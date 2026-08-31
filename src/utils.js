import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = "") {
  return `${prefix}${crypto.randomBytes(12).toString("hex")}`;
}

export function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

export function safeReturnTo(value, fallback = "/app") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;
  return value;
}

export function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function splitList(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

export function publicUrl(config, pathname) {
  return new URL(pathname, `${config.baseUrl}/`).toString();
}

export function setFlash(res, type, message) {
  const value = Buffer.from(JSON.stringify({ type, message }), "utf8").toString("base64url");
  res.cookie("cq_flash", value, {
    httpOnly: true,
    sameSite: "lax",
    secure: res.app.locals.config.isProduction,
    maxAge: 60_000,
    path: "/",
  });
}

export function readFlash(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies.cq_flash;
  if (!raw) return null;
  res.clearCookie("cq_flash", { path: "/" });
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function statusLabel(status) {
  return String(status ?? "draft")
    .replace(/[._]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
