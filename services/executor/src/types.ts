export interface ExecutionConfig {
  enabled: boolean;
  paperTrading: boolean;
  minScore: number;
  buyAmountSol: number;
  maxSlippageBps: number;
  pollIntervalMs: number;
  maxOpenPositions?: number;
  cooldownMinutes?: number;
  timeStopMinutes?: number;
}
