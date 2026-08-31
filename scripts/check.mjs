// ---------------------------------------------------------------------------
// Checks on the rules that decide who may sign up for what.
//
// These run without a database and without a network. Run them after touching
// anything in api/_lib/: the pool rules are the part of this system that is
// wrong silently, because a page that wrongly lets somebody book looks exactly
// like a page that correctly lets somebody book.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import {
  approximateAge, bookableSeats, assessEligibility, applyNoShow, undoNoShow,
  sessionConflict, conflictMessage,
  normalisePhone, isValidPhone, isValidEmail, participantCode,
  formatStamp, formatSessionTime, addDays, daysBetween,
} from "../api/_lib/rules.mjs";
import { csvCell, csvRows, passwordMatches } from "../api/_lib/http.mjs";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "check-secret";
const { issueParticipantToken, readParticipantToken } = await import("../api/_lib/tokens.mjs");

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const NOW = new Date("2026-09-15T10:00:00+05:30");

const ADULT = {
  yearOfBirth: 2004, isStudent: true, status: "active", suspendedUntil: null, noShowCount: 0,
};
const STUDY = {
  status: "open", rcecReference: "RCEC/2026/041", minAge: 18, maxAge: 30, requiresStudent: true,
};
const CLEAN = { takenThisStudy: false };
const RULES = { minDaysBetweenStudies: 30, noShowsBeforeSuspension: 2, suspensionDays: 120 };

const codes = (result) => result.reasons.map((r) => r.code).sort();

// -- Seats ------------------------------------------------------------------

check("no buffer sells exactly the room", () => assert.equal(bookableSeats(8, 0), 8));
check("a 20 per cent buffer on 8 seats sells 10", () => assert.equal(bookableSeats(8, 20), 10));
check("the buffer rounds up, never down", () => assert.equal(bookableSeats(5, 20), 6));
check("a full buffer doubles the room", () => assert.equal(bookableSeats(10, 100), 20));
check("an empty room sells nothing", () => assert.equal(bookableSeats(0, 20), 0));
check("a negative capacity cannot sell seats", () => assert.equal(bookableSeats(-4, 20), 0));
check("a buffer above 100 is clamped", () => assert.equal(bookableSeats(10, 500), 20));

// -- Age --------------------------------------------------------------------

check("age is the year difference", () => assert.equal(approximateAge(2004, NOW), 22));

// -- Eligibility, the clean case --------------------------------------------

check("an active adult student on an open study is eligible", () => {
  const result = assessEligibility(ADULT, STUDY, CLEAN, RULES, NOW);
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.eligibleFrom, null);
});

// -- Eligibility, the ethics gate -------------------------------------------

check("a study with no ethics reference recruits nobody", () => {
  const result = assessEligibility(ADULT, { ...STUDY, rcecReference: "" }, CLEAN, RULES, NOW);
  assert.equal(result.eligible, false);
  assert.ok(codes(result).includes("no_ethics_approval"));
});

check("whitespace is not an ethics reference", () => {
  const result = assessEligibility(ADULT, { ...STUDY, rcecReference: "   " }, CLEAN, RULES, NOW);
  assert.ok(codes(result).includes("no_ethics_approval"));
});

check("a draft study recruits nobody", () => {
  const result = assessEligibility(ADULT, { ...STUDY, status: "draft" }, CLEAN, RULES, NOW);
  assert.ok(codes(result).includes("study_closed"));
});

// -- Eligibility, the repeat rules ------------------------------------------

check("nobody takes the same study twice", () => {
  const result = assessEligibility(ADULT, STUDY, { ...CLEAN, takenThisStudy: true }, RULES, NOW);
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["already_taken"]);
  // This block is permanent, so there is no date at which it lifts.
  assert.equal(result.eligibleFrom, null);
});

// -- The interval between two different studies -----------------------------
// This is decided per session time rather than per participant, so that a
// participant booking forwards into the gap is caught as well as one booking
// backwards out of it.

const other = (at) => [{ studyId: 99, at: new Date(at) }];

check("a session inside the interval of a past study conflicts", () => {
  const result = sessionConflict(NOW, other("2026-09-01T10:00:00+05:30"), 30);
  assert.ok(result);
  assert.equal(result.daysApart, 14);
});

check("a session outside the interval does not conflict", () => {
  assert.equal(sessionConflict(NOW, other("2026-08-01T10:00:00+05:30"), 30), null);
});

check("exactly the interval apart is allowed", () => {
  assert.equal(sessionConflict(NOW, other(addDays(NOW, -30)), 30), null);
});

check("one day short of the interval conflicts", () => {
  assert.ok(sessionConflict(NOW, other(addDays(NOW, -29)), 30));
});

