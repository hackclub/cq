import { nowIso, randomId } from "./utils.js";

const ACTIVE = new Set(["provisioning", "ready", "open", "stopping"]);

function configNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createReviewEnvironmentManager({ store, config, logger = console }) {
  const maxActive = Math.max(1, Math.min(4, config.reviewEnvironmentMaxActive || 4));
  const ttlMs = Math.max(15, config.reviewEnvironmentTtlMinutes || 120) * 60_000;

  async function active() {
    return (await store.list("review_environment")).filter((item) => ACTIVE.has(item.status));
  }

  async function proxmox(path, options = {}) {
    if (!config.proxmoxApiUrl || !config.proxmoxApiToken) throw new Error("Review environments are not configured.");
    const response = await fetch(`${config.proxmoxApiUrl.replace(/\/$/, "")}${path}`, {
      ...options,
      headers: { Accept: "application/json", Authorization: `PVEAPIToken=${config.proxmoxApiToken}`, ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors) throw new Error(body.errors || `Proxmox request failed (${response.status}).`);
    return body.data;
  }

  async function launch({ projectId, reviewId, reviewerId, repositoryUrl }) {
    const current = await active();
    if (current.length >= maxActive) throw new Error("All review environments are currently in use.");
    const id = randomId("env_");
    const vmid = configNumber(config.proxmoxVmidStart, 9100) + current.length;
    const record = { id, projectId, reviewId, reviewerId, repositoryUrl, vmid, status: "provisioning", createdAt: nowIso(), expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    await store.put("review_environment", id, record);
    try {
      await proxmox(`/nodes/${encodeURIComponent(config.proxmoxNode)}/lxc/${config.proxmoxTemplateVmid}/clone`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ newid: String(vmid), hostname: `cq-review-${id.slice(-8)}`, full: "0", target: config.proxmoxNode }),
      });
      await proxmox(`/nodes/${encodeURIComponent(config.proxmoxNode)}/lxc/${vmid}/status/start`, { method: "POST" });
      record.status = "ready";
      record.updatedAt = nowIso();
      await store.put("review_environment", id, record);
      return record;
    } catch (error) {
      record.status = "failed";
      record.failureReason = error.message;
      record.updatedAt = nowIso();
      await store.put("review_environment", id, record);
      logger.error("review environment launch failed", { id, error: error.message });
      throw error;
    }
  }

  async function destroy(record) {
    if (!record || ["destroyed", "failed"].includes(record.status)) return record;
    try { await proxmox(`/nodes/${encodeURIComponent(config.proxmoxNode)}/lxc/${record.vmid}/status/stop`, { method: "POST" }).catch(() => {}); } catch {}
    try { await proxmox(`/nodes/${encodeURIComponent(config.proxmoxNode)}/lxc/${record.vmid}`, { method: "DELETE" }).catch(() => {}); } catch {}
    const updated = { ...record, status: "destroyed", destroyedAt: nowIso(), updatedAt: nowIso() };
    await store.put("review_environment", record.id, updated);
    return updated;
  }

  async function cleanup() {
    const records = await store.list("review_environment");
    for (const record of records.filter((item) => ACTIVE.has(item.status) && new Date(item.expiresAt).getTime() <= Date.now())) await destroy(record);
  }

  const timer = setInterval(() => cleanup().catch((error) => logger.error("review environment cleanup failed", error)), 60_000);
  timer.unref?.();
  return { active, launch, destroy, cleanup, list: () => store.list("review_environment") };
}
