/**
 * @module ttHedge
 * Hedge-mode logic for unhedged arbitrage positions.
 *
 * Extracted from tradeTennis.ts (lines 7135-9109).
 *
 * Contains:
 *   - recheckAndCancelAll        -- cancel all orders for a position
 *   - extractEventDateKey        -- match fingerprint from Kalshi ticker
 *   - collectOpenPositions       -- gather positions needing void monitoring
 *   - isScalarSettlement         -- detect scalar (cancelled/voided) markets
 *   - fetchPmBestBid             -- PM orderbook best bid
 *   - runCancellationMonitor     -- periodic void/scalar detection
 *   - handleCancelledPosition    -- emergency sell on cancellation
 *   - runHedgeCycle              -- main hedge cycle state machine
 *   - detectUnhedgedPmPositions  -- startup PM position scan
 *   - detectUnhedgedKalPositions -- startup Kalshi position scan
 */

import {
  DRY_RUN,
  KALSHI_FEE_RATE,
  KALSHI_MAKER_FEE_RATE,
  PM_FEE_RATE,
  TRADE_USD,
  MAX_CONTRACTS,
  HEDGE_TARGET,
  STRICT_HEDGE,
  PM_ONLY_MAX_CYCLES,
  MIN_EDGE,
  kalFetch,
  kalFetchHedge,
  polyClobFetch,
  fmtPct,
  ts,
  estimateFees,
  KAL_MAKER_MODE,
  KAL_MAKER_WAIT_MS,
  KAL_MAKER_POLL_MS,
  PM_MARKETABLE_MIN_VALUE,
  MIN_DEPTH_MULT,
} from "./ttConfig.js";

import { audit, startTimer } from "./ttAuditLog.js";

import type {
  HedgeState,
  HedgeOrder,
  UnhedgedPosition,
  WatchEntry,
  KalshiLeg,
  PmLeg,
  ArbTradeRecord,
  ArbDir,
  KalshiMarket,
  PmPosition,
  OpenPosition,
  PendingFill,
  KalshiOrder,
} from "./ttTypes.js";

import {
  loadArbTrades,
  saveArbTrades,
  resolveArbTrade,
  saveHedgeState,
  saveHedgeStates,
  loadPendingFills,
  completePendingFill,
  _allHedgeStates,
  setAllHedgeStates,
  _reconcileRecoveredTrades,
  setReconcileRecoveredTrades,
  loadMetrics,
} from "./ttPersistence.js";

import {
  getWsKalBestAsk,
  getWsPmBestAsk,
  getWsPmBestBid,
  getWsPmAsks,
  getWsPmBids,
  isPmServiceDown,
  isPm425,
  markPmDown,
  markPmUp,
  getKalSettlement,
  isKalMarketSettled,
  waitForKalOrderWs,
  waitForPmFillWs,
  isPmUserWsReady,
  registerKalFillListener,
  registerKalOrderListener,
  unregisterKalListeners,
  KalFillEvent,
  KalOrderEvent,
} from "./ttWebSocket.js";

import { appendEvent, type OrderPlacedEvent, type FillDetectedEvent, type OrderCancelledEvent } from "./ttEventLog.js";

import {
  createPmClient,
  placePmGTCBid,
  placePmGTCAsk,
  placePmFOK,
  placePmFOKSell,
  cancelPmOrder,
  cancelAllPmOrdersForToken,
  getPmOrderFills,
  buildKalshiIOCOrder,
  fetchKalshiSingleMarket,
  fetchPmAsk,
  sweepKalshiDepth,
  deriveYesAsks,
  deriveNoAsks,
  waitForPmOrderFill,
  getActualPmFillCost,
} from "./ttPmOrders.js";

import {
  postResolutionFillAudit,
  fetchPmPositionsCached,
  sumPmHeld,
  extractKalMeta,
  extractPmMeta,
  getPmFunder,
} from "./ttReconcile.js";

import { namesMatch } from "./ttNameMatch.js";

import {
  placeKalshiOrder,
  getKalshiOrder,
  cancelKalshiOrder,
  buildKalshiGTCOrder,
  getKalshiPosition,
  getKalshiNoPosition,
  getKalshiPositionMap,
  fetchAllKalshiFills,
  fetchKalshiOrderbook,
  fetchKalshiMarket,
  getKalshiBalance,
  fetchOpenKalshiOrders,
} from "../kalshiTrade.js";
import type { KalFill } from "../kalshiTrade.js";

import { getOnChainBalance, getOnChainBalanceWithFallback } from "../polyChain.js";

import { isMatchFinished, isMatchCancelled, getMatchState } from "../liveScores.js";

import { sleep, pickString, r2, kalSideForDir, totalCostForTrade, normCents, normDollarsOrCents } from "../utils.js";

import fs from "fs";

// -- Module-level state -------------------------------------------------------

let _hedgeLastExitLog = "";  // deduplicate PM exit skip log
export let _hedgeLogCounter = 0;    // cycle counter for periodic status summary

// Track which kalTickers we've already processed for cancellation (avoid re-selling)
const _cancelledTickers = new Set<string>();
// Track cancelled EVENTS (not just tickers) -- e.g. "FNMKOI" and "FNKOIA" are both
// from the same match. If one settles scalar, block all sibling markets.
// Key = event keyword extracted from ticker (e.g. "26MAR09" + team combo).
const _cancelledEventKeys = new Set<string>();
let _cancMonLastRun = 0;
const CANC_MON_INTERVAL_MS = 60_000; // check every 60s (was 10s -- too aggressive, blocks Kalshi queue)

// -- PM fill verification: WS MINED primary, on-chain fallback ----------------
// After CLOB says "matched", wait for WS MINED (on-chain confirmed).
// If WS is down or misses the event, fall back to on-chain balance polling.
// Returns the number of verified shares (0 if phantom fill).

async function verifyPmFill(
  tokenId: string,
  expectedShares: number,
  preBalance: number,
  label: string,
  orderId?: string,
  wsTimeoutMs = 30_000,
  onChainMaxWaitMs = 30_000,
  onChainPollMs = 5_000
): Promise<number> {
  // -- Primary: WS MINED --
  if (orderId && isPmUserWsReady()) {
    const wsEvt = await waitForPmFillWs(orderId, wsTimeoutMs); // requireMined=true (default)
    if (wsEvt) {
      const status = (wsEvt.status ?? "").toUpperCase();
      if (status === "CONFIRMED" || status === "MINED") {
        console.log(`  [${label}] WS ${status}: ${wsEvt.size} shares on-chain confirmed`);
        return Math.min(Math.round(Number(wsEvt.size) || expectedShares), expectedShares);
      }
      if (status === "MATCHED") {
        console.log(`  [${label}] WS MATCHED but not MINED after ${wsTimeoutMs}ms — falling back to on-chain`);
        // Fall through to on-chain check
      }
    } else {
      console.log(`  [${label}] WS timeout (${wsTimeoutMs}ms) — falling back to on-chain`);
    }
  } else if (!isPmUserWsReady()) {
    console.log(`  [${label}] WS not connected — using on-chain fallback`);
  }

  // -- Fallback: on-chain balance polling --
  const t0 = Date.now();
  while (Date.now() - t0 < onChainMaxWaitMs) {
    try {
      const bal = await getOnChainBalance(tokenId);
      const newShares = bal - preBalance;
      if (newShares >= expectedShares) {
        console.log(`  [${label}] On-chain verified: ${newShares} shares`);
        return Math.min(newShares, expectedShares);
      }
      if (newShares > 0) {
        console.log(`  [${label}] On-chain partial: ${newShares}/${expectedShares}`);
      }
    } catch { /* RPC error — retry */ }
    if (Date.now() - t0 + onChainPollMs < onChainMaxWaitMs) {
      await sleep(onChainPollMs);
    } else break;
  }
  // Final on-chain check
  try {
    const bal = await getOnChainBalance(tokenId);
    const newShares = bal - preBalance;
    if (newShares > 0) return Math.min(newShares, expectedShares);
  } catch { /* */ }
  console.warn(`  [${label}] PHANTOM FILL: WS + on-chain both show 0 shares after verification`);
  return 0;
}

// -- Functions ----------------------------------------------------------------

export async function recheckAndCancelAll(
  pos: UnhedgedPosition,
  activeOrders: Map<string, HedgeOrder>,
  dryRun: boolean
): Promise<void> {
  for (const [oid, ho] of activeOrders) {
    // Skip dry-run order IDs -- they're fake and will fail API calls
    if (oid.startsWith("dry-")) { activeOrders.delete(oid); continue; }
    // Re-check final fill count before cancelling
    try {
      let latestFilled = ho.filledSoFar;
      if (ho.exchange === "pm") {
        const { filledShares } = await getPmOrderFills(oid);
        latestFilled = filledShares;
      } else {
        const order = await getKalshiOrder(oid);
        latestFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled ?? ho.filledSoFar);
        // Safety: if order shows executed but fills=0, infer from remaining_count
        const rcSt = String(order.status ?? "");
        if (latestFilled === 0 && (rcSt === "executed" || rcSt === "filled")) {
          const remaining = Number(order.remaining_count ?? ho.shares);
          const inferred = ho.shares - remaining;
          if (inferred > 0) {
            console.warn(`[HEDGE] recheckCancel: fill count missing for ${rcSt} order -- inferred ${inferred} fills`);
            latestFilled = inferred;
          }
        }
      }
      const delta = latestFilled - ho.filledSoFar;
      if (delta > 0) {
        pos.sharesHeld = Math.max(0, pos.sharesHeld - delta);
        if (ho.role === "complete") {
          pos.hedgeFillCost += delta * ho.price;
          if (ho.exchange === "kal") pos.hedgeFillCostKal += delta * ho.price;
          else pos.hedgeFillCostPm += delta * ho.price;
        }
        console.log(`[HEDGE] Late GTC fill detected: ${ho.exchange.toUpperCase()} ${ho.role} +${delta}. Remaining: ${pos.sharesHeld}`);
      }
    } catch { /* order may already be gone -- proceed to cancel */ }
    // Cancel the order
    try {
      if (ho.exchange === "pm") await cancelPmOrder(oid, dryRun);
      else await cancelKalshiOrder(oid, dryRun);
      console.log(`[HEDGE] Cancelled GTC ${ho.exchange.toUpperCase()} ${ho.role} ${oid.slice(0, 16)}... after IOC fill.`);
      appendEvent({
        type: "order-cancelled", tradeId: pos.tradeId, exchange: ho.exchange as "kal" | "pm",
        orderId: oid, ticker: pos.kalLeg.ticker,
        filledBeforeCancel: ho.filledSoFar, reason: "ioc-fill-cancel-remaining",
      } as Omit<OrderCancelledEvent, "seq" | "ts">);
    } catch { /* best effort */ }
  }
  activeOrders.clear();
}

// -- Hedge Mode Strategy ------------------------------------------------------
// When only one arb leg fills, we hold an unhedged position. The bot hedges by
// racing orders on BOTH platforms simultaneously:
//
//   Holding PM token (e.g. P2):
//     • Complete order on Kalshi: GTC bid for P1 YES  -> completes the arb
//     • Complete order on PM:     GTC bid for P1 token -> completes the arb
//     • Exit order on PM:         GTC ask selling held P2 token -> exits position
//
//   Holding Kalshi YES (e.g. P1):
//     • Complete order on PM:     GTC bid for P2 token -> completes the arb
//     • Complete order on Kalshi:  GTC bid for P2 NO   -> completes the arb
//     • Exit order on Kalshi:     GTC ask selling held P1 YES -> exits position
//
// Cross-platform exit (e.g. selling PM token on Kalshi) is NOT possible -- you
// can only sell assets you hold on the platform where you hold them. Buying the
// opposite contract on the other platform would create a NEW position, not close
// the existing one. The dual complete orders already cover both fill paths.
//
// Each hedge cycle also attempts an aggressive FOK sweep on PM to fill instantly.
// -----------------------------------------------------------------------------

// --- Cancellation Monitor ----------------------------------------------------
// Polls Kalshi market status for ALL open positions (filled + hedging).
// Detects scalar settlements (match cancelled/voided) and immediately sells
// PM tokens before PM resolves 50/50, recovering maximum value.
//
// Scalar detection signals:
//   - result === "scalar"
//   - settlement_value is NOT 0, 100, or empty (fractional payout)
//
// On detection: place GTC ASK on PM at max(bestBid, 0.50) to exit fast.
// -----------------------------------------------------------------------------

/**
 * Extract a "match fingerprint" from a Kalshi ticker to detect sibling markets.
 * E.g. KXLOLGAME-26MAR09FNMKOI-MKOI -> "KXLOLGAME-26MAR09" + sorted team codes.
 * KXLOLGAME-26MAR09FNKOIA-KOIA would share the same date prefix.
 * We use the date portion + series as key since Kalshi uses different event codes
 * for rescheduled markets of the same match.
 */
export function extractEventDateKey(ticker: string): string {
  // Ticker format: SERIES-DDMMMYYTEAMS-PLAYER  e.g. KXLOLGAME-26MAR09FNMKOI-MKOI
  const parts = ticker.split("-");
  if (parts.length < 2) return ticker;
  const series = parts[0]; // KXLOLGAME
  const middle = parts[1]; // 26MAR09FNMKOI
  // Extract date portion (first 7 chars: DDMMMYY)
  const dateMatch = middle.match(/^(\d{2}[A-Z]{3}\d{2})/);
  if (!dateMatch) return ticker;
  return `${series}-${dateMatch[1]}`; // e.g. "KXLOLGAME-26MAR09"
}

/** Collect all positions that need void monitoring -- includes resolved trades
 *  from the last 48h that may not have settled on Kalshi yet. */
