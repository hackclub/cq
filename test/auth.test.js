import assert from "node:assert/strict";
import test from "node:test";
import { hasPermission, isOrganizer, userRoles } from "../src/auth.js";

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
