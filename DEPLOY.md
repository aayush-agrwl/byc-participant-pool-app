# Deployment and handover

## Where it lives

| | |
|---|---|
| Live site | <https://byc-participant-pool.vercel.app> |
| Dashboard | <https://byc-participant-pool.vercel.app/admin> |
| Hosting | Vercel, functions pinned to `sin1` (Singapore) in `vercel.json` |
| Database | Neon serverless Postgres, region `ap-southeast-1` (Singapore) |

The project names, the account they sit on, the database endpoint and the
credentials are **not in this repository**. They are in the handover note held
by the department, alongside the dashboard password. This repository is public
so that it can be linked from the handover document, and naming the host of a
database that holds participant personal data on a public page would be a free
hint to anyone who went looking.

The function region and the database region are deliberately the same. If the
database is ever moved, change `regions` in `vercel.json` at the same time or
every page load crosses an ocean.

The pool has a **Neon project of its own**, separate from any other work. That
is on purpose: this database holds real participant personal data under the
DPDP Act and should not share a lifecycle with anything that gets torn down.

## Shipping a change

```bash
npm run check
npx vercel --prod
```

Run `npm run check` first. The pool rules fail silently, so a change that breaks
one of them looks completely normal on screen.

The Vercel CLI token expires periodically. When `vercel whoami` reports an
invalid token, run `npx vercel login` yourself: it is an interactive browser
sign-in.

## Environment variables

Set on Production and Preview in the Vercel project. The same three values are
in `.env.local` for local work, which is gitignored and vercelignored.

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string. The unpooled one will exhaust connections under a recruitment drive |
| `ADMIN_PASSWORD` | The dashboard password. Changing it signs every dashboard user out |
| `SESSION_SECRET` | Signs participant sign-in tokens. Rotating it signs every participant out mid-session |

To change the dashboard password:

```bash
npx vercel env rm ADMIN_PASSWORD production
npx vercel env add ADMIN_PASSWORD production
npx vercel --prod
```

The new value takes effect on the next deployment, not before.

## The state it was handed over in

- The schema is applied and the database is otherwise empty.
- **Pool registration is closed.** Nobody can enter personal data into a system
  whose consent text has not been approved. Open it from the dashboard under
  **Pool rules**, by ticking "The pool is open for new registrations" and saving.
- Two studies are seeded, both carrying the reference `RCEC/2026/DRY-RUN`, with
  four session times each. They exist so the flow can be rehearsed end to end.
  **Delete them before real recruitment opens.**

## Before the pool opens to real participants

1. Settle the consent text and the privacy notice against the RCEC approval for
   the pool, then update `public/privacy.html`, the consent paragraph in
   `public/index.html`, and the version string under **Pool rules**.
2. Clear the dry-run data: `npm run db:teardown -- yes`.
3. Create the real study with its real RCEC reference. The dashboard will not
   let it be opened for sign-up without one.
4. Confirm the four pool rule figures under **Pool rules** against the
   Participant pool and operations pack.
5. Open registration.

## Checking on it

```bash
npm run db:status
```

Prints the pool size, the studies and their ethics references, the booking
counts and the current rules. It warns if any study is open for sign-up without
an ethics reference, which would be a governance failure rather than a bug.

## Clearing everything

```bash
npm run db:teardown -- yes
```

Deletes every participant, study, session and booking, and keeps the pool rules.
The `yes` is required so it cannot be triggered by a mistyped script name.

## The one thing that will bite

The site is public with nothing in front of it, as the four demo stations are.
Anyone with the URL can see the studies and, once registration is open, can
register. That is the intended design for a recruitment drive, but it means the
URL should not be circulated before step 5 above is done. The dashboard is
behind the password; the participant site is not.
