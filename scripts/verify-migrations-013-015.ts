/**
 * One-off: verify migrations 013, 014, 015 are applied.
 * Run: npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/verify-migrations-013-015.ts
 * Output: raw query results to stdout.
 */
import "dotenv/config";
import { query } from "@pulse/db";

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set");
    process.exit(1);
  }

  console.log("--- Query 1: bags_token_enrichments table exists ---");
  const q1 = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bags_token_enrichments'`
  );
  console.log("rows:", q1.rowCount, "data:", JSON.stringify(q1.rows));

  console.log("\n--- Query 2: bags_token_creators table exists ---");
  const q2 = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bags_token_creators'`
  );
  console.log("rows:", q2.rowCount, "data:", JSON.stringify(q2.rows));

  console.log("\n--- Query 3: creators_next_retry_at, fees_next_retry_at on bags_token_enrichments ---");
  const q3 = await query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bags_token_enrichments' AND column_name IN ('creators_next_retry_at', 'fees_next_retry_at') ORDER BY column_name`
  );
  console.log("rows:", q3.rowCount, "data:", JSON.stringify(q3.rows));

  console.log("\n--- Query 4: partial unique index for BAGS_ENRICHMENT_RESOLVED on signals(token_mint) ---");
  const q4 = await query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'signals' AND indexdef LIKE '%BAGS_ENRICHMENT_RESOLVED%'`
  );
  console.log("rows:", q4.rowCount, "data:", JSON.stringify(q4.rows, null, 2));

  console.log("\n--- Done ---");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
