import { query } from "./client";

export interface ExecutionOrderInsert {
  tokenMint: string;
  signalType: string;
  signalId?: string;
  candidateScore?: number;
  alphaWallet?: string;
  probableDevWallet?: string;
  actorId?: string;
  side?: string;
  amountSol: number;
  maxSlippageBps: number;
  metadata?: Record<string, any>;
}

export interface ExecutionOrder {
  id: string;
  token_mint: string;
  signal_type: string;
  signal_id: string | null;
  candidate_score: number | null;
  alpha_wallet: string | null;
  probable_dev_wallet: string | null;
  actor_id: string | null;
  side: string;
  status: string;
  amount_sol: string;
  max_slippage_bps: number;
  priority_fee_lamports: string | null;
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

export async function createExecutionOrder(
  data: ExecutionOrderInsert,
): Promise<ExecutionOrder> {
  const res = await query<ExecutionOrder>(
    `INSERT INTO execution_orders 
      (token_mint, signal_type, signal_id, candidate_score, alpha_wallet, probable_dev_wallet, actor_id, side, amount_sol, max_slippage_bps, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.tokenMint,
      data.signalType,
      data.signalId || null,
      data.candidateScore || null,
      data.alphaWallet || null,
      data.probableDevWallet || null,
      data.actorId || null,
      data.side || "buy",
      data.amountSol,
      data.maxSlippageBps,
      data.metadata || {},
    ],
  );
  return res.rows[0];
}

export async function getExecutionOrder(
  id: string,
): Promise<ExecutionOrder | null> {
  const res = await query<ExecutionOrder>(
    "SELECT * FROM execution_orders WHERE id = $1",
    [id],
  );
  return res.rows[0] || null;
}

export async function getActiveBuyOrderByMint(
  mint: string,
): Promise<ExecutionOrder | null> {
  const res = await query<ExecutionOrder>(
    `SELECT * FROM execution_orders 
     WHERE token_mint = $1 AND side = 'buy' AND status IN ('pending', 'submitted')
     ORDER BY created_at DESC LIMIT 1`,
    [mint],
  );
  return res.rows[0] || null;
}

export async function listRecentExecutionOrders(
  limit = 50,
): Promise<ExecutionOrder[]> {
  const res = await query<ExecutionOrder>(
    "SELECT * FROM execution_orders ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return res.rows;
}

export async function listPendingExecutionOrders(
  limit = 50,
): Promise<ExecutionOrder[]> {
  const res = await query<ExecutionOrder>(
    "SELECT * FROM execution_orders WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1",
    [limit],
  );
  return res.rows;
}

export async function markExecutionOrderSubmitted(
  id: string,
  txSignature: string,
  priorityFeeLamports?: number,
): Promise<void> {
  await query(
    `UPDATE execution_orders 
     SET status = 'submitted', tx_signature = $1, priority_fee_lamports = $2, updated_at = now() 
     WHERE id = $3`,
    [txSignature, priorityFeeLamports || null, id],
  );
}

export async function markExecutionOrderConfirmed(id: string): Promise<void> {
  await query(
    `UPDATE execution_orders 
     SET status = 'confirmed', executed_at = now(), updated_at = now() 
     WHERE id = $1`,
    [id],
  );
}

export async function markExecutionOrderFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  await query(
    `UPDATE execution_orders 
     SET status = 'failed', error_message = $1, updated_at = now() 
     WHERE id = $2`,
    [errorMessage, id],
  );
}

// TG Notification tracking

export async function listUnnotifiedExecutionOrders(): Promise<
  ExecutionOrder[]
> {
  const res = await query<ExecutionOrder>(
    `SELECT * FROM execution_orders 
     WHERE 
       (status = 'submitted' AND submitted_notified_at IS NULL) OR
       (status = 'confirmed' AND confirmed_notified_at IS NULL) OR
       (status = 'failed' AND failed_notified_at IS NULL)
     ORDER BY created_at ASC LIMIT 50`,
  );
  return res.rows;
}

export async function markOrderNotificationSent(
  id: string,
  stage: "submitted" | "confirmed" | "failed",
): Promise<void> {
  const column = `${stage}_notified_at`;
  // Parameterizing column names directly isn't allowed, so we construct safely
  if (
    ![
      "submitted_notified_at",
      "confirmed_notified_at",
      "failed_notified_at",
    ].includes(column)
  ) {
    throw new Error("Invalid stage");
  }

  await query(`UPDATE execution_orders SET ${column} = now() WHERE id = $1`, [
    id,
  ]);
}
