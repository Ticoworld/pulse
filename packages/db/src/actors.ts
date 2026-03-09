import { query } from "./client";

export interface Actor {
  id: string;
  label: string | null;
  actor_type: string;
  wallet_count: number;
  score: number;
  tier: "low" | "medium" | "high";
  metadata: any;
  created_at: Date;
  updated_at: Date;
}

export interface ActorWallet {
  actor_id: string;
  wallet_address: string;
  confidence: number;
  method: string | null;
  created_at: Date;
}

export async function createActor(label?: string): Promise<Actor> {
  const res = await query<Actor>(
    `INSERT INTO actors (label) VALUES ($1) RETURNING *`,
    [label || null],
  );
  return res.rows[0];
}

export async function getActor(actorId: string): Promise<Actor | null> {
  const res = await query<Actor>("SELECT * FROM actors WHERE id = $1", [
    actorId,
  ]);
  return res.rows[0] || null;
}

export async function getActorByWallet(
  walletAddress: string,
): Promise<Actor | null> {
  const res = await query<Actor>(
    `SELECT a.* FROM actors a
     JOIN actor_wallets aw ON a.id = aw.actor_id
     WHERE aw.wallet_address = $1`,
    [walletAddress],
  );
  return res.rows[0] || null;
}

export async function addWalletToActor(
  actorId: string,
  walletAddress: string,
  method = "co_buy",
  confidence = 50,
): Promise<void> {
  await query(
    `INSERT INTO actor_wallets (actor_id, wallet_address, method, confidence)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [actorId, walletAddress, method, confidence],
  );

  // Update wallet_count
  await query(
    `UPDATE actors SET wallet_count = (
       SELECT count(*) FROM actor_wallets WHERE actor_id = $1
     ) WHERE id = $1`,
    [actorId],
  );
}

export async function listActorWallets(
  actorId: string,
): Promise<ActorWallet[]> {
  const res = await query<ActorWallet>(
    "SELECT * FROM actor_wallets WHERE actor_id = $1",
    [actorId],
  );
  return res.rows;
}

export async function listActors(limit = 50): Promise<Actor[]> {
  const res = await query<Actor>(
    "SELECT * FROM actors ORDER BY score DESC LIMIT $1",
    [limit],
  );
  return res.rows;
}

export async function updateActorScore(
  actorId: string,
  score: number,
  tier: string,
): Promise<void> {
  await query(
    "UPDATE actors SET score = $1, tier = $2, updated_at = now() WHERE id = $3",
    [score, tier, actorId],
  );
}

export async function recomputeActorScore(actorId: string): Promise<void> {
  // Aggregate wallet profiles belonging to the actor
  const walletsRes = await query<{
    score: number;
    tier: string;
    wallet_address: string;
  }>(
    `SELECT wp.score, wp.tier, wp.wallet_address
     FROM wallet_profiles wp
     JOIN actor_wallets aw ON wp.wallet_address = aw.wallet_address
     WHERE aw.actor_id = $1`,
    [actorId],
  );
  const wallets = walletsRes.rows;

  if (wallets.length === 0) return;

  let totalSourceScore = 0;
  let mediumCount = 0;
  let highCount = 0;

  for (const w of wallets) {
    totalSourceScore += w.score;
    if (w.tier === "medium") mediumCount++;
    if (w.tier === "high") highCount++;
  }

  // Basic aggregation formula
  let finalScore = totalSourceScore;

  finalScore += mediumCount * 5;
  finalScore += highCount * 10;

  // Distinct HIGH_INTEREST_TOKEN mints across all actor wallets
  const hiRes = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT s.token_mint) as count 
     FROM signals s
     JOIN actor_wallets aw ON s.wallet_address = aw.wallet_address
     WHERE aw.actor_id = $1 AND s.type = 'HIGH_INTEREST_TOKEN'`,
    [actorId],
  );
  const hiDistinctCount = parseInt(hiRes.rows[0].count, 10);

  if (hiDistinctCount >= 2) {
    finalScore += 10;
  }

  let tier = "low";
  if (finalScore >= 120) tier = "high";
  else if (finalScore >= 50) tier = "medium";

  await updateActorScore(actorId, finalScore, tier);
  console.log(
    `[cluster] actor ${actorId} score updated to ${finalScore} (tier: ${tier})`,
  );
}
