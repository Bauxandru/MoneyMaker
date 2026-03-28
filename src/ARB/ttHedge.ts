/**
 * @module ttHedge
 * Hedge-mode logic for unhedged arbitrage positions.
 *
 * Extracted from tradeTennis.ts (lines 7135-9109).
 *
 * Contains:
 *   - recheckAndCancelAll        — cancel all orders for a position
 *   - extractEventDateKey        — match fingerprint from Kalshi ticker
 *   - collectOpenPositions       — gather positions needing void monitoring
 *   - isScalarSettlement         — detect scalar (cancelled/voided) markets
 *   - fetchPmBestBid             — PM orderbook best bid
 *   - runCancellationMonitor     — periodic void/scalar detection
 *   - handleCancelledPosition    — emergency sell on cancellation
 *   - runHedgeCycle              — main hedge cycle state machine
 *   - detectUnhedgedPmPositions  — startup PM position scan
 *   - detectUnhedgedKalPositions — startup Kalshi position scan
 */

import {
  DRY_RUN,
  KALSHI_FEE_RATE,
  PM_FEE_RATE,
  TRADE_USD,
  MAX_CONTRACTS,
  HEDGE_TARGET,
  STRICT_HEDGE,
  PM_ONLY_MAX_CYCLES,
  MIN_EDGE,
  kalFetch,
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
  logArbTrade,
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
} from "./ttWebSocket.js";

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

// ── Module-level state ───────────────────────────────────────────────────────

let _hedgeLastExitLog = "";  // deduplicate PM exit skip log
export let _hedgeLogCounter = 0;    // cycle counter for periodic status summary

// Track which kalTickers we've already processed for cancellation (avoid re-selling)
const _cancelledTickers = new Set<string>();
// Track cancelled EVENTS (not just tickers) — e.g. "FNMKOI" and "FNKOIA" are both
// from the same match. If one settles scalar, block all sibling markets.
// Key = event keyword extracted from ticker (e.g. "26MAR09" + team combo).
const _cancelledEventKeys = new Set<string>();
let _cancMonLastRun = 0;
const CANC_MON_INTERVAL_MS = 10_000; // check every 10s

// ── Functions ────────────────────────────────────────────────────────────────

export async function recheckAndCancelAll(
  pos: UnhedgedPosition,
  activeOrders: Map<string, HedgeOrder>,
  dryRun: boolean
): Promise<void> {
  for (const [oid, ho] of activeOrders) {
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
            console.warn(`[HEDGE] recheckCancel: fill count missing for ${rcSt} order — inferred ${inferred} fills`);
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
    } catch { /* order may already be gone — proceed to cancel */ }
    // Cancel the order
    try {
      if (ho.exchange === "pm") await cancelPmOrder(oid, dryRun);
      else await cancelKalshiOrder(oid, dryRun);
      console.log(`[HEDGE] Cancelled GTC ${ho.exchange.toUpperCase()} ${ho.role} ${oid.slice(0, 16)}... after IOC fill.`);
    } catch { /* best effort */ }
  }
  activeOrders.clear();
}

// ── Hedge Mode Strategy ──────────────────────────────────────────────────────
// When only one arb leg fills, we hold an unhedged position. The bot hedges by
// racing orders on BOTH platforms simultaneously:
//
//   Holding PM token (e.g. P2):
//     • Complete order on Kalshi: GTC bid for P1 YES  → completes the arb
//     • Complete order on PM:     GTC bid for P1 token → completes the arb
//     • Exit order on PM:         GTC ask selling held P2 token → exits position
//
//   Holding Kalshi YES (e.g. P1):
//     • Complete order on PM:     GTC bid for P2 token → completes the arb
//     • Complete order on Kalshi:  GTC bid for P2 NO   → completes the arb
//     • Exit order on Kalshi:     GTC ask selling held P1 YES → exits position
//
// Cross-platform exit (e.g. selling PM token on Kalshi) is NOT possible — you
// can only sell assets you hold on the platform where you hold them. Buying the
// opposite contract on the other platform would create a NEW position, not close
// the existing one. The dual complete orders already cover both fill paths.
//
// Each hedge cycle also attempts an aggressive FOK sweep on PM to fill instantly.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Cancellation Monitor ────────────────────────────────────────────────────
// Polls Kalshi market status for ALL open positions (filled + hedging).
// Detects scalar settlements (match cancelled/voided) and immediately sells
// PM tokens before PM resolves 50/50, recovering maximum value.
//
// Scalar detection signals:
//   - result === "scalar"
//   - settlement_value is NOT 0, 100, or empty (fractional payout)
//
// On detection: place GTC ASK on PM at max(bestBid, 0.50) to exit fast.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a "match fingerprint" from a Kalshi ticker to detect sibling markets.
 * E.g. KXLOLGAME-26MAR09FNMKOI-MKOI → "KXLOLGAME-26MAR09" + sorted team codes.
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

