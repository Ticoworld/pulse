import type { RawEvent, EventType } from "@pulse/common";

export type { RawEvent, EventType };

export interface HeliusSignatureNotice {
  signature: string;
  slot: number;
  logs: string[];
  programId?: string;
}

/** Raw shape of a Helius enhanced transaction (partial — only fields we map) */
export interface HeliusTransaction {
  signature: string;
  slot: number;
  timestamp: number; // unix seconds
  type?: string;   // Helius transaction type string (e.g. "SWAP", "TOKEN_MINT")
  source?: string; // Helius source label (e.g. "METEORA_DBC", "RAYDIUM_AMM")
  feePayer?: string;
  tokenTransfers?: Array<{
    mint?: string;
    toUserAccount?: string;
    fromUserAccount?: string;
    tokenAmount?: number;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
}

/** Message shape coming over the Helius WebSocket for logsSubscribe */
export interface HeliusWsMessage {
  jsonrpc: string;
  method?: string;
  params?: {
    result?: {
      context: { slot: number };
      value: {
        signature: string;
        err: any;
        logs: string[];
      };
    };
    subscription?: number;
  };
  id?: number;
  result?: number;
  error?: { code: number; message: string };
}
