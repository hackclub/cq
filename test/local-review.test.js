import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { LocalEncryptedStore } from "../src/store.js";

function csrf(html) {
  return html.match(/name="_csrf" value="([^"]+)"/)?.[1];
}

test("projects ship into local review when Ari is not configured", async () => {
  const config = getConfig({
    nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true,
    dataEncryptionKey: Buffer.alloc(32, 7).toString("base64"), adminEmails: "reviewer@example.com",
  });
  const store = new LocalEncryptedStore(config, { memory: true });
  const githubClient = { repository: async () => ({
    available: true, slug: "maker/receiver", defaultBranch: "main", description: "Receiver",
    pushedAt: "2026-08-31T00:00:00.000Z", license: "MIT", fork: false, archived: false,
    commits: [{ sha: "abc1234", message: "Ship receiver", author: "maker", date: "2026-08-31T00:00:00.000Z", url: "https://github.com/maker/receiver/commit/abc", verified: false }],
  }) };
  const app = await createApp({ config, store, githubClient, logger: { info() {}, error() {} } });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Reviewer", email: "reviewer@example.com", return_to: "/app" });
  const user = (await store.list("user"))[0];
  const timestamp = "2026-08-31T00:00:00.000Z";
  await store.put("project", "cq_local", {
    id: "cq_local", userId: user.id, title: "Digital receiver", description: "A working digital amateur radio receiver.",
    repoUrl: "https://github.com/maker/receiver", demoUrl: "https://example.com/demo",
    thumbnailUrl: "https://example.com/receiver.jpg", hackatimeProjects: ["receiver"], hackatimeBaseline: { receiver: 0 },
    evidence: ["commits", "elapsed", "devlog"], track: "software", status: "building", projectType: "sdr",
    radioRelevance: "It receives and decodes amateur radio signals from local repeaters.", countryCode: "AU",
    licenseGoal: "Foundation", callsign: "", aiStatement: "", tags: [], isUpdate: false, updateMessage: "",
    originalWork: true, notSchoolAssignment: true, notPaidHackClubWork: true, createdAt: timestamp, updatedAt: timestamp,
  });
  await store.put("journal", "log_local", {
    id: "log_local", projectId: "cq_local", title: "Finished decoding", text: "Decoded a real amateur-radio signal.",
    imageUrl: "https://example.com/progress.jpg", imageUrls: ["https://example.com/progress.jpg"],
    entryDate: "2026-08-31", minutes: 90, createdAt: timestamp, updatedAt: timestamp,
  });

  const projectList = await agent.get("/app/projects");
  const submit = await agent.post("/app/projects/cq_local/submit").type("form").send({ _csrf: csrf(projectList.text) });
  assert.equal(submit.status, 302);
  const submission = (await store.list("submission"))[0];
  assert.equal(submission.phase, "review");
  assert.equal(submission.ariId, null);
  assert.equal((await store.get("project", "cq_local")).status, "submitted");
  assert.equal((await store.list("audit")).some((item) => item.action === "project.shipped"), true);

  const shippedProject = await agent.get("/app/projects/cq_local");
  const lockedEdit = await agent.post("/app/projects/cq_local/edit").type("form").send({ _csrf: csrf(shippedProject.text), title: "Changed after shipping" });
  assert.equal(lockedEdit.status, 302);
  assert.equal((await store.get("project", "cq_local")).title, "Digital receiver");
  const lockedDevlog = await agent.post("/app/projects/cq_local/journals/log_local/delete").type("form").send({ _csrf: csrf(shippedProject.text) });
  assert.equal(lockedDevlog.status, 302);
  assert.ok(await store.get("journal", "log_local"));

  const queue = await agent.get("/admin/reviews");
  assert.equal(queue.status, 200);
  assert.match(queue.text, /Local review active/);
  assert.match(queue.text, /1\.5 hr/);
  const review = await agent.get(`/admin/reviews/${submission.id}`);
  assert.equal(review.status, 200);
  assert.match(review.text, /GitHub activity/);
  assert.match(review.text, /Ship receiver/);
  assert.match(review.text, /90 minutes/);
  assert.match(review.text, /Finished decoding/);

  const projectPage = await agent.get("/app/projects/cq_local");
  assert.doesNotMatch(projectPage.text, /connect the project review service/i);
  assert.doesNotMatch(projectPage.text, /Refresh status/);
  assert.match(projectPage.text, /CQ review queue/);

  const withdraw = await agent.post("/app/projects/cq_local/withdraw").type("form").send({ _csrf: csrf(projectPage.text) });
  assert.equal(withdraw.status, 302);
  assert.equal((await store.get("project", "cq_local")).status, "building");
  assert.equal((await store.get("submission", submission.id)).phase, "withdrawn");
  const afterWithdraw = await agent.get("/app/projects/cq_local");
  const editAfterWithdraw = await agent.post("/app/projects/cq_local/journals/log_local/edit").type("form").send({
    _csrf: csrf(afterWithdraw.text), title: "Updated after withdrawal",
    text: "Changed the devlog after withdrawing the review.", image_url: "https://example.com/progress-2.jpg",
  });
  assert.equal(editAfterWithdraw.status, 302);
  assert.equal((await store.get("journal", "log_local")).title, "Updated after withdrawal");
});

