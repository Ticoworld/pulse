import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import {
  addWatchlistWallet,
  removeWatchlistWallet,
  listWatchlistWallets,
  listUnsentSignals,
  markSignalSent,
  markSignalTelegramSkipped,
  getWalletProfile,
  getActorByWallet,
  listUnnotifiedExecutionOrders,
  markOrderNotificationSent,
  listUnnotifiedExitOrders,
  markExitOrderNotificationSent,
  getTopCandidateSignalsForDigest,
  getMintSummaryForTelegram,
  getTelegramCommandCooldownRemainingSeconds,
  followMintForTelegramUser,
  unfollowMintForTelegramUser,
  listFollowedMintsForTelegramUser,
  listFollowersForMint,
  hasTelegramSignalDelivery,
  recordTelegramSignalDelivery,
  upsertTelegramUser,
  recordTelegramCommandEvent,
  HIGH_INTEREST_THRESHOLD,
  type Signal,
  type ExecutionOrder,
  type ExitOrder,
  type TopCandidateForDigest,
} from "@pulse/db";
import {
  createChatAlertSender,
  createOwnerAlertSender,
  formatErrorForLog,
  type FormattedAlert,
} from "./alertSender";
import {
  formatAlphaWalletBuySignal,
  formatBagsEnrichmentResolvedSignal,
  formatBuyConfirmed,
  formatBuyFailed,
  formatBuySubmitted,
  formatExitConfirmed,
  formatExitFailed,
  formatExitSubmitted,
  formatFollowedHighInterestAlert,
  formatHighInterestSignal,
  formatLiquidityLiveSignal,
  formatMintSummary,
  formatNewMintSignal,
  formatTopCandidatesDigest,
  formatUnknownSignal,
} from "./formatters";
import {
  evaluateSignalFreshness,
  isFreshnessProtectedSignalType,
  type SignalFreshnessResult,
} from "./signalFreshness";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("[tg-bot] TELEGRAM_BOT_TOKEN is not set. Exiting.");
  process.exit(1);
}

const ownerChatIdRaw = process.env.TELEGRAM_OWNER_CHAT_ID;
if (!ownerChatIdRaw) {
  console.error("[tg-bot] TELEGRAM_OWNER_CHAT_ID is not set. Exiting.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("[tg-bot] DATABASE_URL is not set. Exiting.");
  process.exit(1);
}

const OWNER_CHAT_ID = Number(ownerChatIdRaw);
const SIGNAL_POLL_INTERVAL_MS = 5_000;
const TOP_CANDIDATES_DEFAULT_LIMIT = 10;
const TOP_CANDIDATES_FRESHNESS_HOURS = 24;
const PUBLIC_COMMAND_COOLDOWN_SECONDS = Number.parseInt(
  process.env.TG_PUBLIC_COMMAND_COOLDOWN_SECONDS ?? "30",
  10,
);
const COOLDOWN_COMMANDS = ["/top_candidates", "/mint"];
const FOLLOWED_HIGH_INTEREST_DELIVERY_KIND = "followed_high_interest";

const bot = new TelegramBot(token, { polling: true });
const sendChatAlert = createChatAlertSender({
  bot,
  botTokenForRedaction: token,
});
const sendOwnerAlert = createOwnerAlertSender({
  bot,
  ownerChatId: OWNER_CHAT_ID,
  botTokenForRedaction: token,
});

bot.setMyCommands([
  { command: "start", description: "Start the bot" },
  { command: "help", description: "Show command list" },
  { command: "top_candidates", description: "Launch and alpha signals (24h)" },
  { command: "mint", description: "Query a mint for Bags context" },
  { command: "follow", description: "Follow a mint for alerts" },
  { command: "unfollow", description: "Unfollow a mint" },
  { command: "following", description: "List your followed mints" },
]).catch((err) => {
  console.error("[tg-bot] setMyCommands failed:", err);
});

bot.on("polling_error", (err) => {
  console.error("[tg-bot] polling_error:", formatErrorForLog(err, token));
});

function isOwner(msg: TelegramBot.Message): boolean {
  return msg.chat.id === OWNER_CHAT_ID;
}

function readStringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return "unavailable";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "unavailable" : parsed.toISOString();
}

