/**
 * Bags enrichment cache for launch candidates (Phase 2).
 * Apply: psql $DATABASE_URL -f packages/db/src/migrations/013_bags_enrichment.sql
 */

CREATE TABLE IF NOT EXISTS bags_token_enrichments (
  mint                        TEXT PRIMARY KEY,
  enrichment_status           TEXT NOT NULL,
  creators_fetched_at          TIMESTAMPTZ,
  fees_fetched_at              TIMESTAMPTZ,
  creators_count               INTEGER,
  primary_creator_wallet       TEXT,
  primary_creator_display_name TEXT,
  primary_creator_provider    TEXT,
  primary_creator_royalty_bps INTEGER,
  fees_lamports               BIGINT,
  last_error_code             TEXT,
  last_error_status           INTEGER,
  last_error_message          TEXT,
  next_retry_at               TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bags_enrichments_status ON bags_token_enrichments (enrichment_status);
CREATE INDEX IF NOT EXISTS idx_bags_enrichments_creators_fetched ON bags_token_enrichments (creators_fetched_at) WHERE creators_fetched_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bags_enrichments_fees_fetched ON bags_token_enrichments (fees_fetched_at) WHERE fees_fetched_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS bags_token_creators (
  mint         TEXT NOT NULL,
  wallet       TEXT NOT NULL,
  is_creator   BOOLEAN NOT NULL DEFAULT false,
  display_name TEXT,
  provider     TEXT,
  pfp          TEXT,
  royalty_bps  INTEGER NOT NULL DEFAULT 0,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (mint, wallet)
);

CREATE INDEX IF NOT EXISTS idx_bags_creators_mint ON bags_token_creators (mint);
