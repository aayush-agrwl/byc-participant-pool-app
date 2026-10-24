// ---------------------------------------------------------------------------
// One-time sign-in codes.
//
// Only a keyed hash of each code is stored, never the code itself, so a copy
// of the database cannot be used to sign in.
// ---------------------------------------------------------------------------

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

export const CODE_MINUTES = 10;
export const MAX_ATTEMPTS = 5;

function secret() {
  const value = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!value) throw new Error("No SESSION_SECRET or ADMIN_PASSWORD configured.");
  return value;
}

export function newCode() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

export function hashCode(email, code) {
  return createHmac("sha256", secret())
    .update(`${email.toLowerCase()}:${code}`)
    .digest("hex");
}

export function codeMatches(email, code, storedHash) {
  const a = Buffer.from(hashCode(email, code));
  const b = Buffer.from(String(storedHash));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Test mode shows the code on the screen instead of emailing it. It is refused
 * on Vercel production, whatever the environment file says.
 */
export function testModeOn() {
  return process.env.OTP_TEST_MODE === "true" && process.env.VERCEL_ENV !== "production";
}