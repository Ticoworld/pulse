# Pulse — Architecture Audit (Code-Verified)

**Date:** 2026-03-08  
**Scope:** Full monorepo scan; no improvements, verification only.

---

## A. Repo map

- **Root:** `package.json` — workspaces: `apps/*`, `packages/*`, `services/*`. Scripts: `dev:api`, `dev:bot`, `dev:stream`, `dev:stream:debug`, `dev:engine`, `build`, `typecheck`. No `dev:executor` script.
- **apps/**
  - **api** — Express app; single file `src/index.ts`. Port from `PORT` (default 3000).
  - **tg-bot** — Telegram bot; single file `src/index.ts`. Uses `node-telegram-bot-api`, `@pulse/db`.
- **services/**
  - **stream** — Entry `src/index.ts`; uses `stream.ts`, `providers/helius.ts`, `types.ts`. Has local `db.ts` (unused by main flow; stream uses `@pulse/db` for inserts). Debug entry: `debug-ws.ts`.
  - **engine** — Entry `src/index.ts`; core loop in `engine.ts`; modules: `candidateEngine.ts`, `walletScorer.ts`, `clusterEngine.ts`.
  - **executor** — Entry `src/index.ts`; core in `executor.ts`; uses `riskManager.ts`, `solana.ts`, `types.ts`. Not started by any root npm script.
- **packages/**
  - **db** — Raw `pg` client (`client.ts`), no ORM. Modules: `rawEvents`, `watchlist`, `signals`, `launchCandidates`, `devTracking`, `candidateSignals`, `walletProfiles`, `actors`, `executionOrders`, `positions`, `exitOrders`. Migrations in `src/migrations/` (001–012, SQL files).
  - **common** — Shared types only: `RawEvent`, `EventType`, `APP_NAME` (`src/index.ts`).
- **infra/** — Single file `docker-compose.yml`: Postgres 16, Redis 7; no app services.
- **scripts/** — Ad-hoc: `run-migration.ts` (hardcoded to 002_raw_events_fix), `test-phase4.ts`, `test-trigger.ts`, `query-wallets.ts`, `verify-inserts.ts`. Run manually (e.g. `npx ts-node scripts/...`).

---

## B. Confirmed stack

- **Language:** TypeScript (Node ≥18). No Prisma; DB access is raw `pg` in `packages/db/src/client.ts`.
- **Frameworks:** Express in `apps/api`; no framework in other apps/services.
- **DB access:** `pg.Pool` via `DATABASE_URL`; single shared pool in `packages/db`. All DB writes/reads go through `@pulse/db` (stream imports from `packages/db`, not from `services/stream/src/db.ts`).
- **Redis:** Present in `infra/docker-compose.yml` and `.env.example` (`REDIS_URL`). **No Redis client or usage anywhere in the codebase.** Not used as cache or queue.
- **Queue:** None. Stream uses in-memory signature queue + HTTP fetch loop in `services/stream/src/stream.ts`. Engine polls `raw_events` by `seq`. Executor polls `signals` and `exit_orders`. No job queue (Bull, etc.).
- **Telegram:** `node-telegram-bot-api` in `apps/tg-bot`; `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`; polling mode.
- **Docker:** Compose only for Postgres and Redis. No Dockerfile for apps/services; run locally via npm/ts-node.
- **Config / env:** `.env` (from `.env.example`). Keys: Telegram (token, owner chat id), API (PORT), DB (DATABASE_URL), Redis (REDIS_URL, unused), Helius (API key, network, optional WS/HTTP overrides, STREAM_TARGET_PROGRAMS, ENGINE_*), Executor (EXECUTOR_ENABLED, PAPER_TRADING, EXECUTOR_*). No centralized config module; services read `process.env` directly.

---

## C. Confirmed architecture flows

### Event ingestion

- **Source:** Helius. WebSocket: `services/stream/src/providers/helius.ts` — `logsSubscribe` with `mentions: [programId]` for Raydium, Orca, Jupiter (or `STREAM_TARGET_PROGRAMS`). Receives `logsNotification` → extracts `signature` only.
- **Transport:** WS gives signatures only; full tx fetched via HTTP. `stream.ts`: in-memory `processedSignatures` set + `queue[]`; batch loop every 3s, max 50 signatures per request to `https://api.helius.xyz/v0/transactions/?api-key=...` (POST body `{ transactions: signatures }`).
- **Normalization:** `stream.ts` `normalize(tx)`: classifies type (SWAP, TOKEN_MINT, TRANSFER) from Helius `type`; extracts token/wallet/amount from `tokenTransfers[0]` or `nativeTransfers[0]`; produces object compatible with `RawEvent` (id from hash of signature, source `"helius"`, eventType, signature, slot, walletAddress, tokenMint, amount, timestamp, rawPayload). **Storage path:** `insertRawEvent` from `@pulse/db` → `packages/db/src/rawEvents.ts` — INSERT with `event_key = signature:eventType:wallet:tokenMint`, `ON CONFLICT (event_key) DO NOTHING`. Table: `raw_events` (seq, id, event_key, source, event_type, signature, slot, wallet_address, token_mint, amount, ts, raw_payload, created_at).
- **Polling/subscriptions:** Stream is push (WS) + pull (HTTP fetch per batch). No DB polling in stream. Engine polls `raw_events` (see below).

### Scoring and signal pipeline

- **Engine entry:** `services/engine/src/engine.ts` — `runEngine()`: reads `getMaxRawEventSeq()` (or 0 if `ENGINE_REPLAY_FROM_START=true`), then every 5s runs `SELECT ... FROM raw_events WHERE event_type IN ('SWAP','TOKEN_MINT') AND seq > $1 ORDER BY seq ASC LIMIT 100`.
- **Per row:**  
  - **TOKEN_MINT:** If mint not in `ENGINE_IGNORED_MINTS` and no existing launch_candidate: `upsertLaunchCandidateFirstSeen`, `insertSignal('NEW_MINT_SEEN', ...)`. Dev tracking: deployer = row.wallet_address; looks back in raw_events for TRANSFER to deployer → funder heuristic; `upsertLaunchDevLink`, `upsertDevProfile`, `incrementDevLaunchCount`; then `recomputeCandidate(mint)`.  
  - **SWAP:** If mint has launch_candidate and no liquidity_live yet: `markLaunchCandidateLiquidityLive`, optional dev `incrementDevLiquidityLiveCount`, `insertSignal('LIQUIDITY_LIVE', ...)`, `recomputeCandidate(mint)`. If wallet in watchlist: `insertSignal('ALPHA_WALLET_BUY', ...)`, `processAlphaBuy(mint, wallet)` (clusterEngine), `recomputeCandidate(mint)`, `recomputeWallet(wallet)`.
- **Wallet scoring:** `walletScorer.ts` — `recomputeWallet(walletAddress)`: loads ALPHA_WALLET_BUY signals for wallet, distinct mints; for each mint checks candidate_signals, HIGH_INTEREST_TOKEN signals, launch_candidates; computes total_alpha_buys, total_candidate_hits, total_high_interest_hits, total_launch_mint_hits, avg_entry_delay_seconds; score formula (caps and penalties); tier low/medium/high; `upsertWalletProfile`; if wallet in actor, `recomputeActorScore(actor.id)`.
- **Actor scoring:** `packages/db/src/actors.ts` `recomputeActorScore`: aggregates wallet_profiles for actor’s wallets, adds tier bonuses, counts distinct HIGH_INTEREST_TOKEN mints; updates actor score and tier.
- **Dev attribution:** Engine: deployer from TOKEN_MINT wallet_address; funder from latest TRANSFER to deployer before that seq. Stored in `launch_dev_links` (mint, deployer_wallet, funder_wallet, probable_dev_wallet, confidence, method). Dev stats in `dev_profiles` (launch_count, liquidity_live_count, etc.).
- **Launch lifecycle:** `launch_candidates`: first TOKEN_MINT → first_seen_*; first SWAP on that mint → liquidity_live_*. Status and first_swap_* exist in schema but first_swap is not clearly set in engine code path (only first_seen and liquidity_live).
- **Clustering:** `clusterEngine.ts`: in-memory only — `recentBuyers` (mint → list of { walletAddress, timestamp }), `coBuyPairs` (pairKey → set of mints). On ALPHA_WALLET_BUY, co-buy within 15s and same mint; if same pair co-buys ≥3 mints, `evaluateCoBuyClustering`: create or extend actor, add both wallets with method `co_buy`, confidence 60. State is process-local; restart loses clustering history.
- **Candidate scoring:** `candidateEngine.ts` `recomputeCandidate(mint)`: from signals (LIQUIDITY_LIVE, ALPHA_WALLET_BUY), dev link and dev profile; score = 20 (liquidity_live) + 40 (alpha) + 20 (dev launch_count>1) + 10 (dev liquidity_live_count>1) + wallet tier bonus (5/10) + actor tier bonus (5/10); upserts `candidate_signals`; if score ≥ 60 and liquidity_live, inserts signal `HIGH_INTEREST_TOKEN` (once per mint via existing check).

### Execution pipeline

- **Entry:** `services/executor/src/index.ts` — reads env into `ExecutionConfig`, creates `ExecutorBot`, `bot.start()`. If `EXECUTOR_ENABLED !== 'true'`, `start()` returns immediately (no polling). No root npm script to run executor; must run executor process manually (e.g. `npx ts-node -r tsconfig-paths/register --project services/executor/tsconfig.json services/executor/src/index.ts`).
- **Order creation:** `executor.ts` `poll()`: (1) `riskManager.evaluateOpenPositions()`, (2) `listPendingExitOrders(50)` → process each exit, (3) query `signals` WHERE type = 'HIGH_INTEREST_TOKEN' ORDER BY created_at DESC LIMIT 50; for each, `processCandidate(signalRow)`. processCandidate: skip if execution_orders already has signal_id; skip if active buy order for mint; load candidate_signals row; require liquidity_live_trigger, score ≥ minScore, mint not in IGNORE_MINTS; capacity (open positions < maxOpenPositions), cooldown (no recent closed position for mint); then `createExecutionOrder(...)` and `executeBuy(orderId, mint)`.
- **Order state:** execution_orders: pending → submitted (tx_signature set) → confirmed / failed. positions created only on confirmed buy. exit_orders: pending → submitted → confirmed / failed; position closed only when exit sell_percentage === 100 and confirmed.
- **Paper path:** `config.paperTrading` (default true from `PAPER_TRADING !== 'false'`). `quoteAndBuildBuyTx` / `quoteAndBuildSellTx` / `sendSignedTransaction` / `confirmTransaction` in `solana.ts`: when paperTrading true, return stub tx and fake signature; confirm after 1s delay. DB updates (mark submitted/confirmed, create position, create exit_orders) are real.
- **Live path:** In `solana.ts`, when `paperTrading` is false, all four functions throw `Error("Route integration not implemented")` or `Error("Sell route integration not implemented")`. No Jupiter/Raydium/other router or wallet signer integration.
- **Exit logic:** Risk manager: `evaluateOpenPositions()` → for each open position, `evaluateTimeStop(pos)`: if age ≥ timeStopMinutes (default 30), creates exit_order reason `time_stop`, sell_percentage 100. No alpha_exit or dev_risk (TODOs in riskManager.ts).
- **Risk controls:** maxOpenPositions (default 3), cooldown (default 60 min) per mint after close, minScore gate, liquidity_live required. Time stop only; no trailing stop or other rules in code.
- **Stubbed/simulated:** All Solana tx build/send/confirm in `services/executor/src/solana.ts` are stubs in paper mode (fake base64 and signature, fixed 1s then success). Live mode is unimplemented (throws).

---

## D. Confirmed database schema

**Migrations (applied manually; run-migration.ts only runs 002_raw_events_fix):**  
001_raw_events, 002_raw_events_fix, 002_add_seq_to_raw_events, 003_watchlist_wallets, 004_signals, 005_launch_candidates, 006_dev_tracking, 007_candidate_signals, 008_make_signal_wallet_nullable, 009_wallet_profiles, 010_actor_clusters, 011_execution_orders, 012_positions_and_exit_orders.

**Tables (all claimed ones present):**

| Table               | Purpose (from migrations/code) |
|---------------------|---------------------------------|
| raw_events          | Ingested events; seq, event_key dedupe. |
| watchlist_wallets   | Wallets to treat as alpha. |
| signals             | NEW_MINT_SEEN, LIQUIDITY_LIVE, ALPHA_WALLET_BUY, HIGH_INTEREST_TOKEN; is_sent for Telegram. |
| launch_candidates   | Per-mint first_seen + liquidity_live. |
| dev_profiles        | Per dev_wallet launch/liquidity counts. |
| launch_dev_links    | mint → deployer/funder/probable_dev. |
| candidate_signals   | Per-mint score and triggers (alpha, liquidity, dev). |
| wallet_profiles     | Per-wallet scores and tiers. |
| actors              | Clustered-entity label, score, tier. |
| actor_wallets       | actor_id ↔ wallet_address. |
| execution_orders    | Buy orders; status, tx_signature, notification timestamps. |
| positions           | Open/closed; links to execution_orders. |
| exit_orders         | Sell orders; position_id, reason, sell_percentage. |

**No missing claimed tables.** No extra tables beyond these in migrations. Naming in code matches schema (snake_case columns, camelCase in TS where used).

---

## E. Confirmed Telegram / API product surfaces

### Telegram (`apps/tg-bot/src/index.ts`)

- **Auth:** Owner-only by `TELEGRAM_OWNER_CHAT_ID`; `isOwner(msg)`; non-owner messages ignored (e.g. /ping still responds to anyone; watchlist/signals only for owner).
- **Commands:**  
  - `/ping` → "pong" (any chat).  
  - `/watchlist_add <wallet> [label]` — owner only; `addWatchlistWallet`.  
  - `/watchlist_remove <wallet>` — owner only.  
  - `/watchlist_list` — owner only; `listWatchlistWallets`, Markdown list.
- **Alerts (polling):** Every 5s `listUnsentSignals(10)`; for each signal type (ALPHA_WALLET_BUY, NEW_MINT_SEEN, LIQUIDITY_LIVE, HIGH_INTEREST_TOKEN) format message with wallet/profile/actor info and Solscan links; send to OWNER_CHAT_ID, then `markSignalSent(signal.id)`.
- **Execution notifications:** Every 5s (setTimeout loop) `listUnnotifiedExecutionOrders()` and `listUnnotifiedExitOrders()`; for submitted/confirmed/failed send message to owner and mark notified.

No other Telegram features (e.g. /positions, /candidates) in code.

### API (`apps/api/src/index.ts`)

- **Endpoints:** Only `GET /health` → `{ ok: true, service: "api" }`.
- **No** DB, no auth, no other routes. API does not depend on `@pulse/db`.

### Web UI

- **None.** No front-end app or HTML endpoints.

---

## F. What is real and working

- **Repo structure:** Workspaces, TypeScript, shared packages build.
- **Infra:** Docker Compose brings up Postgres and Redis.
- **Stream:** Helius WS (logsSubscribe) + HTTP batch fetch + normalize + insert into `raw_events` with event_key dedupe. Runs with `npm run dev:stream`.
- **Engine:** Polls raw_events, TOKEN_MINT → launch_candidates + NEW_MINT_SEEN + dev links + dev profiles; SWAP → liquidity_live + LIQUIDITY_LIVE signal + alpha watchlist → ALPHA_WALLET_BUY; candidate recompute; wallet and actor scoring; clustering (in-memory). Runs with `npm run dev:engine`.
- **Scoring and signals:** Candidate score (60 threshold), HIGH_INTEREST_TOKEN emission; wallet_profiles and actors updated; cluster creation from co-buy heuristic. All persisted.
- **Telegram:** Watchlist CRUD (owner-only), unsent signal alerts, execution/exit order notifications. Polling loops active.
- **Executor (paper only):** When EXECUTOR_ENABLED=true and PAPER_TRADING=true: poll HIGH_INTEREST_TOKEN signals, create execution_orders, “execute” via stubbed solana.ts (fake tx/signature), confirm after 1s, create positions; risk manager creates time_stop exit_orders; executor processes pending exit_orders with same stub. DB state (orders, positions, exits) is real.
- **DB layer:** All 13 tables used; migrations exist; no ORM; single pool.

---

## G. What is partial, weak, or heuristic

- **Dev attribution:** Single-hop funder heuristic (latest TRANSFER to deployer before mint). No multi-hop or other methods; confidence “high” only when funder found.
- **Clustering:** In-memory only; 15s window, 3 co-buys; no persistence of cluster state across restarts; conflict when two wallets already in different actors (skipped, no merge).
- **Engine replay:** ENGINE_REPLAY_FROM_START replays from seq=0; no checkpoint per run or backfill idempotency story beyond event_key.
- **Executor:** Not in root scripts; must be run manually; EXECUTOR_ENABLED defaults to false.
- **Run-migration script:** Points at single migration file (002_raw_events_fix); no ordered migration runner for 001–012.
- **API:** Health only; no REST for signals, candidates, positions, or config.
- **Risk manager:** Only time_stop; alpha_exit and dev_risk unimplemented (TODOs).

---

## H. What is simulated or fake

- **Paper trading:** `solana.ts` in paper mode returns fake tx data and signature; `confirmTransaction` waits 1s and returns true. No real chain submission or confirmation.
- **Live trading:** Not implemented. All route/build/send/confirm functions throw when `paperTrading === false`.

---

## I. What is missing entirely

- **Redis usage:** No client or code path uses REDIS_URL.
- **Queue backbone:** No job queue; stream/engine/executor use in-memory or DB polling.
- **Executor npm script:** No `dev:executor` or `start:executor` in root package.json.
- **Live Solana execution:** No integration with Jupiter/Raydium or wallet/signer; no real tx build or send.
- **API beyond health:** No endpoints for data or control.
- **Auth on API:** No middleware or API keys.
- **Observability:** No metrics (Prometheus/etc.), no tracing (OpenTelemetry), no structured log levels or request IDs. Console.log/error only.
- **Key management:** No HSM or vault; Helius and Telegram keys from env.
- **Market/safety checks:** No explicit circuit breaker, max notional, or exchange/API health checks in code.
- **Web UI:** None.
- **Bags.fm-specific logic:** No Bags or music/NFT product code; generic Solana launch/alpha flow only.

---

## J. Top 10 technical risks

1. **Engine SIGTERM bug:** `services/engine/src/index.ts` lines 30–33 register a top-level `process.on("SIGTERM", () => { stop(); ... })` where `stop` is not in scope (it’s only inside `init()`). When SIGTERM is delivered, this handler runs and throws ReferenceError.
2. **Stream duplicate insert path:** `services/stream/src/db.ts` defines its own `insertRawEvent` (ON CONFLICT on `id`); stream’s main path uses `@pulse/db` (ON CONFLICT on `event_key`). Two different dedupe semantics; local db.ts is dead code but confusing.
3. **No ordered migrations:** Migrations 001–012 must be applied manually in order; run-migration.ts is hardcoded to one file. Schema drift risk across envs.
4. **Clustering state volatile:** Cluster engine state is in-memory; restart loses all co-buy history; actors already created remain in DB but new process won’t extend clusters until history rebuilds.
5. **Executor not in default runbooks:** No script to start executor; easy to assume it’s off; EXECUTOR_ENABLED=false by default so no accidental live attempt, but paper path is easy to forget to run.
6. **Live trading throws:** If someone sets PAPER_TRADING=false without implementing solana.ts, every buy/sell attempt throws; no graceful degradation.
7. **No rate limiting on API:** Single health endpoint only today; if more routes are added without auth/rate limit, exposure.
8. **Redis unused:** Infra runs Redis but nothing uses it; wasted resource and confusion about intended use (cache vs queue).
9. **Single DB pool:** All services that use @pulse/db share one pool (when run in same process) or one pool per process; no connection limits or per-service isolation documented.
10. **Signal ordering and replay:** Engine processes by seq in batches; executor polls “recent” HIGH_INTEREST_TOKEN signals; no strict ordering guarantee between engine and executor; replay could double-create orders if unique constraints don’t catch it (they do per mint/signal_id, but logic is subtle).

---

## K. Mismatch report: written summary vs code reality

| Claim | Code reality |
|-------|----------------|
| "Redis present but not true queue backbone" | **Correct.** Redis is in compose and env only; no code uses it. No queue anywhere. |
| "Chain ingestion Helius WebSocket plus HTTP fetch by signature" | **Correct.** WS = logsSubscribe → signatures; HTTP = v0/transactions batch. |
| "Normalize events into raw_events" | **Correct.** stream normalizes; inserts via @pulse/db rawEvents (event_key). |
| "Generate launch candidates, score wallets and actors, cluster wallets, emit signals" | **Correct.** candidateEngine, walletScorer, clusterEngine; signals table and HIGH_INTEREST_TOKEN. |
| "Executor/risk manager loops" | **Correct.** Executor poll loop; risk manager evaluates open positions and creates time_stop exits. |
| "Live trading incomplete, paper trading supported" | **Correct.** Live path throws; paper path stubbed in solana.ts. |
| "Main tables (raw_events, …)" | **Correct.** All listed tables exist and are used. |
| "Main apps: api, tg-bot; services: stream, engine, executor; packages: db, common" | **Correct.** executor exists but has no root npm script. |
| "Candidate engine, wallet scorer, cluster engine, risk manager" | **Correct.** All exist and are wired. |
| README "stream / engine / executor (future)" | **Outdated.** All three exist and have real logic; README understates current state. |
| README "db (Prisma / future)" | **Wrong.** DB is raw pg, not Prisma; no "future" Prisma in code. |

---

## L. Readiness verdict (percentages)

- **Signal engine readiness:** **75%.** Ingestion → raw_events → engine → launch_candidates, signals, candidate_signals, wallet_profiles, actors works. Gaps: clustering ephemeral, dev heuristic single-hop, no formal backfill/replay story.
- **Live trading readiness:** **5%.** Schema and executor state machine and risk loop exist; Solana build/send/confirm are stubs. No router, no wallet/signer, no real tx path.
- **Bags pivot readiness:** **15%.** Generic Solana alpha/launch pipeline only; no Bags.fm or music/NFT features; would need product-specific signals and possibly new data sources.
- **Production readiness:** **25%.** No auth on API, no metrics/tracing, no key vault, Redis unused, migration process ad hoc, engine SIGTERM bug, no health checks for stream/engine/executor or DB/Redis.

---

## What the codebase actually is in one paragraph

Pulse is a TypeScript monorepo that ingests Solana DEX activity via Helius (WebSocket for signatures, HTTP for full transactions), normalizes it into a `raw_events` table, and runs a polling engine that builds launch candidates and dev links, scores wallets and actors (including in-memory co-buy clustering), and emits signals (NEW_MINT_SEEN, LIQUIDITY_LIVE, ALPHA_WALLET_BUY, HIGH_INTEREST_TOKEN). A Telegram bot exposes watchlist management and pushes those signals and execution notifications to an owner chat. An executor service can create execution_orders and positions and time-based exit_orders using a full DB state machine, but all Solana transaction build/send/confirm are stubbed for paper mode and unimplemented for live; Redis and the API beyond /health are unused. The stack is Node, Express (minimal), raw pg, and env-based config with no observability or auth layer.
