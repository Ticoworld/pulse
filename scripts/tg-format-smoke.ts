import {
  formatBagsEnrichmentResolvedSignal,
  formatBuyConfirmed,
  formatBuyFailed,
  formatBuySubmitted,
  formatExitConfirmed,
  formatExitFailed,
  formatExitSubmitted,
  formatHighInterestSignal,
  type SignalLike,
} from "../apps/tg-bot/src/formatters";

type SmokeCase = {
  name: string;
  format: string;
  text: string;
};

function printCase(testCase: SmokeCase): void {
  console.log(`\n=== ${testCase.name} ===`);
  console.log(`format: ${testCase.format}`);
  console.log(testCase.text);
}

const highInterestSignal: SignalLike = {
  type: "HIGH_INTEREST_TOKEN",
  wallet_address: "Wallet_Alpha*(unsafe)",
  token_mint: "Mint_Example_[unsafe]",
  signature: "sig_high_interest_123",
  slot: 123456,
  created_at: new Date(),
  payload: {
    score: 62,
    triggers: { liquidity: true, alpha: true, dev: true },
    alpha_wallet: "Wallet_Alpha*(unsafe)",
    dev_wallet: "Dev_Wallet_[unsafe]",
    dev_launches: 2,
    dev_liquidity_success: 1,
    bags_bonus: 2,
    bags_reasons: ["resolved_context", "creator_identity_present", "fees_nonzero"],
    primary_creator_display_name: "PublicFund_App*[unsafe]",
    primary_creator_provider: "twitter",
    fees_lamports: 369655050567,
  },
};

const bagsResolvedSignal: SignalLike = {
  type: "BAGS_ENRICHMENT_RESOLVED",
  wallet_address: null,
  token_mint: "Mint_Bags_[unsafe]",
  signature: "sig_bags_resolved_123",
  slot: 123457,
  created_at: new Date(),
  payload: {
    enrichment_status: "resolved",
    primary_creator_display_name: "Creator_[unsafe]*",
    primary_creator_provider: "twitter",
    fees_lamports: 123450000,
  },
};

const cases: SmokeCase[] = [
  {
    name: "HIGH_INTEREST_TOKEN",
    ...formatHighInterestSignal(highInterestSignal, { tier: "high", score: 88 }, {
      id: "actor-1234-5678",
      tier: "medium",
      wallet_count: 3,
    }),
  },
  {
    name: "BAGS_ENRICHMENT_RESOLVED",
    ...formatBagsEnrichmentResolvedSignal(bagsResolvedSignal),
  },
  {
    name: "BUY_SUBMITTED",
    ...formatBuySubmitted({
      token_mint: "Mint_Buy_[unsafe]",
      candidate_score: 61,
      amount_sol: "0.25",
      tx_signature: "tx_sig_[unsafe]",
      error_message: null,
    }),
  },
  {
    name: "BUY_CONFIRMED",
    ...formatBuyConfirmed({
      token_mint: "Mint_Buy_[unsafe]",
      candidate_score: 61,
      amount_sol: "0.25",
      tx_signature: "tx_sig_[unsafe]",
      error_message: null,
    }),
  },
  {
    name: "BUY_FAILED",
    ...formatBuyFailed({
      token_mint: "Mint_Buy_[unsafe]",
      candidate_score: 61,
      amount_sol: "0.25",
      tx_signature: null,
      error_message: "Route_[not_found]*",
    }),
  },
  {
    name: "EXIT_SUBMITTED",
    ...formatExitSubmitted({
      token_mint: "Mint_Exit_[unsafe]",
      reason: "time_stop_[unsafe]*",
      sell_percentage: 100,
      tx_signature: "exit_sig_[unsafe]",
      error_message: null,
    }),
  },
  {
    name: "EXIT_CONFIRMED",
    ...formatExitConfirmed({
      token_mint: "Mint_Exit_[unsafe]",
      reason: "time_stop_[unsafe]*",
      sell_percentage: 100,
      tx_signature: "exit_sig_[unsafe]",
      error_message: null,
    }),
  },
  {
    name: "EXIT_FAILED",
    ...formatExitFailed({
      token_mint: "Mint_Exit_[unsafe]",
      reason: "time_stop_[unsafe]*",
      sell_percentage: 100,
      tx_signature: null,
      error_message: "rpc_error_[unsafe]*",
    }),
  },
];

for (const testCase of cases) {
  printCase(testCase);
}
