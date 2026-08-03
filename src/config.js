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

export function getConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const baseUrl = (overrides.baseUrl ?? process.env.BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

  return {
    projectRoot,
    nodeEnv,
    isProduction: nodeEnv === "production",
    port: integer(overrides.port ?? process.env.PORT, 3000),
    baseUrl,
    localDataPath: path.resolve(projectRoot, overrides.localDataPath ?? "./data/cq.local.json"),
    airtablePat: overrides.airtablePat ?? process.env.AIRTABLE_PAT ?? "",
    airtableBaseId: overrides.airtableBaseId ?? process.env.AIRTABLE_BASE_ID ?? "",
    airtableTableName: overrides.airtableTableName ?? process.env.AIRTABLE_TABLE_NAME ?? "CQ Data",
    dataEncryptionKey: overrides.dataEncryptionKey ?? process.env.DATA_ENCRYPTION_KEY ?? "",
    adminEmails: String(overrides.adminEmails ?? process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    slackBotToken: overrides.slackBotToken ?? process.env.SLACK_BOT_TOKEN ?? "",
    slackAdminChannelId: overrides.slackAdminChannelId ?? process.env.SLACK_ADMIN_CHANNEL_ID ?? "",
    sessionCookieName: overrides.sessionCookieName ?? process.env.SESSION_COOKIE_NAME ?? "cq_session",
    sessionDays: integer(overrides.sessionDays ?? process.env.SESSION_DAYS, 14),
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
