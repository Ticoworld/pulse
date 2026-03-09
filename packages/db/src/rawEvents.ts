import { query } from "./client";

// Inline the minimal shape needed to avoid circular workspace import complexity at this stage.
// The canonical RawEvent type lives in @pulse/common.
interface RawEventInsert {
  id?: string;
  source: string;
  eventType: string;
  signature: string;
  slot: number;
  walletAddress?: string;
  tokenMint?: string;
  amount?: number;
  timestamp: number;
  rawPayload: unknown;
}

export async function insertRawEvent(event: RawEventInsert): Promise<void> {
  const eventKey = `${event.signature}:${event.eventType}:${event.walletAddress || ""}:${event.tokenMint || ""}`;

  await query(
    `INSERT INTO raw_events
       (source, event_type, signature, slot, wallet_address, token_mint, amount, ts, raw_payload, event_key)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (event_key) DO NOTHING`,
    [
      event.source,
      event.eventType,
      event.signature,
      event.slot,
      event.walletAddress ?? null,
      event.tokenMint ?? null,
      event.amount ?? null,
      new Date(event.timestamp),
      JSON.stringify(event.rawPayload),
      eventKey,
    ],
  );
}

export async function getMaxRawEventSeq(): Promise<bigint> {
  const result = await query<{ max_seq: string }>(
    `SELECT MAX(seq) as max_seq FROM raw_events`,
  );
  const maxSeq = result.rows[0]?.max_seq;
  return maxSeq ? BigInt(maxSeq) : BigInt(0);
}
