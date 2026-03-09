/**
 * Phase 10A: Repeatable migration runner.
 * Applies SQL files from packages/db/src/migrations in sorted order.
 * Uses schema_migrations table to skip already-applied files. Fails on first error.
 *
 * Run: npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/apply-db-migrations.ts
 * Requires: DATABASE_URL
 */
import "dotenv/config";
import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS_DIR = path.join(
  __dirname,
  "../packages/db/src/migrations",
);

const SCHEMA_MIGRATIONS_BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz DEFAULT now()
);
`;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (e) {
    console.error("Failed to connect:", e);
    process.exit(1);
  }

  try {
    await client.query(SCHEMA_MIGRATIONS_BOOTSTRAP);
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort();
    for (const filename of files) {
      const { rows } = await client.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (rows.length > 0) {
        console.log("[skip] " + filename);
        continue;
      }
      console.log("[apply] " + filename);
      const sqlPath = path.join(MIGRATIONS_DIR, filename);
      const sql = fs.readFileSync(sqlPath, "utf-8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
      console.log("[done]  " + filename);
    }
    console.log("Migrations complete.");
  } catch (e) {
    console.error("Migration failed:", e);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
