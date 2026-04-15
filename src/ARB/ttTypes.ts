/**
 * ttTypes.ts -- All internal types used by the tradeTennis arb bot.
 * Pure type definitions -- no runtime code, no state, no side effects.
 */

import { type ArbTradeRecord, type ExecMetric } from "../types.js";

// Re-export shared types so consumers only need one import
export type { ArbTradeRecord, ExecMetric };

// --- WebSocket book types -----------------------------------------------------

export type WsBookSide = Map<number, number>; // priceCents -> size

export interface WsLiveBook {
  yes: WsBookSide;
  no: WsBookSide;
  ts: number; // last update timestamp
}

export type WsPmBook = { bids: WsBookSide; asks: WsBookSide; ts: number };

// --- API response types ------------------------------------------------------
// Lightweight interfaces covering the fields we actually read from each API.
// All fields optional -- external APIs may omit any field at any time.

/** Kalshi market object (from /markets/{ticker} or nested inside events). */
export type KalshiMarket = {
  ticker?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  state?: string;
  result?: string;
  settlement_value?: string | number;
  close_time?: string;
  expected_expiration_time?: string;
  yes_ask?: number;
  yes_bid?: number;
  no_ask?: number;
  yes_ask_dollars?: number;
  yes_bid_dollars?: number;
  no_ask_dollars?: number;
  yes_ask_size_fp?: number;
  yes_ask_size?: number;
  yes_bid_size_fp?: number;
  yes_bid_size?: number;
  no_ask_size_fp?: number;
  no_ask_size?: number;
  remaining_count?: number;
  yes_sub_title?: string;
};

/** Kalshi event object (from /events/{ticker}). */
export type KalshiEvent = {
  event_ticker?: string;
  ticker?: string;
  title?: string;
  name?: string;
  category?: string;
  event_category?: string;
  series_category?: string;
  markets?: KalshiMarket[];
};

/** Kalshi order object (from getOrder / placeOrder responses). */
export type KalshiOrder = {
  order_id?: string;
  orderId?: string;
  status?: string;
  fill_count?: number;
  fill_count_fp?: string;    // "13.00" -- newer API format
  filled_count?: number;
  filled_contracts?: number;
  filled?: number;
  remaining_count?: number;
  taker_fees?: number;
  maker_fees?: number;
  taker_fees_dollars?: string;   // "0.1234" -- newer API format
  maker_fees_dollars?: string;
  taker_fill_cost?: number;       // actual fill cost in cents (taker)
  maker_fill_cost?: number;       // actual fill cost in cents (maker)
  taker_fill_cost_dollars?: string; // "11.18" -- newer API format
  maker_fill_cost_dollars?: string;
  order?: KalshiOrder;
};

/** Polymarket Gamma API market object. */
export type GammaMarket = {
  slug?: string;
  marketSlug?: string;
  question?: string;
  title?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  tokens?: Array<{ token_id?: string; outcome?: string }>;
  active?: boolean;
  closed?: boolean;
  sportsMarketType?: string;
  _eventSlug?: string;  // transient -- set by discovery code
  [key: string]: unknown; // allow arbitrary fields for forward compat
};

/** Polymarket Gamma API event object. */
export type GammaEvent = {
  slug?: string;
  markets?: GammaMarket[];
  [key: string]: unknown;
};

/** Polymarket positions API entry. */
export type PmPosition = {
  asset?: string;
  tokenId?: string;
  conditionId?: string;
  size?: number | string;
  amount?: number | string;
  slug?: string;
  marketSlug?: string;
  outcome?: string;
  title?: string;
  avgPrice?: number | string;
  averagePrice?: number | string;
  price?: number | string;
};

/** Polymarket CLOB order response. */
export type PmOrderResponse = {
  orderID?: string;
  orderId?: string;
  status?: string | number;  // string for order status, number for HTTP error codes
  order_status?: string;
  transactionsHashes?: string[];
  transactionHash?: string;
  txHash?: string;
  order?: PmOrderResponse;
};

/** CLOB orderbook entry (could be array [price, size] or object). */
export type ClobBookEntry = { price?: number; size?: number } | [number, number];

// --- Trading leg types --------------------------------------------------------

export type KalshiLeg = {
  ticker: string;
  surname: string;
  yesAsk: number;
  noAsk: number;
  yesAskSize?: number;  // top-of-book depth from yes_ask_size_fp (0 if unknown)
  noAskSize?: number;   // top-of-book depth (inferred from yes_bid_size_fp)
};

export type PmLeg = {
  outcome: string;
  tokenId: string;
  noTokenId?: string;  // NO token for binary sub-markets (soccer 3-way)
  tickSize: number;
  minSize: number;
  negRisk: boolean;
  /**
   * Per-market taker fee coefficient from gamma's `feeSchedule.rate`.
   * Formula: fee_paid = shares × feeRate × price × (1 - price).
   * Defaults to PM_FEE_RATE (0.03) if not set. Some markets charge 0,
   * others charge higher (e.g. eSports sports_fees_v2 — verify feeSchedule).
   */
  feeRate?: number;
};

export type WatchEntry = {
  matchCode: string;
  pmSlug: string;
  date: string;
  kal1: KalshiLeg;
  kal2: KalshiLeg;
  pm1: PmLeg;
  pm2: PmLeg;
  // Soccer 3-way: optional 3rd legs (Draw on KAL, Draw on PM)
  kal3?: KalshiLeg;  // Draw market on Kalshi (ticker ends -TIE)
  pm3?: PmLeg;       // Draw market on PM (slug ends -draw)
  is3Way?: boolean;   // true for soccer/3-outcome markets
  // Non-moneyline binary: single-ticker KAL market (spreads, totals, game totals)
  isBinary?: boolean;
};

