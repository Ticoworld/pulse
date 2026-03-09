/**
 * Create the watchlist_wallets table.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/003_watchlist_wallets.sql
 */

CREATE TABLE IF NOT EXISTS watchlist_wallets (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT        NOT NULL UNIQUE,
  label          TEXT,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_wallets_active
  ON watchlist_wallets (wallet_address)
  WHERE is_active = true;
