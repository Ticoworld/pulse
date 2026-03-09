/**
 * Create launch_candidates table and make signals.wallet_address nullable.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/005_launch_candidates.sql
 */

BEGIN;

CREATE TABLE IF NOT EXISTS launch_candidates (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mint                   TEXT        NOT NULL UNIQUE,
  first_seen_seq         BIGINT      NOT NULL,
  first_seen_at          TIMESTAMPTZ NOT NULL,
  first_seen_signature   TEXT        NOT NULL,
  liquidity_live_seq     BIGINT,
  liquidity_live_at      TIMESTAMPTZ,
  liquidity_live_signature TEXT,
  first_swap_seq         BIGINT,
  first_swap_at          TIMESTAMPTZ,
  first_swap_signature   TEXT,
  source_program         TEXT,
  status                 TEXT        NOT NULL DEFAULT 'NEW_MINT_SEEN',
  metadata               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_launch_candidates_status
  ON launch_candidates (status);

CREATE INDEX IF NOT EXISTS idx_launch_candidates_first_seen_at
  ON launch_candidates (first_seen_at DESC);

-- Drop NOT NULL constraint on signals.wallet_address
ALTER TABLE signals ALTER COLUMN wallet_address DROP NOT NULL;

-- Strict once-per-mint lifecycle signaling to prevent duplicates without polluting ALPHA_WALLET_BUY
CREATE UNIQUE INDEX IF NOT EXISTS signals_type_mint_uq 
  ON signals (type, token_mint) 
  WHERE type IN ('NEW_MINT_SEEN', 'LIQUIDITY_LIVE');

COMMIT;
