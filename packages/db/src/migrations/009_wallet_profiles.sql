/**
 * Create the wallet_profiles table.
 *
 * Apply:
 *   psql $DATABASE_URL -f packages/db/src/migrations/009_wallet_profiles.sql
 */

CREATE TABLE IF NOT EXISTS wallet_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address TEXT NOT NULL UNIQUE,
    watchlist_label TEXT,
    total_alpha_buys INTEGER NOT NULL DEFAULT 0, -- Distinct mints
    total_candidate_hits INTEGER NOT NULL DEFAULT 0, -- Distinct mints
    total_high_interest_hits INTEGER NOT NULL DEFAULT 0, -- Distinct mints
    total_launch_mint_hits INTEGER NOT NULL DEFAULT 0, -- Distinct mints
    avg_entry_delay_seconds INTEGER,
    first_seen_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    score INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'low',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wallet_profiles_score ON wallet_profiles (score DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_profiles_tier ON wallet_profiles (tier);
CREATE INDEX IF NOT EXISTS idx_wallet_profiles_high_interest_hits ON wallet_profiles (total_high_interest_hits DESC);
