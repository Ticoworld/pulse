/**
 * Phase 2 CLI: one-shot Bags enrichment. Thin wrapper over shared runner.
 *
 * Usage:
 *   npm run bags:enrich -- [options]
 *   --limit N          max mints to process (default 25)
 *   --mint ADDRESS     enrich only this mint (must exist in launch_candidates)
 *   --force            with --mint: run even if mint does not currently need enrichment
 *   --since-hours H    only candidates created in last H hours (default 168 = 7 days)
 *   --dry-run          no Bags client init, no Bags calls, no DB writes
 */

import "dotenv/config";

import { runEnrichment, DEFAULT_LIMIT, DEFAULT_SINCE_HOURS } from "@pulse/bags-enricher";

const LOG_PREFIX = "[bags-enrich]";

function parseArgs(): { limit: number; mint: string | null; sinceHours: number; dryRun: boolean; force: boolean } {
  const args = process.argv.slice(2);
  let limit = DEFAULT_LIMIT;
  let mint: string | null = null;
  let sinceHours = DEFAULT_SINCE_HOURS;
  let dryRun = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10) || DEFAULT_LIMIT;
      i++;
    } else if (args[i] === "--mint" && args[i + 1]) {
      mint = args[i + 1].trim();
      i++;
    } else if (args[i] === "--force") {
      force = true;
    } else if (args[i] === "--since-hours" && args[i + 1]) {
      sinceHours = parseInt(args[i + 1], 10) || DEFAULT_SINCE_HOURS;
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { limit, mint, sinceHours, dryRun, force };
}

async function main(): Promise<void> {
  const { limit, mint, sinceHours, dryRun, force } = parseArgs();

  try {
    const result = await runEnrichment({
      limit,
      sinceHours,
      mint,
      force,
      dryRun,
      logPrefix: LOG_PREFIX,
    });

    if (result.stopReason === "auth") {
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("does not currently need enrichment")) {
      console.log(LOG_PREFIX, msg);
      process.exit(0);
    }
    console.error(LOG_PREFIX, "fatal:", e);
    process.exit(1);
  }
}

main();
