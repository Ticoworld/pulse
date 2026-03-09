-- packages/db/src/migrations/002_raw_events_fix.sql

-- 1. Drop existing primary key on 'id' if there is one
ALTER TABLE raw_events DROP CONSTRAINT IF EXISTS raw_events_pkey CASCADE;

-- 2. Add 'seq' column as new primary key
ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS seq BIGSERIAL PRIMARY KEY;

-- 3. Ensure 'id' is unique and auto-generates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'raw_events_id_unique' AND conrelid = 'raw_events'::regclass
  ) THEN
    ALTER TABLE raw_events ADD CONSTRAINT raw_events_id_unique UNIQUE (id);
  END IF;
END $$;

ALTER TABLE raw_events ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE raw_events ALTER COLUMN id SET NOT NULL;

-- 4. Add 'event_key' column for pure external deduplication
ALTER TABLE raw_events ADD COLUMN IF NOT EXISTS event_key TEXT;

-- 5. Backfill event_key for existing rows
UPDATE raw_events SET event_key = CONCAT(signature, ':', event_type, ':', COALESCE(wallet_address, ''), ':', COALESCE(token_mint, '')) WHERE event_key IS NULL;

-- 6. Make event_key NOT NULL and UNIQUE
ALTER TABLE raw_events ALTER COLUMN event_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'raw_events_event_key_unique' AND conrelid = 'raw_events'::regclass
  ) THEN
    ALTER TABLE raw_events ADD CONSTRAINT raw_events_event_key_unique UNIQUE (event_key);
  END IF;
END $$;
