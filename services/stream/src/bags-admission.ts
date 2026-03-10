/**
 * Bags admission oracle.
 *
 * Maintains an in-memory set of token mints that are confirmed Bags-originated.
 * Populated from two sources:
 *   1. Bags Restream WebSocket (real-time, sub-second latency)
 *   2. Bags Pools REST API (polling, authoritative snapshot)
 *
 * The admission gate in stream.ts checks this set before inserting any event
 * into raw_events in bags_only or hybrid mode. Non-Bags mints are dropped with
 * a bags_admission_drop log so the narrowing is observable.
 */

import { getBagsApiBaseUrl, getBagsApiKey, getStreamBagsPoolsPollMs } from "./config";

// ── In-memory mint registries ──────────────────────────────────────────────

/** Mints confirmed as Bags-originated. Persists for the process lifetime. */
const knownBagsMints = new Set<string>();

/**
 * Negative cache: mints confirmed NOT to be Bags via on-demand API check.
 * Bounded to prevent unbounded growth under sustained non-Bags DBC activity.
 */
const nonBagsMints = new Set<string>();
const NON_BAGS_CACHE_MAX = 5_000;

/**
 * In-flight on-demand API checks keyed by mint. Deduplicates concurrent
 * lookups for the same unknown mint within a batch.
 */
const pendingChecks = new Map<string, Promise<boolean>>();

// ── Types ──────────────────────────────────────────────────────────────────

interface BagsPoolInfo {
  tokenMint: string;
  dbcConfigKey: string;
  dbcPoolKey: string;
  dammV2PoolKey: string | null;
}

interface BagsApiResponse<T> {
  success: boolean;
  response: T;
  error?: string;
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function bagsHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = getBagsApiKey();
  if (key) headers["x-api-key"] = key;
  return headers;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function isBagsMint(mint: string): boolean {
  return knownBagsMints.has(mint);
}

export function getBagsMintCount(): number {
  return knownBagsMints.size;
}

/**
 * Register a mint as Bags-originated directly (called by Bags Restream).
 * Returns true if this was a newly-registered mint.
 */
export function registerBagsMint(mint: string): boolean {
  const isNew = !knownBagsMints.has(mint);
  knownBagsMints.add(mint);
  // Remove from negative cache if it somehow ended up there
  nonBagsMints.delete(mint);
  return isNew;
}

/**
 * On-demand check via Bags REST API for a mint not in knownBagsMints.
 * Returns true if the API confirms it as a Bags pool, false otherwise.
 *
 * Results are cached (positive in knownBagsMints, negative in nonBagsMints).
 * Concurrent callers for the same mint share one in-flight promise.
 *
 * Conservatively returns false on network error (do not admit unknown mints).
 */
export async function checkBagsMintViaApi(mint: string): Promise<boolean> {
  if (knownBagsMints.has(mint)) return true;
  if (nonBagsMints.has(mint)) return false;

  // Deduplicate concurrent checks for the same mint
  const existing = pendingChecks.get(mint);
  if (existing) return existing;

  const promise = (async (): Promise<boolean> => {
    const url = `${getBagsApiBaseUrl()}/solana/bags/pools/token-mint?tokenMint=${encodeURIComponent(mint)}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(url, {
          headers: bagsHeaders(),
          signal: controller.signal,
        });
        if (!res.ok) {
          addToNegativeCache(mint);
          return false;
        }
        const data = (await res.json()) as BagsApiResponse<BagsPoolInfo>;
        if (data.success && data.response?.tokenMint === mint) {
          knownBagsMints.add(mint);
          nonBagsMints.delete(mint);
          return true;
        }
        addToNegativeCache(mint);
        return false;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Network error or abort: conservative, do not admit
      return false;
    } finally {
      pendingChecks.delete(mint);
    }
  })();

  pendingChecks.set(mint, promise);
  return promise;
}

/**
 * Fetch the full Bags pools snapshot and populate knownBagsMints.
 * Called once at startup and by the periodic poller.
 * Returns the number of newly-added mints in this call.
 */
export async function loadBagsPoolsSnapshot(): Promise<number> {
  const url = `${getBagsApiBaseUrl()}/solana/bags/pools`;
  const res = await fetch(url, { headers: bagsHeaders() });
  if (!res.ok) {
    throw new Error(`Bags pools API HTTP ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as BagsApiResponse<BagsPoolInfo[]>;
  if (!data.success || !Array.isArray(data.response)) {
    throw new Error(`Bags pools API unexpected response: success=${data.success}`);
  }

  const before = knownBagsMints.size;
  for (const pool of data.response) {
    if (pool.tokenMint) {
      knownBagsMints.add(pool.tokenMint);
      nonBagsMints.delete(pool.tokenMint);
    }
  }
  return knownBagsMints.size - before;
}

// ── Background poller ──────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function startBagsPoolsPoller(): void {
  const pollMs = getStreamBagsPoolsPollMs();

  const poll = async (): Promise<void> => {
    try {
      const before = knownBagsMints.size;
      await loadBagsPoolsSnapshot();
      const newCount = knownBagsMints.size - before;
      console.log(
        `[stream] bags_pools_poll_success total=${knownBagsMints.size} new=${newCount}`,
      );
    } catch (err) {
      console.error("[stream] bags_pools_poll_error:", err);
    }
    pollTimer = setTimeout(() => void poll(), pollMs);
  };

  pollTimer = setTimeout(() => void poll(), pollMs);
}

export function stopBagsPoolsPoller(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

function addToNegativeCache(mint: string): void {
  if (nonBagsMints.size >= NON_BAGS_CACHE_MAX) {
    // Evict oldest ~500 entries (Set preserves insertion order)
    const iter = nonBagsMints.values();
    for (let i = 0; i < 500; i++) {
      const next = iter.next();
      if (next.done) break;
      nonBagsMints.delete(next.value);
    }
  }
  nonBagsMints.add(mint);
}
