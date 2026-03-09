import "dotenv/config";
import WebSocket from "ws";

const apiKey = process.env.HELIUS_API_KEY;
if (!apiKey) {
  console.error("❌ HELIUS_API_KEY is not set.");
  process.exit(1);
}

const network = process.env.HELIUS_NETWORK || "mainnet";
const explicitWs = process.env.HELIUS_WS_URL;

const baseUrl = explicitWs ? explicitWs : `wss://${network}.helius-rpc.com`;

// Remove trailing slash if present to avoid wss://...com//?api-key=
const cleanBaseUrl = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
const wsUrl = `${cleanBaseUrl}/?api-key=${apiKey}`;

const maskedUrl = wsUrl.replace(
  apiKey,
  `${apiKey.slice(0, 4)}***${apiKey.slice(-4)}`,
);

console.log(`[debug-ws] connecting to: ${maskedUrl}`);

const ws = new WebSocket(wsUrl);

ws.on("open", () => {
  console.log("✅ [debug-ws] WebSocket opened successfully!");
  console.log("   (If it stays open here, your key and URL are correct)");
  setTimeout(() => {
    console.log("[debug-ws] closing connection...");
    ws.close();
  }, 3000);
});

ws.on("error", (err) => {
  console.error("❌ [debug-ws] WebSocket error:", err.message);
});

ws.on("close", (code, reason) => {
  console.log(
    `[debug-ws] WebSocket closed. Code: ${code}, Reason: ${reason.toString() || "No reason"}`,
  );
});
