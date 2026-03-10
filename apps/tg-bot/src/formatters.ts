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

function actorPreview(actorId: string): string {
  return actorId.split("-")[0];
}

export function formatAlphaWalletBuySignal(
  signal: SignalLike,
  walletProfile?: WalletProfileSummary | null,
  actor?: ActorSummary | null,
): FormattedAlert {
  const payload = asRecord(signal.payload);
  const lines: string[] = [
    "ALPHA WALLET BUY",
    `Wallet: ${signal.wallet_address ?? "unknown"}${asString(payload.label) ? ` (${asString(payload.label)})` : ""}`,
  ];

  if (walletProfile && walletProfile.tier !== "low") {
    lines.push(`Quality: ${walletProfile.tier.toUpperCase()} (Score: ${walletProfile.score})`);
  }

  if (actor) {
    lines.push(
      `Actor: ${actorPreview(actor.id)} (wallet cluster)`,
      `Actor Tier: ${actor.tier.toUpperCase()}`,
      `Cluster Size: ${actor.wallet_count} wallets`,
    );
  }

  if (signal.token_mint) lines.push(`Mint: ${signal.token_mint}`);
  const amount = toText(payload.amount);
  if (amount) lines.push(`Amount: ${amount}`);
  lines.push(`Slot: ${signal.slot}`, `Tx: https://solscan.io/tx/${signal.signature}`);

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatNewMintSignal(signal: SignalLike): FormattedAlert {
  const time = primarySignalTime(signal);
  const lines = [
    "NEW MINT SEEN",
    `Mint: ${signal.token_mint ?? "unknown"}`,
    `Slot: ${signal.slot}`,
    `${time.label}: ${time.value.toLocaleString()}`,
    `Tx: https://solscan.io/tx/${signal.signature}`,
  ];

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatLiquidityLiveSignal(signal: SignalLike): FormattedAlert {
  const payload = asRecord(signal.payload);
  const dev = asRecord(payload.dev);
  const time = primarySignalTime(signal);
  const lines = [
    "LIQUIDITY LIVE",
    `Mint: ${signal.token_mint ?? "unknown"}`,
  ];

  const probableDev = asString(dev.probable_dev_wallet);
  if (probableDev) {
    lines.push(
      `Dev: ${probableDev}`,
      `Dev confidence: ${toText(dev.confidence) ?? "unknown"}`,
      `Dev launches: ${toText(dev.launch_count) ?? "0"}`,
      `Dev liquidity success: ${toText(dev.liquidity_live_count) ?? "0"}`,
    );
  }

  lines.push(
    `Slot: ${signal.slot}`,
    `${time.label}: ${time.value.toLocaleString()}`,
    `Tx: https://solscan.io/tx/${signal.signature}`,
  );

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatBagsEnrichmentResolvedSignal(signal: SignalLike): FormattedAlert {
  const payload = asRecord(signal.payload);
  const creatorDisplay = asString(payload.primary_creator_display_name);
  const creatorWallet = asString(payload.primary_creator_wallet);
  const creatorProvider = asString(payload.primary_creator_provider);
  const feesLamports = toText(payload.fees_lamports);
  const status = asString(payload.enrichment_status) ?? "resolved";

  const lines = [
    "BAGS RESOLVED CONTEXT",
    `Mint: ${signal.token_mint ?? "unknown"}`,
    `Status: ${status}`,
  ];

  if (creatorDisplay || creatorWallet) {
    const identity = creatorDisplay ?? creatorWallet ?? "unknown";
    lines.push(`Creator: ${identity}${creatorProvider ? ` (${creatorProvider})` : ""}`);
  }

  if (feesLamports) {
    lines.push(`Fees (lamports): ${feesLamports}`);
  }

  return { text: lines.join("\n"), format: "plain" };
}

export function formatHighInterestSignal(
  signal: SignalLike,
  walletProfile?: WalletProfileSummary | null,
  actor?: ActorSummary | null,
): FormattedAlert {
  const payload = asRecord(signal.payload);
  const triggers = asRecord(payload.triggers);
  const lines = [
    "HIGH INTEREST TOKEN",
    `Mint: ${signal.token_mint ?? "unknown"}`,
    `Score: ${toText(payload.score) ?? "unknown"}`,
    "Signals:",
  ];

  if (asBool(triggers.liquidity)) lines.push("- Liquidity Live");
  if (asBool(triggers.alpha)) lines.push("- Alpha Wallet Buy");
  if (asBool(triggers.dev)) lines.push("- Dev History");
  if (lines[lines.length - 1] === "Signals:") {
    lines.push("- none");
  }

  if (walletProfile) {
    lines.push(`Alpha Quality: ${walletProfile.tier.toUpperCase()} (Score: ${walletProfile.score})`);
  }

  if (actor) {
    lines.push(
      `Actor: ${actorPreview(actor.id)} (wallet cluster)`,
      `Actor Tier: ${actor.tier.toUpperCase()}`,
      `Cluster Size: ${actor.wallet_count} wallets`,
    );
  }

  const alphaWallet = asString(payload.alpha_wallet);
  const devWallet = asString(payload.dev_wallet);
  if (alphaWallet) lines.push(`Alpha Wallet: ${alphaWallet}`);
  if (devWallet) lines.push(`Dev: ${devWallet}`);

  const devLaunches = toText(payload.dev_launches);
  const devLiquiditySuccess = toText(payload.dev_liquidity_success);
  if (devLaunches) lines.push(`Dev launches: ${devLaunches}`);
  if (devLiquiditySuccess) lines.push(`Dev liquidity success: ${devLiquiditySuccess}`);

  const bagsBonus = toText(payload.bags_bonus);
  const bagsReasons = Array.isArray(payload.bags_reasons)
    ? payload.bags_reasons.map((x) => toText(x)).filter((x): x is string => Boolean(x))
    : [];
  const bagsCreatorDisplay = asString(payload.primary_creator_display_name);
  const bagsCreatorProvider = asString(payload.primary_creator_provider);
  const bagsFees = toText(payload.fees_lamports);
  const hasBagsContext = bagsBonus !== null || bagsReasons.length > 0 || bagsCreatorDisplay !== null || bagsFees !== null;

  if (hasBagsContext) {
    lines.push("Bags Context:");
    lines.push(`- Bonus: ${bagsBonus ?? "0"}`);
    if (bagsReasons.length > 0) lines.push(`- Reasons: ${bagsReasons.join(", ")}`);
    if (bagsCreatorDisplay) {
      lines.push(`- Creator: ${bagsCreatorDisplay}${bagsCreatorProvider ? ` (${bagsCreatorProvider})` : ""}`);
    }
    if (bagsFees) lines.push(`- Fees (lamports): ${bagsFees}`);
  }

  lines.push(`Token: https://solscan.io/token/${signal.token_mint ?? ""}`);

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
 * Format ranked digest of top HIGH_INTEREST candidates for Telegram (plain text).
 * Shows rank, mint, final/base score, Bags bonus, triggers, creator, fees. Compact.
 */
export function formatTopCandidatesDigest(
  rows: TopCandidateDigestRow[],
  opts: { title?: string; freshnessHours?: number } = {},
): FormattedAlert {
  const title = opts.title ?? "Top HIGH_INTEREST candidates";
  const freshness = opts.freshnessHours ?? 24;
  const lines: string[] = [`${title} (last ${freshness}h, by score)`, ""];

  if (rows.length === 0) {
    lines.push("No HIGH_INTEREST candidates in freshness window.");
    return { text: lines.join("\n"), format: "plain" };
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rank = i + 1;
    const meta = asRecord(r.metadata ?? {});
    const baseScore = toText(meta.base_score) ?? "-";
    const bagsBonus = toText(meta.bags_bonus) ?? "0";
    const triggers: string[] = [];
    if (r.liquidity_live_trigger) triggers.push("liq");
    if (r.alpha_wallet_trigger) triggers.push("alpha");
    if (r.dev_trigger) triggers.push("dev");
    const triggerStr = triggers.length ? triggers.join(",") : "-";
    const bagsReasons = Array.isArray(meta.bags_reasons)
      ? (meta.bags_reasons as unknown[]).map((x) => toText(x)).filter((x): x is string => Boolean(x))
      : [];
    const bagsStr = bagsReasons.length ? bagsReasons.join(",") : "-";
    const creator = r.primary_creator_display_name ?? null;
    const creatorStr = creator
      ? `${creator}${r.primary_creator_provider ? ` (${r.primary_creator_provider})` : ""}`
      : "-";
    const feesStr = r.fees_lamports ?? "-";

    lines.push(
      `${rank}. ${r.mint}`,
      `   score=${r.score} base=${baseScore} bags=${bagsBonus} | ${triggerStr} | bags: ${bagsStr}`,
      `   creator: ${creatorStr} | fees: ${feesStr}`,
      "",
    );
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
      text: `No DB record found for mint ${summary.mint}.`,
      format: "plain",
    };
  }

  const creator = summary.primaryCreatorDisplayName
    ? `${summary.primaryCreatorDisplayName}${summary.primaryCreatorProvider ? ` (${summary.primaryCreatorProvider})` : ""}`
    : "-";

  const lines = [
    "MINT SUMMARY",
    `Mint: ${summary.mint}`,
    `Latest candidate score: ${summary.score ?? "-"}`,
    `Bags bonus: ${summary.bagsBonus ?? "-"}`,
    `Creator: ${creator}`,
    `Fees (lamports): ${summary.feesLamports ?? "-"}`,
    `HIGH_INTEREST signal: ${summary.hasHighInterestSignal ? "yes" : "no"}`,
  ];

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}

export function formatFollowedHighInterestAlert(signal: SignalLike): FormattedAlert {
  const payload = asRecord(signal.payload);
  const triggers = asRecord(payload.triggers);
  const score = toText(payload.score) ?? "unknown";
  const bagsBonus = toText(payload.bags_bonus) ?? "0";
  const creatorDisplay = asString(payload.primary_creator_display_name);
  const creatorProvider = asString(payload.primary_creator_provider);
  const feesLamports = toText(payload.fees_lamports);

  const triggerParts: string[] = [];
  if (asBool(triggers.liquidity)) triggerParts.push("liquidity");
  if (asBool(triggers.alpha)) triggerParts.push("alpha");
  if (asBool(triggers.dev)) triggerParts.push("dev");
  const triggerSummary = triggerParts.length > 0 ? triggerParts.join(", ") : "none";

  const lines = [
    "FOLLOWED MINT ALERT",
    `Mint: ${signal.token_mint ?? "unknown"}`,
    `Score: ${score} | Bags bonus: ${bagsBonus}`,
    `Triggers: ${triggerSummary}`,
  ];

  if (creatorDisplay) {
    lines.push(
      `Creator: ${creatorDisplay}${creatorProvider ? ` (${creatorProvider})` : ""}`,
    );
  }
  if (feesLamports) {
    lines.push(`Fees (lamports): ${feesLamports}`);
  }

  lines.push("Note: informational signal for a mint you follow.");

  return { text: lines.join("\n"), format: "plain", disableWebPagePreview: true };
}
