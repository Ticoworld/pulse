/**
 * Phase 10A: Supabase (or any Postgres) connectivity smoke test.
 * Verifies DATABASE_URL, key tables exist, and one safe write/read/delete via a temp table.
 *
 * Run: npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/supabase-smoke.ts
 * Requires: DATABASE_URL
 * Exit: 0 on success, non-zero on failure.
 */
import "dotenv/config";
import { Client } from "pg";

const REQUIRED_TABLES = [
  "signals",
  "launch_candidates",
  "bags_token_enrichments",
  "bags_token_creators",
  "telegram_users",
  "telegram_command_events",
  "telegram_user_mint_follows",
  "telegram_signal_deliveries",
];

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("[supabase-smoke] DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log("[supabase-smoke] connected");
  } catch (e) {
    console.error("[supabase-smoke] connect failed:", e);
    process.exit(1);
  }

  try {
    for (const table of REQUIRED_TABLES) {
      const r = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      if (r.rowCount === 0 || r.rows.length === 0) {
        console.error("[supabase-smoke] missing table: " + table);
        process.exit(1);
      }
      console.log("[supabase-smoke] table ok: " + table);
    }

    // Safe write/read/delete using a session-scoped temp table (no migration needed)
    await client.query(`
      CREATE TEMP TABLE pulse_smoke_probe (id serial PRIMARY KEY, created_at timestamptz DEFAULT now());
    `);
    const insert = await client.query("INSERT INTO pulse_smoke_probe DEFAULT VALUES RETURNING id, created_at");
    const id = insert.rows[0]?.id;
    if (id == null) {
      console.error("[supabase-smoke] probe insert failed");
      process.exit(1);
    }
    const sel = await client.query("SELECT id, created_at FROM pulse_smoke_probe WHERE id = $1", [id]);
    if (sel.rows.length === 0) {
      console.error("[supabase-smoke] probe read failed");
      process.exit(1);
    }
    await client.query("DELETE FROM pulse_smoke_probe WHERE id = $1", [id]);
    console.log("[supabase-smoke] write/read/delete probe ok");

    console.log("[supabase-smoke] success");
  } catch (e) {
    console.error("[supabase-smoke] failed:", e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
