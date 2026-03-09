CREATE TABLE IF NOT EXISTS actors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT,
    actor_type TEXT DEFAULT 'unknown',
    wallet_count INTEGER DEFAULT 0,
    score INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'low',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS actor_wallets (
    actor_id UUID REFERENCES actors(id) ON DELETE CASCADE,
    wallet_address TEXT NOT NULL UNIQUE,
    confidence INTEGER DEFAULT 50,
    method TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_actor_wallets_wallet ON actor_wallets (wallet_address);
CREATE INDEX IF NOT EXISTS idx_actor_wallets_actor ON actor_wallets (actor_id);
