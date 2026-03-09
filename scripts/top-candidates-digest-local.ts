/**
 * Local proof for /top_candidates: fetches HIGH_INTEREST digest and prints formatted output.
 * Run: npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/top-candidates-digest-local.ts
 * Does not send Telegram messages.
 */
import "dotenv/config";
import { getTopCandidateSignalsForDigest, HIGH_INTEREST_THRESHOLD } from "@pulse/db";
import { formatTopCandidatesDigest } from "../apps/tg-bot/src/formatters";

const LIMIT = 10;
const FRESHNESS_HOURS = 24;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const rows = await getTopCandidateSignalsForDigest(LIMIT, FRESHNESS_HOURS, HIGH_INTEREST_THRESHOLD);
  const alert = formatTopCandidatesDigest(
    rows.map((r) => ({
      mint: r.mint,
      score: r.score,
      metadata: r.metadata,
      alpha_wallet_trigger: r.alpha_wallet_trigger,
      liquidity_live_trigger: r.liquidity_live_trigger,
      dev_trigger: r.dev_trigger,
      primary_creator_display_name: r.primary_creator_display_name,
      primary_creator_provider: r.primary_creator_provider,
      fees_lamports: r.fees_lamports,
    })),
    { title: "Top HIGH_INTEREST candidates", freshnessHours: FRESHNESS_HOURS },
  );

  console.log("--- /top_candidates digest (HIGH_INTEREST only, local, no Telegram) ---\n");
  console.log(alert.text);
  console.log("\n--- end ---");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
