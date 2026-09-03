import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function integer(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function keyValue(directValue, base64Value) {
  if (directValue) return String(directValue).replace(/\\n/g, "\n");
  if (!base64Value) return "";
  try { return Buffer.from(String(base64Value), "base64").toString("utf8"); } catch { return ""; }
}

export function getConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const baseUrl = (overrides.baseUrl ?? process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  return {
    projectRoot,
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: integer(overrides.port ?? process.env.PORT, 3000),
    baseUrl,
    localDataPath: path.resolve(projectRoot, overrides.localDataPath ?? process.env.LOCAL_DATA_PATH ?? "./data/cq.local.json"),
    airtablePat: overrides.airtablePat ?? process.env.AIRTABLE_PAT ?? "",
    airtableBaseId: overrides.airtableBaseId ?? process.env.AIRTABLE_BASE_ID ?? "",
    airtableTablePrefix: overrides.airtableTablePrefix ?? process.env.AIRTABLE_TABLE_PREFIX ?? "CQ",
    // Used only by the one-way migration script for older single-table deployments.
    airtableTableName: overrides.airtableTableName ?? process.env.AIRTABLE_TABLE_NAME ?? "CQ Data",
    dataEncryptionKey: overrides.dataEncryptionKey ?? process.env.DATA_ENCRYPTION_KEY ?? "",
    adminEmails: String(overrides.adminEmails ?? process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    slackBotToken: overrides.slackBotToken ?? process.env.SLACK_BOT_TOKEN ?? "",
    slackAdminChannelId: overrides.slackAdminChannelId ?? process.env.SLACK_ADMIN_CHANNEL_ID ?? "",
    slackSecurityUserId: overrides.slackSecurityUserId ?? process.env.SLACK_SECURITY_USER_ID ?? "",
    internalFrequencyKey: keyValue(
      overrides.internalFrequencyKey ?? process.env.INTERNAL_FREQUENCY_KEY ?? "",
      overrides.internalFrequencyKeyB64 ?? process.env.INTERNAL_FREQUENCY_KEY_B64 ?? "",
    ),
    hackClubCdnApiKey: overrides.hackClubCdnApiKey ?? process.env.HACKCLUB_CDN_API_KEY ?? "",
    githubToken: overrides.githubToken ?? process.env.GITHUB_TOKEN ?? "",
    sessionCookieName: overrides.sessionCookieName ?? process.env.SESSION_COOKIE_NAME ?? "cq_session",
    sessionDays: integer(overrides.sessionDays ?? process.env.SESSION_DAYS, 14),
    organizerVerificationMinutes: integer(overrides.organizerVerificationMinutes ?? process.env.ORGANIZER_VERIFICATION_MINUTES, 10),
    hackClubClientId: overrides.hackClubClientId ?? process.env.HACKCLUB_CLIENT_ID ?? "",
    hackClubClientSecret: overrides.hackClubClientSecret ?? process.env.HACKCLUB_CLIENT_SECRET ?? "",
    hackClubRedirectUri:
      overrides.hackClubRedirectUri ??
      process.env.HACKCLUB_REDIRECT_URI ??
      `${baseUrl}/auth/callback`,
    hackatimeClientId: overrides.hackatimeClientId ?? process.env.HACKATIME_CLIENT_ID ?? "",
    hackatimeClientSecret: overrides.hackatimeClientSecret ?? process.env.HACKATIME_CLIENT_SECRET ?? "",
    hackatimeRedirectUri:
      overrides.hackatimeRedirectUri ??
      process.env.HACKATIME_REDIRECT_URI ??
      `${baseUrl}/app/hackatime/callback`,
    devAuthBypass:
      !["production", "test"].includes(nodeEnv) &&
      String(overrides.devAuthBypass ?? process.env.DEV_AUTH_BYPASS ?? "false") === "true",
    ariProgramId: overrides.ariProgramId ?? process.env.ARI_PROGRAM_ID ?? "",
    ariSigningSecret: overrides.ariSigningSecret ?? process.env.ARI_SIGNING_SECRET ?? "",
    ariWebhookSecret:
      overrides.ariWebhookSecret ??
      process.env.ARI_WEBHOOK_SECRET ??
      overrides.ariSigningSecret ??
      process.env.ARI_SIGNING_SECRET ??
      "",
  };
}
