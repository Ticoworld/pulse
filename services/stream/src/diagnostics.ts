import type { RawEvent } from "@pulse/common";
import {
  BASE_SOL_MINT,
  BASE_USDC_MINT,
  MAX_BATCH_SIZE,
  getStreamDebugMetrics,
  getStreamMetricsEveryNSignatures,
  getStreamMetricsIntervalMs,
  getStreamStaleEventWarnSeconds,
} from "./config";

interface QueueMetricSnapshot {
  queueDepth: number;
  uniqueQueuedSignatures: number;
  oldestQueuedAgeSeconds: number | null;
  newestQueuedAgeSeconds: number | null;
}

interface BatchStartLog {
  batchStartTimeMs: number;
  batchSizeRequested: number;
  queueDepthBeforeFetch: number;
  oldestQueuedAgeBeforeFetchSeconds: number | null;
  retryCount: number;
}

interface BatchDoneLog extends BatchStartLog {
  queueDepthAfterFetch: number;
  fetchDurationMs: number;
  txCountReturned: number;
  missingTxCount: number;
}

interface BatchErrorLog extends BatchStartLog {
  fetchDurationMs: number;
  errorClass: string;
  httpStatus: number | null;
  errorMessage: string;
}

function toFixed(value: number | null | undefined, digits = 3): string {
  if (value == null || Number.isNaN(value)) return "n/a";
  return value.toFixed(digits);
}

function fmtIso(value: number | null): string {
  if (value == null) return "n/a";
  return new Date(value).toISOString();
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index] ?? null;
}

function topEntries(map: Map<string, number>, limit: number): string {
  return JSON.stringify(
    [...map.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([key, count]) => ({ key, count })),
  );
}

export class StreamDiagnostics {
  private readonly debugMetrics = getStreamDebugMetrics();
  private readonly metricsIntervalMs = getStreamMetricsIntervalMs();
  private readonly metricsEveryNSignatures = getStreamMetricsEveryNSignatures();
  private readonly staleEventWarnSeconds = getStreamStaleEventWarnSeconds();

  private readonly signatureFirstQueuedAt = new Map<string, number>();
  private metricsTimer: ReturnType<typeof setInterval> | null = null;

  private intervalStartedAtMs = Date.now();
  private intervalEnqueueCount = 0;
  private totalEnqueueCount = 0;
  private intervalDuplicateDrops = 0;
  private totalDuplicateDrops = 0;
  private intervalSignaturesReceived = 0;
  private intervalSignaturesDropped = 0;
  private intervalFetchRequestsAttempted = 0;
  private intervalFetchSignaturesAttempted = 0;
  private intervalFetchSignaturesSkipped = 0;
  private readonly intervalDropReasons = new Map<string, number>();

  private readonly intervalEventTypeCounts = new Map<string, number>();
  private readonly intervalMintCounts = new Map<string, number>();
  private readonly intervalChainLagSeconds: number[] = [];
  private oldestChainTimeSeenMs: number | null = null;
  private newestChainTimeSeenMs: number | null = null;

  constructor(private readonly getQueueSnapshot: () => readonly string[]) {}

  start(): void {
    if (this.metricsIntervalMs <= 0) return;

    this.metricsTimer = setInterval(() => {
      this.emitIntervalMetrics();
    }, this.metricsIntervalMs);
    this.metricsTimer.unref?.();
  }

