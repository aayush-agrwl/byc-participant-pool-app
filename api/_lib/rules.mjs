// ---------------------------------------------------------------------------
// Pool rules.
//
// Every decision about whether a person may sign up for a session is taken
// here, by pure functions over plain values, so that `scripts/check.mjs` can
// exercise them without a database. The API calls these; it does not restate
// them. If a rule is wrong it is wrong in exactly one place.
//
// Sources: Lab Operations Manual, SOP 2 (check-in and repeat participation)
// and SOP 5 (no-show, late arrival and withdrawal).
// ---------------------------------------------------------------------------

export const TIMEZONE = "Asia/Kolkata";

/** Booking states that count as having taken part in a study. */
export const PARTICIPATED = new Set(["attended", "late_admitted"]);

/** Booking states that still hold a seat in a session. */
export const HOLDS_SEAT = new Set(["booked", "attended", "late_admitted", "no_show"]);

/**
 * Booking states that count towards the interval between two studies.
 *
 * A seat that is merely booked counts, because the interval has to be enforced
 * when somebody signs up rather than after they have already sat both studies:
 * by then the second study's data is contaminated and no rule can fix it.
 * A no-show does not count, because they saw nothing. Somebody who withdrew
 * partway through does count, because they saw the design.
 */
export const COUNTS_TOWARDS_INTERVAL = new Set(["booked", "attended", "late_admitted", "withdrawn"]);

export const BOOKING_STATUSES = [
  "booked", "attended", "late_admitted", "no_show",
  "turned_away", "withdrawn", "cancelled",
];

export const PARTICIPANT_STATUSES = ["active", "suspended", "withdrawn"];

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

