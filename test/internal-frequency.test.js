import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

test("organizer pages require session acknowledgement before access", async () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const config = getConfig({
    nodeEnv: "development", devAuthBypass: true, adminEmails: "admin@example.com",
    dataEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    internalFrequencyKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const app = await createApp({ config, store: new LocalEncryptedStore(config, { memory: true }), logger: { info() {}, error() {} } });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Admin Radio", email: "admin@example.com", return_to: "/admin" });
  const first = await agent.get("/admin");
  assert.equal(first.status, 200);
  assert.match(first.text, /Now entering an encrypted frequency/);
  assert.match(first.text, /organizer-unverified/);
  assert.match(first.text, /internal-frequency-cell/);
  const verified = await agent.post("/admin/session/verify").type("form").send({ _csrf: csrf(first.text) });
  assert.equal(verified.status, 302);
  const second = await agent.get("/admin/projects");
  assert.doesNotMatch(second.text, /Now entering an encrypted frequency/);
  assert.doesNotMatch(second.text, /organizer-unverified/);
  assert.match(second.text, /internal-frequency-cell/);
});
