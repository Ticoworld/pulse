import crypto from "crypto";
import type { RawEvent } from "@pulse/common";
import { insertRawEvent } from "@pulse/db";
import {
  BASE_SOL_MINT,
  BASE_USDC_MINT,
  JUPITER_V6_PROGRAM_ID,
  MAX_BATCH_SIZE,
  MAX_PROCESSED_SIGNATURE_CACHE_SIZE,
  getHeliusHttpUrl,
  getStreamAllowJupiterProgram,
  getStreamAllowMeteoraDammV2,
  getStreamBatchMinSleepMs,
  getStreamMaxQueueDepth,
  getStreamMaxQueuedAgeSeconds,
  getStreamMode,
  sanitizeHeliusUrl,
} from "./config";
import {
  isBagsMint,
  checkBagsMintViaApi,
  getBagsMintCount,
} from "./bags-admission";
import { StreamDiagnostics } from "./diagnostics";
import type { HeliusSignatureNotice, HeliusTransaction } from "./types";

// ── Type classifiers ───────────────────────────────────────────────────────

const SWAP_TYPES = new Set([
  "SWAP",
  "DEX_SWAP",
  "JUPITER_SWAP",
  "RAYDIUM_SWAP",
  "ORCA_SWAP",
  "METEORA_SWAP",
  // Liquidity events: initial DBC pool funding and post-graduation DAMM v2.
  // Treated as SWAP (LIQUIDITY_LIVE path) — they indicate active trading
  // infrastructure for a mint, not new mint creation.
  "ADD_LIQUIDITY",
  "REMOVE_LIQUIDITY",
]);

const MINT_TYPES = new Set([
  "CREATE_MINT",
  "TOKEN_MINT",
  "MINT_TO",
  "INITIALIZE_MINT",
  // Meteora DBC pool initialization: creates a new token + bonding curve in
  // one tx. Treated as TOKEN_MINT so the engine fires NEW_MINT_SEEN.
  "INITIALIZE_POOL",
  "CREATE_POOL",
]);

const TRANSFER_TYPES = new Set(["TRANSFER", "SYSTEM_TRANSFER"]);

const BASE_MINTS = new Set([BASE_SOL_MINT, BASE_USDC_MINT]);

const FETCH_KEEP_KEYWORDS = [
  "swap",
  "initialize",
  "mint",
  "create",
  "route",
  "liquidity",
];

// In bags_only mode with DAMM v2 disabled, we only need pool/mint creation
// events to fire NEW_MINT_SEEN. Swap/liquidity/route instructions produce
// LIQUIDITY_LIVE and ALPHA_BUY signals that require DAMM v2 to be meaningful.
// Dropping them before the HTTP fetch eliminates ~90% of Helius credit burn.
const BAGS_ONLY_CREATION_KEYWORDS = [
  "initialize",
  "mint",
  "create",
];

const FETCH_NOISE_INSTRUCTION_KEYWORDS = [
  "instruction: transfer",
  "instruction: transferchecked",
  "instruction: syncnative",
  "instruction: closeaccount",
  "instruction: close account",
  "instruction: memo",
];

// ── Normalisation helpers ──────────────────────────────────────────────────

function classifyType(
  tx: HeliusTransaction,
): "SWAP" | "TOKEN_MINT" | "TRANSFER" | null {
  if (!tx.type) return null;

  const upper = tx.type.toUpperCase();
  if (SWAP_TYPES.has(upper)) return "SWAP";
  if (MINT_TYPES.has(upper)) return "TOKEN_MINT";
  if (TRANSFER_TYPES.has(upper)) return "TRANSFER";
  return null;
}

function extractTokenInfo(tx: HeliusTransaction): {
  tokenMint?: string;
  amount?: number;
  walletAddress?: string;
} {
  const transfers = tx.tokenTransfers ?? [];
  const transfer =
    transfers.find(
      (candidate) =>
        candidate.mint != null && !BASE_MINTS.has(candidate.mint),
    ) ?? transfers[0];

  if (transfer) {
    return {
      tokenMint: transfer.mint,
      amount: transfer.tokenAmount,
      walletAddress: transfer.toUserAccount ?? transfer.fromUserAccount,
    };
  }

  const native = tx.nativeTransfers?.[0];
  if (native) {
    return {
      walletAddress: native.toUserAccount ?? native.fromUserAccount,
      amount: native.amount,
    };
  }

  return {};
}

