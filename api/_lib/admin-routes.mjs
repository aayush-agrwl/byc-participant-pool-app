// ---------------------------------------------------------------------------
// The Lab Manager's half of the API. Everything here is behind the dashboard
// password and every write is recorded in the activity log.
// ---------------------------------------------------------------------------

import {
  sendJson, sendCsv, readJson, csvRows, rateLimit, clientKey,
  createAdminSession, destroyAdminSession, isAdmin,
  setAdminCookie, clearAdminCookie, passwordMatches, parseCookies,
} from "./http.mjs";
import {
  applyNoShow, undoNoShow, approximateAge, formatSessionTime, formatStamp,
  BOOKING_STATUSES, PARTICIPANT_STATUSES,
} from "./rules.mjs";
import * as store from "./store.mjs";

function idFrom(pathname, index) {
  return Number(pathname.split("/")[index]);
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function studyFromBody(body, rules) {
  return {
    title:           String(body.title || "").trim(),
    summary:         String(body.summary || "").trim(),
    piName:          String(body.piName || "").trim(),
    rcecReference:   String(body.rcecReference || "").trim(),
    incentive:       String(body.incentive || "").trim(),
    durationMinutes: clampInt(body.durationMinutes, 5, 600, 60),
    venue:           String(body.venue || "").trim(),
    status:          ["draft", "open", "closed"].includes(body.status) ? body.status : "draft",
    minAge:          clampInt(body.minAge, 18, 99, 18),
    maxAge:          clampInt(body.maxAge, 18, 99, 99),
    requiresStudent: body.requiresStudent !== false,
    declarations:    Array.isArray(body.declarations)
      ? body.declarations.map((d) => String(d).trim()).filter(Boolean).slice(0, 12)
      : [],
    bufferPercent:   clampInt(body.bufferPercent, 0, 100, rules.defaultBufferPercent),
  };
}

export async function handleAdmin(req, res, pathname, sql) {
  // -- Login and logout ------------------------------------------------------
  if (req.method === "POST" && pathname === "/api/admin/login") {
    const limit = rateLimit(clientKey(req, "admin-login"), 8, 15 * 60_000);
    if (!limit.allowed) {
      return sendJson(res, 429, { error: `Too many attempts. Try again in ${limit.retryInSeconds} seconds.` });
    }
    const { password } = await readJson(req);
    if (!passwordMatches(password, process.env.ADMIN_PASSWORD)) {
      return sendJson(res, 401, { error: "Incorrect password." });
    }
    setAdminCookie(res, createAdminSession());
    await store.logActivity(sql, "admin_login", "");
    return sendJson(res, 200, { message: "Signed in." });
  }

  if (req.method === "POST" && pathname === "/api/admin/logout") {
    destroyAdminSession(parseCookies(req).admin_session);
    clearAdminCookie(res);
    return sendJson(res, 200, { message: "Signed out." });
  }

  if (req.method === "GET" && pathname === "/api/admin/session") {
    return sendJson(res, 200, { signedIn: isAdmin(req) });
  }

  // -- Everything past this point needs the password -------------------------
  if (!isAdmin(req)) {
    return sendJson(res, 401, { error: "Dashboard password required." });
  }

  const rules = await store.getRules(sql);

  // -- Overview --------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/overview") {
    const overview = await store.getOverview(sql);
    return sendJson(res, 200, {
      ...overview,
      rules,
      upcoming: overview.upcoming.map((s) => ({ ...s, label: formatSessionTime(s.startsAt) })),
    });
  }

  // -- Participants ----------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/participants") {
    const participants = await store.listParticipants(sql);
    return sendJson(res, 200, participants.map((p) => ({
      ...p,
      age: approximateAge(p.yearOfBirth),
      lastParticipationLabel: p.lastParticipation ? formatSessionTime(p.lastParticipation) : "",
    })));
  }

  if (req.method === "GET" && pathname === "/api/admin/participants.csv") {
    const participants = await store.listParticipants(sql);
    const header = [
      "participant_code", "name", "email", "phone", "year_of_birth", "age_approx",
      "gender", "is_student", "institution", "department", "programme",
      "year_of_study", "languages", "how_heard", "pool_status", "suspended_until",
      "no_show_count", "bookings", "sessions_attended", "last_participation",
      "consent_version", "registered_at",
    ];
    const body = participants.map((p) => [
      p.code, p.name, p.email, p.phone, p.yearOfBirth, approximateAge(p.yearOfBirth),
      p.gender, p.isStudent ? "yes" : "no", p.institution, p.department, p.programme,
      p.yearOfStudy, p.languages.join("; "), p.howHeard, p.status,
      p.suspendedUntil ? formatStamp(p.suspendedUntil).slice(0, 10) : "",
      p.noShowCount, p.bookingsCount, p.participatedCount,
      p.lastParticipation ? formatStamp(p.lastParticipation) : "",
      p.consentVersion, formatStamp(p.createdAt),
    ]);
    await store.logActivity(sql, "export_participants", `${participants.length} rows`);
    return sendCsv(res, `participant-pool-${formatStamp(new Date()).slice(0, 10)}.csv`,
      csvRows([header, ...body]));
  }

  if (req.method === "PATCH" && /^\/api\/admin\/participants\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const body = await readJson(req);
    if (!PARTICIPANT_STATUSES.includes(body.status)) {
      return sendJson(res, 400, { error: "Unknown pool status." });
    }
    const participant = await store.updateParticipantStanding(sql, id, {
      status:         body.status,
      suspendedUntil: body.status === "suspended" ? (body.suspendedUntil || null) : null,
      reason:         String(body.reason || "").trim(),
      noShowCount:    body.resetNoShows === true ? 0 : null,
    });
    if (!participant) return sendJson(res, 404, { error: "Participant not found." });
    await store.logActivity(sql, "participant_standing", `${participant.code} → ${body.status}`);
    return sendJson(res, 200, { message: "Pool standing updated.", participant });
  }

  if (req.method === "POST" && /^\/api\/admin\/participants\/\d+\/erase$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const before = await store.getParticipant(sql, id);
    if (!before) return sendJson(res, 404, { error: "Participant not found." });
    if (before.erasedAt) return sendJson(res, 409, { error: "That record has already been erased." });
    const participant = await store.erasePartipant(sql, id);
    await store.logActivity(sql, "participant_erased", before.code);
    return sendJson(res, 200, {
      message: `${before.code} has been erased. The booking history is kept without any identifying details.`,
      participant,
    });
  }

  // -- Studies ---------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/studies") {
    const studies = await store.listStudies(sql);
    const withSessions = [];
    for (const study of studies) {
      withSessions.push({
        ...study,
        sessions: (await store.listSessions(sql, study.id, study.bufferPercent))
          .map((s) => ({ ...s, label: formatSessionTime(s.startsAt) })),
      });
    }
    return sendJson(res, 200, withSessions);
  }

  if (req.method === "POST" && pathname === "/api/admin/studies") {
    const body = await readJson(req);
    const study = studyFromBody(body, rules);
    if (!study.title) return sendJson(res, 400, { error: "The study needs a title." });
    if (study.minAge > study.maxAge) {
      return sendJson(res, 400, { error: "The minimum age cannot be above the maximum age." });
    }
    // No study recruits without an ethics reference. This is the one rule the
    // dashboard will not let anybody click past.
    if (study.status === "open" && !study.rcecReference) {
      return sendJson(res, 400, {
        error: "A study cannot be opened for sign-up without an RCEC approval reference. Save it as a draft until the approval is in hand.",
      });
    }
    const code = String(body.code || "").trim().toUpperCase()
      || `BRL-S${String((await store.listStudies(sql)).length + 1).padStart(2, "0")}`;
    try {
      const created = await store.createStudy(sql, { ...study, code });
      await store.logActivity(sql, "study_created", created.code);
      return sendJson(res, 201, { message: "Study created.", study: created });
    } catch (error) {
      if (String(error?.message || "").includes("studies_code_key")) {
        return sendJson(res, 409, { error: "That study code is already in use." });
      }
      throw error;
    }
  }

  if (req.method === "PATCH" && /^\/api\/admin\/studies\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const study = studyFromBody(await readJson(req), rules);
    if (!study.title) return sendJson(res, 400, { error: "The study needs a title." });
    if (study.minAge > study.maxAge) {
      return sendJson(res, 400, { error: "The minimum age cannot be above the maximum age." });
    }
    if (study.status === "open" && !study.rcecReference) {
      return sendJson(res, 400, {
        error: "A study cannot be opened for sign-up without an RCEC approval reference.",
      });
    }
    const updated = await store.updateStudy(sql, id, study);
    if (!updated) return sendJson(res, 404, { error: "Study not found." });
    await store.logActivity(sql, "study_updated", `${updated.code} → ${updated.status}`);
    return sendJson(res, 200, { message: "Study updated.", study: updated });
  }

  if (req.method === "DELETE" && /^\/api\/admin\/studies\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const study = await store.getStudy(sql, id);
    if (!study) return sendJson(res, 404, { error: "Study not found." });
    const result = await store.deleteStudy(sql, id);
    if (!result.deleted) {
      return sendJson(res, 409, {
        error: `${result.count} people are booked on this study. Close it instead of deleting it, so the record of who took part survives.`,
      });
    }
    await store.logActivity(sql, "study_deleted", study.code);
    return sendJson(res, 200, { message: "Study deleted." });
  }

  // -- Sessions --------------------------------------------------------------
  if (req.method === "POST" && pathname === "/api/admin/sessions") {
    const body = await readJson(req);
    const studyId = Number(body.studyId);
    const study = await store.getStudy(sql, studyId);
    if (!study) return sendJson(res, 404, { error: "Study not found." });

    // The browser sends a wall-clock date and time, which the Lab Manager
    // typed while thinking in Bangalore time. The server runs in UTC, so the
    // offset is applied here rather than trusting whatever the browser meant.
    const date = String(body.date || "");
    const time = String(body.time || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return sendJson(res, 400, { error: "Please give a date and a time for the session." });
    }
    const startsAt = new Date(`${date}T${time}:00+05:30`);
    if (Number.isNaN(startsAt.getTime())) {
      return sendJson(res, 400, { error: "That date and time could not be read." });
    }

    const created = await store.createSession(sql, {
      studyId,
      startsAt:  startsAt.toISOString(),
      capacity:  clampInt(body.capacity, 1, 200, 8),
      location:  String(body.location || study.venue || "").trim(),
      notes:     String(body.notes || "").trim(),
    });
    await store.logActivity(sql, "session_created", `${study.code} ${formatSessionTime(startsAt)}`);
    return sendJson(res, 201, { message: "Session added.", session: created });
  }

  if (req.method === "PATCH" && /^\/api\/admin\/sessions\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const { status } = await readJson(req);
    if (!["open", "cancelled"].includes(status)) {
      return sendJson(res, 400, { error: "A session is either open or cancelled." });
    }
    const session = await store.updateSessionStatus(sql, id, status);
    if (!session) return sendJson(res, 404, { error: "Session not found." });
    await store.logActivity(sql, "session_status", `session ${id} → ${status}`);
    return sendJson(res, 200, {
      message: status === "cancelled"
        ? "Session cancelled. The people booked on it still hold their seats, so contact them and either rebook or release them."
        : "Session reopened.",
    });
  }

  if (req.method === "DELETE" && /^\/api\/admin\/sessions\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const result = await store.deleteSession(sql, id);
    if (!result.deleted) {
      return sendJson(res, 409, {
        error: `${result.count} people are booked on this session. Cancel it rather than deleting it.`,
      });
    }
    await store.logActivity(sql, "session_deleted", `session ${id}`);
    return sendJson(res, 200, { message: "Session deleted." });
  }

  // -- Roster ----------------------------------------------------------------
  if (req.method === "GET" && /^\/api\/admin\/sessions\/\d+\/roster$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const session = await store.getSessionWithStudy(sql, id);
    if (!session) return sendJson(res, 404, { error: "Session not found." });
    const roster = await store.getRoster(sql, id);
    return sendJson(res, 200, {
      session: {
        id,
        label:      formatSessionTime(session.starts_at),
        location:   session.location || session.venue,
        capacity:   session.capacity,
        studyCode:  session.study_code,
        studyTitle: session.study_title,
        rcecReference: session.rcec_reference,
      },
      roster: roster.map((r) => ({ ...r, age: approximateAge(r.yearOfBirth) })),
    });
  }

  if (req.method === "GET" && /^\/api\/admin\/sessions\/\d+\/roster\.csv$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const session = await store.getSessionWithStudy(sql, id);
    if (!session) return sendJson(res, 404, { error: "Session not found." });
    const roster = await store.getRoster(sql, id);
    const header = [
      "participant_code", "name", "phone", "email", "age_approx", "institution",
      "pool_status", "prior_no_shows", "booking_status", "note", "booked_at",
    ];
    const body = roster.map((r) => [
      r.code, r.name, r.phone, r.email, approximateAge(r.yearOfBirth), r.institution,
      r.poolStatus, r.noShowCount, r.status, r.note, formatStamp(r.bookedAt),
    ]);
    await store.logActivity(sql, "export_roster", `session ${id}, ${roster.length} rows`);
    return sendCsv(res, `roster-${session.study_code}-session-${id}.csv`, csvRows([header, ...body]));
  }

  // -- Attendance ------------------------------------------------------------
  if (req.method === "PATCH" && /^\/api\/admin\/bookings\/\d+$/.test(pathname)) {
    const id = idFrom(pathname, 4);
    const body = await readJson(req);
    const status = body.status;
    if (!BOOKING_STATUSES.includes(status)) {
      return sendJson(res, 400, { error: "Unknown attendance status." });
    }
    const before = await store.getBooking(sql, id);
    if (!before) return sendJson(res, 404, { error: "Booking not found." });

    const booking = await store.setBookingStatus(sql, id, status, String(body.note || "").trim());

    // A no-show counts against the participant record, and the second one
    // suspends them. The count follows the status in both directions and only
    // when it actually changes: re-selecting no_show on a row that is already a
    // no-show must not count twice, and correcting a mis-click back to attended
    // has to take the mark off again.
    let standing = null;
    const wasNoShow = before.status === "no_show";
    const isNoShow  = status === "no_show";

    if (isNoShow && !wasNoShow) {
      const participant = await store.getParticipant(sql, booking.participant_id);
      const outcome = applyNoShow(participant.noShowCount, rules);
      standing = await store.updateParticipantStanding(sql, participant.id, outcome);
      await store.logActivity(sql, "no_show_recorded",
        `${participant.code}, count ${outcome.noShowCount}, status ${outcome.status}`);
    } else if (wasNoShow && !isNoShow) {
      const participant = await store.getParticipant(sql, booking.participant_id);
      const outcome = undoNoShow(participant, rules);
      standing = await store.updateParticipantStanding(sql, participant.id, outcome);
      await store.logActivity(sql, "no_show_reversed",
        `${participant.code}, count ${outcome.noShowCount}, status ${outcome.status}`);
    }

    await store.logActivity(sql, "attendance_marked", `booking ${id} → ${status}`);
    let message = "Recorded.";
    if (standing?.status === "suspended" && isNoShow) {
      message = `Recorded. ${standing.code} has now reached ${standing.noShowCount} unexplained no-shows and is paused until ${formatStamp(standing.suspendedUntil).slice(0, 10)}.`;
    } else if (wasNoShow && !isNoShow) {
      message = standing.status === "active" && /corrected/i.test(standing.suspensionReason)
        ? `Recorded. The no-show has been taken off ${standing.code}'s record and the pause on their membership is lifted.`
        : `Recorded. The no-show has been taken off ${standing.code}'s record, which now stands at ${standing.noShowCount}.`;
    }
    return sendJson(res, 200, { message, standing });
  }

  // -- Pool rules ------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/rules") {
    return sendJson(res, 200, rules);
  }

  if (req.method === "PATCH" && pathname === "/api/admin/rules") {
    const body = await readJson(req);
    const next = {
      minDaysBetweenStudies:   clampInt(body.minDaysBetweenStudies, 0, 365, rules.minDaysBetweenStudies),
      noShowsBeforeSuspension: clampInt(body.noShowsBeforeSuspension, 1, 10, rules.noShowsBeforeSuspension),
      suspensionDays:          clampInt(body.suspensionDays, 1, 730, rules.suspensionDays),
      defaultBufferPercent:    clampInt(body.defaultBufferPercent, 0, 100, rules.defaultBufferPercent),
      poolOpen:                body.poolOpen !== false,
      consentVersion:          String(body.consentVersion || rules.consentVersion).trim(),
    };
    await store.updateRules(sql, next);
    await store.logActivity(sql, "rules_updated", JSON.stringify(next));
    return sendJson(res, 200, { message: "Pool rules saved.", rules: next });
  }

  // -- Activity --------------------------------------------------------------
  if (req.method === "GET" && pathname === "/api/admin/activity") {
    const rows = await store.listActivity(sql, 150);
    return sendJson(res, 200, rows.map((r) => ({
      action: r.action, detail: r.detail, at: formatStamp(r.created_at),
    })));
  }

  return null;
}
