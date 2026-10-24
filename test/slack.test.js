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
    if (url.endsWith("conversations.open")) return new Response(JSON.stringify({ ok: true, channel: { id: "D123456" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 });
  };
  const notifier = createSlackNotifier(config, store, fetchImpl);
  await notifier.orderPurchased(
    { id: "user_1", slackId: "U123456", name: "Maker", email: "maker@example.com" },
    { id: "order_1", total: 20 },
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, "Bearer xoxb-test-token");
  assert.match(calls[1].options.body, /20 hertz/);
  const notices = await store.list("notification");
  assert.equal(notices[0].status, "sent");
  assert.equal(notices[0].slackTimestamp, "123.456");
});

test("security alerts are direct messages to the configured security recipient", async () => {
  const config = {
    baseUrl: "https://cq.example", slackBotToken: "xoxb-test-token", slackSecurityUserId: "USECURITY",
    adminEmails: [], dataEncryptionKey: Buffer.alloc(32, 6).toString("base64"), isProduction: false, localDataPath: "/tmp/cq-test-unused.json",
  };
  const store = new LocalEncryptedStore(config, { memory: true });
  const calls = [];
  const notifier = createSlackNotifier(config, store, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("conversations.open")) return new Response(JSON.stringify({ ok: true, channel: { id: "DSECURITY" } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, ts: "123.456" }), { status: 200 });
  });
  await notifier.securityAlert({ id: "admin_1", name: "Admin" }, { method: "POST", path: "/admin/users/user_1", status: 302 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.body, /USECURITY/);
  assert.match(calls[1].options.body, /security alert/i);
});

test("broadcasts send Block Kit as individual recorded direct messages", async () => {
  const config = {
    slackBotToken: "xoxb-test-token", dataEncryptionKey: Buffer.alloc(32, 8).toString("base64"),
    isProduction: false, localDataPath: "/tmp/cq-test-unused.json",
  };
  const store = new LocalEncryptedStore(config, { memory: true });
  const calls = [];
  const notifier = createSlackNotifier(config, store, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith("conversations.open")) return new Response(JSON.stringify({ ok: true, channel: { id: `D${calls.length}` } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, ts: `${calls.length}.000` }), { status: 200 });
  });
  const blocks = [{ type: "section", text: { type: "mrkdwn", text: "Feedback please" } }];
  const results = await notifier.broadcastMessage([
    { id: "one", slackId: "UONE" }, { id: "two", slackId: "UTWO" },
  ], { text: "Feedback please", blocks, entityId: "broadcast_1" });
  assert.equal(results.length, 2);
  assert.equal(results.every((result) => result.status === "sent"), true);
  assert.equal(calls.filter((call) => call.url.endsWith("chat.postMessage")).every((call) => call.body.blocks?.[0].type === "section"), true);
  const notices = await store.list("notification");
  assert.equal(notices.length, 2);
  assert.equal(notices.every((notice) => notice.kind === "admin.broadcast" && notice.entityId === "broadcast_1"), true);
});