// --- Arb direction type -------------------------------------------------------

export type ArbDir = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";

// --- Hedge mode types ---------------------------------------------------------

export type UnhedgedPosition = {
  tradeId: string;              // links back to ArbTradeRecord.id for precise resolution
  heldExchange: "pm" | "kal";  // which side we currently hold
  pmLeg: PmLeg;
  pmOppLeg: PmLeg | null;       // the OTHER PM outcome token
  pmCostBasis: number;          // price paid per PM share (0 if not held yet)
  kalLeg: KalshiLeg;
  kalCostBasis: number;         // price paid per Kalshi contract (0 if not held yet)
  kalSide: "yes" | "no";       // which KAL side was bought (dirs A/B=yes, C/D=no)
  sharesHeld: number;           // unhedged shares/contracts remaining
  initialShares: number;        // original number of shares at trade entry
  initialCost: number;          // cost of the first leg (the one that filled at trade time)
  hedgeFillCost: number;        // accumulates actual cost of hedge fills (completing leg)
  hedgeFillCostKal: number;     // portion of hedgeFillCost spent on Kalshi
  hedgeFillCostPm: number;      // portion of hedgeFillCost spent on Polymarket
  kalFees: number;              // accumulated Kalshi fees (initial + hedge fills)
  initialKalFees: number;       // Kalshi fees from initial fill only (for accurate resolve)
  pmPreBalance?: number;        // on-chain PM token balance before hedge started (for fill verification)
  pmFillPendingVerify?: number; // shares reported by CLOB but not yet verified on-chain
};

// Resting GTC order placed in the book (complete = buy missing leg, exit = sell existing)
export type HedgeOrder = {
  role: "complete" | "exit";
  exchange: "pm" | "kal";
  orderId: string;
  price: number;                // price at which order was placed
  shares: number;               // original size
  filledSoFar: number;          // cumulative fills seen so far (for delta tracking)
  fetchFailures: number;        // consecutive status-check errors; order removed after 3
  placedAt: number;             // Date.now() when placed -- used for timeout rotation
  _lastFeeSeen?: number;        // cumulative Kalshi fees from last poll (for delta calc)
  _feeDelta?: number;           // fee increment since last poll
  _lastLogKey?: string;         // dedup key for status logging
};

export type HedgeState = {
  position: UnhedgedPosition;
  activeOrders: Map<string, HedgeOrder>; // orderId -> HedgeOrder
  kalNextRetryAt: number;               // timestamp: don't retry Kalshi until after this
  pmNextRetryAt?: number;               // timestamp: don't place PM orders until after this (prevents double-fill from delayed settlement)
  lastCompleteExchange?: "pm" | "kal";  // for sequential hedge rotation
  pmOnlyCycles: number;                 // consecutive cycles with no PM fill
  _pendingTradeRecord?: ArbTradeRecord; // set by detection functions; caller logs only for non-duplicate positions
  _hedgeStartTs?: number;               // timestamp: when hedge mode started (for KAL window timeout)
};

export type PersistedHedgeEntry = {
  position: UnhedgedPosition;
  activeOrders: Array<[string, HedgeOrder]>;
  kalNextRetryAt: number;
  lastCompleteExchange?: "pm" | "kal";
  pmOnlyCycles?: number;
};

// --- Persistence types --------------------------------------------------------

export interface PendingFill {
  id: string;           // unique key, e.g. "pf-1710412800000"
  ts: string;           // ISO timestamp of intent
  exchange: "pm" | "kal";
  tokenIdOrTicker: string;
  side: string;         // "BUY" / "yes" / "no"
  shares: number;
  price: number;
  match: string;
  dir: string;
  pmSlug: string;
  pmTokenId: string;
  pmOutcome: string;
  kalTicker: string;
  completed?: boolean;  // set true after logArbTrade succeeds
}

export interface DepthLevel { price: number; size: number }

export interface DepthOpportunity {
  id: string;
  ts: string;
  match: string;
  dir: string;
  edge: number;
  kalAsk: number;
  pmAsk: number;
  outcome: "executed" | "aborted";
  failReason?: string;
  kalLevels: DepthLevel[];
  kalTotalContracts: number;
  kalTotalCostUsd: number;
  kalAvgPrice: number;
  pmLevels: DepthLevel[];
  pmTotalShares: number;
  pmTotalCostUsd: number;
  pmAvgPrice: number;
  // Combined
  maxProfitableShares: number; // min(kalTotal, pmTotal)
  maxInvestableUsd: number;    // shares x (kalAvg + pmAvg)
  projectedPnlUsd: number;    // shares x edge (approx)
  budgetShares: number;        // what we actually trade with our budget
}

export interface BookSample {
  t: number;          // ms offset from tracker start
  kalYesBids: [number, number][];
  kalNoBids: [number, number][];
  kalYesAsks: [number, number][];
  kalNoAsks: [number, number][];
  pmAsks: [number, number][];
  pmBids: [number, number][];
  source: "ws" | "rest" | "mixed";
}

export interface BookTrack {
  id: string;
  ts: string;
  phase: "discovery" | "execution";
  match: string;
  dir: string;
  kalTicker: string;
  pmTokenId: string;
  pmOutcome: string;
  kalAskAtDiscovery: number;
  pmAskAtDiscovery: number;
  edge: number;
  samples: BookSample[];
}

// --- Open position (for cancellation monitor) --------------------------------

export type OpenPosition = {
  kalTicker: string;
  pmTokenId: string;
  pmOutcome: string;
  pmSlug: string;
  shares: number;
  pmCost: number;
  kalCost: number;
  hedgeCost: number;
  tickSize: number;
  negRisk: boolean;
  tradeId: string;
  status: "filled" | "hedging" | "resolved";
};
