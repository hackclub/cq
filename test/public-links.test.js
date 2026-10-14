import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

test("public pages show the required Hack Club links and pending sponsor status", async () => {
  const config = getConfig({
    nodeEnv: "test",
    baseUrl: "http://localhost:3000",
    dataEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const home = await request(app).get("/");

  assert.equal(home.status, 200);
  assert.match(home.text, /SPONSOR PENDING/);
  assert.match(home.text, /href="https:\/\/hackclub\.com"/);
  assert.match(home.text, /href="https:\/\/hackclub\.com\/privacy-and-terms"/);
  assert.match(home.text, /href="https:\/\/forms\.hackclub\.com\/bounty"/);
  assert.match(home.text, /href="https:\/\/security\.hackclub\.com"/);
});
