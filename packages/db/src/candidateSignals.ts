import { query } from "./client";

export interface CandidateSignal {
  id: string;
  mint: string;
  score: number;
  alpha_wallet_trigger: boolean;
  liquidity_live_trigger: boolean;
  dev_trigger: boolean;
  alpha_wallet: string | null;
  probable_dev_wallet: string | null;
  dev_prior_launches: number | null;
  dev_liquidity_live_count: number | null;
  liquidity_live_seq: string | null;
  alpha_trigger_seq: string | null;
  metadata: any;
  created_at: Date;
  updated_at: Date;
}

export type UpsertCandidateData = Omit<
  CandidateSignal,
  "id" | "created_at" | "updated_at"
>;

/**
 * Full row update/insert for a candidate signal.
 * Recomputes everything deterministically.
 */
export async function upsertCandidateSignal(
  data: UpsertCandidateData,
): Promise<CandidateSignal> {
  const sql = `
    INSERT INTO candidate_signals (
      mint, 
      score, 
      alpha_wallet_trigger, 
      liquidity_live_trigger, 
      dev_trigger,
      alpha_wallet, 
      probable_dev_wallet, 
      dev_prior_launches, 
      dev_liquidity_live_count,
      liquidity_live_seq, 
      alpha_trigger_seq, 
      metadata, 
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (mint) DO UPDATE SET
      score = EXCLUDED.score,
      alpha_wallet_trigger = EXCLUDED.alpha_wallet_trigger,
      liquidity_live_trigger = EXCLUDED.liquidity_live_trigger,
      dev_trigger = EXCLUDED.dev_trigger,
      alpha_wallet = EXCLUDED.alpha_wallet,
      probable_dev_wallet = EXCLUDED.probable_dev_wallet,
      dev_prior_launches = EXCLUDED.dev_prior_launches,
      dev_liquidity_live_count = EXCLUDED.dev_liquidity_live_count,
      liquidity_live_seq = EXCLUDED.liquidity_live_seq,
      alpha_trigger_seq = EXCLUDED.alpha_trigger_seq,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *;
  `;
  const params = [
    data.mint,
    data.score,
    data.alpha_wallet_trigger,
    data.liquidity_live_trigger,
    data.dev_trigger,
    data.alpha_wallet,
    data.probable_dev_wallet,
    data.dev_prior_launches,
    data.dev_liquidity_live_count,
    data.liquidity_live_seq,
    data.alpha_trigger_seq,
    data.metadata,
  ];
  const res = await query<CandidateSignal>(sql, params);
  return res.rows[0];
}

/**
 * Fetch a candidate signal by its token mint.
 */
export async function getCandidateSignalByMint(
  mint: string,
): Promise<CandidateSignal | null> {
  const res = await query<CandidateSignal>(
    "SELECT * FROM candidate_signals WHERE mint = $1",
    [mint],
  );
  return res.rows[0] || null;
}

/**
 * List top candidate signals by score.
 */
export async function listTopCandidateSignals(
  limit = 50,
): Promise<CandidateSignal[]> {
  const res = await query<CandidateSignal>(
    "SELECT * FROM candidate_signals ORDER BY score DESC, created_at DESC LIMIT $1",
    [limit],
  );
  return res.rows;
}

/** Row for ranked digest: candidate_signal + optional Bags enrichment (creator, fees). */
export interface TopCandidateForDigest {
  id: string;
  mint: string;
  score: number;
  alpha_wallet_trigger: boolean;
  liquidity_live_trigger: boolean;
  dev_trigger: boolean;
  alpha_wallet: string | null;
  probable_dev_wallet: string | null;
  dev_prior_launches: number | null;
  dev_liquidity_live_count: number | null;
  liquidity_live_seq: string | null;
  alpha_trigger_seq: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  primary_creator_display_name: string | null;
  primary_creator_provider: string | null;
  fees_lamports: string | null;
}

