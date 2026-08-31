import { neon } from "@neondatabase/serverless";
import { statements } from "../api/_lib/schema.mjs";
import { requireEnv } from "./_env.mjs";

const sql = neon(requireEnv("DATABASE_URL"));

console.log(`Applying ${statements.length} schema statements.`);
for (const [i, statement] of statements.entries()) {
  const label = statement.trim().split("\n")[0].slice(0, 70);
  try {
    await sql.query(statement);
    console.log(`  ${String(i + 1).padStart(2)}. ok    ${label}`);
  } catch (error) {
    console.error(`  ${String(i + 1).padStart(2)}. FAIL  ${label}`);
    console.error(`      ${error.message}`);
    process.exit(1);
  }
}
console.log("Schema is up to date.");
