import {
  query,
  upsertWalletProfile,
  Signal,
  WalletProfile,
  getCandidateSignalByMint,
  getActorByWallet,
  recomputeActorScore,
} from "@pulse/db";

/**
 * Recomputes the wallet profile score and metrics deterministically.
 */
export async function recomputeWallet(walletAddress: string): Promise<void> {
  // 1. Load all alpha buys for this wallet
  const buysRes = await query<Signal>(
    `SELECT token_mint, signature, slot, created_at, payload 
     FROM signals 
     WHERE wallet_address = $1 AND type = 'ALPHA_WALLET_BUY'
     ORDER BY created_at ASC`,
    [walletAddress],
  );
  const allBuys = buysRes.rows;
  if (allBuys.length === 0) return;

  // Track distinct mints
  const distinctMints = Array.from(
    new Set(allBuys.map((b) => b.token_mint).filter(Boolean)),
  );
  const total_alpha_buys = distinctMints.length;

  // 2. Aggregate metrics across distinct mints
  let total_candidate_hits = 0;
  let total_high_interest_hits = 0;
  let total_launch_mint_hits = 0;
  const entryDelays: number[] = [];

  for (const mint of distinctMints as string[]) {
    // Check candidate signal
    const candidate = await getCandidateSignalByMint(mint);
    if (candidate) {
      total_candidate_hits++;
    }

    // Check high interest token signal
    const hiRes = await query(
      `SELECT id FROM signals WHERE token_mint = $1 AND type = 'HIGH_INTEREST_TOKEN' LIMIT 1`,
      [mint],
    );
    if (hiRes.rows.length > 0) {
      total_high_interest_hits++;
    }

    // Check launch candidate for timing and launch hits
    const launchRes = await query<any>(
      `SELECT first_seen_at, liquidity_live_at FROM launch_candidates WHERE mint = $1`,
      [mint],
    );
    if (launchRes.rows.length > 0) {
      total_launch_mint_hits++;
      const launch = launchRes.rows[0];
      const launchTs = launch.liquidity_live_at || launch.first_seen_at;

      if (launchTs) {
        // Find earliest buy for this mint
        const firstBuy = allBuys.find((b) => b.token_mint === mint);
        if (firstBuy) {
          const delay =
            (new Date(firstBuy.created_at).getTime() -
              new Date(launchTs).getTime()) /
            1000;
          if (delay >= 0) {
            entryDelays.push(delay);
          }
        }
      }
    }
  }

  const avg_entry_delay_seconds =
    entryDelays.length > 0
      ? Math.floor(entryDelays.reduce((a, b) => a + b, 0) / entryDelays.length)
      : null;

  // 3. Scoring Formula v1
  let score = 0;

  // +1 per buy (cap 15)
  score += Math.min(total_alpha_buys, 15);

  // +5 per candidate hit (cap 25)
  score += Math.min(total_candidate_hits * 5, 25);

  // +8 per high interest hit (cap 32)
  score += Math.min(total_high_interest_hits * 8, 32);

  // Timing bonuses
  if (avg_entry_delay_seconds !== null) {
    if (avg_entry_delay_seconds <= 120) score += 8;
    else if (avg_entry_delay_seconds <= 300) score += 4;
  }

  // Launch exposure
  if (total_launch_mint_hits >= 3) score += 6;

  // Noise penalty: many buys but zero/low quality
  if (total_alpha_buys >= 10 && total_candidate_hits <= 1) {
    score -= 10;
  }

  // Final floor
  if (score < 0) score = 0;

  // Map to tier
  let tier: WalletProfile["tier"] = "low";
  if (score >= 45) tier = "high";
  else if (score >= 20) tier = "medium";

  // 4. Upsert profile
  const firstSeen = allBuys[0].created_at;
  const lastSeen = allBuys[allBuys.length - 1].created_at;

  await upsertWalletProfile({
    wallet_address: walletAddress,
    watchlist_label: null, // Keep existing if any (handled in upsert helper)
    total_alpha_buys,
    total_candidate_hits,
    total_high_interest_hits,
    total_launch_mint_hits,
    avg_entry_delay_seconds,
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    score,
    tier,
    metadata: {
      last_recompute_at: new Date().toISOString(),
      mints_processed: distinctMints.length,
    },
  });

  console.log(
    `[wallet-scorer] recomputed wallet=${walletAddress} score=${score} tier=${tier} [buys:${total_alpha_buys}, cand:${total_candidate_hits}, hi:${total_high_interest_hits}]`,
  );

  // 5. Recompute Actor Score if wallet belongs to an actor
  const actor = await getActorByWallet(walletAddress);
  if (actor) {
    await recomputeActorScore(actor.id);
  }
}
