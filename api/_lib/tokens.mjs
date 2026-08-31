// ---------------------------------------------------------------------------
// Participant tokens.
//
// A participant identifies themselves once, with the email and phone number
// they registered with, and is then handed a short-lived signed token that the
// browser sends back with each following request. The token is stateless, so a
// cold start does not drop somebody halfway through booking a seat, and it is
// signed, so the browser cannot claim to be participant 42 by editing a number.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN_HOURS = 6;

function secret() {
  const value = process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD;
  if (!value) throw new Error("No SESSION_SECRET or ADMIN_PASSWORD configured.");
  return value;
}

function sign(payload) {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function issueParticipantToken(participantId) {
  const expires = Date.now() + TOKEN_HOURS * 3600_000;
  const payload = `${participantId}.${expires}`;
  return `${payload}.${sign(payload)}`;
}

/** @returns {number|null} the participant id, or null if the token is not good. */
export function readParticipantToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [id, expires, signature] = parts;
  const expected = sign(`${id}.${expires}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expires) < Date.now()) return null;
  const participantId = Number(id);
  return Number.isInteger(participantId) && participantId > 0 ? participantId : null;
}
