import crypto from "crypto";
import type { RawEvent } from "@pulse/common";
import { insertRawEvent } from "@pulse/db";
import {
  BASE_SOL_MINT,
  BASE_USDC_MINT,
  JUPITER_V6_PROGRAM_ID,
  FETCH_INTERVAL_MS,
  MAX_BATCH_SIZE,
  MAX_PROCESSED_SIGNATURE_CACHE_SIZE,
  getHeliusHttpUrl,
  getStreamAllowJupiterProgram,
  sanitizeHeliusUrl,
} from "./config";
import { StreamDiagnostics } from "./diagnostics";
import type { HeliusSignatureNotice, HeliusTransaction } from "./types";

const SWAP_TYPES = new Set([
  "SWAP",
  "DEX_SWAP",
  "JUPITER_SWAP",
  "RAYDIUM_SWAP",
  "ORCA_SWAP",
]);
const MINT_TYPES = new Set([
  "CREATE_MINT",
  "TOKEN_MINT",
  "MINT_TO",
  "INITIALIZE_MINT",
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
const FETCH_NOISE_INSTRUCTION_KEYWORDS = [
  "instruction: transfer",
  "instruction: transferchecked",
  "instruction: syncnative",
  "instruction: closeaccount",
  "instruction: close account",
  "instruction: memo",
];

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

function normalize(tx: HeliusTransaction): RawEvent | null {
  const eventType = classifyType(tx);
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
  if (event.eventType !== "SWAP") {
    return false;
  }

  const tokenMints = (tx.tokenTransfers ?? [])
    .map((transfer) => transfer.mint)
    .filter((mint): mint is string => Boolean(mint));

  return tokenMints.length > 0 && tokenMints.every((mint) => BASE_MINTS.has(mint));
}

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
    return {
      errorClass: error.name || "Error",
      httpStatus: null,
      message: error.message,
    };
  }

  return {
    errorClass: "unknown_error",
    httpStatus: null,
    message: String(error),
  };
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

async function processQueueLoop(): Promise<void> {
  if (isFetching || queue.length === 0) return;
  isFetching = true;

  while (queue.length > 0) {
    const batch = queue.splice(0, MAX_BATCH_SIZE);
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

    if (queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL_MS));
    }
  }

  isFetching = false;
}

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
    return {
      txCountReturned,
      missingTxCount,
      fetchDurationMs,
    };
  }

  for (const tx of txs) {
    const event = normalize(tx);
    if (!event) continue;
    if (shouldSkipInsert(event, tx)) continue;

    console.log(
      `[stream] ${event.eventType} | sig: ${event.signature.slice(0, 12)}... | mint: ${
        event.tokenMint ?? "n/a"
      } | wallet: ${event.walletAddress?.slice(0, 6) ?? "n/a"}...`,
    );

    const insertAttemptTimeMs = Date.now();
    diagnostics.recordEventBeforeInsert(event, insertAttemptTimeMs);

    try {
      await insertRawEvent(event);
    } catch (error) {
      console.error("[stream] DB insert failed:", error);
    }
  }

  return {
    txCountReturned,
    missingTxCount,
    fetchDurationMs,
  };
}