// Fallback classifier for transactions where Helius returns no recognised type
// (e.g. Meteora DBC that the enhanced parser has not yet categorised). If the
// tx contains at least one non-base-mint token transfer it is treated as SWAP.
// Only fires when classifyType() returns null.
function classifyByTransferFallback(
  tx: HeliusTransaction,
): "SWAP" | null {
  const transfers = tx.tokenTransfers ?? [];
  const hasNonBaseMint = transfers.some(
    (t) => t.mint != null && !BASE_MINTS.has(t.mint),
  );
  return hasNonBaseMint ? "SWAP" : null;
}

function normalize(tx: HeliusTransaction): RawEvent | null {
  const knownEventType = classifyType(tx);
  const eventType = knownEventType ?? classifyByTransferFallback(tx);
  if (!eventType) return null;

  const { tokenMint, amount, walletAddress } = extractTokenInfo(tx);

  return {
    id: crypto
      .createHash("sha256")
      .update(tx.signature)
      .digest("hex")
      .slice(0, 36),
    source: "helius",
    eventType,
    signature: tx.signature,
    slot: tx.slot,
    walletAddress: walletAddress ?? tx.feePayer,
    tokenMint,
    amount,
    timestamp: (tx.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    rawPayload: tx,
  };
}

function shouldSkipInsert(event: RawEvent, tx: HeliusTransaction): boolean {
  if (event.eventType !== "SWAP") return false;

  const tokenMints = (tx.tokenTransfers ?? [])
    .map((transfer) => transfer.mint)
    .filter((mint): mint is string => Boolean(mint));

  return tokenMints.length > 0 && tokenMints.every((mint) => BASE_MINTS.has(mint));
}

// ── Bags admission ─────────────────────────────────────────────────────────

/**
 * Check whether a token mint is admitted under the current stream mode.
 *
 * bags_only: mint must be in knownBagsMints (from Restream or REST poll).
 *   If not in cache, performs an on-demand Bags Pools API call (≤5s timeout).
 *   Returns reason string for logging.
 *
 * hybrid: same as bags_only, but if mint is unknown AND STREAM_ALLOW_GENERAL_SOLANA
 *   is true, admit anyway (legacy path). No on-demand API call in hybrid.
 *
 * legacy: always admit.
 *
 * Returns { admitted: boolean; reason: string }.
 */
async function checkBagsAdmission(
  mint: string,
): Promise<{ admitted: boolean; reason: string }> {
  const mode = getStreamMode();

  if (mode === "legacy") {
    return { admitted: true, reason: "legacy_mode" };
  }

  if (!mint || BASE_MINTS.has(mint)) {
    // Base mint (SOL, USDC) or no mint. shouldSkipInsert handles the SOL-only
    // swap case. For missing mint, drop in bags_only; allow in hybrid.
    if (mode === "bags_only") {
      return { admitted: false, reason: "no_token_mint" };
    }
    return { admitted: true, reason: "no_token_mint_hybrid_allow" };
  }

  // Fast path: already in knownBagsMints
  if (isBagsMint(mint)) {
    return { admitted: true, reason: "bags_pool_known" };
  }

  // bags_only: try on-demand API check before dropping
  if (mode === "bags_only") {
    const found = await checkBagsMintViaApi(mint);
    if (found) {
      return { admitted: true, reason: "on_demand_verified" };
    }
    return { admitted: false, reason: "not_bags_origin" };
  }

  // hybrid: no on-demand check, rely on knownBagsMints + allow-general flag
  if (process.env.STREAM_ALLOW_GENERAL_SOLANA === "true") {
    return { admitted: true, reason: "general_solana_allowed" };
  }
  return { admitted: false, reason: "not_bags_origin" };
}

// ── Module state ───────────────────────────────────────────────────────────

class FetchBatchHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(message);
    this.name = "FetchBatchHttpError";
  }
}

