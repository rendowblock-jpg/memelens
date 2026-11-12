// The messages of docs/SIDECAR-PROTOCOL.md as TypeScript types. Every amount is a decimal string (the wire rule).

export type ExitReason = "takeProfit" | "stopLoss" | "maxHold" | "end";

export interface FollowWalletsStrategy {
  kind: "follow-wallets";
  wallets: string[];
  latencyMs: number;
  positionQuote: string;
  takeProfitBps: number | null;
  stopLossBps: number | null;
  maxHoldMs: number;
}

export interface BacktestSpec {
  version: 1;
  from: number;
  to: number;
  strategy: FollowWalletsStrategy;
  costs: { feeBps: number; slippageBps: number };
}

export interface WireTrade {
  id: string;
  time: number;
  token: string;
  side: "buy" | "sell";
  amount: string;
  quote: string;
  fee?: string;
}

export interface WireWalletTrade extends WireTrade {
  wallet: string;
}

/** Where the engine reads trades from. The app (main process) chooses this, never the agent or the user. */
export type BacktestData =
  | { source: "inline"; trades: WireWalletTrade[] }
  | { source: "sqlite"; path: string; chain: string };

export interface Position {
  token: string;
  signalTradeId: string;
  signalWallet: string;
  entryTradeId: string;
  entryTime: number;
  entryAmount: string;
  buyFee: string;
  cost: string;
  exitTradeId: string;
  exitTime: number;
  exitReason: ExitReason;
  proceeds: string;
  sellFee: string;
  net: string;
  pnl: string;
}

export interface BacktestSummary {
  signals: number;
  ignoredWhileOpen: number;
  skipped: { noPrice: number; tooSmall: number };
  entered: number;
  exits: Record<ExitReason, number>;
  wins: number;
  losses: number;
  totalCost: string;
  totalNet: string;
  realised: string;
  roiBps: number | null;
}

export interface BacktestReport {
  engineVersion: string;
  specHash: string;
  dataAsOf: number | null;
  positions: Position[];
  summary: BacktestSummary;
}

export interface HelloResult {
  protocol: number;
  engineVersion: string;
  capabilities: string[];
}
