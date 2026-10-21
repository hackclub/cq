import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { buildAnalytics } from "../src/analytics.js";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

test("analytics aggregates CQ activity, reviews, Hertz, and orders", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const records = {
    users: [
      { id: "maker", name: "Maker", verificationStatus: "verified", yswsEligible: true, hertz: 15, roles: ["participant"], addressCountry: "Australia", createdAt: "2026-10-20T10:00:00.000Z" },
      { id: "admin", name: "Admin", verificationStatus: "verified", yswsEligible: true, hertz: 5, roles: ["participant", "admin"], addressCountry: "Australia", createdAt: "2026-09-01T10:00:00.000Z" },
    ],
    projects: [{ id: "radio", userId: "maker", title: "Radio", status: "approved", createdAt: "2026-10-20T11:00:00.000Z" }],
    journals: [{ id: "log", projectId: "radio", minutes: 120, entryDate: "2026-10-21", createdAt: "2026-10-21T08:00:00.000Z" }],
    submissions: [{ id: "sub", projectId: "radio", phase: "reviewed", decision: "approved", createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-21T09:00:00.000Z", review: { approved_hours: 2, reviewed_at: "2026-10-21T09:00:00.000Z" } }],
    orders: [{ id: "order", userId: "maker", status: "received", total: 10, items: [{ productId: "kit", name: "Antenna kit", price: 10, quantity: 1 }], createdAt: "2026-10-21T10:00:00.000Z" }],
    products: [{ id: "kit", name: "Antenna kit", stock: 8, active: true }],
    ledgers: [{ id: "sub", userId: "maker", delta: 10, createdAt: "2026-10-21T09:00:00.000Z" }],
    activities: [{ id: "2026-10-21:maker", userId: "maker", day: "2026-10-21", createdAt: "2026-10-21T11:55:00.000Z", lastSeenAt: "2026-10-21T11:55:00.000Z" }],
    fundingRequests: [{ id: "fund", status: "issued", requestedHertz: 25, approvedHertz: 20, updatedAt: "2026-10-21T10:00:00.000Z" }],
  };
  const result = buildAnalytics(records, 7, now);
  assert.equal(result.activity.activeToday, 1);
  assert.equal(result.visitors.now, 1);
  assert.equal(result.participation.signupsInRange, 1);
  assert.equal(result.projects.totalLoggedHours, 2);
  assert.equal(result.review.approvalRate, 100);
  assert.equal(result.review.approvedHoursInRange, 2);
  assert.equal(result.economy.earnedAll, 10);
  assert.equal(result.economy.spentAll, 10);
  assert.equal(result.economy.topItems[0].unitsSold, 1);
  assert.equal(result.funding.issuedAll, 1);
  assert.equal(result.inventory.lowStock, 1);
});

test("analytics rejects participants, validates ranges, and records signed-in visitors", async () => {
  const config = getConfig({
    nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 4).toString("base64"), adminEmails: "admin@example.com",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const participant = request.agent(app);
  await participant.post("/auth/dev-login").type("form").send({ name: "Maker", email: "maker@example.com", return_to: "/app" });
  assert.equal((await participant.get("/admin/analytics")).status, 403);

  const admin = request.agent(app);
  await admin.post("/auth/dev-login").type("form").send({ name: "Admin", email: "admin@example.com", return_to: "/admin/analytics" });
  const page = await admin.get("/admin/analytics?days=7");
  assert.equal(page.status, 200);
  assert.match(page.text, /Participation and access/);
  assert.match(page.text, /Hertz economy and shop/);
  assert.match(page.text, /Funding and inventory/);
  assert.match(page.text, /href="\?days=7" class="active"|class="active" href="\?days=7"/);
  assert.ok((await store.list("activity")).some((activity) => activity.userId));

  const invalid = await admin.get("/admin/analytics?days=999");
  assert.equal(invalid.status, 200);
  assert.match(invalid.text, /class="active" href="\?days=30"/);
});

test("activity tracking failures are visible to administrators", async () => {
  const config = getConfig({
    nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 5).toString("base64"), adminEmails: "admin@example.com",
  });
  class FailingActivityStore extends LocalEncryptedStore {
    async get(type, id) {
      if (type === "activity") throw new Error("CQ Activity is not writable");
      return super.get(type, id);
    }
    async list(type) {
      if (type === "activity") throw new Error("CQ Activity is not readable");
      return super.list(type);
    }
  }
  const store = new FailingActivityStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Admin", email: "admin@example.com", return_to: "/admin/analytics" });
  const page = await agent.get("/admin/analytics");
  assert.equal(page.status, 200);
  assert.match(page.text, /Analytics/);
  assert.match(page.text, /Visitor tracking is unavailable/);
  assert.match(page.text, /CQ Activity is not readable/);
});
