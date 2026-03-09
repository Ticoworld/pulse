# Bags enrichment Phase 2

DB-backed enrichment bridge for existing `launch_candidates`. Bags is **selective enrichment only**; Helius remains the event source.

---

## What the new tables mean

### `bags_token_enrichments`

One row per mint we have attempted to enrich. It stores **what was actually observed** and **when it was fetched**, not a claim about whether the token "is" or "is not" a Bags token.

- **mint** — Token mint (PK).
- **enrichment_status** — Process truth: `pending` (no successful fetch yet), `partial` (creators or fees succeeded, not both), `resolved` (both creators and fees fetched), `error` (both failed; see last_error_*).
- **creators_fetched_at** / **fees_fetched_at** — When we last successfully got creators or fees from Bags.
- **creators_count**, **primary_creator_*** — From Bags getTokenCreators when successful.
- **fees_lamports** — From Bags getTokenLifetimeFees when successful.
- **last_error_code** / **last_error_status** / **last_error_message** — Last failure (Bags or local); used for debugging.
- **next_retry_at** — Legacy: set when both sides failed (status = error); kept for compatibility.
- **creators_next_retry_at** / **fees_next_retry_at** — Per-field retry backoff. When getTokenCreators fails (non-auth, non-stop), we set `creators_next_retry_at = NOW() + 1 hour`; when it succeeds we clear it (null). Same for fees. Selection uses these so partial failures are not retried until backoff has passed.

We do **not** store or infer `is_bags_token`. A row here only means "we called Bags for this mint and stored what came back."

### `bags_token_creators`

Per-mint, per-wallet creator rows from Bags getTokenCreators. Replaced **atomically** (single transaction: DELETE then INSERTs) when we re-fetch creators for a mint. A successful creator fetch with zero rows clears the table for that mint.

---

## Exact selection rules

A mint is selected for enrichment **only** when at least one of these is true:

1. **No enrichment row** — `bags_token_enrichments` has no row for this mint.
2. **Creators need work and retry due** — Creators are missing or stale (NULL or older than creators TTL) **and** (`creators_next_retry_at` is NULL or `creators_next_retry_at <= NOW()`).
3. **Fees need work and retry due** — Fees are missing or stale **and** (`fees_next_retry_at` is NULL or `fees_next_retry_at <= NOW()`).

We do **not** select a mint just because one side is missing if that side is still in backoff (e.g. creators failed last run and `creators_next_retry_at > NOW()`). Partial rows are protected: if only fees failed, we set `fees_next_retry_at` and the mint is not selected for the fees side until that time has passed. Resolved rows are only refreshed when creators or fees are stale by TTL (and then no retry gate applies for the stale side).

Batch order: liquidity_live candidates first, then by newest `created_at`. Limit default 25; optional `--since-hours` restricts to launch_candidates created in the last N hours.

Selection alone is **not** enough: the runner must only call the Bags method(s) for the side(s) that need work. The DB returns **needs_creators** and **needs_fees** per mint; the script calls getTokenCreators only when needs_creators is true and getTokenLifetimeFees only when needs_fees is true. So creators TTL stays 24h in practice: a fees-only refresh does not touch creators, and a creators-only refresh does not touch fees.

---

## Field-aware execution

The runner is **side-aware**. For each selected mint it reads **needs_creators** and **needs_fees** from the selection result:

- **Only getTokenCreators** is called when needs_creators is true.
- **Only getTokenLifetimeFees** is called when needs_fees is true.
- If only fees need work, creators are not called; creators_fetched_at, creator rows, and creators_next_retry_at are left unchanged.
- If only creators need work, fees are not called; fees_fetched_at, fees_lamports, and fees_next_retry_at are left unchanged.

So creators TTL remains 24 hours because fees-only refreshes do not refresh creators. Status and retry fields stay correct for untouched sides.

---

## Retry semantics (field-aware)

- **Per-field backoff:** If getTokenCreators fails with a non-auth, non-stop error, we set `creators_next_retry_at = NOW() + 1 hour`. If getTokenLifetimeFees fails the same way, we set `fees_next_retry_at = NOW() + 1 hour`. If either call **succeeds**, we clear the corresponding retry field (set to null).
- **Selection respects backoff:** A mint is selected for the creators side only when creators are missing/stale **and** (creators_next_retry_at is null or due). Same for fees. So partial rows do not get retried on every run; the failed side backs off for 1 hour.
- **Error rows (both failed):** We set both `creators_next_retry_at` and `fees_next_retry_at`, and `enrichment_status = 'error'`. The mint is not selected until at least one of the retry timestamps is due.
- **Resolved rows:** Only refreshed when creators or fees are stale by TTL; no retry timestamp blocks TTL-based refresh.

---

## Partial vs resolved

- **resolved** — Both getTokenCreators and getTokenLifetimeFees succeeded this run; `creators_fetched_at` and `fees_fetched_at` are set.
- **partial** — One of the two succeeded; the other failed. We preserve existing creator/fees data via COALESCE so a later partial/error run does not null out previously good primary_creator_* or counts.

