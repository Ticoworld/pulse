// ── Program IDs ────────────────────────────────────────────────────────────

export const RAYDIUM_AMM_V4_PROGRAM_ID =
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const ORCA_WHIRLPOOL_PROGRAM_ID =
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const JUPITER_V6_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// Meteora DBC (Dynamic Bonding Curve): handles Bags token creation and bonding
// curve lifecycle. Source: https://docs.bags.fm/principles/program-ids
export const METEORA_DBC_PROGRAM_ID =
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";

// Meteora DAMM v2: post-graduation AMM after DBC bonding curve completes.
// Source: https://docs.bags.fm/principles/program-ids
export const METEORA_DAMM_V2_PROGRAM_ID =
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

// Legacy Solana programs (Raydium + Orca). Only used in hybrid/legacy mode.
const LEGACY_TARGET_PROGRAMS = [
  RAYDIUM_AMM_V4_PROGRAM_ID,
  ORCA_WHIRLPOOL_PROGRAM_ID,
];

// ── Stream constants ───────────────────────────────────────────────────────

export const MAX_BATCH_SIZE = 50;
export const MAX_PROCESSED_SIGNATURE_CACHE_SIZE = 10_000;

export const BASE_SOL_MINT = "So11111111111111111111111111111111111111112";
export const BASE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const STABLE_CONNECTION_RESET_MS = 60_000;

// ── Env helpers ────────────────────────────────────────────────────────────

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null) return fallback;

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Stream mode ────────────────────────────────────────────────────────────

export type StreamMode = "bags_only" | "hybrid" | "legacy";

/**
 * Controls how the stream filters admitted tokens.
 *
 *   bags_only (default): only Bags-originated mints enter the pipeline.
 *     - Helius subscriptions: Meteora DBC + DAMM v2 only.
 *     - Bags Restream + Pools REST poll are primary sources of truth.
 *     - Non-Bags mints are dropped with bags_admission_drop.
 *
 *   hybrid: Bags ingestion is primary, legacy Solana path can also run.
 *     - All Helius subscriptions active (Raydium, Orca, DBC, DAMM v2).
 *     - Bags mints are always admitted; other mints admitted only if
 *       STREAM_ALLOW_GENERAL_SOLANA=true.
 *
 *   legacy: original pre-Bags behavior, no admission filtering.
 *     - All configured Helius subscriptions active.
 *     - No Bags origin check. Use for rollback only.
 */
export function getStreamMode(): StreamMode {
  const raw = (process.env.STREAM_MODE ?? "bags_only").trim().toLowerCase();
  if (raw === "bags_only" || raw === "hybrid" || raw === "legacy") {
    return raw as StreamMode;
  }
  console.warn(`[stream] Unknown STREAM_MODE="${process.env.STREAM_MODE}", defaulting to bags_only`);
  return "bags_only";
}

// ── Target Helius programs ─────────────────────────────────────────────────

export function getTargetPrograms(): string[] {
  const mode = getStreamMode();

  // bags_only: only Meteora programs (all Bags activity flows through these)
  if (mode === "bags_only") {
    const explicit = process.env.STREAM_TARGET_PROGRAMS;
    if (explicit) {
      return explicit.split(",").map((v) => v.trim()).filter(Boolean);
    }
    const programs: string[] = [];
    if (getStreamAllowMeteoraDbc()) programs.push(METEORA_DBC_PROGRAM_ID);
    if (getStreamAllowMeteoraDammV2()) programs.push(METEORA_DAMM_V2_PROGRAM_ID);
    // Always have at least DBC
    return programs.length > 0 ? programs : [METEORA_DBC_PROGRAM_ID];
  }

  // hybrid / legacy: broader subscription set
  const explicit = process.env.STREAM_TARGET_PROGRAMS;
  let programs: string[] = explicit
    ? explicit.split(",").map((v) => v.trim()).filter(Boolean)
    : [...LEGACY_TARGET_PROGRAMS, METEORA_DBC_PROGRAM_ID];

  if (!getStreamAllowJupiterProgram()) {
    programs = programs.filter((id) => id !== JUPITER_V6_PROGRAM_ID);
  }
  if (!getStreamAllowMeteoraDbc()) {
    programs = programs.filter((id) => id !== METEORA_DBC_PROGRAM_ID);
  }
  if (getStreamAllowMeteoraDammV2() && !programs.includes(METEORA_DAMM_V2_PROGRAM_ID)) {
    programs.push(METEORA_DAMM_V2_PROGRAM_ID);
  }
  if (!getStreamAllowGeneralSolana()) {
    programs = programs.filter(
      (id) => id !== RAYDIUM_AMM_V4_PROGRAM_ID && id !== ORCA_WHIRLPOOL_PROGRAM_ID,
    );
  }

  return programs.length > 0 ? programs : [METEORA_DBC_PROGRAM_ID];
}

