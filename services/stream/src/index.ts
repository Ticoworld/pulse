import "dotenv/config";
import { HeliusProvider } from "./providers/helius";
import { BagsRestreamProvider } from "./providers/bags-restream";
import { processSignature, stopStreamProcessing } from "./stream";
import {
  getStreamStartupConfig,
  getStreamAllowBagsRestream,
  getStreamAllowBagsPoolsPoll,
  getStreamMode,
} from "./config";
import {
  loadBagsPoolsSnapshot,
  startBagsPoolsPoller,
  stopBagsPoolsPoller,
  registerBagsMint,
  checkBagsMintViaApi,
  getBagsMintCount,
} from "./bags-admission";

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

const cfg = getStreamStartupConfig(apiKey);

// ── Startup config log ─────────────────────────────────────────────────────
// Print everything that affects the product boundary so it is visible on
// deploy without needing to read env vars directly.
console.log(
  `[stream] startup_config` +
  ` stream_mode=${cfg.streamMode}` +
  ` target_programs=${JSON.stringify(cfg.targetPrograms)}` +
  ` allow_bags_restream=${cfg.allowBagsRestream}` +
  ` allow_bags_pools_poll=${cfg.allowBagsPoolsPoll}` +
  ` bags_pools_poll_ms=${cfg.bagsPoolsPollMs}` +
  ` bags_restream_url=${cfg.bagsRestreamUrl}` +
  ` bags_api_base_url=${cfg.bagsApiBaseUrl}` +
  ` allow_meteora_dbc=${cfg.allowMeteoraDbc}` +
  ` allow_meteora_damm_v2=${cfg.allowMeteoraDammV2}` +
  ` allow_general_solana=${cfg.allowGeneralSolana}` +
  ` allow_jupiter_program=${cfg.allowJupiterProgram}` +
  ` batch_size=${cfg.batchSize}` +
  ` batch_min_sleep_ms=${cfg.batchMinSleepMs}` +
  ` max_queue_depth=${cfg.maxQueueDepth}` +
  ` max_queued_age_seconds=${cfg.maxQueuedAgeSeconds}` +
  ` helius_ws_base_url=${cfg.heliusWsBaseUrl}` +
  ` helius_http_url=${cfg.heliusHttpUrl}` +
  ` debug_metrics=${cfg.debugMetrics}` +
  ` stale_event_warn_seconds=${cfg.staleEventWarnSeconds}`,
);

// ── Bags Pools snapshot (startup) ──────────────────────────────────────────
// Load the initial snapshot before starting any providers so that the
// admission gate has a populated knownBagsMints set from the first tx.
const mode = getStreamMode();

if (mode !== "legacy" && getStreamAllowBagsPoolsPoll()) {
  console.log("[stream] bags_pools_snapshot_loading...");
  loadBagsPoolsSnapshot()
    .then((newCount) => {
      console.log(
        `[stream] bags_pools_snapshot_loaded count=${getBagsMintCount()} new=${newCount}`,
      );
      startBagsPoolsPoller();
    })
    .catch((err) => {
      console.error("[stream] bags_pools_snapshot_error (continuing without snapshot):", err);
      // Still start the poller — it will retry on the next interval
      startBagsPoolsPoller();
    });
} else if (mode !== "legacy") {
  console.log("[stream] bags_pools_poll disabled (STREAM_ALLOW_BAGS_POOLS_POLL=false)");
}

// ── Bags Restream provider ─────────────────────────────────────────────────

let bagsRestreamProvider: BagsRestreamProvider | null = null;

if (mode !== "legacy" && getStreamAllowBagsRestream()) {
  bagsRestreamProvider = new BagsRestreamProvider(
    (notice) => {
      // Bags Restream fired with a candidate mint extracted from the protobuf
      // payload. The extraction is heuristic (first base58-length string field),
      // so we do NOT trust it blindly. Verify via the Bags REST API first.
      // Only if the API confirms the mint is a known Bags pool do we register it.
      //
      // Restream = speed signal.  REST = truth.
      //
      // If the Helius DBC tx arrives before verification completes, the
      // checkBagsMintViaApi call in checkBagsAdmission() deduplicates with
      // the in-flight promise from here (see bags-admission.ts pendingChecks).
      console.log(`[stream] bags_restream_candidate_seen mint=${notice.mint}`);
      checkBagsMintViaApi(notice.mint)
        .then((confirmed) => {
          if (confirmed) {
            const isNew = registerBagsMint(notice.mint);
            if (isNew) {
              console.log(
                `[stream] bags_admission_accept reason=restream_verified mint=${notice.mint} bags_known_count=${getBagsMintCount()}`,
              );
            }
          } else {
            console.log(
              `[stream] bags_restream_candidate_rejected mint=${notice.mint} reason=api_not_found`,
            );
          }
        })
        .catch((err) => {
          console.error(
            `[stream] bags_restream_candidate_check_error mint=${notice.mint}:`,
            err,
          );
        });
    },
    () => {
      // Undecoded message: trigger an immediate Bags Pools API poll to catch
      // any mint we could not extract from the protobuf payload.
      loadBagsPoolsSnapshot()
        .then((newCount) => {
          if (newCount > 0) {
            console.log(
              `[stream] bags_pools_restream_fallback_poll_success new=${newCount} total=${getBagsMintCount()}`,
            );
          }
        })
        .catch((err) => {
          console.error("[stream] bags_pools_restream_fallback_poll_error:", err);
        });
    },
  );
  bagsRestreamProvider.start();
} else if (mode !== "legacy") {
  console.log("[stream] bags_restream disabled (STREAM_ALLOW_BAGS_RESTREAM=false)");
}

// ── Helius provider ────────────────────────────────────────────────────────

const heliusProvider = new HeliusProvider(apiKey, (notice) => {
  processSignature(notice).catch((err) =>
    console.error("[stream] unhandled error in processSignature:", err),
  );
});

heliusProvider.start();

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(): void {
  console.log("[stream] shutting down...");
  heliusProvider.stop();
  bagsRestreamProvider?.stop();
  stopBagsPoolsPoller();
  stopStreamProcessing();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
