import "dotenv/config";
import { ExecutorBot } from "./executor";
import { ExecutionConfig } from "./types";

const config: ExecutionConfig = {
  enabled: process.env.EXECUTOR_ENABLED === "true",
  paperTrading: process.env.PAPER_TRADING !== "false", // Defaults to true safely
  minScore: parseInt(process.env.EXECUTOR_MIN_SCORE || "70", 10),
  buyAmountSol: parseFloat(process.env.EXECUTOR_BUY_AMOUNT_SOL || "0.05"),
  maxSlippageBps: parseInt(process.env.EXECUTOR_MAX_SLIPPAGE_BPS || "1000", 10),
  pollIntervalMs: parseInt(process.env.EXECUTOR_POLL_INTERVAL_MS || "5000", 10),
};

const bot = new ExecutorBot(config);

bot.start().catch((err) => {
  console.error("Executor service fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("Shutting down executor...");
  bot.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down executor...");
  bot.stop();
  process.exit(0);
});
