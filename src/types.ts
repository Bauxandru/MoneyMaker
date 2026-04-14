export type MarketPairConfig = {
  id: string;
  groupId?: string;
  pmMarketSlug?: string;
  polymarket: {
    eventSlug?: string;
    marketSlug?: string;
    outcomeLabel?: string | null;
    outcomeIndex?: number | null;
    tokenId?: string;
  };
  kalshi: {
    ticker: string;
    side: "YES" | "NO";
  };
  probable?: {
    marketSlug?: string;
  };
  notes?: string;
};

export type AutoPairConfig = {
  idPrefix: string;
  polymarketEventSlug: string;
  kalshiEventTicker: string;
};

export type Exchange = "polymarket" | "kalshi" | "limitless" | "probable";

export type MarketSnapshot = {
  ts: string;
  exchange: Exchange;
  marketId: string;
  marketTitle: string;
  outcomeLabel: string;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  rawJson: string;
};

export type ArbOpportunity = {
  ts: string;
  pairId: string;
  direction: "PM_YES_KAL_NO" | "KAL_YES_PM_NO";
  cost: number | null;
  edge: number | null;
};

// Shared arb trade record -- used by tradeTennis.ts, dashboard.ts, repairTrades.ts
export type ArbTradeRecord = {
  id: string;
  ts: string;
  match: string;
  dir: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";
  status: "filled" | "hedging" | "resolved";
  shares: number;
  kalTicker: string;
  kalFillPrice: number;
  kalCost: number;
  pmOutcome: string;
  pmSlug: string;
  pmTokenId?: string;
  pmFillPrice: number;
  pmCost: number;
  totalCost: number;
  projectedEdge: number;
  projectedProfit: number;
  resolvedTs?: string;
  resolutionMethod?: "both-legs" | "hedge-complete" | "hedge-exit" | "settlement" | "hedge-reconciled-onchain" | "market-settled" | "recovery-error";
  hedgeCost?: number;
  realizedPnl?: number;
  initialExchange?: "pm" | "kal";
  kalFees?: number;   // actual Kalshi taker+maker fees from order response
  // Scalar settlement fields -- set when Kalshi settles a cancelled/voided match
  scalarSettlement?: boolean;           // true if Kalshi settled as scalar (not binary)
  kalSettlementValue?: number;          // per-share KAL payout (e.g. 0.14 for NO at 86c YES scalar)
  pmSettlementValue?: number;           // per-share PM payout (e.g. 0.50 for 50/50 cancellation)
  resolutionNote?: string;              // human-readable note about non-standard resolution
  // Over-hedge tracking -- set when exchange has more fills than the arb trade's shares
  overHedgeShares?: number;             // excess contracts from over-hedging bug
  overHedgeCost?: number;               // cost of excess contracts
  overHedgeSide?: "yes" | "no";         // which side the excess is on
  // Actual exchange fill breakdown -- set by exchange reconcile for audit accuracy
  kalYesFills?: number;                 // actual YES contracts bought on Kalshi for this ticker
  kalNoFills?: number;                  // actual NO contracts bought on Kalshi for this ticker
  kalMakerFill?: boolean;               // true if Kalshi leg filled via maker GTC (lower fees)
  serverId?: string;                     // which server placed this trade (e.g. "ashburn-vps", "romania-local")
  // PM overfill tracking -- when PM fills more fractional shares than ordered
  pmActualShares?: number;              // actual shares received from PM (e.g., 11.55 when 11 ordered)
};

// Shared CLOB trade type -- used by dashboard.ts and repairTrades.ts
export interface ClobTrade {
  id?: string;           // unique trade ID for dedup
  order_id?: string;     // taker's order ID (same across partial fills)
  asset_id: string;
  size: string;
  price: string;
  fee_rate_bps: string;
  side: string;
  status: string;
  match_time: string;
  trader_side?: string; // "MAKER" or "TAKER"
  maker_orders?: { maker_address: string; matched_amount: string; price: string; asset_id: string }[];
}

// Shared execution metric -- used by tradeTennis.ts and dashboard.ts
// (outcome includes "filled" for post-cancel and race-recovery fills)
export type ExecMetric = {
  id: string;
  ts: string;
  match: string;
  dir: string;
  edge: number;
  shares: number;
  firstLeg: "pm" | "kal";
  outcome: "both-filled" | "filled" | "hedge-entry" | "abort-pre-first" | "abort-pre-second" | "abort-safety";
  failReason?: string;
  firstLegFilled: number;
  secondLegFilled: number;
  expectedKalPrice: number;
  expectedPmPrice: number;
  totalMs: number;
  firstLegOrderMs: number;
  firstLegConfirmMs: number;
  secondLegOrderMs: number;
  secondLegConfirmMs: number;
  bookFetchMs: number;
  preflightMs?: number;    // Kalshi market status check before execution
  depthCheckMs?: number;   // parallel depth fetch (KAL orderbook + PM asks)
  postVerifyMs?: number;   // post-fill PM verification (on-chain + CLOB + data-api)
  dryRun?: boolean;
  kalMakerFill?: boolean;  // true if Kalshi leg filled via maker GTC (lower fees)
  serverId?: string;       // which server placed this execution
};
