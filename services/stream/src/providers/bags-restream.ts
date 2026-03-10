/**
 * Bags Restream WebSocket provider.
 *
 * Connects to wss://restream.bags.fm and subscribes to launchpad_launch:BAGS.
 * On each launch event, extracts the token mint from the protobuf payload and
 * calls onLaunch({ mint }).
 *
 * If protobuf extraction fails (schema change or unknown format), onUndecodedMessage
 * is called so the caller can trigger an immediate Bags Pools API poll as fallback.
 *
 * Message format: {topic}:{subject};{varint_len}{protobuf_payload}
 * Example: "launchpad_launch:BAGS;<varint><protobuf bytes>"
 *
 * Protobuf extraction is zero-dep: we scan for the first string field whose
 * decoded value is 43–44 characters of base58 alphabet (a Solana address).
 * No protobufjs needed.
 *
 * Connection requirements:
 *   - Ping JSON {"type":"ping"} every ≤60s (we ping every 30s)
 *   - Reconnect with exponential backoff on close/error
 */

import WebSocket from "ws";
import { getBagsRestreamUrl } from "../config";

const PING_INTERVAL_MS = 30_000;
const RECONNECT_INITIAL_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const LAUNCH_CHANNEL = "launchpad_launch:BAGS";

export interface BagsLaunchNotice {
  /** Token mint address extracted from the Restream protobuf payload. */
  mint: string;
}

type LaunchHandler = (notice: BagsLaunchNotice) => void;
type UndecodedHandler = () => void;

// ── Protobuf zero-dep extractor ────────────────────────────────────────────

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_SET = new Set(BASE58_ALPHABET);

function isSolanaAddress(s: string): boolean {
  return (s.length === 43 || s.length === 44) && [...s].every((c) => BASE58_SET.has(c));
}

/**
 * Read a protobuf varint from `buf` starting at `offset`.
 * Returns [value, bytesConsumed].
 */
function readVarint(buf: Buffer, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i - offset];
    shift += 7;
    if (shift >= 35) break; // overflow guard
  }
  return [0, 0];
}

/**
 * Scan raw protobuf bytes for the first string field that looks like a Solana
 * address (43–44 base58 characters). Returns null if none found.
 *
 * Called AFTER stripping the delimited message length varint. The bytes we
 * receive are raw protobuf key-value pairs; we don't need the field numbers
 * to find addresses because Solana address strings are structurally distinct
 * (exact length, restricted alphabet).
 */
function extractMintFromProtoBytes(buf: Buffer, start: number): string | null {
  let i = start;

  while (i < buf.length) {
    if (buf[i] === undefined) break;

    // Read field tag (varint)
    const [tag, tagLen] = readVarint(buf, i);
    if (tagLen === 0) break;
    i += tagLen;

    const wireType = tag & 0x07;

    if (wireType === 2) {
      // Length-delimited: string, bytes, or embedded message
      const [len, lenBytes] = readVarint(buf, i);
      if (lenBytes === 0) break;
      i += lenBytes;

      if (len >= 43 && len <= 44 && i + len <= buf.length) {
        const candidate = buf.toString("ascii", i, i + len);
        if (isSolanaAddress(candidate)) {
          return candidate;
        }
      }
      i += len;
    } else if (wireType === 0) {
      // Varint — skip
      const [, skip] = readVarint(buf, i);
      i += skip || 1;
    } else if (wireType === 1) {
      i += 8; // 64-bit
    } else if (wireType === 5) {
      i += 4; // 32-bit
    } else {
      // Unknown wire type: stop scanning to avoid mis-parse
      break;
    }
  }

  return null;
}

/**
 * Given the raw WebSocket buffer for a Bags Restream event, extract the
 * token mint from the protobuf payload.
 *
 * Expected structure:
 *   "launchpad_launch:BAGS;" + [varint message length] + [protobuf bytes]
 */
function extractMintFromEvent(buf: Buffer): string | null {
  // Find the ';' delimiter (ASCII 0x3B)
  const semiIdx = buf.indexOf(0x3b);
  if (semiIdx === -1) return null;

  // After ';' comes the delimited protobuf: [varint message length][proto bytes]
  const after = semiIdx + 1;
  const [, varIntLen] = readVarint(buf, after);
  if (varIntLen === 0) return null;

  // Proto message bytes start after the varint
  const protoStart = after + varIntLen;
  return extractMintFromProtoBytes(buf, protoStart);
}

// ── BagsRestreamProvider ───────────────────────────────────────────────────

export class BagsRestreamProvider {
  private ws: WebSocket | null = null;
  private stopped = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private readonly url: string;

  constructor(
    private readonly onLaunch: LaunchHandler,
    private readonly onUndecodedMessage?: UndecodedHandler,
  ) {
    this.url = getBagsRestreamUrl();
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped) return;

    console.log(`[stream] bags_restream_connecting url=${this.url}`);
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      console.log("[stream] bags_restream_connected");

      // Subscribe to Bags launches
      ws.send(JSON.stringify({ type: "subscribe", event: LAUNCH_CHANNEL }));
      console.log(`[stream] bags_restream_subscribed event=${LAUNCH_CHANNEL}`);

      this.startPing(ws);
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        this.handleMessage(data);
      } catch (err) {
        console.error("[stream] bags_restream_message_error:", err);
      }
    });

    ws.on("error", (err) => {
      console.error("[stream] bags_restream_error:", err.message);
    });

    ws.on("close", (code, reason) => {
      this.clearPing();
      this.ws = null;
      if (this.stopped) return;

      const reasonStr = reason.length > 0 ? reason.toString() : "no_reason";
      console.warn(
        `[stream] bags_restream_disconnected code=${code} reason=${reasonStr} reconnecting_in=${this.reconnectDelay}ms`,
      );

      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);

      setTimeout(() => {
        if (!this.stopped) {
          console.log(`[stream] bags_restream_reconnecting delay_ms=${delay}`);
          this.connect();
        }
      }, delay);
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    const buf: Buffer = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data as ArrayBuffer);

    // JSON control messages (pong, subscribed, error notices) start with '{'
    if (buf.length > 0 && buf[0] === 0x7b) {
      try {
        const msg = JSON.parse(buf.toString("utf8")) as {
          type?: string;
          event?: string;
        };
        if (msg.type === "reconnected") {
          console.log("[stream] bags_restream_reconnected");
        } else if (msg.type === "subscribed") {
          console.log(
            `[stream] bags_restream_subscription_confirmed event=${msg.event ?? "unknown"}`,
          );
        }
      } catch {
        // Not parseable JSON — ignore
      }
      return;
    }

    // Binary protobuf message: verify it is a launchpad_launch:BAGS event
    const prefix = buf.toString("ascii", 0, Math.min(buf.length, 28));
    if (!prefix.startsWith("launchpad_launch:BAGS;")) {
      return;
    }

    const mint = extractMintFromEvent(buf);
    if (mint) {
      console.log(`[stream] bags_restream_launch_seen mint=${mint}`);
      this.onLaunch({ mint });
    } else {
      console.warn(
        "[stream] bags_restream_message_undecoded channel=launchpad_launch:BAGS — will trigger pools poll",
      );
      this.onUndecodedMessage?.();
    }
  }

  private startPing(ws: WebSocket): void {
    this.clearPing();
    this.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
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
