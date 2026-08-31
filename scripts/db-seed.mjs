// Two studies and a set of session times, for a dry run against the real
// system. Everything it writes is removed by `npm run db:teardown -- yes`.
import { neon } from "@neondatabase/serverless";
import { requireEnv } from "./_env.mjs";
import { formatSessionTime } from "../api/_lib/rules.mjs";

const sql = neon(requireEnv("DATABASE_URL"));

const studies = [
  {
    code: "BRL-S01",
    title: "Decisions about risk and about waiting",
    summary: "You make a series of choices between a certain amount of money and a gamble, and between money today and more money later. Your payment depends on one of your own choices, drawn at random.",
    pi_name: "To be confirmed",
    rcec_reference: "RCEC/2026/DRY-RUN",
    incentive: "Rs 150 show-up, plus what you earn in the task",
    duration_minutes: 45,
    venue: "Behavioural Research Lab, Bangalore Yeshwanthpur Campus",
    status: "open",
    min_age: 18, max_age: 30, requires_student: true,
    declarations: JSON.stringify([
      "I have not taken part in a similar decision-making study in the past month.",
      "I will bring a photo ID card to the session.",
      "I can complete a task in English.",
    ]),
    buffer_percent: 20,
  },
  {
    code: "BRL-S02",
    title: "Trust and sharing in small groups",
    summary: "You are paired anonymously with another participant and decide how much to send and how much to return. Nobody learns who they were paired with, during the session or afterwards.",
    pi_name: "To be confirmed",
    rcec_reference: "RCEC/2026/DRY-RUN",
    incentive: "Rs 150 show-up, plus what you earn in the task",
    duration_minutes: 60,
    venue: "Behavioural Research Lab, Bangalore Yeshwanthpur Campus",
    status: "open",
    min_age: 18, max_age: 35, requires_student: false,
    declarations: JSON.stringify(["I will bring a photo ID card to the session."]),
    buffer_percent: 20,
  },
];

for (const s of studies) {
  const [row] = await sql`
    INSERT INTO studies (code, title, summary, pi_name, rcec_reference, incentive,
      duration_minutes, venue, status, min_age, max_age, requires_student,
      declarations, buffer_percent)
    VALUES (${s.code}, ${s.title}, ${s.summary}, ${s.pi_name}, ${s.rcec_reference},
      ${s.incentive}, ${s.duration_minutes}, ${s.venue}, ${s.status}, ${s.min_age},
      ${s.max_age}, ${s.requires_student}, ${s.declarations}, ${s.buffer_percent})
    ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title
    RETURNING id, code
  `;
  console.log(`Study ${row.code}`);

  // Four sessions over the coming fortnight, at times the lab actually runs.
  for (const [dayOffset, hour] of [[3, 10], [3, 14], [7, 11], [10, 15]]) {
    const when = new Date();
    when.setDate(when.getDate() + dayOffset);
    // The hour is a Bangalore wall-clock hour, so it is set through an
    // explicit offset rather than through the server's own timezone.
    const iso = `${when.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00+05:30`;
    const startsAt = new Date(iso);
    const [session] = await sql`
      INSERT INTO sessions (study_id, starts_at, capacity, location)
      VALUES (${row.id}, ${startsAt.toISOString()}, 8, ${s.venue})
      RETURNING id
    `;
    console.log(`  session ${session.id}: ${formatSessionTime(startsAt)}`);
  }
}
console.log("\nSeeded. Remove it all with: npm run db:teardown -- yes");
