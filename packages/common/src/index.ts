export const APP_NAME = "pulse";

/** Supported event categories for Phase 1 */
export type EventType = "SWAP" | "TOKEN_MINT" | "TRANSFER";

/** Normalised shape that every raw Helius event gets mapped into */
export interface RawEvent {
  /** Unique ID — we use the transaction signature as the natural key */
  id: string;
  /** Data source label, e.g. 'helius' */
  source: string;
  /** Normalised event category */
  eventType: EventType;
  /** Solana transaction signature */
  signature: string;
  /** Block slot number */
  slot: number;
  /** Primary wallet address involved */
  walletAddress?: string;
  /** Token mint address */
  tokenMint?: string;
  /** Token / SOL amount (raw, not UI formatted) */
  amount?: number;
  /** Block time in milliseconds */
  timestamp: number;
  /** Original payload from Helius, stored as-is for future reprocessing */
  rawPayload: unknown;
}