export function collectOpenPositions(watchlist: WatchEntry[]): OpenPosition[] {
  const trades = loadArbTrades();
  const positions: OpenPosition[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48h lookback

  for (const t of trades) {
    if (!t.kalTicker) continue;
    // Already handled by cancellation monitor
    if (_cancelledTickers.has(t.kalTicker)) continue;
    // Skip resolved trades already marked as scalar settlement (already handled)
    if (t.status === "resolved" && t.scalarSettlement) continue;
    // For resolved trades, only include recent ones (within 48h)
    if (t.status === "resolved" && new Date(t.ts).getTime() < cutoff) continue;

    // Find the watchlist entry to get tickSize/negRisk
    const we = t.pmTokenId
      ? watchlist.find(w => w.pm1.tokenId === t.pmTokenId || w.pm2.tokenId === t.pmTokenId || (w.pm3 && w.pm3.tokenId === t.pmTokenId))
      : null;
    const pmLeg = we
      ? (we.pm1.tokenId === t.pmTokenId ? we.pm1 : we.pm2.tokenId === t.pmTokenId ? we.pm2 : we.pm3 ?? we.pm2)
      : null;

    positions.push({
      kalTicker: t.kalTicker,
      pmTokenId: t.pmTokenId ?? "",
      pmOutcome: t.pmOutcome,
      pmSlug: t.pmSlug,
      shares: t.shares,
      pmCost: t.pmCost,
      kalCost: t.kalCost ?? 0,
      hedgeCost: t.hedgeCost ?? 0,
      tickSize: pmLeg?.tickSize ?? 0.01,
      negRisk: pmLeg?.negRisk ?? false,
      tradeId: t.id,
      status: t.status as "filled" | "hedging" | "resolved",
    });
  }
  return positions;
}

/** Check if a Kalshi market settled as scalar (cancelled/voided). */
export function isScalarSettlement(mkt: KalshiMarket): boolean {
  const result = pickString(mkt.result ?? "").toLowerCase();
  if (result === "scalar") return true;

  // Also check settlement_value for non-binary values.
  // Kalshi sends settlement_value on a 0–1 dollar scale: 1.0 = YES, 0.0 = NO.
  // Anything fractional (e.g. 0.14, 0.50) indicates scalar/cancelled settlement.
  const sv = Number(mkt.settlement_value ?? "");
  if (Number.isFinite(sv) && sv > 0 && sv < 1) {
    return true;
  }
  return false;
}

/** Fetch PM book and return the best bid price (highest buyer). */
export async function fetchPmBestBid(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await polyClobFetch<{ bids?: unknown }>(`${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!Array.isArray(book.bids)) return null;
    const prices: number[] = [];
    for (const entry of book.bids) {
      let price: number;
      if (Array.isArray(entry)) {
        price = Number(entry[0]);
      } else if (entry && typeof entry === "object") {
        price = Number((entry as Record<string, unknown>).price ?? (entry as Record<string, unknown>)[0] ?? NaN);
      } else {
        price = Number(entry);
      }
      if (Number.isFinite(price) && price > 0 && price < 1) prices.push(price);
    }
    return prices.length ? Math.max(...prices) : null;
  } catch {
    return null;
  }
}

/**
 * Run the cancellation monitor for all open positions.
 * Called from the main loop every ~60s. For each open position:
 *   1. Fetch Kalshi market status
 *   2. If scalar settlement detected -> emergency sell PM tokens
 *   3. Update arb_trades.json with cancellation resolution
 */
export async function runCancellationMonitor(watchlist: WatchEntry[], hedgeStates: HedgeState[], clobBase: string): Promise<void> {
  const now = Date.now();
  if (now - _cancMonLastRun < CANC_MON_INTERVAL_MS) return;
  _cancMonLastRun = now;

  const positions = collectOpenPositions(watchlist);
  if (positions.length === 0) return;

  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

  // Deduplicate by kalTicker (multiple trades might reference same market)
  const uniqueTickers = new Map<string, OpenPosition[]>();
  for (const p of positions) {
    const existing = uniqueTickers.get(p.kalTicker) ?? [];
    existing.push(p);
    uniqueTickers.set(p.kalTicker, existing);
  }

  for (const [ticker, posGroup] of uniqueTickers) {
    try {
      // Check WS settlement cache first (instant)
      let mkt: KalshiMarket;
      let mktStatus: string;
      const wsSettle = getKalSettlement(ticker);
      if (wsSettle) {
        mkt = { status: "settled", result: wsSettle.result.toLowerCase(), settlement_value: wsSettle.settlementValue.toString() } as unknown as KalshiMarket;
        mktStatus = "settled";
      } else {
        const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
        mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
        mktStatus = pickString(mkt.status ?? mkt.state ?? "").toLowerCase();
      }

      // Only check finalized/settled/closed markets
      if (mktStatus !== "closed" && mktStatus !== "settled" && mktStatus !== "resolved" && mktStatus !== "finalized") {
        continue;
      }

      // Check if this is a scalar (cancelled) settlement
      if (!isScalarSettlement(mkt)) {
        // Normal binary settlement -- mark as handled so we stop polling this ticker
        _cancelledTickers.add(ticker);
        continue;
      }

      const sv = Number(mkt.settlement_value ?? 0);
      console.error(
        `\n+==================================================================+\n` +
        `|  [!] CANCELLATION DETECTED: ${ticker}\n` +
        `|  Result: ${mkt.result}  Settlement: ${sv}c  Status: ${mktStatus}\n` +
        `|  Affected positions: ${posGroup.length} trade(s)\n` +
        `+==================================================================+\n`
      );

      // Mark ticker + event as handled (blocks sibling markets too)
      _cancelledTickers.add(ticker);
      _cancelledEventKeys.add(extractEventDateKey(ticker));

      // Process each affected trade
      for (const pos of posGroup) {
        await handleCancelledPosition(pos, mkt, hedgeStates, clobBase);
      }
    } catch (err) {
      // Transient fetch error -- will retry next cycle
      console.warn(`[CANC-MON] Failed to check ${ticker}: ${(err as Error).message}`);
    }
  }
}

/**
 * Handle a position affected by a cancelled/scalar-settled Kalshi market.
 *
 * Three scenarios:
 *
 *   1. BOTH LEGS FILLED (status="filled") -- We hold PM tokens + Kalshi already settled.
 *      -> Sell PM tokens into bids (FOK at bestBid if >= 50c, else GTC ask at 50c).
 *        Kalshi side already paid out at settlement_value automatically.
 *
 *   2. ONLY PM SHARES HELD (status="hedging", heldExchange="pm") -- We hold PM tokens,
 *      Kalshi leg was being hedged.
 *      -> Cancel ALL hedge orders on BOTH exchanges, then sell PM tokens same as #1.
 *
 *   3. ONLY KALSHI POSITION (status="hedging", heldExchange="kal") -- We hold Kalshi
 *      contracts, PM leg was being hedged.
 *      -> Cancel ALL hedge orders on BOTH exchanges. Kalshi settles automatically
 *        at settlement_value (we know the exact payout). No PM tokens to sell.
 */
export async function handleCancelledPosition(
  pos: OpenPosition,
  mkt: KalshiMarket,
  hedgeStates: HedgeState[],
  clobBase: string
): Promise<void> {
  const sv = Number(mkt.settlement_value ?? 0);
  const svDecimal = sv > 1 ? sv / 100 : sv; // normalize cents (1-99) to decimal (0.01-0.99)

  console.log(
    `[CANC-MON] Processing ${pos.pmOutcome} (${pos.tradeId}): ` +
    `${pos.shares} shares, pmCost=$${pos.pmCost.toFixed(2)}, ` +
    `kalSettlement=${svDecimal.toFixed(2)}, status=${pos.status}`
  );

  // -- Step 1: Cancel ALL hedge orders on BOTH exchanges ----------------------
  const matchingHs = hedgeStates.find(hs => hs.position.kalLeg.ticker === pos.kalTicker);
  if (matchingHs) {
    for (const [oid, ho] of matchingHs.activeOrders) {
      try {
        if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
        else await cancelKalshiOrder(oid, DRY_RUN);
        console.log(`[CANC-MON] Cancelled ${ho.exchange.toUpperCase()} ${ho.role} order ${oid.slice(0, 16)}...`);
      } catch { /* order may already be gone */ }
    }
    matchingHs.activeOrders.clear();
  }

  // -- Step 2: Determine if we hold PM tokens ---------------------------------
  // Scenario 3: Kalshi-only position -- no PM tokens to sell.
  const isKalshiOnly = pos.status === "hedging" && matchingHs?.position.heldExchange === "kal";
  if (isKalshiOnly) {
    console.log(
      `[CANC-MON] Kalshi-only position for ${pos.kalTicker}. ` +
      `Kalshi settles at ${fmtPct(svDecimal)} automatically. No PM tokens to sell.`
    );
    // Kalshi payout is automatic. Resolve the trade record.
    const kalCost = matchingHs!.position.initialCost + matchingHs!.position.hedgeFillCostKal;
    const kalPayout = matchingHs!.position.initialShares * svDecimal;
    const realizedPnl = Math.round((kalPayout - kalCost) * 100) / 100;
    resolveArbTrade(pos.kalTicker, {
      status: "resolved",
      resolvedTs: new Date().toISOString(),
      resolutionMethod: "settlement",
      realizedPnl,
      scalarSettlement: true,
      kalSettlementValue: svDecimal,
      pmSettlementValue: 0,
      resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}c). Kalshi-only position -- no PM tokens.`,
    }, pos.tradeId);
    console.log(
      `[CANC-MON] Trade resolved (Kalshi-only): ` +
      `kalPayout=$${kalPayout.toFixed(2)} kalCost=$${kalCost.toFixed(2)} P&L=$${realizedPnl.toFixed(2)}`
    );
    if (matchingHs) matchingHs.position.sharesHeld = 0;
    return;
  }

  // -- Scenario 4: Already-resolved trade (both-legs, hedge-complete, etc.) --
  //    Trade was resolved normally but Kalshi voided the market AFTER resolution.
  //    KAL settles automatically at settlement_value. We may still hold PM tokens
  //    that should be sold if above 50c (void settles PM at 50/50).
  if (pos.status === "resolved") {
    const kalPayout = pos.shares * svDecimal;
    const totalCostPaid = pos.kalCost + pos.pmCost + pos.hedgeCost;
    console.log(
      `[CANC-MON] Resolved trade voided: ${pos.pmOutcome} (${pos.tradeId})\n` +
      `  KAL settles at ${fmtPct(svDecimal)} -> payout $${kalPayout.toFixed(2)}\n` +
      `  Original costs: KAL=$${pos.kalCost.toFixed(2)} PM=$${pos.pmCost.toFixed(2)} hedge=$${pos.hedgeCost.toFixed(2)}`
    );

    // Check if we still hold PM tokens
    let pmHeld = 0;
    if (pos.pmTokenId) {
      try {
        pmHeld = await getOnChainBalance(pos.pmTokenId);
        console.log(`[CANC-MON] On-chain PM balance: ${pmHeld} shares`);
      } catch { pmHeld = pos.shares; /* fallback to trade record */ }
    }

    // Sell PM tokens if we hold any and can get > 50c
    let pmRevenue = 0;
    if (pmHeld > 0) {
      const bestBid = await fetchPmBestBid(pos.pmTokenId, clobBase);
      const MIN_SELL = 0.50;
      const tick = pos.tickSize || 0.01;
      if (bestBid !== null && bestBid >= MIN_SELL) {
        const sellPrice = Math.round(bestBid / tick) * tick;
        console.log(`[CANC-MON] EMERGENCY SELL PM: ${pmHeld}x ${pos.pmOutcome} @ ${fmtPct(sellPrice)} (FOK into bids)`);
        if (!DRY_RUN) {
          try {
            await placePmFOKSell(pos.pmTokenId, sellPrice, pmHeld, pos.tickSize, pos.negRisk, false);
            pmRevenue = pmHeld * sellPrice;
          } catch (err) {
            console.error(`[CANC-MON] PM sell failed: ${(err as Error).message}`);
          }
        }
      } else {
        // Place GTC ask at 50c -- PM void settles at 50/50 so this is the floor
        const gtcPrice = Math.round(MIN_SELL / tick) * tick;
        console.log(`[CANC-MON] PM GTC ASK: ${pmHeld}x ${pos.pmOutcome} @ ${fmtPct(gtcPrice)} (floor price)`);
        if (!DRY_RUN) {
          try {
            await placePmGTCAsk(pos.pmTokenId, gtcPrice, pmHeld, pos.tickSize, pos.negRisk, false);
            pmRevenue = pmHeld * gtcPrice; // estimated
          } catch (err) {
            console.error(`[CANC-MON] PM GTC failed: ${(err as Error).message}`);
          }
        }
      }
    }

    // Update trade record with scalar settlement info
    // Only count KAL payout if we actually hold KAL contracts (kalCost > 0).
    // For PM-only positions (KAL GTC failed, detect trades), kalPayout = 0.
    const hasKalPosition = pos.kalCost > 0;
    const effectiveKalPayout = hasKalPosition ? kalPayout : 0;
    const newPnl = Math.round((effectiveKalPayout + (pmHeld > 0 ? pmRevenue : 0) - totalCostPaid) * 100) / 100;
    resolveArbTrade(pos.kalTicker, {
      scalarSettlement: true,
      kalSettlementValue: svDecimal,
      pmSettlementValue: pmHeld > 0 ? (pmRevenue / pmHeld) : 0,
      resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}c). ${pmHeld > 0 ? "PM sell attempted." : "No PM tokens held."}`,
      realizedPnl: newPnl,
    }, pos.tradeId);
    console.log(
      `[CANC-MON] Resolved trade updated: kalPayout=$${kalPayout.toFixed(2)} ` +
      `pmSell~$${pmRevenue.toFixed(2)} totalCost=$${totalCostPaid.toFixed(2)} P&L=$${newPnl.toFixed(2)}`
    );
    return;
  }

  // -- Scenarios 1 & 2: We hold PM tokens (filled/hedging) -- need to sell them -

  // Step 3: Check actual PM holdings via on-chain balance (authoritative)
  let actualShares = pos.shares;
  try {
    const held = await getOnChainBalance(pos.pmTokenId);
    if (held >= 0) {
      actualShares = held;
      console.log(`[CANC-MON] On-chain PM balance: ${actualShares} shares`);
    }
  } catch { /* use trade record shares as fallback */ }

  if (actualShares <= 0) {
    console.log(`[CANC-MON] No PM shares to sell for ${pos.pmOutcome} -- skipping sell.`);
    if (matchingHs) matchingHs.position.sharesHeld = 0;
    return;
  }

  // Step 4: Fetch PM orderbook to find best bid
  const bestBid = await fetchPmBestBid(pos.pmTokenId, clobBase);
  console.log(`[CANC-MON] PM best bid for ${pos.pmOutcome}: ${bestBid !== null ? fmtPct(bestBid) : "no bids"}`);

  // Step 5: Sell strategy
  //   - If bestBid >= 50c -> aggressive FOK sell into bids at bestBid price (instant fill)
  //   - If bestBid < 50c or no bids -> GTC ask at 50c (wait for someone to buy;
  //     PM cancellation resolves 50/50 so 50c is guaranteed floor value)
  const MIN_SELL_PRICE = 0.50;
  const tick = pos.tickSize || 0.01;
  let sellPrice: number;
  let useAggressive = false; // FOK into bids vs GTC resting ask

  if (bestBid !== null && bestBid >= MIN_SELL_PRICE) {
    sellPrice = bestBid;
    useAggressive = true; // sell INTO bids immediately
  } else {
    sellPrice = MIN_SELL_PRICE;
    useAggressive = false; // rest a GTC ask at 50c
  }

  // Round to tick size
  sellPrice = Math.round(sellPrice / tick) * tick;
  sellPrice = Math.max(sellPrice, tick);

  // PM minimum order value check ($1)
  if (actualShares * sellPrice < 1.0) {
    const minPrice = Math.ceil(1.0 / actualShares / tick) * tick;
    if (minPrice <= 1.00) {
      sellPrice = minPrice;
      console.warn(`[CANC-MON] Adjusted sell price to ${fmtPct(sellPrice)} to meet PM $1 minimum order value.`);
    } else {
      console.error(`[CANC-MON] Cannot meet PM $1 minimum with ${actualShares} shares. Manual exit needed.`);
      return;
    }
  }

  console.log(
    `[CANC-MON] EMERGENCY SELL: ${actualShares}x ${pos.pmOutcome} @ ${fmtPct(sellPrice)} ` +
    `(${useAggressive ? "FOK into bids" : "GTC ask at floor"}) ` +
    `value=$${(actualShares * sellPrice).toFixed(2)}`
  );

  // Step 6: Place the sell order
  if (DRY_RUN) {
    console.log(`[CANC-MON] [DRY] Would ${useAggressive ? "FOK SELL" : "GTC ASK"}: ${actualShares}x@${fmtPct(sellPrice)}`);
  } else {
    try {
      let result: unknown;
      if (useAggressive) {
        // Aggressive: FOK sell into existing bids -- fills instantly or fails
        result = await placePmFOKSell(pos.pmTokenId, sellPrice, actualShares, pos.tickSize, pos.negRisk, false);
      } else {
        // Passive: GTC ask resting at 50c -- waits for buyers
        result = await placePmGTCAsk(pos.pmTokenId, sellPrice, actualShares, pos.tickSize, pos.negRisk, false);
      }
      const orderId = pickString((result as Record<string, unknown>)?.orderID ?? (result as Record<string, unknown>)?.order_id ?? "");
      console.log(
        `[CANC-MON] PM ${useAggressive ? "FOK" : "GTC"} sell order placed! orderId=${orderId.slice(0, 20)}... ` +
        `${actualShares}x@${fmtPct(sellPrice)}`
      );

      // If FOK failed to fill (size_matched < size), fall back to GTC at 50c
      const sizeMatched = Number((result as Record<string, unknown>)?.size_matched ?? actualShares);
      if (useAggressive && sizeMatched < actualShares) {
        const remaining = actualShares - Math.round(sizeMatched);
        if (remaining > 0) {
          const gtcPrice = Math.round(MIN_SELL_PRICE / tick) * tick;
          console.log(`[CANC-MON] FOK partially filled (${Math.round(sizeMatched)}/${actualShares}). Placing GTC ask for ${remaining} remaining @ ${fmtPct(gtcPrice)}`);
          try {
            await placePmGTCAsk(pos.pmTokenId, gtcPrice, remaining, pos.tickSize, pos.negRisk, false);
          } catch (e2) {
            console.error(`[CANC-MON] GTC fallback failed: ${(e2 as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[CANC-MON] PM sell FAILED: ${(err as Error).message}`);
      // Fallback: try GTC if FOK failed
      if (useAggressive) {
        console.log(`[CANC-MON] FOK failed -- trying GTC ask at ${fmtPct(MIN_SELL_PRICE)}...`);
        try {
          const gtcPrice = Math.round(MIN_SELL_PRICE / tick) * tick;
          await placePmGTCAsk(pos.pmTokenId, gtcPrice, actualShares, pos.tickSize, pos.negRisk, false);
          console.log(`[CANC-MON] GTC fallback placed: ${actualShares}x@${fmtPct(gtcPrice)}`);
        } catch (e2) {
          console.error(`[CANC-MON] GTC fallback also FAILED: ${(e2 as Error).message}`);
          console.error(`[CANC-MON] MANUAL ACTION NEEDED: sell ${actualShares}x ${pos.pmOutcome} (${pos.pmTokenId.slice(0, 16)}...)`);
        }
      } else {
        console.error(`[CANC-MON] MANUAL ACTION NEEDED: sell ${actualShares}x ${pos.pmOutcome} (${pos.pmTokenId.slice(0, 16)}...)`);
      }
    }
  }

  // Step 7: Resolve trade record
  const kalPayout = pos.shares * svDecimal;
  const pmRevenue = actualShares * sellPrice; // estimated (actual depends on fill)
  const totalRevenue = kalPayout + pmRevenue;
  const totalCostEst = pos.pmCost + pos.kalCost; // PM cost + actual Kalshi cost from trade record
  const realizedPnl = Math.round((totalRevenue - totalCostEst) * 100) / 100;

  resolveArbTrade(pos.kalTicker, {
    status: "resolved",
    resolvedTs: new Date().toISOString(),
    resolutionMethod: "settlement",
    realizedPnl,
    scalarSettlement: true,
    kalSettlementValue: svDecimal,
    pmSettlementValue: sellPrice,
    resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}c). PM sold @ ${fmtPct(sellPrice)}.`,
  }, pos.tradeId);
  console.log(
    `[CANC-MON] Trade ${pos.tradeId} resolved: ` +
    `kalPayout=$${kalPayout.toFixed(2)} pmSell~$${pmRevenue.toFixed(2)} P&L~$${realizedPnl.toFixed(2)}`
  );

  // Step 8: Clear hedge state
  if (matchingHs) {
    matchingHs.position.sharesHeld = 0;
    console.log(`[CANC-MON] Cleared hedge state for ${pos.kalTicker}`);
  }
}

// --- Post-fill price verification (fire-and-forget) --------------------------

