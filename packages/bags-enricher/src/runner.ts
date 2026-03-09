import { getBagsClient, isBagsClientError } from "@pulse/bags";
import {
  getLaunchCandidatesNeedingEnrichment,
  getLaunchCandidateByMint,
  getLaunchCandidateMintNeedingEnrichment,
  getBagsEnrichmentByMint,
  getCandidateSignalByMint,
  insertSignal,
  upsertBagsEnrichment,
  replaceBagsCreatorsForMint,
} from "@pulse/db";
import {
  CREATORS_TTL_HOURS,
  FEES_TTL_MINUTES,
  DEFAULT_LIMIT,
  DEFAULT_SINCE_HOURS,
  type EnrichmentRunOptions,
  type EnrichmentRunResult,
  type EnrichmentStopReason,
} from "./types";

const BAGS_ENRICHMENT_RESOLVED_SIGNAL = "BAGS_ENRICHMENT_RESOLVED";

function isAuthError(e: unknown): boolean {
  if (!isBagsClientError(e)) return false;
  return e.code === "BAGS_AUTH" || e.code === "BAGS_FORBIDDEN";
}

function isStopCleanly(e: unknown): boolean {
  if (!isBagsClientError(e)) return false;
  return e.code === "BAGS_LOCAL_SOFT_CAP" || e.code === "BAGS_RATE_LIMIT";
}

function isWithinFreshnessBoundary(createdAt: Date, sinceHours: number): boolean {
  const cutoff = Date.now() - sinceHours * 60 * 60 * 1000;
  return createdAt.getTime() >= cutoff;
}

/**
 * Run one enrichment cycle: select candidates, then for each mint run side-aware
 * Bags calls and persist. Returns stop reason and counts; does not exit process.
 */
