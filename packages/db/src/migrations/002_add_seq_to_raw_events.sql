/**
 * Add a monotonic sequence column to raw_events for reliable engine polling.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/002_add_seq_to_raw_events.sql
 */

ALTER TABLE raw_events
  ADD COLUMN IF NOT EXISTS seq BIGSERIAL;

-- Ensure the seq is always unique (BIGSERIAL sets NOT NULL + DEFAULT, add unique)
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_seq ON raw_events (seq);
