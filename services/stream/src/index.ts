import "dotenv/config";
import { HeliusProvider } from "./providers/helius";
import { processSignature } from "./stream";

const apiKey = process.env.HELIUS_API_KEY;

if (!apiKey) {
  console.error("[stream] HELIUS_API_KEY is not set. Exiting.");
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("[stream] DATABASE_URL is not set. Exiting.");
  process.exit(1);
}

console.log("[stream] starting Pulse stream service…");

const provider = new HeliusProvider(apiKey, (signature) => {
  processSignature(signature).catch((err) =>
    console.error("[stream] unhandled error in processSignature:", err),
  );
});

provider.start();

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[stream] shutting down…");
  provider.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  provider.stop();
  process.exit(0);
});
