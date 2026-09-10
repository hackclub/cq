import assert from "node:assert/strict";
import test from "node:test";
import { hasPermission, isOrganizer, startOAuth, upsertUser, userRoles } from "../src/auth.js";
import { getConfig } from "../src/config.js";

test("organizer roles grant only their declared permissions", () => {
  const reviewer = { roles: ["participant", "reviewer"] };
  assert.equal(isOrganizer(reviewer), true);
  assert.equal(hasPermission(reviewer, "projects.review"), true);
  assert.equal(hasPermission(reviewer, "shop.manage"), false);

  const operations = { roles: ["shop_editor", "fulfilment_manager"] };
  assert.equal(hasPermission(operations, "shop.manage"), true);
  assert.equal(hasPermission(operations, "orders.manage"), true);
  assert.equal(hasPermission(operations, "users.manage"), false);

  const admin = { role: "admin" };
  assert.equal(hasPermission(admin, "users.manage"), true);
  const auditor = { roles: ["participant", "auditor"] };
  assert.equal(hasPermission(auditor, "audit.read"), true);
  assert.equal(hasPermission(auditor, "users.manage"), false);
  assert.deepEqual(userRoles({ role: "participant" }), ["participant"]);
});

test("Hack Club Auth profile claims populate CQ's read-only identity record", async () => {
  const records = new Map();
  const store = {
    list: async (type) => type === "user" ? [...records.values()] : [],
    put: async (type, id, value) => { if (type === "user") records.set(id, value); return value; },
  };
  const config = getConfig({ adminEmails: "" });
  const user = await upsertUser(store, config, {
    sub: "ident!maker",
    email: "maker@hackclub.com",
    name: "Radio Maker",
    given_name: "Radio",
    family_name: "Maker",
    phone_number: "+61400000000",
    birthdate: "2009-02-03",
    slack_id: "U01234567",
    verification_status: "verified",
    ysws_eligible: true,
    address: {
      street_address: "1 Antenna Road\nUnit 2",
      locality: "Hobart",
      region: "Tasmania",
      postal_code: "7000",
      country: "AU",
    },
  });
  assert.equal(user.firstName, "Radio");
  assert.equal(user.lastName, "Maker");
  assert.equal(user.phoneNumber, "+61400000000");
  assert.equal(user.birthday, "2009-02-03");
  assert.equal(user.addressLine1, "1 Antenna Road");
  assert.equal(user.addressLine2, "Unit 2");
  assert.equal(user.city, "Hobart");
  assert.equal(user.slackId, "U01234567");
  assert.equal(user.yswsEligible, true);
});

test("sign-in consolidates duplicate CQ user rows and preserves owned projects", async () => {
  const records = new Map();
  const key = (type, id) => `${type}:${id}`;
  const store = {
    list: async (type) => [...records.entries()].filter(([recordKey]) => recordKey.startsWith(`${type}:`)).map(([, value]) => value),
    get: async (type, id) => records.get(key(type, id)) || null,
    put: async (type, id, value) => { records.set(key(type, id), structuredClone(value)); return value; },
    delete: async (type, id) => records.delete(key(type, id)),
  };
  await store.put("user", "user_old", {
    id: "user_old", hackClubId: "old-sub", email: "maker@hackclub.com", name: "Radio Maker", hertz: 3,
    roles: ["participant"], createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  });
  await store.put("user", "user_current", {
    id: "user_current", hackClubId: "current-sub", email: "maker@hackclub.com", name: "Radio Maker", hertz: 0,
    roles: ["participant", "reviewer"], createdAt: "2026-09-02T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
  });
  await store.put("project", "cq_2878a781b7d04cba382c3b80", { id: "cq_2878a781b7d04cba382c3b80", userId: "user_old", title: "Receiver" });
  await store.put("funding_request", "fund_1", { id: "fund_1", userId: "user_old", projectId: "cq_2878a781b7d04cba382c3b80" });
  await store.put("session", "session_old", { id: "session_old", userId: "user_old" });

  const user = await upsertUser(store, getConfig({ adminEmails: "" }), {
    sub: "current-sub", email: "maker@hackclub.com", name: "Radio Maker",
  });

  assert.equal(user.id, "user_current");
  assert.equal((await store.get("project", "cq_2878a781b7d04cba382c3b80")).userId, "user_current");
  assert.equal((await store.get("funding_request", "fund_1")).userId, "user_current");
  assert.equal((await store.get("user", "user_old")).banned, true);
  assert.equal((await store.get("user", "user_old")).mergedIntoUserId, "user_current");
  assert.equal((await store.get("session", "session_old")).revokedReason, "duplicate_account_consolidated");
  assert.equal((await store.get("user", "user_current")).hertz, 3);
  assert.equal((await store.get("user", "user_current")).roles.includes("reviewer"), true);

  await upsertUser(store, getConfig({ adminEmails: "" }), {
    sub: "current-sub", email: "maker@hackclub.com", name: "Radio Maker",
  });
  assert.equal((await store.get("user", "user_current")).hertz, 3, "a later sign-in must not merge the disabled row again");
});

test("forced Hack Club authentication requests a fresh login", async () => {
  const states = [];
  const store = { put: async (type, id, value) => states.push({ type, id, value }) };
  const config = getConfig({
    hackClubClientId: "client",
    hackClubClientSecret: "secret",
    hackClubRedirectUri: "https://cq.example/auth/callback",
  });
  const url = new URL(await startOAuth(store, config, "/app/profile", { forceReauth: true }));
  assert.equal(url.searchParams.get("prompt"), "login");
  assert.match(url.searchParams.get("scope"), /birthdate/);
  assert.match(url.searchParams.get("scope"), /address/);
  assert.equal(states[0].value.returnTo, "/app/profile");
});