async function verifyKalFillPrice(
  tradeId: string, orderId: string, ticker: string,
  loggedPrice: number, loggedCost: number, loggedShares: number,
): Promise<void> {
  try {
    const order = await getKalshiOrder(orderId);
    const fillCount = parseFloat(String(order.fill_count_fp ?? order.fill_count ?? "0"));
    const takerCostDollars = parseFloat(String(order.taker_fill_cost_dollars ?? "0"));
    const makerCostDollars = parseFloat(String(order.maker_fill_cost_dollars ?? "0"));
    const actualCost = takerCostDollars > 0 ? takerCostDollars : makerCostDollars;
    if (fillCount <= 0 || actualCost <= 0) return;
    const actualPrice = Math.round((actualCost / fillCount) * 10000) / 10000;
    if (Math.abs(actualPrice - loggedPrice) > 0.005) {
      console.log(`[FILL-VERIFY] KAL hedge ${ticker}: correcting ${(loggedPrice * 100).toFixed(1)}c -> ${(actualPrice * 100).toFixed(1)}c`);
      appendEvent({ type: "fill-correction", tradeId, exchange: "kal", orderId, ticker, tokenId: "", field: "fillPrice", oldValue: loggedPrice, newValue: actualPrice, reason: "rest-order-verify" } as any);
      if (Math.abs(actualCost - loggedCost) > 0.01) {
        appendEvent({ type: "fill-correction", tradeId, exchange: "kal", orderId, ticker, tokenId: "", field: "fillCost", oldValue: loggedCost, newValue: actualCost, reason: "rest-order-verify" } as any);
      }
    }
  } catch { /* best effort */ }
}

async function verifyPmFillPrice(
  tradeId: string, orderId: string, tokenId: string,
  loggedPrice: number, loggedCost: number, loggedShares: number,
): Promise<void> {
  try {
    const actual = await getActualPmFillCost(tokenId, orderId, loggedShares, 0, loggedPrice);
    if (!actual) return;
    if (Math.abs(actual.avgPrice - loggedPrice) > 0.005) {
      console.log(`[FILL-VERIFY] PM hedge ${tokenId.slice(-12)}: correcting ${(loggedPrice * 100).toFixed(1)}c -> ${(actual.avgPrice * 100).toFixed(1)}c`);
      appendEvent({ type: "fill-correction", tradeId, exchange: "pm", orderId, ticker: "", tokenId, field: "fillPrice", oldValue: loggedPrice, newValue: actual.avgPrice, reason: "rest-clob-verify" } as any);
      if (Math.abs(actual.totalCost - loggedCost) > 0.01) {
        appendEvent({ type: "fill-correction", tradeId, exchange: "pm", orderId, ticker: "", tokenId, field: "fillCost", oldValue: loggedCost, newValue: actual.totalCost, reason: "rest-clob-verify" } as any);
      }
    }
  } catch { /* best effort */ }
}

// Per-position lock to prevent concurrent hedge cycles placing duplicate orders
const _hedgeCycleLocks = new Set<string>();

/** Force-release a hedge cycle lock (used by timeout handler in ttExecution.ts). */
export function releaseHedgeCycleLock(tradeId: string): void {
  _hedgeCycleLocks.delete(tradeId);
}

