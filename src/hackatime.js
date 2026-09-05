import { hash, nowIso, randomId, safeReturnTo } from "./utils.js";

const baseUrl = "https://hackatime.hackclub.com";
const authorizationEndpoint = `${baseUrl}/oauth/authorize`;
const tokenEndpoint = `${baseUrl}/oauth/token`;
const revokeEndpoint = `${baseUrl}/oauth/revoke`;
const meEndpoint = `${baseUrl}/api/v1/authenticated/me`;
const projectsEndpoint = `${baseUrl}/api/v1/authenticated/projects`;
const cacheLifetimeMs = 5 * 60_000;

export function hackatimeConfigured(config) {
  return Boolean(config.hackatimeClientId && config.hackatimeClientSecret && config.hackatimeRedirectUri);
}

async function responseBody(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { message: text }; }
}

function errorMessage(body, fallback) {
  return String(body.error_description || body.message || body.error || fallback);
}

function normalizeProjects(body) {
  return (Array.isArray(body.projects) ? body.projects : [])
    .filter((project) => project && typeof project.name === "string" && project.name.trim())
    .map((project) => ({
      name: project.name.trim().slice(0, 200),
      totalSeconds: Math.max(0, Number(project.total_seconds) || 0),
      hours: Math.round((Math.max(0, Number(project.total_seconds) || 0) / 3600) * 10) / 10,
      mostRecentHeartbeat: project.most_recent_heartbeat || null,
      languages: Array.isArray(project.languages) ? project.languages.map(String).slice(0, 10) : [],
      archived: Boolean(project.archived),
    }))
    .filter((project) => !project.archived)
    .sort((a, b) => {
      const recency = String(b.mostRecentHeartbeat || "").localeCompare(String(a.mostRecentHeartbeat || ""));
      return recency || b.totalSeconds - a.totalSeconds || a.name.localeCompare(b.name);
    });
}

export function createHackatimeClient(config, store, fetchImpl = fetch) {
  async function authenticatedGet(endpoint, accessToken) {
    const response = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await responseBody(response);
    if (!response.ok) {
      const error = new Error(errorMessage(body, `Hackatime returned ${response.status}.`));
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function connection(userId) {
    const token = await store.get("hackatime_token", userId);
    return {
      configured: hackatimeConfigured(config),
      connected: Boolean(token?.accessToken),
      connectedAt: token?.connectedAt ?? null,
      account: token?.account ?? null,
    };
  }

  async function startConnection(userId, returnTo = "/app/profile") {
    if (!hackatimeConfigured(config)) throw new Error("Hackatime OAuth is not configured.");
    const state = randomId("ht_state_");
    const record = {
      id: hash(state),
      userId,
      returnTo: safeReturnTo(returnTo, "/app/profile"),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      createdAt: nowIso(),
    };
    await store.put("hackatime_oauth", record.id, record);
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("client_id", config.hackatimeClientId);
    url.searchParams.set("redirect_uri", config.hackatimeRedirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "profile read");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async function finishConnection({ userId, state, code }) {
    const id = hash(String(state || ""));
    const oauthState = await store.get("hackatime_oauth", id);
    await store.delete("hackatime_oauth", id);
    if (!oauthState || oauthState.userId !== userId || new Date(oauthState.expiresAt).getTime() < Date.now()) {
      throw new Error("This Hackatime connection request has expired.");
    }
    if (!code) throw new Error("Hackatime did not return an authorization code.");

    const response = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: config.hackatimeClientId,
        client_secret: config.hackatimeClientSecret,
        code: String(code),
        redirect_uri: config.hackatimeRedirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokens = await responseBody(response);
    if (!response.ok || !tokens.access_token) {
      throw new Error(errorMessage(tokens, "Hackatime rejected the connection request."));
    }

    const profile = await authenticatedGet(meEndpoint, tokens.access_token);
    const timestamp = nowIso();
    const account = {
      id: profile.id ?? profile.user?.id ?? null,
      username: profile.username ?? profile.user?.username ?? profile.github_username ?? null,
      slackId: profile.slack_id ?? profile.user?.slack_id ?? null,
      trustLevel: String(profile.trust_factor?.trust_level ?? profile.user?.trust_factor?.trust_level ?? "blue").toLowerCase(),
    };
    await store.put("hackatime_token", userId, {
      id: userId,
      userId,
      accessToken: tokens.access_token,
      tokenType: tokens.token_type || "Bearer",
      scope: tokens.scope || "profile read",
      account,
      connectedAt: timestamp,
      updatedAt: timestamp,
    });
    await store.delete("hackatime_cache", userId);
    return { returnTo: oauthState.returnTo, account };
  }

  async function trustFactor(userId) {
    const token = await store.get("hackatime_token", userId);
    if (!token?.accessToken) return null;
    try {
      const profile = await authenticatedGet(meEndpoint, token.accessToken);
      return String(profile.trust_factor?.trust_level ?? profile.user?.trust_factor?.trust_level ?? "blue").toLowerCase();
    } catch (error) {
      if (error.status === 401) await disconnect(userId);
      return null;
    }
  }

  async function projects(userId, { force = false } = {}) {
    const status = await connection(userId);
    if (!status.configured || !status.connected) return { ...status, projects: [], fetchedAt: null };

    const cached = await store.get("hackatime_cache", userId);
    const cacheFresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < cacheLifetimeMs;
    if (!force && cacheFresh) return { ...status, projects: cached.projects, fetchedAt: cached.fetchedAt };

    const token = await store.get("hackatime_token", userId);
    try {
      const url = new URL(projectsEndpoint);
      url.searchParams.set("include_archived", "false");
      const body = await authenticatedGet(url, token.accessToken);
      const normalized = normalizeProjects(body);
      const record = { id: userId, userId, projects: normalized, fetchedAt: nowIso() };
      await store.put("hackatime_cache", userId, record);
      return { ...status, projects: normalized, fetchedAt: record.fetchedAt };
    } catch (error) {
      if (error.status === 401) {
        await store.delete("hackatime_token", userId);
        await store.delete("hackatime_cache", userId);
        return { ...status, connected: false, projects: [], fetchedAt: null, error: "reconnect" };
      }
      if (cached) return { ...status, projects: cached.projects, fetchedAt: cached.fetchedAt, error: "stale" };
      return { ...status, projects: [], fetchedAt: null, error: "unavailable" };
    }
  }

  async function disconnect(userId) {
    const token = await store.get("hackatime_token", userId);
    if (token?.accessToken && hackatimeConfigured(config)) {
      try {
        await fetchImpl(revokeEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            token: token.accessToken,
            client_id: config.hackatimeClientId,
            client_secret: config.hackatimeClientSecret,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // Local removal still prevents CQ from using a token if Hackatime is unavailable.
      }
    }
    await store.delete("hackatime_token", userId);
    await store.delete("hackatime_cache", userId);
  }

  return {
    configured: () => hackatimeConfigured(config),
    connection,
    startConnection,
    finishConnection,
    projects,
    disconnect,
    trustFactor,
  };
}