check("booking forwards into the gap is caught too", () => {
  // The other study is next week; this session is the week after. Measuring
  // from today rather than between the two sessions would let this through.
  const otherSession = addDays(NOW, 7);
  const candidate = addDays(NOW, 12);
  const result = sessionConflict(candidate, other(otherSession), 30);
  assert.ok(result);
  assert.equal(result.daysApart, 5);
});

check("the conflict is symmetric", () => {
  const a = new Date("2026-09-10T10:00:00+05:30");
  const b = new Date("2026-09-20T10:00:00+05:30");
  const forwards  = sessionConflict(a, [{ studyId: 99, at: b }], 30);
  const backwards = sessionConflict(b, [{ studyId: 99, at: a }], 30);
  assert.equal(forwards.daysApart, backwards.daysApart);
});

check("the nearest conflicting session is the one reported", () => {
  const result = sessionConflict(NOW, [
    { studyId: 9, at: addDays(NOW, -25) },
    { studyId: 8, at: addDays(NOW, -3) },
  ], 30);
  assert.equal(result.daysApart, 3);
});

check("an interval of zero days never conflicts", () => {
  assert.equal(sessionConflict(NOW, other(NOW), 0), null);
});

check("no other sessions means no conflict", () => {
  assert.equal(sessionConflict(NOW, [], 30), null);
  assert.equal(sessionConflict(NOW, undefined, 30), null);
});

check("an unreadable session time is skipped rather than throwing", () => {
  assert.equal(sessionConflict(NOW, [{ studyId: 9, at: "rubbish" }], 30), null);
  assert.equal(sessionConflict("rubbish", other(NOW), 30), null);
});

check("the conflict message says when and how long the gap has to be", () => {
  const conflict = sessionConflict(NOW, other("2026-09-01T10:00:00+05:30"), 30);
  const message = conflictMessage(conflict, 30);
  assert.match(message, /1 September 2026/);
  assert.match(message, /30 days/);
});

// -- Eligibility, pool standing ---------------------------------------------

check("a live suspension blocks, and reports when it lifts", () => {
  const until = new Date("2026-11-01T00:00:00+05:30");
  const result = assessEligibility(
    { ...ADULT, status: "suspended", suspendedUntil: until }, STUDY, CLEAN, RULES, NOW,
  );
  assert.equal(result.eligible, false);
  assert.deepEqual(codes(result), ["suspended"]);
  assert.equal(result.eligibleFrom.toISOString(), until.toISOString());
});

check("a suspension that has run out does not block", () => {
  const result = assessEligibility(
    { ...ADULT, status: "suspended", suspendedUntil: new Date("2026-08-01T00:00:00+05:30") },
    STUDY, CLEAN, RULES, NOW,
  );
  assert.equal(result.eligible, true);
});

check("a withdrawn participant cannot book", () => {
  const result = assessEligibility({ ...ADULT, status: "withdrawn" }, STUDY, CLEAN, RULES, NOW);
  assert.deepEqual(codes(result), ["withdrawn"]);
});

// -- Eligibility, study criteria --------------------------------------------

check("somebody below the age band is blocked", () => {
  const result = assessEligibility({ ...ADULT, yearOfBirth: 2010 }, STUDY, CLEAN, RULES, NOW);
  assert.deepEqual(codes(result), ["age"]);
});

check("somebody above the age band is blocked", () => {
  const result = assessEligibility({ ...ADULT, yearOfBirth: 1980 }, STUDY, CLEAN, RULES, NOW);
  assert.deepEqual(codes(result), ["age"]);
});

check("the age band is inclusive at both ends", () => {
  assert.equal(assessEligibility({ ...ADULT, yearOfBirth: 2008 }, STUDY, CLEAN, RULES, NOW).eligible, true);
  assert.equal(assessEligibility({ ...ADULT, yearOfBirth: 1996 }, STUDY, CLEAN, RULES, NOW).eligible, true);
});

check("a students-only study blocks a non-student", () => {
  const result = assessEligibility({ ...ADULT, isStudent: false }, STUDY, CLEAN, RULES, NOW);
  assert.deepEqual(codes(result), ["not_student"]);
});

check("a study open to non-students admits one", () => {
  const result = assessEligibility(
    { ...ADULT, isStudent: false }, { ...STUDY, requiresStudent: false }, CLEAN, RULES, NOW,
  );
  assert.equal(result.eligible, true);
});

// -- Eligibility reports every reason, not the first ------------------------

