import { query } from "./client";
import { getExecutionOrder } from "./executionOrders";

export interface Position {
  id: string;
  token_mint: string;
  buy_order_id: string | null;
  entry_tx_signature: string | null;
  entry_amount_sol: number;
  entry_token_amount: number | null;
  entry_price_usd: number | null;
  status: "open" | "closed";
  opened_at: Date;
  closed_at: Date | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Creates an open position strictly from a confirmed execution buy order.
 * Safe to retry because of the unique index on buy_order_id.
 * If position already exists for this order, it safely skips and returns the existing one.
 */
export async function createPositionFromBuyOrder(
  buyOrderId: string,
): Promise<Position> {
  const buyOrder = await getExecutionOrder(buyOrderId);
  if (!buyOrder) throw new Error("Buy order not found");
  if (buyOrder.status !== "confirmed")
    throw new Error("Buy order must be confirmed to open a position");

  // Try to insert, ignoring conflicts on unique buy_order_id
  const sql = `
    INSERT INTO positions (
      token_mint, buy_order_id, entry_tx_signature, entry_amount_sol, 
      entry_token_amount, entry_price_usd, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (buy_order_id) DO NOTHING
    RETURNING *;
  `;

  const res = await query<Position>(sql, [
    buyOrder.token_mint,
    buyOrder.id,
    buyOrder.tx_signature,
    buyOrder.amount_sol,
    null, // entry_token_amount: Not populated yet in v1
    null, // entry_price_usd: Not populated yet in v1
    JSON.stringify({}), // Future metadata
  ]);

  if (res.rowCount && res.rowCount > 0) {
    return res.rows[0];
  }

  // If it returned nothing, it means ON CONFLICT DO NOTHING triggered, fetch existing
  const existingSql = `SELECT * FROM positions WHERE buy_order_id = $1`;
  const existingRes = await query<Position>(existingSql, [buyOrderId]);
  if (!existingRes.rows[0])
    throw new Error(
      "Position creation yielded no row, but fallback lookup also failed.",
    );

  return existingRes.rows[0];
}

export async function getPosition(id: string): Promise<Position | null> {
  const res = await query<Position>("SELECT * FROM positions WHERE id = $1", [
    id,
  ]);
  return res.rows[0] || null;
}

export async function getOpenPositionByMint(
  mint: string,
): Promise<Position | null> {
  const res = await query<Position>(
    "SELECT * FROM positions WHERE token_mint = $1 AND status = 'open'",
    [mint],
  );
  return res.rows[0] || null;
}

export async function listOpenPositions(limit = 100): Promise<Position[]> {
  const res = await query<Position>(
    "SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC LIMIT $1",
    [limit],
  );
  return res.rows;
}

/**
 * Checks for a recently closed position for the same mint.
 * Used for the cooldown guard.
 */
export async function getRecentlyClosedPositionByMint(
  mint: string,
  cooldownMinutes: number,
): Promise<Position | null> {
  const res = await query<Position>(
    `SELECT * FROM positions 
     WHERE token_mint = $1 AND status = 'closed' AND closed_at >= NOW() - INTERVAL '1 minute' * $2
     ORDER BY closed_at DESC LIMIT 1`,
    [mint, cooldownMinutes],
  );
  return res.rows[0] || null;
}

export async function markPositionClosed(id: string): Promise<void> {
  await query(
    "UPDATE positions SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1",
    [id],
  );
}

/**
 * Hard guard for the executor. Checks how many positions are currently open.
 */
export async function getOpenPositionsCount(): Promise<number> {
  const res = await query<{ count: string }>(
    "SELECT COUNT(*) FROM positions WHERE status = 'open'",
  );
  return parseInt(res.rows[0].count, 10);
}