export async function runEnrichment(opts: EnrichmentRunOptions = {}): Promise<EnrichmentRunResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
  const singleMint = opts.mint ?? null;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  const creatorsTtlHours = opts.creatorsTtlHours ?? CREATORS_TTL_HOURS;
  const feesTtlMinutes = opts.feesTtlMinutes ?? FEES_TTL_MINUTES;
  const logPrefix = opts.logPrefix ?? "[bags-enrich]";

  let candidates: { mint: string; liquidity_live_at: Date | null; created_at: Date; needs_creators: boolean; needs_fees: boolean }[];

  if (singleMint) {
    const inTable = await getLaunchCandidateByMint(singleMint);
    if (!inTable) {
      throw new Error(`mint not in launch_candidates: ${singleMint}`);
    }
    const candidate = await getLaunchCandidateMintNeedingEnrichment(singleMint, {
      creatorsTtlHours,
      feesTtlMinutes,
      force,
    });
    if (!candidate) {
      throw new Error(`mint does not currently need enrichment (use force): ${singleMint}`);
    }
    candidates = [{
      mint: candidate.mint,
      liquidity_live_at: candidate.liquidity_live_at,
      created_at: inTable.created_at,
      needs_creators: candidate.needs_creators,
      needs_fees: candidate.needs_fees,
    }];
  } else {
    candidates = await getLaunchCandidatesNeedingEnrichment({
      limit,
      sinceHours,
      creatorsTtlHours,
      feesTtlMinutes,
    });
  }

  if (candidates.length === 0) {
    console.log(logPrefix, "no candidates needing enrichment");
    return { stopReason: null, processedCount: 0, candidateCount: 0 };
  }

  console.log(logPrefix, "mints to process:", candidates.length);

  if (dryRun) {
    console.log(logPrefix, "DRY RUN — no Bags client, no Bags calls, no DB writes");
    for (const c of candidates) {
      console.log(logPrefix, "mint=" + c.mint + " needsCreators=" + c.needs_creators + " needsFees=" + c.needs_fees);
    }
    console.log(logPrefix, "finished");
    return { stopReason: null, processedCount: candidates.length, candidateCount: candidates.length };
  }

  const client = getBagsClient();
  const retryBackoffMs = 60 * 60 * 1000; // 1 hour
  let processedCount = 0;
  let stopReason: EnrichmentStopReason = null;

  for (const c of candidates) {
    const { mint, needs_creators, needs_fees } = c;
    const attempted: string[] = [];
    if (needs_creators) attempted.push("creators");
    if (needs_fees) attempted.push("fees");
    console.log(logPrefix, "mint=" + mint + " needsCreators=" + needs_creators + " needsFees=" + needs_fees);
    console.log(logPrefix, "attempted: " + (attempted.length ? attempted.join(",") : "none"));

    const existing = await getBagsEnrichmentByMint(mint);
    const hasCreators = existing != null && existing.creators_fetched_at != null;
    const hasFees = existing != null && existing.fees_fetched_at != null;

    let creatorsOk = false;
    let feesOk = false;
    let creatorsCount: number | null = existing?.creators_count ?? null;
    let primaryCreatorWallet: string | null = existing?.primary_creator_wallet ?? null;
    let primaryCreatorDisplayName: string | null = existing?.primary_creator_display_name ?? null;
    let primaryCreatorProvider: string | null = existing?.primary_creator_provider ?? null;
    let primaryCreatorRoyaltyBps: number | null = existing?.primary_creator_royalty_bps ?? null;
    let feesLamports: number | null = existing?.fees_lamports != null ? Number(existing.fees_lamports) : null;
    let creators: Array<{ wallet: string; isCreator: boolean; displayName: string | null; provider: string | null; pfp: string | null; royaltyBps: number }> = [];
    let creatorsFetchedAt: Date | null = existing?.creators_fetched_at ?? null;
    let feesFetchedAt: Date | null = existing?.fees_fetched_at ?? null;
    let creatorsNextRetryAt: Date | null = existing?.creators_next_retry_at ?? null;
    let feesNextRetryAt: Date | null = existing?.fees_next_retry_at ?? null;
    let lastErrorCode: string | null = existing?.last_error_code ?? null;
    let lastErrorStatus: number | null = existing?.last_error_status ?? null;
    let lastErrorMessage: string | null = existing?.last_error_message ?? null;

    if (needs_creators) {
      const creatorsResult = await client.getTokenCreators(mint);
      if (isAuthError(creatorsResult)) {
        console.error(logPrefix, "auth error, stopping:", (creatorsResult as { message: string }).message);
        return { stopReason: "auth", processedCount, candidateCount: candidates.length };
      }
      if (isStopCleanly(creatorsResult)) {
        console.error(logPrefix, "stop (local soft cap or Bags 429):", (creatorsResult as { message: string }).message);
        stopReason = isBagsClientError(creatorsResult) && creatorsResult.code === "BAGS_RATE_LIMIT" ? "rate_limit" : "soft_cap";
        return { stopReason, processedCount, candidateCount: candidates.length };
      }
      if (isBagsClientError(creatorsResult)) {
        lastErrorCode = creatorsResult.code;
        if ("status" in creatorsResult && creatorsResult.status != null) lastErrorStatus = creatorsResult.status;
        lastErrorMessage = creatorsResult.message;
        creatorsNextRetryAt = new Date(Date.now() + retryBackoffMs);
        console.warn(logPrefix, "creators failed for", mint, creatorsResult.code, creatorsResult.message);
      } else {
        creatorsOk = true;
        creatorsFetchedAt = new Date();
        creatorsNextRetryAt = null;
        creatorsCount = creatorsResult.creators.length;
        if (creatorsResult.primaryCreator) {
          primaryCreatorWallet = creatorsResult.primaryCreator.wallet;
          primaryCreatorDisplayName = creatorsResult.primaryCreator.displayName ?? null;
          primaryCreatorProvider = creatorsResult.primaryCreator.provider ?? null;
          primaryCreatorRoyaltyBps = creatorsResult.primaryCreator.royaltyBps;
        }
        creators = creatorsResult.creators.map((cr) => ({
          wallet: cr.wallet,
          isCreator: cr.isCreator,
          displayName: cr.displayName ?? null,
          provider: cr.provider ?? null,
          pfp: cr.pfp ?? null,
          royaltyBps: cr.royaltyBps,
        }));
      }
    }

    if (needs_fees) {
      const feesResult = await client.getTokenLifetimeFees(mint);
      if (isAuthError(feesResult)) {
        console.error(logPrefix, "auth error, stopping:", (feesResult as { message: string }).message);
        return { stopReason: "auth", processedCount, candidateCount: candidates.length };
      }
      if (isStopCleanly(feesResult)) {
        console.error(logPrefix, "stop (local soft cap or Bags 429):", (feesResult as { message: string }).message);
        stopReason = isBagsClientError(feesResult) && feesResult.code === "BAGS_RATE_LIMIT" ? "rate_limit" : "soft_cap";
        return { stopReason, processedCount, candidateCount: candidates.length };
      }
      if (isBagsClientError(feesResult)) {
        lastErrorCode = feesResult.code;
        if ("status" in feesResult && feesResult.status != null) lastErrorStatus = feesResult.status;
        lastErrorMessage = feesResult.message;
        feesNextRetryAt = new Date(Date.now() + retryBackoffMs);
        console.warn(logPrefix, "fees failed for", mint, feesResult.code);
      } else {
        feesOk = true;
        feesFetchedAt = new Date();
        feesNextRetryAt = null;
        feesLamports = feesResult.feesLamports;
      }
    }

    const attemptedCreators = needs_creators;
    const attemptedFees = needs_fees;
    const bothOk = (attemptedCreators ? creatorsOk : hasCreators) && (attemptedFees ? feesOk : hasFees);
    if (bothOk) {
      lastErrorCode = null;
      lastErrorStatus = null;
      lastErrorMessage = null;
    }
    const anyOk = (attemptedCreators ? creatorsOk : hasCreators) || (attemptedFees ? feesOk : hasFees);
    const anyAttemptedFailed = (attemptedCreators && !creatorsOk) || (attemptedFees && !feesOk);
    const status =
      bothOk ? "resolved"
        : anyOk ? "partial"
          : anyAttemptedFailed ? "error"
            : "pending";
    const wasResolved = existing?.enrichment_status === "resolved";
    const hasMeaningfulResolvedContext = Boolean(
      primaryCreatorWallet || primaryCreatorDisplayName || feesLamports != null,
    );

    await upsertBagsEnrichment({
      mint,
      enrichmentStatus: status,
      creatorsFetchedAt,
      feesFetchedAt,
      creatorsCount,
      primaryCreatorWallet,
      primaryCreatorDisplayName,
      primaryCreatorProvider,
      primaryCreatorRoyaltyBps,
      feesLamports,
      lastErrorCode: lastErrorCode ?? undefined,
      lastErrorStatus: lastErrorStatus ?? undefined,
      lastErrorMessage: lastErrorMessage ?? undefined,
      nextRetryAt: status === "error" ? new Date(Date.now() + retryBackoffMs) : null,
      creatorsNextRetryAt: creatorsNextRetryAt ?? undefined,
      feesNextRetryAt: feesNextRetryAt ?? undefined,
    });

    if (attemptedCreators && creatorsOk) {
      await replaceBagsCreatorsForMint(mint, creators);
    }

    const shouldEmitBagsResolved =
      status === "resolved" &&
      !wasResolved &&
      hasMeaningfulResolvedContext &&
      isWithinFreshnessBoundary(c.created_at, sinceHours);

    if (shouldEmitBagsResolved) {
      const candidateSignal = await getCandidateSignalByMint(mint);
      await insertSignal({
        type: BAGS_ENRICHMENT_RESOLVED_SIGNAL,
        tokenMint: mint,
        signature: `bags-enrichment-resolved:${mint}`,
        slot: 0,
        payload: {
          mint,
          enrichment_status: status,
          primary_creator_wallet: primaryCreatorWallet,
          primary_creator_display_name: primaryCreatorDisplayName,
          primary_creator_provider: primaryCreatorProvider,
          creators_count: creatorsCount,
          fees_lamports: feesLamports,
          liquidity_live_at: c.liquidity_live_at ? c.liquidity_live_at.toISOString() : null,
          candidate_score: candidateSignal?.score,
        },
      });
      console.log(logPrefix, "emitted signal type=" + BAGS_ENRICHMENT_RESOLVED_SIGNAL + " mint=" + mint);
    }

    processedCount++;
    console.log(logPrefix, "done mint=" + mint + " status=" + status);
  }

  console.log(logPrefix, "finished");
  return { stopReason: null, processedCount, candidateCount: candidates.length };
}
