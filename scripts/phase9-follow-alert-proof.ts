/**
 * Phase 9 proof helper:
 * - /follow persistence
 * - /following list
 * - follower delivery row creation
 * - duplicate delivery dedupe
 * - SQL output for follow and delivery rows
 *
 * Run:
 *   npx ts-node -r dotenv/config -r tsconfig-paths/register --project tsconfig.json scripts/phase9-follow-alert-proof.ts
 */
import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
  followMintForTelegramUser,
  hasTelegramSignalDelivery,
  listFollowedMintsForTelegramUser,
  query,
  recordTelegramSignalDelivery,
  upsertTelegramUser,
} from "@pulse/db";
import { formatErrorForLog } from "../apps/tg-bot/src/alertSender";
import { formatFollowedHighInterestAlert } from "../apps/tg-bot/src/formatters";

const DELIVERY_KIND = "followed_high_interest";

interface HighInterestSignalRow {
  id: string;
  type: string;
  token_mint: string | null;
  signature: string;
  slot: number;
  payload: Record<string, unknown>;
  created_at: Date | string;
}

async function loadHighInterestSignal(mint?: string): Promise<HighInterestSignalRow | null> {
  if (mint) {
    const byMint = await query<HighInterestSignalRow>(
      `SELECT id, type, token_mint, signature, slot, payload, created_at
       FROM signals
       WHERE type = 'HIGH_INTEREST_TOKEN'
         AND token_mint = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [mint],
    );
    return byMint.rows[0] ?? null;
  }

  const latest = await query<HighInterestSignalRow>(
    `SELECT id, type, token_mint, signature, slot, payload, created_at
     FROM signals
     WHERE type = 'HIGH_INTEREST_TOKEN'
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  return latest.rows[0] ?? null;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const ownerChatIdRaw = process.env.TELEGRAM_OWNER_CHAT_ID;
  const proofUserIdRaw = process.env.PHASE9_PROOF_USER_ID ?? ownerChatIdRaw;
  if (!proofUserIdRaw) {
    console.error("Set PHASE9_PROOF_USER_ID or TELEGRAM_OWNER_CHAT_ID.");
    process.exit(1);
  }

  const proofUserId = Number.parseInt(proofUserIdRaw, 10);
  if (Number.isNaN(proofUserId)) {
    console.error("Proof user id is not numeric.");
    process.exit(1);
  }

  const desiredMint = process.env.PHASE9_PROOF_MINT;
  const signal = await loadHighInterestSignal(desiredMint);
  if (!signal || !signal.token_mint) {
    console.error("No HIGH_INTEREST_TOKEN signal found for proof.");
    process.exit(1);
  }
  const mint = signal.token_mint;

  await upsertTelegramUser({
    telegramUserId: proofUserId,
    username: "phase9_proof_user",
    firstName: "Phase9",
    lastName: "Proof",
    lastCommand: "/follow",
    isOwner: ownerChatIdRaw ? proofUserId === Number.parseInt(ownerChatIdRaw, 10) : false,
  });

  const followResult = await followMintForTelegramUser(proofUserId, mint);
  console.log(`[proof:/follow] user=${proofUserId} mint=${mint} created=${followResult.created}`);

  const following = await listFollowedMintsForTelegramUser(proofUserId);
  console.log(`[proof:/following] count=${following.length} mints=${following.map((x) => x.mint).join(",")}`);

  const alreadyDelivered = await hasTelegramSignalDelivery(
    proofUserId,
    signal.id,
    DELIVERY_KIND,
  );

  if (!alreadyDelivered) {
    const alert = formatFollowedHighInterestAlert({
      type: signal.type,
      wallet_address: null,
      token_mint: signal.token_mint,
      signature: signal.signature,
      slot: signal.slot,
      payload: signal.payload,
      created_at: signal.created_at,
    });

    let sent = false;
    let errorMessage: string | null = null;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (botToken) {
      try {
        const bot = new TelegramBot(botToken, { polling: false });
        await bot.sendMessage(proofUserId, alert.text, {
          disable_web_page_preview: true,
        });
        sent = true;
      } catch (err) {
        errorMessage = formatErrorForLog(err, botToken);
      }
    } else {
      errorMessage = "telegram_send_skipped_no_bot_token";
    }

    const inserted = await recordTelegramSignalDelivery({
      telegramUserId: proofUserId,
      signalId: signal.id,
      deliveryKind: DELIVERY_KIND,
      success: sent,
      errorMessage,
    });
    console.log(
      `[proof:delivery] signal=${signal.id} inserted=${inserted.inserted} sent=${sent} error=${errorMessage ?? "none"}`,
    );
  } else {
    console.log(`[proof:delivery] signal=${signal.id} already delivered, skipping send`);
  }

  const duplicateAttempt = await recordTelegramSignalDelivery({
    telegramUserId: proofUserId,
    signalId: signal.id,
    deliveryKind: DELIVERY_KIND,
    success: true,
    errorMessage: null,
  });
  console.log(
    `[proof:dedupe] duplicate insert allowed=${duplicateAttempt.inserted} (expected false)`,
  );

  const followRows = await query(
    `SELECT telegram_user_id, mint, created_at
     FROM telegram_user_mint_follows
     WHERE telegram_user_id = $1
     ORDER BY created_at DESC`,
    [proofUserId],
  );
  console.log(
    `[sql:follows] rows=${followRows.rowCount} data=${JSON.stringify(followRows.rows)}`,
  );

  const deliveryRows = await query(
    `SELECT telegram_user_id, signal_id, delivery_kind, delivered_at, success, error_message
     FROM telegram_signal_deliveries
     WHERE telegram_user_id = $1
       AND signal_id = $2
       AND delivery_kind = $3
     ORDER BY delivered_at ASC`,
    [proofUserId, signal.id, DELIVERY_KIND],
  );
  console.log(
    `[sql:deliveries] rows=${deliveryRows.rowCount} data=${JSON.stringify(deliveryRows.rows)}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
