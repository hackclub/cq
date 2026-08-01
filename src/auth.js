import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { hash, nowIso, parseCookies, randomId, safeReturnTo } from "./utils.js";

const issuer = "https://auth.hackclub.com";
const authorizationEndpoint = `${issuer}/oauth/authorize`;
const tokenEndpoint = `${issuer}/oauth/token`;
const userinfoEndpoint = `${issuer}/oauth/userinfo`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/oauth/discovery/keys`));

export function authConfigured(config) {
  return Boolean(config.hackClubClientId && config.hackClubClientSecret && config.hackClubRedirectUri);
}

export async function startOAuth(store, config, returnTo = "/app") {
  const state = randomId("state_");
  const codeVerifier = crypto.randomBytes(48).toString("base64url");
  const oauthState = {
    id: hash(state),
    codeVerifier,
    nonce: randomId("nonce_"),
    returnTo: safeReturnTo(returnTo),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    createdAt: nowIso(),
  };
  await store.put("oauth", oauthState.id, oauthState);
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", config.hackClubClientId);
  url.searchParams.set("redirect_uri", config.hackClubRedirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email slack_id verification_status");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", oauthState.nonce);
  url.searchParams.set("code_challenge", crypto.createHash("sha256").update(codeVerifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function consumeOAuthState(store, state) {
  const id = hash(String(state ?? ""));
  const row = await store.get("oauth", id);
  await store.delete("oauth", id);
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row;
}

async function jsonResponse(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
}

export async function exchangeHackClubCode(config, code, oauthState, fetchImpl = fetch) {
  const tokenResponse = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: config.hackClubClientId,
      client_secret: config.hackClubClientSecret,
      redirect_uri: config.hackClubRedirectUri,
      code,
      code_verifier: oauthState.codeVerifier,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await jsonResponse(tokenResponse);
  if (!tokenResponse.ok || !tokens.access_token || !tokens.id_token) {
    throw new Error(tokens.message || tokens.error_description || "Hack Club Auth rejected the token exchange.");
  }
  const { payload: claims } = await jwtVerify(tokens.id_token, jwks, {
    issuer,
    audience: config.hackClubClientId,
  });
  if (claims.nonce !== oauthState.nonce) throw new Error("Hack Club Auth returned an invalid nonce.");
  const userinfoResponse = await fetchImpl(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
  });
  const userinfo = await jsonResponse(userinfoResponse);
  if (!userinfoResponse.ok) throw new Error(userinfo.message || "Could not load your Hack Club profile.");
  const profile = { ...claims, ...userinfo };
  if (!profile.sub || !profile.email) throw new Error("Hack Club Auth did not return a user ID and email.");
  return profile;
}

export async function upsertUser(store, config, profile) {
  const users = await store.list("user");
  const email = String(profile.email).toLowerCase();
  const existing = users.find((user) => user.hackClubId === profile.sub || user.email === email);
  const timestamp = nowIso();
  const user = {
    id: existing?.id ?? randomId("user_"),
    hackClubId: profile.sub,
    email,
    name: String(profile.name || profile.nickname || "").trim() || email.split("@")[0],
    slackId: String(profile.slack_id || existing?.slackId || ""),
    verificationStatus: String(profile.verification_status || existing?.verificationStatus || "unknown"),
    yswsEligible:
      typeof profile.ysws_eligible === "boolean" ? profile.ysws_eligible : existing?.yswsEligible ?? null,
    hertz: existing?.hertz ?? 0,
    role: config.adminEmails.includes(email) ? "admin" : existing?.role ?? "participant",
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await store.put("user", user.id, user);
  return user;
}

export async function createSession(store, config, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const session = {
    id: hash(token),
    userId,
    csrfToken: crypto.randomBytes(24).toString("base64url"),
    expiresAt: new Date(Date.now() + config.sessionDays * 86_400_000).toISOString(),
    createdAt: nowIso(),
  };
  await store.put("session", session.id, session);
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    maxAge: config.sessionDays * 86_400_000,
    path: "/",
  });
}

export async function destroySession(store, config, req, res) {
  const token = parseCookies(req.headers.cookie)[config.sessionCookieName];
  if (token) await store.delete("session", hash(token));
  res.clearCookie(config.sessionCookieName, { path: "/" });
}

export function sessionMiddleware(store, config) {
  return async (req, res, next) => {
    try {
      const token = parseCookies(req.headers.cookie)[config.sessionCookieName];
      const session = token ? await store.get("session", hash(token)) : null;
      const user =
        session && new Date(session.expiresAt).getTime() > Date.now()
          ? await store.get("user", session.userId)
          : null;
      req.user = user;
      req.csrfToken = user ? session.csrfToken : null;
      res.locals.user = user;
      res.locals.csrfToken = req.csrfToken;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.role !== "admin") return res.status(403).render("error", {
    title: "Admin frequency only",
    message: "Your account does not have organizer access.",
  });
  next();
}

export function requireCsrf(req, res, next) {
  const supplied = String(req.body?._csrf ?? req.get("x-csrf-token") ?? "");
  const expected = String(req.csrfToken ?? "");
  const valid =
    supplied.length > 0 &&
    expected.length === supplied.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(403).render("error", { title: "Request expired", message: "Refresh the page and try again." });
  next();
}