// The pool holds year of birth rather than a full date of birth, because year
// is all the eligibility bands need and the DPDP note asks for no more than
// the purpose requires. The consequence is that this figure can be out by one
// year for anyone whose birthday has not yet fallen this year. It is the
// figure used to filter the study list, not the figure used to admit anyone:
// SOP 2 step 3 re-screens age against photo ID at check-in, and that check is
// the authoritative one.
export function approximateAge(yearOfBirth, now = new Date()) {
  return now.getFullYear() - Number(yearOfBirth);
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

// SOP 5 asks sessions to be over-recruited by a buffer, defaulting to 20 per
// cent, and the show-up fee paid to anyone turned away. So a session sells
// more seats than the room holds, on purpose. Both numbers are reported to the
// Lab Manager; the participant only ever sees whether a seat is left.
export function bookableSeats(capacity, bufferPercent) {
  const cap = Math.max(0, Math.floor(Number(capacity) || 0));
  const pct = Math.max(0, Math.min(100, Math.floor(Number(bufferPercent) || 0)));
  return cap + Math.ceil((cap * pct) / 100);
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export function addDays(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d;
}

export function daysBetween(earlier, later) {
  return Math.floor((later.getTime() - earlier.getTime()) / 86400000);
}

/**
 * Format an instant for a reader in Bangalore.
 *
 * Vercel runs in UTC. A locale call with no timezone reads correctly on a
 * laptop here and five and a half hours out in production, which turns every
 * session time on the dashboard into a quiet lie. The timezone is pinned on
 * everything a research assistant reads as a clock.
 */
export function formatSessionTime(value) {
  // `new Date(null)` is the epoch rather than an invalid date, so an absent
  // value has to be caught before it is parsed or it renders as 1 January 1970.
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString("en-IN", {
    timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const time = d.toLocaleTimeString("en-IN", {
    timeZone: TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true,
  });
  return `${date}, ${time}`;
}

/** ISO-like stamp in IST, for CSV columns that a spreadsheet has to sort. */
export function formatStamp(value) {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// ---------------------------------------------------------------------------
// The eligibility decision
// ---------------------------------------------------------------------------

/**
 * Decide whether one participant may sign up for one study.
 *
 * Returns every reason they cannot, not the first one found, because a person
 * who is told one at a time will come back three times. `eligibleFrom` is set
 * when the block is temporary, so the page can say when rather than just no.
 *
 * @param {object} participant  { yearOfBirth, isStudent, status, suspendedUntil }
 * @param {object} study        { minAge, maxAge, requiresStudent, status, rcecReference }
 * @param {object} history      { takenThisStudy }
 * @param {object} rules        { minDaysBetweenStudies }
 * @param {Date}   now
 */
export function assessEligibility(participant, study, history, rules, now = new Date()) {
  const reasons = [];
  let eligibleFrom = null;

  const holdFrom = (date) => {
    if (date && (!eligibleFrom || date > eligibleFrom)) eligibleFrom = date;
  };

  // A study without a current ethics reference is not recruiting, whatever its
  // status column says. No participant is enrolled in any study before that
  // study holds an RCEC approval reference number.
  if (!study.rcecReference || !String(study.rcecReference).trim()) {
    reasons.push({
      code: "no_ethics_approval",
      message: "This study is not open for sign-up because it has no ethics approval reference recorded.",
    });
  }
  if (study.status !== "open") {
    reasons.push({
      code: "study_closed",
      message: "This study is not currently recruiting.",
    });
  }

  // Pool standing.
  if (participant.status === "withdrawn") {
    reasons.push({
      code: "withdrawn",
      message: "You have withdrawn from the participant pool. Write to the lab if you would like to rejoin.",
    });
  }
  if (participant.status === "suspended") {
    const until = participant.suspendedUntil ? new Date(participant.suspendedUntil) : null;
    if (until && until > now) {
      holdFrom(until);
      reasons.push({
        code: "suspended",
        message: `Your pool membership is paused until ${until.toLocaleDateString("en-IN", { timeZone: TIMEZONE, day: "numeric", month: "long", year: "numeric" })}. You can ask the Lab Manager to review this.`,
      });
    }
  }

  // SOP 2, and it is absolute: nobody takes the same study twice.
  if (history.takenThisStudy) {
    reasons.push({
      code: "already_taken",
      message: "You have already signed up for this study. Each person may take a study once.",
    });
  }

  // SOP 2's second check, the interval between two different studies, is not
  // made here. It depends on which session time is being asked for rather than
  // on the participant alone, so it is `sessionConflict` below, applied to each
  // session in turn.

  // Study criteria.
  const age = approximateAge(participant.yearOfBirth, now);
  if (age < study.minAge || age > study.maxAge) {
    reasons.push({
      code: "age",
      message: `This study is recruiting people aged ${study.minAge} to ${study.maxAge}.`,
    });
  }
  if (study.requiresStudent && !participant.isStudent) {
    reasons.push({
      code: "not_student",
      message: "This study is recruiting currently enrolled students.",
    });
  }

  return { eligible: reasons.length === 0, reasons, eligibleFrom };
}

/**
 * Is this session time too close to another study the participant is in?
 *
 * SOP 2: somebody who played a trust game last week arrives at this week's
 * public goods game already knowing the shape of it. The interval is measured
 * between the two session dates, so it catches a participant booking forwards
 * into the gap as well as one booking backwards out of it. The comparison is
 * symmetric, which is the whole point: two sessions six days apart are six days
 * apart whichever one was booked first.
 *
 * @param {Date|string} candidateAt   the session being considered
 * @param {Array<{studyId:number, at:Date|string}>} otherSessions
 *        sessions the participant holds in *other* studies
 * @param {number} minDays
 * @returns {{ conflictAt:Date, daysApart:number }|null}
 */
export function sessionConflict(candidateAt, otherSessions, minDays) {
  const wait = Number(minDays) || 0;
  if (wait <= 0) return null;
  const candidate = new Date(candidateAt);
  if (Number.isNaN(candidate.getTime())) return null;

  let worst = null;
  for (const other of otherSessions || []) {
    const at = new Date(other.at);
    if (Number.isNaN(at.getTime())) continue;
    const apart = Math.abs(daysBetween(
      at < candidate ? at : candidate,
      at < candidate ? candidate : at,
    ));
    if (apart < wait && (!worst || apart < worst.daysApart)) {
      worst = { conflictAt: at, daysApart: apart };
    }
  }
  return worst;
}

/** The sentence a participant is shown when a session time is too close. */
export function conflictMessage(conflict, minDays) {
  const when = conflict.conflictAt.toLocaleDateString("en-IN", {
    timeZone: TIMEZONE, day: "numeric", month: "long", year: "numeric",
  });
  return `Too close to your session for another study on ${when}. The pool asks for ${minDays} days between two different studies.`;
}

// ---------------------------------------------------------------------------
// No-shows
// ---------------------------------------------------------------------------

/**
 * Decide what a fresh no-show does to a participant's standing.
 *
 * SOP 5: a recorded no-show counts against the participant record, and the
 * working default is that two unexplained no-shows suspend them for the rest
 * of the term, with a route to appeal to the Lab Manager. A no-show the
 * participant explained in advance is recorded as cancelled instead and never
 * reaches this function.
 */
export function applyNoShow(noShowCount, rules, now = new Date()) {
  const count = Number(noShowCount) + 1;
  const limit = Number(rules.noShowsBeforeSuspension) || 2;
  if (count < limit) {
    return { noShowCount: count, status: "active", suspendedUntil: null, reason: "" };
  }
  return {
    noShowCount: count,
    status: "suspended",
    suspendedUntil: addDays(now, Number(rules.suspensionDays) || 120),
    reason: `${count} unexplained no-shows. Open to appeal to the Lab Manager.`,
  };
}

/**
 * Undo a no-show that was recorded and then corrected.
 *
 * A research assistant working through a roster at the door will occasionally
 * pick the wrong row. Without this, a mis-click leaves a permanent mark on
 * somebody's record that only a full reset can clear, and a second genuine
 * no-show would then suspend them one absence early.
 *
 * If the correction takes the count back below the threshold, a suspension
 * that the no-shows caused is lifted with it. A suspension the Lab Manager
 * applied by hand carries its own reason and is left alone.
 *
 * @param {object} participant { noShowCount, status, suspensionReason }
 */
export function undoNoShow(participant, rules) {
  const count = Math.max(0, Number(participant.noShowCount) - 1);
  const limit = Number(rules.noShowsBeforeSuspension) || 2;

  const suspendedByNoShows =
    participant.status === "suspended" && /no-show/i.test(participant.suspensionReason || "");

  if (suspendedByNoShows && count < limit) {
    return {
      noShowCount: count,
      status: "active",
      suspendedUntil: null,
      reason: "Suspension lifted when a recorded no-show was corrected.",
    };
  }
  return {
    noShowCount: count,
    status: participant.status,
    suspendedUntil: participant.suspendedUntil ?? null,
    reason: participant.suspensionReason ?? "",
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function normalisePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  // Accept a leading country code for India and store the ten national digits,
  // so that the same person typing +91 today and 0 tomorrow is one record.
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export function isValidPhone(value) {
  return /^[6-9][0-9]{9}$/.test(normalisePhone(value));
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || "").trim());
}

/** Participant code: BRL-P0001. Sequential, no personal data encoded in it. */
export function participantCode(sequence) {
  return `BRL-P${String(sequence).padStart(4, "0")}`;
}
