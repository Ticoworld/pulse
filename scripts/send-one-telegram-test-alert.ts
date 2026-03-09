/**
 * One-off: prove one real Telegram send through the same path the bot uses.
 * Run: npx ts-node -r dotenv/config -r tsconfig-paths/register --project apps/tg-bot/tsconfig.json scripts/send-one-telegram-test-alert.ts
 * Requires: TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID
 */
import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIdRaw = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatIdRaw) {
    console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_OWNER_CHAT_ID not set.");
    process.exit(1);
  }
  const ownerChatId = parseInt(chatIdRaw, 10);
  if (Number.isNaN(ownerChatId)) {
    console.error("TELEGRAM_OWNER_CHAT_ID must be a number.");
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: false });
  const text = "[Pulse runtime closure] One real send proof at " + new Date().toISOString();

  console.log("[send-one-telegram-test-alert] sending to owner chat " + ownerChatId + "...");
  await bot.sendMessage(ownerChatId, text, { disable_web_page_preview: true });
  console.log("[send-one-telegram-test-alert] sent successfully.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
