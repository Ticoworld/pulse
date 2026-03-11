/**
 * Phase 11: Harden one-shot signal dedup at the DB level.
 *
 * One-shot signal types (NEW_MINT_SEEN, LIQUIDITY_LIVE) must fire exactly
 * once per token_mint. The engine already has application-level guards, but
 * those are non-atomic. This migration adds a DB-level partial unique index
 * so INSERT ... ON CONFLICT DO NOTHING becomes atomically safe.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/018_signals_oneshot_dedup.sql
 *
 * Idempotent: IF NOT EXISTS guard on index; DELETE only removes actual dupes.
 */

-- Step 1: Remove existing duplicate rows for one-shot types.
-- Keep the EARLIEST row per (type, token_mint).
-- Tie-breaker: created_at ASC, then id ASC (UUID, lexicographic order).
-- Only touches NEW_MINT_SEEN and LIQUIDITY_LIVE. All other types are untouched.

DELETE FROM signals
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY type, token_mint
        ORDER BY created_at ASC, id ASC
      ) AS rn
    FROM signals
    WHERE type IN ('NEW_MINT_SEEN', 'LIQUIDITY_LIVE')
      AND token_mint IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Partial unique index scoped to one-shot signal types only.
-- ALPHA_WALLET_BUY, HIGH_INTEREST_TOKEN, and future repeatable types
-- are NOT constrained by this index.

CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_oneshot_mint_uq
  ON signals (type, token_mint)
  WHERE type IN ('NEW_MINT_SEEN', 'LIQUIDITY_LIVE')
    AND token_mint IS NOT NULL;
