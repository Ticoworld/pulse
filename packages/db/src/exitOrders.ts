import { query } from "./client";

export interface ExitOrder {
  id: string;
  position_id: string;
  token_mint: string;
  reason: string;
  side: "sell";
  status: "pending" | "submitted" | "confirmed" | "failed";
  sell_percentage: number;
  target_description: string | null;
  tx_signature: string | null;
  error_message: string | null;
  metadata: Record<string, any>;
  created_at: Date;
  updated_at: Date;
  executed_at: Date | null;
  submitted_notified_at: Date | null;
  confirmed_notified_at: Date | null;
  failed_notified_at: Date | null;
}

export type ExitOrderInsert = {
  positionId: string;
  tokenMint: string;
  reason: string;
  sellPercentage: number;
  targetDescription?: string;
  metadata?: Record<string, any>;
};

export async function createExitOrder(
  data: ExitOrderInsert,
): Promise<ExitOrder> {
  const sql = `
    INSERT INTO exit_orders (
      position_id, token_mint, reason, sell_percentage, target_description, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;
  const res = await query<ExitOrder>(sql, [
    data.positionId,
    data.tokenMint,
    data.reason,
    data.sellPercentage,
    data.targetDescription || null,
    JSON.stringify(data.metadata || {}),
  ]);
  return res.rows[0];
}

export async function getExitOrder(id: string): Promise<ExitOrder | null> {
  const res = await query<ExitOrder>(
    "SELECT * FROM exit_orders WHERE id = $1",
    [id],
  );
  return res.rows[0] || null;
}

export async function listPendingExitOrders(limit = 50): Promise<ExitOrder[]> {
  const res = await query<ExitOrder>(
    "SELECT * FROM exit_orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1",
    [limit],
  );
  return res.rows;
}

export async function getActiveExitOrderByPositionAndReason(
  positionId: string,
  reason: string,
): Promise<ExitOrder | null> {
  const res = await query<ExitOrder>(
    "SELECT * FROM exit_orders WHERE position_id = $1 AND reason = $2 AND status IN ('pending', 'submitted')",
    [positionId, reason],
  );
  return res.rows[0] || null;
}

export async function markExitOrderSubmitted(
  id: string,
  txSignature: string,
): Promise<void> {
  await query(
    "UPDATE exit_orders SET status = 'submitted', tx_signature = $1, updated_at = NOW(), executed_at = NOW() WHERE id = $2",
    [txSignature, id],
  );
}

export async function markExitOrderConfirmed(
  id: string,
  txSignature?: string,
): Promise<void> {
  if (txSignature) {
    await query(
      "UPDATE exit_orders SET status = 'confirmed', tx_signature = $1, updated_at = NOW() WHERE id = $2",
      [txSignature, id],
    );
  } else {
    await query(
      "UPDATE exit_orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1",
      [id],
    );
  }
}

export async function markExitOrderFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  await query(
    "UPDATE exit_orders SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2",
    [errorMessage, id],
  );
}

// ─── NOTIFICATIONS ─────────────────────────────────────────────────────────────

export async function listUnnotifiedExitOrders(
  limit = 100,
): Promise<ExitOrder[]> {
  const sql = `
    SELECT * FROM exit_orders
    WHERE 
      (status = 'submitted' AND submitted_notified_at IS NULL)
      OR (status = 'confirmed' AND confirmed_notified_at IS NULL)
      OR (status = 'failed' AND failed_notified_at IS NULL)
    ORDER BY updated_at ASC
    LIMIT $1;
  `;
  const res = await query<ExitOrder>(sql, [limit]);
  return res.rows;
}

export async function markExitOrderNotificationSent(
  id: string,
  stage: "submitted" | "confirmed" | "failed",
): Promise<void> {
  const col = `${stage}_notified_at`;
  await query(`UPDATE exit_orders SET ${col} = NOW() WHERE id = $1`, [id]);
}
