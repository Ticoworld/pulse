/**
 * Run this once against your Postgres instance to create the raw_events table.
 *
 *   psql $DATABASE_URL -f packages/db/src/migrations/001_raw_events.sql
 *
 * Or paste into a Postgres client directly.
 */

CREATE TABLE IF NOT EXISTS raw_events (
  seq           BIGSERIAL PRIMARY KEY,
  id            UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  event_key     TEXT UNIQUE NOT NULL,
  source        TEXT        NOT NULL,          -- e.g. 'helius'
  event_type    TEXT        NOT NULL,          -- 'SWAP' | 'TOKEN_MINT' etc.
  signature     TEXT        NOT NULL,
  slot          BIGINT      NOT NULL,
  wallet_address TEXT,
  token_mint    TEXT,
  amount        NUMERIC,
  ts            TIMESTAMPTZ NOT NULL,
  raw_payload   JSONB       NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_events_event_type  ON raw_events (event_type);
CREATE INDEX IF NOT EXISTS idx_raw_events_token_mint  ON raw_events (token_mint);
CREATE INDEX IF NOT EXISTS idx_raw_events_wallet      ON raw_events (wallet_address);
CREATE INDEX IF NOT EXISTS idx_raw_events_ts          ON raw_events (ts DESC);
