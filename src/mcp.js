import readline from "node:readline";
import { getConfig } from "./config.js";
import { createStore } from "./store.js";
import { seedStore } from "./seed.js";
import { createHackatimeClient } from "./hackatime.js";
import { createGitHubClient } from "./github.js";

const tools = [
  ["get_project", "Read one CQ project you own, or any project when using an organizer token.", { project_id: { type: "string" } }],
  ["get_submission", "Read one of your submissions and its participant-visible review state.", { submission_id: { type: "string" } }],
  ["get_devlogs", "Read devlogs for one CQ project you can access.", { project_id: { type: "string" } }],
  ["get_funding_request", "Read the hardware funding request for one CQ project you can access.", { project_id: { type: "string" } }],
  ["get_review_history", "Read participant-visible review history for one CQ project or submission.", { project_id: { type: "string" } }],
  ["get_repository_evidence", "Read public repository evidence when supported.", { repo_url: { type: "string" } }],
  ["get_hackatime_activity", "Read your cached Hackatime activity, or another user's activity with an organizer token.", { user_id: { type: "string" } }],
];

function result(id, value) { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } }; }
function error(id, message) { return { jsonrpc: "2.0", id, error: { code: -32000, message } }; }
function notPermitted(id) { return error(id, "Not found or not permitted."); }

function canAccessProject(actor, project) {
  return Boolean(project && (actor?.privileged || (actor?.userId && project.userId === actor.userId)));
}

function participantSubmission(submission) {
  const review = submission.review || {};
  return {
    id: submission.id,
    projectId: submission.projectId,
    phase: submission.phase,
    decision: submission.decision,
    event: submission.event,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
    review: submission.review ? {
      approved_minutes: review.approved_minutes,
      approved_hours: review.approved_hours,
      note_to_maker: review.note_to_maker,
      reviewed_at: review.reviewed_at,
    } : null,
  };
}

function participantReviewAction(action) {
  return {
    id: action.id,
    action: action.action,
    decision: action.decision,
    noteToMaker: action.noteToMaker,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function participantFundingRequest(request) {
  if (!request) return null;
  const firstPass = request.firstPass || {};
  const review = request.review || {};
  return {
    id: request.id,
    projectId: request.projectId,
    status: request.status,
    requestedUsd: request.requestedUsd ?? request.requestedHertz ?? 0,
    bomTotal: request.bomTotal ?? null,
    designMinutes: request.designMinutes ?? 0,
    buildPlan: request.buildPlan,
    bomItems: request.bomItems || [],
    designUrl: request.designUrl,
    firmwareUrl: request.firmwareUrl,
    testPlan: request.testPlan,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    firstPass: request.firstPass ? { decision: firstPass.decision, noteToMaker: firstPass.noteToMaker, reviewedAt: firstPass.reviewedAt } : null,
    review: request.review ? { decision: review.decision, noteToMaker: review.noteToMaker, approvedUsd: review.approvedUsd ?? review.approvedHertz, reviewedAt: review.reviewedAt } : null,
    issuedAt: request.issuedAt,
  };
}

export function createMcpHandler({ store, githubClient, hackatimeClient }) {
  return async (message, actor = { privileged: true }) => {
    const { id, method, params = {} } = message;
    if (method === "initialize") return result(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cq-readonly", version: "1.1.0" } });
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return result(id, { tools: tools.map(([name, description, properties]) => ({ name, description, inputSchema: { type: "object", properties, required: Object.keys(properties) } })) });
    if (method !== "tools/call") return error(id, "Unsupported MCP method.");
    const name = params.name;
    const args = params.arguments || {};
    if (!tools.some((tool) => tool[0] === name)) return error(id, "Unknown or unavailable read-only tool.");

    if (name === "get_repository_evidence") return result(id, await githubClient.repository(args.repo_url));
    if (name === "get_hackatime_activity") {
      if (!actor.privileged && args.user_id !== actor.userId) return notPermitted(id);
      return result(id, await hackatimeClient.projects(args.user_id));
    }

    let project;
    if (name === "get_submission") {
      const submission = await store.get("submission", args.submission_id);
      project = submission ? await store.get("project", submission.projectId) : null;
      if (!submission || !canAccessProject(actor, project)) return notPermitted(id);
      return result(id, actor.privileged ? submission : participantSubmission(submission));
    }

    const directProject = await store.get("project", args.project_id);
    if (name === "get_review_history" && !directProject) {
      const submission = await store.get("submission", args.project_id);
      project = submission ? await store.get("project", submission.projectId) : null;
    } else {
      project = directProject;
    }
    if (!canAccessProject(actor, project)) return notPermitted(id);

    if (name === "get_project") return result(id, project);
    if (name === "get_devlogs") return result(id, (await store.list("journal")).filter((item) => item.projectId === project.id));
    if (name === "get_funding_request") {
      const request = (await store.list("funding_request")).find((item) => item.projectId === project.id) || null;
      return result(id, actor.privileged ? request : participantFundingRequest(request));
    }
    const actions = (await store.list("review_action")).filter((item) => item.projectId === project.id || item.submissionId === args.project_id);
    return result(id, actor.privileged ? actions : actions.map(participantReviewAction));
  };
}

export async function runMcpServer({ config = getConfig(), store = null, githubClient = null, hackatimeClient = null } = {}) {
  const dataStore = store ?? await createStore(config);
  await seedStore(dataStore);
  const github = githubClient ?? createGitHubClient(config);
  const hackatime = hackatimeClient ?? createHackatimeClient(config, dataStore);
  const handle = createMcpHandler({ store: dataStore, githubClient: github, hackatimeClient: hackatime });
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", async (line) => {
    try {
      const response = await handle(JSON.parse(line), { privileged: true });
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (cause) {
      process.stdout.write(`${JSON.stringify(error(null, cause.message))}\n`);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) runMcpServer();
