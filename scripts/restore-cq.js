import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getConfig } from "../src/config.js";
import { airtableEntityTables, createStore } from "../src/store.js";

const run = promisify(execFile);
const archive = path.resolve(process.argv[2] || "");
const confirmed = process.argv.includes("--confirm-restore");
const config = getConfig();

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

async function main() {
  if (!archive || !confirmed) throw new Error("Usage: npm run restore:prod -- /path/to/backup.tar.gz --confirm-restore");
  if (config.airtableTablePrefix !== "CQ") throw new Error("Restore targets production CQ tables only. Set AIRTABLE_TABLE_PREFIX=CQ.");
  const stage = await mkdtemp(path.join(tmpdir(), "cq-restore-"));
  try {
    await run("tar", ["-xzf", archive, "-C", stage]);
    const manifest = JSON.parse(await readFile(path.join(stage, "manifest.json"), "utf8"));
    if (manifest.version !== 1 || manifest.airtablePrefix !== "CQ") throw new Error("This is not a CQ production backup archive.");
    const store = await createStore(config);
    const data = JSON.parse(await readFile(path.join(stage, "airtable.json"), "utf8"));
    for (const type of Object.keys(airtableEntityTables)) for (const record of data[type] || []) await store.put(type, record.id, record);
    const client = new S3Client({ region: "auto", endpoint: config.r2Endpoint, credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey } });
    for (const object of manifest.objects || []) {
      const source = path.join(stage, "r2", object.key);
      await client.send(new PutObjectCommand({ Bucket: config.r2BucketName, Key: object.key, Body: await readFile(source), ...(object.contentType ? { ContentType: object.contentType } : {}), ...(object.cacheControl ? { CacheControl: object.cacheControl } : {}) }));
    }
    console.log(`Restored ${Object.values(data).reduce((count, records) => count + records.length, 0)} Airtable records and ${(manifest.objects || []).length} R2 objects.`);
    console.log("The archive also contains source.tar for recovering the exact application source.");
  } finally { await rm(stage, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(`Restore failed: ${error.message}`); process.exitCode = 1; });