/**
 * Top HIGH_INTEREST candidates by score within a freshness window, with Bags context when available.
 * Only returns rows with score >= minScore (use HIGH_INTEREST_THRESHOLD from @pulse/db).
 * Used for /top_candidates digest.
 */
export async function getTopCandidateSignalsForDigest(
  limit = 10,
  sinceHours = 24,
  minScore: number,
): Promise<TopCandidateForDigest[]> {
  const res = await query<TopCandidateForDigest>(
    `SELECT
       cs.id, cs.mint, cs.score, cs.alpha_wallet_trigger, cs.liquidity_live_trigger,
       cs.dev_trigger, cs.alpha_wallet, cs.probable_dev_wallet, cs.dev_prior_launches,
       cs.dev_liquidity_live_count, cs.liquidity_live_seq, cs.alpha_trigger_seq,
       cs.metadata, cs.created_at, cs.updated_at,
       e.primary_creator_display_name,
       e.primary_creator_provider,
       e.fees_lamports
     FROM candidate_signals cs
     LEFT JOIN bags_token_enrichments e ON e.mint = cs.mint AND e.enrichment_status = 'resolved'
     WHERE cs.updated_at >= NOW() - ($1::text || ' hours')::interval
       AND cs.score >= $3
     ORDER BY cs.score DESC NULLS LAST, cs.updated_at DESC
     LIMIT $2`,
    [sinceHours, limit, minScore],
  );
  return res.rows;
}

interface MintSummaryRow {
  mint: string;
  score: number | null;
  bags_bonus: string | null;
  primary_creator_display_name: string | null;
  primary_creator_provider: string | null;
  fees_lamports: string | null;
  has_high_interest_signal: boolean;
  has_candidate_signal: boolean;
  has_bags_enrichment: boolean;
}

export interface MintSummaryForTelegram {
  mint: string;
  score: number | null;
  bagsBonus: number | null;
  primaryCreatorDisplayName: string | null;
  primaryCreatorProvider: string | null;
  feesLamports: string | null;
  hasHighInterestSignal: boolean;
  foundInDb: boolean;
}

/**
 * DB-backed mint summary for /mint command.
 * Uses candidate_signals, bags_token_enrichments, and HIGH_INTEREST signal existence.
 */
export async function getMintSummaryForTelegram(
  mint: string,
): Promise<MintSummaryForTelegram> {
  const res = await query<MintSummaryRow>(
    `SELECT
       m.mint,
       cs.score,
       cs.metadata->>'bags_bonus' AS bags_bonus,
       e.primary_creator_display_name,
       e.primary_creator_provider,
       e.fees_lamports::text AS fees_lamports,
       EXISTS (
         SELECT 1
         FROM signals s
         WHERE s.type = 'HIGH_INTEREST_TOKEN'
           AND s.token_mint = m.mint
       ) AS has_high_interest_signal,
       (cs.mint IS NOT NULL) AS has_candidate_signal,
       (e.mint IS NOT NULL) AS has_bags_enrichment
     FROM (SELECT $1::text AS mint) m
     LEFT JOIN candidate_signals cs
       ON cs.mint = m.mint
     LEFT JOIN bags_token_enrichments e
       ON e.mint = m.mint
      AND e.enrichment_status = 'resolved'`,
    [mint],
  );

  const row = res.rows[0];
  const parsedBonus = row?.bags_bonus != null ? Number(row.bags_bonus) : null;
  const bagsBonus = parsedBonus != null && Number.isFinite(parsedBonus)
    ? parsedBonus
    : null;

  return {
    mint,
    score: row?.score ?? null,
    bagsBonus,
    primaryCreatorDisplayName: row?.primary_creator_display_name ?? null,
    primaryCreatorProvider: row?.primary_creator_provider ?? null,
    feesLamports: row?.fees_lamports ?? null,
    hasHighInterestSignal: row?.has_high_interest_signal ?? false,
    foundInDb: Boolean(row?.has_candidate_signal || row?.has_bags_enrichment || row?.has_high_interest_signal),
  };
}
