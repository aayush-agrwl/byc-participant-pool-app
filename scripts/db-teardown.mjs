// Clear every row while leaving the tables in place. Used after a dry run.
// Requires the word "yes" as an argument so it cannot be triggered by an
// accidental npm script.
import { neon } from "@neondatabase/serverless";
import { requireEnv } from "./_env.mjs";

if (process.argv[2] !== "yes") {
  console.error("This deletes every participant, study, session and booking.");
  console.error("Run it as: npm run db:teardown -- yes");
  process.exit(1);
}

const sql = neon(requireEnv("DATABASE_URL"));
const [before] = await sql`SELECT COUNT(*)::int AS n FROM participants`;

await sql`TRUNCATE bookings, sessions, studies, participants, activity_log RESTART IDENTITY CASCADE`;
await sql`UPDATE pool_rules SET updated_at = NOW() WHERE id = 1`;

console.log(`Cleared. ${before.n} participant records were removed. Pool rules kept.`);
