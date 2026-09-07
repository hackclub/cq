import { nowIso, randomId } from "./utils.js";

const ACTIVE = new Set(["provisioning", "ready", "open", "stopping", "stopped", "restarting"]);

export function createReviewEnvironmentManager({ store, config, logger = console }) {
  const maxActive = Math.max(1, Math.min(4, config.reviewEnvironmentMaxActive || 4));
  const ttlMs = Math.max(15, config.reviewEnvironmentTtlMinutes || 120) * 60_000;
  let capacityCache = null;
  let capacityCacheAt = 0;
  async function request(path, { method = "GET", body } = {}) {
    if (!config.reviewAgentUrl || !config.reviewAgentToken) throw new Error("Review environment service is not configured.");
    const response = await fetch(`${config.reviewAgentUrl}${path}`, { method, headers: { Accept: "application/json", Authorization: `Bearer ${config.reviewAgentToken}`, ...(config.cloudflareAccessClientId ? { "CF-Access-Client-Id": config.cloudflareAccessClientId, "CF-Access-Client-Secret": config.cloudflareAccessClientSecret } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path === "/v1/capacity" ? 5_000 : 30_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = {
        url: response.url,
        status: response.status,
        server: response.headers.get("server") || undefined,
        cfRay: response.headers.get("cf-ray") || undefined,
        via: response.headers.get("via") || undefined,
      };
      logger.warn?.("review environment service response", details);
      const suffix = Object.entries(details).filter(([, value]) => value).map(([key, value]) => `${key}=${value}`).join(" ");
      throw new Error(`${payload.error || `Review environment service failed (${response.status}).`} [${suffix}]`);
    }
    return payload;
  }
  async function active() { return (await store.list("review_environment")).filter((item) => ACTIVE.has(item.status)); }
  async function capacity() {
    if (capacityCache && Date.now() - capacityCacheAt < 5_000) return capacityCache;
    try {
      const value = await request("/v1/capacity");
      capacityCache = value;
      capacityCacheAt = Date.now();
      return value;
    }
    catch {
      const current = await active();
      capacityCache = { active: current.length, available: Math.max(0, maxActive - current.length), maximum: maxActive, unavailable: true };
      capacityCacheAt = Date.now();
      return capacityCache;
    }
  }
  async function sync(record) {
    if (!record || !ACTIVE.has(record.status)) return record;
    try {
      const remote = await request(`/v1/environments/${encodeURIComponent(record.id)}`);
      const updated = { ...record, ...remote, updatedAt: nowIso() };
      await store.put("review_environment", record.id, updated);
      return updated;
    } catch (error) {
      logger.warn?.("review sandbox status refresh failed", { id: record.id, error: error.message });
      return record;
    }
  }
  async function launch({ projectId, reviewId, reviewerId, repositoryUrl }) {
    const existing = (await active()).find((item) => item.reviewId === reviewId);
    if (existing) return sync(existing);
    const current = await active();
    if (current.length >= maxActive) throw new Error("All review environments are currently in use.");
    const used = new Set(current.map((item) => item.vmid));
    const vmid = [...Array(maxActive)].map((_, index) => config.proxmoxVmidStart + index).find((id) => !used.has(id));
    if (!vmid) throw new Error("No review VMID is available.");
    const record = { id: randomId("env_"), projectId, reviewId, reviewerId, repositoryUrl, vmid, status: "provisioning", createdAt: nowIso(), expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    await store.put("review_environment", record.id, record);
    try {
      const remote = await request("/v1/environments", { method: "POST", body: { environmentId: record.id, projectId, reviewId, reviewerId, repositoryUrl, vmid, expiresAt: record.expiresAt } });
      const updated = { ...record, ...remote, status: remote.status || "ready", updatedAt: nowIso() };
      await store.put("review_environment", record.id, updated);
      return updated;
    } catch (error) {
      const failed = { ...record, status: "failed", failureReason: error.message, updatedAt: nowIso() };
      await store.put("review_environment", record.id, failed);
      logger.error("review environment launch failed", { id: record.id, error: error.message });
      throw error;
    }
  }
  async function destroy(record) {
    if (!record || record.status === "destroyed") return record;
    try {
      const remote = await request(`/v1/environments/${encodeURIComponent(record.id)}?action=destroy`, { method: "POST" });
      const updated = { ...record, ...remote, status: "destroyed", destroyedAt: nowIso(), updatedAt: nowIso() };
      await store.put("review_environment", record.id, updated);
      return updated;
    } catch (error) {
      const failed = { ...record, status: "failed", failureReason: error.message, updatedAt: nowIso() };
      await store.put("review_environment", record.id, failed);
      throw error;
    }
  }
  async function extend(record, minutes = 30) {
    if (!record || !ACTIVE.has(record.status)) throw new Error("No active review sandbox was found.");
    const remote = await request(`/v1/environments/${encodeURIComponent(record.id)}?action=extend`, { method: "POST", body: { minutes } });
    const updated = { ...record, ...remote, updatedAt: nowIso() };
    await store.put("review_environment", record.id, updated);
    return updated;
  }
  async function restart(record) {
    if (!record || !ACTIVE.has(record.status)) throw new Error("No active review sandbox was found.");
    const remote = await request(`/v1/environments/${encodeURIComponent(record.id)}?action=restart`, { method: "POST" });
    const updated = { ...record, ...remote, updatedAt: nowIso() };
    await store.put("review_environment", record.id, updated);
    return updated;
  }
  async function cleanup() { for (const record of (await active()).filter((item) => new Date(item.expiresAt).getTime() <= Date.now())) await destroy(record); }
  const timer = setInterval(() => cleanup().catch((error) => logger.error("review environment cleanup failed", error)), 60_000);
  timer.unref?.();
  return { active, launch, destroy, extend, restart, sync, capacity, cleanup, list: () => store.list("review_environment"), health: () => request("/v1/health") };
}
