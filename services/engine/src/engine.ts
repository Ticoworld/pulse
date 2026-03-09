import {
  query,
  getWatchlistWalletByAddress,
  insertSignal,
  getMaxRawEventSeq,
  getLaunchCandidateByMint,
  upsertLaunchCandidateFirstSeen,
  markLaunchCandidateLiquidityLive,
  upsertDevProfile,
  incrementDevLaunchCount,
  incrementDevLiquidityLiveCount,
  upsertLaunchDevLink,
  getLaunchDevLinkByMint,
  getDevProfile,
} from "@pulse/db";
import { recomputeCandidate } from "./candidateEngine";
import { recomputeWallet } from "./walletScorer";
import { processAlphaBuy } from "./clusterEngine";

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 100;

interface RawEventRow {
  seq: string; // bigint comes back as string from pg driver
  event_type: string;
  signature: string;
  slot: string;
  wallet_address: string | null;
  token_mint: string | null;
  amount: string | null;
}

/**
 * Start the polling loop.
 * Returns a stop function for graceful shutdown.
 */
export async function runEngine(): Promise<() => void> {
  const replayFromStart = process.env.ENGINE_REPLAY_FROM_START === "true";
  const ignoredMintsRaw =
    process.env.ENGINE_IGNORED_MINTS ||
    "So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const ignoredMints = new Set(
    ignoredMintsRaw
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean),
  );

  let lastSeq = BigInt(0);

  if (replayFromStart) {
    console.log(
      "[engine] ENGINE_REPLAY_FROM_START=true. Replaying from seq=0...",
    );
  } else {
    lastSeq = await getMaxRawEventSeq();
    console.log(
      `[engine] resuming from current max seq=${lastSeq} (set ENGINE_REPLAY_FROM_START=true to replay history)`,
    );
    console.log(
      `[engine] ignoring base mints: ${ignoredMints.size} configured`,
    );
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    try {
      const result = await query<RawEventRow>(
        `SELECT seq, event_type, signature, slot, wallet_address, token_mint, amount
         FROM raw_events
         WHERE event_type IN ('SWAP', 'TOKEN_MINT')
           AND seq > $1
         ORDER BY seq ASC
         LIMIT $2`,
        [lastSeq.toString(), BATCH_SIZE],
      );

      const rows = result.rows;

      if (rows.length > 0) {
        for (const row of rows) {
          await processRow(row);
          // Always advance seq, even if watchlist miss
          const rowSeq = BigInt(row.seq);
          if (rowSeq > lastSeq) lastSeq = rowSeq;
        }
        console.log(
          `[engine] processed ${rows.length} event(s) up to seq=${lastSeq}`,
        );
      }
    } catch (err) {
      console.error("[engine] poll error:", err);
    }

    if (!stopped) {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }

  async function processRow(row: RawEventRow): Promise<void> {
    const isBaseMint = row.token_mint
      ? ignoredMints.has(row.token_mint)
      : false;

    if (row.event_type === "TOKEN_MINT") {
      if (!row.token_mint || isBaseMint) return;

      // 1. Process NEW_MINT_SEEN
      const candidateExists = await getLaunchCandidateByMint(row.token_mint);
      if (!candidateExists) {
        await upsertLaunchCandidateFirstSeen({
          mint: row.token_mint,
          firstSeenSeq: row.seq,
          firstSeenAt: new Date(),
          firstSeenSignature: row.signature,
        });

        await insertSignal({
          type: "NEW_MINT_SEEN",
          tokenMint: row.token_mint,
          signature: row.signature,
          slot: Number(row.slot),
          payload: {
            mint: row.token_mint,
            signature: row.signature,
            slot: row.slot,
            seq: row.seq,
          },
        });
        console.log(
          `[engine] 🌟 NEW_MINT_SEEN | mint: ${row.token_mint} | sig: ${row.signature.slice(0, 12)}…`,
        );

        // 1.1 Dev Tracking: Link Deployer & Search for Funder
        if (row.wallet_address) {
          const deployerWallet = row.wallet_address;
          let probableDev = deployerWallet;
          let funderWallet: string | null = null;
          let confidence = "medium";
          let method = "deployer";

          // Look backward for a funding transfer (1 hop)
          // We look for a TRANSFER to our deployer within a reasonable recent seq window
          const fundingRes = await query<any>(
            `SELECT raw_payload FROM raw_events 
             WHERE wallet_address = $1 
               AND event_type = 'TRANSFER'
               AND seq < $2
             ORDER BY seq DESC LIMIT 1`,
            [deployerWallet, row.seq],
          );

          if (fundingRes.rows.length > 0) {
            const tx = fundingRes.rows[0].raw_payload;
            const nativeTransfer = tx.nativeTransfers?.[0];
            if (nativeTransfer && nativeTransfer.fromUserAccount) {
              funderWallet = nativeTransfer.fromUserAccount as string;
              probableDev = funderWallet;
              confidence = "high";
              method = "funder";
              console.log(
                `[engine] 🔍 funder identified: ${funderWallet} -> ${deployerWallet}`,
              );
            }
          }

          await upsertLaunchDevLink({
            mint: row.token_mint,
            deployer_wallet: deployerWallet,
            funder_wallet: funderWallet,
            probable_dev_wallet: probableDev,
            confidence: confidence as any,
            method,
          });

          await upsertDevProfile(probableDev);
          await incrementDevLaunchCount(probableDev);
          console.log(
            `[engine] 👤 dev tracked: ${probableDev} linked to ${row.token_mint} (v1 ${method} heuristic)`,
          );

          // Trigger candidate recompute on dev update
          await recomputeCandidate(row.token_mint);
        }
      }
      return;
    }

    if (row.event_type === "SWAP") {
      // 2. Pre-liq progression: LIQUIDITY_LIVE
      if (row.token_mint && !isBaseMint) {
        const candidate = await getLaunchCandidateByMint(row.token_mint);
        if (candidate && !candidate.liquidity_live_seq) {
          await markLaunchCandidateLiquidityLive(
            row.token_mint,
            row.seq,
            row.signature,
            new Date(),
          );

          // 2.1 Dev Tracking: Liquidity Live Count
          const devLink = await getLaunchDevLinkByMint(row.token_mint);
          let devPayload = {};
          if (devLink && devLink.probable_dev_wallet) {
            const devWallet = devLink.probable_dev_wallet;
            await incrementDevLiquidityLiveCount(devWallet);
            const profile = await getDevProfile(devWallet);
            if (profile) {
              devPayload = {
                probable_dev_wallet: devWallet,
                confidence: devLink.confidence,
                launch_count: profile.launch_count,
                liquidity_live_count: profile.liquidity_live_count,
              };
            }
            console.log(
              `[engine] 👤 dev profile updated: ${devWallet} liquidity_live_count++`,
            );
          }

          await insertSignal({
            type: "LIQUIDITY_LIVE",
            tokenMint: row.token_mint,
            signature: row.signature,
            slot: Number(row.slot),
            payload: {
              mint: row.token_mint,
              signature: row.signature,
              slot: row.slot,
              seq: row.seq,
              dev: devPayload,
            },
          });
          console.log(
            `[engine] 💧 LIQUIDITY_LIVE | mint: ${row.token_mint} | sig: ${row.signature.slice(0, 12)}…`,
          );

          // Trigger candidate recompute on liquidity live
          await recomputeCandidate(row.token_mint);
        }
      }

      // 3. Existing ALPHA_WALLET_BUY tracking
      if (!row.wallet_address) return;
      const wallet = await getWatchlistWalletByAddress(row.wallet_address);
      if (!wallet) return;

      if (isBaseMint) return;

      await insertSignal({
        type: "ALPHA_WALLET_BUY",
        walletAddress: row.wallet_address,
        tokenMint: row.token_mint ?? undefined,
        signature: row.signature,
        slot: Number(row.slot),
        payload: {
          label: wallet.label,
          tokenMint: row.token_mint,
          amount: row.amount,
          signature: row.signature,
          slot: row.slot,
          seq: row.seq,
        },
      });

      console.log(
        `[engine] 🚨 ALPHA_WALLET_BUY | wallet: ${row.wallet_address}${wallet.label ? ` (${wallet.label})` : ""} | mint: ${row.token_mint ?? "n/a"} | sig: ${row.signature.slice(0, 12)}…`,
      );

      // Trigger clustering heuristic
      if (row.token_mint && row.wallet_address) {
        await processAlphaBuy(row.token_mint, row.wallet_address, Date.now());
      }

      // Trigger candidate recompute on alpha wallet buy
      if (row.token_mint) {
        await recomputeCandidate(row.token_mint);
      }

      // Trigger wallet profile recompute
      await recomputeWallet(row.wallet_address);
    }
  }

  // Kick off immediately
  tick().catch((err) => console.error("[engine] fatal tick error:", err));

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
