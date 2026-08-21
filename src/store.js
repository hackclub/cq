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

export class AirtableStore extends BaseStore {
  constructor(config, fetchImpl = fetch) {
    // Airtable is the access-controlled database. New payloads are readable JSON.
    // Keep an optional key only to read records written by older CQ deployments.
    super(config);
    this.fetch = fetchImpl;
    this.cache = new Map();
    this.cacheComplete = false;
    this.lastRequestAt = 0;
    this.requestChain = Promise.resolve();
  }

  async ready() {
    if (!this.config.airtablePat || !this.config.airtableBaseId) {
      throw new Error("AIRTABLE_PAT and AIRTABLE_BASE_ID are required.");
    }
  }

  tableUrl() {
    return `https://api.airtable.com/v0/${encodeURIComponent(this.config.airtableBaseId)}/${encodeURIComponent(this.config.airtableTableName)}`;
  }

  async request(url, options = {}) {
    const perform = async () => {
      const wait = Math.max(0, 220 - (Date.now() - this.lastRequestAt));
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

  decode(record) {
    const key = String(record.fields?.Key || "").trim();
    const type = String(record.fields?.Type || "").trim();
    const payload = record.fields?.Payload;
    // Airtable often starts a new table with an example or partially filled row.
    // It is not application data unless its key and type match CQ's record format.
    if (!key || !type || !payload || !key.startsWith(`${type}:`)) return null;
    let value;
    try {
      value = String(payload).startsWith("v1.")
        ? decryptRecord(payload, this.key)
        : JSON.parse(payload);
    } catch (error) {
      throw new Error(
        String(payload).startsWith("v1.")
          ? `Airtable record “${key}” is legacy encrypted data. Temporarily restore the DATA_ENCRYPTION_KEY that created it so CQ can read and rewrite it.`
          : `Airtable record “${key}” does not contain valid JSON.`,
        { cause: error },
      );
    }
    this.cache.set(key, { recordId: record.id, value, legacyEncrypted: String(payload).startsWith("v1.") });
    return value;
  }

  async loadAll() {
    if (this.cacheComplete) return;
    let offset = "";
    do {
      const url = new URL(this.tableUrl());
      url.searchParams.set("pageSize", "100");
      if (offset) url.searchParams.set("offset", offset);
      const body = await this.request(url);
      for (const record of body.records ?? []) this.decode(record);
      offset = body.offset ?? "";
    } while (offset);
    this.cacheComplete = true;
    // Complete the one-way migration after a successful full read. The key is
    // retained only long enough to decode legacy rows; every rewrite is JSON.
    for (const [key, record] of [...this.cache.entries()]) {
      if (!record.legacyEncrypted) continue;
      const separator = key.indexOf(":");
      await this.put(key.slice(0, separator), key.slice(separator + 1), record.value);
    }
  }

  async get(type, id) {
    await this.ready();
    const key = `${type}:${id}`;
    if (this.cache.has(key)) return this.cache.get(key).value;
    const formula = `{Key}='${key.replaceAll("'", "\\'")}'`;
    const url = new URL(this.tableUrl());
    url.searchParams.set("maxRecords", "1");
    url.searchParams.set("filterByFormula", formula);
    const body = await this.request(url);
    return body.records?.[0] ? this.decode(body.records[0]) : null;
  }

  async list(type) {
    await this.ready();
    await this.loadAll();
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
    const fields = {
      Key: key,
      Type: type,
      Payload: JSON.stringify(value, null, 2),
      "Updated At": new Date().toISOString(),
    };
    const body = cached
      ? await this.request(`${this.tableUrl()}/${cached.recordId}`, { method: "PATCH", body: JSON.stringify({ fields }) })
      : await this.request(this.tableUrl(), { method: "POST", body: JSON.stringify({ fields }) });
    this.cache.set(key, { recordId: body.id, value, legacyEncrypted: false });
    return value;
  }

  async delete(type, id) {
    await this.ready();
    const key = `${type}:${id}`;
    await this.get(type, id);
    const cached = this.cache.get(key);
    if (!cached) return false;
    await this.request(`${this.tableUrl()}/${cached.recordId}`, { method: "DELETE" });
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