// ── Helius network / URL ───────────────────────────────────────────────────

export function getHeliusNetwork(): "mainnet" | "devnet" {
  const network = process.env.HELIUS_NETWORK || "mainnet";
  if (network !== "mainnet" && network !== "devnet") {
    throw new Error(
      `Invalid HELIUS_NETWORK: ${network}. Must be mainnet or devnet.`,
    );
  }
  return network;
}

export function getHeliusWsBaseUrl(): string {
  const explicitWs = process.env.HELIUS_WS_URL;
  const baseUrl = explicitWs
    ? explicitWs
    : `wss://${getHeliusNetwork()}.helius-rpc.com`;
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function getHeliusHttpUrl(apiKey: string): string {
  const explicitHttp = process.env.HELIUS_RPC_HTTP_URL;
  if (explicitHttp) return explicitHttp;

  const domain =
    getHeliusNetwork() === "devnet"
      ? "api-devnet.helius.xyz"
      : "api.helius.xyz";

  return `https://${domain}/v0/transactions/?api-key=${apiKey}`;
}

export function sanitizeHeliusUrl(url: string, apiKey: string): string {
  return url.replace(apiKey, `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`);
}

// ── Bags Restream ──────────────────────────────────────────────────────────

/** Enable the Bags Restream WebSocket connection (default: true). */
export function getStreamAllowBagsRestream(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_BAGS_RESTREAM", true);
}

/** Bags Restream WebSocket URL. */
export function getBagsRestreamUrl(): string {
  return process.env.BAGS_RESTREAM_URL ?? "wss://restream.bags.fm";
}

// ── Bags Pools REST polling ────────────────────────────────────────────────

/** Enable periodic Bags Pools REST snapshot polling (default: true). */
export function getStreamAllowBagsPoolsPoll(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_BAGS_POOLS_POLL", true);
}

/** Polling interval for Bags Pools REST API in ms (default: 30 000). */
export function getStreamBagsPoolsPollMs(): number {
  return parseNumberEnv("STREAM_BAGS_POOLS_POLL_MS", 30_000);
}

// ── Bags REST API ──────────────────────────────────────────────────────────

/** Base URL for the Bags Public API v2 (no trailing slash). */
export function getBagsApiBaseUrl(): string {
  const url = process.env.BAGS_API_BASE_URL ?? "https://public-api-v2.bags.fm/api/v1";
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Optional Bags API key (x-api-key header). */
export function getBagsApiKey(): string | undefined {
  return process.env.BAGS_API_KEY || undefined;
}

// ── Per-program allow flags ────────────────────────────────────────────────

/** Allow Jupiter program subscription (default: false). */
export function getStreamAllowJupiterProgram(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_JUPITER_PROGRAM", false);
}

/**
 * Allow Meteora DBC subscription (default: true).
 * This is the primary source for Bags launches; disabling it breaks bags_only mode.
 */
export function getStreamAllowMeteoraDbc(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_METEORA_DBC", true);
}

/**
 * Allow Meteora DAMM v2 subscription.
 * Default: true in bags_only mode (post-graduation Bags AMM trading),
 *          false in legacy/hybrid (general-purpose AMM, higher volume).
 */
export function getStreamAllowMeteoraDammV2(): boolean {
  const mode = getStreamMode();
  const defaultVal = mode === "bags_only";
  return parseBooleanEnv("STREAM_ALLOW_METEORA_DAMM_V2", defaultVal);
}

/**
 * Allow general Solana programs (Raydium, Orca) in the subscription.
 * Default: false. Only relevant in hybrid/legacy mode.
 * In bags_only mode this is ignored (general programs are never subscribed).
 */
export function getStreamAllowGeneralSolana(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_GENERAL_SOLANA", false);
}

// ── Helius 429 circuit breaker ─────────────────────────────────────────────

export function getStreamHelius429Threshold(): number {
  return parseNumberEnv("STREAM_HELIUS_429_THRESHOLD", 3);
}

export function getStreamHelius429CooldownMs(): number {
  return parseNumberEnv("STREAM_HELIUS_429_COOLDOWN_MS", 900_000);
}

export function getStreamStableConnectionResetMs(): number {
  return STABLE_CONNECTION_RESET_MS;
}

// ── Queue / throughput ─────────────────────────────────────────────────────

export function getStreamMaxQueueDepth(): number {
  return parseNumberEnv("STREAM_MAX_QUEUE_DEPTH", 500);
}

export function getStreamMaxQueuedAgeSeconds(): number {
  return parseNumberEnv("STREAM_MAX_QUEUED_AGE_SECONDS", 30);
}

export function getStreamBatchMinSleepMs(): number {
  return parseNumberEnv("STREAM_BATCH_MIN_SLEEP_MS", 100);
}

// ── Diagnostics ────────────────────────────────────────────────────────────

export function getStreamDebugMetrics(): boolean {
  return parseBooleanEnv("STREAM_DEBUG_METRICS", false);
}

export function getStreamMetricsIntervalMs(): number {
  return parseNumberEnv("STREAM_METRICS_INTERVAL_MS", 60_000);
}

export function getStreamMetricsEveryNSignatures(): number {
  return parseNumberEnv("STREAM_METRICS_EVERY_N_SIGNATURES", 500);
}

export function getStreamStaleEventWarnSeconds(): number {
  return parseNumberEnv("STREAM_STALE_EVENT_WARN_SECONDS", 120);
}

// ── Startup config snapshot ────────────────────────────────────────────────

export interface StreamStartupConfig {
  streamMode: StreamMode;
  targetPrograms: string[];
  batchSize: number;
  batchMinSleepMs: number;
  maxQueueDepth: number;
  maxQueuedAgeSeconds: number;
  replayMode: string;
  backfillEnabled: boolean;
  restartResumeState: string;
  heliusWsBaseUrl: string;
  heliusHttpUrl: string;
  dedupeCacheSize: number;
  debugMetrics: boolean;
  metricsIntervalMs: number;
  metricsEveryNSignatures: number;
  staleEventWarnSeconds: number;
  allowJupiterProgram: boolean;
  allowMeteoraDbc: boolean;
  allowMeteoraDammV2: boolean;
  allowGeneralSolana: boolean;
  allowBagsRestream: boolean;
  allowBagsPoolsPoll: boolean;
  bagsPoolsPollMs: number;
  bagsRestreamUrl: string;
  bagsApiBaseUrl: string;
  helius429Threshold: number;
  helius429CooldownMs: number;
}

export function getStreamStartupConfig(apiKey: string): StreamStartupConfig {
  return {
    streamMode: getStreamMode(),
    targetPrograms: getTargetPrograms(),
    batchSize: MAX_BATCH_SIZE,
    batchMinSleepMs: getStreamBatchMinSleepMs(),
    maxQueueDepth: getStreamMaxQueueDepth(),
    maxQueuedAgeSeconds: getStreamMaxQueuedAgeSeconds(),
    replayMode: "live_logs_subscribe_only",
    backfillEnabled: false,
    restartResumeState: "in_memory_only",
    heliusWsBaseUrl: sanitizeHeliusUrl(getHeliusWsBaseUrl(), apiKey),
    heliusHttpUrl: sanitizeHeliusUrl(getHeliusHttpUrl(apiKey), apiKey),
    dedupeCacheSize: MAX_PROCESSED_SIGNATURE_CACHE_SIZE,
    debugMetrics: getStreamDebugMetrics(),
    metricsIntervalMs: getStreamMetricsIntervalMs(),
    metricsEveryNSignatures: getStreamMetricsEveryNSignatures(),
    staleEventWarnSeconds: getStreamStaleEventWarnSeconds(),
    allowJupiterProgram: getStreamAllowJupiterProgram(),
    allowMeteoraDbc: getStreamAllowMeteoraDbc(),
    allowMeteoraDammV2: getStreamAllowMeteoraDammV2(),
    allowGeneralSolana: getStreamAllowGeneralSolana(),
    allowBagsRestream: getStreamAllowBagsRestream(),
    allowBagsPoolsPoll: getStreamAllowBagsPoolsPoll(),
    bagsPoolsPollMs: getStreamBagsPoolsPollMs(),
    bagsRestreamUrl: getBagsRestreamUrl(),
    bagsApiBaseUrl: getBagsApiBaseUrl(),
    helius429Threshold: getStreamHelius429Threshold(),
    helius429CooldownMs: getStreamHelius429CooldownMs(),
  };
}
