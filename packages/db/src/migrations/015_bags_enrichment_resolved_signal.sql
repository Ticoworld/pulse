/**
 * Ensure one BAGS_ENRICHMENT_RESOLVED signal per mint.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/015_bags_enrichment_resolved_signal.sql
 */

CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_bags_enrichment_resolved_unique
  ON signals (token_mint)
  WHERE type = 'BAGS_ENRICHMENT_RESOLVED';
