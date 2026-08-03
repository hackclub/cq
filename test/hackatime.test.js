import assert from "node:assert/strict";
import test from "node:test";
import { createHackatimeClient } from "../src/hackatime.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Hackatime OAuth stores its token encrypted and discovers selectable projects", async () => {
  const config = getConfig({
    nodeEnv: "test",
    baseUrl: "https://cq.example",
    dataEncryptionKey: Buffer.alloc(32, 8).toString("base64"),
    hackatimeClientId: "ht_client",
    hackatimeClientSecret: "ht_secret",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/oauth/token")) {
      assert.match(String(options.body), /grant_type=authorization_code/);
      return jsonResponse({ access_token: "very-secret-token", token_type: "Bearer", scope: "profile read" });
    }
    if (String(url).endsWith("/api/v1/authenticated/me")) {
      assert.equal(options.headers.Authorization, "Bearer very-secret-token");
      return jsonResponse({ id: 42, username: "radio-maker" });
    }
    if (String(url).includes("/api/v1/authenticated/projects")) {
      assert.equal(options.headers.Authorization, "Bearer very-secret-token");
      return jsonResponse({ projects: [
        { name: "cq-firmware", total_seconds: 7200, most_recent_heartbeat: "2026-08-02T12:00:00Z", languages: ["C++"], archived: false },
        { name: "old-project", total_seconds: 9000, archived: true },
      ] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const client = createHackatimeClient(config, store, fakeFetch);

  const authorizationUrl = new URL(await client.startConnection("user_1", "/app/projects/new"));
  assert.equal(authorizationUrl.origin, "https://hackatime.hackclub.com");
  assert.equal(authorizationUrl.pathname, "/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("scope"), "profile read");
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);

  const connected = await client.finishConnection({ userId: "user_1", state, code: "oauth-code" });
  assert.equal(connected.returnTo, "/app/projects/new");
  assert.equal((await client.connection("user_1")).account.username, "radio-maker");
  const selection = await client.projects("user_1");
  assert.deepEqual(selection.projects.map((project) => project.name), ["cq-firmware"]);
  assert.equal(selection.projects[0].hours, 2);

  const rawTokenRecord = store.records.get("hackatime_token:user_1");
  assert.ok(rawTokenRecord);
  assert.doesNotMatch(rawTokenRecord.payload, /very-secret-token|radio-maker/);
  assert.equal(requests.length, 3);
});