test("hardware funding is approved and issued before a final ship can enter review", async () => {
  const config = getConfig({ nodeEnv: "development", baseUrl: "http://localhost:3000", devAuthBypass: true, dataEncryptionKey: Buffer.alloc(32, 9).toString("base64"), adminEmails: "hardware@example.com" });
  const store = new LocalEncryptedStore(config, { memory: true });
  const app = await createApp({ config, store, logger: { info() {}, error() {} } });
  const agent = request.agent(app);
  await agent.post("/auth/dev-login").type("form").send({ name: "Hardware reviewer", email: "hardware@example.com", return_to: "/app" });
  const user = (await store.list("user"))[0]; const initialHertz = user.hertz; const timestamp = "2026-09-01T00:00:00.000Z";
  await store.put("project", "cq_hardware", {
    id: "cq_hardware", userId: user.id, title: "Pocket receiver", description: "A portable amateur radio receiver with a simple RF front end.", repoUrl: "https://github.com/maker/receiver", demoUrl: "https://example.com/demo", thumbnailUrl: "https://example.com/receiver.jpg", hackatimeProjects: [], hackatimeBaseline: {}, evidence: ["commits", "elapsed", "devlog"], track: "hardware", status: "building", projectType: "radio-electronics", radioRelevance: "It receives amateur radio signals with an accessible portable receiver.", countryCode: "AU", licenseGoal: "Foundation", callsign: "", aiStatement: "", tags: [], isUpdate: false, updateMessage: "", originalWork: true, notSchoolAssignment: true, notPaidHackClubWork: true, estimatedHours: 12, buildPlan: "Design the RF front end, assemble the receiver, then test it with a local repeater.", bom: "Receiver IC — 1 — $12 — https://example.com/parts/receiver", designUrl: "https://github.com/maker/receiver/tree/main/hardware", testPlan: "Receive a known local signal and document the measured output.", createdAt: timestamp, updatedAt: timestamp,
  });
  const page = await agent.get("/app/projects/cq_hardware");
  const requestFunding = await agent.post("/app/projects/cq_hardware/funding/submit").type("form").send({ _csrf: csrf(page.text) });
  assert.equal(requestFunding.status, 302);
  const funding = (await store.list("funding_request"))[0];
  assert.equal(funding.requestedHertz, 60);
  assert.equal((await store.get("project", "cq_hardware")).status, "funding_submitted");
  const fundingReview = await agent.get(`/admin/funding/${funding.id}`);
  assert.equal(fundingReview.status, 200);
  const approve = await agent.post(`/admin/funding/${funding.id}/decision`).type("form").send({ _csrf: csrf(fundingReview.text), decision: "approved", design_checked: "1", bom_checked: "1", plan_checked: "1", approved_hertz: "55", note_to_maker: "Looks buildable." });
  assert.equal(approve.status, 302);
  assert.equal((await store.get("funding_request", funding.id)).status, "approved");
  assert.equal((await store.get("user", user.id)).hertz, initialHertz);
  const approvedPage = await agent.get(`/admin/funding/${funding.id}`);
  const issue = await agent.post(`/admin/funding/${funding.id}/issue`).type("form").send({ _csrf: csrf(approvedPage.text), hcb_grant_reference: "grant-123" });
  assert.equal(issue.status, 302);
  assert.equal((await store.get("funding_request", funding.id)).status, "issued");
  assert.equal((await store.get("project", "cq_hardware")).status, "funding_issued");
});
