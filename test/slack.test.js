import assert from "node:assert/strict";
import test from "node:test";
import { createSlackNotifier } from "../src/slack.js";
import { LocalEncryptedStore } from "../src/store.js";

test("Slack bot uses its environment token and records notification delivery", async () => {
  const config = {
    baseUrl: "https://cq.example",
    slackBotToken: "xoxb-test-token",
    slackAdminChannelId: "CADMIN",
    dataEncryptionKey: Buffer.alloc(32, 5).toString("base64"),
    isProduction: false,
    localDataPath: "/tmp/cq-test-unused.json",
  };
  const store = new LocalEncryptedStore(config, { memory: true });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 });
  };
  const notifier = createSlackNotifier(config, store, fetchImpl);
  await notifier.orderPurchased(
    { id: "user_1", slackId: "U123456", name: "Maker", email: "maker@example.com" },
    { id: "order_1", total: 20 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, "Bearer xoxb-test-token");
  assert.match(calls[0].options.body, /20 hertz/);
  const notices = await store.list("notification");
  assert.equal(notices[0].status, "sent");
  assert.equal(notices[0].slackTimestamp, "123.456");
});
