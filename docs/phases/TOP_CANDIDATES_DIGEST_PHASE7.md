# Top HIGH_INTEREST candidates digest (Phase 7)

One Telegram-first ranked digest of the current **HIGH_INTEREST** candidates by score, using the same threshold as the engine and existing Bags context. No new signal types, no scoring rewrite, no dashboard.

---

## What the command does

- **Command:** `/top_candidates` (owner-only). Optional: `/top_candidates 5` for top 5.
- **Behavior:** Queries the top N **HIGH_INTEREST** candidates (score ≥ threshold) whose `candidate_signals.updated_at` falls within a freshness window (default 24h), joins Bags enrichment when available, and sends one plain-text digest to the owner via the Phase 6 send helper.
- **Default limit:** 10. Optional integer argument caps at 50.
- **Freshness:** Last 24 hours. Only candidates updated in that window are included.

---

## HIGH_INTEREST threshold (source of truth)

- **Constant:** `HIGH_INTEREST_THRESHOLD` in `@pulse/db` (packages/db/src/scoringConstants.ts). Value: **60**.
- **Reuse:** The engine uses this same constant to decide when to emit `HIGH_INTEREST_TOKEN` (see BAGS_SCORING_PHASE5.md). The digest does not define a second threshold; callers pass `HIGH_INTEREST_THRESHOLD` as `minScore` to the DB helper.

---

## Freshness rule

- **Rule:** `candidate_signals.updated_at >= NOW() - 24 hours`.
- **Why:** Ensures the digest reflects recently computed scores and avoids stale/test rows.

---

## Ranking rule

- **Filter:** Only rows with `score >= HIGH_INTEREST_THRESHOLD` (same as engine).
- **Order:** Among those, `ORDER BY score DESC NULLS LAST, updated_at DESC`, then `LIMIT N`.
- **Source:** Existing `candidate_signals` table and scoring path (Phase 5). No second ranking system.

---

## Why this is not a dashboard

- Single on-demand message: the user asks for the digest; nothing is pushed on a schedule.
- No web UI, no charts, no historical series. Telegram is the only surface.
- Data is what the repo already stores (scores, metadata, Bags enrichment). No fake analytics, win rates, or confidence metrics.

---

## Bags fields shown

When a candidate has a resolved Bags enrichment row (`bags_token_enrichments.enrichment_status = 'resolved'`), the digest line includes:

- **Creator:** `primary_creator_display_name` and, if present, `primary_creator_provider` (e.g. twitter).
- **Fees:** `fees_lamports` from the enrichment row.

From `candidate_signals.metadata` (stored at score time):

- **Base score**, **Bags bonus**, and **Bags reasons** (e.g. resolved_context, creator_identity_present, fees_nonzero).

If there is no resolved enrichment for a mint, creator and fees show as "-" and Bags reasons come only from metadata if present.

---

## Output shape (compact)

Each entry is a few lines:

- Rank and mint.
- Final score, base score, Bags bonus; trigger flags (liq, alpha, dev); Bags reasons.
- Creator (display + provider) and fees.

Plain text only; no Markdown to avoid parse issues (Phase 6 consistency).

---

## DB helper

- **Function:** `getTopCandidateSignalsForDigest(limit, sinceHours, minScore)` in `@pulse/db` (`packages/db/src/candidateSignals.ts`).
- **Query:** `candidate_signals` LEFT JOIN `bags_token_enrichments` ON mint and `enrichment_status = 'resolved'`, filtered by `updated_at >= NOW() - sinceHours` **and `score >= minScore`** (caller passes `HIGH_INTEREST_THRESHOLD`), ordered by score desc, limit N.
- **Return type:** `TopCandidateForDigest[]` (signal columns plus enrichment fields).

---

## Formatter and delivery

- **Formatter:** `formatTopCandidatesDigest(rows, opts)` in `apps/tg-bot/src/formatters.ts`. Pure function; returns `FormattedAlert` (text + format "plain").
- **Delivery:** Digest is sent through `createOwnerAlertSender` (Phase 6); same path as signal and execution alerts.

---

## How to test

1. **Typecheck:**  
   `npm run typecheck`

2. **Local digest (no Telegram):**  
   `npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/top-candidates-digest-local.ts`  
   Prints the same formatted digest using current DB data (freshness 24h, limit 10).

3. **Run bot:**  
   `npm run dev:bot`

4. **In Telegram (as owner):**  
   Send `/top_candidates` or `/top_candidates 5`. You should receive one message with the ranked HIGH_INTEREST digest (or "No HIGH_INTEREST candidates in freshness window." if none qualify).

## Sample digest output (after HIGH_INTEREST filter)

```
Top HIGH_INTEREST candidates (last 24h, by score)

1. CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS
   score=62 base=60 bags=2 | liq,alpha | bags: resolved_context,creator_identity_present,fees_nonzero
   creator: PublicFundApp (twitter) | fees: 369655050567

--- end ---
```

(Only candidates with score ≥ 60 appear. Empty result yields "No HIGH_INTEREST candidates in freshness window.")

---

## Boundaries (unchanged)

- No auto-scheduled digest.
- No new signals.
- No scoring logic changes.
- No trading or execution changes.
- No web UI, Redis, queues, or new infra.
