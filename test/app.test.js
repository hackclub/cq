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
  let hackatimeSeconds = 7200;
  const hackatimeClient = {
    configured: () => true,
    connection: async () => ({ configured: true, connected: true, account: { username: "admin-radio" } }),
    projects: async () => ({
      configured: true,
      connected: true,
      projects: [{ name: "iss-station", totalSeconds: hackatimeSeconds, hours: hackatimeSeconds / 3600, mostRecentHeartbeat: null, languages: ["C++"], archived: false }],
      fetchedAt: new Date().toISOString(),
    }),
    startConnection: async () => "https://hackatime.hackclub.com/oauth/authorize",
    finishConnection: async () => ({ returnTo: "/app/profile" }),
    disconnect: async () => {},
  };
  const cdnClient = {
    configured: () => true,
    upload: async (file) => ({ id: "cdn-test", filename: file.originalname, url: `https://cdn.hackclub.com/test/${file.originalname}` }),
  };
  const app = await createApp({ config, store, ariClient, hackatimeClient, cdnClient, logger: { info() {}, error() {} } });
  const agent = request.agent(app);

  const home = await agent.get("/");
  assert.equal(home.status, 200);
  assert.match(home.text, /Build your way/);

  const health = await agent.get("/healthz");
  assert.equal(health.status, 200);
  assert.equal(health.text, "ok");

  for (const weight of [400, 700]) {
    const font = await agent.get(`/fonts/space-mono/space-mono-latin-${weight}-normal.woff2`);
    assert.equal(font.status, 200);
    assert.match(font.headers["content-type"], /font\/woff2/);
    assert.ok(font.body.length > 10_000);
  }

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

  const profile = await agent.get("/app/profile");
  assert.equal(profile.status, 200);
  assert.match(profile.text, /Managed by Hack Club Auth/);
  assert.match(profile.text, /Update in Hack Club Auth/);
  assert.doesNotMatch(profile.text, /Save profile/);

  const newPage = await agent.get("/app/projects/new");
  assert.match(newPage.text, /iss-station/);
  assert.match(newPage.text, /2 hours/);
  const token = csrf(newPage.text);
  assert.ok(token);
  const create = await agent.post("/app/projects/new").type("form").send({
    _csrf: token,
    title: "Portable ISS station",
    description: "A portable dual-band station for receiving and contacting amateur satellites.",
    repo_url: "https://github.com/example/iss-station",
    demo_url: "https://www.youtube.com/watch?v=radio-demo",
    thumbnail_url: "https://example.com/station.jpg",
    hackatime_projects: "iss-station",
    track: "hardware",
    project_type: "satellite",
    radio_relevance: "This station receives and decodes amateur-radio satellite signals on the two metre and seventy centimetre bands.",
    country_code: "AU",
    license_goal: "Foundation",
    original_work: "1",
    not_school_assignment: "1",
    not_paid_hack_club_work: "1",
  });
  assert.equal(create.status, 302);
  assert.match(create.headers.location, /^\/app\/projects\/cq_/);
  const projectPath = create.headers.location;
  assert.deepEqual((await store.get("project", projectPath.split("/").pop())).evidence, ["commits", "elapsed", "devlog"]);

  const projectPage = await agent.get(projectPath);
  assert.equal(projectPage.status, 200);
  assert.match(projectPage.text, /Ready to ship/);
  assert.doesNotMatch(projectPage.text, /\bAri\b/);
  const projectToken = csrf(projectPage.text);

  const upload = await agent.post(`${projectPath.replace(/\/cq_[^/]+$/, "")}/uploads/images`)
    .set("x-csrf-token", projectToken)
    .attach("images", Buffer.from("fake image"), { filename: "progress.png", contentType: "image/png" });
  assert.equal(upload.status, 200);
  assert.equal(upload.body.images[0].url, "https://cdn.hackclub.com/test/progress.png");

  hackatimeSeconds = 9900;

  const invalidDevlog = await agent.post(`${projectPath}/journals`).type("form").send({
    _csrf: projectToken,
    entry_date: "2026-08-05",
    minutes: 45,
    text: "Assembled the antenna elements.",
  });
  assert.equal(invalidDevlog.status, 302);
  assert.equal((await store.list("journal")).length, 0);

  const addDevlog = await agent.post(`${projectPath}/journals`).type("form").send({
    _csrf: projectToken,
    title: "Built the antenna",
    text: "## Assembly\n\nAssembled the antenna elements and checked every connection. <script>alert('no')</script>",
    image_url: "https://example.com/antenna-progress.jpg",
  });
  assert.equal(addDevlog.status, 302);
  const journal = (await store.list("journal"))[0];
  assert.equal(journal.imageUrl, "https://example.com/antenna-progress.jpg");
  assert.equal(journal.minutes, 45);
  assert.equal(journal.hackatimeSeconds, 2700);

  const devlogPage = await agent.get(projectPath);
  assert.match(devlogPage.text, /antenna-progress\.jpg/);
  assert.match(devlogPage.text, /<h2>Assembly<\/h2>/);
  assert.doesNotMatch(devlogPage.text, /<script>alert/);
  const noNewActivity = await agent.post(`${projectPath}/journals`).type("form").send({
    _csrf: csrf(devlogPage.text),
    title: "Duplicate activity",
    text: "This should not claim the same Hackatime activity twice.",
    image_url: "https://example.com/duplicate.jpg",
  });
  assert.equal(noNewActivity.status, 302);
  assert.equal((await store.list("journal")).length, 1);
  const editDevlog = await agent.post(`${projectPath}/journals/${journal.id}/edit`).type("form").send({
    _csrf: csrf(devlogPage.text),
    title: "Finished the antenna",
    text: "Assembled the antenna elements, checked every connection, and measured continuity.",
    image_urls: "https://example.com/antenna-finished.jpg\nhttps://example.com/swr-reading.jpg",
  });
  assert.equal(editDevlog.status, 302);
  assert.equal((await store.get("journal", journal.id)).minutes, 45);
  assert.equal((await store.get("journal", journal.id)).imageUrl, "https://example.com/antenna-finished.jpg");
  assert.deepEqual((await store.get("journal", journal.id)).imageUrls, [
    "https://example.com/antenna-finished.jpg",
    "https://example.com/swr-reading.jpg",
  ]);

  const submit = await agent.post(`${projectPath}/submit`).type("form").send({ _csrf: projectToken });
  assert.equal(submit.status, 302);
  const submissions = await store.list("submission");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].ariId, "AR-TEST");
  assert.equal(submissions[0].payload.journals[0].image_url, "https://example.com/antenna-finished.jpg");
  assert.equal(submissions[0].payload.journals[0].image_urls.length, 2);
  assert.match(submissions[0].payload.journals[0].text, /Progress image: https:\/\/example\.com\/antenna-finished\.jpg/);

  const reviewPage = await agent.get(`/admin/reviews/${submissions[0].id}`);
  assert.equal(reviewPage.status, 200);
  assert.match(reviewPage.text, /YSWS approval checks/);
  const reviewToken = csrf(reviewPage.text);
  const claim = await agent.post(`/admin/reviews/${submissions[0].id}/claim`).type("form").send({
    _csrf: reviewToken,
    action: "claim",
  });
  assert.equal(claim.status, 302);
  const decision = await agent.post(`/admin/reviews/${submissions[0].id}/decision`).type("form").send({
    _csrf: reviewToken,
    decision: "approved",
    approved_minutes: 60,
    radio_related: "1",
    shipped: "1",
    public_source: "1",
    reproducible: "1",
    evidence_sufficient: "1",
    eligible_work: "1",
    distinct_hours: "1",
    technical_note: "Verified the antenna build, measurements, repository, and functional radio outcome.",
    time_note: "Approved the evidenced first hour.",
    note_to_maker: "Strong documented build.",
    internal_note: "All checks passed.",
  });
  assert.equal(decision.status, 302);
  assert.equal((await store.get("project", projectPath.split("/").pop())).status, "approved");
  assert.equal((await store.list("review_action")).length, 2);
  // The form caps approval at the 45 minutes actually evidenced in devlogs.
  assert.equal((await store.list("user"))[0].hertz, 203.75);

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
  // The external event reconciles the same ledger entry instead of double-awarding it.
  assert.equal((await store.get("user", (await store.list("user"))[0].id)).hertz, 205);

  const shop = await agent.get("/app/shop");
  const shopToken = csrf(shop.text);
  assert.equal(shop.status, 200);
  assert.doesNotMatch(shop.text, /Issued through HCB after organizer review/);
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
  const adminUsers = await agent.get("/admin/users");
  assert.equal(adminUsers.status, 200);
  assert.match(adminUsers.text, /Users and roles/);
  assert.match(adminUsers.text, /Reviewer/);
  const adminUser = (await store.list("user"))[0];
  const updateUser = await agent.post(`/admin/users/${adminUser.id}`).type("form").send({
    _csrf: csrf(adminUsers.text),
    roles: ["reviewer", "admin"],
    hertz_delta: 0,
  });
  assert.equal(updateUser.status, 302);
  const adminProject = await agent.get(`/admin/projects/${projectPath.split("/").pop()}`);
  assert.equal(adminProject.status, 200);
  assert.match(adminProject.text, /Eligibility and evidence/);
  assert.match(adminProject.text, /This station receives and decodes/);
  assert.match(adminProject.text, /antenna-finished\.jpg/);
  const archiveProject = await agent.post(`/admin/projects/${projectPath.split("/").pop()}`).type("form").send({
    _csrf: csrf(adminProject.text),
    status: "archived",
  });
  assert.equal(archiveProject.status, 302);
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
  const updateCountry = await agent.post("/admin/countries/AU").type("form").send({
    _csrf: csrf(adminCountries.text),
    name: "Australia",
    ownership_rule: "Receiving equipment may be owned when it complies with Australian rules.",
    transmission_rule: "An appropriate amateur qualification and callsign are required before transmitting.",
    fulfilment_mode: "local",
    fulfilment_note: "Prefer local Australian fulfilment where stock permits.",
    source_url: "https://www.acma.gov.au/amateur-radio",
    sort_order: 10,
    active: "1",
  });
  assert.equal(updateCountry.status, 302);
  const adminShop = await agent.get("/admin/shop");
  assert.equal(adminShop.status, 200);
  const yagi = await store.get("product", "yagi-kit");
  const updateProduct = await agent.post("/admin/shop/yagi-kit").type("form").send({
    _csrf: csrf(adminShop.text),
    name: yagi.name,
    category: yagi.category,
    price: yagi.price,
    stock: yagi.stock,
    image: yagi.image,
    sort_order: yagi.sortOrder,
    description: yagi.description,
    active: "1",
  });
  assert.equal(updateProduct.status, 302);
  const adminNotifications = await agent.get("/admin/notifications");
  assert.equal(adminNotifications.status, 200);
  assert.match(adminNotifications.text, /Slack notifications/);
  const adminAudit = await agent.get("/admin/audit");
  assert.equal(adminAudit.status, 200);
  assert.match(adminAudit.text, /Audit log/);
  for (const action of ["User Updated", "Project Shipped", "Project Status Updated", "Order Placed", "Order Cancelled", "Product Updated", "Review Claimed", "Review Approved", "Country Updated"]) {
    assert.match(adminAudit.text, new RegExp(action));
  }
  assert.ok((await store.list("audit")).length >= 7);
});
