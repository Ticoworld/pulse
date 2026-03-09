# Phase 3 sign-off handoff — Bags enricher lifecycle patch

**For PM review.** Please paste back sign-off when done.

---

## Summary

Phase 3 lifecycle flaw is fixed: **SIGINT/SIGTERM during the between-cycle sleep now exits promptly** instead of waiting for the full interval. Sleep is interruptible via a shared `createInterruptibleSleep()` helper; the shutdown handler calls `wake()` so the sleep Promise resolves immediately. Current-cycle semantics unchanged: if shutdown arrives during a cycle, we finish the cycle then exit; if during sleep, we exit right after wake. Single exit path, no duplicate timers.

---

## 1. Patched service entrypoint

**File:** `services/bags-enricher/src/index.ts`

```typescript
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
```

---

## 2. Shared runner module

**File:** `packages/bags-enricher/src/runner.ts`

```typescript
import { getBagsClient, isBagsClientError } from "@pulse/bags";
import {
  getLaunchCandidatesNeedingEnrichment,
  getLaunchCandidateByMint,
  getLaunchCandidateMintNeedingEnrichment,
  getBagsEnrichmentByMint,
  upsertBagsEnrichment,
  replaceBagsCreatorsForMint,
} from "@pulse/db";
import {
  CREATORS_TTL_HOURS,
  FEES_TTL_MINUTES,
  DEFAULT_LIMIT,
  DEFAULT_SINCE_HOURS,
  type EnrichmentRunOptions,
  type EnrichmentRunResult,
  type EnrichmentStopReason,
} from "./types";

function isAuthError(e: unknown): boolean {
  if (!isBagsClientError(e)) return false;
  return e.code === "BAGS_AUTH" || e.code === "BAGS_FORBIDDEN";
}

function isStopCleanly(e: unknown): boolean {
  if (!isBagsClientError(e)) return false;
  return e.code === "BAGS_LOCAL_SOFT_CAP" || e.code === "BAGS_RATE_LIMIT";
}

/**
 * Run one enrichment cycle: select candidates, then for each mint run side-aware
 * Bags calls and persist. Returns stop reason and counts; does not exit process.
 */
export async function runEnrichment(opts: EnrichmentRunOptions = {}): Promise<EnrichmentRunResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
  const singleMint = opts.mint ?? null;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  const creatorsTtlHours = opts.creatorsTtlHours ?? CREATORS_TTL_HOURS;
  const feesTtlMinutes = opts.feesTtlMinutes ?? FEES_TTL_MINUTES;
  const logPrefix = opts.logPrefix ?? "[bags-enrich]";

  let candidates: { mint: string; liquidity_live_at: Date | null; created_at?: Date; needs_creators: boolean; needs_fees: boolean }[];

  if (singleMint) {
    const inTable = await getLaunchCandidateByMint(singleMint);
    if (!inTable) {
      throw new Error(`mint not in launch_candidates: ${singleMint}`);
    }
    const candidate = await getLaunchCandidateMintNeedingEnrichment(singleMint, {
      creatorsTtlHours,
      feesTtlMinutes,
      force,
    });
    if (!candidate) {
      throw new Error(`mint does not currently need enrichment (use force): ${singleMint}`);
    }
    candidates = [{
      mint: candidate.mint,
      liquidity_live_at: candidate.liquidity_live_at,
      needs_creators: candidate.needs_creators,
      needs_fees: candidate.needs_fees,
    }];
  } else {
    candidates = await getLaunchCandidatesNeedingEnrichment({
      limit,
      sinceHours,
      creatorsTtlHours,
      feesTtlMinutes,
    });
  }

  if (candidates.length === 0) {
    console.log(logPrefix, "no candidates needing enrichment");
    return { stopReason: null, processedCount: 0, candidateCount: 0 };
  }

  console.log(logPrefix, "mints to process:", candidates.length);

  if (dryRun) {
    console.log(logPrefix, "DRY RUN — no Bags client, no Bags calls, no DB writes");
    for (const c of candidates) {
      console.log(logPrefix, "mint=" + c.mint + " needsCreators=" + c.needs_creators + " needsFees=" + c.needs_fees);
    }
    console.log(logPrefix, "finished");
    return { stopReason: null, processedCount: candidates.length, candidateCount: candidates.length };
  }

  const client = getBagsClient();
  const retryBackoffMs = 60 * 60 * 1000; // 1 hour
  let processedCount = 0;
  let stopReason: EnrichmentStopReason = null;

  for (const c of candidates) {
    const { mint, needs_creators, needs_fees } = c;
    const attempted: string[] = [];
    if (needs_creators) attempted.push("creators");
    if (needs_fees) attempted.push("fees");
    console.log(logPrefix, "mint=" + mint + " needsCreators=" + needs_creators + " needsFees=" + needs_fees);
    console.log(logPrefix, "attempted: " + (attempted.length ? attempted.join(",") : "none"));

    const existing = await getBagsEnrichmentByMint(mint);
    const hasCreators = existing != null && existing.creators_fetched_at != null;
    const hasFees = existing != null && existing.fees_fetched_at != null;

    let creatorsOk = false;
    let feesOk = false;
    let creatorsCount: number | null = existing?.creators_count ?? null;
    let primaryCreatorWallet: string | null = existing?.primary_creator_wallet ?? null;
    let primaryCreatorDisplayName: string | null = existing?.primary_creator_display_name ?? null;
    let primaryCreatorProvider: string | null = existing?.primary_creator_provider ?? null;
    let primaryCreatorRoyaltyBps: number | null = existing?.primary_creator_royalty_bps ?? null;
    let feesLamports: number | null = existing?.fees_lamports != null ? Number(existing.fees_lamports) : null;
    let creators: Array<{ wallet: string; isCreator: boolean; displayName: string | null; provider: string | null; pfp: string | null; royaltyBps: number }> = [];
    let creatorsFetchedAt: Date | null = existing?.creators_fetched_at ?? null;
    let feesFetchedAt: Date | null = existing?.fees_fetched_at ?? null;
    let creatorsNextRetryAt: Date | null = existing?.creators_next_retry_at ?? null;
    let feesNextRetryAt: Date | null = existing?.fees_next_retry_at ?? null;
    let lastErrorCode: string | null = existing?.last_error_code ?? null;
    let lastErrorStatus: number | null = existing?.last_error_status ?? null;
    let lastErrorMessage: string | null = existing?.last_error_message ?? null;

    if (needs_creators) {
      const creatorsResult = await client.getTokenCreators(mint);
      if (isAuthError(creatorsResult)) {
        console.error(logPrefix, "auth error, stopping:", (creatorsResult as { message: string }).message);
        return { stopReason: "auth", processedCount, candidateCount: candidates.length };
      }
      if (isStopCleanly(creatorsResult)) {
        console.error(logPrefix, "stop (local soft cap or Bags 429):", (creatorsResult as { message: string }).message);
        stopReason = isBagsClientError(creatorsResult) && creatorsResult.code === "BAGS_RATE_LIMIT" ? "rate_limit" : "soft_cap";
        return { stopReason, processedCount, candidateCount: candidates.length };
      }
      if (isBagsClientError(creatorsResult)) {
        lastErrorCode = creatorsResult.code;
        if ("status" in creatorsResult && creatorsResult.status != null) lastErrorStatus = creatorsResult.status;
        lastErrorMessage = creatorsResult.message;
        creatorsNextRetryAt = new Date(Date.now() + retryBackoffMs);
        console.warn(logPrefix, "creators failed for", mint, creatorsResult.code, creatorsResult.message);
      } else {
        creatorsOk = true;
        creatorsFetchedAt = new Date();
        creatorsNextRetryAt = null;
        creatorsCount = creatorsResult.creators.length;
        if (creatorsResult.primaryCreator) {
          primaryCreatorWallet = creatorsResult.primaryCreator.wallet;
          primaryCreatorDisplayName = creatorsResult.primaryCreator.displayName ?? null;
          primaryCreatorProvider = creatorsResult.primaryCreator.provider ?? null;
          primaryCreatorRoyaltyBps = creatorsResult.primaryCreator.royaltyBps;
        }
        creators = creatorsResult.creators.map((cr) => ({
          wallet: cr.wallet,
          isCreator: cr.isCreator,
          displayName: cr.displayName ?? null,
          provider: cr.provider ?? null,
          pfp: cr.pfp ?? null,
          royaltyBps: cr.royaltyBps,
        }));
      }
    }

    if (needs_fees) {
      const feesResult = await client.getTokenLifetimeFees(mint);
      if (isAuthError(feesResult)) {
        console.error(logPrefix, "auth error, stopping:", (feesResult as { message: string }).message);
        return { stopReason: "auth", processedCount, candidateCount: candidates.length };
      }
      if (isStopCleanly(feesResult)) {
        console.error(logPrefix, "stop (local soft cap or Bags 429):", (feesResult as { message: string }).message);
        stopReason = isBagsClientError(feesResult) && feesResult.code === "BAGS_RATE_LIMIT" ? "rate_limit" : "soft_cap";
        return { stopReason, processedCount, candidateCount: candidates.length };
      }
      if (isBagsClientError(feesResult)) {
        lastErrorCode = feesResult.code;
        if ("status" in feesResult && feesResult.status != null) lastErrorStatus = feesResult.status;
        lastErrorMessage = feesResult.message;
        feesNextRetryAt = new Date(Date.now() + retryBackoffMs);
        console.warn(logPrefix, "fees failed for", mint, feesResult.code);
      } else {
        feesOk = true;
        feesFetchedAt = new Date();
        feesNextRetryAt = null;
        feesLamports = feesResult.feesLamports;
      }
    }

    const attemptedCreators = needs_creators;
    const attemptedFees = needs_fees;
    const bothOk = (attemptedCreators ? creatorsOk : hasCreators) && (attemptedFees ? feesOk : hasFees);
    if (bothOk) {
      lastErrorCode = null;
      lastErrorStatus = null;
      lastErrorMessage = null;
    }
    const anyOk = (attemptedCreators ? creatorsOk : hasCreators) || (attemptedFees ? feesOk : hasFees);
    const anyAttemptedFailed = (attemptedCreators && !creatorsOk) || (attemptedFees && !feesOk);
    const status =
      bothOk ? "resolved"
        : anyOk ? "partial"
          : anyAttemptedFailed ? "error"
            : "pending";

    await upsertBagsEnrichment({
      mint,
      enrichmentStatus: status,
      creatorsFetchedAt,
      feesFetchedAt,
      creatorsCount,
      primaryCreatorWallet,
      primaryCreatorDisplayName,
      primaryCreatorProvider,
      primaryCreatorRoyaltyBps,
      feesLamports,
      lastErrorCode: lastErrorCode ?? undefined,
      lastErrorStatus: lastErrorStatus ?? undefined,
      lastErrorMessage: lastErrorMessage ?? undefined,
      nextRetryAt: status === "error" ? new Date(Date.now() + retryBackoffMs) : null,
      creatorsNextRetryAt: creatorsNextRetryAt ?? undefined,
      feesNextRetryAt: feesNextRetryAt ?? undefined,
    });

    if (attemptedCreators && creatorsOk) {
      await replaceBagsCreatorsForMint(mint, creators);
    }

    processedCount++;
    console.log(logPrefix, "done mint=" + mint + " status=" + status);
  }

  console.log(logPrefix, "finished");
  return { stopReason: null, processedCount, candidateCount: candidates.length };
}
```

