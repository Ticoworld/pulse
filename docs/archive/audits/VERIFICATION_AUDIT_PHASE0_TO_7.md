# Verification Audit: Phases 0–7 (Bags pivot)

**Date:** 2026-03-08  
**Method:** Direct file inspection, rerun-able commands, code-as-truth. No code was modified.

---

## A. Executive verdict

- **Phases 0–7:** Implementation is **largely present in code** and matches phase intents where verified.
- **Typecheck:** Passes. **Bags smoke:** Script is wired; runtime proof requires `BAGS_SMOKE_MINT` (not run with a real mint in this audit). **Enrichment dry-run:** Run successfully; uses shared runner; field-aware selection confirmed. **tg-format smoke:** Run successfully; EXIT CONFIRMED and others are plain text. **Phase 7 local digest:** Run successfully with DB; returns HIGH_INTEREST-only rows.
- **Migrations:** 001–015 exist on disk (013, 014, 015 for Bags). Migration runner is ad-hoc (run-migration.ts is hardcoded to 002); application of 013/014/015 is **not** re-run in this audit (manual `psql`).
- **Docs vs code:** No material contradictions found. Some doc claims (e.g. “single source of truth”) are consistent with code; others (e.g. “engine SIGTERM bug”) were not re-tested.
- **Verdict:** **PARTIALLY VERIFIED** overall. Core artifacts exist and key commands run; Bags smoke with a live mint and DB migration application are **UNVERIFIED** in this run.

---

## B. Trust ladder: reliable vs unreliable

| Reliable (used as evidence) | Unreliable (not used as proof) |
|-----------------------------|----------------------------------|
| `packages/bags`, `packages/db`, `packages/bags-enricher`, `apps/tg-bot`, `services/engine`, `services/bags-enricher` .ts source | All .md phase docs and PM signoff files |
| `packages/db/src/migrations/*.sql` (read via shell) | Claims in PHASE0_MASTER_CONTEXT, ARCHITECTURE_AUDIT, etc. |
| `npm run typecheck` | “Single source of truth” until code shows single import/constant |
| `scripts/tg-format-smoke.ts` output | Migration “order” or “runner” beyond what run-migration.ts does |
| `npm run bags:enrich -- --dry-run` output | Any claim that “runtime proof” exists without rerunning the command |
| `scripts/top-candidates-digest-local.ts` output (with DB) | Telegram delivery (no bot/network run in audit) |

---

## C. Phase-by-phase verdict

| Phase | Verdict | Notes |
|-------|---------|--------|
| 0 | **PARTIALLY VERIFIED** | Repo structure and phase artifacts exist; no code “phase 0” to verify. |
| 1 | **PARTIALLY VERIFIED** | Client, rate guard, types, smoke script exist and are wired; Bags smoke not run with mint. |
| 2 | **VERIFIED** | Migrations 013/014 exist; selection and retry are field-aware; runner side-aware; creator replace is atomic. |
| 3 | **VERIFIED** | Shared runner in packages; service reuses it; interruptible sleep + wake in code. |
| 4 | **VERIFIED** | BAGS_ENRICHMENT_RESOLVED in runner and bot; 015 partial unique index; formatter branch. |
| 5 | **VERIFIED** | Bags bonus in engine, capped; metadata and HIGH_INTEREST payload have Bags fields; threshold in db. |
| 6 | **VERIFIED** | Centralized send helper; formatter module; EXIT CONFIRMED plain; alerts via helper/formatter. |
| 7 | **VERIFIED** | /top_candidates exists; digest helper with score filter and freshness; formatter; local digest run. |

---

## D. Exact file evidence for each verdict

**Phase 0**  
- `package.json`: workspaces `apps/*`, `packages/*`, `services/*`.  
- Presence of: `packages/bags`, `packages/db`, `packages/bags-enricher`, `packages/common`, `apps/api`, `apps/tg-bot`, `services/stream`, `services/engine`, `services/bags-enricher`, `scripts/bags-smoke-readonly.ts`, `scripts/bags-enrich-launch-candidates.ts`, `scripts/tg-format-smoke.ts`, `scripts/top-candidates-digest-local.ts`.

