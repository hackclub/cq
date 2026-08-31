import assert from "node:assert/strict";
import test from "node:test";
import { AirtableEncryptedStore, LocalEncryptedStore, decryptRecord, encryptRecord } from "../src/store.js";
import { setupAirtable } from "../scripts/setup-airtable.js";

const keyBase64 = Buffer.alloc(32, 7).toString("base64");
const config = {
  dataEncryptionKey: keyBase64,
  isProduction: false,
  localDataPath: "/tmp/cq-test-unused.json",
};

test("AES-256-GCM records round-trip and do not expose plaintext", () => {
  const key = Buffer.from(keyBase64, "base64");
  const value = { email: "maker@hackclub.com", address: "1 Radio Road" };
  const encrypted = encryptRecord(value, key);
  assert.match(encrypted, /^v1\./);
  assert.equal(encrypted.includes(value.email), false);
  assert.deepEqual(decryptRecord(encrypted, key), value);
});

test("encrypted local store supports put, list, get, and delete", async () => {
  const store = new LocalEncryptedStore(config, { memory: true });
  await store.put("user", "one", { id: "one", name: "Mira" });
  assert.deepEqual(await store.get("user", "one"), { id: "one", name: "Mira" });
  assert.equal((await store.list("user")).length, 1);
  assert.equal(await store.delete("user", "one"), true);
  assert.equal(await store.get("user", "one"), null);
});

test("Airtable receives readable JSON documents", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) return new Response(JSON.stringify({ records: [] }), { status: 200 });
    if (options.method === "DELETE") return new Response(JSON.stringify({ deleted: true }), { status: 200 });
    const sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "rec_test", fields: sent.fields }), { status: 200 });
  };
  const store = new AirtableEncryptedStore({
    ...config,
    airtablePat: "pat_test",
    airtableBaseId: "app_test",
    airtableTablePrefix: "DEV CQ",
    airtableTableName: "CQ Data",
    airtableRequestIntervalMs: 0,
  }, fetchImpl);
  await store.put("order", "one", { id: "one", email: "maker@hackclub.com", address: "1 Radio Road" });
  const post = requests.find((request) => request.options.method === "POST");
  const postBody = post.options.body;
  assert.match(post.url, /DEV%20CQ%20Orders/);
  assert.equal(postBody.includes("maker@hackclub.com"), true);
  assert.equal(postBody.includes("1 Radio Road"), true);
  assert.equal(postBody.includes('"ID":"one"'), true);
  assert.equal(postBody.includes('"Data":"{\\n'), true);
  assert.equal(postBody.includes('"Payload"'), false);
  assert.deepEqual(await store.get("order", "one"), { id: "one", email: "maker@hackclub.com", address: "1 Radio Road" });
  await store.put("order", "one", { id: "one", email: "maker@hackclub.com", address: "2 Radio Road" });
  assert.match(requests.find((request) => request.options.method === "PATCH").url, /DEV%20CQ%20Orders/);
  await store.put("user", "maker", { id: "maker", name: "Mira", email: "mira@hackclub.com", roles: ["participant"] });
  assert.match(requests.filter((request) => request.options.method === "POST")[1].url, /DEV%20CQ%20Users/);
  assert.equal(await store.delete("order", "one"), true);
  assert.match(requests.find((request) => request.options.method === "DELETE").url, /DEV%20CQ%20Orders/);
});

test("Airtable ignores incomplete placeholder rows", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    records: [
      { id: "rec_blank", fields: {} },
      { id: "rec_headers", fields: { ID: "ID", Data: "Data" } },
    ],
  }), { status: 200 });
  const store = new AirtableEncryptedStore({
    ...config,
    airtablePat: "pat_test",
    airtableBaseId: "app_test",
    airtableTablePrefix: "CQ",
    airtableTableName: "CQ Data",
    airtableRequestIntervalMs: 0,
  }, fetchImpl);
  assert.deepEqual(await store.list("user"), []);
});

test("Airtable setup creates separate tables and safely migrates legacy ciphertext", async () => {
  const value = { id: "one", name: "Legacy Maker" };
  const encrypted = encryptRecord(value, Buffer.from(keyBase64, "base64"));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    requests.push({ url: href, options });
    if (href.includes("/meta/bases/") && !options.method) {
      return new Response(JSON.stringify({ tables: [] }), { status: 200 });
    }
    if (href.includes("/meta/bases/") && options.method === "POST") {
      return new Response(JSON.stringify({ id: "tbl_created", ...JSON.parse(options.body) }), { status: 200 });
    }
    if (href.includes("CQ%20Data") && !options.method) {
      return new Response(JSON.stringify({ records: [
        { id: "rec_legacy", fields: { Key: "user:one", Type: "user", Payload: encrypted, "Updated At": "2026-08-30T00:00:00.000Z" } },
      ] }), { status: 200 });
    }
    if (href.includes("CQ%20Users") && !options.method) {
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }
    if (href.includes("CQ%20Users") && options.method === "POST") {
      const sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "rec_migrated", fields: sent.fields }), { status: 200 });
    }
    throw new Error(`Unexpected Airtable request: ${options.method || "GET"} ${href}`);
  };
  const result = await setupAirtable({
    ...config,
    airtablePat: "pat_test",
    airtableBaseId: "app_test",
    airtableTablePrefix: "CQ",
    airtableTableName: "CQ Data",
    airtableRequestIntervalMs: 0,
  }, fetchImpl);
  assert.equal(result.created.length, 18);
  assert.equal(result.migrated, 1);
  const migratedBody = requests.find((request) => request.url.includes("CQ%20Users") && request.options.method === "POST").options.body;
  assert.match(migratedBody, /Legacy Maker/);
  assert.doesNotMatch(migratedBody, /v1\./);
  assert.equal(requests.some((request) => request.options.method === "DELETE"), false);
});
