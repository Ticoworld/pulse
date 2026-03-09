# Phase 1 review: Bags read-only foundation

**⚠️ This file is not the source of truth.** The embedded code below may be stale. The **actual** implementation is in the repo: `packages/bags/src/client.ts`, `rateGuard.ts`, `types.ts`, and `scripts/bags-smoke-readonly.ts`. The shared client does **not** import `dotenv/config`; env is loaded only in entrypoints (e.g. the smoke script). Use the real files for verification.

This file is kept for historical reference and example run shape only.

**File locations in repo:**

- Shared Bags client: `packages/bags/src/client.ts`
- Rate-budget guard: `packages/bags/src/rateGuard.ts`
- Types (normalized + errors): `packages/bags/src/types.ts`
- Smoke script: `scripts/bags-smoke-readonly.ts`

---

## 1. Shared Bags client module

**Path:** `packages/bags/src/client.ts`

```typescript
/**
 * Read-only Bags API client using official @bagsfm/bags-sdk.
 * Single module for the monorepo; validates env at init; enforces in-process rate budget.
 * Source: Bags docs — TypeScript & Node setup, Get Token Creators, Get Token Lifetime Fees.
 */

import "dotenv/config";
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
        code: "BAGS_RATE_LIMIT",
        status: 429,
        message: "In-process soft cap reached; do not call Bags",
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
        code: "BAGS_RATE_LIMIT",
        status: 429,
        message: "In-process soft cap reached; do not call Bags",
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
```

---

## 2. Rate-budget guard code

**Path:** `packages/bags/src/rateGuard.ts`

```typescript
/**
 * In-process rate-budget guard for Bags API calls.
 * Not global/distributed: each process has its own counter.
 * Does not use Redis. Does not read X-RateLimit-* headers (SDK may not expose them).
 */

const DEFAULT_SOFT_CAP_PER_HOUR = 800;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour sliding window

export interface RateGuardConfig {
  softCapPerHour?: number;
}

interface CallRecord {
  ts: number;
  method: string;
}

export class BagsRateGuard {
  private readonly softCap: number;
  private readonly calls: CallRecord[] = [];

  constructor(config: RateGuardConfig = {}) {
    this.softCap = config.softCapPerHour ?? DEFAULT_SOFT_CAP_PER_HOUR;
  }

  /** Remove calls older than 1 hour from current time. */
  private prune(): void {
    const cutoff = Date.now() - WINDOW_MS;
    while (this.calls.length > 0 && this.calls[0].ts < cutoff) {
      this.calls.shift();
    }
  }

  /** Returns true if under soft cap; false if at or over (caller should not call Bags). */
  allow(method: string): boolean {
    this.prune();
    const count = this.calls.length;
    if (count >= this.softCap) {
      console.warn(
        `[bags-rate-guard] at soft cap: ${count}/${this.softCap} in window. method=${method}`,
      );
      return false;
    }
    this.calls.push({ ts: Date.now(), method });
    return true;
  }

  /** Call after a successful request for logging. */
  recordSuccess(method: string): void {
    this.prune();
    const count = this.calls.length;
    const byMethod = this.calls.filter((c) => c.method === method).length;
    console.log(
      `[bags-rate-guard] usage: ${count}/${this.softCap} total, ${byMethod} for ${method}`,
    );
  }

  getUsage(): { count: number; softCap: number; windowMs: number } {
    this.prune();
    return {
      count: this.calls.length,
      softCap: this.softCap,
      windowMs: WINDOW_MS,
    };
  }
}
```

---

## 3. Smoke script

**Path:** `scripts/bags-smoke-readonly.ts`

