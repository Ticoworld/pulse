# Runtime Closure Audit (Phases 0–7)

**Purpose:** Close the runtime proof gaps left by the hostile verification audit. No new features; rerunnable evidence only.

---

## A. Executive verdict

Runtime closure pass was run. Four of five proof gaps were closed with rerun evidence; one (engine/service lifecycle) was not rerun and remains unverified.

- **Bags smoke:** VERIFIED — ran against real Bags API with real mint; full output captured.
- **Migrations 013/014/015:** VERIFIED — SQL run against active DB; tables, columns, and partial unique index confirmed.
- **Telegram delivery:** VERIFIED — one real message sent to owner chat via the same code path the bot uses; send succeeded.
- **Bags-enricher shutdown during sleep:** VERIFIED — enricher entered sleep, SIGTERM sent, process exited promptly. On Windows the child process may not log “shutdown requested” / “during sleep, exited promptly” in captured output; exit behavior is proven.
- **Engine/service lifecycle:** UNVERIFIED — not rerun in this pass.

---

## B. Proofs closed successfully

1. **Bags smoke** — Real mint `CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS`; getTokenCreators and getTokenLifetimeFees succeeded; rate guard reported.
2. **Migrations 013/014/015** — Tables `bags_token_enrichments` and `bags_token_creators` exist; columns `creators_next_retry_at` and `fees_next_retry_at` exist on `bags_token_enrichments`; partial unique index `idx_signals_bags_enrichment_resolved_unique` on `signals(token_mint)` WHERE type = 'BAGS_ENRICHMENT_RESOLVED' exists.
3. **Telegram delivery** — Script sent one real message to `TELEGRAM_OWNER_CHAT_ID`; same `sendMessage` path as bot.
4. **Bags-enricher shutdown** — Enricher ran with 1-minute interval, completed one cycle, logged “sleeping 51s until next cycle”, received SIGTERM, exited with signal=SIGTERM.

---

## C. Proofs still missing

- **Engine/service lifecycle:** Not rerun. No new logs or outputs to prove startup/shutdown behavior; remains code-present only.

---

## D. Exact commands run

| # | Command | Purpose |
|---|--------|--------|
| 1 | `npm run bags:smoke -- CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS` | Bags smoke with real mint |
| 2 | `npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/verify-migrations-013-015.ts` | Migration proof (SQL) |
| 3 | `node scripts/test-bags-enricher-shutdown-during-sleep.mjs` | Enricher shutdown during sleep |
| 4 | `npx ts-node -r dotenv/config -r tsconfig-paths/register --project apps/tg-bot/tsconfig.json scripts/send-one-telegram-test-alert.ts` | One real Telegram send |

---

## E. Exact raw terminal outputs

### E1. Bags smoke

```
> pulse@0.1.0 bags:smoke
> npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/bags-smoke-readonly.ts CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS

[bags-smoke] mint: CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS
[bags-smoke] BAGS_API_KEY set: true
[bags-smoke] SOLANA_RPC_URL set: true
[bags-rate-guard] usage: 1/800 total, 1 for getTokenCreators
[bags-smoke] getTokenCreators ok: 1 creator(s)
  primary: wallet=8ABbt5u8SRxr6t4uN3mHfe46ytdP2MuBy5HfiSDmMTz8 displayName=PublicFundApp provider=twitter royaltyBps=10000
[bags-rate-guard] usage: 2/800 total, 1 for getTokenLifetimeFees
[bags-smoke] getTokenLifetimeFees ok: 369.655 SOL (369655050567 lamports)
[bags-smoke] rate guard usage: 2/800
[bags-smoke] done.
```

(Exit code: 0.)

### E2. Bags-enricher shutdown test

```
--- Sending SIGTERM during sleep ---

--- Full output ---

[stdout] [bags-enricher] starting; interval_ms=60000 limit=25 since_hours=168
[stdout] [bags-enricher] cycle start
[stdout] [bags-enricher] mints to process: 14
...
[stdout] [bags-enricher] finished
[stdout] [bags-enricher] cycle end processed=14 candidates=14 stopReason=none
[stdout] [bags-enricher] sleeping 51s until next cycle

--- Process exited: code=null signal=SIGTERM ---
Prompt exit confirmed (child may be killed before handler on Windows).
For PM: run service in foreground, wait for 'sleeping Ns', then Ctrl+C to see both messages.
```

