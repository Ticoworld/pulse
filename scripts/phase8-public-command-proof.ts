/**
 * Local command-path proof for Phase 8 without Telegram interaction.
 * Proves:
 *  - one public /top_candidates use
 *  - one public /mint use
 *  - one cooldown hit
 *
 * Run:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/phase8-public-command-proof.ts
 */
import "dotenv/config";
import {
  getTopCandidateSignalsForDigest,
  getMintSummaryForTelegram,
  getTelegramCommandCooldownRemainingSeconds,
  upsertTelegramUser,
  recordTelegramCommandEvent,
  HIGH_INTEREST_THRESHOLD,
  type TopCandidateForDigest,
} from "@pulse/db";
import { formatMintSummary, formatTopCandidatesDigest } from "../apps/tg-bot/src/formatters";

const COOLDOWN_SECONDS = 30;
const COOLDOWN_COMMANDS = ["/top_candidates", "/mint"];

function firstLines(text: string, count: number): string {
  return text.split("\n").slice(0, count).join("\n");
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const base = 9_000_000_000 + Date.now();
  const userA = base;
  const userB = base + 1;

  await upsertTelegramUser({
    telegramUserId: userA,
    username: "phase8_proof_user_a",
    firstName: "Phase8",
    lastName: "ProofA",
    lastCommand: "/top_candidates",
    isOwner: false,
  });

  const topRows = await getTopCandidateSignalsForDigest(
    5,
    24,
    HIGH_INTEREST_THRESHOLD,
  );
  const topAlert = formatTopCandidatesDigest(
    topRows.map((r: TopCandidateForDigest) => ({
      mint: r.mint,
      score: r.score,
      metadata: r.metadata,
      alpha_wallet_trigger: r.alpha_wallet_trigger,
      liquidity_live_trigger: r.liquidity_live_trigger,
      dev_trigger: r.dev_trigger,
      primary_creator_display_name: r.primary_creator_display_name,
      primary_creator_provider: r.primary_creator_provider,
      fees_lamports: r.fees_lamports,
    })),
    { title: "Top HIGH_INTEREST candidates", freshnessHours: 24 },
  );
  await recordTelegramCommandEvent({
    telegramUserId: userA,
    command: "/top_candidates",
    commandArgs: "5",
    success: true,
  });

  console.log("--- public /top_candidates use (user A) ---");
  console.log(firstLines(topAlert.text, 8));
  console.log("--- end /top_candidates ---\n");

  const proofMint =
    topRows[0]?.mint ??
    process.env.PHASE8_PROOF_MINT ??
    "CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS";

  await upsertTelegramUser({
    telegramUserId: userB,
    username: "phase8_proof_user_b",
    firstName: "Phase8",
    lastName: "ProofB",
    lastCommand: "/mint",
    isOwner: false,
  });

  const cooldownBeforeMint = await getTelegramCommandCooldownRemainingSeconds(
    userB,
    COOLDOWN_COMMANDS,
    COOLDOWN_SECONDS,
  );
  if (cooldownBeforeMint > 0) {
    console.log(`[proof] user B already in cooldown: ${cooldownBeforeMint}s`);
  }

  const mintSummary = await getMintSummaryForTelegram(proofMint);
  const mintAlert = formatMintSummary({
    mint: mintSummary.mint,
    foundInDb: mintSummary.foundInDb,
    score: mintSummary.score,
    bagsBonus: mintSummary.bagsBonus,
    primaryCreatorDisplayName: mintSummary.primaryCreatorDisplayName,
    primaryCreatorProvider: mintSummary.primaryCreatorProvider,
    feesLamports: mintSummary.feesLamports,
    hasHighInterestSignal: mintSummary.hasHighInterestSignal,
  });
  await recordTelegramCommandEvent({
    telegramUserId: userB,
    command: "/mint",
    commandArgs: proofMint,
    success: true,
  });

  console.log("--- public /mint use (user B) ---");
  console.log(mintAlert.text);
  console.log("--- end /mint ---\n");

  await upsertTelegramUser({
    telegramUserId: userB,
    username: "phase8_proof_user_b",
    firstName: "Phase8",
    lastName: "ProofB",
    lastCommand: "/top_candidates",
    isOwner: false,
  });

  const cooldownHit = await getTelegramCommandCooldownRemainingSeconds(
    userB,
    COOLDOWN_COMMANDS,
    COOLDOWN_SECONDS,
  );

  if (cooldownHit > 0) {
    const message = `Too many requests. Try again in ${cooldownHit}s.`;
    await recordTelegramCommandEvent({
      telegramUserId: userB,
      command: "/top_candidates",
      commandArgs: null,
      success: false,
      errorMessage: `cooldown_${cooldownHit}s`,
    });
    console.log("--- cooldown hit (user B) ---");
    console.log(message);
    console.log("--- end cooldown ---");
    return;
  }

  console.log("--- cooldown hit (user B) ---");
  console.log("Expected cooldown hit but remaining was 0s.");
  console.log("--- end cooldown ---");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