**Phase 1**  
- `packages/bags/src/client.ts`: BagsClient, getTokenCreators, getTokenLifetimeFees; BAGS_LOCAL_SOFT_CAP when guard.allow() false; toBagsError returns BAGS_RATE_LIMIT for 429.  
- `packages/bags/src/rateGuard.ts`: BagsRateGuard, soft cap per hour, no HTTP.  
- `packages/bags/src/types.ts`: BagsClientError, isBagsLocalSoftCap, isBagsRateLimit; comment that local soft cap is distinct from Bags 429.  
- `scripts/bags-smoke-readonly.ts`: uses getBagsClient, getTokenCreators, getTokenLifetimeFees, isBagsLocalSoftCap, isBagsRateLimit.  
- `package.json` script: `"bags:smoke": "npx ts-node -r dotenv/config ... scripts/bags-smoke-readonly.ts"`.

**Phase 2**  
- `packages/db/src/migrations/013_bags_enrichment.sql`: bags_token_enrichments, bags_token_creators.  
- `packages/db/src/migrations/014_bags_enrichment_field_retry.sql`: creators_next_retry_at, fees_next_retry_at.  
- `packages/db/src/bagsEnrichment.ts`: getLaunchCandidatesNeedingEnrichment returns needs_creators, needs_fees; per-field retry columns used.  
- `packages/bags-enricher/src/runner.ts`: branches on needs_creators / needs_fees; getTokenCreators / getTokenLifetimeFees; creatorsNextRetryAt, feesNextRetryAt set per side.  
- `packages/db/src/bagsEnrichment.ts`: replaceBagsCreatorsForMint uses withTransaction, DELETE FROM bags_token_creators WHERE mint, then INSERTs.

**Phase 3**  
- `packages/bags-enricher/src/runner.ts`: runEnrichment exported.  
- `packages/bags-enricher/src/index.ts`: re-exports runEnrichment.  
- `services/bags-enricher/src/index.ts`: imports runEnrichment from @pulse/bags-enricher; runCycle calls runEnrichment(...).  
- createInterruptibleSleep(): returns sleep(ms) and wake(); wake() clears timer and resolves promise; shutdown handler calls wakeSleep(); await interruptibleSleep(sleepMs) then if (shutdown) exit.

**Phase 4**  
- `packages/bags-enricher/src/runner.ts`: BAGS_ENRICHMENT_RESOLVED_SIGNAL, insertSignal({ type: BAGS_ENRICHMENT_RESOLVED_SIGNAL, ... }).  
- `packages/db/src/migrations/015_bags_enrichment_resolved_signal.sql`: CREATE UNIQUE INDEX ... ON signals (token_mint) WHERE type = 'BAGS_ENRICHMENT_RESOLVED'.  
- `packages/db/src/signals.ts`: INSERT ... ON CONFLICT DO NOTHING (any unique violation ignored; 015 index enforces one per mint).  
- `apps/tg-bot/src/index.ts`: if (signal.type === "BAGS_ENRICHMENT_RESOLVED") return formatBagsEnrichmentResolvedSignal(signal).  
- `apps/tg-bot/src/formatters.ts`: formatBagsEnrichmentResolvedSignal.

**Phase 5**  
- `services/engine/src/candidateEngine.ts`: imports HIGH_INTEREST_THRESHOLD from @pulse/db; BAGS_BONUS_CAP = Math.min(floor(HIGH_INTEREST_THRESHOLD*0.2), 2); baseScore, bagsBonus, finalScore; metadata: base_score, bags_bonus, bags_bonus_cap, bags_bonus_components, bags_reasons, final_score; insertSignal HIGH_INTEREST_TOKEN payload: base_score, bags_bonus, bags_bonus_cap, bags_reasons, primary_creator_display_name, primary_creator_provider, fees_lamports.  
- `packages/db/src/scoringConstants.ts`: HIGH_INTEREST_THRESHOLD = 60.

