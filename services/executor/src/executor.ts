import {
  query,
  getCandidateSignalByMint,
  getActiveBuyOrderByMint,
  createExecutionOrder,
  markExecutionOrderSubmitted,
  markExecutionOrderConfirmed,
  markExecutionOrderFailed,
  getActorByWallet,
  getOpenPositionsCount,
  createPositionFromBuyOrder,
  getRecentlyClosedPositionByMint,
  listPendingExitOrders,
  markExitOrderSubmitted,
  markExitOrderConfirmed,
  markExitOrderFailed,
  markPositionClosed,
} from "@pulse/db";
import { RiskManager } from "./riskManager";
import { ExecutionConfig } from "./types";
import {
  quoteAndBuildBuyTx,
  quoteAndBuildSellTx,
  sendSignedTransaction,
  confirmTransaction,
} from "./solana";

export class ExecutorBot {
  private config: ExecutionConfig;
  private isRunning = false;
  private maxOpenPositions: number;
  private cooldownMinutes: number;
  private riskManager: RiskManager;

  constructor(
    config: ExecutionConfig & {
      maxOpenPositions?: number;
      cooldownMinutes?: number;
      timeStopMinutes?: number;
    },
  ) {
    this.config = config;
    this.maxOpenPositions = config.maxOpenPositions || 3;
    this.cooldownMinutes = config.cooldownMinutes || 60;

    this.riskManager = new RiskManager({
      enabled: config.enabled,
      timeStopMinutes:
        config.timeStopMinutes !== undefined ? config.timeStopMinutes : 30,
    });
  }

