/**
 * Create dev_profiles and launch_dev_links tables.
 * 
 * Apply:
 *   node -e "const { Client } = require('pg'); const fs = require('fs'); const sql = fs.readFileSync('packages/db/src/migrations/006_dev_tracking.sql', 'utf8'); const c = new Client({ connectionString: process.env.DATABASE_URL }); c.connect().then(() => c.query(sql)).then(() => console.log('Success')).catch(console.error).finally(() => c.end());"
 */

BEGIN;

CREATE TABLE IF NOT EXISTS dev_profiles (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dev_wallet                  TEXT        NOT NULL UNIQUE,
  launch_count                INTEGER     NOT NULL DEFAULT 0,
  liquidity_live_count        INTEGER     NOT NULL DEFAULT 0,
  last_seen_at                TIMESTAMPTZ,
  avg_time_to_liquidity_seconds INTEGER,
  metadata                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dev_profiles_launch_count ON dev_profiles (launch_count DESC);
CREATE INDEX IF NOT EXISTS idx_dev_profiles_liquidity_live_count ON dev_profiles (liquidity_live_count DESC);

CREATE TABLE IF NOT EXISTS launch_dev_links (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mint                TEXT        NOT NULL UNIQUE,
  deployer_wallet     TEXT,
  funder_wallet       TEXT,
  probable_dev_wallet TEXT,
  confidence          TEXT        NOT NULL DEFAULT 'low',
  method              TEXT        NOT NULL DEFAULT 'unknown',
  linked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_launch_dev_links_probable_dev ON launch_dev_links (probable_dev_wallet);
CREATE INDEX IF NOT EXISTS idx_launch_dev_links_deployer ON launch_dev_links (deployer_wallet);
CREATE INDEX IF NOT EXISTS idx_launch_dev_links_funder ON launch_dev_links (funder_wallet);

COMMIT;
