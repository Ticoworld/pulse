/**
 * Read-only Bags API client using official @bagsfm/bags-sdk.
 * Single module for the monorepo; validates env at init; enforces in-process rate budget.
 * Source: Bags docs — TypeScript & Node setup, Get Token Creators, Get Token Lifetime Fees.
 *
 * Env loading: Do NOT import dotenv in this package. Callers (apps/scripts) must load env
 * before constructing BagsClient. BAGS_RATE_LIMIT is only for real API 429; local guard
 * refusal returns BAGS_LOCAL_SOFT_CAP (no HTTP status).
 */

import { BagsSDK } from "@bagsfm/bags-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import type {
  BagsTokenCreatorsResult,
  BagsTokenLifetimeFeesResult,
  BagsClientError,
  BagsTokenCreator,
} from "./types";
import { BagsRateGuard } from "./rateGuard";

const LAMPORTS_PER_SOL = 1e9;

function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Bags client: ${name} is required`);
  }
  return v.trim();
}

/**
 * Classify thrown error into BagsClientError when possible.
 * SDK may throw with response status or message; docs confirm 401, 403, 429 semantics.
 */
function toBagsError(e: unknown): BagsClientError {
  if (e && typeof e === "object" && "status" in e && typeof (e as { status: number }).status === "number") {
    const status = (e as { status: number }).status;
    const message = (e as { message?: string }).message ?? String(e);
    if (status === 401) return { code: "BAGS_AUTH", status: 401, message };
    if (status === 403) return { code: "BAGS_FORBIDDEN", status: 403, message };
    if (status === 429) {
      const body = e as { limit?: number; remaining?: number; resetTime?: string };
      return {
        code: "BAGS_RATE_LIMIT",
        status: 429,
        message,
        limit: body.limit,
        remaining: body.remaining,
        resetTime: body.resetTime,
      };
    }
    return { code: "BAGS_ERROR", status, message };
  }
  const message = e instanceof Error ? e.message : String(e);
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid api key")) {
    return { code: "BAGS_AUTH", status: 401, message };
  }
  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission")) {
    return { code: "BAGS_FORBIDDEN", status: 403, message };
  }
  if (lower.includes("429") || lower.includes("rate limit") || lower.includes("too many")) {
    return { code: "BAGS_RATE_LIMIT", status: 429, message };
  }
  return { code: "BAGS_ERROR", message };
}

/** SDK creator shape from docs (Get Token Creators). We normalize to BagsTokenCreator. */
interface SdkCreator {
  wallet: string;
  isCreator?: boolean;
  providerUsername?: string | null;
  username?: string | null;
  pfp?: string | null;
  royaltyBps?: number;
  provider?: string | null;
}

function normalizeCreator(c: SdkCreator): BagsTokenCreator {
  return {
    wallet: c.wallet,
    isCreator: !!c.isCreator,
    displayName: c.providerUsername ?? c.username ?? null,
    provider: c.provider ?? null,
    pfp: c.pfp ?? null,
    royaltyBps: typeof c.royaltyBps === "number" ? c.royaltyBps : 0,
  };
}

export interface BagsClientConfig {
  /** Soft cap per hour (default 800). In-process only. */
  softCapPerHour?: number;
}

let defaultClient: BagsClient | null = null;

export class BagsClient {
  private readonly sdk: BagsSDK;
  private readonly guard: BagsRateGuard;

  constructor(config: BagsClientConfig = {}) {
    const apiKey = getRequiredEnv("BAGS_API_KEY");
    const rpcUrl = getRequiredEnv("SOLANA_RPC_URL");
    const connection = new Connection(rpcUrl);
    this.sdk = new BagsSDK(apiKey, connection, "processed");
    this.guard = new BagsRateGuard({ softCapPerHour: config.softCapPerHour ?? 800 });
  }

  /**
   * Get token creators/deployers. Docs: sdk.state.getTokenCreators(PublicKey).
   */
  async getTokenCreators(mint: string): Promise<BagsTokenCreatorsResult | BagsClientError> {
    const method = "getTokenCreators";
    if (!this.guard.allow(method)) {
      return {
        code: "BAGS_LOCAL_SOFT_CAP",
        message: "Local in-process soft cap reached; Bags API was not called. This is not a Bags 429.",
      };
    }
    try {
      const raw = await this.sdk.state.getTokenCreators(new PublicKey(mint));
      const creators: BagsTokenCreator[] = Array.isArray(raw)
        ? (raw as SdkCreator[]).map(normalizeCreator)
        : [];
      const primaryCreator = creators.find((c) => c.isCreator) ?? null;
      this.guard.recordSuccess(method);
      return { ok: true, creators, primaryCreator };
    } catch (e) {
      return toBagsError(e);
    }
  }

  /**
   * Get token lifetime fees in lamports. Docs: sdk.state.getTokenLifetimeFees(PublicKey).
   */
  async getTokenLifetimeFees(mint: string): Promise<BagsTokenLifetimeFeesResult | BagsClientError> {
    const method = "getTokenLifetimeFees";
    if (!this.guard.allow(method)) {
      return {
        code: "BAGS_LOCAL_SOFT_CAP",
        message: "Local in-process soft cap reached; Bags API was not called. This is not a Bags 429.",
      };
    }
    try {
      const feesLamports = await this.sdk.state.getTokenLifetimeFees(new PublicKey(mint));
      const num = typeof feesLamports === "number" ? feesLamports : 0;
      this.guard.recordSuccess(method);
      return {
        ok: true,
        feesLamports: num,
        feesSol: num / LAMPORTS_PER_SOL,
      };
    } catch (e) {
      return toBagsError(e);
    }
  }

  getUsage(): { count: number; softCap: number; windowMs: number } {
    return this.guard.getUsage();
  }
}

/**
 * Get the default client (validates env on first use).
 * Use this or construct BagsClient() where you need config.
 */
export function getBagsClient(config?: BagsClientConfig): BagsClient {
  if (!defaultClient) {
    defaultClient = new BagsClient(config);
  }
  return defaultClient;
}
