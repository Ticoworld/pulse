import {
  getActorByWallet,
  createActor,
  addWalletToActor,
  recomputeActorScore,
} from "@pulse/db";

// In-memory state: mint -> array of recent alpha buyers [{walletAddress, timestamp}]
// Note: In-memory co-buy observations are runtime-local and do not backfill historically.
const recentBuyers = new Map<
  string,
  { walletAddress: string; timestamp: number }[]
>();

// In-memory state: pair -> set of distinct mints they co-bought
// Map keys like "walletA|walletB" where walletA < walletB
const coBuyPairs = new Map<string, Set<string>>();

const CO_BUY_WINDOW_MS = 15_000;
const CO_BUY_THRESHOLD = 3;

function getPairKey(w1: string, w2: string): string {
  return w1 < w2 ? `${w1}|${w2}` : `${w2}|${w1}`;
}

export async function processAlphaBuy(
  mint: string,
  buyer: string,
  buyTimeMs: number,
): Promise<void> {
  if (!mint || !buyer) return;

  // 1. Clean up very old buyers for this mint to prevent memory leaks
  let buyers = recentBuyers.get(mint) || [];
  buyers = buyers.filter((b) => buyTimeMs - b.timestamp <= CO_BUY_WINDOW_MS);

  // 2. Check for co-buys with current buyer
  const newPairsToCheck: string[] = [];

  for (const b of buyers) {
    if (b.walletAddress === buyer) continue; // Same wallet

    const timeDiff = Math.abs(buyTimeMs - b.timestamp);
    if (timeDiff <= CO_BUY_WINDOW_MS) {
      // Co-buy detected
      const pairKey = getPairKey(buyer, b.walletAddress);

      let mints = coBuyPairs.get(pairKey);
      if (!mints) {
        mints = new Set<string>();
        coBuyPairs.set(pairKey, mints);
      }

      if (!mints.has(mint)) {
        mints.add(mint);

        // If threshold reached, evaluate clustering
        if (mints.size === CO_BUY_THRESHOLD) {
          newPairsToCheck.push(pairKey);
        }
      }
    }
  }

  // 3. Add current buyer to recent list
  buyers.push({ walletAddress: buyer, timestamp: buyTimeMs });
  recentBuyers.set(mint, buyers);

  // 4. Process new pairs that hit the threshold
  for (const pairKey of newPairsToCheck) {
    const [w1, w2] = pairKey.split("|");
    await evaluateCoBuyClustering(w1, w2);
  }
}

async function evaluateCoBuyClustering(w1: string, w2: string): Promise<void> {
  const actor1 = await getActorByWallet(w1);
  const actor2 = await getActorByWallet(w2);

  if (!actor1 && !actor2) {
    // Neither belongs to an actor: create one and add both
    const label = `Cluster_${w1.substring(0, 4)}_${w2.substring(0, 4)}`;
    const newActor = await createActor(label);
    console.log(`[cluster] actor created: ${newActor.id} (${label})`);

    await addWalletToActor(newActor.id, w1, "co_buy", 60);
    console.log(`[cluster] wallet added to actor: ${w1} -> ${newActor.id}`);

    await addWalletToActor(newActor.id, w2, "co_buy", 60);
    console.log(`[cluster] wallet added to actor: ${w2} -> ${newActor.id}`);

    await recomputeActorScore(newActor.id);
  } else if (actor1 && !actor2) {
    // One belongs to an actor (actor1): add w2 to actor1
    await addWalletToActor(actor1.id, w2, "co_buy", 60);
    console.log(`[cluster] wallet added to actor: ${w2} -> ${actor1.id}`);
    await recomputeActorScore(actor1.id);
  } else if (!actor1 && actor2) {
    // One belongs to an actor (actor2): add w1 to actor2
    await addWalletToActor(actor2.id, w1, "co_buy", 60);
    console.log(`[cluster] wallet added to actor: ${w1} -> ${actor2.id}`);
    await recomputeActorScore(actor2.id);
  } else if (actor1 && actor2 && actor1.id !== actor2.id) {
    // Both belong to DIFFERENT actors: skip and log conflict
    console.log(
      `[cluster] conflict: pair (${w1}, ${w2}) reached co-buy threshold, but belong to different actors (${actor1.id}, ${actor2.id}). Skipping merge.`,
    );
  }
  // If they both belong to the SAME actor, we do nothing (already clustered).
}
