/**
 * Create the candidate_signals table and add uniqueness for HIGH_INTEREST_TOKEN.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/007_candidate_signals.sql
 */

CREATE TABLE IF NOT EXISTS candidate_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mint TEXT NOT NULL UNIQUE,
    score INTEGER NOT NULL,
    alpha_wallet_trigger BOOLEAN NOT NULL DEFAULT false,
    liquidity_live_trigger BOOLEAN NOT NULL DEFAULT false,
    dev_trigger BOOLEAN NOT NULL DEFAULT false,
    alpha_wallet TEXT,
    probable_dev_wallet TEXT,
    dev_prior_launches INTEGER,
    dev_liquidity_live_count INTEGER,
    liquidity_live_seq BIGINT,
    alpha_trigger_seq BIGINT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_signals_score ON candidate_signals (score DESC);
CREATE INDEX IF NOT EXISTS idx_candidate_signals_created_at ON candidate_signals (created_at DESC);

-- Explicit uniqueness protection for HIGH_INTEREST_TOKEN in signals
-- This ensures one HIGH_INTEREST_TOKEN signal per mint
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_high_interest_token_unique ON signals (token_mint) 
WHERE type = 'HIGH_INTEREST_TOKEN';
