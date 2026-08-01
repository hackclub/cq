import assert from "node:assert/strict";
import test from "node:test";
import { AirtableEncryptedStore, LocalEncryptedStore, decryptRecord, encryptRecord } from "../src/store.js";

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

test("Airtable receives ciphertext rather than sensitive document fields", async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (!options.method) return new Response(JSON.stringify({ records: [] }), { status: 200 });
    const sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "rec_test", fields: sent.fields }), { status: 200 });
  };
  const store = new AirtableEncryptedStore({
    ...config,
    airtablePat: "pat_test",
    airtableBaseId: "app_test",
    airtableTableName: "CQ Data",
  }, fetchImpl);
  await store.put("order", "one", { id: "one", email: "maker@hackclub.com", address: "1 Radio Road" });
  const postBody = requests.find((request) => request.options.method === "POST").options.body;
  assert.equal(postBody.includes("maker@hackclub.com"), false);
  assert.equal(postBody.includes("1 Radio Road"), false);
  assert.deepEqual(await store.get("order", "one"), { id: "one", email: "maker@hackclub.com", address: "1 Radio Road" });
});
