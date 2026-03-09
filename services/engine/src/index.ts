import "dotenv/config";
import { runEngine } from "./engine";

if (!process.env.DATABASE_URL) {
  console.error("[engine] DATABASE_URL is not set. Exiting.");
  process.exit(1);
}

console.log("[engine] starting Pulse engine service…");

async function init() {
  const stop = await runEngine();

  process.on("SIGINT", () => {
    console.log("\n[engine] shutting down…");
    stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

init().catch((err) => {
  console.error("[engine] failed to start:", err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
