import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { signAriBody } from "../src/ari.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1];
}

test("participant, project, Ari, shop, and admin flows work end to end", async () => {
  const config = getConfig({
    nodeEnv: "development",
    baseUrl: "http://localhost:3000",
    devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 3).toString("base64"),
    adminEmails: "admin@hackclub.com",
    ariWebhookSecret: "webhook_test_secret",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const ariClient = {
    configured: () => true,
    submit: async () => ({ ok: true, status: 202, body: { id: "AR-TEST" }, text: "" }),
    status: async () => ({ ok: true, status: 200, body: { id: "AR-TEST", phase: "review", decision: null } }),
    withdraw: async () => ({ ok: true, status: 200, body: { status: "withdrawn" } }),
  };
  const app = await createApp({ config, store, ariClient, logger: { info() {}, error() {} } });
  const agent = request.agent(app);

  const home = await agent.get("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /Build your way/);

  const setup = await agent.get("/auth/login");
  assert.equal(setup.status, 503);
  assert.match(setup.text, /Local preview/);

  const login = await agent.post("/auth/dev-login").type("form").send({
    name: "Admin Radio",
    email: "admin@hackclub.com",
    return_to: "/app",
  });
  assert.equal(login.status, 302);

  const dashboard = await agent.get("/app");
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /Good to hear you/);
  assert.match(dashboard.text, /Admin/);

  const newPage = await agent.get("/app/projects/new");
  const token = csrf(newPage.text);
  assert.ok(token);
  const create = await agent.post("/app/projects/new").type("form").send({
    _csrf: token,
    title: "Portable ISS station",
    description: "A portable dual-band station for receiving and contacting amateur satellites.",
    repo_url: "https://github.com/example/iss-station",
    thumbnail_url: "https://example.com/station.jpg",
    hackatime_projects: "iss-station",
    track: "hardware",
    project_type: "satellite",
    radio_relevance: "This station receives and decodes amateur-radio satellite signals on the two metre and seventy centimetre bands.",
    country_code: "AU",
    license_goal: "Foundation",
    evidence: ["commits", "elapsed", "devlog"],
  });
  assert.equal(create.status, 302);
  assert.match(create.headers.location, /^\/app\/projects\/cq_/);
  const projectPath = create.headers.location;

  const projectPage = await agent.get(projectPath);
  assert.equal(projectPage.status, 200);
  assert.match(projectPage.text, /Ready to submit/);
  assert.doesNotMatch(projectPage.text, /\bAri\b/);
  const projectToken = csrf(projectPage.text);

  const submit = await agent.post(`${projectPath}/submit`).type("form").send({ _csrf: projectToken });
  assert.equal(submit.status, 302);
  const submissions = await store.list("submission");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].ariId, "AR-TEST");

  const webhookBody = JSON.stringify({
    event: "review.approved",
    decision: "approved",
    id: "AR-TEST",
    external_id: submissions[0].externalId,
    review: { approved_minutes: 60, approved_hours: 1 },
  });
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const deliveryId = "delivery_app_test";
  const signature = signAriBody(`${webhookTimestamp}.${deliveryId}.${webhookBody}`, config.ariWebhookSecret);
  const webhook = await agent.post("/ari/webhook")
    .set("content-type", "application/json")
    .set("x-ari-timestamp", webhookTimestamp)
    .set("x-ari-delivery-id", deliveryId)
    .set("x-ari-signature", signature)
    .send(webhookBody);
  assert.equal(webhook.status, 200);
  assert.equal(webhook.body.duplicate, false);
  assert.equal((await store.get("user", (await store.list("user"))[0].id)).hertz, 205);

  const shop = await agent.get("/app/shop");
  const shopToken = csrf(shop.text);
  assert.equal(shop.status, 200);
  const add = await agent.post("/app/shop/cart/yagi-kit").type("form").send({ _csrf: shopToken, quantity: 1 });
  assert.equal(add.status, 302);

  const cart = await agent.get("/app/shop/cart");
  const cartToken = csrf(cart.text);
  const checkout = await agent.post("/app/shop/checkout").type("form").send({
    _csrf: cartToken,
    shipping_name: "Admin Radio",
    address_line_1: "1 Radio Road",
    city: "Hobart",
    region: "Tasmania",
    postal_code: "7000",
    country_code: "AU",
  });
  assert.equal(checkout.status, 302);
  assert.match(checkout.headers.location, /^\/app\/shop\/orders\/order_/);
  const orders = await store.list("order");
  assert.equal(orders.length, 1);
  assert.equal(orders[0].shipping.addressLine1, "1 Radio Road");

  const admin = await agent.get("/admin");
  assert.equal(admin.status, 200);
  assert.match(admin.text, /Admin dashboard/);
  const adminProject = await agent.get(`/admin/projects/${projectPath.split("/").pop()}`);
  assert.equal(adminProject.status, 200);
  assert.match(adminProject.text, /Eligibility and evidence/);
  assert.match(adminProject.text, /This station receives and decodes/);
  const adminOrders = await agent.get("/admin/orders");
  assert.equal(adminOrders.status, 200);
  assert.match(adminOrders.text, /1 Radio Road/);
  const cancelOrder = await agent.post(`/admin/orders/${orders[0].id}`).type("form").send({
    _csrf: csrf(adminOrders.text),
    status: "cancelled",
    admin_note: "Cancelled in integration test",
  });
  assert.equal(cancelOrder.status, 302);
  assert.equal((await store.get("order", orders[0].id)).status, "cancelled");
  assert.equal((await store.list("user"))[0].hertz, 205);
  assert.equal((await store.get("product", "yagi-kit")).stock, 60);
  const adminCountries = await agent.get("/admin/countries");
  assert.equal(adminCountries.status, 200);
  assert.match(adminCountries.text, /Country policies/);
  const adminNotifications = await agent.get("/admin/notifications");
  assert.equal(adminNotifications.status, 200);
  assert.match(adminNotifications.text, /Slack notifications/);
});
