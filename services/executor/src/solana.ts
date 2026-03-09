/**
 * Minimal Solana execution wrapper stub.
 */

export async function quoteAndBuildBuyTx(
  tokenMint: string,
  amountSol: number,
  maxSlippageBps: number,
  paperTrading: boolean,
): Promise<{ txData: string; priorityFeeLamports: number }> {
  if (paperTrading) {
    // In paper mode, we pretend we built a transaction
    return {
      txData: "simulated_base64_tx_data",
      priorityFeeLamports: 100000,
    };
  }

  // Real mode - no route integration yet
  throw new Error("Route integration not implemented");
}

export async function quoteAndBuildSellTx(
  tokenMint: string,
  sellPercentage: number,
  maxSlippageBps: number,
  paperTrading: boolean,
): Promise<{ txData: string; priorityFeeLamports: number }> {
  if (paperTrading) {
    return {
      txData: "simulated_sell_base64_tx_data",
      priorityFeeLamports: 100000,
    };
  }

  throw new Error("Sell route integration not implemented");
}

export async function sendSignedTransaction(
  txData: string,
  paperTrading: boolean,
): Promise<string> {
  if (paperTrading) {
    return `sim_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  throw new Error("Route integration not implemented");
}

export async function confirmTransaction(
  txSignature: string,
  paperTrading: boolean,
): Promise<boolean> {
  if (paperTrading) {
    // Simulate some block time and return success
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return true;
  }

  throw new Error("Route integration not implemented");
}