**Phase 6**  
- `apps/tg-bot/src/alertSender.ts`: createOwnerAlertSender, sendOwnerAlert(alert), options.parse_mode = "Markdown" only if alert.format === "markdown".  
- `apps/tg-bot/src/formatters.ts`: formatExitConfirmed returns { text: lines.join("\n"), format: "plain", ... }; no Markdown in body.  
- `apps/tg-bot/src/index.ts`: sendOwnerAlert = createOwnerAlertSender(...); formatBuySubmitted, formatExitConfirmed, etc., passed to sendOwnerAlert; execution and signal alerts go through formatter then sendOwnerAlert.

**Phase 7**  
- `apps/tg-bot/src/index.ts`: bot.onText(/\/top_candidates...); getTopCandidateSignalsForDigest(limit, TOP_CANDIDATES_FRESHNESS_HOURS, HIGH_INTEREST_THRESHOLD); formatTopCandidatesDigest(..., { title: "Top HIGH_INTEREST candidates", ... }); sendOwnerAlert(...).  
- `packages/db/src/candidateSignals.ts`: getTopCandidateSignalsForDigest(limit, sinceHours, minScore); WHERE ... AND cs.score >= $3; ORDER BY cs.score DESC; LEFT JOIN bags_token_enrichments.  
- `apps/tg-bot/src/formatters.ts`: formatTopCandidatesDigest, title default "Top HIGH_INTEREST candidates", empty "No HIGH_INTEREST candidates in freshness window."

---

## E. Exact commands run

| Command | Result |
|---------|--------|
| `npm run typecheck` | Exit 0; all workspaces typecheck. |
| `npm run bags:smoke` | Exit 1; "Usage: provide mint as first CLI arg or set BAGS_SMOKE_MINT". Script wired; no mint provided. |
| `npm run bags:enrich -- --dry-run` | Exit 0; "[bags-enrich] mints to process: 14", field-aware needsCreators/needsFees per mint. |
| `npx ts-node -r tsconfig-paths/register --project tsconfig.json scripts/tg-format-smoke.ts` | Exit 0; EXIT CONFIRMED and other formats printed as plain text. |
| `npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/top-candidates-digest-local.ts` | Exit 0; "Top HIGH_INTEREST candidates (last 24h, by score)" and one row (score=62, base=60, bags=2). |
| `test -d packages/db/src/migrations && ls packages/db/src/migrations` | Migrations 001–015 listed. |
| `head -80 packages/db/src/migrations/004_signals.sql` | signals table, signals_type_sig_wallet_uq. |
| `head -50 packages/db/src/migrations/015_bags_enrichment_resolved_signal.sql` | Partial unique index on (token_mint) WHERE type = 'BAGS_ENRICHMENT_RESOLVED'. |
| `head -70 packages/db/src/migrations/013_bags_enrichment.sql` | bags_token_enrichments, bags_token_creators. |
| `cat packages/db/src/migrations/014_bags_enrichment_field_retry.sql` | creators_next_retry_at, fees_next_retry_at. |

---

## F. Exact SQL queries run

**None.** No `psql` or programmatic SQL was run against a live database in this audit. Migration application (e.g. `psql $DATABASE_URL -f ...`) is documented but not re-executed. The Phase 7 digest script did run and returned data (so DB was used by that script in the environment where it was run); no ad-hoc SQL was executed for the audit.

---

## G. Mismatches between docs and code

- **None identified.** Spot checks: TOP_CANDIDATES_DIGEST_PHASE7.md describes HIGH_INTEREST filter and threshold in @pulse/db; code has getTopCandidateSignalsForDigest(..., minScore) and scoringConstants.ts. BAGS_SCORING_PHASE5.md describes cap and metadata; candidateEngine and upsertCandidateSignal match. TELEGRAM_DELIVERY_HARDENING_PHASE6.md describes plain text and centralized sender; formatters and alertSender match.
- **Caveat:** Only a subset of doc claims were line-by-line checked. Broader claims (e.g. “no second scoring path”) are consistent with code inspection but not exhaustively proven.