check("every reason is reported at once", () => {
  const result = assessEligibility(
    { ...ADULT, yearOfBirth: 1980, isStudent: false, status: "withdrawn" },
    { ...STUDY, status: "closed", rcecReference: "" },
    { takenThisStudy: true },
    RULES, NOW,
  );
  assert.deepEqual(codes(result), [
    "age", "already_taken", "no_ethics_approval", "not_student",
    "study_closed", "withdrawn",
  ]);
});

check("a suspension sets the date the block lifts", () => {
  const until = new Date("2026-12-01T00:00:00+05:30");
  const result = assessEligibility(
    { ...ADULT, status: "suspended", suspendedUntil: until }, STUDY, CLEAN, RULES, NOW,
  );
  assert.equal(result.eligibleFrom.toISOString(), until.toISOString());
});

// -- No-shows ---------------------------------------------------------------

check("a first no-show is counted and does not suspend", () => {
  const result = applyNoShow(0, RULES, NOW);
  assert.equal(result.noShowCount, 1);
  assert.equal(result.status, "active");
  assert.equal(result.suspendedUntil, null);
});

check("the second no-show suspends for the configured length", () => {
  const result = applyNoShow(1, RULES, NOW);
  assert.equal(result.noShowCount, 2);
  assert.equal(result.status, "suspended");
  assert.equal(daysBetween(NOW, result.suspendedUntil), 120);
  assert.match(result.reason, /appeal/i);
});

check("a stricter rule suspends on the first no-show", () => {
  const result = applyNoShow(0, { ...RULES, noShowsBeforeSuspension: 1 }, NOW);
  assert.equal(result.status, "suspended");
});

check("a suspended participant staying suspended is still counted", () => {
  const result = applyNoShow(5, RULES, NOW);
  assert.equal(result.noShowCount, 6);
  assert.equal(result.status, "suspended");
});

check("correcting a mis-clicked no-show takes the mark off", () => {
  const result = undoNoShow({ noShowCount: 1, status: "active", suspensionReason: "" }, RULES);
  assert.equal(result.noShowCount, 0);
  assert.equal(result.status, "active");
});

check("a correction that drops below the threshold lifts the suspension", () => {
  const result = undoNoShow({
    noShowCount: 2, status: "suspended",
    suspensionReason: "2 unexplained no-shows. Open to appeal to the Lab Manager.",
    suspendedUntil: new Date("2026-12-01T00:00:00+05:30"),
  }, RULES);
  assert.equal(result.noShowCount, 1);
  assert.equal(result.status, "active");
  assert.equal(result.suspendedUntil, null);
});

check("a correction that stays at the threshold keeps the suspension", () => {
  const until = new Date("2026-12-01T00:00:00+05:30");
  const result = undoNoShow({
    noShowCount: 3, status: "suspended",
    suspensionReason: "3 unexplained no-shows. Open to appeal to the Lab Manager.",
    suspendedUntil: until,
  }, RULES);
  assert.equal(result.noShowCount, 2);
  assert.equal(result.status, "suspended");
  assert.equal(result.suspendedUntil, until);
});

check("a suspension the Lab Manager applied by hand is not lifted by a correction", () => {
  const until = new Date("2026-12-01T00:00:00+05:30");
  const result = undoNoShow({
    noShowCount: 1, status: "suspended",
    suspensionReason: "Abusive to staff at the front desk.",
    suspendedUntil: until,
  }, RULES);
  assert.equal(result.status, "suspended");
  assert.equal(result.suspendedUntil, until);
  assert.equal(result.reason, "Abusive to staff at the front desk.");
});

check("the count cannot be driven below zero", () => {
  assert.equal(undoNoShow({ noShowCount: 0, status: "active", suspensionReason: "" }, RULES).noShowCount, 0);
});

check("recording then correcting a no-show returns to where it started", () => {
  const start = { noShowCount: 1, status: "active", suspensionReason: "", suspendedUntil: null };
  const after = applyNoShow(start.noShowCount, RULES, NOW);
  const back  = undoNoShow({ ...after, suspensionReason: after.reason }, RULES);
  assert.equal(back.noShowCount, start.noShowCount);
  assert.equal(back.status, start.status);
  assert.equal(back.suspendedUntil, null);
});

// -- Contact details --------------------------------------------------------

check("a plain ten-digit mobile is accepted", () => assert.equal(isValidPhone("9876543210"), true));
check("the country code is stripped", () => assert.equal(normalisePhone("+91 98765 43210"), "9876543210"));
check("a leading zero is stripped", () => assert.equal(normalisePhone("09876543210"), "9876543210"));
check("spaces and dashes are stripped", () => assert.equal(normalisePhone("98765-43210"), "9876543210"));
check("the same person typed three ways is one number", () => {
  const forms = ["+919876543210", "09876543210", "98765 43210"];
  assert.equal(new Set(forms.map(normalisePhone)).size, 1);
});
check("a landline-style number is rejected", () => assert.equal(isValidPhone("0801234567"), false));
check("a nine-digit number is rejected", () => assert.equal(isValidPhone("987654321"), false));
check("an Indian mobile cannot start below 6", () => assert.equal(isValidPhone("5876543210"), false));
check("an email needs a dot in the domain", () => assert.equal(isValidEmail("a@b"), false));
check("an ordinary email is accepted", () => assert.equal(isValidEmail("a.b@christuniversity.in"), true));

