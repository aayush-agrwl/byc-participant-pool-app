// ---------------------------------------------------------------------------
// The participant-facing half of the API.
// ---------------------------------------------------------------------------

import {
  sendJson, readJson, rateLimit, clientKey,
} from "./http.mjs";
import { issueParticipantToken, readParticipantToken } from "./tokens.mjs";
import {
  assessEligibility, sessionConflict, conflictMessage, bookableSeats,
  isValidEmail, isValidPhone, normalisePhone, formatSessionTime,
} from "./rules.mjs";
import * as store from "./store.mjs";

const CURRENT_YEAR = () => new Date().getFullYear();

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

function publicParticipant(p) {
  return {
    code:            p.code,
    name:            p.name,
    email:           p.email,
    phone:           p.phone,
    status:          p.status,
    suspendedUntil:  p.suspendedUntil,
    noShowCount:     p.noShowCount,
    memberSince:     p.createdAt,
  };
}

/**
 * The study list a participant sees.
 *
 * Every open study is returned, including the ones they cannot take, with the
 * reasons attached. Hiding an ineligible study leaves somebody refreshing a
 * page that will never show them anything and no way to find out why.
 */
async function studiesForParticipant(sql, participant, rules, now = new Date()) {
  const studies = await store.listStudies(sql);
  const open = studies.filter((s) => s.status === "open" && s.rcecReference.trim());
  if (open.length === 0) return [];

  const history = participant
    ? await store.getHistory(sql, participant.id)
    : { studiesTaken: new Set(), intervalSessions: [] };

  const result = [];
  for (const study of open) {
    const sessions = (await store.listSessions(sql, study.id, study.bufferPercent))
      .filter((s) => s.status === "open" && new Date(s.startsAt) > now);

    const assessment = participant
      ? assessEligibility(
          participant, study,
          { takenThisStudy: history.studiesTaken.has(study.id) },
          rules, now,
        )
      : { eligible: false, reasons: [{ code: "not_registered", message: "Register to check whether you can take part." }], eligibleFrom: null };

    // The interval between two different studies is a property of the session
    // time, so it is decided here, session by session, and reported on the
    // session rather than on the study. A participant with one seat already
    // booked can still take this study, just not in the week around it.
    const otherSessions = history.intervalSessions.filter((x) => x.studyId !== study.id);
    const annotated = sessions.map((session) => {
      const conflict = sessionConflict(session.startsAt, otherSessions, rules.minDaysBetweenStudies);
      return { session, conflict };
    });
    if (assessment.eligible && annotated.length > 0 && annotated.every((a) => a.conflict)) {
      assessment.eligible = false;
      assessment.reasons.push({
        code: "too_soon",
        message: `Every session time for this study falls within ${rules.minDaysBetweenStudies} days of a session you already hold for another study. The pool asks for a gap between two different studies.`,
      });
    }

    result.push({
      id:              study.id,
      code:            study.code,
      title:           study.title,
      summary:         study.summary,
      piName:          study.piName,
      rcecReference:   study.rcecReference,
      incentive:       study.incentive,
      durationMinutes: study.durationMinutes,
      venue:           study.venue,
      minAge:          study.minAge,
      maxAge:          study.maxAge,
      requiresStudent: study.requiresStudent,
      declarations:    study.declarations,
      eligible:        assessment.eligible,
      reasons:         assessment.reasons,
      eligibleFrom:    assessment.eligibleFrom,
      sessions: annotated.map(({ session, conflict }) => ({
        id:        session.id,
        startsAt:  session.startsAt,
        label:     formatSessionTime(session.startsAt),
        location:  session.location || study.venue,
        remaining: session.remaining,
        full:      session.remaining <= 0,
        blocked:   Boolean(conflict),
        blockedReason: conflict ? conflictMessage(conflict, rules.minDaysBetweenStudies) : "",
      })),
    });
  }
  return result;
}

async function portalPayload(sql, participant, rules) {
  return {
    participant: publicParticipant(participant),
    token:       issueParticipantToken(participant.id),
    studies:     await studiesForParticipant(sql, participant, rules),
    bookings:    (await store.getBookingsForParticipant(sql, participant.id)).map((b) => ({
      ...b,
      label: formatSessionTime(b.startsAt),
    })),
  };
}