export async function runHedgeCycle(state: HedgeState, clobBase: string): Promise<void> {
  const { position: pos, activeOrders } = state;
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  _hedgeLogCounter++;

  if (pos.sharesHeld <= 0) return;

  // Prevent concurrent hedge cycles for the same position
  if (_hedgeCycleLocks.has(pos.tradeId)) return;
  _hedgeCycleLocks.add(pos.tradeId);
  try {
  // (entire function body is now inside this try block — finally releases the lock)

  // -- Lazy init: capture PM pre-balance if not yet set (for positions created before this change)
  if (pos.pmPreBalance == null || pos.pmPreBalance < 0) {
    try {
      const hedgePmTokenId = pos.heldExchange === "pm"
        ? (pos.pmOppLeg?.tokenId ?? pos.pmLeg.tokenId)
        : pos.pmLeg.tokenId;
      const preBal = await Promise.race([
        getOnChainBalance(hedgePmTokenId),
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error("balance-timeout")), 10_000)),
      ]);
      if (preBal >= 0) {
        pos.pmPreBalance = preBal;
        console.log(`[HEDGE] Captured PM pre-balance: ${preBal} shares`);
      }
    } catch { /* will retry next cycle */ }
  }

  // -- Step 0: Check if the Kalshi market has closed/resolved ------------------
  // If the match finished, the market settles automatically -- no hedging needed.
  // Detect this by checking the market status; if closed/resolved, clear hedge.
  // ALSO: detect scalar (cancelled) settlements and trigger emergency PM sell.

  // Live score early detection (before Kalshi API call -- zero latency)
  // Derive matchCode from arb_trades log: find the "hedging" trade for this kalTicker
  const _hedgeTrade = loadArbTrades().find(t => t.kalTicker === pos.kalLeg.ticker && t.status === "hedging");
  const _hedgeMatchCode = _hedgeTrade?.match ?? "";
  if (_hedgeMatchCode) {
    const _lsFinished = isMatchFinished(_hedgeMatchCode);
    const _lsCancelled = isMatchCancelled(_hedgeMatchCode);
    if (_lsFinished) {
      const ls = getMatchState(_hedgeMatchCode);
      console.log(`[HEDGE] Live score: ${_hedgeMatchCode} FINISHED (${ls?.homeScore ?? "?"}-${ls?.awayScore ?? "?"}, ${ls?.detail}) -- checking Kalshi settlement...`);
    } else if (_lsCancelled) {
      const ls = getMatchState(_hedgeMatchCode);
      console.warn(`[HEDGE] Live score: ${_hedgeMatchCode} ${ls?.status?.toUpperCase() ?? "CANCELLED"} -- scalar settlement risk!`);
    }
  }

  try {
    // Check WS settlement cache first (instant, no REST call needed)
    const wsSettlement = getKalSettlement(pos.kalLeg.ticker);
    let mkt: KalshiMarket;
    let mktStatus: string;

    if (wsSettlement) {
      // WS already told us this market settled — build a synthetic mkt object
      mkt = {
        status: "settled",
        result: wsSettlement.result.toLowerCase(),
        settlement_value: wsSettlement.settlementValue.toString(),
      } as unknown as KalshiMarket;
      mktStatus = "settled";
      console.log(`[HEDGE] Market status from WS: ${pos.kalLeg.ticker} settled result=${wsSettlement.result}`);
    } else {
      // WS hasn't seen a lifecycle event yet — fall back to REST via hedge queue (with 10s timeout)
      const mktRes = await Promise.race([
        kalFetchHedge<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("market-status-timeout")), 10_000)),
      ]);
      mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
      mktStatus = pickString(mkt.status ?? mkt.state ?? "").toLowerCase();
    }

    if (mktStatus === "closed" || mktStatus === "settled" || mktStatus === "resolved" || mktStatus === "finalized") {
      const kalResult = pickString(mkt.result ?? "").toLowerCase();

      // -- Scalar (cancelled) settlement: emergency sell PM tokens ----------
      if (isScalarSettlement(mkt) && pos.heldExchange === "pm" && !_cancelledTickers.has(pos.kalLeg.ticker)) {
        const sv = Number(mkt.settlement_value ?? 0);
        console.error(
          `\n+==================================================================+\n` +
          `|  [!] SCALAR SETTLEMENT in hedge: ${pos.kalLeg.ticker}\n` +
          `|  Result: ${kalResult}  Settlement: ${sv}c\n` +
          `|  Holding ${pos.sharesHeld} PM shares -- triggering emergency sell!\n` +
          `+==================================================================+\n`
        );
        _cancelledTickers.add(pos.kalLeg.ticker);
        _cancelledEventKeys.add(extractEventDateKey(pos.kalLeg.ticker));

        // Cancel all hedge orders
        for (const [oid, ho] of activeOrders) {
          try {
            if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
            else await cancelKalshiOrder(oid, DRY_RUN);
          } catch { /* order may already be gone */ }
        }
        activeOrders.clear();

        // Build an OpenPosition for the emergency sell handler
        const emergencyPos: OpenPosition = {
          kalTicker: pos.kalLeg.ticker,
          pmTokenId: pos.pmLeg.tokenId,
          pmOutcome: pos.pmLeg.outcome,
          pmSlug: "", // not needed for sell
          shares: pos.sharesHeld,
          pmCost: pos.heldExchange === "pm" ? pos.initialCost + pos.hedgeFillCostPm : pos.hedgeFillCostPm,
          kalCost: pos.hedgeFillCostKal, // PM-held branch: Kalshi cost is only from hedge fills
          hedgeCost: pos.hedgeFillCost,
          tickSize: pos.pmLeg.tickSize,
          negRisk: pos.pmLeg.negRisk,
          tradeId: "",
          status: "hedging",
        };
        // handleCancelledPosition will place the sell and resolve the trade
        await handleCancelledPosition(emergencyPos, mkt, [], clobBase);
        pos.sharesHeld = 0;
        return;
      }

      // -- Normal (binary) settlement: standard hedge clearance ------------
      console.warn(
        `\n[HEDGE] Market ${pos.kalLeg.ticker} is ${mktStatus}. Position settles automatically -- clearing hedge.\n`
      );
      // Cancel any resting orders (they'll fail on a closed market anyway)
      for (const [oid, ho] of activeOrders) {
        try {
          if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
          else await cancelKalshiOrder(oid, DRY_RUN);
        } catch { /* market closed -- order may already be gone */ }
      }
      activeOrders.clear();
      // Settlement P&L: we held one leg only (hedge incomplete).
      // Check Kalshi result to see if our side won or lost.
      let settlePnl: number;
      const isScalar = kalResult === "scalar" || (mkt.result === "scalar" && Number(mkt.settlement_value ?? 0) > 0);
      if (isScalar) {
        // Scalar settlement: fractional payout per share (e.g., cancelled match -> 86c)
        const sv = Number(mkt.settlement_value ?? 0);
        const svDec = sv > 1 ? sv / 100 : sv;
        const kalPayout = pos.initialShares * (pos.kalSide === "yes" ? svDec : (1 - svDec));
        const hedgedShares = pos.initialShares - pos.sharesHeld;
        settlePnl = kalPayout + hedgedShares - pos.initialCost - pos.hedgeFillCost - pos.kalFees;
      } else if (pos.heldExchange === "kal") {
        // We hold Kalshi contracts. If our side won -> payout $1/share; if lost -> $0.
        const kalWon = (pos.kalSide === "yes" && kalResult === "yes") || (pos.kalSide === "no" && kalResult === "no");
        const payout = kalWon ? pos.initialShares : 0;
        settlePnl = payout - pos.initialCost - pos.hedgeFillCost - pos.kalFees;
      } else {
        // We hold PM tokens. Kalshi market settled -> PM market should settle too.
        const kalSideWon = (pos.kalSide === "yes" && kalResult === "yes") || (pos.kalSide === "no" && kalResult === "no");
        const pmWon = !kalSideWon && kalResult !== "";
        const hedgedShares = pos.initialShares - pos.sharesHeld;
        const hedgedPayout = hedgedShares; // $1 per hedged share (both legs covered)
        const unhedgedPayout = pmWon ? pos.sharesHeld : 0; // $1 per unhedged share if PM won
        settlePnl = hedgedPayout + unhedgedPayout - pos.initialCost - pos.hedgeFillCost - pos.kalFees;
      }
      console.log(
        `[HEDGE] Settlement P&L: initial=$${pos.initialCost.toFixed(2)}` +
        ` hedgeCost=$${pos.hedgeFillCost.toFixed(2)} result=${kalResult || "unknown"}` +
        ` P&L=$${settlePnl.toFixed(2)}`
      );
      pos.sharesHeld = 0;
      const isPmInit = pos.heldExchange === "pm";
      // kalCost = raw fill cost (no fees). Fees tracked separately via kalFees.
      const kalSettleRaw = isPmInit
        ? pos.hedgeFillCostKal
        : pos.initialCost + pos.hedgeFillCostKal;
      const pmSettleTotal = isPmInit
        ? pos.initialCost + pos.hedgeFillCostPm
        : pos.hedgeFillCostPm;
      const kalSettleCost = Math.round(kalSettleRaw * 100) / 100;
      const kalSettleFees = Math.round(pos.kalFees * 100) / 100;
      const pmSettleCost = Math.round(pmSettleTotal * 100) / 100;
      const settleTotal = Math.round((kalSettleCost + kalSettleFees + pmSettleCost) * 100) / 100;
      resolveArbTrade(pos.kalLeg.ticker, {
        status: "resolved",
        resolvedTs: new Date().toISOString(),
        resolutionMethod: "settlement",
        hedgeCost: pos.hedgeFillCost,
        realizedPnl: settlePnl,
        kalCost: kalSettleCost,
        kalFees: kalSettleFees,
        pmCost: pmSettleCost,
        totalCost: settleTotal,
        kalFillPrice: kalSettleRaw > 0
          ? Math.round((kalSettleRaw / pos.initialShares) * 100) / 100
          : 0,
        pmFillPrice: pmSettleTotal > 0
          ? Math.round((pmSettleTotal / pos.initialShares) * 100) / 100
          : 0,
        initialExchange: pos.heldExchange,
      }, pos.tradeId);
      audit({ module: "hedge", fn: "runHedgeCycle", action: "settlement-resolved", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: pos.initialShares, cost: pos.initialCost + pos.hedgeFillCost, trigger: `market-${mktStatus}`, context: { kalResult, isScalar, settlePnl, heldExchange: pos.heldExchange, initialCost: pos.initialCost, hedgeFillCost: pos.hedgeFillCost, hedgeFillCostKal: pos.hedgeFillCostKal, hedgeFillCostPm: pos.hedgeFillCostPm } });
      appendEvent({
        type: "settlement-detected", tradeId: pos.tradeId, exchange: "kal", orderId: "",
        ticker: pos.kalLeg.ticker, result: kalResult, settlementValue: kalResult === "yes" ? 1 : 0,
        payout: settlePnl + pos.initialCost + pos.hedgeFillCost, source: "kal-ws",
      });
      postResolutionFillAudit(pos.kalLeg.ticker, pos.tradeId).catch(() => {});
      return;
    }
  } catch {
    // Transient error fetching market status -- continue hedge cycle normally.
    // If the market is truly gone, order placement will fail and fetchFailures will clean up.
  }

  // -- Step 0b: Periodically verify PM-held position via on-chain balanceOf ----
  // Every ~50 hedge cycles, check the token is still in the wallet on-chain.
  // Primary: on-chain balanceOf (authoritative). Fallback: data-api.
  if (_hedgeLogCounter > 10 && _hedgeLogCounter % 50 === 0 && pos.heldExchange === "pm") {
    try {
      let held = await getOnChainBalance(pos.pmLeg.tokenId);
      if (held < 0) {
        // RPC failed -- fallback to data-api
        const positions = await fetchPmPositionsCached(0);
        held = sumPmHeld(positions, pos.pmLeg.tokenId);
      }
      if (held <= 0) {
        console.warn(
          `\n[HEDGE] [!] PM position ${pos.pmLeg.outcome} no longer exists in wallet (on-chain verified)!` +
          ` Cancelling all hedge orders and clearing.\n`
        );
        for (const [oid, ho] of activeOrders) {
          try {
            if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
            else await cancelKalshiOrder(oid, DRY_RUN);
          } catch { /* best effort */ }
        }
        activeOrders.clear();
        pos.sharesHeld = 0;
        return;
      }
    } catch (e) {
      console.warn(`[HEDGE] PM position verify failed: ${(e as Error).message}`);
    }
  }

  // -- Step 1: Check fills on all active GTC orders ----------------------------
  // Collect counterpart cancellations here to avoid mutating the map mid-iteration
  const toCancel: Array<{ oid: string; ho: HedgeOrder }> = [];

  for (const [oid, ho] of activeOrders) {
    // Skip dry-run order IDs -- they're fake and will fail API calls
    if (oid.startsWith("dry-")) { activeOrders.delete(oid); continue; }

    // Stale order timeout: if a GTC order has been resting with 0 fills for >2 hours,
    // cancel it instead of checking status via CLOB API (which may hang for settled markets).
    // Reconciliation will resolve the trade when the market settles.
    const STALE_ORDER_MS = 2 * 60 * 60 * 1000; // 2 hours
    if (ho.filledSoFar === 0 && ho.placedAt > 0 && Date.now() - ho.placedAt > STALE_ORDER_MS) {
      console.warn(`[HEDGE] Order ${oid.slice(0, 16)}... (${ho.exchange} ${ho.role}) stale for ${Math.round((Date.now() - ho.placedAt) / 60_000)}min with 0 fills — cancelling.`);
      try {
        if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
        else await cancelKalshiOrder(oid, DRY_RUN);
        console.log(`[HEDGE] Cancelled stale order ${oid.slice(0, 16)}...`);
      } catch { /* order may already be gone on the exchange */ }
      activeOrders.delete(oid);
      continue;
    }

    try {
      let filledShares = 0;
      let orderDone = false;

      if (ho.exchange === "pm") {
        const { filledShares: f, status } = await getPmOrderFills(oid);
        const clobDelta = Math.max(0, f - ho.filledSoFar);
        if (clobDelta > 0 && ho.role === "complete") {
          // CLOB says matched — verify on-chain before crediting.
          // Get PM token ID for the leg being bought.
          const verifyTokenId = pos.heldExchange === "pm"
            ? (pos.pmOppLeg?.tokenId ?? pos.pmLeg.tokenId)
            : pos.pmLeg.tokenId;
          const preBal = pos.pmPreBalance ?? 0;
          const verified = await verifyPmFill(verifyTokenId, clobDelta, preBal, "HEDGE-GTC-VERIFY", oid);
          if (verified > 0) {
            filledShares = verified;
            ho.filledSoFar = Math.max(ho.filledSoFar, f);
            pos.pmPreBalance = (preBal + verified); // update baseline for next fill
          } else {
            console.warn(`[HEDGE] PM GTC CLOB says ${clobDelta} filled but on-chain shows 0 — PHANTOM FILL. Not crediting.`);
            // Don't update filledSoFar — recheck next cycle in case settlement is delayed
          }
        } else if (clobDelta > 0) {
          // Exit orders: less critical, credit from CLOB (we're selling, not buying)
          filledShares = clobDelta;
          ho.filledSoFar = Math.max(ho.filledSoFar, f);
        }
        orderDone = status === "matched" || status === "cancelled";
      } else {
        const order = await getKalshiOrder(oid);
        let totalFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled ?? 0);
        const st = String(order.status ?? "");
        const remaining = Number(order.remaining_count ?? order.remaining_count_fp ?? ho.shares);
        orderDone = st === "executed" || st === "filled" || st === "cancelled" || st === "expired";
        // Log every check so we can diagnose missed fills
        const _logKey = `${st}:${totalFilled}`;
        if (_logKey !== ho._lastLogKey) {
          console.log(`[HEDGE] KAL GTC check: ${oid.slice(0,12)}... status=${st} filled=${totalFilled} remaining=${remaining} prevFilled=${ho.filledSoFar}`);
          ho._lastLogKey = _logKey;
        }
        // Safety: if order is done but fill count is 0, infer from remaining_count.
        // NEVER infer fills from cancelled/expired orders — remaining_count drops to 0
        // on cancellation even with zero fills (Kalshi zeroes it out).
        const isCancelled = st === "cancelled" || st === "canceled" || st === "expired";
        if (orderDone && totalFilled === 0 && !isCancelled && (st === "executed" || st === "filled")) {
          const inferred = ho.shares - remaining;
          if (inferred > 0) {
            console.warn(`[HEDGE] Fill count missing for ${st} order ${oid.slice(0,12)}... -- inferred ${inferred} fills from remaining_count=${remaining}`);
            totalFilled = inferred;
          }
        }
        // Also infer from remaining_count even if not "done" — maker fills may update remaining before status changes
        // But ONLY if the order is still live (not cancelled)
        if (totalFilled === 0 && remaining < ho.shares && !isCancelled) {
          const inferred = ho.shares - remaining;
          console.warn(`[HEDGE] Inferred ${inferred} fills from remaining_count=${remaining} (status=${st}, shares=${ho.shares})`);
          totalFilled = inferred;
        }
        filledShares = Math.max(0, totalFilled - ho.filledSoFar);
        ho.filledSoFar = Math.max(ho.filledSoFar, totalFilled);
        // Extract ACTUAL fill cost from order response (REST = ground truth, not WS limit price)
        const _takerCostDollars = Number(order.taker_fill_cost_dollars ?? 0);
        const _makerCostDollars = Number(order.maker_fill_cost_dollars ?? 0);
        const _actualTotalCost = _takerCostDollars > 0 ? _takerCostDollars : _makerCostDollars;
        // Compute actual price per share from REST (falls back to ho.price if REST cost unavailable)
        if (_actualTotalCost > 0 && totalFilled > 0) {
          ho.price = Math.round((_actualTotalCost / totalFilled) * 10000) / 10000;
        }
        // Extract Kalshi fees from order response (cumulative total -> track delta)
        // Use _dollars fields first (newer API format), fall back to cents fields.
        const _takerDollars = Number(order.taker_fees_dollars ?? 0);
        const _makerDollars = Number(order.maker_fees_dollars ?? 0);
        const _takerCents = Number(order.taker_fees ?? 0);
        const _makerCents = Number(order.maker_fees ?? 0);
        const kalOrdFees = (_takerDollars + _makerDollars) || ((_takerCents + _makerCents) / 100);
        const prevFees = ho._lastFeeSeen ?? 0;
        ho._lastFeeSeen = kalOrdFees;
        ho._feeDelta = kalOrdFees - prevFees;
        // Log Kalshi order status only when it changes or every ~30s (75 cycles x 400ms)
        const logKey = `${st}:${totalFilled}`;
        if (orderDone || filledShares > 0 || ho._lastLogKey !== logKey) {
          console.log(`[HEDGE] KAL order ${oid.slice(0,12)}... status=${st} filled=${totalFilled}/${ho.shares} remaining=${order.remaining_count ?? "?"} actualCost=$${_actualTotalCost.toFixed(2)} price=${fmtPct(ho.price)}`);
          ho._lastLogKey = logKey;
        }
      }

      if (filledShares > 0) {
        pos.sharesHeld = Math.max(0, pos.sharesHeld - filledShares);
        // Dust threshold: PM fills can leave sub-share remainders (e.g. 0.001).
        // Treat < 0.5 shares as complete — PM can't fill these and the hedge cycle
        // would keep placing full-size orders for dust, causing over-buying on restart.
        if (pos.sharesHeld > 0 && pos.sharesHeld < 0.5) {
          console.log(`[HEDGE] Rounding dust: ${pos.sharesHeld.toFixed(4)} shares -> 0 (below 0.5 threshold)`);
          pos.sharesHeld = 0;
        }
        if (ho.role === "complete") {
          if (ho.exchange === "kal") {
            pos.hedgeFillCost += filledShares * ho.price;
            pos.hedgeFillCostKal += filledShares * ho.price;
            // Add Kalshi fee delta (not cumulative total -- prevents double-counting on incremental fills)
            const feeDelta = ho._feeDelta ?? 0;
            if (feeDelta > 0) pos.kalFees += feeDelta;
          } else {
            // PM GTC: typically fills as maker (0% fee) since IOC sweep handles taker fills.
            // GTC is placed at breakeven (below current ask) → rests on book → maker fill.
            pos.hedgeFillCost += filledShares * ho.price;
            pos.hedgeFillCostPm += filledShares * ho.price;
          }
        }
        console.log(
          `\n[HEDGE] ${ho.exchange.toUpperCase()} ${ho.role} filled ${filledShares} @${fmtPct(ho.price)}.` +
          ` Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`
        );
        audit({ module: "hedge", fn: "runHedgeCycle", action: "hedge-fill-detected", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: filledShares, price: ho.price, cost: pos.hedgeFillCost, context: { exchange: ho.exchange, role: ho.role, orderId: oid, remaining: pos.sharesHeld, hedgeFillCostKal: pos.hedgeFillCostKal, hedgeFillCostPm: pos.hedgeFillCostPm, kalFees: pos.kalFees } });
        // Event log: hedge fill detected
        // For KAL: compute actual fill price from order's fill cost (not limit price)
        // For PM: use ho.price as best available (actual price from CLOB verification)
        const _evtFillPrice = ho.exchange === "kal" && ho.filledSoFar > 0
          ? Math.round((pos.hedgeFillCostKal / ho.filledSoFar) * 10000) / 10000
          : ho.price;
        // Side: for hedge orders, it's the OPPOSITE of what we hold
        const _evtSide = ho.exchange === "kal"
          ? (pos.kalSide === "yes" ? "no" : "yes") // hedge buys opposite KAL side
          : "BUY"; // PM hedge is always a BUY
        appendEvent({
          type: "fill-detected", tradeId: pos.tradeId, exchange: ho.exchange as "kal" | "pm", orderId: oid,
          ticker: pos.kalLeg.ticker, tokenId: ho.exchange === "pm" ? (pos.pmOppLeg?.tokenId ?? pos.pmLeg.tokenId) : "",
          side: _evtSide,
          fillShares: filledShares, fillPrice: _evtFillPrice, fillCost: filledShares * _evtFillPrice,
          fees: ho._feeDelta ?? 0, cumulativeFilled: ho.filledSoFar,
          source: ho.exchange === "pm" ? "clob-trades" : "rest-poll",
        });
        // Post-fill REST verification for PM (KAL path uses hedgeFillCostKal which is already REST-based)
        if (ho.exchange === "pm") {
          const pmTid = pos.pmOppLeg?.tokenId ?? pos.pmLeg.tokenId;
          verifyPmFillPrice(pos.tradeId, oid, pmTid, _evtFillPrice, filledShares * _evtFillPrice, filledShares).catch(() => {});
        }
        // -- Cancel-on-fill race --------------------------------------------
        // complete fills -> cancel ALL other orders (other completes + exits):
        //   arb resolved on this exchange, don't let the other complete overbuy
        // exit fills -> cancel complete orders only:
        //   position sold, no longer need to complete the hedge
        if (ho.role === "complete") {
          for (const [coid, cho] of activeOrders) {
            if (coid !== oid) toCancel.push({ oid: coid, ho: cho });
          }
        } else {
          for (const [coid, cho] of activeOrders) {
            if (cho.role === "complete" && coid !== oid) toCancel.push({ oid: coid, ho: cho });
          }
        }
      }

      ho.fetchFailures = 0; // successful fetch -- reset counter
      if (orderDone || pos.sharesHeld <= 0) activeOrders.delete(oid);
    } catch (err) {
      // Transient errors: keep the order and retry next cycle.
      // After 10 consecutive failures, CANCEL the order on the exchange before removing it
      // from tracking -- this prevents orphaned live orders that accumulate and all fill
      // simultaneously when volume finally appears (causing oversized positions).
      ho.fetchFailures = (ho.fetchFailures ?? 0) + 1;
      if (ho.fetchFailures === 1 || ho.fetchFailures % 5 === 0) {
        console.warn(`[HEDGE] Order ${oid.slice(0, 16)}... (${ho.exchange} ${ho.role}) status check fail #${ho.fetchFailures}: ${(err as Error).message ?? err}`);
      }
      if (ho.fetchFailures >= 10) {
        console.warn(`[HEDGE] Order ${oid} (${ho.exchange} ${ho.role}) failed status check 10x -- cancelling on exchange and removing.`);
        try {
          if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
          else await cancelKalshiOrder(oid, DRY_RUN);
          console.log(`[HEDGE] Cancelled orphan order ${oid.slice(0, 16)}...`);
        } catch { /* order may already be gone on the exchange -- safe to remove */ }
        activeOrders.delete(oid);
      }
    }
  }

  // -- Cancel counterpart orders collected above (deduplicated) -----------------
  const cancelSeen = new Set<string>();
  for (const { oid, ho: cho } of toCancel) {
    if (cancelSeen.has(oid)) continue;  // duplicate from multiple fills in same cycle
    cancelSeen.add(oid);
    if (!activeOrders.has(oid)) continue; // already removed (filled or expired)
    try {
      if (cho.exchange === "pm") {
        await cancelPmOrder(oid, DRY_RUN);
      } else {
        await cancelKalshiOrder(oid, DRY_RUN);
      }
      activeOrders.delete(oid);
      console.log(
        `[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} order ${oid}` +
        ` -- other side filled first (race resolved).`
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Order already gone (executed/expired) -- clean it from activeOrders
      if (msg.includes("404") || msg.includes("not_found") || msg.includes("Not Found")) {
        activeOrders.delete(oid);
        console.warn(
          `[HEDGE] ${cho.exchange.toUpperCase()} ${cho.role} order ${oid} already gone (likely filled). Removed from tracking.`
        );
      } else {
        console.error(
          `[HEDGE] Failed to cancel ${cho.exchange.toUpperCase()} ${cho.role} order ${oid}: ${msg}`
        );
      }
    }
  }

  if (pos.sharesHeld <= 0) return;

  let sharesNeeded = pos.sharesHeld;

  if (pos.heldExchange === "pm") {
    // -- Held PM token, missing the Kalshi leg ----------------------------------
    // We own pmLeg (e.g. P2_token). We need EITHER:
    //   complete-kal: buy Kalshi P1_YES at <= maxKalPrice
    //   complete-pm:  buy PM P1_token (pmOppLeg) at <= maxOppPrice  (P1+P2 tokens -> $1)
    // Simultaneously exit: sell pmLeg at best ask >= cost basis
    // First fill on any complete -> cancel the other complete + exit
    // First fill on exit -> cancel all completes
    // payout mode: accept any fill up to breakeven; profit mode: require MIN_EDGE margin
    const hedgeEdge = HEDGE_TARGET === "payout" ? 0 : MIN_EDGE;
    // Deduct estimated completing-leg fees.
    // KAL completing: KALSHI_FEE_RATE x P x (1-P).
    // PM opposite completing via GTC (maker = 0% fee). KAL IOC completing (taker = 7% fee).
    const estCompletePrice = 1 - pos.pmCostBasis;
    const kalFeeReserve = KALSHI_FEE_RATE * estCompletePrice * (1 - estCompletePrice);
    // PM GTC placed above ask fills as TAKER (3% fee). Reserve for it.
    const estPmOppPrice = 1 - pos.pmCostBasis - hedgeEdge;
    const pmOppFeeReserve = PM_FEE_RATE * estPmOppPrice * (1 - estPmOppPrice);
    const maxKalPrice = 1 - pos.pmCostBasis - hedgeEdge - kalFeeReserve;
    const maxOppPrice = 1 - pos.pmCostBasis - hedgeEdge - pmOppFeeReserve;
    // Safety: log breakeven calculation on first hedge cycle
    if (!state.lastCompleteExchange) {
      console.log(`[HEDGE] PM-held breakeven: pmCostBasis=${fmtPct(pos.pmCostBasis)} maxKalPrice=${fmtPct(maxKalPrice)} maxOppPrice=${fmtPct(maxOppPrice)} shares=${sharesNeeded}`);
    }

    // -- PM-held hedge strategy:
    // Phase 1 (first 60s): try KAL IOC sweeps — fast, aggressive, no resting orders
    // Phase 2 (after 60s): switch to PM opposite token permanently — 0% fees, GTC resting
    // Never place on both exchanges simultaneously.
    const pmDelayed = (state.pmNextRetryAt ?? 0) > Date.now();
    if (pmDelayed) {
      console.log(`[HEDGE] PM delayed: waiting ${Math.ceil(((state.pmNextRetryAt ?? 0) - Date.now()) / 1000)}s for possible delayed settlement`);
    }
    // Track when hedging started for the 60s KAL window
    if (!state._hedgeStartTs) state._hedgeStartTs = Date.now();
    const kalWindowExpired = Date.now() - (state._hedgeStartTs ?? Date.now()) > 60_000;
    const inKalPhase = !kalWindowExpired && !isPmServiceDown();

    // -- IOC sweeps: aggressively grab available asks each cycle -----------------
    // Phase 1: Sweep Kalshi ask (only during first 60s)
    // Use WS data (instant, no API queue). Fall back to REST only if WS is stale.
    if (inKalPhase && Date.now() >= state.kalNextRetryAt) {
      let kalCurrentAsk = getWsKalBestAsk(pos.kalLeg.ticker, pos.kalSide);
      if (kalCurrentAsk === null) {
        // WS stale — fall back to REST via dedicated hedge queue
        try {
          const { ask: kalYesAsk, noAsk: kalNoAsk } = await Promise.race([
            kalFetchHedge<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`).then(res => {
              const mkt = res.market ?? res as unknown as KalshiMarket;
              return {
                ask: mkt.yes_ask_dollars !== undefined ? normDollarsOrCents(mkt.yes_ask_dollars) : normCents(mkt.yes_ask),
                noAsk: mkt.no_ask_dollars !== undefined ? normDollarsOrCents(mkt.no_ask_dollars) : normCents(mkt.no_ask),
              };
            }),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("kal-market-timeout")), 10_000)),
          ]);
          kalCurrentAsk = pos.kalSide === "yes" ? kalYesAsk : kalNoAsk;
        } catch { kalCurrentAsk = null; }
      }
      if (kalCurrentAsk !== null && kalCurrentAsk <= maxKalPrice && sharesNeeded > 0) {
        const ioOrder = buildKalshiIOCOrder(pos.kalLeg.ticker, kalCurrentAsk, sharesNeeded, pos.kalSide);
        try {
          const res = await placeKalshiOrder(ioOrder, DRY_RUN);
          const meta = extractKalMeta(res);
          const filled = DRY_RUN ? sharesNeeded : meta.filled;
          if (filled > 0) {
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * kalCurrentAsk;
            pos.hedgeFillCostKal += filled * kalCurrentAsk;
            pos.kalFees += meta.fees;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC Kalshi ${pos.kalSide.toUpperCase()} filled ${filled}@${fmtPct(kalCurrentAsk)} fee=$${meta.fees.toFixed(2)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
            appendEvent({
              type: "fill-detected", tradeId: pos.tradeId, exchange: "kal",
              orderId: meta.orderId ? String(meta.orderId) : "", ticker: pos.kalLeg.ticker,
              tokenId: "", side: pos.kalSide,
              fillShares: filled, fillPrice: kalCurrentAsk,
              fillCost: filled * kalCurrentAsk, fees: meta.fees,
              cumulativeFilled: filled, source: "order-response",
            } as Omit<FillDetectedEvent, "seq" | "ts">);
            state.pmOnlyCycles = 0; // reset: switch back to PM-first on next cycle
            await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
            saveHedgeState(state);
            sharesNeeded = pos.sharesHeld;
            if (pos.sharesHeld <= 0) return;
          } else {
            state.kalNextRetryAt = Date.now() + 30_000;
          }
        } catch (e) {
          console.error(`[HEDGE] IOC Kalshi ${pos.kalSide.toUpperCase()} sweep failed: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }
    }
    // Phase 2: Sweep PM opposite token (pmOppLeg) ask — after 60s KAL window
    // Use WS data first (instant). Fall back to REST if WS stale.
    // GUARD: Skip IOC sweep if a GTC complete order is already active on PM.
    // Both orders target the same token; PM sports delay means both can fill before
    // either is detected, causing double-buys (IOC fills + GTC fills = 2x shares).
    const hasActivePmCompleteOrder = [...activeOrders.values()].some(o => o.role === "complete" && o.exchange === "pm");
    if (!inKalPhase && !pmDelayed && pos.pmOppLeg && sharesNeeded >= 5 && !hasActivePmCompleteOrder) {
      let oppCurrentAsk = getWsPmBestAsk(pos.pmOppLeg.tokenId);
      if (oppCurrentAsk === null) {
        oppCurrentAsk = await Promise.race([
          fetchPmAsk(pos.pmOppLeg.tokenId, clobBase),
          new Promise<null>((res) => setTimeout(() => res(null), 10_000)),
        ]);
      }
      // IOC sweep is taker — check that ask + taker fee fits within breakeven
      const pmTakerFeeAtAsk = oppCurrentAsk !== null ? PM_FEE_RATE * oppCurrentAsk * (1 - oppCurrentAsk) : 0;
      const maxOppPriceTaker = maxOppPrice - pmTakerFeeAtAsk; // tighter limit for taker IOC
      if (oppCurrentAsk !== null && oppCurrentAsk <= maxOppPriceTaker && sharesNeeded * oppCurrentAsk >= PM_MARKETABLE_MIN_VALUE) {
        try {
          const res = await placePmFOK(pos.pmOppLeg.tokenId, oppCurrentAsk, sharesNeeded, pos.pmOppLeg.tickSize, pos.pmOppLeg.negRisk, DRY_RUN);
          const meta = extractPmMeta(res);
          let filled = 0;
          if (DRY_RUN) {
            filled = sharesNeeded;
          } else if (meta.status === "matched" || meta.status === "delayed") {
            // CLOB says matched or delayed — verify on-chain before crediting
            if (meta.status === "delayed" && meta.orderId) {
              console.log(`  [HEDGE] PM opp-sweep on-chain pending, waiting for confirmation...`);
              await waitForPmOrderFill(String(meta.orderId), 60_000, pos.pmOppLeg?.tokenId);
            }
            const preBal = pos.pmPreBalance ?? 0;
            const verified = await verifyPmFill(pos.pmOppLeg!.tokenId, sharesNeeded, preBal, "HEDGE-IOC-PM", meta.orderId ? String(meta.orderId) : undefined);
            if (verified > 0) {
              filled = verified;
              pos.pmPreBalance = (preBal + verified);
            } else {
              console.warn(`[HEDGE] PM IOC CLOB status=${meta.status} but on-chain shows 0 — phantom fill, not crediting`);
            }
          }
          if (filled > 0) {
            const pmIocFee = PM_FEE_RATE * oppCurrentAsk * (1 - oppCurrentAsk) * filled;
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * oppCurrentAsk + pmIocFee;
            pos.hedgeFillCostPm += filled * oppCurrentAsk + pmIocFee;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC PM ${pos.pmOppLeg.outcome} on-chain verified ${filled}@${fmtPct(oppCurrentAsk)} +fee $${pmIocFee.toFixed(3)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
            appendEvent({
              type: "fill-detected", tradeId: pos.tradeId, exchange: "pm",
              orderId: meta.orderId ? String(meta.orderId) : "", ticker: pos.kalLeg.ticker,
              tokenId: pos.pmOppLeg!.tokenId, side: pos.pmOppLeg!.outcome,
              fillShares: filled, fillPrice: oppCurrentAsk,
              fillCost: filled * oppCurrentAsk, fees: 0,
              cumulativeFilled: filled, source: "onchain",
            } as Omit<FillDetectedEvent, "seq" | "ts">);
            await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
            saveHedgeState(state);
            sharesNeeded = pos.sharesHeld;
            if (pos.sharesHeld <= 0) return;
          }
        } catch (e) {
          console.error(`[HEDGE] IOC PM opposite sweep failed: ${(e as Error).message}`);
        }
      }
    }

    // -- GTC placement: PM only after 60s KAL window expires ---------------------
    // During KAL phase (first 60s): IOC sweeps only, no resting GTC
    // After KAL phase: place PM GTC on opposite token, keep it resting, don't replace
    const hasAnyComplete = [...activeOrders.values()].some(o => o.role === "complete");
    if (!hasAnyComplete && sharesNeeded > 0 && !inKalPhase) {
      // Re-check market status before placing a new order (WS first, REST fallback)
      if (isKalMarketSettled(pos.kalLeg.ticker)) {
        console.log(`[HEDGE] Market ${pos.kalLeg.ticker} settled (WS) -- skipping new order. Will resolve on next cycle.`);
        saveHedgeState(state);
        return;
      }
      try {
        const recheck = await Promise.race([
          kalFetchHedge<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("recheck-timeout")), 10_000)),
        ]);
        const recheckMkt = recheck.market ?? recheck as unknown as KalshiMarket;
        const recheckStatus = pickString(recheckMkt.status ?? recheckMkt.state ?? "").toLowerCase();
        if (recheckStatus === "closed" || recheckStatus === "settled" || recheckStatus === "resolved" || recheckStatus === "finalized") {
          console.log(`[HEDGE] Market ${pos.kalLeg.ticker} is now ${recheckStatus} -- skipping new order. Will resolve on next cycle.`);
          saveHedgeState(state);
          return;
        }
      } catch { /* non-critical -- proceed with order placement */ }

      // PM-held: always hedge on PM opposite token (0% fees)
      const pmViable = !pmDelayed && pos.pmOppLeg && !isPmServiceDown() && sharesNeeded >= 5;
      let placed = false;

      if (false) {
        // KAL GTC path removed — PM-held trades always hedge on PM
        // -- Try Kalshi GTC YES bid ------------------------------------------
        const kalPriceCents = Math.max(1, Math.min(99, Math.floor(maxKalPrice * 100 + 1e-9)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", pos.kalSide, kalPriceCents, sharesNeeded);
        try {
          console.log(`[HEDGE] Placing Kalshi GTC: ticker=${pos.kalLeg.ticker} side=${pos.kalSide} price=${kalPriceCents}c qty=${sharesNeeded}`);
          const res = await placeKalshiOrder(order, DRY_RUN);
          console.log(`[HEDGE] Kalshi GTC raw response: ${JSON.stringify(res).slice(0, 300)}`);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalPriceCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            state.lastCompleteExchange = "kal";
            saveHedgeState(state);
            console.log(`[HEDGE] Placed Kalshi GTC BID ${sharesNeeded}x${pos.kalSide.toUpperCase()}@${fmtPct(kalPriceCents / 100)} (complete-kal). orderId=${oid}`);
            audit({ module: "hedge", fn: "runHedgeCycle", action: "hedge-gtc-kal-placed", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: sharesNeeded, price: kalPriceCents / 100, context: { orderId: oid, side: pos.kalSide, role: "complete", heldExchange: pos.heldExchange } });
            appendEvent({
              type: "order-placed", tradeId: pos.tradeId, exchange: "kal",
              orderId: oid, role: "hedge-complete", side: pos.kalSide,
              ticker: pos.kalLeg.ticker, tokenId: "",
              requestedShares: sharesNeeded, limitPrice: kalPriceCents / 100, orderType: "GTC",
            } as Omit<OrderPlacedEvent, "seq" | "ts">);

            // Register WS listeners for real-time fill detection (backup to REST polling)
            if (!DRY_RUN) {
              registerKalFillListener(oid, (fillEvt: KalFillEvent) => {
                const fillCount = Number(fillEvt.count_fp ?? 0);
                const ho = activeOrders.get(oid);
                if (!ho || fillCount <= 0) return;
                const delta = fillCount; // Each fill event is incremental
                // Get actual fill cost from REST before crediting (don't use ho.price / WS data)
                getKalshiOrder(oid).then(order => {
                  const takerCost = Number(order.taker_fill_cost_dollars ?? 0);
                  const makerCost = Number(order.maker_fill_cost_dollars ?? 0);
                  const actualCost = takerCost > 0 ? takerCost : makerCost;
                  const totalFilled = Number(order.fill_count_fp ?? order.fill_count ?? 0) || delta;
                  const orderStatus = String(order.status ?? "");
                  const isCancelled = orderStatus === "cancelled" || orderStatus === "canceled" || orderStatus === "expired";
                  // Never credit fills on cancelled orders or when REST shows zero cost
                  if (isCancelled || (totalFilled === 0 && actualCost === 0)) return;
                  if (actualCost > 0 && totalFilled > 0) {
                    ho.price = Math.round((actualCost / totalFilled) * 10000) / 10000;
                  }
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - delta);
                  pos.hedgeFillCost += delta * ho.price;
                  pos.hedgeFillCostKal += delta * ho.price;
                  ho.filledSoFar += delta;
                  console.log(`\n[HEDGE WS] ✓ KAL fill via WS: ${delta}x${fillEvt.side} on ${fillEvt.market_ticker} (order ${oid.slice(0,12)}...) actualPrice=${(ho.price * 100).toFixed(1)}c. Remaining: ${pos.sharesHeld}`);
                  audit({ module: "hedge", fn: "wsKalFill", action: "hedge-ws-kal-fill", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: delta, price: ho.price, context: { orderId: oid, fillCount, side: fillEvt.side, isTaker: fillEvt.is_taker, actualCost } });
                  appendEvent({
                    type: "fill-detected", tradeId: pos.tradeId, exchange: "kal",
                    orderId: oid, ticker: pos.kalLeg.ticker, tokenId: "",
                    side: fillEvt.side, fillShares: delta, fillPrice: ho.price,
                    fillCost: delta * ho.price, fees: 0,
                    cumulativeFilled: ho.filledSoFar, source: "ws-mined",
                  } as Omit<FillDetectedEvent, "seq" | "ts">);
                  saveHedgeState(state);
                if (pos.sharesHeld <= 0) {
                  // Fully hedged — cancel other orders and clean up
                  for (const [coid] of activeOrders) {
                    if (coid !== oid) {
                      try { cancelKalshiOrder(coid, false).catch(() => {}); } catch { /* */ }
                      try { cancelPmOrder(coid, false).catch(() => {}); } catch { /* */ }
                    }
                    unregisterKalListeners(coid);
                  }
                }
                }).catch(() => { /* REST failed — next poll will pick up the fill */ });
              });
              registerKalOrderListener(oid, (orderEvt: KalOrderEvent) => {
                const ho = activeOrders.get(oid);
                if (!ho) return;
                const st = orderEvt.status;
                // Get actual fill cost from REST before crediting
                getKalshiOrder(oid).then(order => {
                  const takerCost = Number(order.taker_fill_cost_dollars ?? 0);
                  const makerCost = Number(order.maker_fill_cost_dollars ?? 0);
                  const actualCost = takerCost > 0 ? takerCost : makerCost;
                  const filled = Number(order.fill_count_fp ?? order.fill_count ?? 0);
                  const remaining = Number(order.remaining_count ?? order.remaining_count_fp ?? ho.shares);
                  const orderStatus = String(order.status ?? "");
                  const isCancelled = orderStatus === "cancelled" || orderStatus === "canceled" || orderStatus === "expired";
                  // Never credit fills on cancelled orders or when REST shows zero cost
                  if (isCancelled || (filled === 0 && actualCost === 0)) return;
                  if (actualCost > 0 && filled > 0) {
                    ho.price = Math.round((actualCost / filled) * 10000) / 10000;
                  }
                  const inferredFills = filled > 0 ? filled : Math.max(0, ho.shares - remaining);
                  if (inferredFills > ho.filledSoFar) {
                    const delta = inferredFills - ho.filledSoFar;
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - delta);
                  pos.hedgeFillCost += delta * ho.price;
                  pos.hedgeFillCostKal += delta * ho.price;
                  ho.filledSoFar = inferredFills;
                  console.log(`\n[HEDGE WS] ✓ KAL order update: ${oid.slice(0,12)}... status=${orderEvt.status} filled=${inferredFills} remaining=${remaining} actualPrice=${(ho.price * 100).toFixed(1)}c. Shares left: ${pos.sharesHeld}`);
                  audit({ module: "hedge", fn: "wsKalOrder", action: "hedge-ws-kal-order-fill", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: delta, context: { orderId: oid, status: orderEvt.status, filled, remaining, inferred: inferredFills, actualCost } });
                  appendEvent({
                    type: "fill-detected", tradeId: pos.tradeId, exchange: "kal",
                    orderId: oid, ticker: pos.kalLeg.ticker, tokenId: "",
                    side: pos.kalSide, fillShares: delta, fillPrice: ho.price,
                    fillCost: delta * ho.price, fees: 0,
                    cumulativeFilled: inferredFills, source: "ws-mined",
                  } as Omit<FillDetectedEvent, "seq" | "ts">);
                  saveHedgeState(state);
                  }
                }).catch(() => { /* REST failed — next poll will pick up the fill */ });
              });
            }

            placed = true;
            // Verify -- if filled immediately, update and return
            try {
              const check = await getKalshiOrder(oid);
              const checkStatus = String(check.status ?? "");
              const checkRemaining = Number(check.remaining_count ?? sharesNeeded);
              console.log(`[HEDGE] Kalshi GTC verify: status=${checkStatus} remaining=${checkRemaining}`);
              if (checkStatus === "executed" || checkStatus === "filled") {
                const immediatelyFilled = sharesNeeded - checkRemaining;
                if (immediatelyFilled > 0) {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - immediatelyFilled);
                  pos.hedgeFillCost += immediatelyFilled * (kalPriceCents / 100);
                  pos.hedgeFillCostKal += immediatelyFilled * (kalPriceCents / 100);
                  // Track fees from immediate GTC fill
                  const immMeta = extractKalMeta(check);
                  if (immMeta.fees > 0) pos.kalFees += immMeta.fees;
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] Kalshi GTC filled immediately (${immediatelyFilled}). sharesHeld=${pos.sharesHeld} fee=$${immMeta.fees.toFixed(2)} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              }
            } catch (ve) {
              console.error(`[HEDGE] Kalshi GTC verify FAILED: ${(ve as Error).message}`);
            }
          } else {
            console.warn(`[HEDGE] Kalshi GTC placed but no orderId returned. Full response: ${JSON.stringify(res).slice(0, 300)}`);
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC bid: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }

      // -- PM GTC bid (the only hedge path for PM-held trades) ---------------
      // If PM fails due to insufficient balance, fall back to KAL GTC.
      let pmBalanceFailed = false;
      if (!placed && pmViable && pos.pmOppLeg) {
        const oppTick = pos.pmOppLeg.tickSize || 0.01;
        const oppBidPrice = Math.round(Math.floor(maxOppPrice / oppTick + 1e-9) * oppTick * 1e6) / 1e6;
        if (oppBidPrice > 0 && sharesNeeded * oppBidPrice >= PM_MARKETABLE_MIN_VALUE) {
          try {
            const res = await placePmGTCBid(pos.pmOppLeg.tokenId, oppBidPrice, sharesNeeded, oppTick, pos.pmOppLeg.negRisk, DRY_RUN);
            const resStr = JSON.stringify(res).toLowerCase();
            if (resStr.includes("not_enough_balance") || resStr.includes("insufficient") || resStr.includes("allowance")) {
              console.warn(`[HEDGE] PM balance insufficient for ${sharesNeeded}x@${fmtPct(oppBidPrice)}. Falling back to KAL.`);
              pmBalanceFailed = true;
            } else if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-opp-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "complete", exchange: "pm", orderId: oid, price: oppBidPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                state.lastCompleteExchange = "pm";
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC BID ${sharesNeeded}x${pos.pmOppLeg.outcome}@${fmtPct(oppBidPrice)} (complete-pm). orderId=${oid}`);
                audit({ module: "hedge", fn: "runHedgeCycle", action: "hedge-gtc-pm-placed", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: sharesNeeded, price: oppBidPrice, context: { orderId: oid, outcome: pos.pmOppLeg.outcome, role: "complete", heldExchange: "pm" } });
                appendEvent({
                  type: "order-placed", tradeId: pos.tradeId, exchange: "pm",
                  orderId: oid, role: "hedge-complete", side: pos.pmOppLeg.outcome,
                  ticker: pos.kalLeg.ticker, tokenId: pos.pmOppLeg.tokenId,
                  requestedShares: sharesNeeded, limitPrice: oppBidPrice, orderType: "GTC",
                } as Omit<OrderPlacedEvent, "seq" | "ts">);
                if (!DRY_RUN && meta.status === "matched") {
                  // CLOB says matched — verify on-chain before crediting
                  const preBal = pos.pmPreBalance ?? 0;
                  const verified = await verifyPmFill(pos.pmOppLeg!.tokenId, sharesNeeded, preBal, "HEDGE-GTC-IMM-PM", oid);
                  if (verified > 0) {
                    pos.sharesHeld = Math.max(0, pos.sharesHeld - verified);
                    pos.hedgeFillCost += verified * oppBidPrice;
                    pos.hedgeFillCostPm += verified * oppBidPrice;
                    pos.pmPreBalance = (preBal + verified);
                    activeOrders.delete(oid);
                    console.log(`[HEDGE] PM GTC on-chain verified (${verified}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  } else {
                    console.warn(`[HEDGE] PM GTC CLOB matched but on-chain shows 0 — keeping order active for re-check`);
                    // Don't delete from activeOrders — the GTC polling will re-verify next cycle
                  }
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              } else {
                console.warn(`[HEDGE] PM GTC bid returned no orderId. Response: ${JSON.stringify(res).slice(0, 200)}`);
              }
            }
          } catch (e) {
            console.error(`[HEDGE] Failed to place PM GTC bid: ${(e as Error).message}`);
          }
        } else {
          console.warn(`[HEDGE] PM complete skipped: oppBidPrice=${oppBidPrice} (maxOpp=${fmtPct(maxOppPrice)} tick=${oppTick})`);
        }
      } else if (!placed && !pos.pmOppLeg) {
        console.warn(`[HEDGE] PM complete skipped: pmOppLeg is null`);
      }

      // -- KAL fallback: when PM can't be used (shares < 5 or PM balance insufficient) --
      if (!placed && sharesNeeded > 0 && (sharesNeeded < 5 || pmBalanceFailed)) {
        // KAL GTC fills as maker (1.75% fee) — use maker fee for breakeven
        const kalMakerFeeReserve = KALSHI_MAKER_FEE_RATE * estCompletePrice * (1 - estCompletePrice);
        const maxKalPriceMaker = 1 - pos.pmCostBasis - hedgeEdge - kalMakerFeeReserve;
        const kalPriceCents = Math.max(1, Math.min(99, Math.floor(maxKalPriceMaker * 100 + 1e-9)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", pos.kalSide, kalPriceCents, sharesNeeded);
        try {
          const reason = pmBalanceFailed ? "pm-balance-insufficient" : "pm-min-size-fallback";
          console.log(`[HEDGE] ${pmBalanceFailed ? "PM balance insufficient" : "PM min size too high (need "+sharesNeeded+" < 5)"}. Falling back to KAL GTC @ ${kalPriceCents}c`);
          const res = await placeKalshiOrder(order, DRY_RUN);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-fb-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalPriceCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            saveHedgeState(state);
            console.log(`[HEDGE] Placed KAL GTC fallback ${sharesNeeded}x${pos.kalSide.toUpperCase()}@${fmtPct(kalPriceCents / 100)}. orderId=${oid}`);
            audit({ module: "hedge", fn: "runHedgeCycle", action: "hedge-gtc-kal-placed", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: sharesNeeded, price: kalPriceCents / 100, context: { orderId: oid, side: pos.kalSide, role: "complete", reason } });
            appendEvent({
              type: "order-placed", tradeId: pos.tradeId, exchange: "kal",
              orderId: oid, role: "hedge-complete", side: pos.kalSide,
              ticker: pos.kalLeg.ticker, tokenId: "",
              requestedShares: sharesNeeded, limitPrice: kalPriceCents / 100, orderType: "GTC",
            } as Omit<OrderPlacedEvent, "seq" | "ts">);
          }
        } catch (e) {
          console.error(`[HEDGE] KAL fallback GTC failed: ${(e as Error).message}`);
        }
      }
    }

    // -- exit: GTC ask on PM to sell our held token at cost basis (skipped if STRICT_HEDGE)
    // Always place at cost basis -- the GTC rests on the book until price comes back up.
    if (!STRICT_HEDGE) {
      const hasPmExit = [...activeOrders.values()].some(o => o.role === "exit" && o.exchange === "pm");
      if (!hasPmExit && !isPmServiceDown() && sharesNeeded >= 5) {
        const exitTick = pos.pmLeg.tickSize || 0.01;
        const exitPrice = Math.ceil(pos.pmCostBasis / exitTick) * exitTick; // round UP to nearest tick
        if (exitPrice > 0 && exitPrice < 1) {
          try {
            const res = await placePmGTCAsk(pos.pmLeg.tokenId, exitPrice, sharesNeeded, exitTick, pos.pmLeg.negRisk, DRY_RUN);
            if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-exit-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "exit", exchange: "pm", orderId: oid, price: exitPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC ASK ${sharesNeeded}x@${fmtPct(exitPrice)} (exit at cost). orderId=${oid}`);
              } else {
                console.warn(`[HEDGE] PM exit returned no orderId. Response: ${JSON.stringify(res).slice(0, 200)}`);
              }
            }
          } catch (e) {
            console.error(`[HEDGE] Failed to place PM GTC ask: ${(e as Error).message}`);
          }
        }
      }
    }

  } else {
    // -- Held Kalshi contract, missing the PM leg ------------------------------
    // -- KAL-held hedge strategy: always hedge on PM, never KAL opposite side.
    // PM GTC rests as maker (0% fee). PM taker fee reserved in breakeven calculation.
    const hedgeEdge2 = HEDGE_TARGET === "payout" ? 0 : MIN_EDGE;
    const estCompletePrice2 = 1 - pos.kalCostBasis;
    // PM GTC placed above market ask fills as TAKER (3% fee). Reserve for it.
    // fee = PM_FEE_RATE × price × (1 - price). Estimate at the expected fill price.
    const estPmFillPrice = 1 - pos.kalCostBasis - hedgeEdge2;
    const pmFeeReserve = PM_FEE_RATE * estPmFillPrice * (1 - estPmFillPrice);
    const maxPmPrice = 1 - pos.kalCostBasis - hedgeEdge2 - pmFeeReserve;
    // Safety: log breakeven calculation on first hedge cycle
    if (!state.lastCompleteExchange) {
      console.log(`[HEDGE] KAL-held breakeven: kalCostBasis=${fmtPct(pos.kalCostBasis)} maxPmPrice=${fmtPct(maxPmPrice)} shares=${sharesNeeded}`);
    }
    const hedgeKalSide: "yes" | "no" = pos.kalSide === "yes" ? "no" : "yes";

    // -- Pre-hedge reconciliation: check if original PM FOK already filled on-chain --
    // The original FOK can settle on-chain minutes after the CLOB API reported it as
    // unmatched (especially for sports markets with delayed matching). If the tokens are
    // already in the wallet, skip hedging -- the position is already complete.
    // IMPORTANT: subtract PM shares already committed to OTHER trades on the same token
    // to avoid false-positive reconciliation (e.g. trade 1 bought 9 shares, trade 2's
    // FOK failed -> wallet shows 9 but only trade 1 owns them).
    if (sharesNeeded > 0 && !DRY_RUN) {
      try {
        let pmHeld = await Promise.race([
          getOnChainBalanceWithFallback(pos.pmLeg.tokenId),
          new Promise<number>((_, rej) => setTimeout(() => rej(new Error("balance-timeout")), 10_000)),
        ]);
        if (pmHeld < 0) {
          const positions = await fetchPmPositionsCached(0);
          pmHeld = sumPmHeld(positions, pos.pmLeg.tokenId);
          console.log(`  [HEDGE] On-chain RPC failed, data-api fallback: ${pmHeld}x ${pos.pmLeg.outcome}`);
        } else {
          console.log(`  [HEDGE] On-chain balance: ${pmHeld}x ${pos.pmLeg.outcome} (token ${pos.pmLeg.tokenId.slice(0,16)}...)`);
        }
        // Subtract shares already attributed to other trades on this same PM token
        const otherTradesShares = loadArbTrades()
          .filter(t => t.id !== pos.tradeId && t.pmTokenId === pos.pmLeg.tokenId &&
                       (t.status === "filled" || t.status === "hedging" || t.status === "resolved") &&
                       t.pmCost > 0)
          .reduce((sum, t) => sum + t.shares, 0);
        const availableForThisTrade = pmHeld - otherTradesShares;
        if (otherTradesShares > 0) {
          console.log(`[HEDGE] On-chain balance ${pmHeld}x but ${otherTradesShares}x committed to other trades -> ${availableForThisTrade}x available for this trade`);
        }
        // Only auto-resolve from on-chain balance if we already have partial hedge fills
        // (hedgeFillCostPm > 0 means our hedge bought some PM tokens). Without this check,
        // PM tokens from OTHER trades on the same slug get mis-attributed to this trade,
        // resolving it at the wrong cost (e.g. 52c when our max was 26c).
        const hasOwnPmFills = pos.hedgeFillCostPm > 0;
        if (availableForThisTrade >= sharesNeeded && hasOwnPmFills) {
          console.log(
            `\n[HEDGE] [OK] On-chain reconciliation: wallet holds ${availableForThisTrade}x available PM ${pos.pmLeg.outcome}` +
            ` (need ${sharesNeeded}). Hedge already has PM fills. Resolving.\n`
          );
          // Try to recover actual fill price from CLOB getTrades()
          let fillPrice = 0;
          let fillCost = 0;
          try {
            const { client } = await createPmClient();
            type ClobFill = { asset_id: string; size: string; price: string; fee_rate_bps: string; side: string; status: string; match_time: string; id?: string };
            const clobTrades = (await client.getTrades()) as unknown as ClobFill[];
            const fills = clobTrades.filter(
              (ct: ClobFill) => ct.asset_id === pos.pmLeg.tokenId && ct.side === "BUY" && ct.status === "CONFIRMED"
            );
            if (fills.length > 0) {
              // Collect fill IDs already attributed to other trades to avoid double-counting
              const otherTrades = loadArbTrades().filter(
                t => t.id !== pos.tradeId && t.pmTokenId === pos.pmLeg.tokenId && t.pmCost > 0
              );
              const otherTradesShareTotal = otherTrades.reduce((s, t) => s + t.shares, 0);
              // Sort fills by time (newest first) -- this trade's fills are likely the most recent
              const sortedFills = [...fills].sort((a, b) =>
                new Date(b.match_time).getTime() - new Date(a.match_time).getTime()
              );
              // Skip fills that belong to earlier trades (by share count)
              let skipped = 0;
              let totalSize = 0;
              let totalCost = 0;
              // Walk oldest-first to attribute early fills to earlier trades
              const oldestFirst = [...sortedFills].reverse();
              for (const f of oldestFirst) {
                const sz = Number(f.size);
                if (skipped < otherTradesShareTotal) {
                  skipped += sz;
                  continue; // this fill belongs to an earlier trade
                }
                const px = Number(f.price);
                totalSize += sz;
                totalCost += sz * px;
                if (totalSize >= sharesNeeded) break; // don't over-attribute
              }
              if (totalSize > 0) {
                fillPrice = Math.round((totalCost / totalSize) * 10000) / 10000;
                fillCost = Math.round(totalCost * 100) / 100;
                console.log(`[HEDGE] Recovered PM fill from CLOB: avgPrice=${fmtPct(fillPrice)} totalCost=$${fillCost.toFixed(2)} (${totalSize} shares, skipped ${skipped} from other trades)`);
              }
            }
          } catch (e) {
            console.warn(`[HEDGE] CLOB getTrades() failed during reconciliation: ${(e as Error).message}`);
          }
          // Cancel all active hedge orders
          for (const [oid, ho] of activeOrders) {
            try {
              if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
              else await cancelKalshiOrder(oid, DRY_RUN);
              console.log(`[HEDGE] Cancelled ${ho.exchange.toUpperCase()} ${ho.role} ${oid.slice(0, 12)}...`);
            } catch { /* order may already be gone */ }
          }
          activeOrders.clear();
          // Update trade record with actual PM fill data
          const totalCost = Math.round((pos.initialCost + fillCost) * 100) / 100;
          resolveArbTrade(pos.kalLeg.ticker, {
            status: "resolved",
            resolutionMethod: "hedge-reconciled-onchain",
            pmFillPrice: fillPrice,
            pmCost: fillCost,
            totalCost,
            hedgeCost: 0,
            realizedPnl: Math.round((pos.initialShares - totalCost) * 100) / 100,
          }, pos.tradeId);
          postResolutionFillAudit(pos.kalLeg.ticker, pos.tradeId).catch(() => {});
          pos.sharesHeld = 0;
          saveHedgeState(state);
          return;
        }
      } catch (e) {
        console.warn(`[HEDGE] Pre-hedge on-chain reconciliation failed: ${(e as Error).message} -- continuing normal hedge.`);
      }
    }

    // KAL-held: always hedge on PM. Respect pmNextRetryAt for delayed settlement.
    const pmDelayedKH = (state.pmNextRetryAt ?? 0) > Date.now();
    if (pmDelayedKH) {
      console.log(`[HEDGE] PM delayed (KAL-held): waiting ${Math.ceil(((state.pmNextRetryAt ?? 0) - Date.now()) / 1000)}s for possible delayed settlement`);
    }

    // -- IOC sweep: PM token ask each cycle ------------------------------------
    // Use WS data first (instant). Fall back to REST if WS stale.
    // GUARD: Skip IOC sweep if a GTC complete order is already active on PM.
    // Both orders target the same token; PM sports delay means both can fill before
    // either is detected, causing double-buys (IOC fills + GTC fills = 2x shares).
    const hasActivePmCompleteKH = [...activeOrders.values()].some(o => o.role === "complete" && o.exchange === "pm");
    if (!pmDelayedKH && sharesNeeded >= 5 && !isPmServiceDown() && !hasActivePmCompleteKH) {
      let pmCurrentAsk = getWsPmBestAsk(pos.pmLeg.tokenId);
      if (pmCurrentAsk === null) {
        pmCurrentAsk = await Promise.race([
          fetchPmAsk(pos.pmLeg.tokenId, clobBase),
          new Promise<null>((res) => setTimeout(() => res(null), 10_000)),
        ]);
      }
      // IOC sweep is taker — subtract taker fee from breakeven
      const pmTakerFeeKH = pmCurrentAsk !== null ? PM_FEE_RATE * pmCurrentAsk * (1 - pmCurrentAsk) : 0;
      const maxPmPriceTaker = maxPmPrice - pmTakerFeeKH;
      if (pmCurrentAsk === null) {
        console.log(`  [HEDGE] PM ask fetch returned null for ${pos.pmLeg.outcome} (token ${pos.pmLeg.tokenId.slice(0,16)}...)`);
      } else if (pmCurrentAsk > maxPmPriceTaker) {
        console.log(`  [HEDGE] PM ask ${fmtPct(pmCurrentAsk)} > breakeven ${fmtPct(maxPmPriceTaker)} (incl ${fmtPct(pmTakerFeeKH)} taker fee) for ${pos.pmLeg.outcome} -- too expensive`);
      } else if (sharesNeeded * pmCurrentAsk < PM_MARKETABLE_MIN_VALUE) {
        console.log(`  [HEDGE] PM order $${(sharesNeeded * pmCurrentAsk).toFixed(2)} < PM min $${PM_MARKETABLE_MIN_VALUE} for ${pos.pmLeg.outcome}`);
      }
      if (pmCurrentAsk !== null && pmCurrentAsk <= maxPmPriceTaker && sharesNeeded * pmCurrentAsk >= PM_MARKETABLE_MIN_VALUE) {
        try {
          const res = await placePmFOK(pos.pmLeg.tokenId, pmCurrentAsk, sharesNeeded, pos.pmLeg.tickSize, pos.pmLeg.negRisk, DRY_RUN);
          if (isPm425(res)) { markPmDown(); }
          else {
            markPmUp();
            const meta = extractPmMeta(res);
            let filled = 0;
            if (DRY_RUN) {
              filled = sharesNeeded;
            } else if (meta.status === "matched" || meta.status === "delayed") {
              // CLOB says matched or delayed — verify on-chain before crediting
              if (meta.status === "delayed" && meta.orderId) {
                console.log(`  [HEDGE] PM sweep on-chain pending, waiting for confirmation...`);
                await waitForPmOrderFill(String(meta.orderId), 60_000, pos.pmLeg.tokenId);
              }
              const preBal = pos.pmPreBalance ?? 0;
              const verified = await verifyPmFill(pos.pmLeg.tokenId, sharesNeeded, preBal, "HEDGE-IOC-KH", meta.orderId ? String(meta.orderId) : undefined);
              if (verified > 0) {
                filled = verified;
                pos.pmPreBalance = (preBal + verified);
              } else {
                console.warn(`[HEDGE] PM IOC CLOB status=${meta.status} but on-chain shows 0 — phantom fill, not crediting`);
              }
            }
            if (filled > 0) {
              const pmIocFeeKH = PM_FEE_RATE * pmCurrentAsk * (1 - pmCurrentAsk) * filled;
              pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
              pos.hedgeFillCost += filled * pmCurrentAsk + pmIocFeeKH;
              pos.hedgeFillCostPm += filled * pmCurrentAsk + pmIocFeeKH;
              sharesNeeded = pos.sharesHeld;
              console.log(`\n[HEDGE] IOC PM ${pos.pmLeg.outcome} on-chain verified ${filled}@${fmtPct(pmCurrentAsk)} +fee $${pmIocFeeKH.toFixed(3)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
              appendEvent({
                type: "fill-detected", tradeId: pos.tradeId, exchange: "pm",
                orderId: meta.orderId ? String(meta.orderId) : "", ticker: pos.kalLeg.ticker,
                tokenId: pos.pmLeg.tokenId, side: pos.pmLeg.outcome,
                fillShares: filled, fillPrice: pmCurrentAsk,
                fillCost: filled * pmCurrentAsk, fees: 0,
                cumulativeFilled: filled, source: "onchain",
              } as Omit<FillDetectedEvent, "seq" | "ts">);
              await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
              saveHedgeState(state);
              sharesNeeded = pos.sharesHeld;
              if (pos.sharesHeld <= 0) return;
            }
          }
        } catch (e) {
          console.error(`[HEDGE] IOC PM sweep failed: ${(e as Error).message}`);
        }
      }
    }
    // KAL-held: no KAL opposite side sweep. PM only.

    // -- GTC placement: PM only, keep resting, don't replace -------------------
    const hasAnyCompleteKH = [...activeOrders.values()].some(o => o.role === "complete");
    if (!hasAnyCompleteKH && sharesNeeded > 0) {
      // Re-check market status before placing a new order (WS first, REST fallback)
      if (isKalMarketSettled(pos.kalLeg.ticker)) {
        console.log(`[HEDGE] Market ${pos.kalLeg.ticker} settled (WS) -- skipping new order. Will resolve on next cycle.`);
        saveHedgeState(state);
        return;
      }
      try {
        const recheck = await Promise.race([
          kalFetchHedge<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("recheck-timeout")), 10_000)),
        ]);
        const recheckMkt = recheck.market ?? recheck as unknown as KalshiMarket;
        const recheckStatus = pickString(recheckMkt.status ?? recheckMkt.state ?? "").toLowerCase();
        if (recheckStatus === "closed" || recheckStatus === "settled" || recheckStatus === "resolved" || recheckStatus === "finalized") {
          console.log(`[HEDGE] Market ${pos.kalLeg.ticker} is now ${recheckStatus} -- skipping new order. Will resolve on next cycle.`);
          saveHedgeState(state);
          return;
        }
      } catch { /* non-critical -- proceed with order placement */ }

      const pmViableKH = !pmDelayedKH && !isPmServiceDown() && sharesNeeded >= 5;
      let placed = false;
      let pmBalanceFailedKH = false;

      if (pmViableKH) {
        // -- Try PM GTC BID for the needed token -----------------------------
        const pmTick = pos.pmLeg.tickSize || 0.01;
        const pmBidPrice = Math.round(Math.floor(maxPmPrice / pmTick + 1e-9) * pmTick * 1e6) / 1e6;
        if (pmBidPrice > 0 && sharesNeeded * pmBidPrice >= PM_MARKETABLE_MIN_VALUE) {
          try {
            const res = await placePmGTCBid(pos.pmLeg.tokenId, pmBidPrice, sharesNeeded, pmTick, pos.pmLeg.negRisk, DRY_RUN);
            const resStr = JSON.stringify(res).toLowerCase();
            if (resStr.includes("not_enough_balance") || resStr.includes("insufficient") || resStr.includes("allowance")) {
              console.warn(`[HEDGE] PM balance insufficient for ${sharesNeeded}x@${fmtPct(pmBidPrice)}. Falling back to KAL.`);
              pmBalanceFailedKH = true;
            } else if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-complete-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "complete", exchange: "pm", orderId: oid, price: pmBidPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                state.lastCompleteExchange = "pm";
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC BID ${sharesNeeded}x${pos.pmLeg.outcome}@${fmtPct(pmBidPrice)} (complete-pm). orderId=${oid}`);
                audit({ module: "hedge", fn: "runHedgeCycle", action: "hedge-gtc-pm-placed", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: sharesNeeded, price: pmBidPrice, context: { orderId: oid, outcome: pos.pmLeg.outcome, role: "complete", heldExchange: "kal" } });
                appendEvent({
                  type: "order-placed", tradeId: pos.tradeId, exchange: "pm",
                  orderId: oid, role: "hedge-complete", side: pos.pmLeg.outcome,
                  ticker: pos.kalLeg.ticker, tokenId: pos.pmLeg.tokenId,
                  requestedShares: sharesNeeded, limitPrice: pmBidPrice, orderType: "GTC",
                } as Omit<OrderPlacedEvent, "seq" | "ts">);
                placed = true;
                if (!DRY_RUN && meta.status === "matched") {
                  // CLOB says matched — verify on-chain before crediting
                  const preBal = pos.pmPreBalance ?? 0;
                  const verified = await verifyPmFill(pos.pmLeg.tokenId, sharesNeeded, preBal, "HEDGE-GTC-IMM-KH", oid);
                  if (verified > 0) {
                    pos.sharesHeld = Math.max(0, pos.sharesHeld - verified);
                    pos.hedgeFillCost += verified * pmBidPrice;
                    pos.hedgeFillCostPm += verified * pmBidPrice;
                    pos.pmPreBalance = (preBal + verified);
                    activeOrders.delete(oid);
                    console.log(`[HEDGE] PM GTC on-chain verified (${verified}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  } else {
                    console.warn(`[HEDGE] PM GTC CLOB matched but on-chain shows 0 — keeping order active for re-check`);
                  }
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              }
            }
          } catch (e) {
            console.error(`[HEDGE] Failed to place PM GTC bid: ${(e as Error).message}`);
          }
        }
      }

      // KAL fallback: when PM balance insufficient, hedge on KAL opposite side
      if (!placed && sharesNeeded > 0 && pmBalanceFailedKH) {
        const hedgeKalSide: "yes" | "no" = pos.kalSide === "yes" ? "no" : "yes";
        // KAL GTC fills as maker — use maker fee rate (1.75%)
        const kalOppFeeReserve = KALSHI_MAKER_FEE_RATE * (1 - pos.kalCostBasis) * pos.kalCostBasis;
        const maxKalOppPrice = 1 - pos.kalCostBasis - kalOppFeeReserve;
        const kalOppCents = Math.max(1, Math.min(99, Math.floor(maxKalOppPrice * 100 + 1e-9)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", hedgeKalSide, kalOppCents, sharesNeeded);
        try {
          console.log(`[HEDGE] PM balance insufficient. Falling back to KAL GTC ${hedgeKalSide.toUpperCase()} @ ${kalOppCents}c`);
          const res = await placeKalshiOrder(order, DRY_RUN);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-bal-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalOppCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            saveHedgeState(state);
            console.log(`[HEDGE] Placed KAL GTC fallback ${sharesNeeded}x${hedgeKalSide.toUpperCase()}@${fmtPct(kalOppCents / 100)}. orderId=${oid}`);
            audit({ module: "hedge", fn: "runHedgeCycle", action: "hedge-gtc-kal-placed", tradeId: pos.tradeId, kalTicker: pos.kalLeg.ticker, shares: sharesNeeded, price: kalOppCents / 100, context: { orderId: oid, side: hedgeKalSide, role: "complete", reason: "pm-balance-insufficient" } });
          }
        } catch (e) {
          console.error(`[HEDGE] KAL balance fallback failed: ${(e as Error).message}`);
        }
      }
    }

    // -- exit: sell our Kalshi side at cost basis (skipped if STRICT_HEDGE)
    // Always place at cost basis -- the GTC rests until price comes back up.
    if (!STRICT_HEDGE && pos.sharesHeld > 0) {
      const hasKalExit = [...activeOrders.values()].some(o => o.role === "exit" && o.exchange === "kal");
      if (!hasKalExit) {
        const exitCents = Math.max(1, Math.min(99, Math.ceil(pos.kalCostBasis * 100)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "sell", pos.kalSide, exitCents, pos.sharesHeld);
        try {
          const res = await placeKalshiOrder(order, DRY_RUN);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-exit-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "exit", exchange: "kal", orderId: oid, price: exitCents / 100, shares: pos.sharesHeld, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            saveHedgeState(state);
            console.log(`\n[HEDGE] Placed Kalshi GTC ${pos.kalSide.toUpperCase()}-ASK ${pos.sharesHeld}x@${fmtPct(exitCents / 100)} (exit at cost). orderId=${oid}`);
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC sell: ${(e as Error).message}`);
        }
      }
    }
  }
  } finally {
    _hedgeCycleLocks.delete(pos.tradeId);
  }
}

// --- Startup position scan ----------------------------------------------------
// When no saved hedge_state.json exists, scan the Polymarket wallet for live
// positions and cross-reference against the current watchlist.
// If a match is found the bot automatically enters hedge mode -- no manual action needed.

export async function detectUnhedgedPmPositions(watchlist: WatchEntry[], hedgeStateTickers?: Set<string>, kalPosMap?: Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>): Promise<HedgeState[]> {
  let positions: PmPosition[];
  try {
    positions = await fetchPmPositionsCached(0); // force fresh at startup
  } catch (err) {
    console.error(`[STARTUP] Failed to fetch PM positions: ${(err as Error).message}`);
    return [];
  }

  if (!positions.length) return [];
  const results: HedgeState[] = [];

  // Load resolved trades to avoid re-processing PM positions that are already accounted for.
  // When a Kalshi market settles, the KAL position disappears from the portfolio, making
  // the PM tokens look "unhedged". But the arb was already resolved -- don't re-process.
  const existingTrades = loadArbTrades();
  const resolvedSharesByPm = new Map<string, number>(); // key: "pmSlug|pmOutcome" -> total resolved shares
  const resolvedSharesByTokenId = new Map<string, number>(); // key: pmTokenId -> total resolved shares
  // Also track by slug alone: hedge-complete trades buy OPPOSITE outcome tokens.
  // Those tokens aren't tracked by pmOutcome, but they're covered by the arb.
  // Any trade on this slug (resolved/hedging) means positions are accounted for.
  const resolvedSharesBySlug = new Map<string, number>(); // key: pmSlug -> total shares across ALL outcomes
  for (const t of existingTrades) {
    if (t.status === "resolved" || t.status === "filled") {
      const key = `${t.pmSlug}|${t.pmOutcome}`;
      resolvedSharesByPm.set(key, (resolvedSharesByPm.get(key) ?? 0) + (t.shares ?? 0));
      if (t.pmTokenId) {
        resolvedSharesByTokenId.set(t.pmTokenId, (resolvedSharesByTokenId.get(t.pmTokenId) ?? 0) + (t.shares ?? 0));
      }
      if (t.pmSlug) {
        resolvedSharesBySlug.set(t.pmSlug, (resolvedSharesBySlug.get(t.pmSlug) ?? 0) + (t.shares ?? 0));
      }
    } else if (t.status === "hedging") {
      // Only count "hedging" trades as tracked if they're actually in hedge_state.json.
      // If hedge state was lost (crash/restart), these positions need to be re-detected.
      if (hedgeStateTickers?.has(t.kalTicker)) {
        const key = `${t.pmSlug}|${t.pmOutcome}`;
        resolvedSharesByPm.set(key, (resolvedSharesByPm.get(key) ?? 0) + (t.shares ?? 0));
        if (t.pmTokenId) {
          resolvedSharesByTokenId.set(t.pmTokenId, (resolvedSharesByTokenId.get(t.pmTokenId) ?? 0) + (t.shares ?? 0));
        }
        if (t.pmSlug) {
          resolvedSharesBySlug.set(t.pmSlug, (resolvedSharesBySlug.get(t.pmSlug) ?? 0) + (t.shares ?? 0));
        }
      }
    }
  }

  // Build tokenId -> watchlist leg lookup.
  // 2-way: Holding pm1 -> needs kal2 YES to complete (dir=B), oppLeg=pm2
  //        Holding pm2 -> needs kal1 YES to complete (dir=A), oppLeg=pm1
  // 3-way: Holding pm1 YES -> needs kal1 NO to complete (dir=G: KAL Home NO + PM Home YES)
  //        Holding pm2 YES -> needs kal2 NO to complete (dir=I: KAL Away NO + PM Away YES)
  //        Holding pm3 YES -> needs kal3 NO to complete (dir=H: KAL Draw NO + PM Draw YES)
  //        Holding pm1 NO  -> needs kal1 YES to complete (dir=J: KAL Home YES + PM Home NO)
  //        Holding pm2 NO  -> needs kal2 YES to complete (dir=L: KAL Away YES + PM Away NO)
  //        Holding pm3 NO  -> needs kal3 YES to complete (dir=K: KAL Draw YES + PM Draw NO)
  //   Using opposite-player KAL (2-way mapping) in 3-way leaves draw UNCOVERED.
  //   Using same-outcome KAL guarantees $1 payout regardless of result.
  type LegMatch = { entry: WatchEntry; pmLeg: PmLeg; pmOppLeg: PmLeg | null; kalLeg: KalshiLeg; kalSide3Way?: "yes" | "no" };
  const tokenMap = new Map<string, LegMatch>();
  for (const entry of watchlist) {
    if (entry.is3Way) {
      // YES tokens -> hedge with KAL NO on SAME outcome (Dir G/H/I)
      tokenMap.set(entry.pm1.tokenId, { entry, pmLeg: entry.pm1, pmOppLeg: null, kalLeg: entry.kal1, kalSide3Way: "no" });
      tokenMap.set(entry.pm2.tokenId, { entry, pmLeg: entry.pm2, pmOppLeg: null, kalLeg: entry.kal2, kalSide3Way: "no" });
      if (entry.pm3 && entry.kal3) {
        tokenMap.set(entry.pm3.tokenId, { entry, pmLeg: entry.pm3, pmOppLeg: null, kalLeg: entry.kal3, kalSide3Way: "no" });
      }
      // NO tokens -> hedge with KAL YES on SAME outcome (Dir J/K/L)
      if (entry.pm1.noTokenId) {
        tokenMap.set(entry.pm1.noTokenId, { entry, pmLeg: { ...entry.pm1, tokenId: entry.pm1.noTokenId, outcome: `${entry.pm1.outcome} [NO]` }, pmOppLeg: null, kalLeg: entry.kal1, kalSide3Way: "yes" });
      }
      if (entry.pm2.noTokenId) {
        tokenMap.set(entry.pm2.noTokenId, { entry, pmLeg: { ...entry.pm2, tokenId: entry.pm2.noTokenId, outcome: `${entry.pm2.outcome} [NO]` }, pmOppLeg: null, kalLeg: entry.kal2, kalSide3Way: "yes" });
      }
      if (entry.pm3?.noTokenId && entry.kal3) {
        tokenMap.set(entry.pm3.noTokenId, { entry, pmLeg: { ...entry.pm3, tokenId: entry.pm3.noTokenId, outcome: `${entry.pm3.outcome} [NO]` }, pmOppLeg: null, kalLeg: entry.kal3, kalSide3Way: "yes" });
      }
    } else {
      // 2-way: opposite player YES
      tokenMap.set(entry.pm1.tokenId, { entry, pmLeg: entry.pm1, pmOppLeg: entry.pm2, kalLeg: entry.kal2 });
      tokenMap.set(entry.pm2.tokenId, { entry, pmLeg: entry.pm2, pmOppLeg: entry.pm1, kalLeg: entry.kal1 });
      if (entry.pm3 && entry.kal3) {
        tokenMap.set(entry.pm3.tokenId, { entry, pmLeg: entry.pm3, pmOppLeg: null, kalLeg: entry.kal3 });
      }
    }
  }

  for (const pos of positions) {
    const tokenId = pickString(pos.asset ?? pos.tokenId ?? pos.conditionId ?? "");
    const size    = Number(pos.size ?? pos.amount ?? 0);
    if (!tokenId || size < 0.5) continue;

    const m = tokenMap.get(tokenId);
    if (!m) {
      // Position exists on PM but is not in the current watchlist
      // (e.g. the match resolved, or discovery couldn't find it today)
      console.warn(
        `[STARTUP] Unrecognized PM position -- tokenId=${tokenId.slice(0, 16)}... size=${size}.` +
        ` Not in today's watchlist -- please resolve manually.`
      );
      continue;
    }

    // Conservative cost basis: if API doesn't return avg price, assume 0.50 (mid-market).
    // Using tickSize (0.01) would make maxKalPrice ≈ 0.99, effectively a market-buy -- dangerous.
    // 0.50 keeps the GTC bid at ~0.50, which is safe and breakeven-ish for most head-to-head markets.
    // IMPORTANT: PM positions API avgPrice can be MARKET PRICE, not fill price.
    // Prefer actual fill price from pending_fills when available.
    const pfMatch = loadPendingFills().find(pf =>
      pf.exchange === "pm" && pf.pmSlug === m.entry.pmSlug &&
      namesMatch(pf.pmOutcome, m.pmLeg.outcome) && pf.price > 0
    );
    const rawAvgPrice = pfMatch ? pfMatch.price : Number(pos.avgPrice ?? pos.averagePrice ?? pos.price ?? 0);
    const avgPrice = (rawAvgPrice > 0 && rawAvgPrice < 1) ? rawAvgPrice : 0.50;
    const totalPmShares = Math.round(size);

    // Count how many shares are already covered by the opposite PM leg (complete-pm path)
    const oppPmSize = m.pmOppLeg ? Math.round(positions.reduce((sum, p) => {
      const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
      const sz = Number(p.size ?? p.amount ?? 0);
      return tid === m.pmOppLeg!.tokenId ? sum + sz : sum;
    }, 0)) : 0;

    // Count how many shares are already covered by the Kalshi leg (complete-kal path)
    // IMPORTANT: check the correct side (YES or NO) based on what the hedge needs.
    // For 3-way markets with kalSide3Way="no", the hedge buys KAL NO, so existing
    // KAL NO positions are the coverage. getKalshiPosition() only returns YES count,
    // which would miss NO positions and cause false "unhedged" detection.
    const detectedKalSideForCheck: "yes" | "no" = m.kalSide3Way ?? "yes";
    let kalAlreadyFilled: number;
    if (kalPosMap) {
      const kalPos = kalPosMap.get(m.kalLeg.ticker);
      kalAlreadyFilled = detectedKalSideForCheck === "no"
        ? (kalPos?.noCount ?? 0)
        : (kalPos?.yesCount ?? 0);
    } else {
      // Fallback: use per-ticker API calls (legacy path)
      const kalAlreadyFilledRaw = detectedKalSideForCheck === "no"
        ? await getKalshiNoPosition(m.kalLeg.ticker)
        : await getKalshiPosition(m.kalLeg.ticker);
      if (kalAlreadyFilledRaw < 0) {
        console.warn(`[STARTUP] Kalshi API error for ${m.kalLeg.ticker} -- skipping PM position to avoid duplicate arbs.`);
        continue;
      }
      kalAlreadyFilled = kalAlreadyFilledRaw;
    }

    // Count shares already accounted for in resolved/active arb trades
    // Use BOTH slug+outcome and tokenId lookups -- whichever finds more (handles string mismatches)
    const tradeKey = `${m.entry.pmSlug}|${m.pmLeg.outcome}`;
    const bySlug = resolvedSharesByPm.get(tradeKey) ?? 0;
    const byToken = resolvedSharesByTokenId.get(m.pmLeg.tokenId) ?? 0;
    // Also check by slug alone: hedge-complete trades create opposite PM tokens
    // that aren't tracked by outcome. Any trade on this slug covers positions.
    const bySlugAny = resolvedSharesBySlug.get(m.entry.pmSlug) ?? 0;

    // CRITICAL: If no trade ever directly bought THIS outcome (bySlug=0, byToken=0)
    // but trades exist on the same slug for the OPPOSITE outcome (bySlugAny > 0),
    // then these PM tokens are hedge artifacts — bought by the hedge cycle to cover
    // the opposite side. They do NOT need their own hedge. Skip entirely.
    // Without this, every restart creates phantom hedge trades for hedge artifacts,
    // buying more tokens in a snowball loop.
    if (bySlug === 0 && byToken === 0 && bySlugAny > 0) {
      console.log(
        `[STARTUP] PM ${totalPmShares}x${m.pmLeg.outcome} -- hedge artifact` +
        ` (no direct trade for this outcome, but ${bySlugAny} shares on same slug). Skipping.\n`
      );
      continue;
    }

    const alreadyTracked = Math.max(bySlug, byToken, bySlugAny);

    // CRITICAL: if there's an active hedging trade for this ticker that is NOT in hedgeStates,
    // it means the hedge was lost (crash/restart). Don't count it as covered — it needs re-detection.
    const hasOrphanedHedge = existingTrades.some(t =>
      t.status === "hedging" && t.kalTicker === m.kalLeg.ticker &&
      !hedgeStateTickers?.has(t.kalTicker)
    );
    if (hasOrphanedHedge) {
      console.log(`[STARTUP] PM ${totalPmShares}x${m.pmLeg.outcome} -- orphaned hedging trade on ${m.kalLeg.ticker}. Needs re-detection.`);
      // Fall through to unhedged detection below
    }

    // Net unhedged = total PM shares minus whatever is already covered on either side.
    // alreadyTracked counts shares from trade records (resolved + active hedging trades).
    // oppPmSize counts PM opposite tokens in the wallet (from hedge-complete PM hedges).
    // kalAlreadyFilled counts KAL positions on this ticker.
    // These CAN be additive: tracked shares = completed arbs, oppPmSize = hedge tokens
    // that aren't in any trade record's share count. Use sum, capped at totalPmShares.
    const covered = hasOrphanedHedge ? 0 : Math.min(totalPmShares, alreadyTracked + oppPmSize + kalAlreadyFilled);
    const sharesHeld = totalPmShares - covered;

    // Audit: log every PM position evaluation so we can trace detection decisions
    audit({ module: "hedge", fn: "detectUnhedgedPmPositions", action: sharesHeld > 0 ? "pm-position-unhedged" : "pm-position-covered", kalTicker: m.kalLeg.ticker, pmSlug: m.entry.pmSlug, shares: totalPmShares, context: { outcome: m.pmLeg.outcome, tokenId: m.pmLeg.tokenId.slice(0, 20), bySlug, byToken, bySlugAny, alreadyTracked, oppPmSize, kalAlreadyFilled, covered, sharesHeld, tradeKey } });

    if (sharesHeld <= 0) {
      const parts: string[] = [];
      if (kalAlreadyFilled > 0) parts.push(`KAL ${kalAlreadyFilled}`);
      if (oppPmSize > 0) parts.push(`PM-opp ${oppPmSize}`);
      if (alreadyTracked > 0) parts.push(`trades ${alreadyTracked}`);
      console.log(
        `[STARTUP] PM ${totalPmShares}x${m.pmLeg.outcome} -- fully covered` +
        ` (${parts.join(" + ")}). Arb complete, skipping.\n`
      );
      continue;
    }

    if (covered > 0) {
      console.log(
        `[STARTUP] PM ${totalPmShares}x${m.pmLeg.outcome} -- ${covered} already covered` +
        ` (KAL ${kalAlreadyFilled} + PM-opp ${oppPmSize}). Net unhedged: ${sharesHeld}.`
      );
    }

    console.warn(
      `\n[STARTUP] Found unhedged PM position: ${sharesHeld}x${m.pmLeg.outcome}` +
      ` @${fmtPct(avgPrice)} (${m.entry.pmSlug}). Will hedge automatically.\n`
    );

    // Determine kalSide: 3-way uses kalSide3Way from tokenMap, 2-way defaults to "yes"
    const detectedKalSide: "yes" | "no" = m.kalSide3Way ?? "yes";

    // Build arb trade record but DON'T persist yet -- the caller will log it
    // only for positions that survive the dedup check. This prevents phantom
    // trade entries when the same ticker is already being hedged.
    const pmCostForTrade = Math.round(sharesHeld * avgPrice * 100) / 100;
    // Pick the closest matching dir for audit trail
    const detectedDir: ArbTradeRecord["dir"] = m.kalSide3Way === "no" ? "G" : m.kalSide3Way === "yes" ? "J" : "A";
    const tidDetect = `arb-detect-${Date.now()}`;
    const pendingRecord: ArbTradeRecord = {
      id: tidDetect,
      ts: new Date().toISOString(),
      match: `${m.entry.kal1.surname} vs ${m.entry.kal2.surname}`,
      dir: detectedDir,
      status: "hedging",
      shares: sharesHeld,
      kalTicker: m.kalLeg.ticker,
      kalFillPrice: 0,
      kalCost: 0,
      kalFees: 0,
      pmOutcome: m.pmLeg.outcome,
      pmSlug: m.entry.pmSlug,
      pmTokenId: m.pmLeg.tokenId,
      pmFillPrice: avgPrice,
      pmCost: pmCostForTrade,
      totalCost: pmCostForTrade,
      projectedEdge: 0,
      projectedProfit: 0,
      initialExchange: "pm",
    };

    results.push({
      position: {
        tradeId: tidDetect,
        heldExchange: "pm",
        pmLeg: m.pmLeg,
        pmOppLeg: m.pmOppLeg,
        pmCostBasis: avgPrice,
        kalLeg: m.kalLeg,
        kalCostBasis: 0,
        kalSide: detectedKalSide,
        sharesHeld,
        initialShares: sharesHeld,
        initialCost: sharesHeld * avgPrice,
        hedgeFillCost: 0,
        hedgeFillCostKal: 0,
        hedgeFillCostPm: 0,
        kalFees: 0,
        initialKalFees: 0,
      },
      activeOrders: new Map(),
      kalNextRetryAt: 0,
      pmOnlyCycles: 0,
      _pendingTradeRecord: pendingRecord,
    });
  }

  return results;
}