  public async start() {
    if (!this.config.enabled) {
      console.log(
        "[executor] EXECUTOR_ENABLED is false. Executor will not process trades.",
      );
      return;
    }

    console.log(
      `[executor] Started. Paper Trading: ${this.config.paperTrading}, Min Score: ${this.config.minScore}`,
    );

    this.isRunning = true;
    while (this.isRunning) {
      try {
        await this.poll();
      } catch (err) {
        console.error("[executor] Poll error:", err);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.pollIntervalMs),
      );
    }
  }

  public stop() {
    this.isRunning = false;
  }

  private async poll() {
    // 1. Evaluate open positions against risk rules
    await this.riskManager.evaluateOpenPositions();

    // 2. Poll pending exit orders
    const pendingExits = await listPendingExitOrders(50);
    for (const exit of pendingExits) {
      await this.processExitOrder(exit);
    }

    // 3. Poll unresolved HIGH_INTEREST_TOKEN signals.
    // For V1, we simply poll recent ones and explicitly check for duplicate execution_orders.
    const recentSignals = await query(
      `SELECT * FROM signals 
       WHERE type = 'HIGH_INTEREST_TOKEN' 
       ORDER BY created_at DESC 
       LIMIT 50`,
    );

    for (const row of recentSignals.rows) {
      await this.processCandidate(row);
    }
  }

  private async processCandidate(signalRow: any) {
    const mint = signalRow.token_mint;
    const payload = signalRow.payload;

    if (!mint) return;

    // 0. Check if we already processed this EXACT signal
    const existingForSignal = await query(
      `SELECT id FROM execution_orders WHERE signal_id = $1`,
      [signalRow.id],
    );
    if (existingForSignal.rowCount && existingForSignal.rowCount > 0) {
      return;
    }

    // 1. Check if we already have an active order for this mint
    const activeOrder = await getActiveBuyOrderByMint(mint);
    if (activeOrder) {
      // We already have a pending or submitted order. Skip.
      return;
    }

    // 2. Load the hard candidate_signals row explicitly for validation
    const candidate = await getCandidateSignalByMint(mint);
    if (!candidate) return;

    // 3. Strict Validation Gates
    if (!candidate.liquidity_live_trigger) {
      return;
    }

    const score = candidate.score;
    if (score < this.config.minScore) {
      return;
    }

    // Ignore explicitly mapped base mints (e.g., SOL, USDC)
    const IGNORE_MINTS = [
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ];
    if (IGNORE_MINTS.includes(mint)) {
      return;
    }

    // 4. RISK CONTROLS & CAPACITY
    // Check global capacity
    const openCount = await getOpenPositionsCount();
    if (openCount >= this.maxOpenPositions) {
      console.log(
        `[risk] max open positions (${this.maxOpenPositions}) reached. Skip mint=${mint}`,
      );
      return;
    }

    // Check cooldown window
    const recentClose = await getRecentlyClosedPositionByMint(
      mint,
      this.cooldownMinutes,
    );
    if (recentClose) {
      console.log(
        `[risk] recently closed position hit cooldown. Skip mint=${mint}`,
      );
      return;
    }

    // 5. Load Actor (if alpha wallet is known)
    let actorId: string | undefined = undefined;
    if (payload.alpha_wallet) {
      const actor = await getActorByWallet(payload.alpha_wallet);
      if (actor) {
        actorId = actor.id;
      }
    }

    // 5. Create Execution Order
    console.log(`[executor] candidate accepted mint=${mint} score=${score}`);

    const metadata: any = {
      signal_payload: payload,
    };

    if (this.config.paperTrading) {
      metadata.paper_trading = true;
    }

    // Try to create the order. If another instance sneaked in, the UNIQUE index will throw.
    let orderId: string;
    try {
      const order = await createExecutionOrder({
        tokenMint: mint,
        signalType: "HIGH_INTEREST_TOKEN",
        signalId: signalRow.id,
        candidateScore: score,
        alphaWallet: payload.alpha_wallet,
        probableDevWallet: payload.dev_wallet,
        actorId,
        side: "buy",
        amountSol: this.config.buyAmountSol,
        maxSlippageBps: this.config.maxSlippageBps,
        metadata,
      });
      orderId = order.id;
      console.log(`[executor] buy order created id=${orderId}`);
    } catch (e: any) {
      // Likely unique constraint violation from concurrent polling
      if (e.code === "23505") {
        return;
      }
      console.error(`[executor] Failed to create order for ${mint}:`, e);
      return;
    }

    // 6. Execute
    await this.executeBuy(orderId, mint);
  }

  private async executeBuy(orderId: string, mint: string) {
    try {
      // Stub integration: Route quote
      const { txData, priorityFeeLamports } = await quoteAndBuildBuyTx(
        mint,
        this.config.buyAmountSol,
        this.config.maxSlippageBps,
        this.config.paperTrading,
      );

      // Stub integration: Send tx
      const txSignature = await sendSignedTransaction(
        txData,
        this.config.paperTrading,
      );

      await markExecutionOrderSubmitted(
        orderId,
        txSignature,
        priorityFeeLamports,
      );
      console.log(
        `[executor] tx submitted sig=${txSignature} (paper=${this.config.paperTrading})`,
      );

      // Stub integration: Confirm tx
      const confirmed = await confirmTransaction(
        txSignature,
        this.config.paperTrading,
      );

      if (confirmed) {
        await markExecutionOrderConfirmed(orderId);
        console.log(
          `[executor] tx confirmed sig=${txSignature} (paper=${this.config.paperTrading})`,
        );

        // CREATE POSITION IDEMPOTENTLY
        try {
          const pos = await createPositionFromBuyOrder(orderId);
          console.log(`[risk] position opened mint=${mint} pos_id=${pos.id}`);
        } catch (posErr) {
          console.error(
            `[risk] failed to create position for confirmed order ${orderId}:`,
            posErr,
          );
        }
      } else {
        await markExecutionOrderFailed(
          orderId,
          "Transaction dropped or failed confirmation",
        );
        console.log(
          `[executor] execution failed mint=${mint} reason=Confirmation failure`,
        );
      }
    } catch (err: any) {
      await markExecutionOrderFailed(
        orderId,
        err.message || "Unknown execution error",
      );
      console.log(
        `[executor] execution failed mint=${mint} reason=${err.message}`,
      );
    }
  }

  private async processExitOrder(exit: any) {
    const mint = exit.token_mint;
    try {
      console.log(
        `[executor] processing exit order id=${exit.id} reason=${exit.reason}`,
      );

      // Stub integration: Route quote for sell
      const { txData, priorityFeeLamports } = await quoteAndBuildSellTx(
        mint,
        exit.sell_percentage,
        this.config.maxSlippageBps,
        this.config.paperTrading,
      );

      // Stub integration: Send tx
      const txSignature = await sendSignedTransaction(
        txData,
        this.config.paperTrading,
      );

      await markExitOrderSubmitted(exit.id, txSignature);
      console.log(
        `[executor] sell submitted sig=${txSignature} (paper=${this.config.paperTrading})`,
      );

      // Stub integration: Confirm tx
      const confirmed = await confirmTransaction(
        txSignature,
        this.config.paperTrading,
      );

      if (confirmed) {
        await markExitOrderConfirmed(exit.id, txSignature);
        console.log(
          `[executor] sell confirmed sig=${txSignature} (paper=${this.config.paperTrading})`,
        );

        // Close position ONLY if 100% sell percentage is confirmed
        if (exit.sell_percentage === 100) {
          await markPositionClosed(exit.position_id);
          console.log(
            `[risk] position closed id=${exit.position_id} mint=${mint}`,
          );
        }
      } else {
        await markExitOrderFailed(
          exit.id,
          "Transaction dropped or failed confirmation",
        );
        console.log(
          `[executor] sell failed mint=${mint} reason=Confirmation failure`,
        );
      }
    } catch (err: any) {
      await markExitOrderFailed(
        exit.id,
        err.message || "Unknown execution error",
      );
      console.log(`[executor] sell failed mint=${mint} reason=${err.message}`);
    }
  }
}
