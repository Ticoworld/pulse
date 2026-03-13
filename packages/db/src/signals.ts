import { query } from "./client";

export interface SignalTraceInsert {
  chainTime?: Date | string | null;
  rawEventCreatedAt?: Date | string | null;
  engineProcessedAt?: Date | string | null;
}

export interface SignalInsert {
  type: string;
  walletAddress?: string;
  tokenMint?: string;
  signature: string;
  slot: number;
  confidence?: number;
  payload: Record<string, unknown>;
  trace?: SignalTraceInsert;
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
  chain_time?: Date | null;
  raw_event_created_at?: Date | null;
  engine_processed_at?: Date | null;
}

export interface SignalTelegramSkipInsert {
  skippedAt?: Date;
  reason: string;
  ageSeconds: number;
  chainTime: Date | string | null;
  currentTime: Date | string;
}

function serializeTraceDate(value?: Date | string | null): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function withSignalTrace(
  payload: Record<string, unknown>,
  trace?: SignalTraceInsert,
): Record<string, unknown> {
  if (!trace) {
    return payload;
  }

  const tracePayload = {
    chain_time: serializeTraceDate(trace.chainTime),
    raw_event_created_at: serializeTraceDate(trace.rawEventCreatedAt),
    engine_processed_at: serializeTraceDate(trace.engineProcessedAt),
  };

  return {
    ...payload,
    trace: tracePayload,
  };
}

/**
 * Insert a signal row. Silently ignores duplicates per (type, signature, wallet_address)
 * or per the overarching unique constraint (e.g. type, token_mint).
 */
export async function insertSignal(signal: SignalInsert): Promise<void> {
  const payload = withSignalTrace(signal.payload, signal.trace);

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
      JSON.stringify(payload),
    ],
  );
}

/**
 * Return up to `limit` unsent signals, oldest first.
 */
export async function listUnsentSignals(limit = 10): Promise<Signal[]> {
  const result = await query<Signal>(
    `SELECT s.id, s.type, s.wallet_address, s.token_mint, s.signature, s.slot,
            s.confidence, s.payload, s.is_sent, s.sent_at, s.created_at,
            COALESCE((s.payload #>> '{trace,chain_time}')::timestamptz, re.ts) AS chain_time,
            COALESCE((s.payload #>> '{trace,raw_event_created_at}')::timestamptz, re.created_at) AS raw_event_created_at,
            COALESCE((s.payload #>> '{trace,engine_processed_at}')::timestamptz, s.created_at) AS engine_processed_at
     FROM signals s
     LEFT JOIN LATERAL (
       SELECT r.ts, r.created_at
       FROM raw_events r
       WHERE r.signature = s.signature
         AND r.token_mint IS NOT DISTINCT FROM s.token_mint
         AND (
           (s.type = 'NEW_MINT_SEEN' AND r.event_type = 'TOKEN_MINT')
           OR (s.type = 'LIQUIDITY_LIVE' AND r.event_type = 'SWAP')
           OR (s.type = 'ALPHA_WALLET_BUY' AND r.event_type = 'SWAP')
         )
       ORDER BY r.seq ASC
       LIMIT 1
     ) re ON true
     WHERE s.is_sent = false
       AND s.created_at > NOW() - INTERVAL '30 minutes'
     ORDER BY s.created_at ASC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * Mark a signal as sent and record the sent timestamp.
 */
/**
 * Atomically claim a signal for sending. Returns true if this call
 * successfully claimed it (sent_at was NULL), false if another instance
 * already claimed it. Callers must skip sending when false is returned.
 */
export async function markSignalSent(
  id: string,
  sentAt = new Date(),
): Promise<boolean> {
  const result = await query(
    `UPDATE signals
     SET is_sent = true,
         sent_at = $2,
         payload = jsonb_set(
           COALESCE(payload, '{}'::jsonb),
           '{telegram_delivery}',
           $3::jsonb,
           true
         )
     WHERE id = $1 AND sent_at IS NULL`,
    [
      id,
      sentAt,
      JSON.stringify({
        status: "sent",
        attempted_at: sentAt.toISOString(),
        sent_at: sentAt.toISOString(),
      }),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Keep stale signals for auditability and downstream state, but mark them handled so
 * the bot does not retry misleading launch/liquidity alerts forever. `sent_at` stays null.
 */
export async function markSignalTelegramSkipped(
  id: string,
  skip: SignalTelegramSkipInsert,
): Promise<void> {
  const skippedAt = skip.skippedAt ?? new Date();

  await query(
    `UPDATE signals
     SET is_sent = true,
         sent_at = NULL,
         payload = jsonb_set(
           COALESCE(payload, '{}'::jsonb),
           '{telegram_delivery}',
           $2::jsonb,
           true
         )
     WHERE id = $1`,
    [
      id,
      JSON.stringify({
        status: "skipped_stale",
        attempted_at: skippedAt.toISOString(),
        skipped_at: skippedAt.toISOString(),
        reason: skip.reason,
        age_seconds: Number(skip.ageSeconds.toFixed(3)),
        chain_time: serializeTraceDate(skip.chainTime),
        current_time: serializeTraceDate(skip.currentTime),
      }),
    ],
  );
}
