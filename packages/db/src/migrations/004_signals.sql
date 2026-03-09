/**
 * Create the signals table.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/004_signals.sql
 */

CREATE TABLE IF NOT EXISTS signals (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type           TEXT        NOT NULL,                   -- e.g. 'ALPHA_WALLET_BUY'
  wallet_address TEXT        NOT NULL,
  token_mint     TEXT,
  signature      TEXT        NOT NULL,
  slot           BIGINT      NOT NULL,
  confidence     NUMERIC,
  payload        JSONB       NOT NULL DEFAULT '{}',
  is_sent        BOOLEAN     NOT NULL DEFAULT false,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dedupe per detected actor + transaction, not just per transaction
  CONSTRAINT signals_type_sig_wallet_uq UNIQUE (type, signature, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_signals_unsent
  ON signals (created_at ASC)
  WHERE is_sent = false;

CREATE INDEX IF NOT EXISTS idx_signals_wallet
  ON signals (wallet_address);

CREATE INDEX IF NOT EXISTS idx_signals_token_mint
  ON signals (token_mint);