Types and package export: `packages/bags-enricher/src/types.ts` (EnrichmentRunOptions, EnrichmentRunResult, EnrichmentStopReason, constants); `packages/bags-enricher/src/index.ts` re-exports `runEnrichment` and those types.

---

## 3. Terminal output — shutdown during sleep

**How to reproduce:**  
`BAGS_ENRICHER_INTERVAL_MINUTES=1 npm run bags:enricher` → wait for `[bags-enricher] sleeping 60s until next cycle` → press **Ctrl+C**.

**Expected (paste your actual run below if you have it):**

```
[bags-enricher] starting; interval_ms=60000 limit=25 since_hours=168
[bags-enricher] cycle start
... (cycle output or cycle error) ...
[bags-enricher] sleeping 60s until next cycle
[bags-enricher] shutdown requested
[bags-enricher] shutdown complete (during sleep, exited promptly)
```

Process should exit within a couple of seconds, not after 60s. Automated check: `node scripts/test-bags-enricher-shutdown-during-sleep.mjs` (confirms prompt exit; on Windows the two shutdown lines may not appear when run as child).

---

## Command to run the service

```bash
npm run bags:enricher
```

Optional env: `BAGS_ENRICHER_INTERVAL_MINUTES`, `BAGS_ENRICHER_LIMIT`, `BAGS_ENRICHER_SINCE_HOURS` (see BAGS_ENRICHMENT_SERVICE_PHASE3.md).

---

**Review checkpoint:** Please confirm (1) patched entrypoint, (2) shared runner, (3) terminal output proving prompt shutdown during sleep, then sign off Phase 3.
