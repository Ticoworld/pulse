/**
 * Normalized shapes for app use. SDK raw responses are not leaked outside this package.
 * Source: Bags docs Get Token Creators / Get Token Lifetime Fees.
 */

export interface BagsTokenCreator {
  wallet: string;
  isCreator: boolean;
  displayName: string | null;
  provider: string | null;
  pfp: string | null;
  royaltyBps: number;
}

export interface BagsTokenCreatorsResult {
  ok: true;
  creators: BagsTokenCreator[];
  primaryCreator: BagsTokenCreator | null;
}

export interface BagsTokenLifetimeFeesResult {
  ok: true;
  feesLamports: number;
  feesSol: number;
}

/**
 * Explicit Bags client error types.
 * IMPORTANT: BAGS_LOCAL_SOFT_CAP is in-process guard refusal (no HTTP status).
 * BAGS_RATE_LIMIT is only for a real 429 from the Bags API. Do not collapse these two.
 */
export type BagsClientError =
  | { code: "BAGS_LOCAL_SOFT_CAP"; message: string }
  | { code: "BAGS_AUTH"; status: 401; message: string }
  | { code: "BAGS_FORBIDDEN"; status: 403; message: string }
  | { code: "BAGS_RATE_LIMIT"; status: 429; message: string; limit?: number; remaining?: number; resetTime?: string }
  | { code: "BAGS_ERROR"; status?: number; message: string };

export function isBagsClientError(e: unknown): e is BagsClientError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    typeof (e as BagsClientError).code === "string" &&
    (e as BagsClientError).code.startsWith("BAGS_")
  );
}

/** True iff this is local in-process soft-cap refusal (not a real Bags API 429). */
export function isBagsLocalSoftCap(e: unknown): e is { code: "BAGS_LOCAL_SOFT_CAP"; message: string } {
  return isBagsClientError(e) && e.code === "BAGS_LOCAL_SOFT_CAP";
}

/** True iff this is a real Bags API rate-limit response (HTTP 429). */
export function isBagsRateLimit(e: unknown): e is Extract<BagsClientError, { code: "BAGS_RATE_LIMIT" }> {
  return isBagsClientError(e) && e.code === "BAGS_RATE_LIMIT";
}
