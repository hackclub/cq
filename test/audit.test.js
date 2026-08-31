import assert from "node:assert/strict";
import test from "node:test";
import { writeAudit } from "../src/audit.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

test("audit records capture before and after values while redacting credentials", async () => {
  const config = getConfig({
    nodeEnv: "test",
    dataEncryptionKey: Buffer.alloc(32, 4).toString("base64"),
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  await writeAudit(store, { id: "admin_one", name: "Ruben", email: "ruben@example.com" }, {
    action: "user.updated",
    entityType: "user",
    entityId: "maker_one",
    summary: "Updated a maker.",
    before: { hertz: 5, accessToken: "before-secret" },
    after: { hertz: 10, nested: { client_secret: "after-secret" } },
  });
  const [entry] = await store.list("audit");
  assert.equal(entry.actorName, "Ruben");
  assert.equal(entry.before.hertz, 5);
  assert.equal(entry.after.hertz, 10);
  assert.equal(entry.before.accessToken, "[redacted]");
  assert.equal(entry.after.nested.client_secret, "[redacted]");
});
