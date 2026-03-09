CREATE TABLE IF NOT EXISTS positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_mint TEXT NOT NULL,
    buy_order_id UUID REFERENCES execution_orders(id) ON DELETE SET NULL,
    entry_tx_signature TEXT,
    entry_amount_sol NUMERIC NOT NULL,
    entry_token_amount NUMERIC,
    entry_price_usd NUMERIC,
    status TEXT NOT NULL DEFAULT 'open',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_positions_status ON positions(status);
CREATE INDEX idx_positions_mint ON positions(token_mint);
CREATE INDEX idx_positions_opened ON positions(opened_at DESC);

-- Prevent duplicate positions from the same buy order (idempotency)
CREATE UNIQUE INDEX idx_positions_buy_order ON positions(buy_order_id) WHERE buy_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS exit_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    position_id UUID REFERENCES positions(id) ON DELETE CASCADE,
    token_mint TEXT NOT NULL,
    reason TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'sell',
    status TEXT NOT NULL DEFAULT 'pending',
    sell_percentage INTEGER NOT NULL,
    target_description TEXT,
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

CREATE INDEX idx_exit_orders_status ON exit_orders(status);
CREATE INDEX idx_exit_orders_position ON exit_orders(position_id);
CREATE INDEX idx_exit_orders_mint ON exit_orders(token_mint);

-- Prevent duplicate active exit orders for the same position & reason
CREATE UNIQUE INDEX idx_exit_orders_active 
ON exit_orders(position_id, reason) 
WHERE status IN ('pending', 'submitted');