interface FetchBatchResult {
  txCountReturned: number;
  missingTxCount: number;
  fetchDurationMs: number;
}

const processedSignatures = new Set<string>();
const queue: string[] = [];
const batchRetryCounts = new Map<string, number>();
const diagnostics = new StreamDiagnostics(() => [...queue]);

let isFetching = false;

diagnostics.start();

// ── Helpers ────────────────────────────────────────────────────────────────

function hashBatch(signatures: readonly string[]): string {
  return crypto
    .createHash("sha256")
    .update(signatures.join(","))
    .digest("hex");
}

function classifyFetchError(error: unknown): {
  errorClass: string;
  httpStatus: number | null;
  message: string;
} {
  if (error instanceof FetchBatchHttpError) {
    return {
      errorClass: `http_${error.status}`,
      httpStatus: error.status,
      message: error.message,
    };
  }
  if (error instanceof Error) {
    return { errorClass: error.name || "Error", httpStatus: null, message: error.message };
  }
  return { errorClass: "unknown_error", httpStatus: null, message: String(error) };
}

function rememberProcessedSignature(signature: string): void {
  if (processedSignatures.size > MAX_PROCESSED_SIGNATURE_CACHE_SIZE) {
    const iterator = processedSignatures.values();
    for (let index = 0; index < 1_000; index += 1) {
      const next = iterator.next();
      if (next.done) break;
      processedSignatures.delete(next.value);
    }
  }
  processedSignatures.add(signature);
}

function isNoiseInstructionLog(line: string): boolean {
  return FETCH_NOISE_INSTRUCTION_KEYWORDS.some((keyword) =>
    line.includes(keyword),
  );
}

