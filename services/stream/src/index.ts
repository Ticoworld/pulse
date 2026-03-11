import "dotenv/config";
import crypto from "crypto";
import { insertRawEvent } from "@pulse/db";
import { HeliusProvider } from "./providers/helius";
import { BagsRestreamProvider } from "./providers/bags-restream";
import { processSignature, stopStreamProcessing } from "./stream";
import {
  getStreamStartupConfig,
  getStreamAllowBagsRestream,
  getStreamAllowBagsPoolsPoll,
  getStreamMode,
  getTargetPrograms,
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
      // Retry up to 3 times with backoff before giving up — transient API
      // errors (rate limit, cold-start) must not kill a fresh deploy.
      const MAX_TRIES = 3;
      let lastErr: unknown;
      let loaded = false;
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        try {
          const newCount = await loadBagsPoolsSnapshot();
          console.log(
            `[stream] bags_pools_snapshot_loaded count=${getBagsMintCount()} new=${newCount} attempt=${attempt}`,
          );
          loaded = true;
          break;
        } catch (err) {
          lastErr = err;
          console.error(
            `[stream] bags_pools_snapshot_error attempt=${attempt}/${MAX_TRIES}:`,
            err,
          );
          if (attempt < MAX_TRIES) {
            const delay = attempt * 5_000;
            console.log(`[stream] retrying snapshot in ${delay}ms…`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (!loaded) {
        console.error("[stream] FATAL bags_pools_snapshot_failed after all retries:", lastErr);
        console.error(
          "[stream] bags_only mode requires Bags snapshot on startup. " +
          "Check BAGS_API_KEY and BAGS_API_BASE_URL. Exiting.",
        );
        process.exit(1);
      }
      console.log("[stream] bags_admission_ready=true");
      startBagsPoolsPoller();
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
          .then(async (confirmed) => {
            if (confirmed) {
              const isNew = registerBagsMint(notice.mint);
              if (isNew) {
                console.log(
                  `[stream] bags_admission_accept reason=restream_verified mint=${notice.mint} bags_known_count=${getBagsMintCount()}`,
                );
              }
              // Insert a synthetic TOKEN_MINT raw event so the engine fires
              // NEW_MINT_SEEN immediately — without waiting for the Helius
              // HTTP fetch, which may be delayed or age out during DBC bursts.
              // The engine's signalAlreadyFiredForMint guard deduplicates if
              // the real Helius tx also comes through later.
              const syntheticSig = `restream_${notice.mint}_${crypto.createHash("sha256").update(notice.mint).digest("hex").slice(0, 8)}`;
              try {
                await insertRawEvent({
                  source: "bags_restream",
                  eventType: "TOKEN_MINT",
                  signature: syntheticSig,
                  slot: 0,
                  tokenMint: notice.mint,
                  timestamp: Date.now(),
                  rawPayload: { source: "bags_restream", mint: notice.mint },
                });
                console.log(
                  `[stream] bags_restream_direct_insert mint=${notice.mint} sig=${syntheticSig}`,
                );
              } catch (insertErr) {
                console.error(
                  `[stream] bags_restream_direct_insert_error mint=${notice.mint}:`,
                  insertErr,
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
  // Skip entirely when no programs are subscribed (e.g. DBC=false, DAMM v2=false).
  // In that mode Restream handles all launch detection at zero Helius credit cost.

  let heliusProvider: HeliusProvider | null = null;
  const targetPrograms = getTargetPrograms();

  if (targetPrograms.length > 0) {
    heliusProvider = new HeliusProvider(apiKey!, (notice) => {
      processSignature(notice).catch((err) =>
        console.error("[stream] unhandled error in processSignature:", err),
      );
    });
    heliusProvider.start();
  } else {
    console.log(
      "[stream] helius_provider_skipped reason=no_target_programs (restream_only mode)",
    );
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────

  const shutdown = (): void => {
    console.log("[stream] shutting down...");
    heliusProvider?.stop();
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
