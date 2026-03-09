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
