/**
 * Phase 3: Long-running Bags enrichment service.
 * Runs enrichment cycles on a fixed interval; reuses Phase 2 runner.
 */

import "dotenv/config";

import { runEnrichment, DEFAULT_LIMIT, DEFAULT_SINCE_HOURS } from "@pulse/bags-enricher";

const LOG_PREFIX = "[bags-enricher]";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_LIMIT_PER_CYCLE = DEFAULT_LIMIT;

function getIntervalMs(): number {
  const env = process.env.BAGS_ENRICHER_INTERVAL_MINUTES;
  if (env == null || env === "") return DEFAULT_INTERVAL_MS;
  const min = parseInt(env, 10);
  if (!Number.isFinite(min) || min < 1) return DEFAULT_INTERVAL_MS;
  return min * 60 * 1000;
}

function getLimit(): number {
  const env = process.env.BAGS_ENRICHER_LIMIT;
  if (env == null || env === "") return DEFAULT_LIMIT_PER_CYCLE;
  const n = parseInt(env, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT_PER_CYCLE;
  return n;
}

function getSinceHours(): number {
  const env = process.env.BAGS_ENRICHER_SINCE_HOURS;
  if (env == null || env === "") return DEFAULT_SINCE_HOURS;
  const n = parseInt(env, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SINCE_HOURS;
  return n;
}

async function runCycle(): Promise<{ stopReason: string | null; processedCount: number; candidateCount: number }> {
  const result = await runEnrichment({
    limit: getLimit(),
    sinceHours: getSinceHours(),
    mint: null,
    force: false,
    dryRun: false,
    logPrefix: LOG_PREFIX,
  });
  return {
    stopReason: result.stopReason,
    processedCount: result.processedCount,
    candidateCount: result.candidateCount,
  };
}

/**
 * Interruptible sleep so SIGINT/SIGTERM during the between-cycle wait exit promptly.
 * Without this, the process would sit in setTimeout for up to the full interval before exiting.
 */
function createInterruptibleSleep(): { sleep: (ms: number) => Promise<void>; wake: () => void } {
  let wake: (() => void) | null = null;
  return {
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    },
    wake() {
      if (wake) wake();
    },
  };
}

async function main(): Promise<void> {
  const intervalMs = getIntervalMs();
  console.log(LOG_PREFIX, "starting; interval_ms=" + intervalMs + " limit=" + getLimit() + " since_hours=" + getSinceHours());

  let shutdown = false;
  const { sleep: interruptibleSleep, wake: wakeSleep } = createInterruptibleSleep();

  const shutdownHandler = (): void => {
    if (shutdown) return;
    shutdown = true;
    wakeSleep(); // so we don't wait the full interval if we're sleeping
    // stderr so shutdown log is visible when run as child (e.g. in tests)
    process.stderr.write(LOG_PREFIX + " shutdown requested\n");
  };
  process.on("SIGINT", shutdownHandler);
  process.on("SIGTERM", shutdownHandler);

  while (!shutdown) {
    const cycleStart = Date.now();
    try {
      console.log(LOG_PREFIX, "cycle start");
      const result = await runCycle();

      if (result.stopReason === "auth") {
        console.error(LOG_PREFIX, "auth error, exiting");
        process.exit(1);
      }

      console.log(
        LOG_PREFIX,
        "cycle end processed=" + result.processedCount + " candidates=" + result.candidateCount + " stopReason=" + (result.stopReason ?? "none")
      );

      if (result.stopReason === "soft_cap" || result.stopReason === "rate_limit") {
        console.log(LOG_PREFIX, "stopped cleanly (soft cap or 429), sleeping until next interval");
      }
    } catch (e) {
      console.error(LOG_PREFIX, "cycle error:", e);
    }

    if (shutdown) {
      process.stderr.write(LOG_PREFIX + " shutdown complete (after cycle)\n");
      setTimeout(() => process.exit(0), 50);
      return;
    }

    const elapsed = Date.now() - cycleStart;
    const sleepMs = Math.max(0, intervalMs - elapsed);
    console.log(LOG_PREFIX, "sleeping " + Math.round(sleepMs / 1000) + "s until next cycle");
    await interruptibleSleep(sleepMs);
    if (shutdown) {
      process.stderr.write(LOG_PREFIX + " shutdown complete (during sleep, exited promptly)\n");
      setTimeout(() => process.exit(0), 50);
      return;
    }
  }
}

main().catch((e) => {
  console.error(LOG_PREFIX, "fatal:", e);
  process.exit(1);
});
