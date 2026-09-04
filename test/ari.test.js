import assert from "node:assert/strict";
import test from "node:test";
import { applyAriEvent, signAriBody, verifyAriDelivery } from "../src/ari.js";
import { LocalEncryptedStore } from "../src/store.js";

const config = {
  dataEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  isProduction: false,
  localDataPath: "/tmp/cq-test-unused.json",
};

test("Ari delivery signatures cover timestamp, delivery ID, and exact body", () => {
  const rawBody = JSON.stringify({ event: "review.approved", external_id: "cq_1" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const deliveryId = "delivery_1";
  const secret = "whsec_test";
  const signature = signAriBody(`${timestamp}.${deliveryId}.${rawBody}`, secret);
  assert.equal(verifyAriDelivery({ rawBody, timestamp, deliveryId, signature, secret }), true);
  assert.equal(verifyAriDelivery({ rawBody: `${rawBody} `, timestamp, deliveryId, signature, secret }), false);
  assert.equal(verifyAriDelivery({ rawBody, timestamp: "1", deliveryId, signature, secret }), false);
});

test("approved events award hertz once and reverts remove them", async () => {
  const store = new LocalEncryptedStore(config, { memory: true });
  await store.put("user", "user_1", { id: "user_1", hertz: 2, updatedAt: "" });
  await store.put("project", "cq_1", { id: "cq_1", userId: "user_1", status: "submitted", updatedAt: "" });
  await store.put("submission", "ship_1", {
    id: "ship_1", projectId: "cq_1", externalId: "cq_1", phase: "review", createdAt: "2026-01-01", updatedAt: "",
  });
  const approved = {
    event: "review.approved",
    decision: "approved",
    id: "AR-1",
    external_id: "cq_1",
    review: { approved_minutes: 125, approved_hours: 2 },
  };
  await applyAriEvent(store, approved, "delivery_1");
  await applyAriEvent(store, approved, "delivery_1");
  assert.equal((await store.get("user", "user_1")).hertz, 12.42);
  assert.equal((await store.get("project", "cq_1")).status, "approved");
  assert.equal((await store.list("audit")).length, 1);

  await applyAriEvent(store, {
    event: "review.reverted",
    decision: null,
    id: "AR-1",
    external_id: "cq_1",
    review: {},
  }, "delivery_2");
  assert.equal((await store.get("user", "user_1")).hertz, 2);
  assert.equal((await store.get("project", "cq_1")).status, "building");
  assert.equal((await store.list("audit")).length, 2);
});