---

## H. Runtime proofs missing

1. **Bags smoke with real mint:** `npm run bags:smoke` was not run with BAGS_SMOKE_MINT or CLI mint; exit was usage error. So “smoke script works against Bags API” is **not** proved in this audit.
2. **Migrations applied:** No check that 013, 014, 015 have been applied to the DB (e.g. table/column existence). Dry-run and Phase 7 digest succeeded, which implies bags_token_enrichments and candidate_signals exist; migration order/application not verified.
3. **Telegram delivery:** No bot run, no message send. EXIT CONFIRMED and /top_candidates delivery are **not** runtime-verified here.
4. **Engine SIGTERM:** PHASE0/ARCHITECTURE_AUDIT mention “engine SIGTERM handler bug”; engine shutdown was not tested.
5. **Shutdown-during-sleep:** Phase 3 interruptible sleep is in code; no signal was sent to the service in this audit to confirm prompt exit.

---

## I. Top 10 remaining technical risks

1. **Migration drift:** No ordered runner; 013/014/015 applied manually; risk of inconsistent schema across envs.
2. **Bags smoke not in CI:** Smoke requires mint and Bags API; no evidence it’s run in a pipeline.
3. **Engine SIGTERM:** Doc claims a bug; code not re-audited for correct shutdown.
4. **insertSignal ON CONFLICT:** Relies on generic DO NOTHING; if another unique constraint is added, behavior may change without explicit conflict target.
5. **Single process rate guard:** Bags soft cap is in-process; multiple workers would each have their own cap.
6. **No health checks:** Stream/engine/executor/DB not verified via health endpoints in this audit.
7. **Telegram token in env:** No verification of how token is loaded or redaction in logs beyond alertSender.
8. **Phase 7 digest and DB:** Depends on candidate_signals.updated_at and score; stale or missing data could yield empty digest without a clear “no data” story.
9. **run-migration.ts:** Hardcoded to 002; other migrations not run by this script; easy to assume “migrations run” when they don’t.
10. **.cursorignore and migrations:** Migrations exist on disk but may be ignored by some tooling; visibility for future audits.

---

## J. What is real today in one paragraph

The repo has a shared Bags client (read-only, SDK-based, local soft cap vs Bags 429), field-aware Bags enrichment (tables and retry columns in migrations 013/014, selection and runner in code), a shared runEnrichment in packages/bags-enricher used by both the CLI and the bags-enricher service, and an interruptible-sleep shutdown path in the service. BAGS_ENRICHMENT_RESOLVED is emitted by the runner and deduped by a partial unique index (015); the bot has a formatter and branch for it. Candidate scoring adds an explicit, capped Bags bonus and stores base_score, bags_bonus, and final_score in candidate_signals.metadata; HIGH_INTEREST payload includes Bags fields; HIGH_INTEREST_THRESHOLD lives in @pulse/db and is used by the engine and the digest. The Telegram bot uses a single send helper and a formatter module; EXIT CONFIRMED and other execution alerts are plain text. The /top_candidates command calls a DB helper that filters by score >= HIGH_INTEREST_THRESHOLD and 24h freshness, and sends a plain-text digest via the same helper. Typecheck, enrichment dry-run, tg-format smoke, and the Phase 7 local digest script all ran successfully in this audit.

---

## K. What is still story, not proof, in one paragraph

That the Bags smoke script “proves” the client against the real Bags API was not shown (no mint supplied). That migrations 013/014/015 are applied in any environment was not verified by querying the DB. That the bot actually sends EXIT CONFIRMED or /top_candidates messages in Telegram was not verified by running the bot or capturing messages. That the engine shuts down correctly on SIGTERM or that the bags-enricher service exits promptly when signaled during sleep was not tested. Doc claims such as “single source of truth” and “no second ranking path” are consistent with the code inspected but were not exhaustively proven. Any PM signoff or phase doc that states “runtime proof” or “verified” for these scenarios is therefore not independently confirmed by this audit’s runs.