async function authenticate(sql, body) {
  const id = readParticipantToken(body.token);
  if (!id) return null;
  const participant = await store.getParticipant(sql, id);
  if (!participant || participant.erasedAt) return null;
  return participant;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handlePublic(req, res, pathname, sql) {
  const rules = await store.getRules(sql);

  // -- What the landing page needs before anybody has identified themselves --
  if (req.method === "GET" && pathname === "/api/config") {
    return sendJson(res, 200, {
      poolOpen:              rules.poolOpen,
      consentVersion:        rules.consentVersion,
      minDaysBetweenStudies: rules.minDaysBetweenStudies,
      noShowsBeforeSuspension: rules.noShowsBeforeSuspension,
      studies: (await studiesForParticipant(sql, null, rules)).map((s) => ({
        code: s.code, title: s.title, summary: s.summary,
        incentive: s.incentive, durationMinutes: s.durationMinutes,
        minAge: s.minAge, maxAge: s.maxAge, requiresStudent: s.requiresStudent,
        openSessions: s.sessions.filter((x) => !x.full).length,
      })),
    });
  }

  // -- Register into the pool ------------------------------------------------
  if (req.method === "POST" && pathname === "/api/register") {
    const limit = rateLimit(clientKey(req, "register"), 8, 10 * 60_000);
    if (!limit.allowed) {
      return sendJson(res, 429, { error: "Too many attempts from this connection. Please try again shortly." });
    }
    if (!rules.poolOpen) {
      return sendJson(res, 503, { error: "Pool registration is closed at the moment. Please check back later." });
    }

    const body  = await readJson(req);
    const name  = String(body.name  || "").trim();
    const email = String(body.email || "").trim();
    const phone = normalisePhone(body.phone);
    const yearOfBirth = Number(body.yearOfBirth);

    if (!name || name.length < 2) {
      return sendJson(res, 400, { error: "Please enter your full name." });
    }
    if (!isValidEmail(email)) {
      return sendJson(res, 400, { error: "Please enter a valid email address." });
    }
    if (!isValidPhone(phone)) {
      return sendJson(res, 400, { error: "Please enter a valid 10-digit Indian mobile number." });
    }
    const year = CURRENT_YEAR();
    if (!Number.isInteger(yearOfBirth) || yearOfBirth < year - 90 || yearOfBirth > year - 16) {
      return sendJson(res, 400, { error: "Please enter your year of birth." });
    }
    if (body.confirmAdult !== true) {
      return sendJson(res, 400, { error: "The pool is open to people aged 18 and over. Please confirm your age." });
    }
    if (body.consent !== true) {
      return sendJson(res, 400, { error: "You have to agree to your details being held in the pool before you can register." });
    }

    if (await store.findParticipantByEmail(sql, email)) {
      return sendJson(res, 409, { error: "That email address is already registered. Use 'I have registered before' to sign in.", field: "email" });
    }
    if (await store.findParticipantByPhone(sql, phone)) {
      return sendJson(res, 409, { error: "That mobile number is already registered. Use 'I have registered before' to sign in.", field: "phone" });
    }

    const participant = await store.createParticipant(sql, {
      name, email, phone, yearOfBirth,
      gender:      String(body.gender      || "").trim(),
      isStudent:   body.isStudent !== false,
      institution: String(body.institution || "").trim(),
      department:  String(body.department  || "").trim(),
      programme:   String(body.programme   || "").trim(),
      yearOfStudy: String(body.yearOfStudy || "").trim(),
      languages:   Array.isArray(body.languages) ? body.languages.map(String).slice(0, 10) : [],
      howHeard:    String(body.howHeard    || "").trim(),
      consentVersion: rules.consentVersion,
    });

    await store.logActivity(sql, "participant_registered", participant.code);
    return sendJson(res, 201, await portalPayload(sql, participant, rules));
  }

  // -- Returning participant -------------------------------------------------
  if (req.method === "POST" && pathname === "/api/lookup") {
    // Both identifiers have to match one record, and the attempt is rate
    // limited, so the endpoint cannot be walked to find out who is in the pool.
    const limit = rateLimit(clientKey(req, "lookup"), 10, 10 * 60_000);
    if (!limit.allowed) {
      return sendJson(res, 429, { error: "Too many attempts from this connection. Please try again shortly." });
    }
    const body  = await readJson(req);
    const email = String(body.email || "").trim();
    const phone = normalisePhone(body.phone);
    const participant = await store.findParticipantByBoth(sql, email, phone);
    if (!participant) {
      return sendJson(res, 404, {
        error: "No record matches that email address and mobile number together. Check both, or register as a new participant.",
      });
    }
    return sendJson(res, 200, await portalPayload(sql, participant, rules));
  }

  // -- Refresh the portal ----------------------------------------------------
  if (req.method === "POST" && pathname === "/api/me") {
    const participant = await authenticate(sql, await readJson(req));
    if (!participant) return sendJson(res, 401, { error: "Your session has expired. Please sign in again." });
    return sendJson(res, 200, await portalPayload(sql, participant, rules));
  }

  // -- Take a seat -----------------------------------------------------------
  if (req.method === "POST" && pathname === "/api/bookings") {
    const body = await readJson(req);
    const participant = await authenticate(sql, body);
    if (!participant) return sendJson(res, 401, { error: "Your session has expired. Please sign in again." });

    const sessionId = Number(body.sessionId);
    const session = await store.getSessionWithStudy(sql, sessionId);
    if (!session) return sendJson(res, 404, { error: "That session no longer exists." });
    if (session.status !== "open") {
      return sendJson(res, 409, { error: "That session has been cancelled. Please choose another." });
    }
    if (new Date(session.starts_at) <= new Date()) {
      return sendJson(res, 409, { error: "That session has already started. Please choose a later one." });
    }

    const study = {
      status:          session.study_status,
      rcecReference:   session.rcec_reference,
      minAge:          session.min_age,
      maxAge:          session.max_age,
      requiresStudent: session.requires_student,
    };
    const history = await store.getHistory(sql, participant.id);
    const assessment = assessEligibility(
      participant, study,
      { takenThisStudy: history.studiesTaken.has(session.study_id) },
      rules,
    );
    if (!assessment.eligible) {
      return sendJson(res, 403, {
        error: assessment.reasons[0].message,
        reasons: assessment.reasons,
      });
    }

    // The interval is checked against the session actually chosen, not against
    // today, so that booking forwards into the gap is caught as well.
    const conflict = sessionConflict(
      session.starts_at,
      history.intervalSessions.filter((x) => x.studyId !== session.study_id),
      rules.minDaysBetweenStudies,
    );
    if (conflict) {
      return sendJson(res, 403, {
        error: conflictMessage(conflict, rules.minDaysBetweenStudies),
        reasons: [{ code: "too_soon", message: conflictMessage(conflict, rules.minDaysBetweenStudies) }],
      });
    }

    // Every declaration the study asks for has to be ticked. These are the
    // study-specific screening items from SOP 2 that the pool record cannot
    // answer: whether the person wears contact lenses, whether they have run
    // this task before elsewhere, and so on.
    const required = store.safeParse(session.declarations, []);
    const given = Array.isArray(body.declarations) ? body.declarations : [];
    if (required.length > 0 && (given.length !== required.length || !given.every(Boolean))) {
      return sendJson(res, 400, { error: "Please confirm every statement before booking your seat." });
    }

    const seats = bookableSeats(session.capacity, session.buffer_percent);
    const result = await store.insertBooking(sql, {
      participantId: participant.id,
      sessionId,
      studyId:       session.study_id,
      declarations:  required,
      seats,
    });
    if (!result.ok) {
      return sendJson(res, 409, {
        error: result.reason === "duplicate"
          ? "You already have a seat for this study."
          : "That session filled up while you were deciding. Please choose another time.",
      });
    }

    await store.logActivity(sql, "booking_created", `${participant.code} → ${session.study_code} session ${sessionId}`);
    return sendJson(res, 201, {
      message: "Your seat is booked.",
      booking: {
        id:        result.id,
        studyTitle: session.study_title,
        label:     formatSessionTime(session.starts_at),
        location:  session.location || session.venue,
        incentive: session.incentive,
        durationMinutes: session.duration_minutes,
      },
      ...(await portalPayload(sql, participant, rules)),
    });
  }

  // -- Give a seat back ------------------------------------------------------
  if (req.method === "POST" && /^\/api\/bookings\/\d+\/cancel$/.test(pathname)) {
    const body = await readJson(req);
    const participant = await authenticate(sql, body);
    if (!participant) return sendJson(res, 401, { error: "Your session has expired. Please sign in again." });

    const bookingId = Number(pathname.split("/")[3]);
    const booking = await store.getBooking(sql, bookingId);
    if (!booking || booking.participant_id !== participant.id) {
      return sendJson(res, 404, { error: "Booking not found." });
    }
    if (booking.status !== "booked") {
      return sendJson(res, 409, { error: "That booking can no longer be cancelled here. Please write to the lab." });
    }
    // A cancellation given in advance is not a no-show and must not count as
    // one. SOP 5 counts unexplained absence, not a change of plan.
    await store.setBookingStatus(sql, bookingId, "cancelled", "Cancelled by the participant.");
    await store.logActivity(sql, "booking_cancelled", `${participant.code} → booking ${bookingId}`);
    return sendJson(res, 200, {
      message: "Your seat has been released.",
      ...(await portalPayload(sql, participant, rules)),
    });
  }

  // -- Leave the pool --------------------------------------------------------
  if (req.method === "POST" && pathname === "/api/withdraw") {
    const body = await readJson(req);
    const participant = await authenticate(sql, body);
    if (!participant) return sendJson(res, 401, { error: "Your session has expired. Please sign in again." });

    const upcoming = await store.getBookingsForParticipant(sql, participant.id);
    for (const booking of upcoming) {
      if (booking.status === "booked") {
        await store.setBookingStatus(sql, booking.id, "cancelled", "Participant withdrew from the pool.");
      }
    }
    await store.updateParticipantStanding(sql, participant.id, {
      status: "withdrawn", suspendedUntil: null, reason: "Withdrawn at the participant's own request.",
    });
    await store.logActivity(sql, "participant_withdrew", participant.code);
    return sendJson(res, 200, {
      message: "You have been removed from the pool and any upcoming seats have been released. Write to the lab if you would like your details erased entirely, or if you change your mind.",
    });
  }

  return null; // not a public route
}