function shouldDropBeforeFetch(notice: HeliusSignatureNotice): {
  drop: boolean;
  reason: string;
} {
  if (
    !getStreamAllowJupiterProgram() &&
    notice.programId === JUPITER_V6_PROGRAM_ID
  ) {
    return { drop: true, reason: "jupiter_program_disabled" };
  }

  const instructionLogs = notice.logs
    .map((line) => line.toLowerCase())
    .filter((line) => line.includes("instruction:"));

  if (instructionLogs.length === 0) {
    return { drop: false, reason: "no_instruction_logs" };
  }

  // bags_only mode with DAMM v2 disabled: only fetch pool/mint creation events.
  // Swap, liquidity, and route instructions cannot produce NEW_MINT_SEEN and
  // cannot produce LIQUIDITY_LIVE without DAMM v2. Dropping them before the
  // HTTP fetch cuts ~90% of Helius credit usage at the cost of no additional
  // signal loss beyond what disabling DAMM v2 already accepted.
  if (getStreamMode() === "bags_only" && !getStreamAllowMeteoraDammV2()) {
    const hasCreationKeyword = instructionLogs.some((line) =>
      BAGS_ONLY_CREATION_KEYWORDS.some((keyword) => line.includes(keyword)),
    );
    if (!hasCreationKeyword) {
      return { drop: true, reason: "bags_only_non_creation_tx" };
    }
    return { drop: false, reason: "bags_only_creation_tx" };
  }

  if (
    instructionLogs.some((line) =>
      FETCH_KEEP_KEYWORDS.some((keyword) => line.includes(keyword)),
    )
  ) {
    return { drop: false, reason: "signal_keyword_present" };
  }

  if (instructionLogs.every((line) => isNoiseInstructionLog(line))) {
    return { drop: true, reason: "transfer_only_logs" };
  }

  return { drop: false, reason: "unknown_keep" };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function processSignature(
  notice: HeliusSignatureNotice,
): Promise<void> {
  diagnostics.onSignatureReceived();

  if (processedSignatures.has(notice.signature)) {
    diagnostics.onDuplicateSignatureDropped();
    diagnostics.onSignatureDropped("duplicate_signature");
    diagnostics.onFetchSkipped(1);
    return;
  }

  const filterDecision = shouldDropBeforeFetch(notice);
  if (filterDecision.drop) {
    rememberProcessedSignature(notice.signature);
    diagnostics.onSignatureDropped(filterDecision.reason);
    diagnostics.onFetchSkipped(1);
    return;
  }

  // Bounded queue: shed new admissions when overloaded.
  const maxQueueDepth = getStreamMaxQueueDepth();
  if (queue.length >= maxQueueDepth) {
    diagnostics.onSignatureDropped("queue_full");
    diagnostics.onFetchSkipped(1);
    return;
  }

  rememberProcessedSignature(notice.signature);
  queue.push(notice.signature);
  diagnostics.onSignatureQueued(notice.signature);

  if (!isFetching) {
    void processQueueLoop();
  }
}

export function stopStreamProcessing(): void {
  diagnostics.stop();
}

// ── Drain loop ─────────────────────────────────────────────────────────────

async function processQueueLoop(): Promise<void> {
  if (isFetching || queue.length === 0) return;
  isFetching = true;

  const maxQueuedAgeMs = getStreamMaxQueuedAgeSeconds() * 1000;

  while (queue.length > 0) {
    const candidates = queue.splice(0, MAX_BATCH_SIZE);
    const batch: string[] = [];

    if (maxQueuedAgeMs > 0) {
      let ageDropCount = 0;
      for (const sig of candidates) {
        if (diagnostics.isSignatureStale(sig, maxQueuedAgeMs)) {
          diagnostics.onSignatureDropped("age_expired");
          diagnostics.onFetchSkipped(1);
          diagnostics.onBatchSettled([sig]);
          ageDropCount++;
        } else {
          batch.push(sig);
        }
      }
      if (ageDropCount > 0) {
        console.warn(
          `[stream] age_drop_purge count=${ageDropCount} max_queued_age_seconds=${getStreamMaxQueuedAgeSeconds()} remaining_queue=${queue.length}`,
        );
      }
    } else {
      batch.push(...candidates);
    }

    if (batch.length === 0) continue;

    const batchKey = hashBatch(batch);
    const retryCount = batchRetryCounts.get(batchKey) ?? 0;
    const batchStartLog = diagnostics.buildBatchStartLog(batch, retryCount);
    diagnostics.logFetchBatchStart(batchStartLog);

    try {
      const result = await fetchAndProcessBatch(batch);
      batchRetryCounts.delete(batchKey);
      diagnostics.onBatchSettled(batch);
      diagnostics.logFetchBatchDone({
        ...batchStartLog,
        queueDepthAfterFetch: queue.length,
        fetchDurationMs: result.fetchDurationMs,
        txCountReturned: result.txCountReturned,
        missingTxCount: result.missingTxCount,
      });
    } catch (error) {
      const errorInfo = classifyFetchError(error);
      diagnostics.logFetchBatchError({
        ...batchStartLog,
        fetchDurationMs: Date.now() - batchStartLog.batchStartTimeMs,
        errorClass: errorInfo.errorClass,
        httpStatus: errorInfo.httpStatus,
        errorMessage: errorInfo.message,
      });

      if (errorInfo.httpStatus === 429) {
        console.warn("[stream] Rate limited (429). Sleeping 5s then retrying...");
        batchRetryCounts.set(batchKey, retryCount + 1);
        queue.unshift(...batch);
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        continue;
      }

      batchRetryCounts.delete(batchKey);
      diagnostics.onBatchSettled(batch);
      console.error(
        `[stream] batch fetch failed (${batch.length} sigs): ${errorInfo.message}`,
      );
    }

    // Always sleep between batches regardless of queue depth.
    // The original isBehind bypass allowed rapid-fire fetches during DBC
    // activity spikes, exhausting Helius free-tier HTTP credits within minutes.
    // With STREAM_BATCH_MIN_SLEEP_MS controlling the rate, excess signatures
    // will age out via STREAM_MAX_QUEUED_AGE_SECONDS rather than burning credits.
    const minSleepMs = getStreamBatchMinSleepMs();
    if (minSleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, minSleepMs));
    }
  }

  isFetching = false;
}

// ── Batch HTTP fetch + Bags admission ─────────────────────────────────────

