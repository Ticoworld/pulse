/**
 * Phase 9: followed-mint retention alerts.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/017_follow_alerts_phase9.sql
 */

CREATE TABLE IF NOT EXISTS telegram_user_mint_follows (
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  mint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (telegram_user_id, mint)
);

CREATE INDEX IF NOT EXISTS idx_telegram_user_mint_follows_mint
  ON telegram_user_mint_follows (mint);

CREATE TABLE IF NOT EXISTS telegram_signal_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  signal_id UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  delivery_kind TEXT NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_signal_deliveries_unique
  ON telegram_signal_deliveries (telegram_user_id, signal_id, delivery_kind);

CREATE INDEX IF NOT EXISTS idx_telegram_signal_deliveries_signal_kind
  ON telegram_signal_deliveries (signal_id, delivery_kind);