  stop(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }
  }

  onSignatureQueued(signature: string): void {
    this.signatureFirstQueuedAt.set(signature, Date.now());
    this.intervalEnqueueCount += 1;
    this.totalEnqueueCount += 1;

    if (
      this.debugMetrics &&
      this.metricsEveryNSignatures > 0 &&
      this.totalEnqueueCount % this.metricsEveryNSignatures === 0
    ) {
      this.emitQueueMetrics("signature_sample");
    }
  }

  onDuplicateSignatureDropped(): void {
    this.intervalDuplicateDrops += 1;
    this.totalDuplicateDrops += 1;
  }

  onSignatureReceived(): void {
    this.intervalSignaturesReceived += 1;
  }

  onSignatureDropped(reason: string): void {
    this.intervalSignaturesDropped += 1;
    this.intervalDropReasons.set(
      reason,
      (this.intervalDropReasons.get(reason) ?? 0) + 1,
    );
  }

  onFetchAttempt(signatureCount: number): void {
    this.intervalFetchRequestsAttempted += 1;
    this.intervalFetchSignaturesAttempted += signatureCount;
  }

  onFetchSkipped(signatureCount: number): void {
    this.intervalFetchSignaturesSkipped += signatureCount;
  }

  onBatchSettled(signatures: readonly string[]): void {
    for (const signature of signatures) {
      this.signatureFirstQueuedAt.delete(signature);
    }
  }

  buildBatchStartLog(batch: readonly string[], retryCount: number): BatchStartLog {
    const batchStartTimeMs = Date.now();
    const queueWithBatch = [...batch, ...this.getQueueSnapshot()];
    const ageSnapshot = this.snapshotFor(queueWithBatch);

    return {
      batchStartTimeMs,
      batchSizeRequested: batch.length,
      queueDepthBeforeFetch: queueWithBatch.length,
      oldestQueuedAgeBeforeFetchSeconds: ageSnapshot.oldestQueuedAgeSeconds,
      retryCount,
    };
  }

  logFetchBatchStart(log: BatchStartLog): void {
    console.log(
      `[stream] fetch_batch_start batch_start_time=${new Date(
        log.batchStartTimeMs,
      ).toISOString()} batch_size_requested=${log.batchSizeRequested} queue_depth_before_fetch=${log.queueDepthBeforeFetch} oldest_queued_age_before_fetch_seconds=${toFixed(log.oldestQueuedAgeBeforeFetchSeconds)} retry_count=${log.retryCount}`,
    );
  }

  logFetchBatchDone(log: BatchDoneLog): void {
    console.log(
      `[stream] fetch_batch_done batch_start_time=${new Date(
        log.batchStartTimeMs,
      ).toISOString()} batch_size_requested=${log.batchSizeRequested} queue_depth_before_fetch=${log.queueDepthBeforeFetch} queue_depth_after_fetch=${log.queueDepthAfterFetch} oldest_queued_age_before_fetch_seconds=${toFixed(log.oldestQueuedAgeBeforeFetchSeconds)} fetch_duration_ms=${log.fetchDurationMs} tx_count_returned=${log.txCountReturned} missing_tx_count=${log.missingTxCount} retry_count=${log.retryCount}`,
    );
  }

  logFetchBatchError(log: BatchErrorLog): void {
    console.error(
      `[stream] fetch_batch_error batch_start_time=${new Date(
        log.batchStartTimeMs,
      ).toISOString()} batch_size_requested=${log.batchSizeRequested} queue_depth_before_fetch=${log.queueDepthBeforeFetch} oldest_queued_age_before_fetch_seconds=${toFixed(log.oldestQueuedAgeBeforeFetchSeconds)} fetch_duration_ms=${log.fetchDurationMs} retry_count=${log.retryCount} http_status=${log.httpStatus ?? "n/a"} error_class=${log.errorClass} error_message=${JSON.stringify(log.errorMessage)}`,
    );
  }

  recordEventBeforeInsert(event: RawEvent, insertAttemptTimeMs: number): void {
    const mint = event.tokenMint ?? "n/a";
    const chainToStreamInsertSeconds =
      (insertAttemptTimeMs - event.timestamp) / 1000;

    this.intervalEventTypeCounts.set(
      event.eventType,
      (this.intervalEventTypeCounts.get(event.eventType) ?? 0) + 1,
    );
    this.intervalMintCounts.set(
      mint,
      (this.intervalMintCounts.get(mint) ?? 0) + 1,
    );
    this.intervalChainLagSeconds.push(chainToStreamInsertSeconds);

    this.oldestChainTimeSeenMs =
      this.oldestChainTimeSeenMs == null
        ? event.timestamp
        : Math.min(this.oldestChainTimeSeenMs, event.timestamp);
    this.newestChainTimeSeenMs =
      this.newestChainTimeSeenMs == null
        ? event.timestamp
        : Math.max(this.newestChainTimeSeenMs, event.timestamp);

    if (
      this.debugMetrics ||
      chainToStreamInsertSeconds >= this.staleEventWarnSeconds
    ) {
      console.warn(
        `[stream] stale_event_ingested event_type=${event.eventType} mint=${mint} signature=${event.signature} chain_time=${new Date(
          event.timestamp,
        ).toISOString()} stream_insert_attempt_time=${new Date(
          insertAttemptTimeMs,
        ).toISOString()} chain_to_stream_insert_seconds=${toFixed(
          chainToStreamInsertSeconds,
        )}`,
      );
    }
  }

  private emitIntervalMetrics(): void {
    this.emitQueueMetrics("interval");
    this.emitUsageSummary();
    this.emitMixSummary();
    this.emitFreshnessSummary();
    this.resetIntervalState();
  }

  private emitQueueMetrics(trigger: string): void {
    const snapshot = this.snapshotFor(this.getQueueSnapshot());
    const elapsedSeconds = Math.max(
      (Date.now() - this.intervalStartedAtMs) / 1000,
      1,
    );
    const enqueueRate = this.intervalEnqueueCount / elapsedSeconds;

    console.log(
      `[stream] queue_metrics trigger=${trigger} queue_depth=${snapshot.queueDepth} unique_queued_signatures=${snapshot.uniqueQueuedSignatures} duplicate_signature_drops_interval=${this.intervalDuplicateDrops} duplicate_signature_drops_total=${this.totalDuplicateDrops} oldest_queued_age_seconds=${toFixed(snapshot.oldestQueuedAgeSeconds)} newest_queued_age_seconds=${toFixed(snapshot.newestQueuedAgeSeconds)} enqueue_rate_per_second=${toFixed(enqueueRate)}`,
    );

    const hasDepthWarning = snapshot.queueDepth >= MAX_BATCH_SIZE * 10;
    const hasAgeWarning =
      snapshot.oldestQueuedAgeSeconds != null &&
      snapshot.oldestQueuedAgeSeconds >= this.staleEventWarnSeconds;

    if (hasDepthWarning || hasAgeWarning) {
      const warningReason =
        hasDepthWarning && hasAgeWarning
          ? "depth_and_age"
          : hasDepthWarning
            ? "depth"
            : "age";

      console.warn(
        `[stream] queue_backlog_warning reason=${warningReason} queue_depth=${snapshot.queueDepth} unique_queued_signatures=${snapshot.uniqueQueuedSignatures} oldest_queued_age_seconds=${toFixed(snapshot.oldestQueuedAgeSeconds)} newest_queued_age_seconds=${toFixed(snapshot.newestQueuedAgeSeconds)} stale_event_warn_seconds=${this.staleEventWarnSeconds}`,
      );
    }
  }

  private emitMixSummary(): void {
    console.log(
      `[stream] mix_summary interval_ms=${this.metricsIntervalMs} total_events=${this.intervalChainLagSeconds.length} event_type_counts=${JSON.stringify(
        Object.fromEntries(this.intervalEventTypeCounts),
      )} top_mints=${topEntries(this.intervalMintCounts, 10)} so111_count=${this.intervalMintCounts.get(BASE_SOL_MINT) ?? 0} epjfwdd_count=${this.intervalMintCounts.get(BASE_USDC_MINT) ?? 0} mint_na_count=${this.intervalMintCounts.get("n/a") ?? 0}`,
    );
  }

  private emitUsageSummary(): void {
    console.log(
      `[stream] usage_summary interval_ms=${this.metricsIntervalMs} signatures_received=${this.intervalSignaturesReceived} signatures_enqueued=${this.intervalEnqueueCount} signatures_dropped=${this.intervalSignaturesDropped} duplicate_signature_drops=${this.intervalDuplicateDrops} tx_fetch_requests_attempted=${this.intervalFetchRequestsAttempted} tx_fetch_signatures_attempted=${this.intervalFetchSignaturesAttempted} tx_fetch_signatures_skipped=${this.intervalFetchSignaturesSkipped} estimated_http_request_units_per_minute=${this.intervalFetchRequestsAttempted} estimated_credits_burned_per_minute=unproven drop_reasons=${topEntries(this.intervalDropReasons, 10)}`,
    );
  }

  private emitFreshnessSummary(): void {
    console.log(
      `[stream] freshness_summary interval_ms=${this.metricsIntervalMs} samples=${this.intervalChainLagSeconds.length} oldest_chain_time_seen=${fmtIso(
        this.oldestChainTimeSeenMs,
      )} newest_chain_time_seen=${fmtIso(
        this.newestChainTimeSeenMs,
      )} wall_clock_minus_chain_time_p50=${toFixed(
        percentile(this.intervalChainLagSeconds, 0.5),
      )} wall_clock_minus_chain_time_p95=${toFixed(
        percentile(this.intervalChainLagSeconds, 0.95),
      )} wall_clock_minus_chain_time_max=${toFixed(
        percentile(this.intervalChainLagSeconds, 1),
      )}`,
    );
  }

  private resetIntervalState(): void {
    this.intervalStartedAtMs = Date.now();
    this.intervalEnqueueCount = 0;
    this.intervalDuplicateDrops = 0;
    this.intervalSignaturesReceived = 0;
    this.intervalSignaturesDropped = 0;
    this.intervalFetchRequestsAttempted = 0;
    this.intervalFetchSignaturesAttempted = 0;
    this.intervalFetchSignaturesSkipped = 0;
    this.intervalEventTypeCounts.clear();
    this.intervalMintCounts.clear();
    this.intervalDropReasons.clear();
    this.intervalChainLagSeconds.length = 0;
    this.oldestChainTimeSeenMs = null;
    this.newestChainTimeSeenMs = null;
  }

  private snapshotFor(signatures: readonly string[]): QueueMetricSnapshot {
    const now = Date.now();
    const unique = new Set<string>();
    const ages: number[] = [];

    for (const signature of signatures) {
      unique.add(signature);
      const queuedAt = this.signatureFirstQueuedAt.get(signature);
      if (queuedAt != null) {
        ages.push((now - queuedAt) / 1000);
      }
    }

    if (ages.length === 0) {
      return {
        queueDepth: signatures.length,
        uniqueQueuedSignatures: unique.size,
        oldestQueuedAgeSeconds: null,
        newestQueuedAgeSeconds: null,
      };
    }

    return {
      queueDepth: signatures.length,
      uniqueQueuedSignatures: unique.size,
      oldestQueuedAgeSeconds: Math.max(...ages),
      newestQueuedAgeSeconds: Math.min(...ages),
    };
  }
}