async function fetchAndProcessBatch(
  signatures: string[],
): Promise<FetchBatchResult> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set.");

  diagnostics.onFetchAttempt(signatures.length);

  const url = getHeliusHttpUrl(apiKey);
  const maskedUrl = sanitizeHeliusUrl(url, apiKey);

  console.log(
    `[stream] fetching batch of ${signatures.length} txs via ${maskedUrl.split("?")[0]}`,
  );

  const fetchStartedAt = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: signatures }),
  });

  if (!response.ok) {
    throw new FetchBatchHttpError(
      `HTTP ${response.status} ${response.statusText}`,
      response.status,
      response.statusText,
    );
  }

  const txs = (await response.json()) as HeliusTransaction[];
  const fetchDurationMs = Date.now() - fetchStartedAt;
  const txCountReturned = txs?.length ?? 0;
  const missingTxCount = Math.max(signatures.length - txCountReturned, 0);

  if (!txs || txs.length === 0) {
    return { txCountReturned, missingTxCount, fetchDurationMs };
  }

  // ── Step 1: Normalise all txs ──────────────────────────────────────────

  interface Candidate {
    event: RawEvent;
    tx: HeliusTransaction;
    usedFallback: boolean;
  }

  const candidates: Candidate[] = [];
  for (const tx of txs) {
    const event = normalize(tx);
    if (!event) continue;
    if (shouldSkipInsert(event, tx)) continue;
    candidates.push({ event, tx, usedFallback: !classifyType(tx) });
  }

  if (candidates.length === 0) {
    return { txCountReturned, missingTxCount, fetchDurationMs };
  }

  // ── Step 2: Bags admission gate (parallel across the batch) ───────────
  //
  // In bags_only mode: mints not in knownBagsMints trigger an on-demand
  // API check before being admitted. On-demand checks are deduped by
  // bags-admission.ts for concurrent callers.
  //
  // In legacy mode: all candidates pass through unchanged.

  const admissionResults = await Promise.allSettled(
    candidates.map(async (c) => {
      const mint = c.event.tokenMint;
      const mintForCheck = mint ?? "";
      const { admitted, reason } = await checkBagsAdmission(mintForCheck);

      if (admitted) {
        console.log(
          `[stream] bags_admission_accept reason=${reason} mint=${mint ?? "n/a"}`,
        );
        return c;
      } else {
        console.log(
          `[stream] bags_admission_drop reason=${reason} mint=${mint ?? "n/a"} bags_known_count=${getBagsMintCount()}`,
        );
        return null;
      }
    }),
  );

  const admitted: Candidate[] = admissionResults
    .filter(
      (r): r is PromiseFulfilledResult<Candidate | null> =>
        r.status === "fulfilled",
    )
    .map((r) => r.value)
    .filter((v): v is Candidate => v !== null);

  if (admitted.length === 0) {
    return { txCountReturned, missingTxCount, fetchDurationMs };
  }

  // ── Step 3: Insert admitted events in parallel ─────────────────────────

  const insertTasks: Promise<void>[] = [];

  for (const { event, tx, usedFallback } of admitted) {
    const heliusType = tx.type ?? "null";
    const heliusSource = tx.source ?? "n/a";

    if (usedFallback) {
      console.log(
        `[stream] type_fallback_admitted sig=${event.signature.slice(0, 12)}... helius_source=${heliusSource} helius_type=${heliusType} classified_as=${event.eventType} mint=${event.tokenMint ?? "n/a"}`,
      );
    }

    console.log(
      `[stream] ${event.eventType} | sig: ${event.signature.slice(0, 12)}... | mint: ${
        event.tokenMint ?? "n/a"
      } | wallet: ${event.walletAddress?.slice(0, 6) ?? "n/a"}... | hs=${heliusSource} | ht=${heliusType}`,
    );

    const insertAttemptTimeMs = Date.now();
    diagnostics.recordEventBeforeInsert(event, insertAttemptTimeMs);
    insertTasks.push(insertRawEvent(event));
  }

  const results = await Promise.allSettled(insertTasks);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[stream] DB insert failed:", result.reason);
    }
  }

  return { txCountReturned, missingTxCount, fetchDurationMs };
}
