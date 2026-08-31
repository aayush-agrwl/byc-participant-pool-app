// ---------------------------------------------------------------------------
// Participant pool and sign-up system
// Behavioural Research Lab, Department of Economics
// CHRIST (Deemed to be University), Bangalore Yeshwanthpur Campus
//
// One serverless function serves the whole API. Static pages are served by
// Vercel out of public/ and never reach this file.
// ---------------------------------------------------------------------------

import { sendJson } from "./_lib/http.mjs";
import { getSql, ensureSchema, resetSchemaFlag } from "./_lib/store.mjs";
import { handlePublic } from "./_lib/public-routes.mjs";
import { handleAdmin } from "./_lib/admin-routes.mjs";

export default async function handler(req, res) {
  if (!process.env.DATABASE_URL) {
    return sendJson(res, 503, { error: "The database is not configured. DATABASE_URL is missing." });
  }
  if (!process.env.ADMIN_PASSWORD) {
    return sendJson(res, 503, { error: "The dashboard is not configured. ADMIN_PASSWORD is missing." });
  }

  const sql = getSql();
  try {
    await ensureSchema(sql);
  } catch (error) {
    resetSchemaFlag();
    console.error("Schema check failed:", error);
    return sendJson(res, 503, { error: "The database is not reachable at the moment. Please try again." });
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const pathname = url.pathname.replace(/\/+$/, "") || url.pathname;

  try {
    if (pathname.startsWith("/api/admin/")) {
      const handled = await handleAdmin(req, res, pathname, sql);
      if (handled !== null) return handled;
    } else {
      const handled = await handlePublic(req, res, pathname, sql);
      if (handled !== null) return handled;
    }
    return sendJson(res, 404, { error: "No such route." });
  } catch (error) {
    // The message is logged for the lab and never returned, because a database
    // error message can carry column names and fragments of participant data.
    console.error(`${req.method} ${pathname} failed:`, error);
    if (!res.headersSent) {
      return sendJson(res, 500, { error: "Something went wrong. Please try again, and tell the lab if it keeps happening." });
    }
  }
}
