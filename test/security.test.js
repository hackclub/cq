import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1];
}

test("participant IDOR, admin permissions, CSRF, and return redirects are enforced", async () => {
  const config = getConfig({
    nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 6).toString("base64"), adminEmails: "admin@example.com",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const owner = request.agent(app);
  await owner.post("/auth/dev-login").type("form").send({ name: "Owner", email: "owner@example.com", return_to: "/app" });
  const ownerUser = (await store.list("user")).find((item) => item.email === "owner@example.com");
  const timestamp = "2026-08-31T00:00:00.000Z";
  await store.put("project", "cq_private", {
    id: "cq_private", userId: ownerUser.id, title: "Private owner route test", status: "building",
    hackatimeProjects: [], tags: [], createdAt: timestamp, updatedAt: timestamp,
  });
  await store.put("order", "order_private", {
    id: "order_private", userId: ownerUser.id, status: "received", total: 1, shipping: {}, items: [],
    createdAt: timestamp, updatedAt: timestamp,
  });

  const other = request.agent(app);
  const safeLogin = await other.post("/auth/dev-login").type("form").send({
    name: "Other", email: "other@example.com", return_to: "//evil.example/steal",
  });
  assert.equal(safeLogin.headers.location, "/app");
  assert.equal((await other.get("/app/projects/cq_private")).status, 404);
  assert.equal((await other.get("/app/shop/orders/order_private")).status, 404);
  assert.equal((await other.post("/admin/shop").type("form").send({ _csrf: "made-up" })).status, 403);

  const admin = request.agent(app);
  await admin.post("/auth/dev-login").type("form").send({ name: "Admin", email: "admin@example.com", return_to: "/admin" });
  assert.equal((await admin.post("/admin/shop").type("form").send({ name: "No CSRF" })).status, 403);
  assert.equal((await admin.post("/admin/users/not-real").type("form").send({ _csrf: "incorrect" })).status, 403);

  const usersPage = await admin.get("/admin/users");
  assert.match(usersPage.text, /Sign everyone out/);
  assert.match(usersPage.text, /1 active/);
  const revokeOwner = await admin.post(`/admin/users/${ownerUser.id}/sessions/revoke`).type("form").send({
    _csrf: csrf(usersPage.text),
  });
  assert.equal(revokeOwner.status, 302);
  const signedOutOwner = await owner.get("/app");
  assert.equal(signedOutOwner.status, 302);
  assert.match(signedOutOwner.headers.location, /^\/auth\/login\?.*reauth=1/);

  const refreshedUsersPage = await admin.get("/admin/users");
  const revokeEveryone = await admin.post("/admin/users/sessions/revoke-all").type("form").send({
    _csrf: csrf(refreshedUsersPage.text),
  });
  assert.equal(revokeEveryone.status, 302);
  const signedOutAdmin = await admin.get("/admin");
  assert.equal(signedOutAdmin.status, 302);
  assert.match(signedOutAdmin.headers.location, /^\/auth\/login\?.*reauth=1/);
});
