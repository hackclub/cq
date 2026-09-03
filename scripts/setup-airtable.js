import process from "node:process";
import { pathToFileURL } from "node:url";
import { getConfig } from "../src/config.js";
import {
  airtableEntityTables,
  airtableRecordFields,
  airtableTableName,
  decryptRecord,
} from "../src/store.js";

const commonFields = [
  { name: "ID", type: "singleLineText" },
  { name: "Name", type: "singleLineText" },
  { name: "Status", type: "singleLineText" },
  { name: "Owner", type: "singleLineText" },
  { name: "Data", type: "multilineText" },
  {
    name: "Updated At",
    type: "dateTime",
    options: {
      dateFormat: { name: "iso" },
      timeFormat: { name: "24hour" },
      timeZone: "utc",
    },
  },
];

const submissionFields = [
  "Code URL", "Demo URL", "How did you hear about this", "What are we doing well",
  "how can we improve", "First Name", "Last Name", "Email", "Project banner", "Description",
  "GitHub Username", "Address line 1", "Address line 2", "City", "state/province",
  "Country(2 letter code)", "Zip/Postal code", "Birthday", "Override Hours Spent",
  "Override hours spent justification", "Claimed Hours", "Approved Hours", "Project Type", "Submission ID", "Review Status",
].map((name) => ({ name, type: "singleLineText" }));

function legacyValue(payload, encryptionKey) {
  if (!String(payload).startsWith("v1.")) return JSON.parse(payload);
  if (!encryptionKey) throw new Error("DATA_ENCRYPTION_KEY is required to migrate encrypted legacy rows.");
  const key = Buffer.from(encryptionKey, "base64");
  if (key.length !== 32) throw new Error("DATA_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return decryptRecord(payload, key);
}

export async function setupAirtable(config, fetchImpl = fetch) {
  if (!config.airtablePat || !config.airtableBaseId) {
    throw new Error("AIRTABLE_PAT and AIRTABLE_BASE_ID are required.");
  }
  let lastRequestAt = 0;
  const request = async (url, options = {}) => {
    const interval = config.airtableRequestIntervalMs ?? 220;
    const wait = Math.max(0, interval - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const response = await fetchImpl(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.airtablePat}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!response.ok) throw new Error(body.error?.message || body.error || `Airtable returned ${response.status}.`);
    return body;
  };

  const metadataUrl = `https://api.airtable.com/v0/meta/bases/${encodeURIComponent(config.airtableBaseId)}/tables`;
  let metadata;
  try {
    metadata = await request(metadataUrl);
  } catch (error) {
    throw new Error(
      `CQ could not inspect the Airtable base. Give this PAT schema.bases:read, schema.bases:write, data.records:read, and data.records:write access to the selected base. Airtable said: ${error.message}`,
      { cause: error },
    );
  }
  const existingNames = new Set((metadata.tables || []).map((table) => table.name));
  const created = [];
  for (const type of Object.keys(airtableEntityTables)) {
    const name = airtableTableName(config.airtableTablePrefix, type);
    const existingTable = (metadata.tables || []).find((table) => table.name === name);
    if (existingTable) {
      if (type === "submission") {
        const present = new Set((existingTable.fields || []).map((field) => field.name));
        for (const field of submissionFields) {
          if (present.has(field.name)) continue;
          await request(`${metadataUrl}/${encodeURIComponent(existingTable.id)}/fields`, {
            method: "POST", body: JSON.stringify(field),
          });
        }
      }
      continue;
    }
    await request(metadataUrl, {
      method: "POST",
      body: JSON.stringify({ name, fields: type === "submission" ? [...commonFields, ...submissionFields] : commonFields }),
    });
    existingNames.add(name);
    created.push(name);
  }

  const legacyUrl = `https://api.airtable.com/v0/${encodeURIComponent(config.airtableBaseId)}/${encodeURIComponent(config.airtableTableName)}`;
  let offset = "";
  let migrated = 0;
  let skipped = 0;
  do {
    const url = new URL(legacyUrl);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    let page;
    try {
      page = await request(url);
    } catch (error) {
      if (/not found|could not find|unknown table/i.test(error.message)) break;
      throw error;
    }
    for (const record of page.records || []) {
      const type = String(record.fields?.Type || "").trim();
      const key = String(record.fields?.Key || "").trim();
      const payload = record.fields?.Payload;
      if (!airtableEntityTables[type] || !key.startsWith(`${type}:`) || !payload) {
        skipped += 1;
        continue;
      }
      const id = key.slice(type.length + 1);
      const tableUrl = `https://api.airtable.com/v0/${encodeURIComponent(config.airtableBaseId)}/${encodeURIComponent(airtableTableName(config.airtableTablePrefix, type))}`;
      const lookup = new URL(tableUrl);
      lookup.searchParams.set("maxRecords", "1");
      lookup.searchParams.set("filterByFormula", `{ID}='${id.replaceAll("'", "\\'")}'`);
      const existing = await request(lookup);
      if (existing.records?.length) {
        skipped += 1;
        continue;
      }
      const value = legacyValue(String(payload), config.dataEncryptionKey);
      await request(tableUrl, {
        method: "POST",
        body: JSON.stringify({
          fields: airtableRecordFields(type, id, value, record.fields?.["Updated At"] || new Date().toISOString()),
        }),
      });
      migrated += 1;
    }
    offset = page.offset || "";
  } while (offset);

  return { created, migrated, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setupAirtable(getConfig())
    .then(({ created, migrated, skipped }) => {
      console.log(`Airtable ready: ${created.length} tables created, ${migrated} records migrated, ${skipped} records skipped.`);
      console.log("The legacy table was not changed or deleted.");
    })
    .catch((error) => {
      console.error(`Airtable setup failed: ${error.message}`);
      process.exitCode = 1;
    });
}
