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

The Vercel project deploys from this repository. **Whatever is on `main` is the
live site.** A push to `main` goes to production on its own, usually within a
minute, and `main` is not protected, so there is no review step in between.

```bash
npm run check
git push origin main
```

Nothing runs `npm run check` for you. Run it before every push to `main`. The
pool rules fail silently, so a change that breaks one of them looks completely
normal on screen and goes live anyway.

A push to any other branch gets its own preview URL, which Vercel posts on the
commit in GitHub.

**Previews use the live database.** There is no separate test database, so a
registration, a booking or an attendance mark made on a preview URL is a real
row in the live participant pool, next to real people's records. Either look at
previews without submitting forms, or use obviously fake details and erase the
record from the dashboard (Participant register, Open, Erase personal data)
before you finish.

### Who can deploy

The Vercel project is on a Hobby plan and this repository is private. On that
combination, Vercel only deploys commits whose author is the owner of the Vercel
account. A collaborator can push to `main` and the code will be on GitHub, but
Vercel will block the deployment and the live site will not change. See Vercel's
[Troubleshoot project collaboration](https://vercel.com/docs/deployments/troubleshoot-project-collaboration).

There are two ways round it:

- Make this repository public (`gh repo edit --visibility public
  --accept-visibility-change-consequences`). Vercel does not restrict
  collaboration on public repositories. No credentials are in the repository,
  so nothing secret becomes visible.
- Move the project to a Vercel Pro team and add each maintainer as a team member.
  This is a paid plan.

Whoever commits also needs the email in `git config user.email` to be a verified
email on their GitHub account, or Vercel cannot tell who wrote the commit and
blocks it regardless of plan.

### Deploying without Git

The account owner can still deploy the local folder directly, which bypasses
GitHub entirely. Use this only in an emergency, because the live site then stops
matching `main` until the next push.

```bash
npx vercel --prod
```

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

- The schema is applied.
- **Pool registration is open**, as of 31 August 2026. The consent text is still
  the draft, so every registration carries the consent version
  `v1 (draft, pending RCEC)`. Keep that string on existing records: it is how
  the people who registered before approval can be found and re-consented if the
  committee changes the wording.
- Two studies are seeded, both carrying the reference `RCEC/2026/DRY-RUN`, with
  four session times each. They exist so the flow can be rehearsed end to end,
  and they are open, so a real registrant can book onto one.
  **Close or delete them before real recruitment opens.**

## Before real recruitment

Registration is already open, so real participants may be on the register. None
of these steps may use `db:teardown`, which deletes them.

1. Settle the consent text and the privacy notice against the RCEC approval for
   the pool, then update `public/privacy.html`, the consent paragraph in
   `public/index.html`, and the version string under **Pool rules**.
2. Set both dry-run studies to **Closed** in the dashboard under Studies and
   sessions. A study with people booked on it cannot be deleted, and closing it
   keeps the record of who booked.
3. Create the real study with its real RCEC reference. The dashboard will not
   let it be opened for sign-up without one.
4. Confirm the four pool rule figures under **Pool rules** against the
   Participant pool and operations pack.

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

**Registration is open, so this now deletes real participants' records.** It
exists for clearing a rehearsal before a pool goes live. Do not run it against
the live database. To remove one person, use Erase personal data on their record
in the dashboard, which is what the privacy notice promises them.

## The one thing that will bite

The site is public with nothing in front of it, as the four demo stations are.
Anyone with the URL can see the studies and, once registration is open, can
register. That is the intended design for a recruitment drive, but it means the
URL should not be circulated before step 5 above is done. The dashboard is
behind the password; the participant site is not.