function secondsBetween(
  later: Date | string | null | undefined,
  earlier: Date | string | null | undefined,
): string {
  if (!later || !earlier) return "unavailable";
  const laterDate = later instanceof Date ? later : new Date(later);
  const earlierDate = earlier instanceof Date ? earlier : new Date(earlier);
  if (Number.isNaN(laterDate.getTime()) || Number.isNaN(earlierDate.getTime())) {
    return "unavailable";
  }
  return ((laterDate.getTime() - earlierDate.getTime()) / 1000).toFixed(3);
}

function logFreshnessDecision(
  label: string,
  signal: Signal,
  freshness: SignalFreshnessResult,
): void {
  console.warn(
    `[tg-bot] ${label} type=${signal.type} mint=${signal.token_mint ?? "n/a"} signature=${signal.signature} chain_time=${toIso(freshness.chainTime)} current_time=${toIso(freshness.currentTime)} age_seconds=${freshness.ageSeconds == null ? "unproven" : freshness.ageSeconds.toFixed(3)}`,
  );
}

function logSignalDeliveryTrace(signal: Signal, telegramSentAt: Date): void {
  console.log(
    `[tg-bot] signal_delivery_trace type=${signal.type} mint=${signal.token_mint ?? "n/a"} signature=${signal.signature} chain_time=${toIso(signal.chain_time)} raw_event_created_at=${toIso(signal.raw_event_created_at)} engine_processed_at=${toIso(signal.engine_processed_at)} signal_created_at=${toIso(signal.created_at)} telegram_sent_at=${telegramSentAt.toISOString()} chain_to_raw_seconds=${secondsBetween(signal.raw_event_created_at, signal.chain_time)} raw_to_engine_seconds=${secondsBetween(signal.engine_processed_at, signal.raw_event_created_at)} engine_to_signal_seconds=${secondsBetween(signal.created_at, signal.engine_processed_at)} signal_to_telegram_seconds=${secondsBetween(telegramSentAt, signal.created_at)} chain_to_telegram_seconds=${secondsBetween(telegramSentAt, signal.chain_time)}`,
  );
}

async function formatSignalAlert(signal: Signal): Promise<FormattedAlert> {
  if (signal.type === "ALPHA_WALLET_BUY") {
    const wallet = signal.wallet_address;
    if (!wallet) {
      return formatAlphaWalletBuySignal(signal);
    }

    const [profile, actor] = await Promise.all([
      getWalletProfile(wallet),
      getActorByWallet(wallet),
    ]);

    return formatAlphaWalletBuySignal(signal, profile, actor);
  }

  if (signal.type === "NEW_MINT_SEEN") {
    return formatNewMintSignal(signal);
  }

  if (signal.type === "LIQUIDITY_LIVE") {
    return formatLiquidityLiveSignal(signal);
  }

  if (signal.type === "BAGS_ENRICHMENT_RESOLVED") {
    return formatBagsEnrichmentResolvedSignal(signal);
  }

  if (signal.type === "HIGH_INTEREST_TOKEN") {
    const payload = signal.payload as Record<string, unknown>;
    const alphaWallet = readStringField(payload, "alpha_wallet");
    if (!alphaWallet) {
      return formatHighInterestSignal(signal);
    }

    const [profile, actor] = await Promise.all([
      getWalletProfile(alphaWallet),
      getActorByWallet(alphaWallet),
    ]);

    return formatHighInterestSignal(signal, profile, actor);
  }

  return formatUnknownSignal(signal);
}

interface CommandContext {
  msg: TelegramBot.Message;
  command: string;
  argsRaw: string | null;
  telegramUserId: number;
  owner: boolean;
}

interface CommandResult {
  success: boolean;
  errorMessage?: string | null;
}

type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

function parseArgsRaw(match?: RegExpExecArray | null): string | null {
  const raw = match?.[1]?.trim();
  return raw && raw.length > 0 ? raw : null;
}