// -- Participant codes ------------------------------------------------------

check("codes are padded and sequential", () => {
  assert.equal(participantCode(1), "BRL-P0001");
  assert.equal(participantCode(412), "BRL-P0412");
  assert.equal(participantCode(10000), "BRL-P10000");
});

// -- Time -------------------------------------------------------------------

check("session times are rendered in India Standard Time, not UTC", () => {
  // 03:30 UTC is 09:00 in Bangalore. A server that forgets the timezone shows
  // 3:30 am here and sends everybody to the lab at the wrong hour.
  const label = formatSessionTime("2026-09-15T03:30:00.000Z");
  assert.match(label, /9:00\s*am/i);
  assert.match(label, /Tuesday/);
  assert.match(label, /15 September 2026/);
});

check("the CSV stamp is sortable and in IST", () => {
  assert.equal(formatStamp("2026-09-15T03:30:00.000Z"), "2026-09-15 09:00:00");
});

check("an instant just before IST midnight keeps the right date", () => {
  assert.equal(formatStamp("2026-09-15T18:29:00.000Z"), "2026-09-15 23:59:00");
  assert.equal(formatStamp("2026-09-15T18:31:00.000Z"), "2026-09-16 00:01:00");
});

check("an unreadable date formats to nothing rather than to Invalid Date", () => {
  assert.equal(formatStamp("not a date"), "");
  assert.equal(formatSessionTime(null), "");
  assert.equal(formatSessionTime(undefined), "");
  assert.equal(formatStamp(null), "");
  assert.equal(formatStamp(""), "");
});

// -- CSV --------------------------------------------------------------------

check("a comma is quoted", () => assert.equal(csvCell("Rao, Meera"), '"Rao, Meera"'));
check("a quote is doubled", () => assert.equal(csvCell('She said "no"'), '"She said ""no"""'));
check("a newline is quoted", () => assert.equal(csvCell("a\nb"), '"a\nb"'));
check("a formula is defused", () => assert.equal(csvCell("=1+1"), "'=1+1"));
check("a leading minus is defused", () => assert.equal(csvCell("-2+3"), "'-2+3"));
check("a leading at sign is defused", () => assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)"));
check("an ordinary cell is left alone", () => assert.equal(csvCell("Bengaluru"), "Bengaluru"));
check("empty values become empty cells", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});
check("a raw Date is flagged rather than written as prose", () => {
  // The Neon driver returns Date objects for timestamptz. One reaching the CSV
  // unformatted is a bug, and this makes it loud in the file instead of quiet.
  assert.match(csvCell(new Date("2026-09-15T03:30:00Z")), /^UNFORMATTED_DATE/);
});
check("rows join with CRLF", () => assert.equal(csvRows([["a", "b"], ["c", "d"]]), "a,b\r\nc,d"));

// -- Passwords and tokens ---------------------------------------------------

check("the right password matches", () => assert.equal(passwordMatches("hunter2", "hunter2"), true));
check("a wrong password of the same length does not", () => assert.equal(passwordMatches("hunter3", "hunter2"), false));
check("a wrong password of a different length does not throw", () => {
  assert.equal(passwordMatches("x", "hunter2"), false);
});
check("no configured password means nobody gets in", () => {
  assert.equal(passwordMatches("", ""), false);
  assert.equal(passwordMatches("anything", undefined), false);
});

check("a token round-trips to its participant", () => {
  assert.equal(readParticipantToken(issueParticipantToken(42)), 42);
});
check("a token with the id swapped is rejected", () => {
  const [, expires, signature] = issueParticipantToken(42).split(".");
  assert.equal(readParticipantToken(`43.${expires}.${signature}`), null);
});
check("a token with the expiry pushed out is rejected", () => {
  const [id, , signature] = issueParticipantToken(42).split(".");
  assert.equal(readParticipantToken(`${id}.${Date.now() + 9e9}.${signature}`), null);
});
check("rubbish is rejected", () => {
  assert.equal(readParticipantToken("nonsense"), null);
  assert.equal(readParticipantToken(""), null);
  assert.equal(readParticipantToken(null), null);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} checks passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
