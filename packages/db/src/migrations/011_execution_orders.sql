CREATE TABLE IF NOT EXISTS execution_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_mint TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    signal_id UUID,
    candidate_score INTEGER,
    alpha_wallet TEXT,
    probable_dev_wallet TEXT,
    actor_id UUID,
    side TEXT NOT NULL DEFAULT 'buy',
    status TEXT NOT NULL DEFAULT 'pending',
    amount_sol NUMERIC NOT NULL,
    max_slippage_bps INTEGER NOT NULL,
    priority_fee_lamports BIGINT,
    tx_signature TEXT,
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at TIMESTAMPTZ,
    submitted_notified_at TIMESTAMPTZ,
    confirmed_notified_at TIMESTAMPTZ,
    failed_notified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_exec_orders_status ON execution_orders(status);
CREATE INDEX IF NOT EXISTS idx_exec_orders_created ON execution_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_orders_mint ON execution_orders(token_mint);
CREATE INDEX IF NOT EXISTS idx_exec_orders_sig ON execution_orders(tx_signature);

-- Prevent duplicate active buy orders for the same mint currently in-flight
CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_orders_active_buy ON execution_orders(token_mint, side)
WHERE side = 'buy' AND status IN ('pending', 'submitted');
