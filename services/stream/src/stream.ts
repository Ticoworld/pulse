import crypto from "crypto";
import type { RawEvent } from "@pulse/common";
import type { HeliusTransaction } from "./types";
import { insertRawEvent } from "@pulse/db";

/** Helius transaction type strings we care about in Phase 1 */
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
  const transfer = tx.tokenTransfers?.[0];
  if (transfer) {
    return {
      tokenMint: transfer.mint,
      amount: transfer.tokenAmount,
      walletAddress: transfer.toUserAccount ?? transfer.fromUserAccount,
    };
  }
  const native = tx.nativeTransfers?.[0];
  if (native) {
    // For a TRANSFER, we want to know who RECEIVED it if we are looking for funder.
    // However, if we store the receiver as walletAddress, we can query "who sent to this wallet?".
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

// ─── Concurrency, deduplication, and rate limiting ───────────────────────────

const processedSignatures = new Set<string>();
const MAX_CACHE_SIZE = 10_000;

const queue: string[] = [];
let isFetching = false;

// Helius Free Tier allows ~10-30 HTTP req/sec, but it's safer to batch.
// The v0/transactions endpoint accepts up to 100 signatures per call.
const MAX_BATCH_SIZE = 50;
const FETCH_INTERVAL_MS = 3000; // Force a 3s sleep between batches to avoid 429s

/**
 * Entry point from the WebSocket provider.
 */
export async function processSignature(signature: string): Promise<void> {
  if (processedSignatures.has(signature)) return;

  if (processedSignatures.size > MAX_CACHE_SIZE) {
    // Avoid memory leaks. Delete first 1000 items.
    const iterator = processedSignatures.values();
    for (let i = 0; i < 1000; i++) {
      processedSignatures.delete(iterator.next().value!);
    }
  }

  processedSignatures.add(signature);
  queue.push(signature);

  if (!isFetching) {
    processQueueLoop();
  }
}

async function processQueueLoop() {
  if (isFetching || queue.length === 0) return;
  isFetching = true;

  while (queue.length > 0) {
    // Take up to MAX_BATCH_SIZE signatures from the queue
    const batch = queue.splice(0, MAX_BATCH_SIZE);

    try {
      await fetchAndProcessBatch(batch);
    } catch (err: any) {
      console.error(
        `[stream] batch fetch failed (${batch.length} sigs):`,
        err.message,
      );

      // If we hit a rate limit, put the batch back at the front of the queue and sleep longer
      if (err.message.includes("429")) {
        console.warn(
          `[stream] Rate limited (429). Sleeping 5s then retrying...`,
        );
        queue.unshift(...batch);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue; // Skip the standard interval sleep below and loop around
      }
    }

    // Force sleep to respect rate limits before taking the next batch
    if (queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_INTERVAL_MS));
    }
  }

  isFetching = false;
}

async function fetchAndProcessBatch(signatures: string[]) {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set.");

  const network = process.env.HELIUS_NETWORK || "mainnet";
  const explicitHttp = process.env.HELIUS_RPC_HTTP_URL;

  const restDomain =
    network === "devnet" ? "api-devnet.helius.xyz" : "api.helius.xyz";

  let url = `https://${restDomain}/v0/transactions/?api-key=${apiKey}`;

  if (explicitHttp) {
    url = explicitHttp;
  }

  const maskedUrl = url.replace(
    apiKey,
    `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`,
  );

  console.log(
    `[stream] fetching batch of ${signatures.length} txs via ${maskedUrl.split("?")[0]}`,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: signatures }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const txs: HeliusTransaction[] = await response.json();
  if (!txs || txs.length === 0) return;

  for (const tx of txs) {
    const event = normalize(tx);
    if (!event) continue; // skip irrelevant tx types

    console.log(
      `[stream] ${event.eventType} | sig: ${event.signature.slice(0, 12)}… | mint: ${
        event.tokenMint ?? "n/a"
      } | wallet: ${event.walletAddress?.slice(0, 6) ?? "n/a"}…`,
    );

    try {
      await insertRawEvent(event);
    } catch (err) {
      console.error("[stream] DB insert failed:", err);
    }
  }
}