/** Collect all positions that need void monitoring — includes resolved trades
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

  // Also check settlement_value for non-binary values
  const sv = Number(mkt.settlement_value ?? "");
  if (Number.isFinite(sv) && sv > 0 && sv < 100 && sv !== 0 && sv !== 100) {
    // Fractional settlement (not 0¢ or 100¢) = scalar/cancelled
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
 *   2. If scalar settlement detected → emergency sell PM tokens
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
      const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
      const mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
      const mktStatus = pickString(mkt.status ?? mkt.state ?? "").toLowerCase();

      // Only check finalized/settled/closed markets
      if (mktStatus !== "closed" && mktStatus !== "settled" && mktStatus !== "resolved" && mktStatus !== "finalized") {
        continue;
      }

      // Check if this is a scalar (cancelled) settlement
      if (!isScalarSettlement(mkt)) {
        // Normal binary settlement — mark as handled so we stop polling this ticker
        _cancelledTickers.add(ticker);
        continue;
      }

      const sv = Number(mkt.settlement_value ?? 0);
      console.error(
        `\n╔══════════════════════════════════════════════════════════════════╗\n` +
        `║  ⚠ CANCELLATION DETECTED: ${ticker}\n` +
        `║  Result: ${mkt.result}  Settlement: ${sv}¢  Status: ${mktStatus}\n` +
        `║  Affected positions: ${posGroup.length} trade(s)\n` +
        `╚══════════════════════════════════════════════════════════════════╝\n`
      );

      // Mark ticker + event as handled (blocks sibling markets too)
      _cancelledTickers.add(ticker);
      _cancelledEventKeys.add(extractEventDateKey(ticker));

      // Process each affected trade
      for (const pos of posGroup) {
        await handleCancelledPosition(pos, mkt, hedgeStates, clobBase);
      }
    } catch (err) {
      // Transient fetch error — will retry next cycle
      console.warn(`[CANC-MON] Failed to check ${ticker}: ${(err as Error).message}`);
    }
  }
}

/**
 * Handle a position affected by a cancelled/scalar-settled Kalshi market.
 *
 * Three scenarios:
 *
 *   1. BOTH LEGS FILLED (status="filled") — We hold PM tokens + Kalshi already settled.
 *      → Sell PM tokens into bids (FOK at bestBid if >= 50¢, else GTC ask at 50¢).
 *        Kalshi side already paid out at settlement_value automatically.
 *
 *   2. ONLY PM SHARES HELD (status="hedging", heldExchange="pm") — We hold PM tokens,
 *      Kalshi leg was being hedged.
 *      → Cancel ALL hedge orders on BOTH exchanges, then sell PM tokens same as #1.
 *
 *   3. ONLY KALSHI POSITION (status="hedging", heldExchange="kal") — We hold Kalshi
 *      contracts, PM leg was being hedged.
 *      → Cancel ALL hedge orders on BOTH exchanges. Kalshi settles automatically
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

  // ── Step 1: Cancel ALL hedge orders on BOTH exchanges ──────────────────────
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

  // ── Step 2: Determine if we hold PM tokens ─────────────────────────────────
  // Scenario 3: Kalshi-only position — no PM tokens to sell.
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
      resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}¢). Kalshi-only position — no PM tokens.`,
    }, pos.tradeId);
    console.log(
      `[CANC-MON] Trade resolved (Kalshi-only): ` +
      `kalPayout=$${kalPayout.toFixed(2)} kalCost=$${kalCost.toFixed(2)} P&L=$${realizedPnl.toFixed(2)}`
    );
    if (matchingHs) matchingHs.position.sharesHeld = 0;
    return;
  }

  // ── Scenario 4: Already-resolved trade (both-legs, hedge-complete, etc.) ──
  //    Trade was resolved normally but Kalshi voided the market AFTER resolution.
  //    KAL settles automatically at settlement_value. We may still hold PM tokens
  //    that should be sold if above 50¢ (void settles PM at 50/50).
  if (pos.status === "resolved") {
    const kalPayout = pos.shares * svDecimal;
    const totalCostPaid = pos.kalCost + pos.pmCost + pos.hedgeCost;
    console.log(
      `[CANC-MON] Resolved trade voided: ${pos.pmOutcome} (${pos.tradeId})\n` +
      `  KAL settles at ${fmtPct(svDecimal)} → payout $${kalPayout.toFixed(2)}\n` +
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

    // Sell PM tokens if we hold any and can get > 50¢
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
        // Place GTC ask at 50¢ — PM void settles at 50/50 so this is the floor
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
    const newPnl = Math.round((kalPayout + (pmHeld > 0 ? pmRevenue : 0) - totalCostPaid) * 100) / 100;
    resolveArbTrade(pos.kalTicker, {
      scalarSettlement: true,
      kalSettlementValue: svDecimal,
      pmSettlementValue: pmHeld > 0 ? (pmRevenue / pmHeld) : 0,
      resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}¢). ${pmHeld > 0 ? "PM sell attempted." : "No PM tokens held."}`,
      realizedPnl: newPnl,
    }, pos.tradeId);
    console.log(
      `[CANC-MON] Resolved trade updated: kalPayout=$${kalPayout.toFixed(2)} ` +
      `pmSell~$${pmRevenue.toFixed(2)} totalCost=$${totalCostPaid.toFixed(2)} P&L=$${newPnl.toFixed(2)}`
    );
    return;
  }

  // ── Scenarios 1 & 2: We hold PM tokens (filled/hedging) — need to sell them ─

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
    console.log(`[CANC-MON] No PM shares to sell for ${pos.pmOutcome} — skipping sell.`);
    if (matchingHs) matchingHs.position.sharesHeld = 0;
    return;
  }

  // Step 4: Fetch PM orderbook to find best bid
  const bestBid = await fetchPmBestBid(pos.pmTokenId, clobBase);
  console.log(`[CANC-MON] PM best bid for ${pos.pmOutcome}: ${bestBid !== null ? fmtPct(bestBid) : "no bids"}`);

  // Step 5: Sell strategy
  //   - If bestBid >= 50¢ → aggressive FOK sell into bids at bestBid price (instant fill)
  //   - If bestBid < 50¢ or no bids → GTC ask at 50¢ (wait for someone to buy;
  //     PM cancellation resolves 50/50 so 50¢ is guaranteed floor value)
  const MIN_SELL_PRICE = 0.50;
  const tick = pos.tickSize || 0.01;
  let sellPrice: number;
  let useAggressive = false; // FOK into bids vs GTC resting ask

  if (bestBid !== null && bestBid >= MIN_SELL_PRICE) {
    sellPrice = bestBid;
    useAggressive = true; // sell INTO bids immediately
  } else {
    sellPrice = MIN_SELL_PRICE;
    useAggressive = false; // rest a GTC ask at 50¢
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
        // Aggressive: FOK sell into existing bids — fills instantly or fails
        result = await placePmFOKSell(pos.pmTokenId, sellPrice, actualShares, pos.tickSize, pos.negRisk, false);
      } else {
        // Passive: GTC ask resting at 50¢ — waits for buyers
        result = await placePmGTCAsk(pos.pmTokenId, sellPrice, actualShares, pos.tickSize, pos.negRisk, false);
      }
      const orderId = pickString((result as Record<string, unknown>)?.orderID ?? (result as Record<string, unknown>)?.order_id ?? "");
      console.log(
        `[CANC-MON] PM ${useAggressive ? "FOK" : "GTC"} sell order placed! orderId=${orderId.slice(0, 20)}... ` +
        `${actualShares}x@${fmtPct(sellPrice)}`
      );

      // If FOK failed to fill (size_matched < size), fall back to GTC at 50¢
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
        console.log(`[CANC-MON] FOK failed — trying GTC ask at ${fmtPct(MIN_SELL_PRICE)}...`);
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
    resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}¢). PM sold @ ${fmtPct(sellPrice)}.`,
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

export async function runHedgeCycle(state: HedgeState, clobBase: string): Promise<void> {
  const { position: pos, activeOrders } = state;
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  _hedgeLogCounter++;

  if (pos.sharesHeld <= 0) return;

  // ── Step 0: Check if the Kalshi market has closed/resolved ──────────────────
  // If the match finished, the market settles automatically — no hedging needed.
  // Detect this by checking the market status; if closed/resolved, clear hedge.
  // ALSO: detect scalar (cancelled) settlements and trigger emergency PM sell.

  // Live score early detection (before Kalshi API call — zero latency)
  // Derive matchCode from arb_trades log: find the "hedging" trade for this kalTicker
  const _hedgeTrade = loadArbTrades().find(t => t.kalTicker === pos.kalLeg.ticker && t.status === "hedging");
  const _hedgeMatchCode = _hedgeTrade?.match ?? "";
  if (_hedgeMatchCode) {
    const _lsFinished = isMatchFinished(_hedgeMatchCode);
    const _lsCancelled = isMatchCancelled(_hedgeMatchCode);
    if (_lsFinished) {
      const ls = getMatchState(_hedgeMatchCode);
      console.log(`[HEDGE] Live score: ${_hedgeMatchCode} FINISHED (${ls?.homeScore ?? "?"}-${ls?.awayScore ?? "?"}, ${ls?.detail}) — checking Kalshi settlement...`);
    } else if (_lsCancelled) {
      const ls = getMatchState(_hedgeMatchCode);
      console.warn(`[HEDGE] Live score: ${_hedgeMatchCode} ${ls?.status?.toUpperCase() ?? "CANCELLED"} — scalar settlement risk!`);
    }
  }

  try {
    const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`);
    const mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
    const mktStatus = pickString(mkt.status ?? mkt.state ?? "").toLowerCase();
    if (mktStatus === "closed" || mktStatus === "settled" || mktStatus === "resolved" || mktStatus === "finalized") {
      const kalResult = pickString(mkt.result ?? "").toLowerCase();

      // ── Scalar (cancelled) settlement: emergency sell PM tokens ──────────
      if (isScalarSettlement(mkt) && pos.heldExchange === "pm" && !_cancelledTickers.has(pos.kalLeg.ticker)) {
        const sv = Number(mkt.settlement_value ?? 0);
        console.error(
          `\n╔══════════════════════════════════════════════════════════════════╗\n` +
          `║  ⚠ SCALAR SETTLEMENT in hedge: ${pos.kalLeg.ticker}\n` +
          `║  Result: ${kalResult}  Settlement: ${sv}¢\n` +
          `║  Holding ${pos.sharesHeld} PM shares — triggering emergency sell!\n` +
          `╚══════════════════════════════════════════════════════════════════╝\n`
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

      // ── Normal (binary) settlement: standard hedge clearance ────────────
      console.warn(
        `\n[HEDGE] Market ${pos.kalLeg.ticker} is ${mktStatus}. Position settles automatically — clearing hedge.\n`
      );
      // Cancel any resting orders (they'll fail on a closed market anyway)
      for (const [oid, ho] of activeOrders) {
        try {
          if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
          else await cancelKalshiOrder(oid, DRY_RUN);
        } catch { /* market closed — order may already be gone */ }
      }
      activeOrders.clear();
      // Settlement P&L: we held one leg only (hedge incomplete).
      // Check Kalshi result to see if our side won or lost.
      let settlePnl: number;
      const isScalar = kalResult === "scalar" || (mkt.result === "scalar" && Number(mkt.settlement_value ?? 0) > 0);
      if (isScalar) {
        // Scalar settlement: fractional payout per share (e.g., cancelled match → 86¢)
        const sv = Number(mkt.settlement_value ?? 0);
        const svDec = sv > 1 ? sv / 100 : sv;
        const kalPayout = pos.initialShares * (pos.kalSide === "yes" ? svDec : (1 - svDec));
        const hedgedShares = pos.initialShares - pos.sharesHeld;
        settlePnl = kalPayout + hedgedShares - pos.initialCost - pos.hedgeFillCost;
      } else if (pos.heldExchange === "kal") {
        // We hold Kalshi contracts. If our side won → payout $1/share; if lost → $0.
        const kalWon = (pos.kalSide === "yes" && kalResult === "yes") || (pos.kalSide === "no" && kalResult === "no");
        const payout = kalWon ? pos.initialShares : 0;
        settlePnl = payout - pos.initialCost - pos.hedgeFillCost;
      } else {
        // We hold PM tokens. Kalshi market settled → PM market should settle too.
        const kalSideWon = (pos.kalSide === "yes" && kalResult === "yes") || (pos.kalSide === "no" && kalResult === "no");
        const pmWon = !kalSideWon && kalResult !== "";
        const hedgedShares = pos.initialShares - pos.sharesHeld;
        const hedgedPayout = hedgedShares; // $1 per hedged share (both legs covered)
        const unhedgedPayout = pmWon ? pos.sharesHeld : 0; // $1 per unhedged share if PM won
        settlePnl = hedgedPayout + unhedgedPayout - pos.initialCost - pos.hedgeFillCost;
      }
      console.log(
        `[HEDGE] Settlement P&L: initial=$${pos.initialCost.toFixed(2)}` +
        ` hedgeCost=$${pos.hedgeFillCost.toFixed(2)} result=${kalResult || "unknown"}` +
        ` P&L=$${settlePnl.toFixed(2)}`
      );
      pos.sharesHeld = 0;
      const isPmInit = pos.heldExchange === "pm";
      const kalSettleTotal = isPmInit
        ? pos.hedgeFillCostKal
        : pos.initialCost + pos.hedgeFillCostKal;
      const pmSettleTotal = isPmInit
        ? pos.initialCost + pos.hedgeFillCostPm
        : pos.hedgeFillCostPm;
      const kalSettleCost = Math.round(kalSettleTotal * 100) / 100;
      const pmSettleCost = Math.round(pmSettleTotal * 100) / 100;
      resolveArbTrade(pos.kalLeg.ticker, {
        status: "resolved",
        resolvedTs: new Date().toISOString(),
        resolutionMethod: "settlement",
        hedgeCost: pos.hedgeFillCost,
        realizedPnl: settlePnl,
        kalCost: kalSettleCost,
        pmCost: pmSettleCost,
        totalCost: Math.round((kalSettleCost + pmSettleCost) * 100) / 100,
        kalFillPrice: kalSettleTotal > 0
          ? Math.round((kalSettleTotal / pos.initialShares) * 100) / 100
          : 0,
        pmFillPrice: pmSettleTotal > 0
          ? Math.round((pmSettleTotal / pos.initialShares) * 100) / 100
          : 0,
        initialExchange: pos.heldExchange,
      }, pos.tradeId);
      postResolutionFillAudit(pos.kalLeg.ticker, pos.tradeId).catch(() => {});
      return;
    }
  } catch {
    // Transient error fetching market status — continue hedge cycle normally.
    // If the market is truly gone, order placement will fail and fetchFailures will clean up.
  }

  // ── Step 0b: Periodically verify PM-held position via on-chain balanceOf ────
  // Every ~50 hedge cycles, check the token is still in the wallet on-chain.
  // Primary: on-chain balanceOf (authoritative). Fallback: data-api.
  if (_hedgeLogCounter > 10 && _hedgeLogCounter % 50 === 0 && pos.heldExchange === "pm") {
    try {
      let held = await getOnChainBalance(pos.pmLeg.tokenId);
      if (held < 0) {
        // RPC failed — fallback to data-api
        const positions = await fetchPmPositionsCached(0);
        held = sumPmHeld(positions, pos.pmLeg.tokenId);
      }
      if (held <= 0) {
        console.warn(
          `\n[HEDGE] ⚠ PM position ${pos.pmLeg.outcome} no longer exists in wallet (on-chain verified)!` +
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

  // ── Step 1: Check fills on all active GTC orders ────────────────────────────
  // Collect counterpart cancellations here to avoid mutating the map mid-iteration
  const toCancel: Array<{ oid: string; ho: HedgeOrder }> = [];

  for (const [oid, ho] of activeOrders) {
    try {
      let filledShares = 0;
      let orderDone = false;

      if (ho.exchange === "pm") {
        const { filledShares: f, status } = await getPmOrderFills(oid);
        filledShares = Math.max(0, f - ho.filledSoFar);
        ho.filledSoFar = Math.max(ho.filledSoFar, f);
        orderDone = status === "matched" || status === "cancelled";
      } else {
        const order = await getKalshiOrder(oid);
        let totalFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled ?? 0);
        const st = String(order.status ?? "");
        orderDone = st === "executed" || st === "filled" || st === "cancelled" || st === "expired";
        // Safety: if order is done but fill count is 0, infer from remaining_count
        if (orderDone && totalFilled === 0 && (st === "executed" || st === "filled")) {
          const remaining = Number(order.remaining_count ?? ho.shares);
          const inferred = ho.shares - remaining;
          if (inferred > 0) {
            console.warn(`[HEDGE] Fill count missing for ${st} order ${oid.slice(0,12)}... — inferred ${inferred} fills from remaining_count=${remaining}`);
            totalFilled = inferred;
          }
        }
        filledShares = Math.max(0, totalFilled - ho.filledSoFar);
        ho.filledSoFar = Math.max(ho.filledSoFar, totalFilled);
        // Extract Kalshi fees from order response (cumulative total → track delta)
        const kalOrdFees = (Number(order.taker_fees ?? 0) + Number(order.maker_fees ?? 0)) / 100;
        const prevFees = ho._lastFeeSeen ?? 0;
        ho._lastFeeSeen = kalOrdFees;
        ho._feeDelta = kalOrdFees - prevFees;
        // Log Kalshi order status only when it changes or every ~30s (75 cycles × 400ms)
        const logKey = `${st}:${totalFilled}`;
        if (orderDone || filledShares > 0 || ho._lastLogKey !== logKey) {
          console.log(`[HEDGE] KAL order ${oid.slice(0,12)}... status=${st} filled=${totalFilled}/${ho.shares} remaining=${order.remaining_count ?? "?"}`);
          ho._lastLogKey = logKey;
        }
      }

      if (filledShares > 0) {
        pos.sharesHeld = Math.max(0, pos.sharesHeld - filledShares);
        if (ho.role === "complete") {
          pos.hedgeFillCost += filledShares * ho.price;
          if (ho.exchange === "kal") {
            pos.hedgeFillCostKal += filledShares * ho.price;
            // Add Kalshi fee delta (not cumulative total — prevents double-counting on incremental fills)
            const feeDelta = ho._feeDelta ?? 0;
            if (feeDelta > 0) pos.kalFees += feeDelta;
          }
          else pos.hedgeFillCostPm += filledShares * ho.price;
        }
        console.log(
          `\n[HEDGE] ${ho.exchange.toUpperCase()} ${ho.role} filled ${filledShares} @${fmtPct(ho.price)}.` +
          ` Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`
        );
        // ── Cancel-on-fill race ────────────────────────────────────────────
        // complete fills → cancel ALL other orders (other completes + exits):
        //   arb resolved on this exchange, don't let the other complete overbuy
        // exit fills → cancel complete orders only:
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

      ho.fetchFailures = 0; // successful fetch — reset counter
      if (orderDone || pos.sharesHeld <= 0) activeOrders.delete(oid);
    } catch (err) {
      // Transient errors: keep the order and retry next cycle.
      // After 10 consecutive failures, CANCEL the order on the exchange before removing it
      // from tracking — this prevents orphaned live orders that accumulate and all fill
      // simultaneously when volume finally appears (causing oversized positions).
      ho.fetchFailures = (ho.fetchFailures ?? 0) + 1;
      if (ho.fetchFailures === 1 || ho.fetchFailures % 5 === 0) {
        console.warn(`[HEDGE] Order ${oid.slice(0, 16)}... (${ho.exchange} ${ho.role}) status check fail #${ho.fetchFailures}: ${(err as Error).message ?? err}`);
      }
      if (ho.fetchFailures >= 10) {
        console.warn(`[HEDGE] Order ${oid} (${ho.exchange} ${ho.role}) failed status check 10× — cancelling on exchange and removing.`);
        try {
          if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
          else await cancelKalshiOrder(oid, DRY_RUN);
          console.log(`[HEDGE] Cancelled orphan order ${oid.slice(0, 16)}...`);
        } catch { /* order may already be gone on the exchange — safe to remove */ }
        activeOrders.delete(oid);
      }
    }
  }

  // ── Cancel counterpart orders collected above (deduplicated) ─────────────────
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
        ` — other side filled first (race resolved).`
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Order already gone (executed/expired) — clean it from activeOrders
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
    // ── Held PM token, missing the Kalshi leg ──────────────────────────────────
    // We own pmLeg (e.g. P2_token). We need EITHER:
    //   complete-kal: buy Kalshi P1_YES at ≤ maxKalPrice
    //   complete-pm:  buy PM P1_token (pmOppLeg) at ≤ maxOppPrice  (P1+P2 tokens → $1)
    // Simultaneously exit: sell pmLeg at best ask ≥ cost basis
    // First fill on any complete → cancel the other complete + exit
    // First fill on exit → cancel all completes
    // payout mode: accept any fill up to breakeven; profit mode: require MIN_EDGE margin
    const hedgeEdge = HEDGE_TARGET === "payout" ? 0 : MIN_EDGE;
    // Deduct estimated completing-leg fees only. pmCostBasis is the initial PM cost (0% fee on tennis).
    // KAL completing: KALSHI_FEE_RATE × P × (1-P).
    // PM opposite completing: PM_FEE_RATE × P × (1-P) (currently 0 for tennis).
    const estCompletePrice = 1 - pos.pmCostBasis;
    const kalFeeReserve = KALSHI_FEE_RATE * estCompletePrice * (1 - estCompletePrice);
    const pmOppFeeReserve = PM_FEE_RATE * estCompletePrice * (1 - estCompletePrice);
    const maxKalPrice = 1 - pos.pmCostBasis - hedgeEdge - kalFeeReserve;
    const maxOppPrice = 1 - pos.pmCostBasis - hedgeEdge - pmOppFeeReserve;
    // Safety: log breakeven calculation on first hedge cycle
    if (!state.lastCompleteExchange) {
      console.log(`[HEDGE] PM-held breakeven: pmCostBasis=${fmtPct(pos.pmCostBasis)} maxKalPrice=${fmtPct(maxKalPrice)} maxOppPrice=${fmtPct(maxOppPrice)} shares=${sharesNeeded}`);
    }

    // ── Single-exchange hedging: PM-only first, then KAL-only after PM_ONLY_MAX_CYCLES ──
    const inPmPhasePH = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();

    // ── IOC sweeps: aggressively grab available asks each cycle ─────────────────
    // 1) Sweep Kalshi ask for pos.kalSide (throttled: back off 30s after each failure)
    if (!inPmPhasePH && Date.now() >= state.kalNextRetryAt) {
      const { ask: kalYesAsk, noAsk: kalNoAsk } = await fetchKalshiSingleMarket(pos.kalLeg.ticker);
      const kalCurrentAsk = pos.kalSide === "yes" ? kalYesAsk : kalNoAsk;
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
    // 2) Sweep PM opposite token (pmOppLeg) ask — only in PM phase
    if (inPmPhasePH && pos.pmOppLeg && sharesNeeded >= 5) {
      const oppCurrentAsk = await fetchPmAsk(pos.pmOppLeg.tokenId, clobBase);
      if (oppCurrentAsk !== null && oppCurrentAsk <= maxOppPrice && sharesNeeded * oppCurrentAsk >= PM_MARKETABLE_MIN_VALUE) {
        try {
          const res = await placePmFOK(pos.pmOppLeg.tokenId, oppCurrentAsk, sharesNeeded, pos.pmOppLeg.tickSize, pos.pmOppLeg.negRisk, DRY_RUN);
          const meta = extractPmMeta(res);
          let filled = 0;
          if (DRY_RUN) {
            filled = sharesNeeded;
          } else if (meta.status === "matched") {
            filled = sharesNeeded;
          } else if (meta.status === "delayed" && meta.orderId) {
            console.log(`  [HEDGE] PM opp-sweep on-chain pending, polling...`);
            const finalStatus = await waitForPmOrderFill(String(meta.orderId), 20_000, pos.pmOppLeg?.tokenId);
            if (finalStatus === "matched") filled = sharesNeeded;
            // cancelled/timeout → filled stays 0
          }
          if (filled > 0) {
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * oppCurrentAsk;
            pos.hedgeFillCostPm += filled * oppCurrentAsk;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC PM ${pos.pmOppLeg.outcome} filled ${filled}@${fmtPct(oppCurrentAsk)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
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

    // ── Track PM-only cycles for single-exchange hedging ──
    if (inPmPhasePH && sharesNeeded > 0) {
      state.pmOnlyCycles = (state.pmOnlyCycles ?? 0) + 1;
      if (state.pmOnlyCycles >= PM_ONLY_MAX_CYCLES) {
        console.log(`[HEDGE] PM-held: ${state.pmOnlyCycles} PM-only cycles with no fill — switching to KAL-only`);
        // Cancel any resting PM GTC orders before switching to KAL
        for (const [oid, ho] of activeOrders) {
          if (ho.exchange === "pm") {
            try { await cancelPmOrder(oid, DRY_RUN); } catch { /* best effort */ }
            activeOrders.delete(oid);
          }
        }
      }
    }

    // ── SEQUENTIAL complete: only ONE complete order at a time (prevents double-fill) ──
    // Single-exchange: GTC orders only on the active phase's exchange
    const hasAnyComplete = [...activeOrders.values()].some(o => o.role === "complete");
    if (!hasAnyComplete && sharesNeeded > 0) {
      // Re-check market status + price before placing a new order
      try {
        const recheck = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`);
        const recheckMkt = recheck.market ?? recheck as unknown as KalshiMarket;
        const recheckStatus = pickString(recheckMkt.status ?? recheckMkt.state ?? "").toLowerCase();
        if (recheckStatus === "closed" || recheckStatus === "settled" || recheckStatus === "resolved" || recheckStatus === "finalized") {
          console.log(`[HEDGE] Market ${pos.kalLeg.ticker} is now ${recheckStatus} — skipping new order. Will resolve on next cycle.`);
          saveHedgeState(state);
          return;
        }
        // No price-based skip — always attempt hedging regardless of current price.
      } catch { /* non-critical — proceed with order placement */ }

      // Single-exchange hedging: only place GTC on the current phase's exchange
      const inPmNow = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();
      const pmViable = pos.pmOppLeg && !isPmServiceDown() && sharesNeeded >= 5;
      const tryOrder: Array<"kal" | "pm"> = inPmNow ? (pmViable ? ["pm"] : []) : ["kal"];
      let placed = false;

      for (const tryExchange of tryOrder) {
        if (placed) break;

      if (!placed && tryExchange === "kal") {
        // ── Try Kalshi GTC YES bid ──────────────────────────────────────────
        const kalPriceCents = Math.max(1, Math.min(99, Math.floor(maxKalPrice * 100)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", pos.kalSide, kalPriceCents, sharesNeeded);
        try {
          console.log(`[HEDGE] Placing Kalshi GTC: ticker=${pos.kalLeg.ticker} side=${pos.kalSide} price=${kalPriceCents}¢ qty=${sharesNeeded}`);
          const res = await placeKalshiOrder(order, DRY_RUN);
          console.log(`[HEDGE] Kalshi GTC raw response: ${JSON.stringify(res).slice(0, 300)}`);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalPriceCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            state.lastCompleteExchange = "kal";
            saveHedgeState(state);
            console.log(`[HEDGE] Placed Kalshi GTC BID ${sharesNeeded}×${pos.kalSide.toUpperCase()}@${fmtPct(kalPriceCents / 100)} (complete-kal). orderId=${oid}`);
            placed = true;
            // Verify — if filled immediately, update and return
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
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] Kalshi GTC filled immediately (${immediatelyFilled}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
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

      // ── Try PM GTC bid ──────────────────────────────────────────────────
      if (!placed && tryExchange === "pm" && pos.pmOppLeg && !isPmServiceDown() && sharesNeeded >= 5) {
        const oppTick = pos.pmOppLeg.tickSize || 0.01;
        const oppBidPrice = Math.floor(maxOppPrice / oppTick) * oppTick;
        if (oppBidPrice > 0 && sharesNeeded * oppBidPrice >= PM_MARKETABLE_MIN_VALUE) {
          try {
            const res = await placePmGTCBid(pos.pmOppLeg.tokenId, oppBidPrice, sharesNeeded, oppTick, pos.pmOppLeg.negRisk, DRY_RUN);
            if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-opp-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "complete", exchange: "pm", orderId: oid, price: oppBidPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                state.lastCompleteExchange = "pm";
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC BID ${sharesNeeded}×${pos.pmOppLeg.outcome}@${fmtPct(oppBidPrice)} (complete-pm). orderId=${oid}`);
                if (!DRY_RUN && meta.status === "matched") {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - sharesNeeded);
                  pos.hedgeFillCost += sharesNeeded * oppBidPrice;
                  pos.hedgeFillCostPm += sharesNeeded * oppBidPrice;
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] PM GTC filled immediately (${sharesNeeded}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
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

      } // end for (tryOrder)
    }

    // ── exit: GTC ask on PM to sell our held token at cost basis (skipped if STRICT_HEDGE)
    // Always place at cost basis — the GTC rests on the book until price comes back up.
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
                console.log(`\n[HEDGE] Placed PM GTC ASK ${sharesNeeded}×@${fmtPct(exitPrice)} (exit at cost). orderId=${oid}`);
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
    // ── Held Kalshi contract, missing the PM leg ──────────────────────────────
    // We own kalLeg at pos.kalSide (YES or NO). We need EITHER:
    //   complete-pm:  buy PM token (pmLeg) at ≤ maxPmPrice
    //   complete-kal: buy the OPPOSITE Kalshi side at ≤ maxKalOppPrice  (YES+NO → $1)
    // Simultaneously exit: sell our Kalshi side at best bid ≥ cost basis
    // First fill on any complete → cancel the other complete + exit
    // First fill on exit → cancel all completes
    // payout mode: accept any fill up to breakeven; profit mode: require MIN_EDGE margin
    const hedgeEdge2 = HEDGE_TARGET === "payout" ? 0 : MIN_EDGE;
    // Deduct estimated completing-leg fees only. kalCostBasis already includes the initial Kalshi fee.
    // PM completing: PM_FEE_RATE × P × (1-P) (currently 0 for tennis).
    // KAL opposite completing: KALSHI_FEE_RATE × P × (1-P).
    const estCompletePrice2 = 1 - pos.kalCostBasis;
    const pmFeeReserve = PM_FEE_RATE * estCompletePrice2 * (1 - estCompletePrice2);
    const kalOppFeeReserve = KALSHI_FEE_RATE * estCompletePrice2 * (1 - estCompletePrice2);
    const maxPmPrice = 1 - pos.kalCostBasis - hedgeEdge2 - pmFeeReserve;
    const maxKalOppPrice = 1 - pos.kalCostBasis - hedgeEdge2 - kalOppFeeReserve;
    // Safety: log breakeven calculation on first hedge cycle
    if (!state.lastCompleteExchange) {
      console.log(`[HEDGE] KAL-held breakeven: kalCostBasis=${fmtPct(pos.kalCostBasis)} maxPmPrice=${fmtPct(maxPmPrice)} maxKalOpp=${fmtPct(maxKalOppPrice)} shares=${sharesNeeded}`);
    }
    const hedgeKalSide: "yes" | "no" = pos.kalSide === "yes" ? "no" : "yes";

    // ── Pre-hedge reconciliation: check if original PM FOK already filled on-chain ──
    // The original FOK can settle on-chain minutes after the CLOB API reported it as
    // unmatched (especially for sports markets with delayed matching). If the tokens are
    // already in the wallet, skip hedging — the position is already complete.
    // IMPORTANT: subtract PM shares already committed to OTHER trades on the same token
    // to avoid false-positive reconciliation (e.g. trade 1 bought 9 shares, trade 2's
    // FOK failed → wallet shows 9 but only trade 1 owns them).
    if (sharesNeeded > 0 && !DRY_RUN) {
      try {
        let pmHeld = await getOnChainBalanceWithFallback(pos.pmLeg.tokenId);
        if (pmHeld < 0) {
          // All RPCs failed — try data-api as last resort
          const positions = await fetchPmPositionsCached(0);
          pmHeld = sumPmHeld(positions, pos.pmLeg.tokenId);
        }
        // Subtract shares already attributed to other trades on this same PM token
        const otherTradesShares = loadArbTrades()
          .filter(t => t.id !== pos.tradeId && t.pmTokenId === pos.pmLeg.tokenId &&
                       (t.status === "filled" || t.status === "hedging" || t.status === "resolved") &&
                       t.pmCost > 0)
          .reduce((sum, t) => sum + t.shares, 0);
        const availableForThisTrade = pmHeld - otherTradesShares;
        if (otherTradesShares > 0) {
          console.log(`[HEDGE] On-chain balance ${pmHeld}× but ${otherTradesShares}× committed to other trades → ${availableForThisTrade}× available for this trade`);
        }
        if (availableForThisTrade >= sharesNeeded) {
          console.log(
            `\n[HEDGE] ✓ On-chain reconciliation: wallet holds ${availableForThisTrade}× available PM ${pos.pmLeg.outcome}` +
            ` (need ${sharesNeeded}). Original FOK likely filled late. Resolving hedge.\n`
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
              // Sort fills by time (newest first) — this trade's fills are likely the most recent
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
        console.warn(`[HEDGE] Pre-hedge on-chain reconciliation failed: ${(e as Error).message} — continuing normal hedge.`);
      }
    }

    // ── Single-exchange hedging: PM-only first, then KAL-only after PM_ONLY_MAX_CYCLES ──
    const inPmPhaseKH = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();

    // ── IOC sweeps: aggressively grab available asks each cycle ─────────────────
    // 1) Sweep PM token ask — only in PM phase
    if (inPmPhaseKH && sharesNeeded >= 5 && !isPmServiceDown()) {
      const pmCurrentAsk = await fetchPmAsk(pos.pmLeg.tokenId, clobBase);
      if (pmCurrentAsk !== null && pmCurrentAsk <= maxPmPrice && sharesNeeded * pmCurrentAsk >= PM_MARKETABLE_MIN_VALUE) {
        try {
          const res = await placePmFOK(pos.pmLeg.tokenId, pmCurrentAsk, sharesNeeded, pos.pmLeg.tickSize, pos.pmLeg.negRisk, DRY_RUN);
          if (isPm425(res)) { markPmDown(); }
          else {
            markPmUp();
            const meta = extractPmMeta(res);
            let filled = 0;
            if (DRY_RUN) {
              filled = sharesNeeded;
            } else if (meta.status === "matched") {
              filled = sharesNeeded;
            } else if (meta.status === "delayed" && meta.orderId) {
              console.log(`  [HEDGE] PM sweep on-chain pending, polling...`);
              const finalStatus = await waitForPmOrderFill(String(meta.orderId), 20_000, pos.pmLeg.tokenId);
              if (finalStatus === "matched") filled = sharesNeeded;
            }
            if (filled > 0) {
              pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
              pos.hedgeFillCost += filled * pmCurrentAsk;
              pos.hedgeFillCostPm += filled * pmCurrentAsk;
              sharesNeeded = pos.sharesHeld;
              console.log(`\n[HEDGE] IOC PM ${pos.pmLeg.outcome} filled ${filled}@${fmtPct(pmCurrentAsk)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
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
    // 2) Sweep Kalshi opposite side ask — only in KAL phase
    if (!inPmPhaseKH && sharesNeeded > 0 && Date.now() >= state.kalNextRetryAt) {
      const { ask: kalYesAsk, noAsk: kalNoAsk } = await fetchKalshiSingleMarket(pos.kalLeg.ticker);
      // We need the opposite side: if we hold YES, sweep NO asks; if we hold NO, sweep YES asks
      const oppAsk = hedgeKalSide === "no" ? kalNoAsk : kalYesAsk;
      if (oppAsk !== null && oppAsk <= maxKalOppPrice) {
        const oppAskCents = Math.max(1, Math.min(99, Math.round(oppAsk * 100)));
        const ioOrder = buildKalshiIOCOrder(pos.kalLeg.ticker, oppAsk, sharesNeeded, hedgeKalSide);
        try {
          const res = await placeKalshiOrder(ioOrder, DRY_RUN);
          const meta = extractKalMeta(res);
          const filled = DRY_RUN ? sharesNeeded : meta.filled;
          if (filled > 0) {
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * (oppAskCents / 100);
            pos.hedgeFillCostKal += filled * (oppAskCents / 100);
            pos.kalFees += meta.fees;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC Kalshi ${hedgeKalSide.toUpperCase()} filled ${filled}@${fmtPct(oppAskCents / 100)} fee=$${meta.fees.toFixed(2)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
            state.pmOnlyCycles = 0; // reset: switch back to PM-first on next cycle
            await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
            saveHedgeState(state);
            sharesNeeded = pos.sharesHeld;
            if (pos.sharesHeld <= 0) return;
          } else {
            state.kalNextRetryAt = Date.now() + 30_000;
          }
        } catch (e) {
          console.error(`[HEDGE] IOC Kalshi ${hedgeKalSide.toUpperCase()} sweep failed: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }
    }

    // ── Track PM-only cycles for single-exchange hedging ──
    if (inPmPhaseKH && sharesNeeded > 0) {
      state.pmOnlyCycles = (state.pmOnlyCycles ?? 0) + 1;
      if (state.pmOnlyCycles >= PM_ONLY_MAX_CYCLES) {
        console.log(`[HEDGE] KAL-held: ${state.pmOnlyCycles} PM-only cycles with no fill — switching to KAL-only`);
        // Cancel any resting PM GTC orders before switching to KAL
        for (const [oid, ho] of activeOrders) {
          if (ho.exchange === "pm") {
            try { await cancelPmOrder(oid, DRY_RUN); } catch { /* best effort */ }
            activeOrders.delete(oid);
          }
        }
      }
    }

    // ── SEQUENTIAL complete: only ONE complete order at a time (prevents double-fill) ──
    // Single-exchange: GTC orders only on the active phase's exchange
    const hasAnyCompleteKH = [...activeOrders.values()].some(o => o.role === "complete");
    if (!hasAnyCompleteKH && sharesNeeded > 0) {
      // Re-check market status + price before placing a new order
      try {
        const recheck = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`);
        const recheckMkt = recheck.market ?? recheck as unknown as KalshiMarket;
        const recheckStatus = pickString(recheckMkt.status ?? recheckMkt.state ?? "").toLowerCase();
        if (recheckStatus === "closed" || recheckStatus === "settled" || recheckStatus === "resolved" || recheckStatus === "finalized") {
          console.log(`[HEDGE] Market ${pos.kalLeg.ticker} is now ${recheckStatus} — skipping new order. Will resolve on next cycle.`);
          saveHedgeState(state);
          return;
        }
        // No price-based skip — always attempt hedging regardless of current price.
      } catch { /* non-critical — proceed with order placement */ }

      // Single-exchange hedging: only place GTC on the current phase's exchange
      const inPmNowKH = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();
      const pmViableKH = !isPmServiceDown() && sharesNeeded >= 5;
      const tryOrderKH: Array<"kal" | "pm"> = inPmNowKH ? (pmViableKH ? ["pm"] : []) : ["kal"];
      let placed = false;

      for (const tryExchangeKH of tryOrderKH) {
        if (placed) break;

      if (!placed && tryExchangeKH === "pm") {
        // ── Try PM GTC BID for the needed token ─────────────────────────────
        const pmTick = pos.pmLeg.tickSize || 0.01;
        const pmBidPrice = Math.floor(maxPmPrice / pmTick) * pmTick;
        if (pmBidPrice > 0 && sharesNeeded * pmBidPrice >= PM_MARKETABLE_MIN_VALUE) {
          try {
            const res = await placePmGTCBid(pos.pmLeg.tokenId, pmBidPrice, sharesNeeded, pmTick, pos.pmLeg.negRisk, DRY_RUN);
            if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-complete-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "complete", exchange: "pm", orderId: oid, price: pmBidPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                state.lastCompleteExchange = "pm";
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC BID ${sharesNeeded}×${pos.pmLeg.outcome}@${fmtPct(pmBidPrice)} (complete-pm). orderId=${oid}`);
                placed = true;
                if (!DRY_RUN && meta.status === "matched") {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - sharesNeeded);
                  pos.hedgeFillCost += sharesNeeded * pmBidPrice;
                  pos.hedgeFillCostPm += sharesNeeded * pmBidPrice;
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] PM GTC filled immediately (${sharesNeeded}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
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

      // ── Try Kalshi opposite-side GTC bid ─────────────────────────────────────
      if (!placed && tryExchangeKH === "kal" && sharesNeeded > 0) {
        const kalOppCents = Math.max(1, Math.min(99, Math.floor(maxKalOppPrice * 100)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", hedgeKalSide, kalOppCents, sharesNeeded);
        try {
          const res = await placeKalshiOrder(order, DRY_RUN);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-opp-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalOppCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            state.lastCompleteExchange = "kal";
            saveHedgeState(state);
            console.log(`\n[HEDGE] Placed Kalshi GTC ${hedgeKalSide.toUpperCase()}-BID ${sharesNeeded}×@${fmtPct(kalOppCents / 100)} (complete-kal ${hedgeKalSide.toUpperCase()}). orderId=${oid}`);
            try {
              const check = await getKalshiOrder(oid);
              const checkStatus = String(check.status ?? "");
              const checkRemaining = Number(check.remaining_count ?? sharesNeeded);
              console.log(`[HEDGE] Kalshi ${hedgeKalSide.toUpperCase()} GTC verify: status=${checkStatus} remaining=${checkRemaining}`);
              if (checkStatus === "executed" || checkStatus === "filled") {
                const immediatelyFilled = sharesNeeded - checkRemaining;
                if (immediatelyFilled > 0) {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - immediatelyFilled);
                  pos.hedgeFillCost += immediatelyFilled * (kalOppCents / 100);
                  pos.hedgeFillCostKal += immediatelyFilled * (kalOppCents / 100);
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] Kalshi ${hedgeKalSide.toUpperCase()} GTC filled immediately (${immediatelyFilled}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
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
              console.error(`[HEDGE] Kalshi ${hedgeKalSide.toUpperCase()} GTC verify FAILED: ${(ve as Error).message}`);
            }
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC ${hedgeKalSide.toUpperCase()} bid: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }

      } // end for (tryOrderKH)
    }

    // ── exit: sell our Kalshi side at cost basis (skipped if STRICT_HEDGE)
    // Always place at cost basis — the GTC rests until price comes back up.
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
            console.log(`\n[HEDGE] Placed Kalshi GTC ${pos.kalSide.toUpperCase()}-ASK ${pos.sharesHeld}×@${fmtPct(exitCents / 100)} (exit at cost). orderId=${oid}`);
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC sell: ${(e as Error).message}`);
        }
      }
    }
  }
}

// ─── Startup position scan ────────────────────────────────────────────────────
// When no saved hedge_state.json exists, scan the Polymarket wallet for live
// positions and cross-reference against the current watchlist.
// If a match is found the bot automatically enters hedge mode — no manual action needed.

export async function detectUnhedgedPmPositions(watchlist: WatchEntry[], hedgeStateTickers?: Set<string>): Promise<HedgeState[]> {
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
  // the PM tokens look "unhedged". But the arb was already resolved — don't re-process.
  const existingTrades = loadArbTrades();
  const resolvedSharesByPm = new Map<string, number>(); // key: "pmSlug|pmOutcome" → total resolved shares
  const resolvedSharesByTokenId = new Map<string, number>(); // key: pmTokenId → total resolved shares
  for (const t of existingTrades) {
    if (t.status === "resolved" || t.status === "filled") {
      const key = `${t.pmSlug}|${t.pmOutcome}`;
      resolvedSharesByPm.set(key, (resolvedSharesByPm.get(key) ?? 0) + (t.shares ?? 0));
      if (t.pmTokenId) {
        resolvedSharesByTokenId.set(t.pmTokenId, (resolvedSharesByTokenId.get(t.pmTokenId) ?? 0) + (t.shares ?? 0));
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
      }
    }
  }

  // Build tokenId → watchlist leg lookup.
  // 2-way: Holding pm1 → needs kal2 YES to complete (dir=B), oppLeg=pm2
  //        Holding pm2 → needs kal1 YES to complete (dir=A), oppLeg=pm1
  // 3-way: Holding pm1 YES → needs kal1 NO to complete (dir=G: KAL Home NO + PM Home YES)
  //        Holding pm2 YES → needs kal2 NO to complete (dir=I: KAL Away NO + PM Away YES)
  //        Holding pm3 YES → needs kal3 NO to complete (dir=H: KAL Draw NO + PM Draw YES)
  //        Holding pm1 NO  → needs kal1 YES to complete (dir=J: KAL Home YES + PM Home NO)
  //        Holding pm2 NO  → needs kal2 YES to complete (dir=L: KAL Away YES + PM Away NO)
  //        Holding pm3 NO  → needs kal3 YES to complete (dir=K: KAL Draw YES + PM Draw NO)
  //   Using opposite-player KAL (2-way mapping) in 3-way leaves draw UNCOVERED.
  //   Using same-outcome KAL guarantees $1 payout regardless of result.
  type LegMatch = { entry: WatchEntry; pmLeg: PmLeg; pmOppLeg: PmLeg | null; kalLeg: KalshiLeg; kalSide3Way?: "yes" | "no" };
  const tokenMap = new Map<string, LegMatch>();
  for (const entry of watchlist) {
    if (entry.is3Way) {
      // YES tokens → hedge with KAL NO on SAME outcome (Dir G/H/I)
      tokenMap.set(entry.pm1.tokenId, { entry, pmLeg: entry.pm1, pmOppLeg: null, kalLeg: entry.kal1, kalSide3Way: "no" });
      tokenMap.set(entry.pm2.tokenId, { entry, pmLeg: entry.pm2, pmOppLeg: null, kalLeg: entry.kal2, kalSide3Way: "no" });
      if (entry.pm3 && entry.kal3) {
        tokenMap.set(entry.pm3.tokenId, { entry, pmLeg: entry.pm3, pmOppLeg: null, kalLeg: entry.kal3, kalSide3Way: "no" });
      }
      // NO tokens → hedge with KAL YES on SAME outcome (Dir J/K/L)
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
        `[STARTUP] Unrecognized PM position — tokenId=${tokenId.slice(0, 16)}... size=${size}.` +
        ` Not in today's watchlist — please resolve manually.`
      );
      continue;
    }

    // Conservative cost basis: if API doesn't return avg price, assume 0.50 (mid-market).
    // Using tickSize (0.01) would make maxKalPrice ≈ 0.99, effectively a market-buy — dangerous.
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
    const kalAlreadyFilledRaw = await getKalshiPosition(m.kalLeg.ticker);
    if (kalAlreadyFilledRaw < 0) {
      console.warn(`[STARTUP] Kalshi API error for ${m.kalLeg.ticker} — skipping PM position to avoid duplicate arbs.`);
      continue;
    }
    const kalAlreadyFilled = kalAlreadyFilledRaw;

    // Count shares already accounted for in resolved/active arb trades
    // Use BOTH slug+outcome and tokenId lookups — whichever finds more (handles string mismatches)
    const tradeKey = `${m.entry.pmSlug}|${m.pmLeg.outcome}`;
    const bySlug = resolvedSharesByPm.get(tradeKey) ?? 0;
    const byToken = resolvedSharesByTokenId.get(m.pmLeg.tokenId) ?? 0;
    const alreadyTracked = Math.max(bySlug, byToken);

    // Net unhedged = total PM shares minus whatever is already covered on either side
    // alreadyTracked may overlap with oppPmSize/kalAlreadyFilled (same shares in trade records AND exchange),
    // so use the larger of (live coverage) vs (tracked trades) to avoid double-counting
    const liveCoverage = oppPmSize + kalAlreadyFilled;
    const covered = Math.min(totalPmShares, Math.max(liveCoverage, alreadyTracked));
    const sharesHeld = totalPmShares - covered;

    if (sharesHeld <= 0) {
      const parts: string[] = [];
      if (kalAlreadyFilled > 0) parts.push(`KAL ${kalAlreadyFilled}`);
      if (oppPmSize > 0) parts.push(`PM-opp ${oppPmSize}`);
      if (alreadyTracked > 0) parts.push(`trades ${alreadyTracked}`);
      console.log(
        `[STARTUP] PM ${totalPmShares}×${m.pmLeg.outcome} — fully covered` +
        ` (${parts.join(" + ")}). Arb complete, skipping.\n`
      );
      continue;
    }

    if (covered > 0) {
      console.log(
        `[STARTUP] PM ${totalPmShares}×${m.pmLeg.outcome} — ${covered} already covered` +
        ` (KAL ${kalAlreadyFilled} + PM-opp ${oppPmSize}). Net unhedged: ${sharesHeld}.`
      );
    }

    console.warn(
      `\n[STARTUP] Found unhedged PM position: ${sharesHeld}×${m.pmLeg.outcome}` +
      ` @${fmtPct(avgPrice)} (${m.entry.pmSlug}). Will hedge automatically.\n`
    );

    // Determine kalSide: 3-way uses kalSide3Way from tokenMap, 2-way defaults to "yes"
    const detectedKalSide: "yes" | "no" = m.kalSide3Way ?? "yes";

    // Log an arb trade entry so resolveArbTrade can find it when the hedge completes.
    const pmCostForTrade = Math.round(sharesHeld * avgPrice * 100) / 100;
    // Pick the closest matching dir for audit trail
    const detectedDir: ArbTradeRecord["dir"] = m.kalSide3Way === "no" ? "G" : m.kalSide3Way === "yes" ? "J" : "A";
    const tidDetect = `arb-detect-${Date.now()}`;
    logArbTrade({
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
    });

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
    });
  }

  return results;
}

// ─── Startup Kalshi position scan ─────────────────────────────────────────────
// Mirror of detectUnhedgedPmPositions — scans the Kalshi portfolio for open YES
// positions and cross-references against the watchlist.  If a match is found and
// neither the PM leg nor the Kalshi NO leg is already held, enters hedge mode.

export async function detectUnhedgedKalPositions(watchlist: WatchEntry[], kalPosMap?: Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>, hedgeStateTickers?: Set<string>): Promise<HedgeState[]> {
  // Build ticker → watchlist leg lookup.
  // 2-way markets: Holding kal1 YES → needs pm2 to complete (dir=A logic)
  //                Holding kal2 YES → needs pm1 to complete (dir=B logic)
  // 3-way soccer:  Holding kal1 YES → needs PM Home NO to complete (dir=J logic)
  //                Holding kal2 YES → needs PM Away NO to complete (dir=L logic)
  //                Holding kal3 YES → needs PM Draw NO to complete (dir=K logic)
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
  console.log(`[STARTUP] KAL scan: ${kalYesPositions.length} YES position(s): ${kalYesPositions.map(p => `${p.yesCount}×${p.ticker}`).join(", ")}`);

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
  const resolvedSharesByKal = new Map<string, number>(); // key: kalTicker → total resolved shares
  for (const t of existingTrades) {
    if (t.status === "resolved" || t.status === "filled") {
      resolvedSharesByKal.set(t.kalTicker, (resolvedSharesByKal.get(t.kalTicker) ?? 0) + (t.shares ?? 0));
    } else if (t.status === "hedging") {
      // Only count "hedging" trades as tracked if they're actually in hedge_state.json.
      // If hedge state was lost (crash/restart), these positions need to be re-detected.
      if (hedgeStateTickers?.has(t.kalTicker)) {
        resolvedSharesByKal.set(t.kalTicker, (resolvedSharesByKal.get(t.kalTicker) ?? 0) + (t.shares ?? 0));
      } else {
        console.warn(`[STARTUP] Orphaned hedge trade: ${t.kalTicker} (${t.shares} shares) — status=hedging but NOT in hedge_state.json. Will re-detect.`);
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
        `\n[STARTUP] ⚠ Orphaned Kalshi position: ${yesCount}×${ticker} YES` +
        `  status=${status}${extra}` +
        (title ? `\n         ${title}` : "") +
        `\n         Not in today's watchlist — cannot auto-hedge.` +
        (status === "finalized" || status === "settled"
          ? `\n         Market is settled. Kalshi should pay out automatically.`
          : status === "closed"
          ? `\n         Event finished but not yet settled — payout pending.`
          : `\n         Market still open — resolve manually or add to watchlist.\n`)
      );
      continue;
    }

    const totalKalShares = yesCount;

    // Count how many shares are already covered by the Kalshi NO leg (YES + NO = $1)
    // Use the pre-fetched position map — no extra API call per ticker.
    const kalNoFilled = posMap.get(ticker)?.noCount ?? 0;

    // Count how many shares are already covered by the PM leg (complete-pm path)
    const pmHeld = Math.round(pmPositions.reduce((sum, p) => {
      const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
      const sz = Number(p.size ?? p.amount ?? 0);
      return tid === m.pmLeg.tokenId ? sum + sz : sum;
    }, 0));

    // Count shares already accounted for in resolved/active arb trades
    const alreadyTracked = resolvedSharesByKal.get(ticker) ?? 0;

    console.log(`[STARTUP] KAL ${totalKalShares}×${ticker}: kalNO=${kalNoFilled} pmHeld=${pmHeld} tracked=${alreadyTracked} inHedgeState=${hedgeStateTickers?.has(ticker) ?? "n/a"}`);

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
        `[STARTUP] Kalshi ${totalKalShares}×${ticker} YES — fully covered` +
        ` (${parts.join(" + ")}). Arb complete, skipping.\n`
      );
      continue;
    }

    if (covered > 0) {
      console.log(
        `[STARTUP] Kalshi ${totalKalShares}×${ticker} YES — ${covered} already covered` +
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
      `\n[STARTUP] Found unhedged Kalshi position: ${sharesHeld}×${ticker} YES` +
      ` @~${fmtPct(avgFillPrice)} fee=$${actualKalFees.toFixed(2)} (${fmtPct(kalFeePerShare)}/sh) (${m.entry.pmSlug}). Will hedge automatically.\n`
    );

    // Log an arb trade entry so resolveArbTrade can find it when the hedge completes.
    // Without this, the resolved hedge has no audit trail in arb_trades.json.
    const kalCostForTrade = Math.round(sharesHeld * avgFillPrice * 100) / 100;
    const tidKalDetect = `arb-detect-${Date.now()}`;
    logArbTrade({
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
    });

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
    });
  }

  return results;
}
