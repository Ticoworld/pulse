# Phase 7 sign-off — actual files and proofs

Paste-back for PM. All files are the real current contents, not summaries.

---

## 1. candidateSignals.ts

**Path:** `packages/db/src/candidateSignals.ts`

```typescript
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
```

---

## 2. scoringConstants.ts

**Path:** `packages/db/src/scoringConstants.ts`

```typescript
/** Minimum score for HIGH_INTEREST_TOKEN; single source of truth for engine and digest. */
export const HIGH_INTEREST_THRESHOLD = 60;
```

---

## 3. patched candidateEngine.ts

**Path:** `services/engine/src/candidateEngine.ts`

```typescript
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
```

---

## 4. patched formatters.ts

**Path:** `apps/tg-bot/src/formatters.ts`

(Only the Phase 7–relevant parts: `TopCandidateDigestRow`, `formatTopCandidatesDigest` — default title and empty state are HIGH_INTEREST.)

```typescript
/** One row for top-candidates digest (score + optional Bags context). */
export interface TopCandidateDigestRow {
  mint: string;
  score: number;
  metadata: Record<string, unknown> | null;
  alpha_wallet_trigger: boolean;
  liquidity_live_trigger: boolean;
  dev_trigger: boolean;
  primary_creator_display_name: string | null;
  primary_creator_provider: string | null;
  fees_lamports: string | null;
}

/**
 * Format ranked digest of top HIGH_INTEREST candidates for Telegram (plain text).
 * Shows rank, mint, final/base score, Bags bonus, triggers, creator, fees. Compact.
 */
export function formatTopCandidatesDigest(
  rows: TopCandidateDigestRow[],
  opts: { title?: string; freshnessHours?: number } = {},
): FormattedAlert {
  const title = opts.title ?? "Top HIGH_INTEREST candidates";
  const freshness = opts.freshnessHours ?? 24;
  const lines: string[] = [`${title} (last ${freshness}h, by score)`, ""];

  if (rows.length === 0) {
    lines.push("No HIGH_INTEREST candidates in freshness window.");
    return { text: lines.join("\n"), format: "plain" };
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rank = i + 1;
    const meta = asRecord(r.metadata ?? {});
    const baseScore = toText(meta.base_score) ?? "-";
    const bagsBonus = toText(meta.bags_bonus) ?? "0";
    const triggers: string[] = [];
    if (r.liquidity_live_trigger) triggers.push("liq");
    if (r.alpha_wallet_trigger) triggers.push("alpha");
    if (r.dev_trigger) triggers.push("dev");
    const triggerStr = triggers.length ? triggers.join(",") : "-";
    const bagsReasons = Array.isArray(meta.bags_reasons)
      ? (meta.bags_reasons as unknown[]).map((x) => toText(x)).filter((x): x is string => Boolean(x))
      : [];
    const bagsStr = bagsReasons.length ? bagsReasons.join(",") : "-";
    const creator = r.primary_creator_display_name ?? null;
    const creatorStr = creator
      ? `${creator}${r.primary_creator_provider ? ` (${r.primary_creator_provider})` : ""}`
      : "-";
    const feesStr = r.fees_lamports ?? "-";

    lines.push(
      `${rank}. ${r.mint}`,
      `   score=${r.score} base=${baseScore} bags=${bagsBonus} | ${triggerStr} | bags: ${bagsStr}`,
      `   creator: ${creatorStr} | fees: ${feesStr}`,
      "",
    );
  }

  return { text: lines.join("\n").trimEnd(), format: "plain", disableWebPagePreview: true };
}
```

---

## 5. patched TOP_CANDIDATES_DIGEST_PHASE7.md

**Path:** `TOP_CANDIDATES_DIGEST_PHASE7.md`

(See repo file `TOP_CANDIDATES_DIGEST_PHASE7.md` — contents already match the Phase 7 patch: HIGH_INTEREST wording, threshold in `@pulse/db`, filter, ranking, sample. Attach that file as-is.)

---

## 6. One local digest proof

**Command run:**  
`npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/top-candidates-digest-local.ts`

**Terminal output:**

```
--- /top_candidates digest (HIGH_INTEREST only, local, no Telegram) ---

Top HIGH_INTEREST candidates (last 24h, by score)

1. CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS
   score=62 base=60 bags=2 | liq,alpha | bags: resolved_context,creator_identity_present,fees_nonzero,bonus_capped
   creator: PublicFundApp (twitter) | fees: 369655050567

--- end ---
```

---

## 7. One Telegram proof

**How to get it:** With the bot running (`npm run dev:bot`), in Telegram (as owner) send `/top_candidates`. The bot should reply with the same “Top HIGH_INTEREST candidates (last 24h, by score)” digest.

**What to attach:** A screenshot of that Telegram exchange (your `/top_candidates` message and the bot’s digest reply), or paste the bot’s reply text here.

---

**Checklist for PM**

- [ ] candidateSignals.ts — filter `AND cs.score >= $3`, `minScore` param
- [ ] scoringConstants.ts — `HIGH_INTEREST_THRESHOLD = 60`
- [ ] candidateEngine.ts — imports `HIGH_INTEREST_THRESHOLD` from `@pulse/db`, no local threshold
- [ ] formatters.ts — “Top HIGH_INTEREST candidates”, “No HIGH_INTEREST candidates in freshness window.”
- [ ] TOP_CANDIDATES_DIGEST_PHASE7.md — HIGH_INTEREST, threshold source, filter, ranking
- [ ] Local digest proof — script output above
- [ ] Telegram proof — screenshot or pasted bot reply
