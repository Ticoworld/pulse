# PHASE0 — Master Product & Architecture Context (Bags Pivot)

Internal brief for Cursor implementation prompts. Based only on audit-confirmed repo reality and provided Bags hackathon constraints. No code, no refactor.

---

## 1. What this codebase actually is today

- A TypeScript monorepo that ingests Solana DEX activity via Helius (WebSocket for signatures, HTTP for full transactions), normalizes into `raw_events`, and runs a polling engine that builds launch candidates, dev links, wallet/actor scores, and in-memory co-buy clustering, then emits signals (NEW_MINT_SEEN, LIQUIDITY_LIVE, ALPHA_WALLET_BUY, HIGH_INTEREST_TOKEN).
- A Telegram bot that manages a watchlist and pushes those signals plus execution-order notifications to a single owner chat.
- A minimal Express API (health only) and an executor that can create execution_orders/positions/exit_orders in the DB with a full state machine but only stubbed Solana tx build/send/confirm (paper path returns fake tx/signature; live path throws).
- Stack: Node, TypeScript, raw `pg`, PostgreSQL, Redis in Docker/env only (unused in code), no job queue. DB access via `@pulse/db`; migrations are ad-hoc SQL files with no ordered runner.

---

## 2. What this codebase is not

- Not a Bags-native product. It has no Bags API integration, no Bags auth, no Bags token/creator/launch or fee concepts in schema or logic.
- Not a complete trading system. Live execution is unimplemented; Solana routing and signing are stubs.
- Not production-hardened. No observability, no auth layer, no migration runner, no market-safety layer. Clustering is in-memory only; engine has a SIGTERM handler bug.
- Not a web app. There is no web UI. Telegram is the only real user surface.

---

## 3. Why the current form is weak for Bags hackathon

- **No Bags usage.** Judging favours “deeper integrations” and “onchain performance and app traction”; the repo currently ignores Bags entirely. It cannot be verified as a Bags project.
- **Generic Solana, not Bags-native.** Launch and alpha signals are built from raw Helius DEX events only. There is no notion of “Bags launch,” “Bags creator,” or “Bags token,” so we cannot rank or prioritise by Bags-specific quality or fee potential.
- **Traction surface is narrow.** One Telegram bot and a health-only API do not demonstrate “app traction” strongly; we have no Bags-specific UX (e.g. Bags launch alerts, creator quality, fee-claim hints).
- **Execution is irrelevant for the wedge.** We are not pitching a full trading infra; we are pitching Bags Alpha Intelligence. Building on the broken live-execution path would distract from signal quality and Bags integration depth.

---

## 4. Bags constraints that shape product decisions

- **Auth:** Bags API requires the `x-api-key` header. Confirmed in official Bags docs.
- **Rate limit:** 1,000 requests/hour per user and per IP; applies across all API keys; sliding hourly windows; X-RateLimit-* headers and 429 body (limit, remaining, resetTime) confirmed in official Bags docs.
- **Error semantics:** 401 = missing/invalid API key; 403 = insufficient permissions; 429 = rate limit exceeded. Confirmed in official Bags docs with example payloads.
- **Documented areas:** launching a token; creating a partner key; claiming partner fees; getting token lifetime fees; getting token creators; claiming fees from token positions; trading tokens; getting token claim events. Exact raw endpoint paths and request/response shapes for each workflow are in the API reference; this repo uses the TypeScript SDK as the source of truth for Phase 1.
- **Hackathon rules:** Ranked by real traction; verified projects only; must use Bags; deeper integrations rank higher; rolling applications; winners judged on onchain performance and app traction. Implication: every phase should increase demonstrable Bags usage and user-visible value, not generic infra.

---

## 5. Chosen pivot: exact product definition

- **Product name (working):** Bags Alpha Intelligence Bot.
- **Core job:** Monitor Bags-native launches, creators, and token activity; surface high-signal intelligence to traders via Telegram first.
- **Wedge:** Launch intelligence, early activity alerts, dev/deployer quality heuristics, wallet activity signals; later, deeper Bags-native trading and fee-sharing integrations as scope allows.
- **Not in scope for the pivot:** Becoming a generic Solana trading bot; rebuilding full trading infra; claiming “live trading” before it exists. This is a hackathon traction play centred on Bags-native signal intelligence.

---

## 6. Primary user and their real job-to-be-done

- **Primary user:** A trader (or small group) who wants an edge on Bags-launched tokens and creator quality, and is willing to use Telegram as the main interface.
- **Job-to-be-done:** “Tell me when something important happens in the Bags ecosystem—new Bags launch, strong creator, wallet activity on a Bags token—so I can decide whether and how to act, without me polling dashboards or reading raw chain data.”

