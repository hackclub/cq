import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

const baseConfig = {
  nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true,
  dataEncryptionKey: Buffer.alloc(32, 6).toString("base64"),
};

test("signed-in CQ users go directly to the NPS form with their Slack ID", async () => {
  const config = getConfig(baseConfig);
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Maker", email: "maker@example.com", return_to: "/app" });
  const response = await agent.get("/api/cq-nps");
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, "https://forms.hackclub.com/ysws-cq-nps?slackid=UDEVLOCAL");
  assert.equal(response.text.includes("CQ"), false);
});

test("signed-out visitors request only openid and slack_id", async () => {
  const config = getConfig({
    ...baseConfig, hackClubClientId: "client", hackClubClientSecret: "secret",
    hackClubRedirectUri: "https://cq.example/auth/callback",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const response = await request(app).get("/api/cq-nps");
  assert.equal(response.status, 302);
  const location = new URL(response.headers.location);
  assert.equal(location.origin, "https://auth.hackclub.com");
  assert.equal(location.searchParams.get("scope"), "openid slack_id");
  const states = await store.list("oauth");
  assert.equal(states.length, 1);
  assert.equal(states[0].purpose, "cq_nps");
});

test("cancelled NPS authentication returns plain text instead of the CQ interface", async () => {
  const config = getConfig({
    ...baseConfig, hackClubClientId: "client", hackClubClientSecret: "secret",
    hackClubRedirectUri: "https://cq.example/auth/callback",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const startResponse = await request(app).get("/api/cq-nps");
  const state = new URL(startResponse.headers.location).searchParams.get("state");
  const response = await request(app)
    .get("/auth/callback")
    .query({ error: "access_denied", state });
  assert.equal(response.status, 400);
  assert.match(response.headers["content-type"], /^text\/plain/);
  assert.equal(response.text, "Hack Club sign-in was cancelled.");
});

test("the NPS endpoint returns plain text when authentication is unavailable", async () => {
  const config = getConfig(baseConfig);
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const response = await request(app).get("/api/cq-nps");
  assert.equal(response.status, 503);
  assert.match(response.headers["content-type"], /^text\/plain/);
  assert.equal(response.text, "CQ sign-in is unavailable.");
});
