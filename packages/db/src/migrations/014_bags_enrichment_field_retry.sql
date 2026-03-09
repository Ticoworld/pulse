-- Phase 2 retry patch: per-field retry timestamps so partial failures back off independently.
-- Apply after 013_bags_enrichment.sql.

ALTER TABLE bags_token_enrichments
  ADD COLUMN IF NOT EXISTS creators_next_retry_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS fees_next_retry_at timestamptz NULL;
