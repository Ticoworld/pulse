import WebSocket from "ws";
import type { HeliusSignatureNotice, HeliusWsMessage } from "../types";
import {
  getHeliusNetwork,
  getHeliusWsBaseUrl,
  getStreamHelius429CooldownMs,
  getStreamHelius429Threshold,
  getStreamStableConnectionResetMs,
  getTargetPrograms,
} from "../config";

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

type EventHandler = (notice: HeliusSignatureNotice) => void;

function is429Like(message: string | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("429") ||
    normalized.includes("too many requests") ||
    normalized.includes("credit") ||
    normalized.includes("rate limit")
  );
}

export class HeliusProvider {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private stopped = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly targetPrograms: string[];
  private readonly wsBaseUrl: string;
  private readonly requestIdToProgram = new Map<number, string>();
  private readonly subscriptionIdToProgram = new Map<number, string>();
  private readonly ws429Threshold = getStreamHelius429Threshold();
  private readonly ws429CooldownMs = getStreamHelius429CooldownMs();
  private readonly stableConnectionResetMs = getStreamStableConnectionResetMs();

  private consecutive429s = 0;
  private circuitOpenUntilMs = 0;
  private connectedAtMs: number | null = null;
  private connectionSaw429 = false;

  constructor(
    private readonly apiKey: string,
    private readonly onEvent: EventHandler,
  ) {
    if (!this.apiKey) {
      throw new Error("HELIUS_API_KEY is missing");
    }

    const network = getHeliusNetwork();
    this.wsBaseUrl = getHeliusWsBaseUrl();
    this.targetPrograms = getTargetPrograms();

    console.log(`[helius] network configured: ${network}`);
    console.log(
      `[helius] target programs count: ${this.targetPrograms.length}`,
    );
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPing();
    this.ws?.close();
  }

  private url(): string {
    return `${this.wsBaseUrl}/?api-key=${this.apiKey}`;
  }

  private connect(): void {
    if (this.stopped) return;

    const blockedMs = this.circuitOpenUntilMs - Date.now();
    if (blockedMs > 0) {
      console.warn(
        `[helius] circuit_open reconnect_blocked_ms=${blockedMs} circuit_open_until=${new Date(
          this.circuitOpenUntilMs,
        ).toISOString()} consecutive_429s=${this.consecutive429s}`,
      );
      setTimeout(() => this.connect(), blockedMs);
      return;
    }

    this.connectionSaw429 = false;

    const wsUrl = this.url();
    const maskedUrl = wsUrl.replace(
      this.apiKey,
      `${this.apiKey.slice(0, 4)}***${this.apiKey.slice(-4)}`,
    );

    console.log(`[helius] connecting to ${maskedUrl} ...`);
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      console.log("[helius] connected");
      this.connectedAtMs = Date.now();
      this.reconnectDelay = RECONNECT_DELAY_MS;
      this.subscribe(ws);
      this.startPing(ws);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const msg: HeliusWsMessage = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        console.error("[helius] message parse error:", err);
      }
    });

    ws.on("error", (err) => {
      if (is429Like(err.message)) {
        this.note429("ws_error", err.message);
        return;
      }
      console.error("[helius] WebSocket error:", err.message);
    });

    ws.on("close", (code, reasonBuffer) => {
      this.clearPing();

      const reason = reasonBuffer.toString();
      const lifetimeMs = this.connectedAtMs == null ? 0 : Date.now() - this.connectedAtMs;
      this.connectedAtMs = null;

      if (!this.connectionSaw429 && is429Like(reason)) {
        this.note429("ws_close", reason || `close_code_${code}`);
      } else if (
        !this.connectionSaw429 &&
        lifetimeMs >= this.stableConnectionResetMs &&
        this.consecutive429s > 0
      ) {
        this.consecutive429s = 0;
      }

      if (this.stopped) return;

      const blockedMs = Math.max(this.circuitOpenUntilMs - Date.now(), 0);
      const reconnectDelay = blockedMs > 0 ? blockedMs : this.reconnectDelay;

      console.warn(
        `[helius] disconnected - reconnecting in ${reconnectDelay}ms...`,
      );
      setTimeout(() => this.connect(), reconnectDelay);

      if (blockedMs === 0) {
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          MAX_RECONNECT_DELAY_MS,
        );
      }
    });
  }

  private subscribe(ws: WebSocket): void {
    this.requestIdToProgram.clear();
    this.subscriptionIdToProgram.clear();

    this.targetPrograms.forEach((programId, index) => {
      const requestId = index + 1;
      this.requestIdToProgram.set(requestId, programId);

      const payload = {
        jsonrpc: "2.0",
        id: requestId,
        method: "logsSubscribe",
        params: [
          {
            mentions: [programId],
          },
          {
            commitment: "confirmed",
          },
        ],
      };
      ws.send(JSON.stringify(payload));
    });

    console.log(
      `[helius] logsSubscribe requests sent for ${this.targetPrograms.length} programs`,
    );
  }

  private handleMessage(msg: HeliusWsMessage): void {
    if (msg.error) {
      if (is429Like(msg.error.message)) {
        this.note429("rpc_message", msg.error.message);
        this.ws?.close();
        return;
      }

      console.error(
        `[helius] RPC error code=${msg.error.code} message=${msg.error.message}`,
      );
      return;
    }

    if (msg.id !== undefined && msg.result !== undefined) {
      const programId = this.requestIdToProgram.get(msg.id);
      if (programId) {
        this.subscriptionIdToProgram.set(msg.result, programId);
      }
      console.log(
        `[helius] subscribed, subscription id: ${msg.result} program=${programId ?? "unknown"}`,
      );
      return;
    }

    if (msg.method === "logsNotification" && msg.params?.result) {
      const value = msg.params.result.value;
      if (value && value.signature && !value.err) {
        this.onEvent({
          signature: value.signature,
          slot: msg.params.result.context.slot,
          logs: value.logs ?? [],
          programId:
            msg.params.subscription == null
              ? undefined
              : this.subscriptionIdToProgram.get(msg.params.subscription),
        });
      }
    }
  }

  private note429(source: string, details: string): void {
    this.connectionSaw429 = true;
    this.consecutive429s += 1;

    console.warn(
      `[helius] ws_429_detected source=${source} consecutive_429s=${this.consecutive429s} details=${JSON.stringify(
        details,
      )}`,
    );

    if (this.consecutive429s >= this.ws429Threshold) {
      this.circuitOpenUntilMs = Date.now() + this.ws429CooldownMs;
      console.error(
        `[helius] ws_429_circuit_open cooldown_ms=${this.ws429CooldownMs} circuit_open_until=${new Date(
          this.circuitOpenUntilMs,
        ).toISOString()} consecutive_429s=${this.consecutive429s}`,
      );
    }
  }

  private startPing(ws: WebSocket): void {
    this.clearPing();
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