---

## Zero-creator refresh behavior

When the creator fetch **succeeds** (no Bags error), we always replace the creator set for that mint in one transaction: DELETE all rows for the mint, then INSERT the current list. If the API returns zero creators, we DELETE and insert nothing, so the mint ends with no creator rows. We do **not** leave stale creator rows when the fetch succeeded with an empty list.

---

## Single-mint mode and force

- **`--mint ADDRESS`** — Enrich only this mint. The mint must exist in `launch_candidates`. We apply the **same** selection rules: no row, stale creators, stale fees, or retry due. If the mint exists but does not currently need enrichment, the script logs "mint does not currently need enrichment" and exits 0.
- **`--force`** — Only meaningful with `--mint`. Skips the "needs enrichment" check and runs for that mint even if it would not be selected in batch (e.g. resolved and not stale). Use for re-enriching a single mint on demand.

---

## TTL rules

- **Creators TTL:** 24 hours. After that we may re-fetch creators for that mint.
- **Fees TTL:** 15 minutes. Fees change more often; we refresh more frequently.
- Defaults are in the script; no separate config table.

---

## Stop conditions

- **Local soft cap (BAGS_LOCAL_SOFT_CAP):** Stop the run cleanly (exit 0). Do not call Bags again this run.
- **Real Bags 429 (BAGS_RATE_LIMIT):** Stop the run cleanly (exit 0). Do not burn rate limit.
- **401 / 403:** Stop hard (exit 1). Auth or permissions are broken.
- **Other errors:** Record in last_error_* and set the corresponding creators_next_retry_at or fees_next_retry_at (1 hour). Continue to the next mint.

---

## Row-level error metadata (last_error_*)

`last_error_code`, `last_error_status`, and `last_error_message` must stay consistent with unresolved row state:

- **Clear only when resolved** — We clear `last_error_*` only when the row becomes **resolved** (both creators and fees successfully fetched). We do **not** clear them just because the **attempted** side(s) succeeded this run.
- **Partial / error rows** — If the row remains `partial` or `error` because the other side is still unresolved (e.g. in backoff), we preserve the existing `last_error_*` so the row does not lie about its unresolved failure.
- **New failure** — If we attempt a side and it fails, we update `last_error_*` to that failure (overwriting any prior error for that run).
- So: one-sided success (e.g. fees-only refresh succeeds while creators are still unresolved) must **not** clear `last_error_*`; the row stays partial and keeps the prior unresolved-side error until the row is fully resolved.

---

## Why we do not use `is_bags_token` yet

We don't have a documented Bags API that returns a single "this token is a Bags token" flag. We only have getTokenCreators and getTokenLifetimeFees. A mint can return data (resolved/partial) or fail for many reasons. Inferring "not a Bags token" from a failed call would be wrong. So we store only what we observed and when; later phases can define "Bags token" from this data or from new API surface.

---

## Commands

**Apply migrations (once, in order):**
```bash
psql $DATABASE_URL -f packages/db/src/migrations/013_bags_enrichment.sql
psql $DATABASE_URL -f packages/db/src/migrations/014_bags_enrichment_field_retry.sql
```

**Dry run (no Bags client init, no Bags calls, no DB writes):**
```bash
npm run bags:enrich -- --dry-run
```

**Real run (default limit 25, last 7 days):**
```bash
npm run bags:enrich
```

**Real run, one mint (only if it needs enrichment):**
```bash
npm run bags:enrich -- --mint CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS
```

**Force single mint (ignore selection rules):**
```bash
npm run bags:enrich -- --mint CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS --force
```

**With options:**
```bash
npm run bags:enrich -- --limit 5 --since-hours 48
```

---

## Verification

1. **Dry-run with side flags** — `npm run bags:enrich -- --dry-run` logs per mint: `mint=... needsCreators=true needsFees=false` (or both true, or only needsFees). Does not require Bags env.
2. **Single-side refresh** — Create a row where only fees need work (e.g. resolved row with fees_fetched_at stale by 15 min, creators_fetched_at fresh). Run real enrich; logs should show `attempted: fees` only for that mint. SQL after: `creators_fetched_at` should be unchanged from before.
3. **Error rows skipped** — Run once (e.g. `--limit 2`), then run again immediately. Mints that just got status `error` should not be selected; second run processes fewer mints.
4. **Partial rows skipped** — Partial row with fees_next_retry_at in future must not be selected for the fees side until retry is due.
5. **Resolved only by TTL** — Resolved rows are selected only when creators or fees are stale by TTL.
6. **One-sided refresh and error metadata** — Set a mint to partial with only fees needing work (e.g. `creators_fetched_at` null, `creators_next_retry_at` in future, `fees_fetched_at` null, `last_error_*` set). Run `npm run bags:enrich -- --mint <mint>`. Terminal must show `needsCreators=false needsFees=true` and `attempted: fees`. SQL after: `creators_fetched_at` unchanged; `last_error_*` reflects the attempted side (updated if that side failed, or preserved if that side succeeded and row stays partial).
