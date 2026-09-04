import { nowIso, randomId } from "./utils.js";

const secretKey = /(^|_)(access_?token|refresh_?token|secret|password|authorization|airtable_?pat|encryption_?key)($|_)/i;
const privateKey = /^(csrf|email|phone|birth|address|postal|zip|shipping|slack|city|region)/i;

function safeValue(value, depth = 0) {
  if (depth > 7) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    (secretKey.test(key) || privateKey.test(key)) ? "[redacted]" : safeValue(item, depth + 1),
  ]));
}

export async function writeAudit(store, actor, {
  action,
  entityType,
  entityId,
  summary,
  before = null,
  after = null,
  metadata = null,
}) {
  const timestamp = nowIso();
  const record = {
    id: randomId("audit_"),
    actorId: actor?.id || "system",
    actorName: actor?.name || "CQ system",
    actorEmail: actor?.email || "",
    action: String(action || "unknown"),
    entityType: String(entityType || "record"),
    entityId: String(entityId || ""),
    summary: String(summary || action || "Organizer action").slice(0, 500),
    before: before ? safeValue(before) : null,
    after: after ? safeValue(after) : null,
    metadata: metadata ? safeValue(metadata) : null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await store.put("audit", record.id, record);
  return record;
}
