import "dotenv/config";
import { HeliusProvider } from "./providers/helius";
import { processSignature, stopStreamProcessing } from "./stream";
import { getStreamStartupConfig } from "./config";

const apiKey = process.env.HELIUS_API_KEY;

if (!apiKey) {
  console.error("[stream] HELIUS_API_KEY is not set. Exiting.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("[stream] DATABASE_URL is not set. Exiting.");
  process.exit(1);
}

console.log("[stream] starting Pulse stream service...");

const startupConfig = getStreamStartupConfig(apiKey);
console.log(
  `[stream] startup_config target_programs=${JSON.stringify(
    startupConfig.targetPrograms,
  )} batch_size=${startupConfig.batchSize} batch_sleep_ms=${startupConfig.batchSleepMs} replay_mode=${startupConfig.replayMode} backfill_enabled=${startupConfig.backfillEnabled} restart_resume_state=${startupConfig.restartResumeState} helius_ws_base_url=${startupConfig.heliusWsBaseUrl} helius_http_url=${startupConfig.heliusHttpUrl} dedupe_cache_size=${startupConfig.dedupeCacheSize} max_queue_depth=${startupConfig.maxQueueDepth} debug_metrics=${startupConfig.debugMetrics} metrics_interval_ms=${startupConfig.metricsIntervalMs} metrics_every_n_signatures=${startupConfig.metricsEveryNSignatures} stale_event_warn_seconds=${startupConfig.staleEventWarnSeconds}`,
);

const provider = new HeliusProvider(apiKey, (signature) => {
  processSignature(signature).catch((err) =>
    console.error("[stream] unhandled error in processSignature:", err),
  );
});

provider.start();

process.on("SIGINT", () => {
  console.log("\n[stream] shutting down...");
  provider.stop();
  stopStreamProcessing();
  process.exit(0);
});

process.on("SIGTERM", () => {
  provider.stop();
  stopStreamProcessing();
  process.exit(0);
});
