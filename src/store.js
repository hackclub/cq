import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function encryptionKey(config, { required = true } = {}) {
  if (config.dataEncryptionKey) {
    const key = Buffer.from(config.dataEncryptionKey, "base64");
    if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    return key;
  }
  if (required && config.isProduction) throw new Error("DATA_ENCRYPTION_KEY is required in production for local encrypted storage.");
  if (!required) return null;
  return crypto.createHash("sha256").update("cq-local-development-only").digest();
}

export function encryptRecord(value, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptRecord(value, key) {
  const [version, iv, tag, ciphertext] = String(value).split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Encrypted record has an invalid format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

class BaseStore {
  constructor(config, { encrypted = false } = {}) {
    this.config = config;
    this.key = encryptionKey(config, { required: encrypted });
    this.locks = new Map();
  }

  async withLock(name, operation) {
    const previous = this.locks.get(name) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(name, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(name) === queued) this.locks.delete(name);
    }
  }
}

export class LocalEncryptedStore extends BaseStore {
  constructor(config, { memory = false } = {}) {
    super(config, { encrypted: true });
    this.memory = memory;
    this.records = new Map();
    this.loaded = false;
    this.persistChain = Promise.resolve();
  }

  async ready() {
    if (this.loaded) return;
    this.loaded = true;
    if (this.memory) return;
    try {
      const data = JSON.parse(await fs.readFile(this.config.localDataPath, "utf8"));
      for (const record of data.records ?? []) this.records.set(record.key, record);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async persist() {
    if (this.memory) return;
    const contents = JSON.stringify({ records: [...this.records.values()] }, null, 2);
    this.persistChain = this.persistChain.then(async () => {
      await fs.mkdir(path.dirname(this.config.localDataPath), { recursive: true });
      const temporary = `${this.config.localDataPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporary, contents, { mode: 0o600 });
      await fs.rename(temporary, this.config.localDataPath);
    });
    await this.persistChain;
  }

  async get(type, id) {
    await this.ready();
    const record = this.records.get(`${type}:${id}`);
    return record ? decryptRecord(record.payload, this.key) : null;
  }

  async list(type) {
    await this.ready();
    return [...this.records.values()]
      .filter((record) => record.type === type)
      .map((record) => decryptRecord(record.payload, this.key));
  }

  async put(type, id, value) {
    await this.ready();
    const record = {
      key: `${type}:${id}`,
      type,
      payload: encryptRecord(value, this.key),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(record.key, record);
    await this.persist();
    return value;
  }

  async delete(type, id) {
    await this.ready();
    const removed = this.records.delete(`${type}:${id}`);
    if (removed) await this.persist();
    return removed;
  }
}

export const airtableEntityTables = Object.freeze({
  user: "Users",
  project: "Projects",
  journal: "Devlogs",
  submission: "Submissions",
  funding_request: "Funding Requests",
  order: "Orders",
  product: "Shop Products",
  country: "Countries",
  review_action: "Review Actions",
  audit: "Audit Log",
  ledger: "Hertz Ledger",
  notification: "Slack Notifications",
  delivery: "Ari Deliveries",
  cart: "Carts",
  session: "Sessions",
  oauth: "OAuth States",
  hackatime_oauth: "Hackatime OAuth States",
  hackatime_token: "Hackatime Tokens",
  hackatime_cache: "Hackatime Cache",
});

export function airtableTableName(prefix, type) {
  const label = airtableEntityTables[type];
  if (!label) throw new Error(`No Airtable table is configured for record type “${type}”.`);
  return `${String(prefix || "CQ").trim()} ${label}`.trim();
}

function airtableSummary(type, value = {}) {
  const text = (input, maximum = 500) => String(input ?? "").trim().slice(0, maximum);
  const summaries = {
    user: [value.name, userStatus(value), value.email],
    project: [value.title, value.status, value.userId],
    journal: [value.title || "Project update", `${Number(value.minutes) || 0} minutes`, value.projectId],
    submission: [value.externalId || value.id, value.decision || value.phase, value.projectId],
    funding_request: [value.projectId || value.id, value.status, value.userId],
    order: [value.id, value.status, value.userId],
    product: [value.name, value.active === false ? "Inactive" : "Active", value.category],
    country: [value.name, value.fulfilmentMode, value.code || value.id],
    review_action: [value.action, value.action, value.reviewerName || value.reviewerId],
    audit: [value.summary || value.action, value.action, value.actorName || value.actorId],
    ledger: [value.reason, `${Number(value.delta) || 0} hertz`, value.userId],
    notification: [value.kind, value.status, value.userId || value.entityId],
    delivery: [value.event || value.id, value.status || value.outcome, value.externalId],
    cart: [value.productId || value.id, `${Number(value.quantity) || 0} items`, value.userId],
    session: [value.id, value.expiresAt ? "Active" : "Stored", value.userId],
    oauth: [value.id, "Pending", value.returnTo],
    hackatime_oauth: [value.id, "Pending", value.userId],
    hackatime_token: [value.account?.username || value.id, "Connected", value.userId || value.id],
    hackatime_cache: [value.id, value.fetchedAt || "Cached", value.userId || value.id],
  };
  const [name, status, owner] = summaries[type] || [value.name || value.id, value.status, value.userId];
  return { Name: text(name), Status: text(status), Owner: text(owner) };
}

export function airtableRecordFields(type, id, value, updatedAt = new Date().toISOString()) {
  return {
    ID: String(id),
    ...airtableSummary(type, value),
    Data: JSON.stringify(value, null, 2),
    "Updated At": updatedAt,
  };
}

function userStatus(value) {
  const roles = Array.isArray(value.roles) ? value.roles : [value.role].filter(Boolean);
  return roles.length ? roles.join(", ") : value.verificationStatus;
}

export class AirtableStore extends BaseStore {
  constructor(config, fetchImpl = fetch) {
    // Airtable is the access-controlled database. New payloads are readable JSON.
    // Keep an optional key only to read records written by older CQ deployments.
    super(config);
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.loadedTypes = new Set();
    this.lastRequestAt = 0;
    this.requestChain = Promise.resolve();
  }

  async ready() {
    if (!this.config.airtablePat || !this.config.airtableBaseId) {
      throw new Error("AIRTABLE_PAT and AIRTABLE_BASE_ID are required.");
    }
  }

  tableUrl(type) {
    const table = airtableTableName(this.config.airtableTablePrefix, type);
    return `https://api.airtable.com/v0/${encodeURIComponent(this.config.airtableBaseId)}/${encodeURIComponent(table)}`;
  }

  async request(url, options = {}) {
    const perform = async () => {
      const interval = this.config.airtableRequestIntervalMs ?? 220;
      const wait = Math.max(0, interval - (Date.now() - this.lastRequestAt));
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
      const response = await this.fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${this.config.airtablePat}`,
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      if (!response.ok) throw new Error(body.error?.message || body.error || `Airtable returned ${response.status}.`);
      return body;
    };
    const request = this.requestChain.then(perform, perform);
    this.requestChain = request.catch(() => {});
    return request;
  }

  decode(type, record) {
    const id = String(record.fields?.ID || "").trim();
    const payload = record.fields?.Data;
    // Airtable often starts a new table with an example or partially filled row.
    // It is not application data unless its key and type match CQ's record format.
    if (!id || !payload || (id === "ID" && payload === "Data")) return null;
    let value;
    try {
      value = String(payload).startsWith("v1.")
        ? decryptRecord(payload, this.key)
        : JSON.parse(payload);
    } catch (error) {
      throw new Error(
        String(payload).startsWith("v1.")
          ? `Airtable ${type} record “${id}” is encrypted legacy data. Run the Airtable migration with its original DATA_ENCRYPTION_KEY.`
          : `Airtable ${type} record “${id}” does not contain valid JSON.`,
        { cause: error },
      );
    }
    this.cache.set(`${type}:${id}`, { recordId: record.id, value });
    return value;
  }

  async loadType(type) {
    if (this.loadedTypes.has(type)) return;
    try {
      let offset = "";
      do {
        const url = new URL(this.tableUrl(type));
        url.searchParams.set("pageSize", "100");
        if (offset) url.searchParams.set("offset", offset);
        const body = await this.request(url);
        for (const record of body.records ?? []) this.decode(type, record);
        offset = body.offset ?? "";
      } while (offset);
      this.loadedTypes.add(type);
    } catch (error) {
      const table = airtableTableName(this.config.airtableTablePrefix, type);
      throw new Error(
        `CQ could not open the Airtable table “${table}”. Run “npm run airtable:setup” with the same AIRTABLE_TABLE_PREFIX, and confirm the PAT can read records in this base. Airtable said: ${error.message}`,
        { cause: error },
      );
    }
  }

  async get(type, id) {
    await this.ready();
    const key = `${type}:${id}`;
    if (this.cache.has(key)) return this.cache.get(key).value;
    const formula = `{ID}='${String(id).replaceAll("'", "\\'")}'`;
    const url = new URL(this.tableUrl(type));
    url.searchParams.set("maxRecords", "1");
    url.searchParams.set("filterByFormula", formula);
    const body = await this.request(url);
    return body.records?.[0] ? this.decode(type, body.records[0]) : null;
  }

  async list(type) {
    await this.ready();
    await this.loadType(type);
    return [...this.cache.entries()]
      .filter(([key]) => key.startsWith(`${type}:`))
      .map(([, record]) => record.value);
  }

  async put(type, id, value) {
    await this.ready();
    const key = `${type}:${id}`;
    let cached = this.cache.get(key);
    if (!cached) {
      await this.get(type, id);
      cached = this.cache.get(key);
    }
    const fields = airtableRecordFields(type, id, value);
    const body = cached
      ? await this.request(`${this.tableUrl(type)}/${cached.recordId}`, { method: "PATCH", body: JSON.stringify({ fields }) })
      : await this.request(this.tableUrl(type), { method: "POST", body: JSON.stringify({ fields }) });
    this.cache.set(key, { recordId: body.id, value });
    return value;
  }

  async delete(type, id) {
    await this.ready();
    const key = `${type}:${id}`;
    await this.get(type, id);
    const cached = this.cache.get(key);
    if (!cached) return false;
    await this.request(`${this.tableUrl(type)}/${cached.recordId}`, { method: "DELETE" });
    this.cache.delete(key);
    return true;
  }
}

// Backwards-compatible export for deployments or tests importing the old name.
export const AirtableEncryptedStore = AirtableStore;

export async function createStore(config, options = {}) {
  if (config.isProduction && (!config.airtablePat || !config.airtableBaseId)) {
    throw new Error("Production requires AIRTABLE_PAT and AIRTABLE_BASE_ID.");
  }
  const store =
    config.airtablePat && config.airtableBaseId
      ? new AirtableStore(config, options.fetchImpl)
      : new LocalEncryptedStore(config, { memory: options.memory });
  await store.ready();
  return store;
}
