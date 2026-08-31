# Participant pool and sign-up system

Behavioural Research Lab, Department of Economics
CHRIST (Deemed to be University), Bangalore Yeshwanthpur Campus

The registration and booking system for the lab's participant pool. It is the
software half of deliverable 4 of the August 2026 consultancy workplan, and it
implements the rules written into the Lab Operations Manual, SOP 2 (check-in
and repeat participation) and SOP 5 (no-show, late arrival and withdrawal).

## What it does

**For a participant.** Register once, with contact details, a small set of
demographics and consent to be held on the register. The system then shows
every study that is recruiting, says plainly whether they can take each one and
why not where they cannot, and lets them pick a session time. They can cancel a
seat, and they can withdraw from the pool.

**For the Lab Manager.** A password-protected dashboard at `/admin` that
creates studies and session times, prints and exports a check-in roster, records
attendance, holds the participant register, and sets the pool rules.

## The rules it enforces

These are enforced by the server, not only shown on the page. A participant who
opens the browser console cannot book past any of them.

| Rule | Where it comes from |
|---|---|
| No study is visible to a participant, or bookable, without an RCEC approval reference recorded against it | Lab Operations Manual, "IRB approval is granted per study, not per lab" |
| Nobody takes the same study twice. Absolute. | SOP 2 |
| A minimum interval between two *different* studies, measured between the two session dates | SOP 2 |
| Sessions are over-recruited by a buffer, 20 per cent by default | SOP 5 |
| Unexplained no-shows are counted, and the second one pauses the participant's membership | SOP 5 |
| A cancellation given in advance is not a no-show and costs the participant nothing | SOP 5 |

The interval between studies is checked against the **session time being
booked**, not against today. A participant who holds a seat for next Tuesday
cannot book a different study for the Thursday after, which a check against
today would let through.

Where a participant cannot sign up, the page gives every reason at once rather
than the first one found, and gives the date the block lifts where it is
temporary.

### Two decisions worth knowing about

**Year of birth, not date of birth.** The register holds the year only, because
year is all the age bands need and the DPDP note asks for no more than the
purpose requires. Age is therefore accurate to within a year, and it is used to
filter the study list rather than to admit anybody: SOP 2 step 3 re-screens age
against photo ID at check-in, and that check is the authoritative one.

**Email and mobile together are the sign-in.** There is no password for
participants. Both identifiers have to match one record, and the lookup is rate
limited so the endpoint cannot be walked to find out who is in the pool. This is
proportionate to what the record holds and it keeps a student from being locked
out of a session by a forgotten password. It is listed as an open item below.

## Running it locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3400`, and the dashboard at
`http://localhost:3400/admin`.

`.env.local` holds three values, and is not committed:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Neon pooled connection string |
| `ADMIN_PASSWORD` | The dashboard password |
| `SESSION_SECRET` | Signs participant sign-in tokens. Rotating it signs everybody out |

## Commands

| Command | What it does |
|---|---|
| `npm run check` | 77 checks of the pool rules, with no database and no network. Run after touching anything in `api/_lib/` |
| `npm run db:init` | Applies the schema. Idempotent, safe to replay against a live database |
| `npm run db:status` | What is in the database now, and a warning if any study is open without an ethics reference |
| `npm run db:seed` | Two dry-run studies with session times, for rehearsing the flow |
| `npm run db:teardown -- yes` | Deletes every participant, study, session and booking. Keeps the pool rules |
| `npm run dev` | Local server on port 3400 |

`npm run check` is the one that matters. The pool rules fail silently: a page
that wrongly lets somebody book looks exactly like a page that correctly lets
somebody book, and the cost is a contaminated sample that nobody notices until
analysis.

## Layout

```text
api/
  index.js              Router. One serverless function serves the whole API
  _lib/
    rules.mjs           Every pool rule, as pure functions. The file to read first
    store.mjs           Every SQL statement in the application
    public-routes.mjs   Register, sign in, book, cancel, withdraw
    admin-routes.mjs    The dashboard
    schema.mjs          The database schema, one statement per entry
    http.mjs            JSON, cookies, admin sessions, rate limiting, CSV
    tokens.mjs          Signed participant sign-in tokens
public/
  index.html  app.js    Participant site
  admin.html  admin.js  Lab dashboard
  admin-login.html  admin-login.js
  privacy.html          How the lab handles participant data
  styles.css
scripts/                Command-line tools listed above
```

Personal data lives in the `participants` table and nowhere else. Every other
table refers to a participant by integer id. That is deliberate: the data
inventory in the DPDP note has one table to point at, and an erasure request is
satisfied by clearing the identifying columns of a single row while the record
of which sessions ran survives in anonymous form.

## Deployment

See `DEPLOY.md`.

## Open items

These need a decision from the department before the pool opens to real
participants. They are the software half of the open items in section 12 of the
Lab Operations Manual.

1. **The consent text on the registration form and the privacy notice are
   drafts** and carry a "Draft" banner. They issue in final form with the RCEC
   approval for the pool. The version string recorded against each registration
   is set in the dashboard under Pool rules.
2. **Pool registration is closed** on the deployed site, so nobody can enter
   personal data into a system whose consent text is not approved. One toggle
   in Pool rules opens it.
3. **The two seeded studies carry the reference `RCEC/2026/DRY-RUN`.** They
   exist to rehearse the flow. Delete them before real recruitment opens:
   `npm run db:teardown -- yes`.
4. **The lab email address** for erasure, correction and access requests does
   not exist yet. The privacy notice says so rather than giving an address that
   bounces.
5. **The Data Fiduciary** under the DPDP Act 2023 has not been designated. The
   privacy notice says so.
6. **The retention period** for a pool record after a participant's last session
   is set by the data management plan and is not yet fixed.
7. **The pool rule figures are the working defaults** from the Lab Operations
   Manual: 30 days between studies, suspension after 2 no-shows, 120 days,
   20 per cent buffer. The Participant pool and operations pack settles them.
   All four are editable in the dashboard without a redeployment.
8. **Reminders are not sent by this system.** SOP 5 asks for a confirmation at
   booking, a reminder 24 hours before and one on the morning of the session.
   The roster export carries the phone numbers to send them from; automating it
   needs an SMS or email route the department has approved.
9. **Participant sign-in is email plus mobile**, with no password. If the
   department wants a stronger check, a one-time code to the mobile number is
   the natural next step and needs an SMS route.

## Provenance and reuse

Written by Aayush Agarwal in August 2026, as part of a consultancy engagement
with the Department of Economics, CHRIST (Deemed to be University), Bangalore
Yeshwanthpur Campus. It is published so that it can be linked from the handover
documentation and read by whoever maintains it next.

The operational rules it implements come from the lab's own Lab Operations
Manual, which is not published here. If you want to run this for another lab,
the file to read and change first is `api/_lib/rules.mjs`: every rule is a pure
function in that one file, and `npm run check` will tell you what you broke.
Please get in touch before reusing it for a lab at another institution, since
the consent text, the privacy notice and the ethics gate are written against
one committee's requirements and would be wrong somewhere else.