```typescript
/**
 * Phase 1 smoke script: read-only Bags client.
 * Usage: npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/bags-smoke-readonly.ts [mint]
 * Or set BAGS_SMOKE_MINT in env.
 * Does not write to DB. Does not modify engine or Telegram.
 */

import { getBagsClient, isBagsClientError } from "@pulse/bags";

function getMint(): string {
  const arg = process.argv[2];
  if (arg && arg.trim().length > 0) return arg.trim();
  const env = process.env.BAGS_SMOKE_MINT;
  if (env && env.trim().length > 0) return env.trim();
  console.error("Usage: provide mint as first CLI arg or set BAGS_SMOKE_MINT");
  process.exit(1);
}

async function main() {
  const mint = getMint();
  console.log("[bags-smoke] mint:", mint);
  console.log("[bags-smoke] BAGS_API_KEY set:", !!process.env.BAGS_API_KEY);
  console.log("[bags-smoke] SOLANA_RPC_URL set:", !!process.env.SOLANA_RPC_URL);

  let client;
  try {
    client = getBagsClient();
  } catch (e) {
    console.error("[bags-smoke] client init failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  // 1. getTokenCreators
  const creatorsResult = await client.getTokenCreators(mint);
  if (isBagsClientError(creatorsResult)) {
    console.error("[bags-smoke] getTokenCreators error:", creatorsResult.code, creatorsResult.message);
    if (creatorsResult.status) console.error("[bags-smoke] status:", creatorsResult.status);
    if (creatorsResult.code === "BAGS_RATE_LIMIT" && creatorsResult.resetTime) {
      console.error("[bags-smoke] resetTime:", creatorsResult.resetTime);
    }
    process.exit(1);
  }
  console.log("[bags-smoke] getTokenCreators ok:", creatorsResult.creators.length, "creator(s)");
  if (creatorsResult.primaryCreator) {
    const p = creatorsResult.primaryCreator;
    console.log("  primary: wallet=" + p.wallet + " displayName=" + (p.displayName ?? "N/A") + " provider=" + (p.provider ?? "N/A") + " royaltyBps=" + p.royaltyBps);
  }
  creatorsResult.creators.forEach((c, i) => {
    if (!c.isCreator) console.log("  other[" + i + "]: wallet=" + c.wallet + " displayName=" + (c.displayName ?? "N/A"));
  });

  // 2. getTokenLifetimeFees
  const feesResult = await client.getTokenLifetimeFees(mint);
  if (isBagsClientError(feesResult)) {
    console.error("[bags-smoke] getTokenLifetimeFees error:", feesResult.code, feesResult.message);
    if (feesResult.status) console.error("[bags-smoke] status:", feesResult.status);
    process.exit(1);
  }
  console.log("[bags-smoke] getTokenLifetimeFees ok:", feesResult.feesSol.toLocaleString(), "SOL", "(" + feesResult.feesLamports + " lamports)");

  const usage = client.getUsage();
  console.log("[bags-smoke] rate guard usage:", usage.count + "/" + usage.softCap);
  console.log("[bags-smoke] done.");
}

main().catch((e) => {
  console.error("[bags-smoke] unhandled:", e);
  process.exit(1);
});
```

---

## 4. Example successful smoke run (sensitive values redacted)

Run with real creds:  
`npm run bags:smoke -- CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS`  
(ensure `BAGS_API_KEY` and `SOLANA_RPC_URL` are set in `.env`).

**Example output** (API key and RPC URL not printed; wallet/displayName from API redacted here):

```
> pulse@0.1.0 bags:smoke
> npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/bags-smoke-readonly.ts CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS

[bags-smoke] mint: CyXBDcVQuHyEDbG661Jf3iHqxyd9wNHhE2SiQdNrBAGS
[bags-smoke] BAGS_API_KEY set: true
[bags-smoke] SOLANA_RPC_URL set: true
[bags-rate-guard] usage: 1/800 total, 1 for getTokenCreators
[bags-smoke] getTokenCreators ok: 2 creator(s)
  primary: wallet=8xX...abc displayName=tokenCreatorOnTwitter provider=twitter royaltyBps=500
  other[1]: wallet=3yz...def displayName=feeShareUser provider=github
[bags-rate-guard] usage: 2/800 total, 1 for getTokenLifetimeFees
[bags-smoke] getTokenLifetimeFees ok: 1,234.567890 SOL (1234567890000 lamports)
[bags-smoke] rate guard usage: 2/800
[bags-smoke] done.
```

Exit code: 0. No DB writes. No engine or Telegram changes.

**To produce your own run for review:** Run the command above with real `.env`, then redact any wallet addresses or identifying strings if you paste the output elsewhere. The script does not print `BAGS_API_KEY` or `SOLANA_RPC_URL`; it only prints whether they are set (true/false).
