/**
 * Telegram multi-user usage tracking (Phase 8).
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/016_telegram_usage_tracking.sql
 */

CREATE TABLE IF NOT EXISTS telegram_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_command TEXT,
  command_count INTEGER NOT NULL DEFAULT 0,
  is_owner BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telegram_command_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id BIGINT NOT NULL REFERENCES telegram_users(telegram_user_id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  command_args TEXT,
  used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_telegram_command_events_used_at
  ON telegram_command_events (used_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_command_events_user_used_at
  ON telegram_command_events (telegram_user_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_command_events_command_used_at
  ON telegram_command_events (command, used_at DESC);
