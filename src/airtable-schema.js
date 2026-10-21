import { airtableEntityTables, airtableTableName } from "./store.js";

export const commonAirtableFields = [
  { name: "ID", type: "singleLineText" },
  { name: "Name", type: "singleLineText" },
  { name: "Status", type: "singleLineText" },
  { name: "Owner", type: "singleLineText" },
  { name: "Data", type: "multilineText" },
  {
    name: "Updated At", type: "dateTime",
    options: { dateFormat: { name: "iso" }, timeFormat: { name: "24hour" }, timeZone: "utc" },
  },
];

export const submissionAirtableFields = [
  "Code URL", "Demo URL", "How did you hear about this", "What are we doing well",
  "how can we improve", "First Name", "Last Name", "Email", "Project banner", "Description",
  "GitHub Username", "Address line 1", "Address line 2", "City", "state/province",
  "Country(2 letter code)", "Zip/Postal code", "Birthday", "Override Hours Spent",
  "Override hours spent justification", "Claimed Hours", "Approved Hours", "Project Type", "Submission ID", "Review Status",
].map((name) => ({ name, type: "singleLineText" }));

export async function ensureAirtableSchema(config, fetchImpl = fetch, log = () => {}) {
  if (!config.airtablePat || !config.airtableBaseId) throw new Error("AIRTABLE_PAT and AIRTABLE_BASE_ID are required.");
  let lastRequestAt = 0;
  const request = async (url, options = {}) => {
    const wait = Math.max(0, (config.airtableRequestIntervalMs ?? 220) - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const response = await fetchImpl(url, {
      ...options,
      headers: { Authorization: `Bearer ${config.airtablePat}`, "Content-Type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(15_000),
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

  const created = [];
  const addedFields = [];
  for (const type of Object.keys(airtableEntityTables)) {
    const name = airtableTableName(config.airtableTablePrefix, type);
    const existingTable = (metadata.tables || []).find((table) => table.name === name);
    const requiredFields = type === "submission" ? [...commonAirtableFields, ...submissionAirtableFields] : commonAirtableFields;
    if (!existingTable) {
      await request(metadataUrl, { method: "POST", body: JSON.stringify({ name, fields: requiredFields }) });
      created.push(name);
      log(`Created ${name}`);
      continue;
    }
    const present = new Set((existingTable.fields || []).map((field) => field.name));
    for (const field of requiredFields) {
      if (present.has(field.name)) continue;
      await request(`${metadataUrl}/${encodeURIComponent(existingTable.id)}/fields`, { method: "POST", body: JSON.stringify(field) });
      addedFields.push(`${name}.${field.name}`);
      log(`Added field ${field.name} to ${name}`);
    }
  }
  return { created, addedFields };
}
