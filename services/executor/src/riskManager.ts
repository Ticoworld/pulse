import {
  listOpenPositions,
  createExitOrder,
  getActiveExitOrderByPositionAndReason,
  Position,
} from "@pulse/db";

export class RiskManager {
  private enabled: boolean;
  private timeStopMinutes: number;

  constructor(config: { enabled: boolean; timeStopMinutes: number }) {
    this.enabled = config.enabled;
    this.timeStopMinutes = config.timeStopMinutes;
  }

  /**
   * Evaluates all open positions against defined exit rules.
   * In V1, only Time Stop is enforced automatically.
   */
  async evaluateOpenPositions() {
    if (!this.enabled) return;

    try {
      const positions = await listOpenPositions(100);

      for (const pos of positions) {
        await this.evaluateTimeStop(pos);
        // TODO: alpha_exit
        // TODO: dev_risk
      }
    } catch (err) {
      console.error("[risk] Error evaluating open positions:", err);
    }
  }

  private async evaluateTimeStop(pos: Position) {
    const ageMs = Date.now() - pos.opened_at.getTime();
    const ageMinutes = ageMs / (1000 * 60);

    if (ageMinutes >= this.timeStopMinutes) {
      // Create exit order if one doesn't already exist
      const existing = await getActiveExitOrderByPositionAndReason(
        pos.id,
        "time_stop",
      );
      if (existing) return; // Order is already pending/submitted

      console.log(
        `[risk] Creating time_stop exit order for position ${pos.id} (mint=${pos.token_mint})`,
      );

      await createExitOrder({
        positionId: pos.id,
        tokenMint: pos.token_mint,
        reason: "time_stop",
        sellPercentage: 100,
        targetDescription: `Time stop triggered at ${Math.round(ageMinutes)} mins`,
      });
    }
  }
}