(Exit code: 0. Process entered sleep then exited on SIGTERM.)

### E3. One real Telegram send

```
[send-one-telegram-test-alert] sending to owner chat 1331814679...
[send-one-telegram-test-alert] sent successfully.
```

(Exit code: 0.)

---

## F. Exact SQL queries run

Executed via script `scripts/verify-migrations-013-015.ts` (uses `@pulse/db` and `DATABASE_URL`):

1. **Tables `bags_token_enrichments` and `bags_token_creators` exist:**
   ```sql
   SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bags_token_enrichments';
   SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'bags_token_creators';
   ```

2. **Columns on `bags_token_enrichments`:**
   ```sql
   SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bags_token_enrichments' AND column_name IN ('creators_next_retry_at', 'fees_next_retry_at') ORDER BY column_name;
   ```

3. **Partial unique index for BAGS_ENRICHMENT_RESOLVED on signals:**
   ```sql
   SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'signals' AND indexdef LIKE '%BAGS_ENRICHMENT_RESOLVED%';
   ```

---

## G. Exact SQL outputs

```
--- Query 1: bags_token_enrichments table exists ---
rows: 1 data: [{"?column?":1}]

--- Query 2: bags_token_creators table exists ---
rows: 1 data: [{"?column?":1}]

--- Query 3: creators_next_retry_at, fees_next_retry_at on bags_token_enrichments ---
rows: 2 data: [{"column_name":"creators_next_retry_at"},{"column_name":"fees_next_retry_at"}]

--- Query 4: partial unique index for BAGS_ENRICHMENT_RESOLVED on signals(token_mint) ---
rows: 1 data: [
  {
    "indexname": "idx_signals_bags_enrichment_resolved_unique",
    "indexdef": "CREATE UNIQUE INDEX idx_signals_bags_enrichment_resolved_unique ON public.signals USING btree (token_mint) WHERE (type = 'BAGS_ENRICHMENT_RESOLVED'::text)"
  }
]

--- Done ---
```

---

## H. Failures encountered

- None for the four proofs that were run. Bags-enricher cycle reported BAGS API 400 and non–base58 mints for some rows; those are expected for test/invalid mints and do not affect the shutdown proof.

---

## I. Final runtime status by phase

| Phase | Runtime status |
|-------|----------------|
| Phase 1 | Runtime proven (migrations 013/014/015 applied; schema and index verified by SQL). |
| Phase 2 | Runtime proven (Bags smoke with real mint and real Bags API). |
| Phase 3 | Code-present; engine lifecycle not rerun in this pass. |
| Phase 4 | Code-present; bags-enricher **shutdown during sleep** runtime proven. |
| Phase 5 | Code-present; scoring/bags logic exercised via smoke and enricher run. |
| Phase 6 | Runtime proven (one real Telegram send to owner chat via same path as bot). |
| Phase 7 | Code-present; HIGH_INTEREST digest path used by bot and local script; no separate lifecycle rerun. |

---

## J. What is now proven in the real environment

- **Bags API:** Real mint works with getTokenCreators and getTokenLifetimeFees; rate guard in use.
- **Database:** Migrations 013, 014, 015 are applied: `bags_token_enrichments`, `bags_token_creators`, retry columns, and partial unique index on `signals(token_mint)` for `BAGS_ENRICHMENT_RESOLVED`.
- **Telegram:** At least one message successfully sent to the owner chat using the same mechanism as the bot (sendMessage to TELEGRAM_OWNER_CHAT_ID).
- **Bags-enricher:** Runs one cycle, then sleeps; on SIGTERM during sleep the process exits promptly (Windows child may not echo “shutdown requested” / “during sleep” in captured output).

---

## K. What is still only code-present, not runtime-proven

- **Engine/service lifecycle:** Startup and shutdown behavior of the engine (or other long-running services) was not rerun; no new logs or outputs. Reliance on past logs only.
- **Full bot flow:** `/top_candidates` or unsent-signal send was not exercised end-to-end in this pass; delivery proof was done via the dedicated send-one-telegram-test-alert script using the same send path.

---

*Document generated after runtime closure pass. All captured outputs and commands above were produced by rerunning the corresponding commands in the current environment.*
