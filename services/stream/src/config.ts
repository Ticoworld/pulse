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
// Higher volume than DBC; opt-in via STREAM_ALLOW_METEORA_DAMM_V2=true.
// Source: https://docs.bags.fm/principles/program-ids
export const METEORA_DAMM_V2_PROGRAM_ID =
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";

const DEFAULT_TARGET_PROGRAMS = [
  RAYDIUM_AMM_V4_PROGRAM_ID, // Raydium AMM v4
  ORCA_WHIRLPOOL_PROGRAM_ID, // Orca Whirlpool
  METEORA_DBC_PROGRAM_ID,    // Meteora DBC — Bags token launches and bonding curve trades
];

export const MAX_BATCH_SIZE = 50;
export const MAX_PROCESSED_SIGNATURE_CACHE_SIZE = 10_000;

export const BASE_SOL_MINT = "So11111111111111111111111111111111111111112";
export const BASE_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const STABLE_CONNECTION_RESET_MS = 60_000;

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

export function getHeliusNetwork(): "mainnet" | "devnet" {
  const network = process.env.HELIUS_NETWORK || "mainnet";
  if (network !== "mainnet" && network !== "devnet") {
    throw new Error(
      `Invalid HELIUS_NETWORK: ${network}. Must be mainnet or devnet.`,
    );
  }
  return network;
}

export function getTargetPrograms(): string[] {
  const configured = process.env.STREAM_TARGET_PROGRAMS;
  let programs: string[] = configured
    ? configured
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [...DEFAULT_TARGET_PROGRAMS];

  if (!getStreamAllowJupiterProgram()) {
    programs = programs.filter((id) => id !== JUPITER_V6_PROGRAM_ID);
  }

  if (!getStreamAllowMeteoraDbc()) {
    programs = programs.filter((id) => id !== METEORA_DBC_PROGRAM_ID);
  }

  // DAMM v2 is off by default (higher volume, post-graduation tokens).
  // Enable with STREAM_ALLOW_METEORA_DAMM_V2=true.
  if (
    getStreamAllowMeteoraDammV2() &&
    !programs.includes(METEORA_DAMM_V2_PROGRAM_ID)
  ) {
    programs.push(METEORA_DAMM_V2_PROGRAM_ID);
  }

  return programs.length > 0 ? programs : [...DEFAULT_TARGET_PROGRAMS];
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
  if (explicitHttp) {
    return explicitHttp;
  }

  const domain =
    getHeliusNetwork() === "devnet"
      ? "api-devnet.helius.xyz"
      : "api.helius.xyz";

  return `https://${domain}/v0/transactions/?api-key=${apiKey}`;
}

export function sanitizeHeliusUrl(url: string, apiKey: string): string {
  return url.replace(apiKey, `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`);
}

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

export function getStreamAllowJupiterProgram(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_JUPITER_PROGRAM", false);
}

// Meteora DBC is enabled by default because it is the primary program for
// Bags token launches. Disable with STREAM_ALLOW_METEORA_DBC=false if the
// DBC subscription causes unexpected volume or 429s.
export function getStreamAllowMeteoraDbc(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_METEORA_DBC", true);
}

// Meteora DAMM v2 handles post-graduation AMM trading. It is disabled by
// default because it is a general-purpose DEX (not Bags-exclusive) and will
// add significant volume. Enable with STREAM_ALLOW_METEORA_DAMM_V2=true once
// DBC coverage is confirmed healthy and throughput headroom is verified.
export function getStreamAllowMeteoraDammV2(): boolean {
  return parseBooleanEnv("STREAM_ALLOW_METEORA_DAMM_V2", false);
}

export function getStreamHelius429Threshold(): number {
  return parseNumberEnv("STREAM_HELIUS_429_THRESHOLD", 3);
}

export function getStreamHelius429CooldownMs(): number {
  return parseNumberEnv("STREAM_HELIUS_429_COOLDOWN_MS", 900_000);
}

export function getStreamStableConnectionResetMs(): number {
  return STABLE_CONNECTION_RESET_MS;
}

// Maximum number of signatures held in the in-memory queue at once.
// When the queue reaches this depth, new admissions are dropped with reason
// "queue_full". This bounds memory and forces explicit shedding under load
// rather than silently accumulating unbounded stale work.
export function getStreamMaxQueueDepth(): number {
  return parseNumberEnv("STREAM_MAX_QUEUE_DEPTH", 500);
}

// Signatures that have been waiting in the queue longer than this many seconds
// are dropped without an HTTP fetch. At 70s queue age the events are already
// too stale for the engine and tg-bot to act on; spending Helius credits on
// them only keeps the queue deep. Default is 30s: short enough to purge a
// runaway backlog quickly, long enough to survive brief Helius HTTP spikes.
export function getStreamMaxQueuedAgeSeconds(): number {
  return parseNumberEnv("STREAM_MAX_QUEUED_AGE_SECONDS", 30);
}

// Minimum sleep between successive HTTP fetch batches when the queue is at or
// below MAX_BATCH_SIZE (i.e. "caught up"). Set to 0 to disable entirely.
// When the queue is deeper than MAX_BATCH_SIZE the drain loop skips this sleep
// and processes the next batch immediately. Replaces the old fixed 3000 ms
// inter-batch sleep which was the primary self-inflicted throughput bottleneck.
export function getStreamBatchMinSleepMs(): number {
  return parseNumberEnv("STREAM_BATCH_MIN_SLEEP_MS", 100);
}

export interface StreamStartupConfig {
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
  helius429Threshold: number;
  helius429CooldownMs: number;
}

export function getStreamStartupConfig(apiKey: string): StreamStartupConfig {
  return {
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
    helius429Threshold: getStreamHelius429Threshold(),
    helius429CooldownMs: getStreamHelius429CooldownMs(),
  };
}
