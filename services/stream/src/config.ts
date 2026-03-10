export const RAYDIUM_AMM_V4_PROGRAM_ID =
  "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
export const ORCA_WHIRLPOOL_PROGRAM_ID =
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const JUPITER_V6_PROGRAM_ID =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

const DEFAULT_TARGET_PROGRAMS = [
  RAYDIUM_AMM_V4_PROGRAM_ID, // Raydium AMM v4
  ORCA_WHIRLPOOL_PROGRAM_ID, // Orca Whirlpool
];

export const MAX_BATCH_SIZE = 50;
export const FETCH_INTERVAL_MS = 3_000;
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
  const programs = configured
    ? configured
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [...DEFAULT_TARGET_PROGRAMS];

  if (getStreamAllowJupiterProgram()) {
    return programs.length > 0 ? programs : [...DEFAULT_TARGET_PROGRAMS];
  }

  const filtered = programs.filter(
    (programId) => programId !== JUPITER_V6_PROGRAM_ID,
  );
  return filtered.length > 0 ? filtered : [...DEFAULT_TARGET_PROGRAMS];
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

export function getStreamHelius429Threshold(): number {
  return parseNumberEnv("STREAM_HELIUS_429_THRESHOLD", 3);
}

export function getStreamHelius429CooldownMs(): number {
  return parseNumberEnv("STREAM_HELIUS_429_COOLDOWN_MS", 900_000);
}

export function getStreamStableConnectionResetMs(): number {
  return STABLE_CONNECTION_RESET_MS;
}

export interface StreamStartupConfig {
  targetPrograms: string[];
  batchSize: number;
  batchSleepMs: number;
  replayMode: string;
  backfillEnabled: boolean;
  restartResumeState: string;
  heliusWsBaseUrl: string;
  heliusHttpUrl: string;
  dedupeCacheSize: number;
  maxQueueDepth: string;
  debugMetrics: boolean;
  metricsIntervalMs: number;
  metricsEveryNSignatures: number;
  staleEventWarnSeconds: number;
  allowJupiterProgram: boolean;
  helius429Threshold: number;
  helius429CooldownMs: number;
}

export function getStreamStartupConfig(apiKey: string): StreamStartupConfig {
  return {
    targetPrograms: getTargetPrograms(),
    batchSize: MAX_BATCH_SIZE,
    batchSleepMs: FETCH_INTERVAL_MS,
    replayMode: "live_logs_subscribe_only",
    backfillEnabled: false,
    restartResumeState: "in_memory_only",
    heliusWsBaseUrl: sanitizeHeliusUrl(getHeliusWsBaseUrl(), apiKey),
    heliusHttpUrl: sanitizeHeliusUrl(getHeliusHttpUrl(apiKey), apiKey),
    dedupeCacheSize: MAX_PROCESSED_SIGNATURE_CACHE_SIZE,
    maxQueueDepth: "unbounded_in_memory",
    debugMetrics: getStreamDebugMetrics(),
    metricsIntervalMs: getStreamMetricsIntervalMs(),
    metricsEveryNSignatures: getStreamMetricsEveryNSignatures(),
    staleEventWarnSeconds: getStreamStaleEventWarnSeconds(),
    allowJupiterProgram: getStreamAllowJupiterProgram(),
    helius429Threshold: getStreamHelius429Threshold(),
    helius429CooldownMs: getStreamHelius429CooldownMs(),
  };
}
