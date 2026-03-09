/**
 * Phase 1 smoke script: read-only Bags client.
 * Env is loaded here (entrypoint); do not rely on the shared package to load dotenv.
 * Usage: npx ts-node -r tsconfig-paths/register --project tsconfig.json scripts/bags-smoke-readonly.ts [mint]
 * Or set BAGS_SMOKE_MINT in env.
 * Does not write to DB. Does not modify engine or Telegram.
 */
import "dotenv/config";

import { getBagsClient, isBagsClientError, isBagsLocalSoftCap, isBagsRateLimit } from "@pulse/bags";

function getMint(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return arg.trim();
  const env = process.env.BAGS_SMOKE_MINT;
  if (env && env.trim().length > 0) return env.trim();
  console.error("Usage: provide mint as first CLI arg or set BAGS_SMOKE_MINT");
  process.exit(1);
}

async function main() {
  const mint = getMint();
  console.log("[bags-smoke] mint:", mint);
  console.log("[bags-smoke] BAGS_API_KEY set:", !!process.env.BAGS_API_KEY);
  console.log("[bags-smoke] SOLANA_RPC_URL set:", !!process.env.SOLANA_RPC_URL);

  let client;
  try {
    client = getBagsClient();
  } catch (e) {
    console.error("[bags-smoke] client init failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // 1. getTokenCreators
  const creatorsResult = await client.getTokenCreators(mint);
  if (isBagsClientError(creatorsResult)) {
    if (isBagsLocalSoftCap(creatorsResult)) {
      console.error("[bags-smoke] getTokenCreators: LOCAL soft cap (in-process), not Bags API 429:", creatorsResult.message);
    } else if (isBagsRateLimit(creatorsResult)) {
      console.error("[bags-smoke] getTokenCreators: Bags API 429 rate limit:", creatorsResult.message);
      if (creatorsResult.status) console.error("[bags-smoke] status:", creatorsResult.status);
      if (creatorsResult.resetTime) console.error("[bags-smoke] resetTime:", creatorsResult.resetTime);
    } else {
      console.error("[bags-smoke] getTokenCreators error:", creatorsResult.code, creatorsResult.message);
      if ("status" in creatorsResult && creatorsResult.status) console.error("[bags-smoke] status:", creatorsResult.status);
    }
    process.exit(1);
  }
  console.log("[bags-smoke] getTokenCreators ok:", creatorsResult.creators.length, "creator(s)");
  if (creatorsResult.primaryCreator) {
    const p = creatorsResult.primaryCreator;
    console.log("  primary: wallet=" + p.wallet + " displayName=" + (p.displayName ?? "N/A") + " provider=" + (p.provider ?? "N/A") + " royaltyBps=" + p.royaltyBps);
  }
  creatorsResult.creators.forEach((c, i) => {
    if (!c.isCreator) console.log("  other[" + i + "]: wallet=" + c.wallet + " displayName=" + (c.displayName ?? "N/A"));
  });

  // 2. getTokenLifetimeFees
  const feesResult = await client.getTokenLifetimeFees(mint);
  if (isBagsClientError(feesResult)) {
    if (isBagsLocalSoftCap(feesResult)) {
      console.error("[bags-smoke] getTokenLifetimeFees: LOCAL soft cap (in-process), not Bags API 429:", feesResult.message);
    } else if (isBagsRateLimit(feesResult)) {
      console.error("[bags-smoke] getTokenLifetimeFees: Bags API 429 rate limit:", feesResult.message);
      if (feesResult.status) console.error("[bags-smoke] status:", feesResult.status);
      if (feesResult.resetTime) console.error("[bags-smoke] resetTime:", feesResult.resetTime);
    } else {
      console.error("[bags-smoke] getTokenLifetimeFees error:", feesResult.code, feesResult.message);
      if ("status" in feesResult && feesResult.status) console.error("[bags-smoke] status:", feesResult.status);
    }
    process.exit(1);
  }
  console.log("[bags-smoke] getTokenLifetimeFees ok:", feesResult.feesSol.toLocaleString(), "SOL", "(" + feesResult.feesLamports + " lamports)");

  const usage = client.getUsage();
  console.log("[bags-smoke] rate guard usage:", usage.count + "/" + usage.softCap);
  console.log("[bags-smoke] done.");
}

main().catch((e) => {
  console.error("[bags-smoke] unhandled:", e);
  process.exit(1);
});
