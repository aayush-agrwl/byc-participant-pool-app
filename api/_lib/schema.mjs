// ---------------------------------------------------------------------------
// Database schema for the Behavioural Research Lab participant pool.
//
// One statement per array entry. Every statement is idempotent, so the array
// can be replayed against a live database without loss. `scripts/db-init.mjs`
// runs it from the command line and the API runs it once per warm instance.
//
// Personal data lives in `participants` and nowhere else. Every other table
// refers to a participant by integer id. This is deliberate: the data
// inventory in the DPDP note has one row to point at, and an erasure request
// is satisfied by clearing the identifying columns of a single row while the
// booking and attendance history that the lab needs for its own records
// survives in anonymous form.
// ---------------------------------------------------------------------------

export const statements = [
  // -- Participants ---------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS participants (
     id                SERIAL       PRIMARY KEY,
     code              TEXT         NOT NULL UNIQUE,
     name              TEXT         NOT NULL,
     email             TEXT         NOT NULL,
     phone             TEXT         NOT NULL,
     year_of_birth     INTEGER      NOT NULL,
     gender            TEXT         NOT NULL DEFAULT '',
     is_student        BOOLEAN      NOT NULL DEFAULT TRUE,
     institution       TEXT         NOT NULL DEFAULT '',
     department        TEXT         NOT NULL DEFAULT '',
     programme         TEXT         NOT NULL DEFAULT '',
     year_of_study     TEXT         NOT NULL DEFAULT '',
     languages         TEXT         NOT NULL DEFAULT '[]',
     how_heard         TEXT         NOT NULL DEFAULT '',
     consent_version   TEXT         NOT NULL DEFAULT '',
     consent_at        TIMESTAMPTZ,
     status            TEXT         NOT NULL DEFAULT 'active',
     suspended_until   DATE,
     suspension_reason TEXT         NOT NULL DEFAULT '',
     no_show_count     INTEGER      NOT NULL DEFAULT 0,
     erased_at         TIMESTAMPTZ,
     created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // Email and phone identify a returning participant, so both are unique
  // across the pool and both are ignored once a record has been erased.
  `CREATE UNIQUE INDEX IF NOT EXISTS participants_email_key
     ON participants (LOWER(email)) WHERE erased_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS participants_phone_key
     ON participants (phone) WHERE erased_at IS NULL`,

  // -- Studies --------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS studies (
     id                SERIAL       PRIMARY KEY,
     code              TEXT         NOT NULL UNIQUE,
     title             TEXT         NOT NULL,
     summary           TEXT         NOT NULL DEFAULT '',
     pi_name           TEXT         NOT NULL DEFAULT '',
     rcec_reference    TEXT         NOT NULL DEFAULT '',
     incentive         TEXT         NOT NULL DEFAULT '',
     duration_minutes  INTEGER      NOT NULL DEFAULT 60,
     venue             TEXT         NOT NULL DEFAULT '',
     status            TEXT         NOT NULL DEFAULT 'draft',
     min_age           INTEGER      NOT NULL DEFAULT 18,
     max_age           INTEGER      NOT NULL DEFAULT 99,
     requires_student  BOOLEAN      NOT NULL DEFAULT TRUE,
     declarations      TEXT         NOT NULL DEFAULT '[]',
     buffer_percent    INTEGER      NOT NULL DEFAULT 20,
     created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // -- Sessions (bookable slots under a study) ------------------------------
  `CREATE TABLE IF NOT EXISTS sessions (
     id          SERIAL       PRIMARY KEY,
     study_id    INTEGER      NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
     starts_at   TIMESTAMPTZ  NOT NULL,
     capacity    INTEGER      NOT NULL DEFAULT 8,
     location    TEXT         NOT NULL DEFAULT '',
     notes       TEXT         NOT NULL DEFAULT '',
     status      TEXT         NOT NULL DEFAULT 'open',
     created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS sessions_study_idx ON sessions (study_id, starts_at)`,

  // -- Bookings -------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS bookings (
     id             SERIAL       PRIMARY KEY,
     participant_id INTEGER      NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
     session_id     INTEGER      NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     study_id       INTEGER      NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
     status         TEXT         NOT NULL DEFAULT 'booked',
     declarations   TEXT         NOT NULL DEFAULT '[]',
     note           TEXT         NOT NULL DEFAULT '',
     booked_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
     updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  // The absolute rule from SOP 2: nobody takes the same study twice. A booking
  // the participant cancelled before the session is not participation, so a
  // cancelled row does not block a fresh sign-up. Enforced in the database
  // rather than only in the API, because the API is not the only thing that
  // will ever write here.
  `CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_per_study
     ON bookings (participant_id, study_id) WHERE status <> 'cancelled'`,
  `CREATE INDEX IF NOT EXISTS bookings_session_idx ON bookings (session_id)`,

  // -- Pool rules (single row, id = 1) --------------------------------------
  `CREATE TABLE IF NOT EXISTS pool_rules (
     id                        INTEGER PRIMARY KEY DEFAULT 1,
     min_days_between_studies  INTEGER NOT NULL DEFAULT 30,
     no_shows_before_suspension INTEGER NOT NULL DEFAULT 2,
     suspension_days           INTEGER NOT NULL DEFAULT 120,
     default_buffer_percent    INTEGER NOT NULL DEFAULT 20,
     pool_open                 BOOLEAN NOT NULL DEFAULT TRUE,
     consent_version           TEXT    NOT NULL DEFAULT 'v1 (draft, pending RCEC)',
     updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT pool_rules_single_row CHECK (id = 1)
   )`,
  `INSERT INTO pool_rules (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,

  // -- Activity log ---------------------------------------------------------
  // Access to participant data has to be accountable under the DPDP note.
  // This records what the dashboard did, never what it read out.
  `CREATE TABLE IF NOT EXISTS activity_log (
     id          SERIAL       PRIMARY KEY,
     action      TEXT         NOT NULL,
     detail      TEXT         NOT NULL DEFAULT '',
     created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,
];
