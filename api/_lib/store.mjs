// ---------------------------------------------------------------------------
// Data access. Every SQL statement in the application lives in this file.
// ---------------------------------------------------------------------------

import { neon } from "@neondatabase/serverless";
import { statements } from "./schema.mjs";
import {
  HOLDS_SEAT, PARTICIPATED, COUNTS_TOWARDS_INTERVAL,
  bookableSeats, participantCode,
} from "./rules.mjs";

const SEAT_HOLDING = [...HOLDS_SEAT];
const PARTICIPATED_IN = [...PARTICIPATED];

export function getSql() {
  return neon(process.env.DATABASE_URL);
}

// The schema is applied once per warm instance. A failure clears the flag so
// the next request retries rather than serving a half-built database.
if (global.__schemaReady === undefined) global.__schemaReady = false;

export async function ensureSchema(sql) {
  if (global.__schemaReady) return;
  for (const statement of statements) await sql.query(statement);
  global.__schemaReady = true;
}

export function resetSchemaFlag() {
  global.__schemaReady = false;
}

// ---------------------------------------------------------------------------
// Pool rules
// ---------------------------------------------------------------------------

export async function getRules(sql) {
  const [row] = await sql`SELECT * FROM pool_rules WHERE id = 1`;
  return {
    minDaysBetweenStudies:   row.min_days_between_studies,
    noShowsBeforeSuspension: row.no_shows_before_suspension,
    suspensionDays:          row.suspension_days,
    defaultBufferPercent:    row.default_buffer_percent,
    poolOpen:                row.pool_open,
    consentVersion:          row.consent_version,
  };
}

export async function updateRules(sql, r) {
  await sql`
    UPDATE pool_rules SET
      min_days_between_studies   = ${r.minDaysBetweenStudies},
      no_shows_before_suspension = ${r.noShowsBeforeSuspension},
      suspension_days            = ${r.suspensionDays},
      default_buffer_percent     = ${r.defaultBufferPercent},
      pool_open                  = ${r.poolOpen},
      consent_version            = ${r.consentVersion},
      updated_at                 = NOW()
    WHERE id = 1
  `;
}

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

function mapParticipant(row) {
  if (!row) return null;
  return {
    id:               row.id,
    code:             row.code,
    name:             row.name,
    email:            row.email,
    phone:            row.phone,
    yearOfBirth:      row.year_of_birth,
    gender:           row.gender,
    isStudent:        row.is_student,
    institution:      row.institution,
    department:       row.department,
    programme:        row.programme,
    yearOfStudy:      row.year_of_study,
    languages:        safeParse(row.languages, []),
    howHeard:         row.how_heard,
    consentVersion:   row.consent_version,
    consentAt:        row.consent_at,
    status:           row.status,
    suspendedUntil:   row.suspended_until,
    suspensionReason: row.suspension_reason,
    noShowCount:      row.no_show_count,
    erasedAt:         row.erased_at,
    createdAt:        row.created_at,
  };
}