---

## 7. Core product loop we are trying to create

1. **Ingest** onchain activity (existing Helius stream → `raw_events`) and, where relevant, **enrich** with Bags API data (e.g. “is this a Bags token?”, “who is the Bags creator?”, “creator verification / fee potential”) within strict rate limits.
2. **Filter and score** using existing engine concepts (launch lifecycle, dev links, wallet/actor quality) plus Bags-specific flags (Bags launch, Bags creator, optional fee/claim hints).
3. **Emit signals** that are explicitly Bags-aware (e.g. Bags launch seen, Bags creator activity, Bags token alpha buy) and persist them so the bot can send alerts.
4. **Deliver** to the user via Telegram: concise, actionable alerts with Bags context (e.g. Bags token link, creator, verification) and optional Solscan/explorer links.
5. **Iterate:** Later phases can add Bags trading or fee-claim hints without claiming full live execution until it is implemented.

---

## 8. What parts of the existing repo we can reuse directly

- **Monorepo layout:** apps (api, tg-bot), services (stream, engine, executor), packages (db, common). Keep it.
- **Ingestion pipeline:** Helius WebSocket + HTTP fetch → normalize → `raw_events` via `@pulse/db`. Reuse; do not replace with Bags as the primary event source (Bags is rate-limited HTTP, not a realtime event stream).
- **Engine polling and core tables:** Polling `raw_events`, building `launch_candidates`, `signals`, `candidate_signals`, `dev_profiles`, `launch_dev_links`, `wallet_profiles`, `actors`, `actor_wallets`. Reuse as the onchain backbone; extend with Bags enrichment where needed.
- **Telegram bot:** Commands (watchlist, ping), signal alert loop, execution notification loop. Reuse and extend with Bags-specific message types and links.
- **DB client and schema (existing tables):** Raw `pg`, `@pulse/db`, existing 13 tables. Reuse; add new tables/columns for Bags only where necessary.
- **Executor/risk/positions/exit_orders:** Keep schema and state machine for future use; do not rely on live execution for the Bags wedge. Paper path can remain as-is for demos if needed.

---

## 9. What parts are too weak to rely on yet

- **Live trading and `solana.ts`:** Stubbed; throws outside paper mode. Do not pretend it exists. Any “trading” in the Bags narrative must be explicitly mock or future scope.
- **Redis and queues:** Redis is unused; there is no queue backbone. Do not design flows that silently depend on Redis or a job queue unless we add and document them.
- **Clustering:** In-memory only; lost on restart. Do not depend on it for Bags-critical features until it is persisted or redefined.
- **API beyond health:** No auth, no Bags-related endpoints. Any new API must be added explicitly with auth and rate-limiting in mind.
- **Observability and migrations:** No metrics/tracing; no ordered migration runner. These are technical-debt items; new work must not assume they exist.
- **Engine SIGTERM bug:** Top-level handler references out-of-scope `stop`. Fix when touching engine startup; do not build new behaviour on top of broken shutdown.

---

## 10. Non-goals for the next phases

- Implementing full live Solana execution as a requirement for the Bags wedge.
- Building a broad web dashboard or replacing Telegram as the primary surface.
- Adding Redis or a queue backbone “for future use” without a concrete Bags or traction need.
- Generic “AI” or vague “alpha” features that do not tie to Bags tokens/creators/launches.
- Claiming production readiness (auth, observability, hardening) until we explicitly build for it.
- Supporting non-Bags chains or non-Bags launch flows as first-class in the product narrative.

---

## 11. Immediate build priorities in order

1. **Bags API integration (read-only, within rate limits):** Auth (x-api-key), one or two high-value read endpoints (e.g. token/creator/launch info as documented by Bags), and a strict client that enforces 1,000 req/hour (and any burst rules once confirmed). No enrichment of every raw_event; only where defined below.
2. **Enrichment bridge (Helius → Bags):** Define and implement when we call Bags (e.g. only for mints that already pass our filters), with caching and thresholds so we never exceed Bags rate limits. See “Enrichment bridge” below.
3. **Schema gap for Bags:** Add only the minimal tables/columns needed for Bags tokens, creators, partner/fee state, and enrichment cache. See “Schema gap” below.
4. **Engine extension:** After enrichment and schema exist, wire Bags data into candidate/signal logic (e.g. “Bags launch,” “Bags creator”) and emit Bags-specific or Bags-augmented signals without breaking existing behaviour.
5. **Telegram:** Bags-aware alert copy and links (e.g. Bags token page, creator), and optional commands that show Bags context. No new surface (e.g. web) until Telegram is clearly Bags-relevant.
6. **Fixes that block reliability:** Engine SIGTERM bug; migration strategy (at least document order of migrations; runner optional but recommended). No large infra additions.

