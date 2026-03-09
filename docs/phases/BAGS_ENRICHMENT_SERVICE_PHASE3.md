# Bags enrichment service (Phase 3)

Long-running service that runs Bags enrichment cycles on a fixed interval so enrichment stays fresh for recent launch candidates. The service reuses the same Phase 2 runner logic as the CLI script; there is no duplicate code path.

---

## What the service does

- **Runs continuously** as a separate process (`services/bags-enricher`).
- **Polls on an interval** (default 5 minutes), selects due candidates via existing Phase 2 DB helpers, and enriches them sequentially with side-aware Bags calls.
- **Reuses Phase 2 logic** from `@pulse/bags-enricher`: selection, side-aware execution, stop conditions, and DB writes.
- **Logs** cycle start, cycle end, processed/candidate counts, and stop reason (none, soft_cap, rate_limit).
- **Stops the current cycle cleanly** on local soft cap or Bags 429, then **sleeps until the next interval** instead of crashing.
- **Exits hard (non-zero)** on 401 or 403 (auth/permissions).
- **Shuts down cleanly** on SIGINT/SIGTERM: if a cycle is running, it finishes that cycle then exits; if the process is in the between-cycle sleep, **sleep is interrupted** and the process exits promptly (no waiting for the full interval).

---

## What it does not do

- **No Telegram changes** — Phase 3 does not touch the bot.
- **No scoring changes** — The engine and candidate scoring are unchanged; enrichment data is not yet wired into signals.
- **No new API routes** — No HTTP API for enrichment.
- **No Redis or queue** — Sequential polling only; no distributed queue or Redis.
- **No parallel Bags fan-out** — One mint at a time, one or two calls per mint (side-aware).

---

## Interval and batch defaults

- **Interval:** 5 minutes (configurable via `BAGS_ENRICHER_INTERVAL_MINUTES`).
- **Limit per cycle:** 25 mints (configurable via `BAGS_ENRICHER_LIMIT`).
- **Since-hours:** 168 (7 days) for candidate selection (configurable via `BAGS_ENRICHER_SINCE_HOURS`).

Same TTL and retry semantics as Phase 2 (creators 24h, fees 15 min, per-field retry backoff).

---

## Stop behavior

- **Local soft cap (BAGS_LOCAL_SOFT_CAP):** Current cycle stops; service logs and sleeps until the next interval.
- **Bags 429 (BAGS_RATE_LIMIT):** Same — cycle stops, sleep until next interval.
- **401 / 403:** Service logs and **exits with non-zero** (auth broken).
- **Other per-mint errors:** Phase 2 logic persists error state and retry timestamps; service continues the cycle to the next mint.

---

## How it differs from the CLI script

| | CLI script | Service |
|---|------------|--------|
| **Runs** | One shot | Loops every N minutes |
| **Use case** | Manual run, dry-run, single mint, force | Automated background enrichment |
| **On soft cap / 429** | Exits 0 | Stops cycle, sleeps, then next cycle |
| **On 401/403** | Exits 1 | Exits 1 |
| **Core logic** | Same shared runner (`@pulse/bags-enricher`) | Same |

The CLI script (`npm run bags:enrich`) remains the way to do one-off runs, dry-runs, and single-mint or force runs. The service is for “keep enrichment fresh” in the background.

---

## Why this phase does not change scoring or Telegram

Phase 3 only **automates** enrichment. The schema and runner are already Phase 2; we do not yet wire `bags_token_enrichments` or `bags_token_creators` into the engine or the bot. That wiring is a later phase so that scoring and Telegram can consume Bags data consistently.

---

## Commands

**One-shot dry-run (CLI):**
```bash
npm run bags:enrich -- --dry-run
```

**One-shot real run (CLI):**
```bash
npm run bags:enrich -- --limit 5
```

**Long-running service:**
```bash
npm run bags:enricher
```

Optional env (service only):

- `BAGS_ENRICHER_INTERVAL_MINUTES` — minutes between cycles (default 5).
- `BAGS_ENRICHER_LIMIT` — max mints per cycle (default 25).
- `BAGS_ENRICHER_SINCE_HOURS` — only candidates created in last N hours (default 168).

The service uses the same `DATABASE_URL` and Bags env as the CLI (`BAGS_API_KEY`, etc.).

---

## Shutdown behavior (Phase 3 lifecycle patch)

Sleep between cycles is **interruptible**: on SIGINT/SIGTERM the handler calls `wake()`, so the sleep Promise resolves immediately and the process exits without waiting for the full interval.

**Manual verification (shutdown during sleep):**

1. Start the service with a 1-minute interval:  
   `BAGS_ENRICHER_INTERVAL_MINUTES=1 npm run bags:enricher`
2. Wait until you see `[bags-enricher] sleeping 60s until next cycle`.
3. Send SIGINT (Ctrl+C) or SIGTERM.
4. You should see `shutdown requested` and `shutdown complete (during sleep, exited promptly)` and the process should exit within a few seconds.

**Automated test:**  
`node scripts/test-bags-enricher-shutdown-during-sleep.mjs` — spawns the service, waits for "sleeping", sends SIGTERM, and asserts the process exits promptly (exit code 0). On Windows, the shutdown log lines may not appear when the process is run as a child; the test still confirms prompt exit.
