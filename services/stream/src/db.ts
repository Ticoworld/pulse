import { Pool, QueryResult, QueryResultRow } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export interface RawEventInsert {
  id: string;
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
  await query(
    `INSERT INTO raw_events
       (id, source, event_type, signature, slot, wallet_address, token_mint, amount, ts, raw_payload)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`,
    [
      event.id,
      event.source,
      event.eventType,
      event.signature,
      event.slot,
      event.walletAddress ?? null,
      event.tokenMint ?? null,
      event.amount ?? null,
      new Date(event.timestamp),
      JSON.stringify(event.rawPayload),
    ],
  );
}