// --- Startup Kalshi position scan ---------------------------------------------
// Mirror of detectUnhedgedPmPositions -- scans the Kalshi portfolio for open YES
// positions and cross-references against the watchlist.  If a match is found and
// neither the PM leg nor the Kalshi NO leg is already held, enters hedge mode.

export async function detectUnhedgedKalPositions(watchlist: WatchEntry[], kalPosMap?: Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>, hedgeStateTickers?: Set<string>): Promise<HedgeState[]> {
  // Build ticker -> watchlist leg lookup.
  // 2-way markets: Holding kal1 YES -> needs pm2 to complete (dir=A logic)
  //                Holding kal2 YES -> needs pm1 to complete (dir=B logic)
  // 3-way soccer:  Holding kal1 YES -> needs PM Home NO to complete (dir=J logic)
  //                Holding kal2 YES -> needs PM Away NO to complete (dir=L logic)
  //                Holding kal3 YES -> needs PM Draw NO to complete (dir=K logic)
  //   Using opposite-player YES (2-way mapping) in 3-way leaves draw UNCOVERED.
  //   Using same-outcome NO token guarantees $1 payout regardless of result.
  type KalLegMatch = { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg };
  const kalTickerMap = new Map<string, KalLegMatch>();
  for (const entry of watchlist) {
    if (entry.is3Way) {
      // 3-way: hedge with PM NO token on SAME outcome (KAL YES + PM NO = $1 always)
      if (entry.pm1.noTokenId) {
        kalTickerMap.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: { ...entry.pm1, tokenId: entry.pm1.noTokenId, outcome: `${entry.pm1.outcome} [NO]` } });
      }
      if (entry.pm2.noTokenId) {
        kalTickerMap.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: { ...entry.pm2, tokenId: entry.pm2.noTokenId, outcome: `${entry.pm2.outcome} [NO]` } });
      }
      if (entry.kal3 && entry.pm3?.noTokenId) {
        kalTickerMap.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: { ...entry.pm3, tokenId: entry.pm3.noTokenId, outcome: `${entry.pm3.outcome} [NO]` } });
      }
    } else {
      // 2-way: opposite player YES (KAL P1 YES + PM P2 YES = $1 always)
      kalTickerMap.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm2 });
      kalTickerMap.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm1 });
      if (entry.kal3 && entry.pm3) {
        kalTickerMap.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
      }
    }
  }

  // Use pre-fetched position map if provided, otherwise fetch fresh
  const posMap = kalPosMap ?? await getKalshiPositionMap();
  // Convert map to array format for existing loop
  const kalYesPositions: Array<{ ticker: string; yesCount: number; avgPriceCents: number }> = [];
  for (const [ticker, p] of posMap) {
    if (p.yesCount > 0) kalYesPositions.push({ ticker, yesCount: p.yesCount, avgPriceCents: p.avgPriceCents });
  }
  if (!kalYesPositions.length) {
    console.log(`[STARTUP] KAL scan: No YES positions found on Kalshi.`);
    return [];
  }
  console.log(`[STARTUP] KAL scan: ${kalYesPositions.length} YES position(s): ${kalYesPositions.map(p => `${p.yesCount}x${p.ticker}`).join(", ")}`);

  // Use cached PM positions (already fetched by detectUnhedgedPmPositions on same startup)
  let pmPositions: PmPosition[] = [];
  try {
    pmPositions = await fetchPmPositionsCached(5000);
  } catch (err) {
    console.error(`[STARTUP] Failed to fetch PM positions for Kalshi scan: ${(err as Error).message}`);
  }

  const results: HedgeState[] = [];

  // Load resolved trades to avoid re-processing Kalshi positions already accounted for.
  const existingTrades = loadArbTrades();
  const resolvedSharesByKal = new Map<string, number>(); // key: kalTicker -> total resolved shares
  for (const t of existingTrades) {
    if (t.status === "resolved" || t.status === "filled") {
      resolvedSharesByKal.set(t.kalTicker, (resolvedSharesByKal.get(t.kalTicker) ?? 0) + (t.shares ?? 0));
    } else if (t.status === "hedging") {
      // Only count "hedging" trades as tracked if they're actually in hedge_state.json.
      // If hedge state was lost (crash/restart), these positions need to be re-detected.
      if (hedgeStateTickers?.has(t.kalTicker)) {
        resolvedSharesByKal.set(t.kalTicker, (resolvedSharesByKal.get(t.kalTicker) ?? 0) + (t.shares ?? 0));
      } else {
        console.warn(`[STARTUP] Orphaned hedge trade: ${t.kalTicker} (${t.shares} shares) -- status=hedging but NOT in hedge_state.json. Will re-detect.`);
      }
    }
  }

  for (const { ticker, yesCount, avgPriceCents } of kalYesPositions) {
    const m = kalTickerMap.get(ticker);
    if (!m) {
      // Fetch market status so we can tell the user if the event is finished
      const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
      let status = "unknown";
      let title = "";
      let result = "";
      try {
        const res = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
        const mkt = res.market ?? res as unknown as KalshiMarket;
        status = String(mkt.status ?? "unknown");
        title = String(mkt.title ?? "");
        result = String(mkt.result ?? mkt.settlement_value ?? "");
      } catch { /* ignore fetch errors */ }
      const extra = result ? ` result=${result}` : "";
      console.warn(
        `\n[STARTUP] [!] Orphaned Kalshi position: ${yesCount}x${ticker} YES` +
        `  status=${status}${extra}` +
        (title ? `\n         ${title}` : "") +
        `\n         Not in today's watchlist -- cannot auto-hedge.` +
        (status === "finalized" || status === "settled"
          ? `\n         Market is settled. Kalshi should pay out automatically.`
          : status === "closed"
          ? `\n         Event finished but not yet settled -- payout pending.`
          : `\n         Market still open -- resolve manually or add to watchlist.\n`)
      );
      continue;
    }

    const totalKalShares = yesCount;

    // Count how many shares are already covered by the Kalshi NO leg (YES + NO = $1)
    // Use the pre-fetched position map -- no extra API call per ticker.
    const kalNoFilled = posMap.get(ticker)?.noCount ?? 0;

    // Count how many shares are already covered by the PM leg (complete-pm path)
    const pmHeld = Math.round(pmPositions.reduce((sum, p) => {
      const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
      const sz = Number(p.size ?? p.amount ?? 0);
      return tid === m.pmLeg.tokenId ? sum + sz : sum;
    }, 0));

    // Count shares already accounted for in resolved/active arb trades
    const alreadyTracked = resolvedSharesByKal.get(ticker) ?? 0;

    console.log(`[STARTUP] KAL ${totalKalShares}x${ticker}: kalNO=${kalNoFilled} pmHeld=${pmHeld} tracked=${alreadyTracked} inHedgeState=${hedgeStateTickers?.has(ticker) ?? "n/a"}`);

    // Net unhedged = total Kalshi YES minus whatever is already covered on either side
    // alreadyTracked may overlap with kalNoFilled/pmHeld, so use max to avoid double-counting
    const liveCoverage = kalNoFilled + pmHeld;
    const covered = Math.min(totalKalShares, Math.max(liveCoverage, alreadyTracked));
    const sharesHeld = totalKalShares - covered;

    if (sharesHeld <= 0) {
      const parts: string[] = [];
      if (kalNoFilled > 0) parts.push(`KAL NO ${kalNoFilled}`);
      if (pmHeld > 0) parts.push(`PM ${pmHeld}`);
      if (alreadyTracked > 0) parts.push(`trades ${alreadyTracked}`);
      console.log(
        `[STARTUP] Kalshi ${totalKalShares}x${ticker} YES -- fully covered` +
        ` (${parts.join(" + ")}). Arb complete, skipping.\n`
      );
      continue;
    }

    if (covered > 0) {
      console.log(
        `[STARTUP] Kalshi ${totalKalShares}x${ticker} YES -- ${covered} already covered` +
        ` (KAL NO ${kalNoFilled} + PM ${pmHeld}). Net unhedged: ${sharesHeld}.`
      );
    }

    // Use actual fill price from Kalshi API: total_traded / position (gross cost).
    // Fall back to current market ask if the API didn't return cost data.
    const avgFillPrice = avgPriceCents > 0 && avgPriceCents < 100
      ? avgPriceCents / 100
      : (m.kalLeg.yesAsk > 0 && m.kalLeg.yesAsk < 1) ? m.kalLeg.yesAsk : 0.50;

    // Fetch actual Kalshi fills for this ticker to get real fee data
    let actualKalFees = 0;
    try {
      const allFills = await fetchAllKalshiFills();
      const tickerFills = allFills.filter(f => f.ticker === ticker && f.action === "buy" && f.side === "yes");
      actualKalFees = tickerFills.reduce((s, f) => s + f.feeCost, 0);
    } catch (e) {
      console.warn(`[STARTUP] Failed to fetch Kalshi fills for fee data: ${(e as Error).message}`);
    }
    const kalFeePerShare = actualKalFees / Math.max(sharesHeld, 1);

    console.warn(
      `\n[STARTUP] Found unhedged Kalshi position: ${sharesHeld}x${ticker} YES` +
      ` @~${fmtPct(avgFillPrice)} fee=$${actualKalFees.toFixed(2)} (${fmtPct(kalFeePerShare)}/sh) (${m.entry.pmSlug}). Will hedge automatically.\n`
    );

    // Build arb trade record but DON'T persist yet -- the caller will log it
    // only for positions that survive the dedup check. This prevents phantom
    // trade entries when the same ticker is already being hedged.
    const kalCostForTrade = Math.round(sharesHeld * avgFillPrice * 100) / 100;
    const tidKalDetect = `arb-detect-${Date.now()}`;
    const pendingRecordKal: ArbTradeRecord = {
      id: tidKalDetect,
      ts: new Date().toISOString(),
      match: `${m.entry.kal1.surname} vs ${m.entry.kal2.surname}`,
      dir: "A", // startup detection assumes dir A (KAL YES + PM opposite)
      status: "hedging",
      shares: sharesHeld,
      kalTicker: ticker,
      kalFillPrice: avgFillPrice,
      kalCost: kalCostForTrade,
      kalFees: actualKalFees,
      pmOutcome: m.pmLeg.outcome,
      pmSlug: m.entry.pmSlug,
      pmTokenId: m.pmLeg.tokenId,
      pmFillPrice: 0,
      pmCost: 0,
      totalCost: kalCostForTrade + actualKalFees,
      projectedEdge: 0,
      projectedProfit: 0,
      initialExchange: "kal",
    };

    results.push({
      position: {
        tradeId: tidKalDetect,
        heldExchange: "kal",
        pmLeg: m.pmLeg,
        pmOppLeg: null,
        pmCostBasis: 0,
        kalLeg: m.kalLeg,
        kalCostBasis: avgFillPrice + kalFeePerShare,  // actual fill price + actual fee per share
        kalSide: "yes",   // startup detection assumes YES side (legacy dir A/B)
        sharesHeld,
        initialShares: sharesHeld,
        initialCost: sharesHeld * avgFillPrice + actualKalFees,
        hedgeFillCost: 0,
        hedgeFillCostKal: 0,
        hedgeFillCostPm: 0,
        kalFees: actualKalFees,
        initialKalFees: actualKalFees,
      },
      activeOrders: new Map(),
      kalNextRetryAt: 0,
      pmOnlyCycles: 0,
      _pendingTradeRecord: pendingRecordKal,
    });
  }

  return results;
}
