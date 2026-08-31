// What is actually in the database right now.
import { neon } from "@neondatabase/serverless";
import { requireEnv } from "./_env.mjs";
import { formatStamp } from "../api/_lib/rules.mjs";

const sql = neon(requireEnv("DATABASE_URL"));

const [pool] = await sql`
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status = 'active')::int    AS active,
    COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
    COUNT(*) FILTER (WHERE status = 'withdrawn')::int AS withdrawn,
    COUNT(*) FILTER (WHERE erased_at IS NOT NULL)::int AS erased
  FROM participants`;
const studies  = await sql`SELECT code, title, status, rcec_reference FROM studies ORDER BY id`;
const [book]   = await sql`
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE status = 'booked')::int    AS booked,
    COUNT(*) FILTER (WHERE status = 'attended')::int  AS attended,
    COUNT(*) FILTER (WHERE status = 'no_show')::int   AS no_shows,
    COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
  FROM bookings`;
const [rules]  = await sql`SELECT * FROM pool_rules WHERE id = 1`;
const [latest] = await sql`SELECT action, detail, created_at FROM activity_log ORDER BY id DESC LIMIT 1`;

console.log(`\nParticipants  ${pool.total} on the register`);
console.log(`              ${pool.active} active, ${pool.suspended} paused, ${pool.withdrawn} withdrawn, ${pool.erased} erased`);
console.log(`\nStudies       ${studies.length}`);
for (const s of studies) {
  const ethics = s.rcec_reference || "NO ETHICS REFERENCE";
  console.log(`              ${s.code.padEnd(10)} ${s.status.padEnd(7)} ${ethics.padEnd(22)} ${s.title}`);
}
console.log(`\nBookings      ${book.total} total`);
console.log(`              ${book.booked} holding a seat, ${book.attended} attended, ${book.no_shows} no-shows, ${book.cancelled} cancelled`);
console.log(`\nPool rules    ${rules.min_days_between_studies} days between studies, suspension after ${rules.no_shows_before_suspension} no-shows for ${rules.suspension_days} days`);
console.log(`              buffer ${rules.default_buffer_percent} per cent, registration ${rules.pool_open ? "open" : "closed"}, consent ${rules.consent_version}`);
console.log(`\nLast action   ${latest ? `${formatStamp(latest.created_at)}  ${latest.action}  ${latest.detail}` : "none"}\n`);

// A live study with no ethics reference would be a governance failure, so it is
// reported here rather than left for somebody to notice on the dashboard.
const unapproved = studies.filter((s) => s.status === "open" && !s.rcec_reference.trim());
if (unapproved.length > 0) {
  console.log(`WARNING: ${unapproved.length} study is open with no ethics reference: ${unapproved.map((s) => s.code).join(", ")}\n`);
}
