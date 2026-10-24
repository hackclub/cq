import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

test("administrators can broadcast Block Kit to a selected participant group", async () => {
  const config = getConfig({
    nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 3).toString("base64"), adminEmails: "admin@example.com",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const delivered = [];
  const slackNotifier = {
    configured: () => true,
    securityAlert: async () => ({ skipped: true }),
    broadcastMessage: async (users, message) => {
      delivered.push({ users, message });
      return users.map((user) => ({ userId: user.id, status: "sent" }));
    },
  };
  const app = await createApp({ config, store, slackNotifier, logger: { info() {}, error() {} } });
  const now = "2026-10-24T00:00:00.000Z";
  await store.put("user", "no_project", { id: "no_project", name: "No project", slackId: "UNOProject", roles: ["participant"], createdAt: now });
  await store.put("user", "builder", { id: "builder", name: "Builder", slackId: "UBUILDER", roles: ["participant"], createdAt: now });
  await store.put("user", "opted_out", { id: "opted_out", name: "Opted out", slackId: "UOPTOUT", roles: ["participant"], optionalCommunicationsOptOutAt: now, createdAt: now });
  await store.put("project", "project_1", { id: "project_1", userId: "builder", title: "Radio", status: "building", createdAt: now });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Admin", email: "admin@example.com", return_to: "/admin/notifications" });
  const page = await agent.get("/admin/notifications");
  assert.equal(page.status, 200);
  assert.match(page.text, /Signed up without a project \(1\)/);
  assert.match(page.text, /Administrators only \(1\)/);
  assert.match(page.text, /Specific people/);
  assert.match(page.text, /Start your first project/);
  assert.match(page.text, /data-specific-recipients hidden/);
  assert.doesNotMatch(page.text, /UOPTOUT/);
  assert.match(page.text, /Slack Block Kit payload/);
  const payload = { blocks: [{ type: "section", text: { type: "mrkdwn", text: "Please share feedback" } }] };
  const send = await agent.post("/admin/notifications/broadcast").type("form").send({
    _csrf: csrf(page.text), audience: "no_project", payload: JSON.stringify(payload),
  });
  assert.equal(send.status, 302);
  assert.deepEqual(delivered[0].users.map((user) => user.id), ["no_project"]);
  assert.deepEqual(delivered[0].message.blocks, payload.blocks);
  const specific = await agent.post("/admin/notifications/broadcast").type("form").send({
    _csrf: csrf(page.text), audience: "specific", recipient_ids: "builder", payload: JSON.stringify(payload),
  });
  assert.equal(specific.status, 302);
  assert.deepEqual(delivered[1].users.map((user) => user.id), ["builder"]);
  assert.equal((await store.list("audit")).some((item) => item.action === "notifications.broadcast"), true);
});
