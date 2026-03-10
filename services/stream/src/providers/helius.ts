import WebSocket from "ws";
import type { HeliusWsMessage } from "../types";
import { getHeliusNetwork, getHeliusWsBaseUrl, getTargetPrograms } from "../config";

const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

type EventHandler = (signature: string) => void;

export class HeliusProvider {
  private ws: WebSocket | null = null;
  private reconnectDelay = RECONNECT_DELAY_MS;
  private stopped = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private targetPrograms: string[];
  private wsBaseUrl: string;

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
      console.error("[helius] WebSocket error:", err.message);
    });

    ws.on("close", () => {
      this.clearPing();
      if (this.stopped) return;
      console.warn(
        `[helius] disconnected - reconnecting in ${this.reconnectDelay}ms...`,
      );
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(
        this.reconnectDelay * 2,
        MAX_RECONNECT_DELAY_MS,
      );
    });
  }

  /**
   * Subscribe to log notifications filtered to our target programs.
   * Free-tier safe (unlike transactionSubscribe).
   */
  private subscribe(ws: WebSocket): void {
    this.targetPrograms.forEach((programId, index) => {
      const payload = {
        jsonrpc: "2.0",
        id: index + 1,
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
    if (msg.id !== undefined && msg.result !== undefined) {
      console.log(`[helius] subscribed, subscription id: ${msg.result}`);
      return;
    }

    if (msg.method === "logsNotification" && msg.params?.result) {
      const value = msg.params.result.value;
      if (value && value.signature && !value.err) {
        this.onEvent(value.signature);
      }
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
