import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHandler } from "../src/mcp.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function call(name, arguments_, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } };
}

function content(response) {
  return JSON.parse(response.result.content[0].text);
}

test("participant MCP tokens stay within their own projects and hide private review data", async () => {
  const config = getConfig({ nodeEnv: "development", dataEncryptionKey: Buffer.alloc(32, 13).toString("base64") });
  const store = new LocalEncryptedStore(config, { memory: true });
  await store.put("project", "cq_owned", { id: "cq_owned", userId: "user_a", title: "Owned receiver", status: "approved" });
  await store.put("project", "cq_other", { id: "cq_other", userId: "user_b", title: "Other receiver", status: "submitted" });
  await store.put("submission", "ship_owned", {
    id: "ship_owned", projectId: "cq_owned", phase: "reviewed", decision: "approved", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
    payload: { address_line_1: "Secret street" }, airtableFields: { Email: "secret@example.com" },
    review: { approved_minutes: 60, approved_hours: 1, note_to_maker: "Nice work.", internal_note: "Do not expose." },
  });
  await store.put("review_action", "act_owned", { id: "act_owned", projectId: "cq_owned", action: "second_pass_approved", noteToMaker: "Nice work.", internalNote: "Do not expose.", createdAt: "2026-09-02T00:00:00.000Z" });
  await store.put("funding_request", "fund_owned", {
    id: "fund_owned", projectId: "cq_owned", userId: "user_a", status: "approved", requestedUsd: 45,
    firstPass: { decision: "approved", noteToMaker: "Looks good.", internalNote: "Do not expose." },
    review: { decision: "approved", noteToMaker: "Approved.", approvedUsd: 45, internalNote: "Do not expose." },
  });
  const handler = createMcpHandler({ store, githubClient: { repository: async () => ({ available: true }) }, hackatimeClient: { projects: async (userId) => ({ userId }) } });

  const other = await handler(call("get_project", { project_id: "cq_other" }), { userId: "user_a", privileged: false });
  assert.equal(other.error.message, "Not found or not permitted.");

  const submission = content(await handler(call("get_submission", { submission_id: "ship_owned" }), { userId: "user_a", privileged: false }));
  assert.equal(submission.review.note_to_maker, "Nice work.");
  assert.equal("payload" in submission, false);
  assert.equal(JSON.stringify(submission).includes("Secret street"), false);
  assert.equal(JSON.stringify(submission).includes("Do not expose"), false);

  const history = content(await handler(call("get_review_history", { project_id: "cq_owned" }), { userId: "user_a", privileged: false }));
  assert.equal(JSON.stringify(history).includes("Do not expose"), false);
  const funding = content(await handler(call("get_funding_request", { project_id: "cq_owned" }), { userId: "user_a", privileged: false }));
  assert.equal(JSON.stringify(funding).includes("Do not expose"), false);
  assert.equal((await handler(call("get_hackatime_activity", { user_id: "user_b" }), { userId: "user_a", privileged: false })).error.message, "Not found or not permitted.");

  const organizer = content(await handler(call("get_submission", { submission_id: "ship_owned" }), { privileged: true }));
  assert.equal(organizer.payload.address_line_1, "Secret street");
});
