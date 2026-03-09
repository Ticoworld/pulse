import { query } from "./client";

export interface LaunchCandidateInsert {
  mint: string;
  firstSeenSeq: string;
  firstSeenAt: Date;
  firstSeenSignature: string;
  sourceProgram?: string;
  metadata?: Record<string, unknown>;
}

export interface LaunchCandidate {
  id: string;
  mint: string;
  first_seen_seq: string;
  first_seen_at: Date;
  first_seen_signature: string;
  liquidity_live_seq: string | null;
  liquidity_live_at: Date | null;
  liquidity_live_signature: string | null;
  first_swap_seq: string | null;
  first_swap_at: Date | null;
  first_swap_signature: string | null;
  source_program: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * Creates a new launch candidate tracking row when a mint is first observed.
 * Uses ON CONFLICT DO NOTHING to strictly ensure we only record the true absolute first discovery.
 */
export async function upsertLaunchCandidateFirstSeen(
  candidate: LaunchCandidateInsert,
): Promise<void> {
  await query(
    `INSERT INTO launch_candidates
       (mint, first_seen_seq, first_seen_at, first_seen_signature, source_program, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (mint) DO NOTHING`,
    [
      candidate.mint,
      candidate.firstSeenSeq,
      candidate.firstSeenAt,
      candidate.firstSeenSignature,
      candidate.sourceProgram ?? null,
      JSON.stringify(candidate.metadata ?? {}),
    ],
  );
}

/**
 * Marks a candidate as having live liquidity observed.
 * Only updates the row if liquidity_live_seq is currently null to prevent subsequent swaps from overwriting the first one.
 */
export async function markLaunchCandidateLiquidityLive(
  mint: string,
  seq: string,
  signature: string,
  timestamp: Date,
): Promise<void> {
  await query(
    `UPDATE launch_candidates
     SET liquidity_live_seq = $1,
         liquidity_live_at = $2,
         liquidity_live_signature = $3,
         status = 'LIQUIDITY_LIVE',
         updated_at = NOW()
     WHERE mint = $4
       AND liquidity_live_seq IS NULL`,
    [seq, timestamp, signature, mint],
  );
}

/**
 * Retrieves a candidate by its token mint address.
 */
export async function getLaunchCandidateByMint(
  mint: string,
): Promise<LaunchCandidate | null> {
  const result = await query<LaunchCandidate>(
    `SELECT * FROM launch_candidates WHERE mint = $1`,
    [mint],
  );
  return result.rows[0] ?? null;
}
