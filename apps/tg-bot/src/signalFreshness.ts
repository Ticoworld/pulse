const NORMAL_MAX_AGE_SECONDS = 60;
const WARNING_MAX_AGE_SECONDS = 120;

export type FreshnessDecision =
  | "send"
  | "send_with_warning"
  | "skip_stale"
  | "unproven";

export interface FreshnessSignalLike {
  type: string;
  token_mint: string | null;
  signature: string;
  payload: Record<string, unknown>;
  chain_time?: Date | string | null;
}

export interface SignalFreshnessResult {
  decision: FreshnessDecision;
  chainTime: Date | null;
  currentTime: Date;
  ageSeconds: number | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isFreshnessProtectedSignalType(type: string): boolean {
  return type === "NEW_MINT_SEEN" || type === "LIQUIDITY_LIVE";
}

export function evaluateSignalFreshness(
  signal: FreshnessSignalLike,
  currentTime = new Date(),
): SignalFreshnessResult {
  if (!isFreshnessProtectedSignalType(signal.type)) {
    return {
      decision: "send",
      chainTime: null,
      currentTime,
      ageSeconds: null,
    };
  }

  const trace = asRecord(asRecord(signal.payload).trace);
  const chainTime =
    parseDate(signal.chain_time) ?? parseDate(trace.chain_time as Date | string | null | undefined);

  if (!chainTime) {
    return {
      decision: "unproven",
      chainTime: null,
      currentTime,
      ageSeconds: null,
    };
  }

  const ageSeconds = Number(
    ((currentTime.getTime() - chainTime.getTime()) / 1000).toFixed(3),
  );

  if (ageSeconds <= NORMAL_MAX_AGE_SECONDS) {
    return { decision: "send", chainTime, currentTime, ageSeconds };
  }

  if (ageSeconds <= WARNING_MAX_AGE_SECONDS) {
    return {
      decision: "send_with_warning",
      chainTime,
      currentTime,
      ageSeconds,
    };
  }

  return {
    decision: "skip_stale",
    chainTime,
    currentTime,
    ageSeconds,
  };
}
