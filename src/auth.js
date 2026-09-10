import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { hash, nowIso, parseCookies, randomId, safeReturnTo } from "./utils.js";

const issuer = "https://auth.hackclub.com";
const authorizationEndpoint = `${issuer}/oauth/authorize`;
const tokenEndpoint = `${issuer}/oauth/token`;
const userinfoEndpoint = `${issuer}/oauth/userinfo`;
const jwks = createRemoteJWKSet(new URL(`${issuer}/oauth/discovery/keys`));

export const roleDefinitions = {
  reviewer: {
    label: "Reviewer",
    description: "Review projects, inspect submissions, and update project decisions.",
    permissions: ["projects.review", "reviews.read"],
  },
  second_pass_reviewer: {
    label: "Second-pass reviewer",
    description: "Double-check first-pass project and hardware-funding reviews before they become final.",
    permissions: ["projects.review", "reviews.read", "reviews.second_pass"],
  },
  shop_editor: {
    label: "Shop editor",
    description: "Add products and manage shop pricing, stock, and availability.",
    permissions: ["shop.manage"],
  },
  fulfilment_manager: {
    label: "Fulfilment manager",
    description: "Process, track, cancel, and refund participant orders.",
    permissions: ["orders.manage"],
  },
  country_editor: {
    label: "Country policy editor",
    description: "Maintain country-specific radio guidance and fulfilment policies.",
    permissions: ["countries.manage"],
  },
  support: {
    label: "Support",
    description: "Inspect Slack notification delivery and participant-facing operational issues.",
    permissions: ["notifications.read"],
  },
  auditor: {
    label: "Audit viewer",
    description: "Read the organizer audit log without changing program data.",
    permissions: ["audit.read"],
  },
  admin: {
    label: "Administrator",
    description: "Full access, including users, roles, hertz, and every organizer tool.",
    permissions: ["*"],
  },
};

export function userRoles(user = {}) {
  const candidates = Array.isArray(user.roles) ? user.roles : [user.role];
  return [...new Set(candidates.filter((role) => role === "participant" || roleDefinitions[role]))];
}

export function hasPermission(user, permission) {
  const roles = userRoles(user);
  return roles.some((role) => {
    const permissions = roleDefinitions[role]?.permissions || [];
    return permissions.includes("*") || permissions.includes(permission);
  });
}

export function isOrganizer(user) {
  return userRoles(user).some((role) => role !== "participant");
}

export function authConfigured(config) {
  return Boolean(config.hackClubClientId && config.hackClubClientSecret && config.hackClubRedirectUri);
}

export async function startOAuth(store, config, returnTo = "/app/profile", { forceReauth = false } = {}) {
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
  url.searchParams.set("scope", "openid email name profile phone birthdate address verification_status slack_id basic_info");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", oauthState.nonce);
  url.searchParams.set("code_challenge", crypto.createHash("sha256").update(codeVerifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  if (forceReauth) url.searchParams.set("prompt", "login");
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
  const existingRoles = userRoles(existing || {});
  const roles = config.adminEmails.includes(email)
    ? [...new Set(["participant", ...existingRoles, "admin"])]
    : [...new Set(["participant", ...existingRoles.filter((role) => role !== "participant")])];
  const hasClaim = (name) => Object.prototype.hasOwnProperty.call(profile, name);
  const claimedText = (name, fallback = "") => hasClaim(name) ? String(profile[name] ?? "").trim() : fallback;
  const addressClaimed = hasClaim("address");
  const address = profile.address && typeof profile.address === "object" ? profile.address : {};
  const street = String(address.street_address ?? "").split(/\r?\n/);
  const addressValue = (name, fallback = "") => addressClaimed ? String(address[name] ?? "").trim() : fallback;
  const user = {
    id: existing?.id ?? randomId("user_"),
    hackClubId: profile.sub,
    email,
    name: claimedText("name", existing?.name) || claimedText("nickname", existing?.name) || email.split("@")[0],
    firstName: claimedText("given_name", existing?.firstName || ""),
    lastName: claimedText("family_name", existing?.lastName || ""),
    phoneNumber: claimedText("phone_number", existing?.phoneNumber || ""),
    birthday: claimedText("birthdate", existing?.birthday || ""),
    addressLine1: addressClaimed ? String(street.shift() ?? "").trim() : existing?.addressLine1 || "",
    addressLine2: addressClaimed ? street.join("\n").trim() : existing?.addressLine2 || "",
    city: addressValue("locality", existing?.city || ""),
    region: addressValue("region", existing?.region || ""),
    postalCode: addressValue("postal_code", existing?.postalCode || ""),
    addressCountry: addressValue("country", existing?.addressCountry || ""),
    slackId: claimedText("slack_id", existing?.slackId || ""),
    verificationStatus: claimedText("verification_status", existing?.verificationStatus || "unknown") || "unknown",
    yswsEligible:
      typeof profile.ysws_eligible === "boolean" ? profile.ysws_eligible : existing?.yswsEligible ?? null,
    hertz: existing?.hertz ?? 0,
    roles,
    role: roles.includes("admin") ? "admin" : "participant",
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
        session && !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now()
          ? await store.get("user", session.userId)
          : null;
      req.forceReauth = Boolean(session?.revokedAt);
      req.user = user?.banned ? null : user;
      req.session = session;
      req.csrfToken = req.user ? session.csrfToken : null;
      res.locals.user = req.user;
      res.locals.userRoles = userRoles(req.user || {});
      res.locals.csrfToken = req.csrfToken;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}${req.forceReauth ? "&reauth=1" : ""}`);
}

export function requireOrganizer(req, res, next) {
  if (!req.user) return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}${req.forceReauth ? "&reauth=1" : ""}`);
  if (!isOrganizer(req.user)) {
    req.app?.locals?.logger?.info(`${req.user.id} attempted to open ${req.originalUrl} - 403 forbidden, missing permission: organizer.access`);
    return res.status(403).render("error", {
    title: "Organizer frequency only",
    message: "Your account does not have organizer access.",
    });
  }
  next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(`/auth/login?return_to=${encodeURIComponent(req.originalUrl)}${req.forceReauth ? "&reauth=1" : ""}`);
    if (!hasPermission(req.user, permission)) {
      req.app?.locals?.logger?.info(`${req.user.id} attempted to open ${req.originalUrl} - 403 forbidden, missing permission: ${permission}`);
      return res.status(403).render("error", {
      title: "Permission required",
      message: "Your organizer roles do not allow this action.",
      });
    }
    next();
  };
}

export const requireAdmin = requirePermission("users.manage");

export function requireCsrf(req, res, next) {
  const supplied = String(req.body?._csrf ?? req.get("x-csrf-token") ?? "");
  const expected = String(req.csrfToken ?? "");
  const valid =
    supplied.length > 0 &&
    expected.length === supplied.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    req.app?.locals?.logger?.info(`${req.user?.id || "anonymous"} attempted ${req.method} ${req.originalUrl} - 403 forbidden, invalid CSRF token`);
    return res.status(403).render("error", { title: "Request expired", message: "Refresh the page and try again." });
  }
  next();
}