function parseFirstArg(argsRaw: string | null): string | null {
  if (!argsRaw) return null;
  const first = argsRaw.split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

function buildHelpText(owner: boolean): string {
  const lines = [
    "Commands:",
    "/start - welcome and quick command intro",
    "/help - command list",
    "/top_candidates [limit] - top HIGH_INTEREST candidates from DB (24h window)",
    "/mint <address> - DB-backed mint summary",
    "/follow <mint> - follow a mint for personalized HIGH_INTEREST alerts",
    "/unfollow <mint> - stop follow alerts for a mint",
    "/following - list your followed mints",
  ];

  if (owner) {
    lines.push(
      "",
      "Owner admin commands:",
      "/watchlist_add <wallet> [label]",
      "/watchlist_remove <wallet>",
      "/watchlist_list",
    );
  }

  return lines.join("\n");
}

function buildStartText(owner: boolean): string {
  const lines = [
    "Pulse Bags bot is live.",
    "Public commands are read-only and DB-backed.",
    "",
    buildHelpText(owner),
  ];
  return lines.join("\n");
}

async function sendPlainText(chatId: number, text: string, context: string): Promise<boolean> {
  return sendChatAlert({
    chatId,
    text,
    format: "plain",
    context,
  });
}

async function requireOwner(ctx: CommandContext): Promise<CommandResult | null> {
  if (ctx.owner) {
    return null;
  }
  await sendPlainText(ctx.msg.chat.id, "This command is owner-only.", `${ctx.command} owner_only`);
  return { success: false, errorMessage: "owner_only" };
}

async function enforcePublicCooldown(ctx: CommandContext): Promise<CommandResult | null> {
  const cooldownSeconds = Number.isFinite(PUBLIC_COMMAND_COOLDOWN_SECONDS)
    ? Math.max(1, PUBLIC_COMMAND_COOLDOWN_SECONDS)
    : 30;

  const remaining = await getTelegramCommandCooldownRemainingSeconds(
    ctx.telegramUserId,
    COOLDOWN_COMMANDS,
    cooldownSeconds,
  );

  if (remaining <= 0) {
    return null;
  }

  await sendPlainText(
    ctx.msg.chat.id,
    `Too many requests. Try again in ${remaining}s.`,
    `${ctx.command} cooldown`,
  );
  return { success: false, errorMessage: `cooldown_${remaining}s` };
}

async function sendFollowedHighInterestAlerts(signal: Signal): Promise<void> {
  if (signal.type !== "HIGH_INTEREST_TOKEN" || !signal.token_mint) {
    return;
  }

  let followers: number[] = [];
  try {
    followers = await listFollowersForMint(signal.token_mint);
  } catch (err) {
    console.error(
      `[tg-bot] failed loading followers for mint ${signal.token_mint}:`,
      formatErrorForLog(err, token),
    );
    return;
  }

  if (followers.length === 0) {
    return;
  }

  const alert = formatFollowedHighInterestAlert(signal);
  for (const followerId of followers) {
    try {
      const alreadyDelivered = await hasTelegramSignalDelivery(
        followerId,
        signal.id,
        FOLLOWED_HIGH_INTEREST_DELIVERY_KIND,
      );
      if (alreadyDelivered) {
        continue;
      }

      const sent = await sendChatAlert({
        ...alert,
        chatId: followerId,
        context: `followed mint alert signal=${signal.id} user=${followerId}`,
      });

      await recordTelegramSignalDelivery({
        telegramUserId: followerId,
        signalId: signal.id,
        deliveryKind: FOLLOWED_HIGH_INTEREST_DELIVERY_KIND,
        success: sent,
        errorMessage: sent ? null : "send_failed",
      });
    } catch (err) {
      const errorMessage = formatErrorForLog(err, token);
      console.error(
        `[tg-bot] follower alert error signal=${signal.id} user=${followerId}:`,
        errorMessage,
      );
      try {
        await recordTelegramSignalDelivery({
          telegramUserId: followerId,
          signalId: signal.id,
          deliveryKind: FOLLOWED_HIGH_INTEREST_DELIVERY_KIND,
          success: false,
          errorMessage,
        });
      } catch (recordErr) {
        console.error(
          `[tg-bot] failed recording follower delivery error signal=${signal.id} user=${followerId}:`,
          formatErrorForLog(recordErr, token),
        );
      }
    }
  }
}

async function runTrackedCommand(
  msg: TelegramBot.Message,
  command: string,
  argsRaw: string | null,
  handler: CommandHandler,
): Promise<void> {
  const user = msg.from;
  if (!user) {
    console.error(`[tg-bot] ${command} ignored: message missing sender`);
    return;
  }

  const owner = isOwner(msg);
  const telegramUserId = user.id;

  try {
    await upsertTelegramUser({
      telegramUserId,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      lastName: user.last_name ?? null,
      lastCommand: command,
      isOwner: owner,
    });
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error(`[tg-bot] failed user upsert for ${command}:`, errorMessage);
    await sendPlainText(msg.chat.id, "Command failed. Try again shortly.", `${command} upsert_failed`);
    return;
  }

  const ctx: CommandContext = {
    msg,
    command,
    argsRaw,
    telegramUserId,
    owner,
  };

  let result: CommandResult = { success: true };
  try {
    result = await handler(ctx);
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error(`[tg-bot] ${command} error:`, errorMessage);
    await sendPlainText(msg.chat.id, "Command failed. Check logs.", `${command} unhandled`);
    result = { success: false, errorMessage };
  }

  try {
    await recordTelegramCommandEvent({
      telegramUserId,
      command,
      commandArgs: argsRaw,
      success: result.success,
      errorMessage: result.errorMessage ?? null,
    });
  } catch (err) {
    console.error(
      `[tg-bot] failed to record command event for ${command}:`,
      formatErrorForLog(err, token),
    );
  }
}

function registerCommand(
  regex: RegExp,
  command: string,
  handler: CommandHandler,
): void {
  bot.onText(regex, (msg, match) => {
    runTrackedCommand(msg, command, parseArgsRaw(match), handler).catch((err) => {
      console.error(
        `[tg-bot] fatal command handler error for ${command}:`,
        formatErrorForLog(err, token),
      );
    });
  });
}

registerCommand(/^\/ping(?:@\w+)?$/, "/ping", async (ctx) => {
  const sent = await sendPlainText(ctx.msg.chat.id, "pong", "/ping");
  return sent ? { success: true } : { success: false, errorMessage: "send_failed" };
});

registerCommand(/^\/start(?:@\w+)?$/, "/start", async (ctx) => {
  const sent = await sendPlainText(
    ctx.msg.chat.id,
    buildStartText(ctx.owner),
    "/start",
  );
  return sent ? { success: true } : { success: false, errorMessage: "send_failed" };
});

registerCommand(/^\/help(?:@\w+)?$/, "/help", async (ctx) => {
  const sent = await sendPlainText(
    ctx.msg.chat.id,
    buildHelpText(ctx.owner),
    "/help",
  );
  return sent ? { success: true } : { success: false, errorMessage: "send_failed" };
});

registerCommand(/^\/watchlist_add(?:@\w+)?(?:\s+(.+))?$/, "/watchlist_add", async (ctx) => {
  const ownerGate = await requireOwner(ctx);
  if (ownerGate) return ownerGate;

  const args = ctx.argsRaw?.split(/\s+/) ?? [];
  const wallet = args[0];
  const label = args.slice(1).join(" ") || undefined;

  if (!wallet) {
    await sendPlainText(
      ctx.msg.chat.id,
      "Usage: /watchlist_add <wallet> [label]",
      "/watchlist_add usage",
    );
    return { success: false, errorMessage: "invalid_args" };
  }

  try {
    await addWatchlistWallet(wallet, label);
    const display = label ? `${wallet} (${label})` : wallet;
    const sent = await sendPlainText(
      ctx.msg.chat.id,
      `Added to watchlist: ${display}`,
      "/watchlist_add ok",
    );
    if (sent) {
      console.log(`[tg-bot] watchlist add: ${display}`);
      return { success: true };
    }
    return { success: false, errorMessage: "send_failed" };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] watchlist_add error:", errorMessage);
    await sendPlainText(
      ctx.msg.chat.id,
      "Failed to add wallet. Check logs.",
      "/watchlist_add failed",
    );
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/watchlist_remove(?:@\w+)?(?:\s+(.+))?$/, "/watchlist_remove", async (ctx) => {
  const ownerGate = await requireOwner(ctx);
  if (ownerGate) return ownerGate;

  const wallet = parseFirstArg(ctx.argsRaw);
  if (!wallet) {
    await sendPlainText(
      ctx.msg.chat.id,
      "Usage: /watchlist_remove <wallet>",
      "/watchlist_remove usage",
    );
    return { success: false, errorMessage: "invalid_args" };
  }

  try {
    await removeWatchlistWallet(wallet);
    const sent = await sendPlainText(
      ctx.msg.chat.id,
      `Removed from watchlist: ${wallet}`,
      "/watchlist_remove ok",
    );
    if (sent) {
      console.log(`[tg-bot] watchlist remove: ${wallet}`);
      return { success: true };
    }
    return { success: false, errorMessage: "send_failed" };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] watchlist_remove error:", errorMessage);
    await sendPlainText(
      ctx.msg.chat.id,
      "Failed to remove wallet. Check logs.",
      "/watchlist_remove failed",
    );
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/watchlist_list(?:@\w+)?$/, "/watchlist_list", async (ctx) => {
  const ownerGate = await requireOwner(ctx);
  if (ownerGate) return ownerGate;

  try {
    const wallets = await listWatchlistWallets();
    if (wallets.length === 0) {
      const sent = await sendPlainText(ctx.msg.chat.id, "Watchlist is empty.", "/watchlist_list empty");
      return sent ? { success: true } : { success: false, errorMessage: "send_failed" };
    }

    const lines = wallets.map((wallet, idx) => {
      const suffix = wallet.label ? ` - ${wallet.label}` : "";
      return `${idx + 1}. ${wallet.wallet_address}${suffix}`;
    });

    const sent = await sendPlainText(
      ctx.msg.chat.id,
      `Watchlist (${wallets.length}):\n\n${lines.join("\n")}`,
      "/watchlist_list ok",
    );
    return sent ? { success: true } : { success: false, errorMessage: "send_failed" };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] watchlist_list error:", errorMessage);
    await sendPlainText(
      ctx.msg.chat.id,
      "Failed to fetch watchlist. Check logs.",
      "/watchlist_list failed",
    );
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/top_candidates(?:@\w+)?(?:\s+(.+))?$/, "/top_candidates", async (ctx) => {
  const cooldownGate = await enforcePublicCooldown(ctx);
  if (cooldownGate) return cooldownGate;

  let limit = TOP_CANDIDATES_DEFAULT_LIMIT;
  if (ctx.argsRaw) {
    const parsed = Number.parseInt(ctx.argsRaw, 10);
    if (Number.isNaN(parsed)) {
      await sendPlainText(
        ctx.msg.chat.id,
        "Usage: /top_candidates [limit]",
        "/top_candidates usage",
      );
      return { success: false, errorMessage: "invalid_args" };
    }
    limit = Math.min(Math.max(1, parsed), 50);
  }

  try {
    const rows = await getTopCandidateSignalsForDigest(
      limit,
      TOP_CANDIDATES_FRESHNESS_HOURS,
      HIGH_INTEREST_THRESHOLD,
    );
    const alert = formatTopCandidatesDigest(
      rows.map((r: TopCandidateForDigest) => ({
        mint: r.mint,
        score: r.score,
        metadata: r.metadata,
        alpha_wallet_trigger: r.alpha_wallet_trigger,
        liquidity_live_trigger: r.liquidity_live_trigger,
        dev_trigger: r.dev_trigger,
        primary_creator_display_name: r.primary_creator_display_name,
        primary_creator_provider: r.primary_creator_provider,
        fees_lamports: r.fees_lamports,
      })),
      {
        title: "Top HIGH_INTEREST candidates",
        freshnessHours: TOP_CANDIDATES_FRESHNESS_HOURS,
      },
    );

    const sent = await sendChatAlert({
      ...alert,
      chatId: ctx.msg.chat.id,
      context: "/top_candidates digest",
    });
    if (sent) {
      console.log(`[tg-bot] sent /top_candidates digest to ${ctx.telegramUserId}, count=${rows.length}`);
      return { success: true };
    }
    return { success: false, errorMessage: "send_failed" };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] top_candidates error:", errorMessage);
    await sendPlainText(
      ctx.msg.chat.id,
      "Failed to fetch top candidates. Check logs.",
      "/top_candidates failed",
    );
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/mint(?:@\w+)?(?:\s+(.+))?$/, "/mint", async (ctx) => {
  const cooldownGate = await enforcePublicCooldown(ctx);
  if (cooldownGate) return cooldownGate;

  const mint = parseFirstArg(ctx.argsRaw);
  if (!mint) {
    await sendPlainText(ctx.msg.chat.id, "Usage: /mint <address>", "/mint usage");
    return { success: false, errorMessage: "invalid_args" };
  }

  try {
    const summary = await getMintSummaryForTelegram(mint);
    const alert = formatMintSummary({
      mint: summary.mint,
      foundInDb: summary.foundInDb,
      score: summary.score,
      bagsBonus: summary.bagsBonus,
      primaryCreatorDisplayName: summary.primaryCreatorDisplayName,
      primaryCreatorProvider: summary.primaryCreatorProvider,
      feesLamports: summary.feesLamports,
      hasHighInterestSignal: summary.hasHighInterestSignal,
    });
    const sent = await sendChatAlert({
      ...alert,
      chatId: ctx.msg.chat.id,
      context: "/mint summary",
    });
    return sent ? { success: true } : { success: false, errorMessage: "send_failed" };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] mint lookup error:", errorMessage);
    await sendPlainText(ctx.msg.chat.id, "Failed to fetch mint summary. Check logs.", "/mint failed");
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/follow(?:@\w+)?(?:\s+(.+))?$/, "/follow", async (ctx) => {
  const mint = parseFirstArg(ctx.argsRaw);
  if (!mint) {
    await sendPlainText(ctx.msg.chat.id, "Usage: /follow <mint>", "/follow usage");
    return { success: false, errorMessage: "invalid_args" };
  }

  try {
    const summary = await getMintSummaryForTelegram(mint);
    if (!summary.foundInDb) {
      await sendPlainText(ctx.msg.chat.id, `Mint not found in DB: ${mint}`, "/follow mint_not_found");
      return { success: false, errorMessage: "mint_not_found" };
    }

    const followResult = await followMintForTelegramUser(ctx.telegramUserId, mint);
    if (!followResult.created) {
      await sendPlainText(ctx.msg.chat.id, `Already following: ${mint}`, "/follow already_following");
      return { success: true };
    }

    await sendPlainText(ctx.msg.chat.id, `Now following: ${mint}`, "/follow ok");
    return { success: true };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] follow error:", errorMessage);
    await sendPlainText(ctx.msg.chat.id, "Failed to follow mint. Check logs.", "/follow failed");
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/unfollow(?:@\w+)?(?:\s+(.+))?$/, "/unfollow", async (ctx) => {
  const mint = parseFirstArg(ctx.argsRaw);
  if (!mint) {
    await sendPlainText(ctx.msg.chat.id, "Usage: /unfollow <mint>", "/unfollow usage");
    return { success: false, errorMessage: "invalid_args" };
  }

  try {
    const result = await unfollowMintForTelegramUser(ctx.telegramUserId, mint);
    if (result.removed) {
      await sendPlainText(ctx.msg.chat.id, `Unfollowed: ${mint}`, "/unfollow removed");
      return { success: true };
    }
    await sendPlainText(ctx.msg.chat.id, `Not currently followed: ${mint}`, "/unfollow not_found");
    return { success: true };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] unfollow error:", errorMessage);
    await sendPlainText(ctx.msg.chat.id, "Failed to unfollow mint. Check logs.", "/unfollow failed");
    return { success: false, errorMessage };
  }
});

registerCommand(/^\/following(?:@\w+)?$/, "/following", async (ctx) => {
  try {
    const follows = await listFollowedMintsForTelegramUser(ctx.telegramUserId);
    if (follows.length === 0) {
      await sendPlainText(ctx.msg.chat.id, "You are not following any mints.", "/following empty");
      return { success: true };
    }

    const lines = follows.map((row, index) => `${index + 1}. ${row.mint}`);
    await sendPlainText(
      ctx.msg.chat.id,
      `Following (${follows.length}):\n\n${lines.join("\n")}`,
      "/following ok",
    );
    return { success: true };
  } catch (err) {
    const errorMessage = formatErrorForLog(err, token);
    console.error("[tg-bot] following error:", errorMessage);
    await sendPlainText(ctx.msg.chat.id, "Failed to list follows. Check logs.", "/following failed");
    return { success: false, errorMessage };
  }
});

async function pollSignals(): Promise<void> {
  try {
    const signals = await listUnsentSignals(10);
    for (const signal of signals) {
      if (isFreshnessProtectedSignalType(signal.type)) {
        const freshness = evaluateSignalFreshness(signal);

        if (freshness.decision === "unproven") {
          logFreshnessDecision("freshness_unproven", signal, freshness);
        } else if (freshness.decision === "send_with_warning") {
          logFreshnessDecision("freshness_warning", signal, freshness);
        } else if (freshness.decision === "skip_stale") {
          logFreshnessDecision("stale_signal_skipped", signal, freshness);
          await markSignalTelegramSkipped(signal.id, {
            reason: "chain_age_over_120s",
            ageSeconds: freshness.ageSeconds ?? 0,
            chainTime: freshness.chainTime,
            currentTime: freshness.currentTime,
          });
          continue;
        }
      }

      const alert = await formatSignalAlert(signal);
      const ownerSent = await sendOwnerAlert({
        ...alert,
        context: `signal ${signal.id} (${signal.type})`,
      });

      if (ownerSent) {
        const telegramSentAt = new Date();
        await markSignalSent(signal.id, telegramSentAt);
        logSignalDeliveryTrace(signal, telegramSentAt);
        console.log(`[tg-bot] sent alert for signal ${signal.id}`);
      }

      if (signal.type === "HIGH_INTEREST_TOKEN") {
        await sendFollowedHighInterestAlerts(signal);
      }
    }
  } catch (err) {
    console.error("[tg-bot] signal poll error:", formatErrorForLog(err, token));
  }
}

async function notifyExecutionOrder(order: ExecutionOrder): Promise<void> {
  if (order.status === "submitted" && !order.submitted_notified_at) {
    const sent = await sendOwnerAlert({
      ...formatBuySubmitted(order),
      context: `execution order submitted ${order.id}`,
    });
    if (sent) {
      await markOrderNotificationSent(order.id, "submitted");
    }
    return;
  }

  if (order.status === "confirmed" && !order.confirmed_notified_at) {
    const sent = await sendOwnerAlert({
      ...formatBuyConfirmed(order),
      context: `execution order confirmed ${order.id}`,
    });
    if (sent) {
      await markOrderNotificationSent(order.id, "confirmed");
    }
    return;
  }

  if (order.status === "failed" && !order.failed_notified_at) {
    const sent = await sendOwnerAlert({
      ...formatBuyFailed(order),
      context: `execution order failed ${order.id}`,
    });
    if (sent) {
      await markOrderNotificationSent(order.id, "failed");
    }
  }
}

async function notifyExitOrder(exit: ExitOrder): Promise<void> {
  if (exit.status === "submitted" && !exit.submitted_notified_at) {
    const sent = await sendOwnerAlert({
      ...formatExitSubmitted(exit),
      context: `exit order submitted ${exit.id}`,
    });
    if (sent) {
      await markExitOrderNotificationSent(exit.id, "submitted");
    }
    return;
  }

  if (exit.status === "confirmed" && !exit.confirmed_notified_at) {
    const sent = await sendOwnerAlert({
      ...formatExitConfirmed(exit),
      context: `exit order confirmed ${exit.id}`,
    });
    if (sent) {
      await markExitOrderNotificationSent(exit.id, "confirmed");
    }
    return;
  }

  if (exit.status === "failed" && !exit.failed_notified_at) {
    const sent = await sendOwnerAlert({
      ...formatExitFailed(exit),
      context: `exit order failed ${exit.id}`,
    });
    if (sent) {
      await markExitOrderNotificationSent(exit.id, "failed");
    }
  }
}

async function pollExecutionOrders(): Promise<void> {
  try {
    const orders = await listUnnotifiedExecutionOrders();
    for (const order of orders) {
      await notifyExecutionOrder(order);
    }

    const exits = await listUnnotifiedExitOrders();
    for (const exit of exits) {
      await notifyExitOrder(exit);
    }
  } catch (err) {
    console.error("[tg-bot] error polling execution orders:", formatErrorForLog(err, token));
  }

  setTimeout(pollExecutionOrders, 5_000);
}

setInterval(() => {
  pollSignals().catch((err) => {
    console.error("[tg-bot] unhandled signal poll error:", formatErrorForLog(err, token));
  });
}, SIGNAL_POLL_INTERVAL_MS);

Promise.all([pollSignals(), pollExecutionOrders()]).catch((err) => {
  console.error("[tg-bot] unhandled initial poll error:", formatErrorForLog(err, token));
});

console.log("[tg-bot] running - polling for updates and signals...");
