/**
 * Brutal proof for stream freshness based on raw_events inserts.
 *
 * Run:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/prove-stream-freshness.ts
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/prove-stream-freshness.ts --mint EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm
 */
import "dotenv/config";
import { query } from "@pulse/db";

interface CliOptions {
  mint: string | null;
  hours: number;
  thresholdSeconds: number;
}

interface OverallStatsRow {
  total_rows: string;
  p50_seconds: string | null;
  p95_seconds: string | null;
  p99_seconds: string | null;
  max_seconds: string | null;
}

interface EventTypeStatsRow {
  event_type: string;
  row_count: string;
  p50_seconds: string | null;
  p95_seconds: string | null;
  p99_seconds: string | null;
  max_seconds: string | null;
}

interface TopMintRow {
  mint: string;
  row_count: string;
}

interface StaleRow {
  event_type: string;
  mint: string;
  signature: string;
  chain_time: Date;
  raw_event_created_at: Date;
  chain_to_raw_seconds: string;
}

function parseCliArgs(argv: string[]): CliOptions {
  let mint: string | null = null;
  let hours = 24;
  let thresholdSeconds = Number(
    process.env.STREAM_STALE_EVENT_WARN_SECONDS || 120,
  );

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--mint") {
      mint = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--hours") {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        hours = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--threshold") {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed >= 0) {
        thresholdSeconds = parsed;
      }
      index += 1;
      continue;
    }

    if (!arg.startsWith("--") && !mint) {
      mint = arg;
    }
  }

  return { mint, hours, thresholdSeconds };
}

function fmtNumber(value: string | number | null | undefined): string {
  if (value == null) return "n/a";
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3) : "n/a";
}

function fmtIso(value: Date | null | undefined): string {
  if (!value) return "n/a";
  return value.toISOString();
}

function printSection(title: string, lines: string[]): void {
  console.log(`\n=== ${title} ===`);
  for (const line of lines) {
    console.log(line);
  }
}

async function loadOverallStats(options: CliOptions): Promise<OverallStatsRow> {
  const result = await query<OverallStatsRow>(
    `SELECT COUNT(*)::text AS total_rows,
            ROUND(
              PERCENTILE_CONT(0.50) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (created_at - ts))
              )::numeric,
              3
            )::text AS p50_seconds,
            ROUND(
              PERCENTILE_CONT(0.95) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (created_at - ts))
              )::numeric,
              3
            )::text AS p95_seconds,
            ROUND(
              PERCENTILE_CONT(0.99) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (created_at - ts))
              )::numeric,
              3
            )::text AS p99_seconds,
            ROUND(
              MAX(EXTRACT(EPOCH FROM (created_at - ts)))::numeric,
              3
            )::text AS max_seconds
     FROM raw_events
     WHERE created_at >= NOW() - ($1::text || ' hours')::interval
       AND ($2::text IS NULL OR token_mint = $2)`,
    [String(options.hours), options.mint],
  );

  return (
    result.rows[0] ?? {
      total_rows: "0",
      p50_seconds: null,
      p95_seconds: null,
      p99_seconds: null,
      max_seconds: null,
    }
  );
}

async function loadEventTypeStats(
  options: CliOptions,
): Promise<EventTypeStatsRow[]> {
  const result = await query<EventTypeStatsRow>(
    `SELECT event_type,
            COUNT(*)::text AS row_count,
            ROUND(
              PERCENTILE_CONT(0.50) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (created_at - ts))
              )::numeric,
              3
            )::text AS p50_seconds,
            ROUND(
              PERCENTILE_CONT(0.95) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (created_at - ts))
              )::numeric,
              3
            )::text AS p95_seconds,
            ROUND(
              PERCENTILE_CONT(0.99) WITHIN GROUP (
                ORDER BY EXTRACT(EPOCH FROM (created_at - ts))
              )::numeric,
              3
            )::text AS p99_seconds,
            ROUND(
              MAX(EXTRACT(EPOCH FROM (created_at - ts)))::numeric,
              3
            )::text AS max_seconds
     FROM raw_events
     WHERE created_at >= NOW() - ($1::text || ' hours')::interval
       AND ($2::text IS NULL OR token_mint = $2)
     GROUP BY event_type
     ORDER BY COUNT(*) DESC, event_type ASC`,
    [String(options.hours), options.mint],
  );

  return result.rows;
}

