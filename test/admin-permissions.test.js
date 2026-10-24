import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) { return html.match(/name="_csrf" value="([^"]+)"/)?.[1]; }

test("every organizer role can open only its assigned admin sections", async () => {
  const config = getConfig({
    nodeEnv: "development",
    baseUrl: "http://localhost:3000",
    devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const timestamp = "2026-08-30T00:00:00.000Z";
  await store.put("user", "maker", { id: "maker", name: "Maker", email: "maker@example.com", roles: ["participant"], createdAt: timestamp, updatedAt: timestamp });
  await store.put("project", "cq_sensitive", { id: "cq_sensitive", userId: "maker", title: "REVIEW PROJECT ONLY", repoUrl: "https://github.com/example/shipped", hackatimeProjects: ["shipped-code"], hackatimeBaseline: { "shipped-code": 1200 }, track: "software", status: "submitted", createdAt: timestamp, updatedAt: timestamp });
  await store.put("project", "cq_unshipped", { id: "cq_unshipped", userId: "maker", title: "UNSHIPPED PROJECT", repoUrl: "https://github.com/example/unshipped", hackatimeProjects: ["secret-draft"], track: "software", status: "building", createdAt: timestamp, updatedAt: timestamp });
  await store.put("submission", "sub_sensitive", { id: "sub_sensitive", projectId: "cq_sensitive", userId: "maker", phase: "review", createdAt: timestamp, updatedAt: timestamp });
  await store.put("hackatime_token", "maker", { id: "maker", userId: "maker", accessToken: "secret-token", account: { id: "ht_42", username: "radio-maker", email: "maker@hackclub.com" }, connectedAt: timestamp, updatedAt: timestamp });
  await store.put("order", "order_sensitive", { id: "ORDER FULFILMENT ONLY", userId: "maker", status: "received", total: 20, items: [], shipping: { shippingName: "Maker", addressLine1: "1 Test Road", addressLine2: "", city: "Hobart", region: "Tasmania", postalCode: "7000", countryCode: "AU", country: "Australia", notes: "" }, createdAt: timestamp, updatedAt: timestamp });
  await store.put("product", "product_sensitive", { id: "product_sensitive", name: "SHOP INVENTORY ONLY", stock: 1, category: "gear", sortOrder: 1, active: true, createdAt: timestamp, updatedAt: timestamp });
  const cases = [
    ["fraud_reviewer", "/admin/fraud-review", "/admin/reviews"],
    ["reviewer", "/admin/reviews", "/admin/shop"],
    ["shop_editor", "/admin/shop", "/admin/orders"],
    ["fulfilment_manager", "/admin/orders", "/admin/countries"],
    ["country_editor", "/admin/countries", "/admin/notifications"],
    ["support", "/admin/notifications", "/admin/users"],
    ["auditor", "/admin/audit", "/admin/projects"],
    ["admin", "/admin/users", null],
  ];

  for (const [role, allowed, denied] of cases) {
    const id = `user_${role}`;
    const email = `${role}@example.com`;
    await store.put("user", id, {
      id, email, name: role, roles: ["participant", role], role,
      verificationStatus: "verified", yswsEligible: true, hertz: 0,
      createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
    });
    const agent = request.agent(app);
    const login = await agent.post("/auth/dev-login").type("form").send({ name: role, email, return_to: "/admin" });
    assert.equal(login.status, 302);
    assert.equal((await agent.get(allowed)).status, 200, `${role} should access ${allowed}`);
    if (denied) assert.equal((await agent.get(denied)).status, 403, `${role} should not access ${denied}`);
    const overview = await agent.get("/admin");
    assert.equal(overview.status, 200);
    assert.equal(overview.text.includes("REVIEW PROJECT ONLY"), ["reviewer", "admin"].includes(role), `${role} project overview isolation`);
    assert.equal(overview.text.includes("ORDER FULFILMENT ONLY"), ["fulfilment_manager", "admin"].includes(role), `${role} order overview isolation`);
    assert.equal(overview.text.includes("SHOP INVENTORY ONLY"), ["shop_editor", "admin"].includes(role), `${role} shop overview isolation`);
    if (role === "fraud_reviewer") {
      const fraudList = await agent.get("/admin/fraud-review");
      assert.match(fraudList.text, /REVIEW PROJECT ONLY/);
      assert.match(fraudList.text, /radio-maker/);
      assert.match(fraudList.text, /shipped-code/);
      assert.doesNotMatch(fraudList.text, /UNSHIPPED PROJECT|secret-draft/);
      const detail = await agent.get("/admin/fraud-review/cq_sensitive");
      assert.equal(detail.status, 200);
      assert.match(detail.text, /ht_42/);
      assert.match(detail.text, /maker@hackclub\.com/);
      assert.match(detail.text, /shipped-code/);
      assert.doesNotMatch(detail.text, /Archive project/);
      assert.match(detail.text, /Approve fraud check/);
      const decision = await agent.post("/admin/fraud-review/cq_sensitive/approve").type("form").send({ _csrf: csrf(detail.text) });
      assert.equal(decision.status, 302);
      const reviewedSubmission = await store.get("submission", "sub_sensitive");
      assert.equal(reviewedSubmission.phase, "review");
      assert.equal(reviewedSubmission.decision, undefined);
      assert.equal(reviewedSubmission.fraudReview.decision, "approved");
      assert.equal(reviewedSubmission.fraudReview.reviewerId, id);
      assert.equal((await store.list("review_action")).some((item) => item.submissionId === "sub_sensitive" && item.action === "fraud_approved"), true);
      assert.equal((await store.list("audit")).some((item) => item.entityId === "sub_sensitive" && item.action === "review.fraud_approved"), true);
      const approvedDetail = await agent.get("/admin/fraud-review/cq_sensitive");
      assert.match(approvedDetail.text, /Fraud approved/);
      assert.doesNotMatch(approvedDetail.text, /Approve fraud check/);
      assert.equal((await agent.get("/admin/fraud-review/cq_unshipped")).status, 404);
      assert.equal((await agent.post("/admin/projects/cq_sensitive").type("form").send({ status: "archived" })).status, 403);
    }
  }

  const participant = request.agent(app);
  await participant.post("/auth/dev-login").type("form").send({ name: "Maker", email: "maker@example.com", return_to: "/app" });
  assert.equal((await participant.get("/admin")).status, 403);
});
