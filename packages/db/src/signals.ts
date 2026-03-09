import { query } from "./client";

export interface SignalInsert {
  type: string;
  walletAddress?: string;
  tokenMint?: string;
  signature: string;
  slot: number;
  confidence?: number;
  payload: Record<string, unknown>;
}

export interface Signal {
  id: string;
  type: string;
  wallet_address: string | null;
  token_mint: string | null;
  signature: string;
  slot: number;
  confidence: number | null;
  payload: Record<string, unknown>;
  is_sent: boolean;
  sent_at: Date | null;
  created_at: Date;
}

/**
 * Insert a signal row. Silently ignores duplicates per (type, signature, wallet_address)
 * or per the overarching unique constraint (e.g. type, token_mint).
 */
export async function insertSignal(signal: SignalInsert): Promise<void> {
  await query(
    `INSERT INTO signals
       (type, wallet_address, token_mint, signature, slot, confidence, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      signal.type,
      signal.walletAddress ?? null,
      signal.tokenMint ?? null,
      signal.signature,
      signal.slot,
      signal.confidence ?? null,
      JSON.stringify(signal.payload),
    ],
  );
}

/**
 * Return up to `limit` unsent signals, oldest first.
 */
export async function listUnsentSignals(limit = 10): Promise<Signal[]> {
  const result = await query<Signal>(
    `SELECT id, type, wallet_address, token_mint, signature, slot,
            confidence, payload, is_sent, sent_at, created_at
     FROM signals
     WHERE is_sent = false
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * Mark a signal as sent and record the sent timestamp.
 */
export async function markSignalSent(id: string): Promise<void> {
  await query(
    `UPDATE signals SET is_sent = true, sent_at = NOW() WHERE id = $1`,
    [id],
  );
}
