import { FormattedAlert } from "./alertSender";

export interface SignalLike {
  type: string;
  wallet_address: string | null;
  token_mint: string | null;
  signature: string;
  slot: number;
  payload: Record<string, unknown>;
  created_at: Date | string;
  chain_time?: Date | string | null;
}

export interface WalletProfileSummary {
  tier: "low" | "medium" | "high";
  score: number;
}

export interface ActorSummary {
  id: string;
  tier: "low" | "medium" | "high";
  wallet_count: number;
}

export interface ExecutionOrderLike {
  token_mint: string;
  candidate_score: number | null;
  amount_sol: string;
  tx_signature: string | null;
  error_message: string | null;
}

export interface ExitOrderLike {
  token_mint: string;
  reason: string;
  sell_percentage: number;
  tx_signature: string | null;
  error_message: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function primarySignalTime(
  signal: SignalLike,
): { label: "Chain Time" | "Observed At"; value: Date } {
  const payload = asRecord(signal.payload);
  const trace = asRecord(payload.trace);
  const chainTime =
    parseDate(signal.chain_time) ?? parseDate(asString(trace.chain_time));

  if (chainTime) {
    return { label: "Chain Time", value: chainTime };
  }

  return {
    label: "Observed At",
    value: parseDate(signal.created_at) ?? new Date(signal.created_at),
  };
}


/** Convert raw lamports to a human SOL string e.g. "28.13 SOL". Returns null if missing or zero. */
function lamportsToSol(lamports: string | number | null | undefined): string | null {
  if (lamports === null || lamports === undefined) return null;
  const n = typeof lamports === "string" ? parseFloat(lamports) : lamports;
  if (isNaN(n) || n <= 0) return null;
  return (n / 1e9).toFixed(2) + " SOL";
}

/** Map a numeric score to a plain-English confidence label. */
function scoreToLabel(score: number | string | null | undefined): string {
  if (score === null || score === undefined) return "Unknown";
  const n = typeof score === "string" ? parseFloat(score) : score;
  if (isNaN(n)) return "Unknown";
  if (n >= 80) return "Very High";
  if (n >= 60) return "High";
  if (n >= 40) return "Medium";
  return "Low";
}

/** Shorten a long mint address for inline display: first 8 + "…" + last 4. */
function shortMint(mint: string): string {
  if (mint.length <= 16) return mint;
  return mint.slice(0, 8) + "…" + mint.slice(-4);
}

/** Format a Date as "Mar 11, 12:44 PM UTC". Falls back to ISO string on error. */
function formatTimeUtc(date: Date): string {
  try {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

export function formatAlphaWalletBuySignal(
  signal: SignalLike,
  walletProfile?: WalletProfileSummary | null,
  actor?: ActorSummary | null,
): FormattedAlert {
  const payload = asRecord(signal.payload);
  const label = asString(payload.label);
  const walletDisplay = signal.wallet_address
    ? `${shortMint(signal.wallet_address)}${label ? ` (${label})` : ""}`
    : "unknown";

  const lines: string[] = [
    "👀 Watched whale wallet just bought",
    "",
    `Wallet: ${walletDisplay}`,
  ];

  if (walletProfile && walletProfile.tier !== "low") {
    lines.push(`Whale quality: ${scoreToLabel(walletProfile.score)}`);
  }

  if (actor) {
    const actorQuality = actor.tier === "high" ? "High" : actor.tier === "medium" ? "Medium" : "Low";
    lines.push(`Part of a cluster of ${actor.wallet_count} whale wallets (quality: ${actorQuality})`);
  }

  if (signal.token_mint) {
    lines.push(``, `Token: ${signal.token_mint}`, `→ https://solscan.io/token/${signal.token_mint}`);
  }

  lines.push(`Tx: https://solscan.io/tx/${signal.signature}`);

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatNewMintSignal(signal: SignalLike): FormattedAlert {
  const time = primarySignalTime(signal);
  const isRestream = signal.signature.startsWith("restream_");
  const mint = signal.token_mint ?? "unknown";

  const lines = [
    "🆕 New token just launched on Bags",
    "",
    `Mint: ${mint}`,
    `Launched: ${formatTimeUtc(time.value)}`,
  ];

  if (signal.token_mint) {
    lines.push(``, `→ https://solscan.io/token/${signal.token_mint}`);
  }

  if (!isRestream) {
    lines.push(`Tx: https://solscan.io/tx/${signal.signature}`);
  }

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatLiquidityLiveSignal(signal: SignalLike): FormattedAlert {
  const payload = asRecord(signal.payload);
  const dev = asRecord(payload.dev);
  const time = primarySignalTime(signal);
  const mint = signal.token_mint ?? "unknown";

  const lines = [
    "💧 Liquidity just went live",
    "",
    `Token: ${mint}`,
    `Time: ${formatTimeUtc(time.value)}`,
  ];

  const probableDev = asString(dev.probable_dev_wallet);
  if (probableDev) {
    const launches = toText(dev.launch_count) ?? "0";
    const liquidityWins = toText(dev.liquidity_live_count) ?? "0";
    const confidence = toText(dev.confidence);
    lines.push(
      ``,
      `Dev wallet: ${shortMint(probableDev)}`,
      `Past launches: ${launches}  ·  ${liquidityWins} reached liquidity`,
    );
    if (confidence) lines.push(`Dev confidence: ${confidence.charAt(0).toUpperCase() + confidence.slice(1)}`);
  }

  if (signal.token_mint) {
    lines.push(``, `→ https://solscan.io/token/${signal.token_mint}`);
  }
  lines.push(`Tx: https://solscan.io/tx/${signal.signature}`);

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatBagsEnrichmentResolvedSignal(signal: SignalLike): FormattedAlert {
  const payload = asRecord(signal.payload);
  const creatorDisplay = asString(payload.primary_creator_display_name);
  const creatorWallet = asString(payload.primary_creator_wallet);
  const creatorProvider = asString(payload.primary_creator_provider);
  const feesLamports = toText(payload.fees_lamports);
  const mint = signal.token_mint ?? "unknown";

  const identity = creatorDisplay ?? (creatorWallet ? shortMint(creatorWallet) : null);
  const creatorLine = identity
    ? `${identity}${creatorProvider ? ` · ${creatorProvider}` : ""}`
    : null;
  const feesLine = lamportsToSol(feesLamports);

  const header = creatorLine ? "👤 Creator identified" : "📋 Token context resolved";

  const lines = [
    header,
    "",
    `Token: ${mint}`,
  ];

  if (creatorLine) lines.push(`Creator: ${creatorLine}`);
  if (feesLine) lines.push(`Fees earned: ${feesLine}`);

  if (signal.token_mint) {
    lines.push(``, `→ https://solscan.io/token/${signal.token_mint}`);
  }

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatHighInterestSignal(
  signal: SignalLike,
  walletProfile?: WalletProfileSummary | null,
  actor?: ActorSummary | null,
): FormattedAlert {
  const payload = asRecord(signal.payload);
  const triggers = asRecord(payload.triggers);
  const score = toText(payload.score);
  const mint = signal.token_mint ?? "unknown";

  // Build plain-English "why" line
  const whyParts: string[] = [];
  if (asBool(triggers.alpha)) whyParts.push("tracked whale wallet bought early");
  if (asBool(triggers.liquidity)) whyParts.push("liquidity is live");
  if (asBool(triggers.dev)) whyParts.push("dev has prior launch history");
  const whyLine = whyParts.length > 0 ? whyParts.join(" · ") : "multiple signals fired";

  const lines = [
    "🔥 Strong signal detected",
    "",
    `Token: ${mint}`,
    `Confidence: ${scoreToLabel(score)}`,
    `Why: ${whyLine}`,
  ];

  const bagsCreatorDisplay = asString(payload.primary_creator_display_name);
  const bagsCreatorProvider = asString(payload.primary_creator_provider);
  const bagsFees = toText(payload.fees_lamports);
  const feesLine = lamportsToSol(bagsFees);

  if (bagsCreatorDisplay) {
    lines.push(`Creator: ${bagsCreatorDisplay}${bagsCreatorProvider ? ` · ${bagsCreatorProvider}` : ""}`);
  }
  if (feesLine) lines.push(`Creator fees earned: ${feesLine}`);

  const alphaWallet = asString(payload.alpha_wallet);
  const devWallet = asString(payload.dev_wallet);
  const devLaunches = toText(payload.dev_launches);
  const devLiqSuccess = toText(payload.dev_liquidity_success);

  if (alphaWallet) {
    const walletLine = walletProfile
      ? `${shortMint(alphaWallet)} (quality: ${scoreToLabel(walletProfile.score)})`
      : shortMint(alphaWallet);
    lines.push(`Whale wallet: ${walletLine}`);
  }
  if (actor) {
    lines.push(`Part of a cluster of ${actor.wallet_count} whale wallets`);
  }
  if (devWallet) {
    const devDetail = devLaunches
      ? ` · ${devLaunches} launches, ${devLiqSuccess ?? "0"} reached liquidity`
      : "";
    lines.push(`Dev wallet: ${shortMint(devWallet)}${devDetail}`);
  }

  if (signal.token_mint) {
    lines.push(``, `→ https://solscan.io/token/${signal.token_mint}`);
    lines.push(`Use /check ${signal.token_mint} for full details`);
  }

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatUnknownSignal(signal: SignalLike): FormattedAlert {
  const lines = [
    "SIGNAL PAYLOAD",
    JSON.stringify(signal.payload, null, 2),
    `Tx: https://solscan.io/tx/${signal.signature}`,
  ];
  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatBuySubmitted(order: ExecutionOrderLike): FormattedAlert {
  const lines = [
    "BUY SUBMITTED",
    `Mint: ${order.token_mint}`,
    `Score: ${order.candidate_score ?? "N/A"}`,
    `Amount: ${order.amount_sol} SOL`,
    `Tx: ${order.tx_signature ?? "unknown"}`,
  ];
  return { text: lines.join("\n"), format: "plain" };
}

export function formatBuyConfirmed(order: ExecutionOrderLike): FormattedAlert {
  const lines = [
    "BUY CONFIRMED",
    `Mint: ${order.token_mint}`,
    `Tx: https://solscan.io/tx/${order.tx_signature ?? ""}`,
  ];
  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatBuyFailed(order: ExecutionOrderLike): FormattedAlert {
  const lines = [
    "BUY FAILED",
    `Mint: ${order.token_mint}`,
    `Reason: ${order.error_message ?? "Unknown error"}`,
  ];
  return { text: lines.join("\n"), format: "plain" };
}

export function formatExitSubmitted(exit: ExitOrderLike): FormattedAlert {
  const lines = [
    "EXIT SUBMITTED",
    `Mint: ${exit.token_mint}`,
    `Reason: ${exit.reason}`,
    `Percentage: ${exit.sell_percentage}%`,
    `Tx: ${exit.tx_signature ?? "unknown"}`,
  ];
  return { text: lines.join("\n"), format: "plain" };
}

export function formatExitConfirmed(exit: ExitOrderLike): FormattedAlert {
  const lines = [
    "EXIT CONFIRMED",
    `Mint: ${exit.token_mint}`,
    `Reason: ${exit.reason}`,
    `Percentage: ${exit.sell_percentage}%`,
    `Tx: https://solscan.io/tx/${encodeURIComponent(exit.tx_signature ?? "")}`,
  ];
  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatExitFailed(exit: ExitOrderLike): FormattedAlert {
  const lines = [
    "EXIT FAILED",
    `Mint: ${exit.token_mint}`,
    `Reason: ${exit.reason}`,
    `Error: ${exit.error_message ?? "Unknown error"}`,
  ];
  return { text: lines.join("\n"), format: "plain" };
}

/** One row for top-candidates digest (score + optional Bags context). */
export interface TopCandidateDigestRow {
  mint: string;
  score: number;
  metadata: Record<string, unknown> | null;
  alpha_wallet_trigger: boolean;
  liquidity_live_trigger: boolean;
  dev_trigger: boolean;
  primary_creator_display_name: string | null;
  primary_creator_provider: string | null;
  fees_lamports: string | null;
}

/**
 * Format ranked digest of top HIGH_INTEREST tokens for Telegram (plain text).
 */
export function formatTopCandidatesDigest(
  rows: TopCandidateDigestRow[],
  opts: { title?: string; freshnessHours?: number } = {},
): FormattedAlert {
  const freshness = opts.freshnessHours ?? 24;
  const lines: string[] = [`🔥 Top tokens right now (last ${freshness}h)`, ""];

  if (rows.length === 0) {
    lines.push("No strong signals in the last " + freshness + " hours.");
    return { text: lines.join("\n"), format: "plain" };
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rank = i + 1;

    const why: string[] = [];
    if (r.liquidity_live_trigger) why.push("liquidity live");
    if (r.alpha_wallet_trigger) why.push("tracked whale wallet bought");
    if (r.dev_trigger) why.push("dev history");
    const whyStr = why.length ? why.join(" · ") : "signals fired";

    const creator = r.primary_creator_display_name
      ? `${r.primary_creator_display_name}${r.primary_creator_provider ? ` · ${r.primary_creator_provider}` : ""}`
      : null;

    const feesLine = lamportsToSol(r.fees_lamports);

    lines.push(`${rank}. ${shortMint(r.mint)}`);
    lines.push(`   Confidence: ${scoreToLabel(r.score)}  ·  Why: ${whyStr}`);
    if (creator) lines.push(`   Creator: ${creator}`);
    if (feesLine) lines.push(`   Creator fees: ${feesLine}`);
    lines.push("");
  }

  return { text: lines.join("\n").trimEnd(), format: "plain", disableWebPagePreview: true };
}

export interface MintSummaryView {
  mint: string;
  foundInDb: boolean;
  score: number | null;
  bagsBonus: number | null;
  primaryCreatorDisplayName: string | null;
  primaryCreatorProvider: string | null;
  feesLamports: string | null;
  hasHighInterestSignal: boolean;
}

export function formatMintSummary(summary: MintSummaryView): FormattedAlert {
  if (!summary.foundInDb) {
    return {
      text: [
        "Token not found in our database.",
        "",
        `Mint: ${summary.mint}`,
        "",
        "This token may have launched before Pulse was running, or has not been seen yet.",
      ].join("\n"),
      format: "plain",
    };
  }

  const creator = summary.primaryCreatorDisplayName
    ? `${summary.primaryCreatorDisplayName}${summary.primaryCreatorProvider ? ` · ${summary.primaryCreatorProvider}` : ""}`
    : "Not identified yet";

  const feesLine = lamportsToSol(summary.feesLamports) ?? "Not available";
  const confidenceLabel = scoreToLabel(summary.score);
  const strongSignal = summary.hasHighInterestSignal ? "Yes — this token fired a strong signal" : "No";

  const lines = [
    "Token check",
    "",
    `Mint: ${summary.mint}`,
    `Confidence: ${confidenceLabel}`,
    `Strong signal: ${strongSignal}`,
    `Creator: ${creator}`,
    `Creator fees earned: ${feesLine}`,
    ``,
    `→ https://solscan.io/token/${summary.mint}`,
  ];

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatFollowedHighInterestAlert(signal: SignalLike): FormattedAlert {
  const payload = asRecord(signal.payload);
  const triggers = asRecord(payload.triggers);
  const score = toText(payload.score);
  const creatorDisplay = asString(payload.primary_creator_display_name);
  const creatorProvider = asString(payload.primary_creator_provider);
  const feesLamports = toText(payload.fees_lamports);
  const mint = signal.token_mint ?? "unknown";

  const whyParts: string[] = [];
  if (asBool(triggers.alpha)) whyParts.push("tracked whale wallet bought early");
  if (asBool(triggers.liquidity)) whyParts.push("liquidity is live");
  if (asBool(triggers.dev)) whyParts.push("dev has prior history");
  const whyLine = whyParts.length > 0 ? whyParts.join(" · ") : "multiple signals fired";

  const lines = [
    "🔔 Update on a token you follow",
    "",
    `Token: ${mint}`,
    `Confidence: ${scoreToLabel(score)}`,
    `Why: ${whyLine}`,
  ];

  if (creatorDisplay) {
    lines.push(`Creator: ${creatorDisplay}${creatorProvider ? ` · ${creatorProvider}` : ""}`);
  }
  const feesLine = lamportsToSol(feesLamports);
  if (feesLine) lines.push(`Creator fees earned: ${feesLine}`);

  if (signal.token_mint) {
    lines.push(``, `→ https://solscan.io/token/${signal.token_mint}`);
  }

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}
