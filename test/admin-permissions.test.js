import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

test("every organizer role can open only its assigned admin sections", async () => {
  const config = getConfig({
    nodeEnv: "development",
    baseUrl: "http://localhost:3000",
    devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const cases = [
    ["reviewer", "/admin/reviews", "/admin/shop"],
    ["shop_editor", "/admin/shop", "/admin/orders"],
    ["fulfilment_manager", "/admin/orders", "/admin/countries"],
    ["country_editor", "/admin/countries", "/admin/notifications"],
    ["support", "/admin/notifications", "/admin/users"],
    ["auditor", "/admin/audit", "/admin/projects"],
    ["admin", "/admin/users", null],
  ];

  for (const [role, allowed, denied] of cases) {
    const id = `user_${role}`;
    const email = `${role}@example.com`;
    await store.put("user", id, {
      id, email, name: role, roles: ["participant", role], role,
      verificationStatus: "verified", yswsEligible: true, hertz: 0,
      createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
    });
    const agent = request.agent(app);
    const login = await agent.post("/auth/dev-login").type("form").send({ name: role, email, return_to: "/admin" });
    assert.equal(login.status, 302);
    assert.equal((await agent.get(allowed)).status, 200, `${role} should access ${allowed}`);
    if (denied) assert.equal((await agent.get(denied)).status, 403, `${role} should not access ${denied}`);
  }

  const participant = request.agent(app);
  await participant.post("/auth/dev-login").type("form").send({ name: "Maker", email: "maker@example.com", return_to: "/app" });
  assert.equal((await participant.get("/admin")).status, 403);
});
