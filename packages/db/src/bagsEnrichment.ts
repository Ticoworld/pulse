import pg from "pg";
import { query, withTransaction } from "./client";

export interface BagsEnrichmentRow {
  mint: string;
  enrichment_status: string;
  creators_fetched_at: Date | null;
  fees_fetched_at: Date | null;
  creators_count: number | null;
  primary_creator_wallet: string | null;
  primary_creator_display_name: string | null;
  primary_creator_provider: string | null;
  primary_creator_royalty_bps: number | null;
  fees_lamports: string | null;
  last_error_code: string | null;
  last_error_status: number | null;
  last_error_message: string | null;
  next_retry_at: Date | null;
  creators_next_retry_at: Date | null;
  fees_next_retry_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface BagsCreatorRow {
  mint: string;
  wallet: string;
  is_creator: boolean;
  display_name: string | null;
  provider: string | null;
  pfp: string | null;
  royalty_bps: number;
  fetched_at: Date;
}

export interface EnrichmentUpsert {
  mint: string;
  enrichmentStatus: string;
  creatorsFetchedAt?: Date | null;
  feesFetchedAt?: Date | null;
  creatorsCount?: number | null;
  primaryCreatorWallet?: string | null;
  primaryCreatorDisplayName?: string | null;
  primaryCreatorProvider?: string | null;
  primaryCreatorRoyaltyBps?: number | null;
  feesLamports?: number | bigint | null;
  lastErrorCode?: string | null;
  lastErrorStatus?: number | null;
  lastErrorMessage?: string | null;
  nextRetryAt?: Date | null;
  creatorsNextRetryAt?: Date | null;
  feesNextRetryAt?: Date | null;
}

export interface CandidateNeedingEnrichment {
  mint: string;
  liquidity_live_at: Date | null;
  created_at: Date;
  needs_creators: boolean;
  needs_fees: boolean;
}

/**
 * Launch candidates that need Bags enrichment or refresh, with side flags.
 * Prioritizes liquidity_live then newest first.
 * needs_creators: no row, or creators missing/stale and creators retry due.
 * needs_fees: no row, or fees missing/stale and fees retry due.
 */
export async function getLaunchCandidatesNeedingEnrichment(
  opts: {
    limit?: number;
    sinceHours?: number;
    creatorsTtlHours?: number;
    feesTtlMinutes?: number;
  } = {},
): Promise<CandidateNeedingEnrichment[]> {
  const limit = opts.limit ?? 25;
  const sinceHours = opts.sinceHours ?? 24 * 7;
  const creatorsTtlHours = opts.creatorsTtlHours ?? 24;
  const feesTtlMinutes = opts.feesTtlMinutes ?? 15;

  const result = await query<CandidateNeedingEnrichment>(
    `SELECT
       lc.mint,
       lc.liquidity_live_at,
       lc.created_at,
       (e.mint IS NULL OR (
         (e.creators_fetched_at IS NULL OR e.creators_fetched_at < NOW() - ($2::text || ' hours')::interval)
         AND (e.creators_next_retry_at IS NULL OR e.creators_next_retry_at <= NOW())
       )) AS needs_creators,
       (e.mint IS NULL OR (
         (e.fees_fetched_at IS NULL OR e.fees_fetched_at < NOW() - ($3::text || ' minutes')::interval)
         AND (e.fees_next_retry_at IS NULL OR e.fees_next_retry_at <= NOW())
       )) AS needs_fees
     FROM launch_candidates lc
     LEFT JOIN bags_token_enrichments e ON e.mint = lc.mint
     WHERE lc.created_at >= NOW() - ($1::text || ' hours')::interval
       AND (
         e.mint IS NULL
         OR (
           (e.creators_fetched_at IS NULL OR e.creators_fetched_at < NOW() - ($2::text || ' hours')::interval)
           AND (e.creators_next_retry_at IS NULL OR e.creators_next_retry_at <= NOW())
         )
         OR (
           (e.fees_fetched_at IS NULL OR e.fees_fetched_at < NOW() - ($3::text || ' minutes')::interval)
           AND (e.fees_next_retry_at IS NULL OR e.fees_next_retry_at <= NOW())
         )
       )
     ORDER BY (lc.liquidity_live_at IS NOT NULL) DESC, lc.created_at DESC
     LIMIT $4`,
    [sinceHours, creatorsTtlHours, feesTtlMinutes, limit],
  );
  return result.rows;
}

export interface SingleCandidateNeedingEnrichment {
  mint: string;
  liquidity_live_at: Date | null;
  needs_creators: boolean;
  needs_fees: boolean;
}

/**
 * Single mint needing enrichment: same rules as batch, with side flags.
 * Returns null if mint not in launch_candidates or does not currently need enrichment.
 * With force: true, returns row if in launch_candidates with needs_creators=true, needs_fees=true (both sides attempted).
 */
export async function getLaunchCandidateMintNeedingEnrichment(
  mint: string,
  opts: {
    creatorsTtlHours?: number;
    feesTtlMinutes?: number;
    force?: boolean;
  } = {},
): Promise<SingleCandidateNeedingEnrichment | null> {
  const creatorsTtlHours = opts.creatorsTtlHours ?? 24;
  const feesTtlMinutes = opts.feesTtlMinutes ?? 15;
  if (opts.force) {
    const row = await query<{ mint: string; liquidity_live_at: Date | null }>(
      `SELECT mint, liquidity_live_at FROM launch_candidates WHERE mint = $1`,
      [mint],
    );
    const r = row.rows[0];
    if (!r) return null;
    return { mint: r.mint, liquidity_live_at: r.liquidity_live_at, needs_creators: true, needs_fees: true };
  }
  const result = await query<SingleCandidateNeedingEnrichment>(
    `SELECT
       lc.mint,
       lc.liquidity_live_at,
       (e.mint IS NULL OR (
         (e.creators_fetched_at IS NULL OR e.creators_fetched_at < NOW() - ($2::text || ' hours')::interval)
         AND (e.creators_next_retry_at IS NULL OR e.creators_next_retry_at <= NOW())
       )) AS needs_creators,
       (e.mint IS NULL OR (
         (e.fees_fetched_at IS NULL OR e.fees_fetched_at < NOW() - ($3::text || ' minutes')::interval)
         AND (e.fees_next_retry_at IS NULL OR e.fees_next_retry_at <= NOW())
       )) AS needs_fees
     FROM launch_candidates lc
     LEFT JOIN bags_token_enrichments e ON e.mint = lc.mint
     WHERE lc.mint = $1
       AND (
         e.mint IS NULL
         OR (
           (e.creators_fetched_at IS NULL OR e.creators_fetched_at < NOW() - ($2::text || ' hours')::interval)
           AND (e.creators_next_retry_at IS NULL OR e.creators_next_retry_at <= NOW())
         )
         OR (
           (e.fees_fetched_at IS NULL OR e.fees_fetched_at < NOW() - ($3::text || ' minutes')::interval)
           AND (e.fees_next_retry_at IS NULL OR e.fees_next_retry_at <= NOW())
         )
       )`,
    [mint, creatorsTtlHours, feesTtlMinutes],
  );
  return result.rows[0] ?? null;
}

/**
 * Upsert bags_token_enrichments. On conflict (mint) update all provided fields.
 */
export async function upsertBagsEnrichment(data: EnrichmentUpsert): Promise<void> {
  await query(
    `INSERT INTO bags_token_enrichments (
       mint, enrichment_status, creators_fetched_at, fees_fetched_at,
       creators_count, primary_creator_wallet, primary_creator_display_name,
       primary_creator_provider, primary_creator_royalty_bps, fees_lamports,
       last_error_code, last_error_status, last_error_message, next_retry_at,
       creators_next_retry_at, fees_next_retry_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (mint) DO UPDATE SET
       enrichment_status = EXCLUDED.enrichment_status,
       creators_fetched_at = COALESCE(EXCLUDED.creators_fetched_at, bags_token_enrichments.creators_fetched_at),
       fees_fetched_at = COALESCE(EXCLUDED.fees_fetched_at, bags_token_enrichments.fees_fetched_at),
       creators_count = COALESCE(EXCLUDED.creators_count, bags_token_enrichments.creators_count),
       primary_creator_wallet = COALESCE(EXCLUDED.primary_creator_wallet, bags_token_enrichments.primary_creator_wallet),
       primary_creator_display_name = COALESCE(EXCLUDED.primary_creator_display_name, bags_token_enrichments.primary_creator_display_name),
       primary_creator_provider = COALESCE(EXCLUDED.primary_creator_provider, bags_token_enrichments.primary_creator_provider),
       primary_creator_royalty_bps = COALESCE(EXCLUDED.primary_creator_royalty_bps, bags_token_enrichments.primary_creator_royalty_bps),
       fees_lamports = COALESCE(EXCLUDED.fees_lamports, bags_token_enrichments.fees_lamports),
       last_error_code = EXCLUDED.last_error_code,
       last_error_status = EXCLUDED.last_error_status,
       last_error_message = EXCLUDED.last_error_message,
       next_retry_at = EXCLUDED.next_retry_at,
       creators_next_retry_at = EXCLUDED.creators_next_retry_at,
       fees_next_retry_at = EXCLUDED.fees_next_retry_at,
       updated_at = NOW()`,
    [
      data.mint,
      data.enrichmentStatus,
      data.creatorsFetchedAt ?? null,
      data.feesFetchedAt ?? null,
      data.creatorsCount ?? null,
      data.primaryCreatorWallet ?? null,
      data.primaryCreatorDisplayName ?? null,
      data.primaryCreatorProvider ?? null,
      data.primaryCreatorRoyaltyBps ?? null,
      data.feesLamports != null ? String(data.feesLamports) : null,
      data.lastErrorCode ?? null,
      data.lastErrorStatus ?? null,
      data.lastErrorMessage ?? null,
      data.nextRetryAt ?? null,
      data.creatorsNextRetryAt ?? null,
      data.feesNextRetryAt ?? null,
    ],
  );
}

/**
 * Replace all creators for a mint atomically (DELETE + INSERTs in one transaction).
 */
export async function replaceBagsCreatorsForMint(
  mint: string,
  creators: Array<{
    wallet: string;
    isCreator: boolean;
    displayName: string | null;
    provider: string | null;
    pfp: string | null;
    royaltyBps: number;
  }>,
): Promise<void> {
  await withTransaction(async (client: pg.PoolClient) => {
    await client.query("DELETE FROM bags_token_creators WHERE mint = $1", [mint]);
    for (const c of creators) {
      await client.query(
        `INSERT INTO bags_token_creators (mint, wallet, is_creator, display_name, provider, pfp, royalty_bps)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (mint, wallet) DO UPDATE SET
           is_creator = EXCLUDED.is_creator,
           display_name = EXCLUDED.display_name,
           provider = EXCLUDED.provider,
           pfp = EXCLUDED.pfp,
           royalty_bps = EXCLUDED.royalty_bps,
           fetched_at = NOW()`,
        [mint, c.wallet, c.isCreator, c.displayName ?? null, c.provider ?? null, c.pfp ?? null, c.royaltyBps],
      );
    }
  });
}

/**
 * Get enrichment row by mint (for verification).
 */
export async function getBagsEnrichmentByMint(mint: string): Promise<BagsEnrichmentRow | null> {
  const result = await query<BagsEnrichmentRow>(
    "SELECT * FROM bags_token_enrichments WHERE mint = $1",
    [mint],
  );
  return result.rows[0] ?? null;
}

/**
 * Get creators for a mint (for verification).
 */
export async function getBagsCreatorsByMint(mint: string): Promise<BagsCreatorRow[]> {
  const result = await query<BagsCreatorRow>(
    "SELECT * FROM bags_token_creators WHERE mint = $1 ORDER BY is_creator DESC, wallet",
    [mint],
  );
  return result.rows;
}
