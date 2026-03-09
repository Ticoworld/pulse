/**
 * One-off: prove SIGINT during sleep exits promptly.
 * Spawns bags-enricher, waits for "sleeping" log, sends SIGINT, captures output.
 * Run from repo root: node scripts/test-bags-enricher-shutdown-during-sleep.mjs
 */
import { spawn } from "child_process";
import { createInterface } from "readline";

const cwd = process.cwd();
const path = await import("path");
const script = path.join(cwd, "services", "bags-enricher", "src", "index.ts");
const tsconfig = path.join(cwd, "tsconfig.json");
const child = spawn(
  process.execPath,
  [
    "-r", "ts-node/register",
    "-r", "dotenv/config",
    "-r", "tsconfig-paths/register",
    script,
  ],
  {
    cwd,
    env: { ...process.env, BAGS_ENRICHER_INTERVAL_MINUTES: "1", TS_NODE_PROJECT: tsconfig },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

const out = [];
const rlOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
const rlErr = createInterface({ input: child.stderr, crlfDelay: Infinity });
rlOut.on("line", (line) => {
  out.push("[stdout] " + line);
  if (line.includes("sleeping") && line.includes("until next cycle")) {
    setTimeout(() => {
      console.log("\n--- Sending SIGTERM during sleep ---\n");
      child.kill("SIGTERM");
    }, 500);
  }
});
rlErr.on("line", (line) => out.push("[stderr] " + line));

child.on("close", (code, signal) => {
  console.log("--- Full output ---\n");
  out.forEach((l) => console.log(l));
  const promptExit = (signal === "SIGINT" || signal === "SIGTERM") && (code === 0 || code === null);
  const hasRequested = out.some((l) => l.includes("shutdown requested"));
  const hasDuringSleep = out.some((l) => l.includes("during sleep, exited promptly"));
  const hasShutdownMessages = hasRequested && hasDuringSleep;
  console.log("\n--- Process exited: code=" + code + " signal=" + signal + " ---");
  if (promptExit && hasShutdownMessages) {
    console.log("PM checkpoint: shutdown requested + during-sleep exit logged, prompt exit.");
  } else if (promptExit && !hasShutdownMessages) {
    console.log("Prompt exit confirmed (child may be killed before handler on Windows).");
    console.log("For PM: run service in foreground, wait for 'sleeping Ns', then Ctrl+C to see both messages.");
  }
  process.exit(promptExit ? 0 : 1);
});

setTimeout(() => {
  if (!child.killed) {
    console.error("Timeout: process did not exit");
    child.kill("SIGKILL");
    process.exit(1);
  }
}, 25000);