---

## 12. Technical debt that must be visible in every phase

- No ordered migration runner; schema changes are manual SQL. Any new table or column must be documented and added in a way that does not assume automation.
- Redis is present in Docker/env but unused. Do not introduce Redis dependency without a stated use and a task to implement it.
- No observability (metrics/tracing). Logging is console; any new service or loop should log in a way that makes debugging possible without pretending we have metrics.
- No production auth on the API. If we add API endpoints, auth and rate limiting must be part of the same task.
- Live execution is stubbed. Any mention of “trading” or “execution” in specs or prompts must be explicit: paper/mock vs real (and real does not exist yet).
- Clustering is in-memory; do not rely on it for Bags-specific logic until we persist or replace it.

---

## Enrichment bridge: Helius stream ↔ Bags API (rate limits)

- **Problem:** Helius gives a continuous stream of events (signatures → full tx → `raw_events`). Bags is HTTP, 1,000 requests/hour per user and per IP. We cannot call Bags for every SWAP or TOKEN_MINT.
- **Principle:** Bags is used to **enrich** a subset of data we already care about, not to drive ingestion. The event source remains Helius; Bags adds “is this a Bags token?”, “who is the Bags creator?”, metadata, etc.
- **When to call Bags (allowed):**
  - When we have a **new mint** that we already track (e.g. in `launch_candidates` or `candidate_signals`) and we have not yet resolved it against Bags (e.g. no row in a Bags cache/enrichment table, or cache TTL expired).
  - When we need **creator or token metadata** for a mint we are about to surface in a signal or alert (e.g. HIGH_INTEREST_TOKEN or a new Bags-specific signal), and we do not have fresh cached data.
  - Batch or debounce: e.g. collect mints that need enrichment over a short window (e.g. 1–5 minutes) and resolve in small batches (e.g. 10–20 mints per Bags call if the API allows batch), so we stay under ~16–17 requests per minute on average (1000/60).
- **When NOT to call Bags:**
  - For every raw_event row. Never.
  - For mints we already ignore (e.g. base mints in ENGINE_IGNORED_MINTS).
  - For mints we have never and will not promote to signals (e.g. one-off SWAP with no launch_candidate and no watchlist wallet). Prefer to only enrich after a mint is in `launch_candidates` or has a candidate_signal, or is explicitly in a “to enrich” list derived from those.
- **Thresholds and caching:**
  - **Budget:** Assume 1,000 Bags API calls per hour per process (or per API key). Reserve a margin (e.g. 800/hour) for safety; document the chosen cap.
  - **Cache:** Persist Bags responses (or derived fields) in the DB (see schema gap). Per-mint and per-creator cache with a TTL (e.g. 24h for token metadata, 1h for creator/claim status if needed). Do not re-call Bags for the same mint/creator within TTL unless we explicitly invalidate.
  - **Backoff:** On 429, back off and retry with exponential delay; do not burn the hourly budget in a burst.
- **Implementation rule:** Every Bags call must be behind a single module or client that enforces the budget, uses the cache, and logs usage so we can verify we stay under the limit.

---

## Schema gap: Bags pivot (additions / modifications)

Existing schema has no Bags concepts. Below are the **likely** additions or changes. Exact column names and types must follow Bags API response shapes and our enrichment design; this is the minimal set to support the wedge.

- **Bags token/launch tracking (new or extend launch_candidates):**
  - Need to record which mints we have confirmed as Bags-launched and when we last synced with Bags. Options: (a) New table `bags_launches` (e.g. `mint`, `bags_launch_id` or equivalent, `launched_at`, `creator_id` or wallet, `raw_response` or key fields, `last_synced_at`); or (b) Add columns to `launch_candidates` such as `bags_launch_id`, `bags_creator_id`, `bags_verified_at`, `bags_last_synced_at`. Choose one and document.
- **Bags creator / verification state:**
  - Need to store Bags-side creator info so we don’t re-fetch every time. Options: (a) New table `bags_creators` (e.g. `id`, `wallet_or_bags_creator_id`, `verified`, `metadata`/`raw_response`, `updated_at`); or (b) Extend `dev_profiles` with `bags_creator_id`, `bags_verified`, `bags_updated_at`. Ensures we can show “Bags creator” and “verified” in alerts without hitting the API on every signal.
