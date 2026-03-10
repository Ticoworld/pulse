/**
 * Brutal latency proof for one mint.
 *
 * Run:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/prove-mint-latency.ts <MINT>
 *
 * If <MINT> is omitted, the script picks the latest mint with a NEW_MINT_SEEN or LIQUIDITY_LIVE signal.
 */
import "dotenv/config";
import { query } from "@pulse/db";
import { evaluateSignalFreshness, type FreshnessSignalLike } from "../apps/tg-bot/src/signalFreshness";

type EventType = "TOKEN_MINT" | "SWAP";
type SignalType = "NEW_MINT_SEEN" | "LIQUIDITY_LIVE";

interface RawEventProofRow {
  event_type: EventType;
  signature: string;
  slot: string;
  seq: string;
  chain_time: Date;
  raw_event_created_at: Date;
}

interface SignalProofRow {
  id: string;
  type: SignalType;
  token_mint: string | null;
  signature: string;
  slot: number;
  is_sent: boolean;
  sent_at: Date | null;
  created_at: Date;
  payload: Record<string, unknown>;
  chain_time: Date | null;
  raw_event_created_at: Date | null;
  engine_processed_at: Date | null;
  telegram_delivery_status: string | null;
  telegram_delivery_reason: string | null;
  trace_engine_processed_at: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function fmt(value: Date | string | null | undefined): string {
  if (!value) return "null";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "invalid" : parsed.toISOString();
}

function deltaSeconds(
  later: Date | string | null | undefined,
  earlier: Date | string | null | undefined,
): string {
  if (!later || !earlier) return "unproven";
  const laterDate = later instanceof Date ? later : new Date(later);
  const earlierDate = earlier instanceof Date ? earlier : new Date(earlier);
  if (Number.isNaN(laterDate.getTime()) || Number.isNaN(earlierDate.getTime())) {
    return "unproven";
  }
  return ((laterDate.getTime() - earlierDate.getTime()) / 1000).toFixed(3);
}

function deriveDeliveryStatus(row: SignalProofRow): string {
  if (row.telegram_delivery_status) return row.telegram_delivery_status;
  if (row.sent_at) return "sent_legacy";
  if (row.is_sent) return "handled_unknown";
  return "pending";
}

function printSection(title: string, lines: string[]): void {
  console.log(`\n=== ${title} ===`);
  for (const line of lines) {
    console.log(line);
  }
}

async function resolveMint(argMint?: string): Promise<string> {
  if (argMint) return argMint;

  const latest = await query<{ token_mint: string | null }>(
    `SELECT token_mint
     FROM signals
     WHERE type IN ('NEW_MINT_SEEN', 'LIQUIDITY_LIVE')
       AND token_mint IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
  );

  const mint = latest.rows[0]?.token_mint;
  if (!mint) {
    throw new Error("No NEW_MINT_SEEN or LIQUIDITY_LIVE signals found.");
  }
  return mint;
}

async function loadRawEvents(mint: string): Promise<RawEventProofRow[]> {
  const result = await query<RawEventProofRow>(
    `SELECT DISTINCT ON (event_type)
        event_type,
        signature,
        slot,
        seq,
        ts AS chain_time,
        created_at AS raw_event_created_at
     FROM raw_events
     WHERE token_mint = $1
       AND event_type IN ('TOKEN_MINT', 'SWAP')
     ORDER BY event_type, seq ASC`,
    [mint],
  );

  return result.rows;
}

async function loadSignals(mint: string): Promise<SignalProofRow[]> {
  const result = await query<SignalProofRow>(
    `SELECT s.id, s.type, s.token_mint, s.signature, s.slot, s.is_sent, s.sent_at, s.created_at,
            s.payload,
            COALESCE((s.payload #>> '{trace,chain_time}')::timestamptz, re.ts) AS chain_time,
            COALESCE((s.payload #>> '{trace,raw_event_created_at}')::timestamptz, re.created_at) AS raw_event_created_at,
            COALESCE((s.payload #>> '{trace,engine_processed_at}')::timestamptz, s.created_at) AS engine_processed_at,
            s.payload #>> '{telegram_delivery,status}' AS telegram_delivery_status,
            s.payload #>> '{telegram_delivery,reason}' AS telegram_delivery_reason,
            s.payload #>> '{trace,engine_processed_at}' AS trace_engine_processed_at
     FROM signals s
     LEFT JOIN LATERAL (
       SELECT r.ts, r.created_at
       FROM raw_events r
       WHERE r.signature = s.signature
         AND r.token_mint IS NOT DISTINCT FROM s.token_mint
         AND (
           (s.type = 'NEW_MINT_SEEN' AND r.event_type = 'TOKEN_MINT')
           OR (s.type = 'LIQUIDITY_LIVE' AND r.event_type = 'SWAP')
         )
       ORDER BY r.seq ASC
       LIMIT 1
     ) re ON true
     WHERE s.token_mint = $1
       AND s.type IN ('NEW_MINT_SEEN', 'LIQUIDITY_LIVE')
     ORDER BY s.created_at ASC`,
    [mint],
  );

  return result.rows;
}

function printRawEventSummary(rawEvents: RawEventProofRow[]): void {
  const tokenMintEvent = rawEvents.find((row) => row.event_type === "TOKEN_MINT");
  const swapEvent = rawEvents.find((row) => row.event_type === "SWAP");

  printSection("STREAM / RAW_EVENTS", [
    `stream_ingested=${rawEvents.length > 0 ? "YES" : "NO"}`,
    `first_token_mint_signature=${tokenMintEvent?.signature ?? "none"}`,
    `first_token_mint_chain_time=${fmt(tokenMintEvent?.chain_time)}`,
    `first_token_mint_raw_event_created_at=${fmt(tokenMintEvent?.raw_event_created_at)}`,
    `first_token_mint_chain_to_raw_seconds=${deltaSeconds(tokenMintEvent?.raw_event_created_at, tokenMintEvent?.chain_time)}`,
    `first_swap_signature=${swapEvent?.signature ?? "none"}`,
    `first_swap_chain_time=${fmt(swapEvent?.chain_time)}`,
    `first_swap_raw_event_created_at=${fmt(swapEvent?.raw_event_created_at)}`,
    `first_swap_chain_to_raw_seconds=${deltaSeconds(swapEvent?.raw_event_created_at, swapEvent?.chain_time)}`,
  ]);
}

function printSignalSummary(type: SignalType, row: SignalProofRow | undefined): void {
  if (!row) {
    printSection(type, [
      "signal_inserted=NO",
      "engine_processed_at=unproven",
      "telegram_sent_at=unproven",
    ]);
    return;
  }

  const freshness = evaluateSignalFreshness({
    type: row.type,
    token_mint: row.token_mint,
    signature: row.signature,
    payload: row.payload,
    chain_time: row.chain_time,
  } satisfies FreshnessSignalLike);

  const engineSource = row.trace_engine_processed_at
    ? "trace.engine_processed_at"
    : "signal_created_at_fallback";

  printSection(type, [
    `signal_inserted=YES`,
    `signal_id=${row.id}`,
    `signature=${row.signature}`,
    `delivery_status=${deriveDeliveryStatus(row)}`,
    `delivery_reason=${row.telegram_delivery_reason ?? "none"}`,
    `chain_time=${fmt(row.chain_time)}`,
    `raw_event_created_at=${fmt(row.raw_event_created_at)}`,
    `engine_processed_at=${fmt(row.engine_processed_at)} (${engineSource})`,
    `signal_created_at=${fmt(row.created_at)}`,
    `telegram_sent_at=${fmt(row.sent_at)}`,
    `chain_to_raw_seconds=${deltaSeconds(row.raw_event_created_at, row.chain_time)}`,
    `raw_to_engine_seconds=${deltaSeconds(row.engine_processed_at, row.raw_event_created_at)}`,
    `engine_to_signal_seconds=${deltaSeconds(row.created_at, row.engine_processed_at)}`,
    `signal_to_telegram_seconds=${deltaSeconds(row.sent_at, row.created_at)}`,
    `chain_to_telegram_seconds=${deltaSeconds(row.sent_at, row.chain_time)}`,
    `freshness_now=${freshness.decision}`,
    `freshness_now_age_seconds=${freshness.ageSeconds == null ? "unproven" : freshness.ageSeconds.toFixed(3)}`,
  ]);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set.");
  }

  const mint = await resolveMint(process.argv[2]);
  const [rawEvents, signals] = await Promise.all([
    loadRawEvents(mint),
    loadSignals(mint),
  ]);

  console.log(`MINT=${mint}`);
  printRawEventSummary(rawEvents);
  printSignalSummary(
    "NEW_MINT_SEEN",
    signals.find((row) => row.type === "NEW_MINT_SEEN"),
  );
  printSignalSummary(
    "LIQUIDITY_LIVE",
    signals.find((row) => row.type === "LIQUIDITY_LIVE"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
