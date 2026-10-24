import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { getConfig } from "../src/config.js";
import { airtableEntityTables, createStore } from "../src/store.js";

const run = promisify(execFile);
const config = getConfig();
const output = path.resolve(process.argv[2] || `backups/cq-production-${new Date().toISOString().replaceAll(":", "-")}.tar.gz`);

function requireValue(name, value) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function readBody(body) {
  if (typeof body?.transformToByteArray === "function") return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  if (config.airtableTablePrefix !== "CQ") throw new Error("This command only backs up production CQ tables. Set AIRTABLE_TABLE_PREFIX=CQ.");
  requireValue("AIRTABLE_PAT", config.airtablePat); requireValue("AIRTABLE_BASE_ID", config.airtableBaseId);
  requireValue("R2_ENDPOINT", config.r2Endpoint); requireValue("R2_ACCESS_KEY_ID", config.r2AccessKeyId); requireValue("R2_SECRET_ACCESS_KEY", config.r2SecretAccessKey);
  const stage = await mkdtemp(path.join(tmpdir(), "cq-backup-"));
  try {
    const store = await createStore(config);
    const data = {};
    for (const type of Object.keys(airtableEntityTables)) {
      data[type] = await store.list(type);
      console.log(`Saved ${data[type].length} ${type} records.`);
    }
    await writeFile(path.join(stage, "airtable.json"), JSON.stringify(data));

    const client = new S3Client({ region: "auto", endpoint: config.r2Endpoint, credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey } });
    const objects = [];
    let token;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.r2BucketName, ContinuationToken: token }));
      for (const item of page.Contents || []) {
        if (!item.Key) continue;
        const response = await client.send(new GetObjectCommand({ Bucket: config.r2BucketName, Key: item.Key }));
        const destination = path.join(stage, "r2", item.Key);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, await readBody(response.Body));
        objects.push({ key: item.Key, contentType: response.ContentType || null, cacheControl: response.CacheControl || null });
        console.log(`Saved R2 object ${item.Key}.`);
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    const sourceTar = path.join(stage, "source.tar");
    await run("git", ["archive", "--format=tar", "HEAD", "-o", sourceTar], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
    await writeFile(path.join(stage, "manifest.json"), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), airtablePrefix: "CQ", r2Bucket: config.r2BucketName, objects, source: "source.tar" }, null, 2));
    await mkdir(path.dirname(output), { recursive: true });
    await run("tar", ["-czf", output, "-C", stage, "."]);
    await chmod(output, 0o600);
    console.log(`Backup complete: ${output}`);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(`Backup failed: ${error.message}`); process.exitCode = 1; });