- **Token metadata enrichment:**
  - We have `token_mint` everywhere but no central human-readable metadata. Add a table for Bags (or generic) token metadata used in alerts, e.g. `token_metadata` or `bags_token_metadata`: `mint`, `name`, `symbol`, `image_url`, `bags_token_id` (if any), `source` (e.g. `bags`), `updated_at`. Populate from Bags (and optionally other sources later) when we enrich; use in Telegram and signals.
- **Partner keys and fee/claim state (if we use partner features):**
  - **Partner key:** For hackathon, a single API key (and optionally a partner key) may live in env only. If we need multiple keys or rotation: table `bags_partner_keys` (e.g. `id`, `key_ref` or hashed identifier, `scope`, `created_at`). Do not store raw secret in DB; reference env or secret manager.
  - **Fee claims / claimable state:** If we show “claimable fees” or “claimed” in the product, we need to store what we fetched from Bags (e.g. claim events or positions). Table such as `bags_fee_claims` or `bags_claim_events`: e.g. `id`, `token_mint`, `position_or_claim_ref`, `amount`, `claimed_at`, `tx_signature`, `updated_at`. Exact fields depend on Bags “claiming fees” and “token claim events” API responses.
- **Enrichment cache / rate-limit state:**
  - To enforce “don’t re-call Bags within TTL,” we need either (a) `last_synced_at` (and optionally `response_hash`) on the tables above, or (b) a small `bags_enrichment_cache` table (e.g. `mint` or `cache_key`, `kind` = token|creator|launch, `last_fetched_at`, `payload` or key fields). Use one consistent approach so the enrichment bridge can enforce TTL and budget.

**Unverified:** Bags API response shapes and exact identifiers (e.g. `bags_launch_id`, `bags_creator_id`) are not confirmed in this brief. Implementation must align with official Bags API documentation and adjust table/column names and types accordingly.

---

## 13. One-paragraph brutal truth

This repo is a working Helius-based Solana launch and alpha signal engine with a Telegram front-end and a stubbed executor; it has no Bags integration, no Bags schema, and no rate-limited enrichment strategy. To become a credible Bags hackathon entry we must add a minimal Bags read-only integration and enrichment layer that stays under 1,000 req/hour, persist Bags-related state (launches, creators, token metadata, optional fee/claim) in the DB, and surface Bags-native intelligence in Telegram first—without claiming live trading, without adding unused infra, and without pretending the current executor or clustering are production-ready. The wedge is signal quality and Bags depth, not full trading automation.

---

## 14. Rules for all future Cursor implementation prompts

- **Do not pretend live trading exists.** The executor’s live path throws. Any “trading” feature must be explicitly paper/mock or out of scope until implemented.
- **Do not build broad dashboards yet.** Telegram-first; no web UI unless explicitly scoped and justified.
- **Prefer Bags-native signal intelligence before full execution.** Alerts and signals that reference Bags tokens, creators, and launches rank higher than generic DEX signals for this pivot.
- **Every phase must create clearer Bags relevance.** If a task does not tie to Bags (API, schema, or UX), call that out and justify or defer it.
- **Avoid adding infra that does not help traction.** No Redis, no queue, no new runtimes unless there is a concrete Bags or rate-limit need and a task to implement it.
- **Code must fit the existing monorepo structure** (apps/api, apps/tg-bot, services/stream, services/engine, services/executor, packages/db, packages/common) unless a change is explicitly justified and documented.
- **Be explicit about mock vs real.** Every Bags API call, every “trade,” every “claim” must be clearly mock/stub or real. No silent stubs.
- **Do not silently depend on Redis or queues that do not exist.** If a design requires Redis or a job queue, the prompt must state it and add the dependency and usage; otherwise use DB polling or in-memory logic consistent with the audit.
- **Every implementation must define a review checkpoint.** Before considering a task done: what to run, what to inspect (logs, DB row, Telegram message), and what “done” means for that phase. No vague “it works.”
- **Respect the enrichment bridge.** No Bags calls for every raw_event. Only enrich mints (or creators) that pass defined filters, use a cache with TTL, and enforce a per-hour request cap (e.g. 800–1000). All Bags usage must go through a single client/module that enforces this.
- **Schema changes must be documented.** New tables or columns for Bags (launches, creators, token metadata, partner/fee, cache) must be listed in a migration or schema doc; do not add columns ad hoc without updating the schema story.
- **Do not introduce Bags response assumptions without docs.** If an endpoint or field is not clearly documented in Bags docs, the brief or prompt must flag it as “to be confirmed from Bags API docs” and handle missing or changed shapes safely.

---

*End of PHASE0 master context.*
