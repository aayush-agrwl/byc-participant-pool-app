// ---------------------------------------------------------------------------
// HTTP plumbing: JSON, cookies, the admin session, and rate limiting.
// ---------------------------------------------------------------------------

import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

export function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

export function sendCsv(res, filename, body) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  // A leading byte order mark so that Excel opens the file as UTF-8 and does
  // not mangle names with Kannada or Devanagari characters in them.
  res.end("\uFEFF" + body);
}

export async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) throw new Error("Request body too large.");
  }
  return body ? JSON.parse(body) : {};
}

export function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const [name, ...rest] = c.split("=");
        return [name, decodeURIComponent(rest.join("="))];
      }),
  );
}

// ---------------------------------------------------------------------------
// Admin sessions
//
// Held in the instance's memory, as in the CSBC app. A cold start logs the
// Lab Manager out, which is a small cost and means there is no session store
// to secure. Tokens expire after eight hours regardless.
// ---------------------------------------------------------------------------

const SESSION_HOURS = 8;

if (!global.__adminSessions) global.__adminSessions = new Map();
const adminSessions = global.__adminSessions;

export function createAdminSession() {
  const token = randomBytes(32).toString("hex");
  adminSessions.set(token, Date.now() + SESSION_HOURS * 3600_000);
  return token;
}

export function destroyAdminSession(token) {
  if (token) adminSessions.delete(token);
}

export function isAdmin(req) {
  const token = parseCookies(req).admin_session;
  if (!token) return false;
  const expires = adminSessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

export function setAdminCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `admin_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
  );
}

export function clearAdminCookie(res) {
  res.setHeader(
    "Set-Cookie",
    "admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
  );
}

/**
 * Constant-time password comparison.
 *
 * The submitted value is hashed before comparison so that two strings of
 * different lengths can still be compared in constant time. Comparing lengths
 * first, as the CSBC app does, leaks the length of the password.
 */
export function passwordMatches(submitted, configured) {
  if (!configured) return false;
  const a = createHash("sha256").update(String(submitted ?? "")).digest();
  const b = createHash("sha256").update(String(configured)).digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Rate limiting
//
// Per warm instance, which is porous under load but enough to stop somebody
// walking the pool by trying phone numbers against the returning-participant
// lookup, or guessing the dashboard password from a script.
// ---------------------------------------------------------------------------

if (!global.__rateBuckets) global.__rateBuckets = new Map();
const buckets = global.__rateBuckets;

export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryInSeconds: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    return { allowed: false, retryInSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { allowed: true, retryInSeconds: 0 };
}

export function clientKey(req, scope) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return `${scope}:${forwarded || req.socket?.remoteAddress || "unknown"}`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  // The Neon driver hands back Date objects for timestamptz columns, and a
  // bare Date stringifies to a human-readable form that no spreadsheet sorts
  // correctly. Every date reaching this function should already be a string;
  // this is the backstop that makes a missed one visible rather than silent.
  if (value instanceof Date) return `UNFORMATTED_DATE(${value.toISOString()})`;
  const text = String(value);
  // A cell beginning with one of these is executed as a formula by Excel and
  // by Google Sheets. Participant-supplied text goes into this file.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvRows(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
