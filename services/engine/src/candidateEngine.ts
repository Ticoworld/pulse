import {
  upsertCandidateSignal,
  insertSignal,
  query,
  getLaunchDevLinkByMint,
  Signal,
  getWalletProfile,
  getActorByWallet,
  getDevProfile,
  getBagsEnrichmentByMint,
  HIGH_INTEREST_THRESHOLD,
} from "@pulse/db";
import { recomputeWallet } from "./walletScorer";

const BAGS_BONUS_CAP = Math.min(Math.floor(HIGH_INTEREST_THRESHOLD * 0.2), 2);

/**
 * Recomputes the candidate score and state for a given mint based on derived signals.
 * This is the single source of truth for candidate evaluation.
 */
export async function recomputeCandidate(mint: string): Promise<void> {
  const signalsRes = await query<Signal>(
    `SELECT type, wallet_address, signature, slot, payload
     FROM signals
     WHERE token_mint = $1`,
    [mint],
  );
  const signals = signalsRes.rows;

  const liquiditySignal = signals.find((s) => s.type === "LIQUIDITY_LIVE");
  const alphaSignal = signals.find((s) => s.type === "ALPHA_WALLET_BUY");

  const devLink = await getLaunchDevLinkByMint(mint);
  let devProfile = null;
  if (devLink?.probable_dev_wallet) {
    devProfile = await getDevProfile(devLink.probable_dev_wallet);
  }

  let score = 0;
  const liquidity_live_trigger = !!liquiditySignal;
  const alpha_wallet_trigger = !!alphaSignal;
  let dev_trigger = false;

  if (liquidity_live_trigger) score += 20;
  if (alpha_wallet_trigger) score += 40;

  if (devProfile && devProfile.launch_count > 1) {
    dev_trigger = true;
    score += 20;
    if (devProfile.liquidity_live_count > 1) {
      score += 10;
    }
  }

  const alpha_wallet_address: string | null = alphaSignal?.wallet_address || null;
  if (alpha_wallet_address) {
    const walletProfile = await getWalletProfile(alpha_wallet_address);
    if (walletProfile?.tier === "high") {
      score += 10;
      console.log(
        `[candidate] wallet bonus: +10 (tier: high) for ${alpha_wallet_address}`,
      );
    } else if (walletProfile?.tier === "medium") {
      score += 5;
      console.log(
        `[candidate] wallet bonus: +5 (tier: medium) for ${alpha_wallet_address}`,
      );
    }

    const actor = await getActorByWallet(alpha_wallet_address);
    if (actor?.tier === "high") {
      score += 10;
      console.log(
        `[candidate] actor bonus: +10 (tier: high) for actor ${actor.id}`,
      );
    } else if (actor?.tier === "medium") {
      score += 5;
      console.log(
        `[candidate] actor bonus: +5 (tier: medium) for actor ${actor.id}`,
      );
    }
  }

  const baseScore = score;

  const bagsEnrichment = await getBagsEnrichmentByMint(mint);
  const hasCreatorIdentity = Boolean(
    bagsEnrichment?.primary_creator_wallet || bagsEnrichment?.primary_creator_display_name,
  );
  const feesLamports =
    bagsEnrichment?.fees_lamports != null ? Number(bagsEnrichment.fees_lamports) : null;
  const hasMeaningfulBagsContext =
    hasCreatorIdentity || bagsEnrichment?.fees_lamports != null;

  const bagsBonusComponents = {
    bags_resolved_context_bonus: 0,
    bags_creator_identity_bonus: 0,
    bags_fees_bonus: 0,
  };
  const bagsReasons: string[] = [];

  if (
    bagsEnrichment?.enrichment_status === "resolved" &&
    hasMeaningfulBagsContext
  ) {
    bagsBonusComponents.bags_resolved_context_bonus = 1;
    bagsReasons.push("resolved_context");

    if (hasCreatorIdentity) {
      bagsBonusComponents.bags_creator_identity_bonus = 1;
      bagsReasons.push("creator_identity_present");
    }

    if (feesLamports != null && feesLamports > 0) {
      bagsBonusComponents.bags_fees_bonus = 1;
      bagsReasons.push("fees_nonzero");
    }
  }

  const bagsBonusRaw =
    bagsBonusComponents.bags_resolved_context_bonus +
    bagsBonusComponents.bags_creator_identity_bonus +
    bagsBonusComponents.bags_fees_bonus;
  const bagsBonus = Math.min(bagsBonusRaw, BAGS_BONUS_CAP);
  if (bagsBonusRaw > bagsBonus) {
    bagsReasons.push("bonus_capped");
  }

  const finalScore = baseScore + bagsBonus;

  await upsertCandidateSignal({
    mint,
    score: finalScore,
    alpha_wallet_trigger,
    liquidity_live_trigger,
    dev_trigger,
    alpha_wallet: alphaSignal?.wallet_address || null,
    probable_dev_wallet: devLink?.probable_dev_wallet || null,
    dev_prior_launches: devProfile?.launch_count || null,
    dev_liquidity_live_count: devProfile?.liquidity_live_count || null,
    liquidity_live_seq: (liquiditySignal?.payload?.seq as string) || null,
    alpha_trigger_seq: (alphaSignal?.payload?.seq as string) || null,
    metadata: {
      last_recompute_at: new Date().toISOString(),
      base_score: baseScore,
      bags_bonus: bagsBonus,
      bags_bonus_cap: BAGS_BONUS_CAP,
      bags_bonus_components: bagsBonusComponents,
      bags_reasons: bagsReasons,
      final_score: finalScore,
    },
  });

  for (const sig of signals.filter((s) => s.type === "ALPHA_WALLET_BUY")) {
    if (sig.wallet_address) {
      await recomputeWallet(sig.wallet_address);
    }
  }

  console.log(
    `[candidate] recomputed mint=${mint} baseScore=${baseScore} bagsBonus=${bagsBonus} finalScore=${finalScore} triggers=[liq:${liquidity_live_trigger}, alpha:${alpha_wallet_trigger}, dev:${dev_trigger}]`,
  );

  if (finalScore >= HIGH_INTEREST_THRESHOLD && liquidity_live_trigger) {
    const existingHighInterest = signals.find(
      (s) => s.type === "HIGH_INTEREST_TOKEN",
    );
    if (!existingHighInterest) {
      const triggerSig =
        alphaSignal?.signature || liquiditySignal?.signature || "manual";
      const triggerSlot = alphaSignal?.slot || liquiditySignal?.slot || 0;

      await insertSignal({
        type: "HIGH_INTEREST_TOKEN",
        tokenMint: mint,
        signature: triggerSig,
        slot: Number(triggerSlot),
        payload: {
          mint,
          score: finalScore,
          base_score: baseScore,
          bags_bonus: bagsBonus,
          bags_bonus_cap: BAGS_BONUS_CAP,
          bags_reasons: bagsReasons,
          triggers: {
            liquidity: liquidity_live_trigger,
            alpha: alpha_wallet_trigger,
            dev: dev_trigger,
          },
          alpha_wallet: alphaSignal?.wallet_address || null,
          dev_wallet: devLink?.probable_dev_wallet || null,
          dev_launches: devProfile?.launch_count || 0,
          dev_liquidity_success: devProfile?.liquidity_live_count || 0,
          primary_creator_display_name: bagsEnrichment?.primary_creator_display_name ?? null,
          primary_creator_provider: bagsEnrichment?.primary_creator_provider ?? null,
          fees_lamports: feesLamports,
        },
        walletAddress: alphaSignal?.wallet_address ?? undefined,
      });
      console.log(
        `[candidate] HIGH_INTEREST_TOKEN emitted mint=${mint} score=${finalScore} (base=${baseScore}, bagsBonus=${bagsBonus})`,
      );

      for (const sig of signals.filter((s) => s.type === "ALPHA_WALLET_BUY")) {
        if (sig.wallet_address) {
          await recomputeWallet(sig.wallet_address);
        }
      }
    }
  }
}
