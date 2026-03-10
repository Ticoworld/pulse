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

// ── Env guards ─────────────────────────────────────────────────────────────

const apiKey = process.env.HELIUS_API_KEY;

if (!apiKey) {
  console.error("[stream] HELIUS_API_KEY is not set. Exiting.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("[stream] DATABASE_URL is not set. Exiting.");
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("[stream] starting Pulse stream service...");

  const cfg = getStreamStartupConfig(apiKey!);
  const mode = getStreamMode();

  // Print everything that affects the product boundary.
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

  // ── Step 1: Bags Pools snapshot ──────────────────────────────────────────
  // In bags_only mode: AWAIT the snapshot before starting Helius ingestion.
  // This eliminates the 7-second startup race where DBC txs are processed
  // before knownBagsMints is populated, causing valid Bags mints to be
  // dropped as not_bags_origin.
  //
  // In hybrid/legacy mode: fire-and-forget (non-blocking, best-effort).

  if (mode !== "legacy" && getStreamAllowBagsPoolsPoll()) {
    console.log("[stream] bags_pools_snapshot_loading...");

    if (mode === "bags_only") {
      // Blocking: Helius ingestion must not start until the gate is armed.
      try {
        const newCount = await loadBagsPoolsSnapshot();
        console.log(
          `[stream] bags_pools_snapshot_loaded count=${getBagsMintCount()} new=${newCount}`,
        );
        console.log("[stream] bags_admission_ready=true");
        startBagsPoolsPoller();
      } catch (err) {
        // Fatal: in bags_only mode we cannot correctly gate admissions without
        // the snapshot. Continuing would silently drop all Bags traffic.
        console.error("[stream] FATAL bags_pools_snapshot_error:", err);
        console.error(
          "[stream] bags_only mode requires Bags snapshot on startup. " +
          "Check BAGS_API_KEY and BAGS_API_BASE_URL. Exiting.",
        );
        process.exit(1);
      }
    } else {
      // hybrid: non-blocking, log when done, but do not hold up Helius start.
      loadBagsPoolsSnapshot()
        .then((newCount) => {
          console.log(
            `[stream] bags_pools_snapshot_loaded count=${getBagsMintCount()} new=${newCount}`,
          );
          console.log("[stream] bags_admission_ready=true");
          startBagsPoolsPoller();
        })
        .catch((err) => {
          console.error("[stream] bags_pools_snapshot_error (continuing in hybrid mode):", err);
          startBagsPoolsPoller();
        });
    }
  } else if (mode !== "legacy") {
    console.log("[stream] bags_pools_poll disabled (STREAM_ALLOW_BAGS_POOLS_POLL=false)");
    // In bags_only without polling, admission relies entirely on Restream.
    // Mark ready anyway — on-demand checks will handle unknown mints.
    console.log("[stream] bags_admission_ready=true (restream_only)");
  }

  // ── Step 2: Bags Restream ────────────────────────────────────────────────
  // Start in parallel with the snapshot (above). Real-time launch signals
  // begin accumulating immediately; verified mints enter knownBagsMints
  // as soon as REST confirms them.

  let bagsRestreamProvider: BagsRestreamProvider | null = null;

  if (mode !== "legacy" && getStreamAllowBagsRestream()) {
    bagsRestreamProvider = new BagsRestreamProvider(
      (notice) => {
        // Restream = speed signal. REST = truth.
        // Verify before registering — do not trust heuristic protobuf extraction blindly.
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
        // Undecoded protobuf: trigger immediate REST poll as fallback.
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

  // ── Step 3: Helius provider ──────────────────────────────────────────────
  // In bags_only mode this line is only reached AFTER the snapshot await
  // above succeeds, so knownBagsMints is already populated when the first
  // DBC transaction signature arrives.

  const heliusProvider = new HeliusProvider(apiKey!, (notice) => {
    processSignature(notice).catch((err) =>
      console.error("[stream] unhandled error in processSignature:", err),
    );
  });

  heliusProvider.start();

  // ── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = (): void => {
    console.log("[stream] shutting down...");
    heliusProvider.stop();
    bagsRestreamProvider?.stop();
    stopBagsPoolsPoller();
    stopStreamProcessing();
  };

  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
}

main().catch((err) => {
  console.error("[stream] unhandled startup error:", err);
  process.exit(1);
});
