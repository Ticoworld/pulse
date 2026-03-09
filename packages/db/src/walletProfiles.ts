import { query } from "./client";

export interface WalletProfile {
  id: string;
  wallet_address: string;
  watchlist_label: string | null;
  total_alpha_buys: number;
  total_candidate_hits: number;
  total_high_interest_hits: number;
  total_launch_mint_hits: number;
  avg_entry_delay_seconds: number | null;
  first_seen_at: Date | null;
  last_seen_at: Date | null;
  score: number;
  tier: "low" | "medium" | "high";
  metadata: any;
  created_at: Date;
  updated_at: Date;
}

export type UpsertWalletProfileData = Omit<
  WalletProfile,
  "id" | "created_at" | "updated_at"
>;

/**
 * Full row update/insert for a wallet profile.
 * Recomputes everything deterministically.
 */
export async function upsertWalletProfile(
  data: UpsertWalletProfileData,
): Promise<WalletProfile> {
  const sql = `
    INSERT INTO wallet_profiles (
      wallet_address,
      watchlist_label,
      total_alpha_buys,
      total_candidate_hits,
      total_high_interest_hits,
      total_launch_mint_hits,
      avg_entry_delay_seconds,
      first_seen_at,
      last_seen_at,
      score,
      tier,
      metadata,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    ON CONFLICT (wallet_address) DO UPDATE SET
      watchlist_label = COALESCE(EXCLUDED.watchlist_label, wallet_profiles.watchlist_label),
      total_alpha_buys = EXCLUDED.total_alpha_buys,
      total_candidate_hits = EXCLUDED.total_candidate_hits,
      total_high_interest_hits = EXCLUDED.total_high_interest_hits,
      total_launch_mint_hits = EXCLUDED.total_launch_mint_hits,
      avg_entry_delay_seconds = EXCLUDED.avg_entry_delay_seconds,
      first_seen_at = EXCLUDED.first_seen_at,
      last_seen_at = EXCLUDED.last_seen_at,
      score = EXCLUDED.score,
      tier = EXCLUDED.tier,
      metadata = EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *;
  `;
  const params = [
    data.wallet_address,
    data.watchlist_label,
    data.total_alpha_buys,
    data.total_candidate_hits,
    data.total_high_interest_hits,
    data.total_launch_mint_hits,
    data.avg_entry_delay_seconds,
    data.first_seen_at,
    data.last_seen_at,
    data.score,
    data.tier,
    data.metadata,
  ];
  const res = await query<WalletProfile>(sql, params);
  return res.rows[0];
}

/**
 * Fetch a wallet profile by its address.
 */
export async function getWalletProfile(
  address: string,
): Promise<WalletProfile | null> {
  const res = await query<WalletProfile>(
    "SELECT * FROM wallet_profiles WHERE wallet_address = $1",
    [address],
  );
  return res.rows[0] || null;
}

/**
 * List top wallet profiles by score.
 */
export async function listTopWalletProfiles(
  limit = 50,
): Promise<WalletProfile[]> {
  const res = await query<WalletProfile>(
    "SELECT * FROM wallet_profiles ORDER BY score DESC, total_high_interest_hits DESC LIMIT $1",
    [limit],
  );
  return res.rows;
}

/**
 * List wallet profiles by tier.
 */
export async function listWalletProfilesByTier(
  tier: string,
  limit = 50,
): Promise<WalletProfile[]> {
  const res = await query<WalletProfile>(
    "SELECT * FROM wallet_profiles WHERE tier = $1 ORDER BY score DESC LIMIT $2",
    [tier, limit],
  );
  return res.rows;
}
