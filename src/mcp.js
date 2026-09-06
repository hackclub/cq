import readline from "node:readline";
import { getConfig } from "./config.js";
import { createStore } from "./store.js";
import { seedStore } from "./seed.js";
import { createHackatimeClient } from "./hackatime.js";
import { createGitHubClient } from "./github.js";

const tools = [
  ["get_project", "Read a CQ project and its public metadata.", { project_id: { type: "string" } }],
  ["get_submission", "Read a project submission and prior review state.", { submission_id: { type: "string" } }],
  ["get_devlogs", "Read all devlogs for a CQ project.", { project_id: { type: "string" } }],
  ["get_funding_request", "Read the hardware funding request for a project.", { project_id: { type: "string" } }],
  ["get_review_history", "Read review actions for a project or submission.", { project_id: { type: "string" } }],
  ["get_repository_evidence", "Read public repository evidence when supported.", { repo_url: { type: "string" } }],
  ["get_hackatime_activity", "Read cached Hackatime activity for a user.", { user_id: { type: "string" } }],
];

function result(id, value) { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } }; }
function error(id, message) { return { jsonrpc: "2.0", id, error: { code: -32000, message } }; }

export function createMcpHandler({ store, githubClient, hackatimeClient }) {
  return async (message) => {
    const { id, method, params = {} } = message;
    if (method === "initialize") return result(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cq-readonly-review", version: "1.0.0" } });
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return result(id, { tools: tools.map(([name, description, properties]) => ({ name, description, inputSchema: { type: "object", properties, required: Object.keys(properties) } })) });
    if (method !== "tools/call") return error(id, "Unsupported MCP method.");
    const name = params.name; const args = params.arguments || {};
    if (!tools.some((tool) => tool[0] === name)) return error(id, "Unknown or unavailable read-only tool.");
    let value;
    if (name === "get_project") value = await store.get("project", args.project_id);
    else if (name === "get_submission") value = await store.get("submission", args.submission_id);
    else if (name === "get_devlogs") value = (await store.list("journal")).filter((item) => item.projectId === args.project_id);
    else if (name === "get_funding_request") value = (await store.list("funding_request")).find((item) => item.projectId === args.project_id) || null;
    else if (name === "get_review_history") value = (await store.list("review_action")).filter((item) => item.projectId === args.project_id || item.submissionId === args.project_id);
    else if (name === "get_repository_evidence") value = await githubClient.repository(args.repo_url);
    else if (name === "get_hackatime_activity") value = await hackatimeClient.projects(args.user_id);
    return value === undefined ? error(id, "Not found.") : result(id, value);
  };
}

export async function runMcpServer({ config = getConfig(), store = null, githubClient = null, hackatimeClient = null } = {}) {
  const dataStore = store ?? await createStore(config);
  await seedStore(dataStore);
  const github = githubClient ?? createGitHubClient(config);
  const hackatime = hackatimeClient ?? createHackatimeClient(config, dataStore);
  const handle = createMcpHandler({ store: dataStore, githubClient: github, hackatimeClient: hackatime });
  /* const handle = async (message) => {
    const { id, method, params = {} } = message;
    if (method === "initialize") return result(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cq-readonly-review", version: "1.0.0" } });
    if (method === "notifications/initialized") return null;
    if (method === "tools/list") return result(id, { tools: tools.map(([name, description, properties]) => ({ name, description, inputSchema: { type: "object", properties, required: Object.keys(properties) } })) });
    if (method !== "tools/call") return error(id, "Unsupported MCP method.");
    const name = params.name; const args = params.arguments || {};
    if (!tools.some((tool) => tool[0] === name)) return error(id, "Unknown or unavailable read-only tool.");
    let value;
    if (name === "get_project") value = await dataStore.get("project", args.project_id);
    else if (name === "get_submission") value = await dataStore.get("submission", args.submission_id);
    else if (name === "get_devlogs") value = (await dataStore.list("journal")).filter((item) => item.projectId === args.project_id);
    else if (name === "get_funding_request") value = (await dataStore.list("funding_request")).find((item) => item.projectId === args.project_id) || null;
    else if (name === "get_review_history") value = (await dataStore.list("review_action")).filter((item) => item.projectId === args.project_id || item.submissionId === args.project_id);
    else if (name === "get_repository_evidence") value = await github.repository(args.repo_url);
    else if (name === "get_hackatime_activity") value = await hackatime.projects(args.user_id);
    if (value === undefined) return error(id, "Not found.");
    return result(id, value);
  }; */
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", async (line) => { try { const response = await handle(JSON.parse(line)); if (response) process.stdout.write(`${JSON.stringify(response)}\n`); } catch (e) { process.stdout.write(`${JSON.stringify(error(null, e.message))}\n`); } });
}

if (import.meta.url === `file://${process.argv[1]}`) runMcpServer();
