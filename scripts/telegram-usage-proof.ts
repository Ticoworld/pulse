/**
 * Proof helper for Telegram usage activity.
 * Run:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/telegram-usage-proof.ts
 */
import "dotenv/config";
import { getTelegramUsageMetrics, listTopTelegramCommands } from "@pulse/db";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const metrics = await getTelegramUsageMetrics(24);
  const topCommands = await listTopTelegramCommands(24, 10);

  console.log("[telegram-usage-proof] unique_users_last_24h=" + metrics.uniqueUsers);
  console.log(
    "[telegram-usage-proof] command_events_last_24h=" + metrics.totalCommandEvents,
  );
  console.log("[telegram-usage-proof] top_commands_last_24h:");

  if (topCommands.length === 0) {
    console.log("  (none)");
    return;
  }

  topCommands.forEach((row, index) => {
    console.log(`  ${index + 1}. ${row.command} -> ${row.count}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
