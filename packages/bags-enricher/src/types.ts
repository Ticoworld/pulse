export const CREATORS_TTL_HOURS = 24;
export const FEES_TTL_MINUTES = 15;
export const DEFAULT_LIMIT = 25;
export const DEFAULT_SINCE_HOURS = 168;

export interface EnrichmentRunOptions {
  limit?: number;
  sinceHours?: number;
  mint?: string | null;
  force?: boolean;
  dryRun?: boolean;
  creatorsTtlHours?: number;
  feesTtlMinutes?: number;
  /** Optional log prefix (e.g. "[bags-enrich]" or "[bags-enricher]") */
  logPrefix?: string;
}

/** Stop reason when the run did not complete all candidates. */
export type EnrichmentStopReason = "auth" | "soft_cap" | "rate_limit" | null;

export interface EnrichmentRunResult {
  /** Why the run stopped early, or null if finished normally. */
  stopReason: EnrichmentStopReason;
  /** Number of mints processed (attempted at least one Bags call or dry-run line). */
  processedCount: number;
  /** Total candidates selected for this run. */
  candidateCount: number;
}