async function loadTopMints(options: CliOptions): Promise<TopMintRow[]> {
  const result = await query<TopMintRow>(
    `SELECT COALESCE(token_mint, 'n/a') AS mint,
            COUNT(*)::text AS row_count
     FROM raw_events
     WHERE created_at >= NOW() - ($1::text || ' hours')::interval
       AND ($2::text IS NULL OR token_mint = $2)
     GROUP BY COALESCE(token_mint, 'n/a')
     ORDER BY COUNT(*) DESC, mint ASC
     LIMIT 10`,
    [String(options.hours), options.mint],
  );

  return result.rows;
}

async function loadStaleRows(options: CliOptions): Promise<StaleRow[]> {
  const result = await query<StaleRow>(
    `SELECT event_type,
            COALESCE(token_mint, 'n/a') AS mint,
            signature,
            ts AS chain_time,
            created_at AS raw_event_created_at,
            ROUND(
              EXTRACT(EPOCH FROM (created_at - ts))::numeric,
              3
            )::text AS chain_to_raw_seconds
     FROM raw_events
     WHERE created_at >= NOW() - ($1::text || ' hours')::interval
       AND ($2::text IS NULL OR token_mint = $2)
       AND EXTRACT(EPOCH FROM (created_at - ts)) > $3
     ORDER BY created_at DESC
     LIMIT 25`,
    [String(options.hours), options.mint, options.thresholdSeconds],
  );

  return result.rows;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL not set.");
  }

  const options = parseCliArgs(process.argv.slice(2));
  const [overallStats, eventTypeStats, topMints, staleRows] = await Promise.all(
    [
      loadOverallStats(options),
      loadEventTypeStats(options),
      loadTopMints(options),
      loadStaleRows(options),
    ],
  );

  console.log(
    `STREAM_FRESHNESS_PROOF hours=${options.hours} threshold_seconds=${options.thresholdSeconds} mint=${options.mint ?? "ALL"}`,
  );

  printSection("OVERALL", [
    `total_rows_inspected=${overallStats.total_rows}`,
    `chain_to_raw_p50_seconds=${fmtNumber(overallStats.p50_seconds)}`,
    `chain_to_raw_p95_seconds=${fmtNumber(overallStats.p95_seconds)}`,
    `chain_to_raw_p99_seconds=${fmtNumber(overallStats.p99_seconds)}`,
    `chain_to_raw_max_seconds=${fmtNumber(overallStats.max_seconds)}`,
  ]);

  printSection(
    "BY_EVENT_TYPE",
    eventTypeStats.length === 0
      ? ["no_rows=true"]
      : eventTypeStats.map(
          (row) =>
            `event_type=${row.event_type} rows=${row.row_count} p50_seconds=${fmtNumber(
              row.p50_seconds,
            )} p95_seconds=${fmtNumber(row.p95_seconds)} p99_seconds=${fmtNumber(
              row.p99_seconds,
            )} max_seconds=${fmtNumber(row.max_seconds)}`,
        ),
  );

  printSection(
    "TOP_MINTS",
    topMints.length === 0
      ? ["no_rows=true"]
      : topMints.map((row) => `mint=${row.mint} rows=${row.row_count}`),
  );

  printSection(
    "ROWS_ABOVE_THRESHOLD",
    staleRows.length === 0
      ? ["rows_above_threshold=0"]
      : staleRows.map(
          (row) =>
            `event_type=${row.event_type} mint=${row.mint} signature=${row.signature} chain_time=${fmtIso(
              row.chain_time,
            )} raw_event_created_at=${fmtIso(
              row.raw_event_created_at,
            )} chain_to_raw_seconds=${fmtNumber(row.chain_to_raw_seconds)}`,
        ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