export function safeParse(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export async function findParticipantByEmail(sql, email) {
  const [row] = await sql`
    SELECT * FROM participants
    WHERE LOWER(email) = LOWER(${email}) AND erased_at IS NULL
  `;
  return mapParticipant(row);
}

export async function findParticipantByPhone(sql, phone) {
  const [row] = await sql`
    SELECT * FROM participants WHERE phone = ${phone} AND erased_at IS NULL
  `;
  return mapParticipant(row);
}

/** The returning-participant lookup: both identifiers must match one record. */
export async function findParticipantByBoth(sql, email, phone) {
  const [row] = await sql`
    SELECT * FROM participants
    WHERE LOWER(email) = LOWER(${email}) AND phone = ${phone} AND erased_at IS NULL
  `;
  return mapParticipant(row);
}

export async function getParticipant(sql, id) {
  const [row] = await sql`SELECT * FROM participants WHERE id = ${id}`;
  return mapParticipant(row);
}

export async function createParticipant(sql, p) {
  // The code is issued from the row's own id so that it is sequential and
  // carries no personal data. The row is inserted with a placeholder first
  // because the id does not exist until the insert has run.
  const placeholder = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await sql`
    INSERT INTO participants (
      code, name, email, phone, year_of_birth, gender, is_student,
      institution, department, programme, year_of_study, languages,
      how_heard, consent_version, consent_at
    ) VALUES (
      ${placeholder}, ${p.name}, ${p.email}, ${p.phone}, ${p.yearOfBirth},
      ${p.gender}, ${p.isStudent}, ${p.institution}, ${p.department},
      ${p.programme}, ${p.yearOfStudy}, ${JSON.stringify(p.languages)},
      ${p.howHeard}, ${p.consentVersion}, NOW()
    )
    RETURNING id
  `;
  const code = participantCode(row.id);
  const [updated] = await sql`
    UPDATE participants SET code = ${code} WHERE id = ${row.id} RETURNING *
  `;
  return mapParticipant(updated);
}

export async function updateParticipantStanding(sql, id, standing) {
  const [row] = await sql`
    UPDATE participants SET
      status            = ${standing.status},
      suspended_until   = ${standing.suspendedUntil ?? null},
      suspension_reason = ${standing.reason ?? ""},
      no_show_count     = COALESCE(${standing.noShowCount ?? null}, no_show_count),
      updated_at        = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return mapParticipant(row);
}

/**
 * Erasure.
 *
 * The identifying columns are cleared and the row is kept, so that the lab's
 * own record of who sat in which session survives as a count while the person
 * is no longer identifiable from it. This is the shape the DPDP note asks for:
 * erasure of personal data, not destruction of the research record.
 */
export async function erasePartipant(sql, id) {
  const [row] = await sql`
    UPDATE participants SET
      name = 'Erased', email = ${`erased-${id}@invalid.local`}, phone = ${`erased-${id}`},
      gender = '', institution = '', department = '', programme = '',
      year_of_study = '', languages = '[]', how_heard = '',
      status = 'withdrawn', erased_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND erased_at IS NULL
    RETURNING *
  `;
  return mapParticipant(row);
}

export async function listParticipants(sql) {
  const rows = await sql`
    SELECT p.*,
      COUNT(b.id) FILTER (WHERE b.status = ANY(${SEAT_HOLDING}))::int    AS bookings_count,
      COUNT(b.id) FILTER (WHERE b.status = ANY(${PARTICIPATED_IN}))::int AS participated_count,
      MAX(s.starts_at) FILTER (WHERE b.status = ANY(${PARTICIPATED_IN})) AS last_participation
    FROM participants p
    LEFT JOIN bookings b ON b.participant_id = p.id
    LEFT JOIN sessions s ON s.id = b.session_id
    GROUP BY p.id
    ORDER BY p.id DESC
  `;
  return rows.map((row) => ({
    ...mapParticipant(row),
    bookingsCount:      row.bookings_count,
    participatedCount:  row.participated_count,
    lastParticipation:  row.last_participation,
  }));
}

// ---------------------------------------------------------------------------
// Participation history, used by the eligibility check
// ---------------------------------------------------------------------------

/**
 * @returns {{ studiesTaken:Set<number>, intervalSessions:Array<{studyId:number, at:Date}> }}
 *
 * `studiesTaken` holds every study the participant currently has a live
 * booking on, whether or not they have sat it yet, because a person holding a
 * seat for Friday has already signed up for that study.
 *
 * `intervalSessions` are the session times that the between-studies interval
 * is measured against. Session times rather than booking times, because the
 * interval is about how close together somebody sits two studies, and future
 * times as well as past ones, because a seat already booked for next week
 * constrains what can be booked the week after.
 */
export async function getHistory(sql, participantId) {
  const rows = await sql`
    SELECT b.study_id, b.status, s.starts_at
    FROM bookings b
    JOIN sessions s ON s.id = b.session_id
    WHERE b.participant_id = ${participantId} AND b.status <> 'cancelled'
  `;
  const studiesTaken = new Set();
  const intervalSessions = [];
  for (const row of rows) {
    studiesTaken.add(row.study_id);
    if (COUNTS_TOWARDS_INTERVAL.has(row.status)) {
      intervalSessions.push({ studyId: row.study_id, at: new Date(row.starts_at) });
    }
  }
  return { studiesTaken, intervalSessions };
}

export async function getBookingsForParticipant(sql, participantId) {
  const rows = await sql`
    SELECT b.id, b.status, b.booked_at, b.note,
           s.starts_at, s.location,
           st.code AS study_code, st.title AS study_title,
           st.incentive, st.duration_minutes, st.venue
    FROM bookings b
    JOIN sessions s  ON s.id  = b.session_id
    JOIN studies  st ON st.id = b.study_id
    WHERE b.participant_id = ${participantId}
    ORDER BY s.starts_at DESC
  `;
  return rows.map((r) => ({
    id:              r.id,
    status:          r.status,
    bookedAt:        r.booked_at,
    note:            r.note,
    startsAt:        r.starts_at,
    location:        r.location || r.venue,
    studyCode:       r.study_code,
    studyTitle:      r.study_title,
    incentive:       r.incentive,
    durationMinutes: r.duration_minutes,
  }));
}

// ---------------------------------------------------------------------------
// Studies and sessions
// ---------------------------------------------------------------------------

function mapStudy(row) {
  return {
    id:              row.id,
    code:            row.code,
    title:           row.title,
    summary:         row.summary,
    piName:          row.pi_name,
    rcecReference:   row.rcec_reference,
    incentive:       row.incentive,
    durationMinutes: row.duration_minutes,
    venue:           row.venue,
    status:          row.status,
    minAge:          row.min_age,
    maxAge:          row.max_age,
    requiresStudent: row.requires_student,
    declarations:    safeParse(row.declarations, []),
    bufferPercent:   row.buffer_percent,
    createdAt:       row.created_at,
  };
}

export async function listStudies(sql) {
  const rows = await sql`SELECT * FROM studies ORDER BY id DESC`;
  return rows.map(mapStudy);
}

export async function getStudy(sql, id) {
  const [row] = await sql`SELECT * FROM studies WHERE id = ${id}`;
  return row ? mapStudy(row) : null;
}

export async function createStudy(sql, s) {
  const [row] = await sql`
    INSERT INTO studies (
      code, title, summary, pi_name, rcec_reference, incentive,
      duration_minutes, venue, status, min_age, max_age, requires_student,
      declarations, buffer_percent
    ) VALUES (
      ${s.code}, ${s.title}, ${s.summary}, ${s.piName}, ${s.rcecReference},
      ${s.incentive}, ${s.durationMinutes}, ${s.venue}, ${s.status},
      ${s.minAge}, ${s.maxAge}, ${s.requiresStudent},
      ${JSON.stringify(s.declarations)}, ${s.bufferPercent}
    )
    RETURNING *
  `;
  return mapStudy(row);
}

export async function updateStudy(sql, id, s) {
  const [row] = await sql`
    UPDATE studies SET
      title = ${s.title}, summary = ${s.summary}, pi_name = ${s.piName},
      rcec_reference = ${s.rcecReference}, incentive = ${s.incentive},
      duration_minutes = ${s.durationMinutes}, venue = ${s.venue},
      status = ${s.status}, min_age = ${s.minAge}, max_age = ${s.maxAge},
      requires_student = ${s.requiresStudent},
      declarations = ${JSON.stringify(s.declarations)},
      buffer_percent = ${s.bufferPercent}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return row ? mapStudy(row) : null;
}

export async function deleteStudy(sql, id) {
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM bookings
    WHERE study_id = ${id} AND status <> 'cancelled'
  `;
  if (count > 0) return { deleted: false, count };
  await sql`DELETE FROM studies WHERE id = ${id}`;
  return { deleted: true, count: 0 };
}

/** Sessions for one study, with seats taken and seats bookable. */
export async function listSessions(sql, studyId, bufferPercent) {
  const rows = await sql`
    SELECT s.*,
      COUNT(b.id) FILTER (WHERE b.status = ANY(${SEAT_HOLDING}))::int    AS taken,
      COUNT(b.id) FILTER (WHERE b.status = ANY(${PARTICIPATED_IN}))::int AS attended,
      COUNT(b.id) FILTER (WHERE b.status = 'no_show')::int               AS no_shows
    FROM sessions s
    LEFT JOIN bookings b ON b.session_id = s.id
    WHERE s.study_id = ${studyId}
    GROUP BY s.id
    ORDER BY s.starts_at
  `;
  return rows.map((r) => {
    const seats = bookableSeats(r.capacity, bufferPercent);
    return {
      id:        r.id,
      studyId:   r.study_id,
      startsAt:  r.starts_at,
      capacity:  r.capacity,
      location:  r.location,
      notes:     r.notes,
      status:    r.status,
      taken:     r.taken,
      attended:  r.attended,
      noShows:   r.no_shows,
      seats,
      remaining: Math.max(0, seats - r.taken),
    };
  });
}

export async function createSession(sql, s) {
  const [row] = await sql`
    INSERT INTO sessions (study_id, starts_at, capacity, location, notes)
    VALUES (${s.studyId}, ${s.startsAt}, ${s.capacity}, ${s.location}, ${s.notes})
    RETURNING *
  `;
  return row;
}

export async function updateSessionStatus(sql, id, status) {
  const [row] = await sql`
    UPDATE sessions SET status = ${status} WHERE id = ${id} RETURNING *
  `;
  return row ?? null;
}

export async function deleteSession(sql, id) {
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM bookings
    WHERE session_id = ${id} AND status <> 'cancelled'
  `;
  if (count > 0) return { deleted: false, count };
  await sql`DELETE FROM sessions WHERE id = ${id}`;
  return { deleted: true, count: 0 };
}

export async function getSessionWithStudy(sql, sessionId) {
  const [row] = await sql`
    SELECT s.id, s.study_id, s.starts_at, s.capacity, s.location, s.status,
           st.buffer_percent, st.status AS study_status, st.rcec_reference,
           st.min_age, st.max_age, st.requires_student, st.declarations,
           st.title AS study_title, st.code AS study_code, st.venue,
           st.incentive, st.duration_minutes
    FROM sessions s
    JOIN studies st ON st.id = s.study_id
    WHERE s.id = ${sessionId}
  `;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

/**
 * Take a seat, or fail without taking one.
 *
 * The seat count is evaluated inside the insert rather than in a prior query,
 * so that two people confirming the last seat at the same moment cannot both
 * be given it. The partial unique index on (participant_id, study_id) is the
 * second guard: it is what stops the same person taking one study twice even
 * if two of their own requests arrive together.
 *
 * @returns {{ ok:true, id:number } | { ok:false, reason:'full'|'duplicate' }}
 */
export async function insertBooking(sql, { participantId, sessionId, studyId, declarations, seats }) {
  let rows;
  try {
    rows = await sql`
      INSERT INTO bookings (participant_id, session_id, study_id, declarations)
      SELECT ${participantId}, ${sessionId}, ${studyId}, ${JSON.stringify(declarations)}
      WHERE (
        SELECT COUNT(*) FROM bookings b
        WHERE b.session_id = ${sessionId} AND b.status = ANY(${SEAT_HOLDING})
      ) < ${seats}
      RETURNING id
    `;
  } catch (error) {
    if (String(error?.message || "").includes("bookings_one_per_study")) {
      return { ok: false, reason: "duplicate" };
    }
    throw error;
  }
  if (rows.length === 0) return { ok: false, reason: "full" };
  return { ok: true, id: rows[0].id };
}

export async function getBooking(sql, id) {
  const [row] = await sql`
    SELECT b.*, s.starts_at, s.location, st.title AS study_title, st.code AS study_code
    FROM bookings b
    JOIN sessions s  ON s.id  = b.session_id
    JOIN studies  st ON st.id = b.study_id
    WHERE b.id = ${id}
  `;
  return row ?? null;
}

export async function setBookingStatus(sql, id, status, note) {
  const [row] = await sql`
    UPDATE bookings
    SET status = ${status}, note = ${note ?? ""}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return row ?? null;
}

/** The roster a research assistant works from at check-in. */
export async function getRoster(sql, sessionId) {
  const rows = await sql`
    SELECT b.id, b.status, b.note, b.booked_at,
           p.id AS participant_id, p.code, p.name, p.email, p.phone,
           p.year_of_birth, p.institution, p.no_show_count, p.status AS pool_status
    FROM bookings b
    JOIN participants p ON p.id = b.participant_id
    WHERE b.session_id = ${sessionId}
    ORDER BY b.booked_at
  `;
  return rows.map((r) => ({
    bookingId:     r.id,
    status:        r.status,
    note:          r.note,
    bookedAt:      r.booked_at,
    participantId: r.participant_id,
    code:          r.code,
    name:          r.name,
    email:         r.email,
    phone:         r.phone,
    yearOfBirth:   r.year_of_birth,
    institution:   r.institution,
    noShowCount:   r.no_show_count,
    poolStatus:    r.pool_status,
  }));
}

// ---------------------------------------------------------------------------
// Overview counts for the dashboard
// ---------------------------------------------------------------------------

export async function getOverview(sql) {
  const [pool] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE erased_at IS NULL)::int                              AS total,
      COUNT(*) FILTER (WHERE status = 'active'    AND erased_at IS NULL)::int     AS active,
      COUNT(*) FILTER (WHERE status = 'suspended' AND erased_at IS NULL)::int     AS suspended,
      COUNT(*) FILTER (WHERE status = 'withdrawn' AND erased_at IS NULL)::int     AS withdrawn,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int         AS last_seven_days
    FROM participants
  `;
  const [studies] = await sql`
    SELECT
      COUNT(*)::int                                AS total,
      COUNT(*) FILTER (WHERE status = 'open')::int AS open
    FROM studies
  `;
  const [bookings] = await sql`
    SELECT
      COUNT(*)::int                                        AS total,
      COUNT(*) FILTER (WHERE status = 'booked')::int       AS booked,
      COUNT(*) FILTER (WHERE status = ANY(${PARTICIPATED_IN}))::int AS attended,
      COUNT(*) FILTER (WHERE status = 'no_show')::int      AS no_shows
    FROM bookings
  `;
  const upcoming = await sql`
    SELECT s.id, s.starts_at, s.capacity, s.location, s.status,
           st.code AS study_code, st.title AS study_title, st.buffer_percent,
           COUNT(b.id) FILTER (WHERE b.status = ANY(${SEAT_HOLDING}))::int AS taken
    FROM sessions s
    JOIN studies st ON st.id = s.study_id
    LEFT JOIN bookings b ON b.session_id = s.id
    WHERE s.starts_at > NOW() - INTERVAL '2 hours' AND s.status = 'open'
    GROUP BY s.id, st.code, st.title, st.buffer_percent
    ORDER BY s.starts_at
    LIMIT 12
  `;
  return {
    pool,
    studies,
    bookings,
    upcoming: upcoming.map((r) => ({
      id:         r.id,
      startsAt:   r.starts_at,
      capacity:   r.capacity,
      location:   r.location,
      studyCode:  r.study_code,
      studyTitle: r.study_title,
      taken:      r.taken,
      seats:      bookableSeats(r.capacity, r.buffer_percent),
    })),
  };
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export async function logActivity(sql, action, detail) {
  await sql`INSERT INTO activity_log (action, detail) VALUES (${action}, ${detail})`;
}

export async function listActivity(sql, limit = 100) {
  return sql`
    SELECT action, detail, created_at FROM activity_log
    ORDER BY id DESC LIMIT ${limit}
  `;
}
