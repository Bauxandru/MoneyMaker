/**
 * ttReconcile.ts — Reconciliation, ghost-fill handling, and book tracking.
 *
 * Extracted from tradeTennis.ts.  Contains:
 *   • handleGhostFill          – detect & handle delayed PM fills that appear on-chain
 *   • startBookTracker         – continuous orderbook snapshot sampler around arb execution
 *   • postResolutionFillAudit  – post-resolve Kalshi fill audit (Option D)
 *   • repairPmCostsFromClob    – repair PM costs via CLOB getTrades() API
 *   • verifyAndFixPnl          – verify & fix P&L for resolved trades
 *   • writeReconcileAudit      – audit trail writer
 *   • reconcilePositions       – main reconciliation loop
 *   • getPmFunder / fetchPmPositionsCached / sumPmHeld – PM position helpers
 *   • extractPmMeta / extractKalMeta – order-response metadata extractors
 */

import fs from "fs";
import path from "path";
import { Wallet } from "@ethersproject/wallet";

import { sleep, pickString, parseJsonArray, totalCostForTrade, kalSideForDir, normCents, normDollarsOrCents } from "../utils.js";
import { fetchJsonWithRetry } from "../http.js";
import { resolvePolyApiCreds } from "../polyAuth.js";
import { getOnChainBalance, getOnChainBalanceWithFallback } from "../polyChain.js";

import { atomicWriteFileSync, DRY_RUN, KALSHI_FEE_RATE, MIN_EDGE, kalFetch, polyFetch, polyClobFetch, fmtPct, retryOpts, ts } from "./ttConfig.js";
import type { ArbTradeRecord, ExecMetric, PmPosition, KalshiMarket, WatchEntry, ArbDir, WsLiveBook, BookTrack, BookSample, KalshiOrder, PmOrderResponse, UnhedgedPosition, HedgeState } from "./ttTypes.js";
import {
  loadArbTrades, saveArbTrades, completePendingFill, getIncompletePendingFills,
  loadPendingFills, resolveArbTrade, loadMetrics, logArbTrade, saveBookTrack,
  _activePendingFillId, setActivePendingFillId,
  _reconcileRecoveredTrades, setReconcileRecoveredTrades,
  BOOK_SNAPSHOTS_PATH, loadHedgeStates,
} from "./ttPersistence.js";
import { getWsKalBook, getWsPmAsks, getWsPmBids, getWsPmBestAsk, wsKalBooks, wsPmBooks, getWsKalBestAsk } from "./ttWebSocket.js";
import { createPmClient, fetchPmAsk } from "./ttPmOrders.js";
import { namesMatch } from "./ttNameMatch.js";
import {
  fetchAllKalshiFills, fetchAllKalshiSettlements, getKalshiPositionMap,
  fetchKalshiMarket, fetchKalshiOrderbook,
  type KalFill, type KalSettlement,
} from "../kalshiTrade.js";

// ─── Module-level state ───────────────────────────────────────────────────────

let _reconcileSnapshot = new Map<string, Record<string, unknown>>();
let _reconcileTrigger = "startup";
let _pmPosCache: { data: PmPosition[]; ts: number } | null = null;
let _cachedFunder: string | null = null;

// ─── Book tracker constants ───────────────────────────────────────────────────

const BOOK_TRACK_DURATION_MS = 20_000;
const BOOK_TRACK_INTERVAL_MS = 50;

// ─── Ghost fill handler ──────────────────────────────────────────────────────

export async function handleGhostFill(tokenId: string, shares: number, txHash: string): Promise<void> {
  const pendingFills = loadPendingFills();
  const ghostPf = pendingFills.find(pf =>
    !pf.completed && pf.exchange === "pm" && pf.pmTokenId === tokenId
  );
  if (!ghostPf) return; // Not a ghost fill — normal fill, ignore

  // Guard: if this pending fill belongs to the CURRENTLY RUNNING execution, skip.
  // The WSS on-chain event fires 2-4s before the PM API poll confirms — during that
  // window the pending fill is still incomplete but the execution is actively waiting
  // for it. Let the execution path handle it; don't create a duplicate ghost trade.
  if (_activePendingFillId === ghostPf.id) {
    console.log(`[GHOST] Skipping — pending fill ${ghostPf.id} belongs to active execution (WSS arrived before PM API confirm). Execution will handle it.`);
    return;
  }

  console.warn(
    `\n[GHOST] Detected ghost fill: ${shares}× token=...${tokenId.slice(-12)} (tx=${txHash.slice(0, 18)}...)` +
    `\n[GHOST] Matches pending fill ${ghostPf.id}: ${ghostPf.match} ${ghostPf.pmOutcome} @$${ghostPf.price}` +
    `\n[GHOST] This was a delayed PM order that appeared to fail but settled on-chain.`
  );

  // Mark pending fill as completed
  completePendingFill(ghostPf.id);

  // Look for a "hedging" trade on the same KAL ticker that needs PM shares
  const trades = loadArbTrades();
  const hedgingTrade = trades.find(t =>
    t.status === "hedging" && t.kalTicker === ghostPf.kalTicker && t.pmCost === 0
  );

  if (hedgingTrade) {
    // The hedge trade was waiting for PM shares — they just arrived as a ghost fill!
    // Use the actual fill price from the CLOB API if possible, fall back to pending fill price
    const actualPrice = ghostPf.price;
    const pmCost = Math.round(hedgingTrade.shares * actualPrice * 100) / 100;
    const totalCost = Math.round((hedgingTrade.kalCost + pmCost) * 100) / 100;
    const costPerShare = totalCost / Math.max(hedgingTrade.shares, 1);

    if (costPerShare < 1) {
      // Profitable — resolve the trade
      hedgingTrade.status = "resolved";
      hedgingTrade.resolutionMethod = "hedge-complete";
      hedgingTrade.resolvedTs = new Date().toISOString();
      hedgingTrade.pmFillPrice = actualPrice;
      hedgingTrade.pmCost = pmCost;
      hedgingTrade.totalCost = totalCost;
      hedgingTrade.realizedPnl = Math.round((hedgingTrade.shares - totalCost) * 100) / 100;
      saveArbTrades(trades);
      console.warn(
        `[GHOST] Resolved trade ${hedgingTrade.id}: ${hedgingTrade.match} — ghost PM fill @${(actualPrice * 100).toFixed(0)}¢ ` +
        `combined $${costPerShare.toFixed(2)}/sh → P&L=$${hedgingTrade.realizedPnl!.toFixed(2)}`
      );
    } else {
      // Cost >= $1 — linking them would be a guaranteed loss.
      // Treat as 2 independent unhedged positions, each hedging at breakeven via normal hedge loop.
      // Don't link ghost PM to the KAL trade — create a separate trade for the ghost PM position.
      console.warn(
        `[GHOST] Combined cost $${costPerShare.toFixed(2)}/sh >= $1.00 for ${hedgingTrade.match}. ` +
        `Treating as 2 independent positions — each will hedge at breakeven.`
      );
      const ghostTrade: ArbTradeRecord = {
        id: `arb-ghost-${Date.now()}-pm`,
        ts: new Date().toISOString(),
        match: ghostPf.match,
        dir: ghostPf.dir as ArbTradeRecord["dir"],
        status: "hedging",
        shares: Math.min(shares, hedgingTrade.shares),
        kalTicker: ghostPf.kalTicker,
        kalFillPrice: 0,
        kalCost: 0,
        pmOutcome: ghostPf.pmOutcome,
        pmSlug: ghostPf.pmSlug,
        pmTokenId: ghostPf.pmTokenId,
        pmFillPrice: actualPrice,
        pmCost: Math.round(Math.min(shares, hedgingTrade.shares) * actualPrice * 100) / 100,
        totalCost: Math.round(Math.min(shares, hedgingTrade.shares) * actualPrice * 100) / 100,
        projectedEdge: 0,
        projectedProfit: 0,
        initialExchange: "pm",
      };
      trades.push(ghostTrade);
      saveArbTrades(trades);
      console.warn(
        `[GHOST] Created ghost trade ${ghostTrade.id}: ${ghostTrade.shares}×${ghostPf.pmOutcome} @${(actualPrice * 100).toFixed(0)}¢ — ` +
        `will hedge at max ${((1 - actualPrice) * 100).toFixed(0)}¢ on KAL. ` +
        `Original KAL trade ${hedgingTrade.id} stays in hedge mode — will hedge at max ${((1 - hedgingTrade.kalCost / Math.max(hedgingTrade.shares, 1)) * 100).toFixed(0)}¢ on PM.`
      );
    }
  } else {
    // No matching hedging trade — create a new hedge trade for the ghost PM position.
    const ghostTrade: ArbTradeRecord = {
      id: `arb-ghost-${Date.now()}-pm`,
      ts: new Date().toISOString(),
      match: ghostPf.match,
      dir: ghostPf.dir as ArbTradeRecord["dir"],
      status: "hedging",
      shares,
      kalTicker: ghostPf.kalTicker,
      kalFillPrice: 0,
      kalCost: 0,
      pmOutcome: ghostPf.pmOutcome,
      pmSlug: ghostPf.pmSlug,
      pmTokenId: ghostPf.pmTokenId,
      pmFillPrice: ghostPf.price,
      pmCost: Math.round(shares * ghostPf.price * 100) / 100,
      totalCost: Math.round(shares * ghostPf.price * 100) / 100,
      projectedEdge: 0,
      projectedProfit: 0,
      initialExchange: "pm",
    };
    const trades = loadArbTrades();
    trades.push(ghostTrade);
    saveArbTrades(trades);
    // Signal the main loop to pick up this new hedging trade immediately
    setReconcileRecoveredTrades(true);
    console.warn(
      `[GHOST] Created orphan ghost trade ${ghostTrade.id}: ${shares}×${ghostPf.pmOutcome} @${(ghostPf.price * 100).toFixed(0)}¢ — ` +
      `entering hedge mode (max KAL hedge = ${((1 - ghostPf.price) * 100).toFixed(0)}¢).`
    );
  }
}

// ─── Continuous book snapshot tracker ─────────────────────────────────────────
// On arb discovery, samples both orderbooks every 500ms for 20s and saves to disk.
// Lets you audit exactly what the books looked like around execution time.

export function startBookTracker(
  kalTicker: string,
  pmTokenId: string,
  meta: { match: string; dir: string; pmOutcome: string; kalAsk: number; pmAsk: number; edge: number; tradeTs: number },
  phase: "discovery" | "execution" = "discovery"
): void {
  const track: BookTrack = {
    id: `arb-${meta.tradeTs}`,
    ts: new Date().toISOString(),
    phase,
    match: meta.match,
    dir: meta.dir,
    kalTicker,
    pmTokenId,
    pmOutcome: meta.pmOutcome,
    kalAskAtDiscovery: meta.kalAsk,
    pmAskAtDiscovery: meta.pmAsk,
    edge: meta.edge,
    samples: [],
  };
  const startMs = Date.now();

  const takeSample = () => {
    const t = Date.now() - startMs;
    let source: BookSample["source"] = "ws";

    // Kalshi: WS first — capture full book (both bids and derived asks)
    const kalWs = getWsKalBook(kalTicker);
    let kalYesBids: [number, number][] = [];
    let kalNoBids: [number, number][] = [];
    let kalYesAsks: [number, number][] = [];
    let kalNoAsks: [number, number][] = [];
    if (kalWs) {
      // All bids sorted ascending by price
      kalYesBids = kalWs.yes;  // full YES bids
      kalNoBids = kalWs.no;    // full NO bids
      // Derived asks: YES ask = 100 - NO bid price, NO ask = 100 - YES bid price
      kalYesAsks = kalNoBids.map(([p, s]) => [100 - p, s] as [number, number]).sort((a, b) => a[0] - b[0]);
      kalNoAsks = kalYesBids.map(([p, s]) => [100 - p, s] as [number, number]).sort((a, b) => a[0] - b[0]);
    } else {
      source = "rest";
      // Fire-and-forget REST fetch — will appear in next sample
      fetchKalshiOrderbook(kalTicker).then(book => {
        if (book) {
          const wsBook: WsLiveBook = {
            yes: new Map(book.yes.map(([p, s]) => [p, s])),
            no: new Map(book.no.map(([p, s]) => [p, s])),
            ts: Date.now(),
          };
          wsKalBooks.set(kalTicker, wsBook);
        }
      }).catch(() => {});
    }

    // PM: WS first — capture top 20 levels
    const pmWsAsks = getWsPmAsks(pmTokenId);
    const pmWsBids = getWsPmBids(pmTokenId);
    const pmAsks: [number, number][] = pmWsAsks ? pmWsAsks.slice(0, 20) : [];
    const pmBids: [number, number][] = pmWsBids ? pmWsBids.slice(0, 20) : [];
    if (!pmWsAsks && source === "ws") source = "mixed";

    track.samples.push({ t, kalYesBids, kalNoBids, kalYesAsks, kalNoAsks, pmAsks, pmBids, source });
  };

  // Take first sample immediately
  takeSample();

  const iv = setInterval(() => {
    if (Date.now() - startMs >= BOOK_TRACK_DURATION_MS) {
      clearInterval(iv);
      try { saveBookTrack(track); } catch (e) { console.error(`[BOOK TRACK] Save failed:`, e); }
      console.log(`[BOOK TRACK] Saved ${track.samples.length} ${phase} samples for ${meta.match} (${BOOK_TRACK_DURATION_MS / 1000}s)`);
      return;
    }
    takeSample();
  }, BOOK_TRACK_INTERVAL_MS);
}

// ─── Post-Resolution Fill Audit (Option D) ──────────────────────────────────
// After resolving a hedge-complete trade, checks Kalshi fills for untracked buys
// (e.g., race condition where GTC fills after cancel). Corrects costs and P&L.

export async function postResolutionFillAudit(kalTicker: string, tradeId: string): Promise<void> {
  try {
    const allFills = await fetchAllKalshiFills();
    const tickerFills = allFills.filter(f => f.ticker === kalTicker && f.action === "buy");
    if (tickerFills.length === 0) return;

    // Sum actual KAL buys from exchange
    let actualBuyCost = 0;
    let actualFees = 0;
    let actualBuyCount = 0;
    for (const f of tickerFills) {
      const price = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100;
      actualBuyCost += f.count * price;
      actualFees += f.feeCost;
      actualBuyCount += f.count;
    }
    actualBuyCost = Math.round(actualBuyCost * 100) / 100;
    actualFees = Math.round(actualFees * 100) / 100;

    // Load the trade and check for discrepancy
    const trades = loadArbTrades();
    const trade = trades.find(t => t.id === tradeId);
    if (!trade || trade.status !== "resolved") return;

    // Compare: are there more fills on exchange than tracked?
    const trackedKalCost = trade.kalCost ?? 0;
    const trackedKalFees = trade.kalFees ?? 0;
    const totalExchangeCost = actualBuyCost + actualFees;
    const totalTrackedCost = trackedKalCost + trackedKalFees;
    const discrepancy = Math.abs(totalExchangeCost - totalTrackedCost);

    if (discrepancy < 0.02) return; // within rounding tolerance

    // Check if another trade shares this ticker (shared ticker = don't audit)
    const sharedCount = trades.filter(t => t.kalTicker === kalTicker).length;
    if (sharedCount > 1) {
      console.log(`[AUDIT] Ticker ${kalTicker} shared by ${sharedCount} trades — skipping fill audit`);
      return;
    }

    console.warn(
      `\n[AUDIT] ⚠ Fill discrepancy for ${kalTicker} (trade ${tradeId}):\n` +
      `  Exchange: ${actualBuyCount} buys, cost=$${actualBuyCost.toFixed(2)}, fees=$${actualFees.toFixed(2)}, total=$${totalExchangeCost.toFixed(2)}\n` +
      `  Tracked:  kalCost=$${trackedKalCost.toFixed(2)}, kalFees=$${trackedKalFees.toFixed(2)}, total=$${totalTrackedCost.toFixed(2)}\n` +
      `  Δ = $${discrepancy.toFixed(2)} — correcting trade record`
    );

    // Correct the trade: update kalCost to include ALL exchange buys
    const correctedKalCost = actualBuyCost;
    const correctedKalFees = actualFees;
    const correctedTotalCost = Math.round((correctedKalCost + correctedKalFees + (trade.pmCost ?? 0)) * 100) / 100;
    const correctedPnl = Math.round((trade.shares - correctedTotalCost) * 100) / 100;

    trade.kalCost = correctedKalCost;
    trade.kalFees = correctedKalFees;
    trade.totalCost = correctedTotalCost;
    trade.realizedPnl = correctedPnl;
    trade.resolutionNote = `audit-corrected: +$${discrepancy.toFixed(2)} untracked KAL fills (${actualBuyCount} buys vs ${trade.shares} shares)`;
    saveArbTrades(trades);

    console.log(
      `[AUDIT] Corrected: kalCost=$${correctedKalCost.toFixed(2)} totalCost=$${correctedTotalCost.toFixed(2)} P&L=$${correctedPnl.toFixed(2)}`
    );
  } catch (e) {
    console.warn(`[AUDIT] Post-resolution fill audit failed: ${(e as Error).message}`);
  }
}

// ─── Position Reconciliation ─────────────────────────────────────────────────
// Fetches ground truth from both exchanges and corrects arb_trades.json.
// Runs on startup + every hour to keep P&L log accurate.

// ── Reconcile sub-steps (extracted for readability) ──────────────────────────

/** (c2) Repair PM costs using CLOB getTrades() API + on-chain fallback. Mutates trades in place. */
export async function repairPmCostsFromClob(trades: ArbTradeRecord[]): Promise<{ repaired: number; changed: boolean }> {
  let repaired = 0;
  let changed = false;
  // Include resolved trades with pmCost=0 — section (a) may have resolved via settlement
  // before CLOB repair ran, leaving pmCost=0 on trades that actually had PM fills.
  const needRepair = trades.filter(t => t.pmTokenId && t.pmCost === 0 && t.pmFillPrice === 0);
  if (needRepair.length === 0) return { repaired, changed };

  // Retry CLOB getTrades() up to 5 times with exponential backoff.
  // No estimated fallback — we only use actual exchange data.
  const MAX_CLOB_RETRIES = 5;
  type ClobFill = { asset_id: string; size: string; price: string; fee_rate_bps: string; side: string; status: string; match_time: string };
  let clobTrades: ClobFill[] | null = null;
  for (let attempt = 1; attempt <= MAX_CLOB_RETRIES; attempt++) {
    try {
      const { client } = await createPmClient();
      clobTrades = (await client.getTrades()) as unknown as ClobFill[];
      break;
    } catch (e) {
      console.warn(`[RECONCILE]   PM CLOB fetch attempt ${attempt}/${MAX_CLOB_RETRIES} failed: ${(e as Error).message}`);
      if (attempt < MAX_CLOB_RETRIES) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        console.log(`[RECONCILE]   Retrying in ${(delayMs / 1000).toFixed(0)}s...`);
        await sleep(delayMs);
      } else {
        console.error(`[RECONCILE]   PM CLOB fetch failed after ${MAX_CLOB_RETRIES} attempts. ${needRepair.length} trades left unrepaired.`);
      }
    }
  }

  if (clobTrades) {
    const pmFillsByToken = new Map<string, ClobFill[]>();
    for (const ct of clobTrades) {
      if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
      const list = pmFillsByToken.get(ct.asset_id) ?? [];
      list.push(ct);
      pmFillsByToken.set(ct.asset_id, list);
    }
    const usedPmIdx = new Map<string, Set<number>>();

    for (const trade of needRepair) {
      const fills = pmFillsByToken.get(trade.pmTokenId!);
      if (!fills || fills.length === 0) continue;
      let used = usedPmIdx.get(trade.pmTokenId!);
      if (!used) { used = new Set(); usedPmIdx.set(trade.pmTokenId!, used); }

      const tradeSec = new Date(trade.ts).getTime() / 1000;
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < fills.length; i++) {
        if (used.has(i)) continue;
        const rawMt = fills[i].match_time;
        const fillSec = /^\d+(\.\d+)?$/.test(rawMt) ? Number(rawMt) : new Date(rawMt).getTime() / 1000;
        const dist = Math.abs(fillSec - tradeSec);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      // Hedge trades may have PM fills minutes/hours after KAL fill — allow wider window
      const maxDistSec = (trade.status === "resolved" || trade.initialExchange === "kal") ? 7200 : 60;
      if (bestIdx < 0 || bestDist > maxDistSec) continue;
      used.add(bestIdx);

      const f = fills[bestIdx];
      const price = Number(f.price);
      const feeBps = Number(f.fee_rate_bps);
      const feePerShare = price * (feeBps / 10000);
      const avgPrice = Math.round((price + feePerShare) * 100) / 100;
      trade.pmFillPrice = avgPrice;
      trade.pmCost = Math.round(trade.shares * avgPrice * 100) / 100;
      trade.totalCost = totalCostForTrade(trade);
      // Recalculate P&L for resolved trades that were settled with pmCost=0
      if (trade.status === "resolved" && trade.realizedPnl != null) {
        const hedgeCost = trade.hedgeCost ?? 0;
        const payout = trade.shares; // arb guarantees $1/share when both legs exist
        const oldPnl = trade.realizedPnl;
        trade.realizedPnl = Math.round((payout - trade.kalCost - trade.pmCost - hedgeCost) * 100) / 100;
        console.log(`[RECONCILE]   PM CLOB P&L fix: ${trade.match} → P&L $${oldPnl.toFixed(2)}→$${trade.realizedPnl.toFixed(2)} (pmCost was missing)`);
      }
      console.log(`[RECONCILE]   PM CLOB repair: ${trade.match} → pmFP=${avgPrice} pmCost=$${trade.pmCost.toFixed(2)} (ts-matched)`);
      repaired++;
      changed = true;
    }
  }
  return { repaired, changed };
}

/** (d) Verify and fix P&L for all resolved trades. Mutates trades in place. */
export async function verifyAndFixPnl(
  trades: ArbTradeRecord[],
  settlementByTicker: Map<string, KalSettlement>
): Promise<{ fixed: number; changed: boolean }> {
  let fixed = 0;
  let changed = false;

  for (const trade of trades) {
    if (trade.status !== "resolved") continue;
    // Scalar-settled trades have manually-verified P&L from actual settlement values.
    // Never overwrite with the binary formula.
    if (trade.scalarSettlement) continue;

    let correctPnl: number;

    if (trade.resolutionMethod === "hedge-complete") {
      const payout = trade.shares;
      // New-style trades (initialExchange set): the hedge loop already merged hedge costs into
      // kalCost+pmCost (e.g., PM-initial → pmCost = initialCost + hedgeFillCostPm). Don't double-count.
      // EXCEPTION: partial-fill trades have 3 independent cost components (kalCost + pmCost + hedgeCost)
      // when both KAL partially filled AND PM hedge covered remaining. Detect by checking if
      // both kalCost > 0 AND pmCost > 0 AND hedgeCost > 0 AND hedgeCost ≠ kalCost/pmCost.
      // Legacy trades (no initialExchange): hedgeCost may need to be added if one side is 0.
      let hc: number;
      const hedgeCostVal = trade.hedgeCost ?? 0;
      if (!trade.initialExchange) {
        // Legacy: add hedgeCost when one side is 0
        hc = ((trade.pmCost === 0 || trade.kalCost === 0) && hedgeCostVal > 0) ? hedgeCostVal : 0;
      } else if (hedgeCostVal > 0 && trade.kalCost > 0 && trade.pmCost > 0
        && Math.abs(hedgeCostVal - trade.kalCost) > 0.05
        && Math.abs(hedgeCostVal - trade.pmCost) > 0.05) {
        // New-style partial-fill: hedgeCost is a third independent component
        hc = hedgeCostVal;
      } else {
        // New-style standard: hedgeCost is a duplicate of one leg
        hc = 0;
      }
      // kalCost already includes kalFees (baked in at resolve time) — do NOT add kalFees again
      trade.totalCost = Math.round((trade.kalCost + hc + trade.pmCost) * 100) / 100;
      correctPnl = payout - trade.totalCost;
    } else {
      const settlement = settlementByTicker.get(trade.kalTicker);
      let kalResult = settlement?.marketResult ?? "";
      if (!kalResult) {
        try {
          const mkt = await fetchKalshiMarket(trade.kalTicker);
          kalResult = String(mkt.result ?? "").toLowerCase();
        } catch { continue; }
      }
      if (!kalResult) continue;

      const kalSide = kalSideForDir(trade.dir);
      const kalSideWon = (kalSide === "yes" && kalResult === "yes") || (kalSide === "no" && kalResult === "no");
      const hasPm = trade.pmCost > 0 || trade.pmFillPrice > 0;
      const hasKal = trade.kalCost > 0 || trade.kalFillPrice > 0;

      {
        // Same logic: new-style trades have hedge costs merged into kalCost/pmCost by the hedge loop.
        const hcS = !trade.initialExchange && ((trade.pmCost === 0 || trade.kalCost === 0) && (trade.hedgeCost ?? 0) > 0) ? (trade.hedgeCost ?? 0) : 0;
        // If hedge exists (opposite side bought on either exchange), both sides covered → payout = shares
        const kalPayout = hcS > 0 ? trade.shares : ((hasKal && kalSideWon) ? trade.shares : 0);
        const pmPayout = hcS > 0 ? 0 : ((hasPm && !kalSideWon) ? trade.shares : 0);
        // kalCost already includes kalFees — do NOT subtract kalFees separately
        correctPnl = kalPayout + pmPayout - trade.kalCost - hcS - trade.pmCost;
      }
      const hcS2 = !trade.initialExchange && ((trade.pmCost === 0 || trade.kalCost === 0) && (trade.hedgeCost ?? 0) > 0) ? (trade.hedgeCost ?? 0) : 0;
      trade.totalCost = Math.round((trade.kalCost + hcS2 + trade.pmCost) * 100) / 100;
    }
    correctPnl = Math.round(correctPnl * 100) / 100;

    if (trade.realizedPnl !== correctPnl) {
      const oldPnl = trade.realizedPnl;
      trade.realizedPnl = correctPnl;
      console.log(`[RECONCILE]   Fixed P&L: ${trade.match} dir=${trade.dir} method=${trade.resolutionMethod ?? "n/a"} (was $${(oldPnl ?? 0).toFixed(2)}, now $${correctPnl.toFixed(2)})`);
      fixed++;
      changed = true;
    }
  }
  return { fixed, changed };
}

/** Write reconcile audit trail to data/reconcile_audit.json. */
export function writeReconcileAudit(trades: ArbTradeRecord[]): void {
  const auditChanges: { tradeId: string; match: string; field: string; oldValue: unknown; newValue: unknown }[] = [];
  const auditFields = ["status", "resolutionMethod", "kalCost", "pmCost", "totalCost", "kalFillPrice", "pmFillPrice", "realizedPnl", "resolvedTs", "hedgeCost"] as const;
  for (const t of trades) {
    const snap = _reconcileSnapshot.get(t.id);
    if (!snap) continue;
    for (const f of auditFields) {
      const oldVal = snap[f];
      const newVal = t[f as keyof ArbTradeRecord];
      if (oldVal !== newVal && !(oldVal == null && newVal == null)) {
        auditChanges.push({ tradeId: t.id, match: t.match, field: f, oldValue: oldVal, newValue: newVal });
      }
    }
  }
  if (auditChanges.length > 0) {
    const auditPath = path.join("data", "reconcile_audit.json");
    let entries: unknown[] = [];
    try { if (fs.existsSync(auditPath)) entries = JSON.parse(fs.readFileSync(auditPath, "utf8")); } catch {}
    entries.push({
      ts: new Date().toISOString(),
      trigger: _reconcileTrigger,
      changeCount: auditChanges.length,
      changes: auditChanges,
    });
    if (entries.length > 200) entries = entries.slice(entries.length - 200);
    atomicWriteFileSync(auditPath, JSON.stringify(entries, null, 2));
    console.log(`[RECONCILE] Audit: ${auditChanges.length} field changes logged.`);
  }
}

export async function reconcilePositions(trigger: string = "startup"): Promise<void> {
  _reconcileTrigger = trigger;
  console.log("[RECONCILE] Fetching exchange data...");
  let kalFills: KalFill[] = [];
  let kalSettlements: KalSettlement[] = [];
  let kalPosMap = new Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>();
  let pmPositions: PmPosition[] = [];

  try {
    [kalFills, kalSettlements, kalPosMap] = await Promise.all([
      fetchAllKalshiFills(),
      fetchAllKalshiSettlements(),
      getKalshiPositionMap(),
    ]);
    console.log(`[RECONCILE] Kalshi: ${kalFills.length} fills, ${kalSettlements.length} settlements, ${kalPosMap.size} positions`);
  } catch (e) {
    console.error(`[RECONCILE] Kalshi fetch failed: ${(e as Error).message}`);
  }

  try {
    pmPositions = await fetchPmPositionsCached(0); // force fresh
    console.log(`[RECONCILE] PM: ${pmPositions.length} positions`);
  } catch (e) {
    console.error(`[RECONCILE] PM fetch failed: ${(e as Error).message}`);
  }

  // Build per-ticker+side fill arrays for timestamp-matched lookups.
  // Each fill is kept individually (not aggregated) so we can match by timestamp.
  const kalFillsByKey = new Map<string, KalFill[]>();
  for (const f of kalFills) {
    if (f.action !== "buy" || !f.ticker) continue;
    const key = `${f.ticker}:${f.side}`;
    const list = kalFillsByKey.get(key) ?? [];
    list.push(f);
    kalFillsByKey.set(key, list);
  }
  // Track which fill indices have been consumed (prevents double-assignment across trades)
  const usedKalFillIdx = new Map<string, Set<number>>();

  // Helper: match Kalshi fills to a trade by timestamp proximity (same as repairTrades.ts)
  function matchKalFillsForTrade(key: string, tradeTs: string, tradeShares: number): { costCents: number; fees: number; shares: number; avgPriceCents: number } | null {
    const fills = kalFillsByKey.get(key);
    if (!fills || fills.length === 0) return null;
    let used = usedKalFillIdx.get(key);
    if (!used) { used = new Set(); usedKalFillIdx.set(key, used); }

    const tradeSec = new Date(tradeTs).getTime() / 1000;
    const candidates: { idx: number; dist: number }[] = [];
    for (let i = 0; i < fills.length; i++) {
      if (used.has(i)) continue;
      if (!fills[i].ts) continue;
      const fillSec = new Date(fills[i].ts).getTime() / 1000;
      candidates.push({ idx: i, dist: Math.abs(fillSec - tradeSec) });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    let totalShares = 0, totalCostCents = 0, totalFees = 0;
    const matched: number[] = [];
    for (const c of candidates) {
      if (totalShares >= tradeShares) break;
      const f = fills[c.idx];
      const priceCents = f.side === "yes" ? f.yesPrice : f.noPrice;
      totalShares += f.count;
      totalCostCents += f.count * priceCents;
      totalFees += f.feeCost;
      matched.push(c.idx);
    }
    if (totalShares === 0 || totalShares < tradeShares * 0.5) return null;
    for (const idx of matched) used.add(idx);
    return { costCents: totalCostCents, fees: totalFees, shares: totalShares, avgPriceCents: totalShares > 0 ? Math.round(totalCostCents / totalShares) : 0 };
  }

  // Also keep aggregate fillsByTicker for settlement fee proportioning (step a)
  const fillsByTicker = new Map<string, { totalShares: number; totalCostCents: number; totalFeeDollars: number; side: string; avgPriceCents: number }>();
  // Per-side fills: key = "ticker:yes" or "ticker:no" → detect hedge fills on opposite side
  const fillsByTickerSide = new Map<string, { totalShares: number; totalCostDollars: number; totalFeeDollars: number }>();
  for (const f of kalFills) {
    if (f.action !== "buy" || !f.ticker) continue;
    const costCents = f.count * (f.side === "yes" ? f.yesPrice : f.noPrice);
    // Aggregate (existing behavior)
    const existing = fillsByTicker.get(f.ticker);
    if (existing) {
      existing.totalShares += f.count;
      existing.totalCostCents += costCents;
      existing.totalFeeDollars += f.feeCost;
      existing.avgPriceCents = existing.totalShares > 0 ? Math.round(existing.totalCostCents / existing.totalShares) : 0;
    } else {
      const avg = f.count > 0 ? Math.round(costCents / f.count) : 0;
      fillsByTicker.set(f.ticker, { totalShares: f.count, totalCostCents: costCents, totalFeeDollars: f.feeCost, side: f.side, avgPriceCents: avg });
    }
    // Per-side index
    const sideKey = `${f.ticker}:${f.side}`;
    const es = fillsByTickerSide.get(sideKey);
    if (es) {
      es.totalShares += f.count;
      es.totalCostDollars += costCents / 100;
      es.totalFeeDollars += f.feeCost;
    } else {
      fillsByTickerSide.set(sideKey, { totalShares: f.count, totalCostDollars: costCents / 100, totalFeeDollars: f.feeCost });
    }
  }

  // Build settlement lookup with full data (costs, fees, market result)
  const settlementByTicker = new Map<string, KalSettlement>();
  for (const s of kalSettlements) {
    if (!s.ticker) continue;
    const existing = settlementByTicker.get(s.ticker);
    if (!existing || s.settledTime > existing.settledTime) {
      settlementByTicker.set(s.ticker, s);
    }
  }

  // Load trades and snapshot for audit trail
  const trades = loadArbTrades();
  _reconcileSnapshot = new Map();
  for (const t of trades) {
    _reconcileSnapshot.set(t.id, { status: t.status, resolutionMethod: t.resolutionMethod, kalCost: t.kalCost, pmCost: t.pmCost, totalCost: t.totalCost, kalFillPrice: t.kalFillPrice, pmFillPrice: t.pmFillPrice, realizedPnl: t.realizedPnl, resolvedTs: t.resolvedTs, hedgeCost: t.hedgeCost });
  }
  let staleResolved = 0;
  let filledToResolved = 0;
  let costsCorrected = 0;
  let changed = false;

  // ── (pre) Ghost/duplicate consolidation: merge multiple records per ticker into one ──
  // When ghost/recovered/excess trades share a kalTicker with a normal trade, consolidate
  // into a single record using actual exchange data as source of truth.
  {
    const removeIds = new Set<string>();
    // Group trades by kalTicker
    const byTicker = new Map<string, ArbTradeRecord[]>();
    for (const t of trades) {
      if (!t.kalTicker) continue;
      const list = byTicker.get(t.kalTicker) ?? [];
      list.push(t);
      byTicker.set(t.kalTicker, list);
    }

    for (const [ticker, group] of byTicker) {
      if (group.length <= 1) continue;
      const hasGhost = group.some(g => g.id.includes("ghost") || g.id.includes("recovered") || g.id.includes("excess"));
      if (!hasGhost) continue;

      // Get actual Kalshi position for this ticker
      const kalPos = kalPosMap.get(ticker);
      const kalSide = kalSideForDir(group[0].dir);
      const actualShares = kalPos ? (kalSide === "yes" ? kalPos.yesCount : kalPos.noCount) : 0;

      // Get actual Kalshi fills
      const kalKey = `${ticker}:${kalSide}`;
      const kalFillList = kalFillsByKey.get(kalKey) ?? [];
      let actualKalCostRaw = 0, actualKalFees = 0;
      for (const f of kalFillList) {
        const price = f.side === "yes" ? f.yesPrice : f.noPrice;
        actualKalCostRaw += f.count * price / 100;
        actualKalFees += f.feeCost;
      }
      const totalKalFillShares = kalFillList.reduce((s, f) => s + f.count, 0);
      const actualKalCost = Math.round((actualKalCostRaw + actualKalFees) * 100) / 100;

      // Choose primary trade (prefer normal over ghost/recovered)
      const primary = group.find(g => !g.id.includes("ghost") && !g.id.includes("recovered") && !g.id.includes("excess"))
        ?? group.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())[0];
      const mergedIds = group.filter(g => g !== primary).map(g => g.id);

      // Aggregate PM costs — use the FIRST trade's pmCost per share, don't double-count
      const pmCostPerShare = primary.pmCost > 0 && primary.shares > 0
        ? primary.pmCost / primary.shares
        : group.find(g => g.pmCost > 0 && g.shares > 0)
          ? (group.find(g => g.pmCost > 0 && g.shares > 0)!.pmCost / group.find(g => g.pmCost > 0 && g.shares > 0)!.shares)
          : 0;

      // Use max single-trade PM shares (each ghost claims same fills, don't sum)
      const uniquePmShares = Math.round(group.reduce((max, g) => Math.max(max, g.pmCost > 0 ? g.shares : 0), 0));
      const actualPmShares = uniquePmShares || primary.shares;
      const actualPmFillPrice = pmCostPerShare > 0 ? Math.round(pmCostPerShare * 100) / 100 : primary.pmFillPrice;

      // Arb shares = min(KAL fills, PM fills). Cap both sides to arb size.
      const arbShares = Math.min(totalKalFillShares, actualPmShares) || totalKalFillShares || primary.shares;
      const cappedPmShares = Math.min(actualPmShares, arbShares);
      const cappedPmCost = Math.round(cappedPmShares * pmCostPerShare * 100) / 100;
      const cappedKalShares = Math.min(totalKalFillShares, arbShares);
      const cappedKalCost = totalKalFillShares > 0
        ? Math.round((cappedKalShares * (actualKalCostRaw / totalKalFillShares) + actualKalFees * (cappedKalShares / totalKalFillShares)) * 100) / 100
        : 0;
      const excessCost = Math.round((actualKalCost - cappedKalCost + actualPmShares * pmCostPerShare - cappedPmCost) * 100) / 100;

      console.log(`[RECONCILE]   CONSOLIDATE: ${ticker} — merging ${group.length} records → 1. Removing: ${mergedIds.join(", ")}`);
      console.log(`[RECONCILE]     Arb: ${arbShares} shares | KAL: $${cappedKalCost} | PM: $${cappedPmCost}${excessCost > 0.01 ? ` | Excess: $${excessCost}` : ""}`);

      primary.shares = arbShares;
      primary.kalCost = cappedKalCost;
      primary.kalFillPrice = totalKalFillShares > 0 ? Math.round(actualKalCostRaw / totalKalFillShares * 100) / 100 : primary.kalFillPrice;
      primary.kalFees = Math.round(actualKalFees * (cappedKalShares / Math.max(1, totalKalFillShares)) * 100) / 100;
      primary.pmCost = cappedPmCost;
      primary.pmFillPrice = actualPmFillPrice;
      primary.totalCost = Math.round((cappedKalCost + cappedPmCost) * 100) / 100;
      primary.hedgeCost = undefined;
      primary.kalYesFills = kalFillList.filter(f => f.side === "yes").reduce((s, f) => s + f.count, 0);
      primary.kalNoFills = kalFillList.filter(f => f.side === "no").reduce((s, f) => s + f.count, 0);
      // Track over-hedge excess cost
      if (totalKalFillShares > arbShares || actualPmShares > arbShares) {
        primary.overHedgeShares = Math.max(totalKalFillShares - arbShares, actualPmShares - arbShares);
        primary.overHedgeCost = excessCost;
        primary.overHedgeSide = (totalKalFillShares > arbShares) ? kalSide as "yes" | "no" : "yes";
      } else {
        delete primary.overHedgeShares;
        delete primary.overHedgeCost;
        delete primary.overHedgeSide;
      }

      // Fix P&L with capped costs
      if (primary.status === "resolved" && (primary.resolutionMethod === "hedge-complete" || primary.resolutionMethod === "both-legs")) {
        primary.realizedPnl = Math.round((arbShares - primary.totalCost) * 100) / 100;
      }

      // Mark others for removal
      for (const g of group) {
        if (g !== primary) removeIds.add(g.id);
      }
      changed = true;
    }

    if (removeIds.size > 0) {
      for (let i = trades.length - 1; i >= 0; i--) {
        if (removeIds.has(trades[i].id)) {
          console.log(`[RECONCILE]   Removed duplicate: ${trades[i].id}`);
          trades.splice(i, 1);
        }
      }
    }
  }

  for (const trade of trades) {
    // Skip scalar-settled trades — their P&L is manually corrected based on actual settlement
    // values and should never be recalculated using the binary formula.
    if (trade.scalarSettlement) continue;

    // (a) Fix stale "hedging" → check if market settled
    if (trade.status === "hedging") {
      const settlement = settlementByTicker.get(trade.kalTicker);
      if (settlement) {
        const kalFee = settlement.feeCost;

        // Try to find PM cost from positions — only if this trade's hedge actually went to PM.
        // Don't assign PM cost from positions that belong to other trades on the same slug.
        let pmCost = trade.pmCost;
        if (pmCost === 0 || trade.pmFillPrice === 0) {
          const otherPmClaimed = trades
            .filter(t => t.id !== trade.id && t.pmSlug === trade.pmSlug && t.pmCost > 0)
            .reduce((s, t) => s + t.shares, 0);
          for (const p of pmPositions) {
            const slug = String(p.slug ?? p.marketSlug ?? "");
            const outcome = String(p.outcome ?? p.title ?? "");
            if ((slug && slug === trade.pmSlug) && (outcome === "" || namesMatch(outcome, trade.pmOutcome))) {
              const avgPrice = Number(p.avgPrice ?? 0);
              const size = Number(p.size ?? p.amount ?? 0);
              const availableShares = size - otherPmClaimed;
              if (avgPrice > 0 && availableShares >= trade.shares) {
                // Sanity check: if combined cost/share >= $1, PM avgPrice is likely market price, not fill price — skip
                const estCombined = (trade.kalCost + trade.shares * avgPrice) / Math.max(trade.shares, 1);
                if (estCombined >= 1) {
                  console.warn(`[RECONCILE]   PM avgPrice ${(avgPrice * 100).toFixed(0)}¢ for ${trade.match} gives combined $${estCombined.toFixed(2)}/sh >= $1.00 — skipping PM cost backfill`);
                } else {
                  pmCost = trade.shares * avgPrice;
                  trade.pmFillPrice = avgPrice;
                  trade.pmCost = Math.round(pmCost * 100) / 100;
                }
              }
              break;
            }
          }
        }

        // Per-trade P&L — don't use aggregate settlement kalCostExact/kalRevenue
        // as it sums ALL fills for the ticker, double-counting when multiple trades share it.
        const kalSide = kalSideForDir(trade.dir);
        const kalOppSide = kalSide === "yes" ? "no" : "yes";
        const kalSideWon = (kalSide === "yes" && settlement.marketResult === "yes") || (kalSide === "no" && settlement.marketResult === "no");
        const hasPmLeg = pmCost > 0 || trade.pmFillPrice > 0;

        // ── Check for hedge fills on OPPOSITE Kalshi side ──
        // If the bot hedged by buying the opposite side on Kalshi (e.g., bought YES initially,
        // then bought NO as hedge), both sides are covered → payout = shares × $1 regardless.
        // IMPORTANT: Only count opposite-side fills as hedges if no OTHER trade on this ticker
        // already accounts for them — otherwise we'd fabricate hedge data from unrelated trades.
        const oppSideFills = fillsByTickerSide.get(`${trade.kalTicker}:${kalOppSide}`);
        let hedgeCostKal = trade.hedgeCost ?? 0;
        let kalHedgeShares = 0;
        if (oppSideFills && oppSideFills.totalShares > 0 && !hasPmLeg) {
          // Check if other trades already account for opposite-side fills on this ticker
          // Only count trades on the SAME opposite side (e.g., both buying NO as hedge)
          const otherTradesOppShares = trades
            .filter(t => t.id !== trade.id && t.kalTicker === trade.kalTicker &&
              t.resolutionMethod === "hedge-complete" && (t.hedgeCost ?? 0) > 0 && t.pmCost === 0)
            .reduce((s, t) => s + t.shares, 0);
          const unclaimedOppShares = Math.max(0, oppSideFills.totalShares - otherTradesOppShares);
          if (unclaimedOppShares > 0) {
            kalHedgeShares = Math.min(unclaimedOppShares, trade.shares);
            hedgeCostKal = Math.round((oppSideFills.totalCostDollars + oppSideFills.totalFeeDollars) * (kalHedgeShares / oppSideFills.totalShares) * 100) / 100;
            console.log(`[RECONCILE]   Found KAL hedge fills: ${kalHedgeShares}×${kalOppSide.toUpperCase()} cost=$${hedgeCostKal.toFixed(2)} on ${trade.kalTicker} (${unclaimedOppShares} unclaimed of ${oppSideFills.totalShares} total)`);
          }
        }

        // Payout calculation: hedged shares always pay $1, unhedged depend on result
        const hedgedShares = hasPmLeg ? trade.shares : kalHedgeShares;
        const unhedgedShares = trade.shares - hedgedShares;
        const kalPayout = hedgedShares + (kalSideWon ? unhedgedShares : 0);
        const pmPayout = (hasPmLeg && !kalSideWon) ? trade.shares : 0;

        // Keep per-trade kalCost (set by makeUnhedged). Add proportional fee if missing.
        if (trade.kalCost > 0 && trade.kalFillPrice > 0) {
          const rawCost = trade.shares * trade.kalFillPrice;
          // If kalCost ≈ shares × fillPrice, fee isn't included yet — add proportional fee
          if (Math.abs(trade.kalCost - rawCost) < 0.05 && kalFee > 0) {
            const fillData = fillsByTicker.get(trade.kalTicker);
            const totalShares = fillData?.totalShares ?? trade.shares;
            const perTradeFee = Math.round(kalFee * (trade.shares / totalShares) * 100) / 100;
            trade.kalCost = Math.round((rawCost + perTradeFee) * 100) / 100;
          }
        } else if (trade.kalCost === 0 && fillsByTicker.has(trade.kalTicker)) {
          // kalCost lost — backfill from proportional fill data
          const fillData = fillsByTicker.get(trade.kalTicker)!;
          const proportion = fillData.totalShares > 0 ? trade.shares / fillData.totalShares : 1;
          const backfilledKalCost = Math.round((fillData.totalCostCents / 100 + fillData.totalFeeDollars) * proportion * 100) / 100;
          const combinedPerShare = (backfilledKalCost + pmCost) / Math.max(trade.shares, 1);
          if (combinedPerShare >= 1) {
            console.log(`[RECONCILE]   WARNING: backfill for ${trade.match} gives combined cost $${combinedPerShare.toFixed(2)}/share >= $1.00 — bad recovery, money already spent`);
          }
          trade.kalCost = backfilledKalCost;
          trade.kalFillPrice = fillData.avgPriceCents / 100;
        }

        // Include hedge cost in total
        const totalKalCost = trade.kalCost + hedgeCostKal;
        const pnl = kalPayout + pmPayout - totalKalCost - pmCost;

        trade.status = "resolved";
        trade.resolutionMethod = kalHedgeShares > 0 ? "hedge-complete" : "settlement";
        trade.resolvedTs = settlement.settledTime;
        trade.pmCost = pmCost;
        trade.hedgeCost = hedgeCostKal > 0 ? hedgeCostKal : (trade.hedgeCost ?? 0);
        trade.totalCost = Math.round((trade.kalCost + hedgeCostKal + pmCost) * 100) / 100;
        trade.realizedPnl = Math.round(pnl * 100) / 100;
        console.log(`[RECONCILE]   Resolved ${trade.match} (dir ${trade.dir}): ${trade.resolutionMethod}, kalPayout=$${kalPayout}${kalHedgeShares > 0 ? ` hedgeKal=$${hedgeCostKal.toFixed(2)}` : ""} pmPayout=$${pmPayout} P&L=$${trade.realizedPnl.toFixed(2)}`);
        staleResolved++;
        changed = true;
        continue;
      }
    }

    // (a2) Fix "hedging" trades where PM already holds the hedge tokens.
    //      This happens when the bot placed KAL, then PM filled separately (or the bot
    //      crashed after PM filled but before updating the trade record).
    //      Check if PM wallet has tokens matching the trade's pmOutcome on the same slug.
    //      IMPORTANT: Subtract PM shares already claimed by other trades on the same slug
    //      to avoid double-counting the same PM position across multiple trades.
    if (trade.status === "hedging" && trade.pmCost === 0 && trade.kalFillPrice > 0) {
      // Count PM shares already claimed by other trades on the same slug
      const otherPmSharesClaimed = trades
        .filter(t => t.id !== trade.id && t.pmSlug === trade.pmSlug && t.pmCost > 0)
        .reduce((s, t) => s + t.shares, 0);
      for (const p of pmPositions) {
        const slug = String(p.slug ?? p.marketSlug ?? "");
        const outcome = String(p.outcome ?? p.title ?? "");
        const size = Math.round(Number(p.size ?? p.amount ?? 0));
        const availableShares = size - otherPmSharesClaimed;
        const posAvgPrice = Number(p.avgPrice ?? 0);
        if (availableShares >= trade.shares && slug === trade.pmSlug && namesMatch(outcome, trade.pmOutcome)) {
          // PM holds enough UNCLAIMED shares to cover this trade's hedge.
          // Prefer actual fill price from pending_fills over PM positions API avgPrice (which can be market price).
          const pfMatch = loadPendingFills().find(pf =>
            pf.exchange === "pm" && pf.pmSlug === trade.pmSlug &&
            namesMatch(pf.pmOutcome, trade.pmOutcome) && pf.price > 0
          );
          const avgPrice = pfMatch ? pfMatch.price : posAvgPrice;
          // Validate combined cost: if cost/share >= $1, the avgPrice is unreliable — don't resolve, let hedge loop handle it.
          const pmCost = Math.round(trade.shares * avgPrice * 100) / 100;
          const totalCost = Math.round((trade.kalCost + pmCost) * 100) / 100;
          const costPerShare = totalCost / Math.max(trade.shares, 1);
          if (costPerShare >= 1) {
            console.warn(
              `[RECONCILE]   PM wallet hedge found but avgPrice unreliable: ${trade.match} — ` +
              `${size}×${outcome} @${(avgPrice * 100).toFixed(0)}¢ on PM → combined $${costPerShare.toFixed(2)}/sh >= $1.00. ` +
              `Leaving in hedge mode (max hedge price = ${((1 - trade.kalCost / Math.max(trade.shares, 1)) * 100).toFixed(0)}¢).`
            );
            break;
          }
          const payout = trade.shares;
          const realizedPnl = Math.round((payout - totalCost) * 100) / 100;
          trade.status = "resolved";
          trade.resolutionMethod = "hedge-complete";
          trade.resolvedTs = new Date().toISOString();
          trade.pmFillPrice = Math.round(avgPrice * 100) / 100;
          trade.pmCost = pmCost;
          trade.totalCost = totalCost;
          trade.realizedPnl = realizedPnl;
          console.log(
            `[RECONCILE]   PM wallet hedge found: ${trade.match} — ` +
            `${size}×${outcome} @${(avgPrice * 100).toFixed(0)}¢ on PM. ` +
            `Resolved: P&L=$${realizedPnl.toFixed(2)}`
          );
          staleResolved++;
          changed = true;
          break;
        }
      }
      if (trade.status !== "hedging") continue;
    }

    // (b) Fix "filled" instant-arbs → mark resolved if both legs have prices
    if (trade.status === "filled" && trade.kalFillPrice > 0 && trade.pmFillPrice > 0 && trade.realizedPnl != null) {
      trade.status = "resolved";
      trade.resolutionMethod = "both-legs";
      trade.resolvedTs = trade.resolvedTs ?? trade.ts;
      console.log(`[RECONCILE]   Fixed status: ${trade.match} (filled→resolved)`);
      filledToResolved++;
      changed = true;
    }

    // (b2) Fix "hedging" trades that already have both legs filled but never got resolved.
    //      This happens when hedge_state.json is lost (crash/restart) — the hedge cycle
    //      can't find the trade, so it stays stuck in "hedging" forever.
    if (trade.status === "hedging" && trade.kalCost > 0 && trade.pmCost > 0) {
      trade.status = "resolved";
      trade.resolutionMethod = "hedge-complete";
      trade.resolvedTs = trade.resolvedTs ?? new Date().toISOString();
      trade.hedgeCost = trade.initialExchange === "pm" ? trade.kalCost : trade.pmCost;
      trade.totalCost = totalCostForTrade(trade);
      trade.realizedPnl = Math.round((trade.shares - trade.totalCost) * 100) / 100;
      console.log(`[RECONCILE]   Fixed status: ${trade.match} (hedging→resolved, both legs filled: KAL=$${trade.kalCost.toFixed(2)} PM=$${trade.pmCost.toFixed(2)} P&L=$${trade.realizedPnl.toFixed(2)})`);
      filledToResolved++;
      changed = true;
    }

    // (c) Backfill missing kalCost or fix cost discrepancies using timestamp-matched fills.
    //     Skip hedge-complete trades UNLESS kalCost=0 (ghost/recovered trades resolved before backfill).
    //     Skip resolved trades UNLESS kalCost=0 (same reason — settlement resolved before cost was known).
    const kalNeedsBackfill = trade.kalCost === 0;
    if (trade.kalTicker && (kalNeedsBackfill || (trade.resolutionMethod !== "hedge-complete" && trade.status !== "resolved"))) {
      const kalSide = kalSideForDir(trade.dir);
      const kalKey = `${trade.kalTicker}:${kalSide}`;
      const matched = matchKalFillsForTrade(kalKey, trade.ts, trade.shares);
      if (matched) {
        const avgPrice = Math.round(matched.costCents / matched.shares) / 100;
        const kalCostWithFees = Math.round((matched.costCents / 100 + matched.fees) * 100) / 100;

        if (trade.kalCost === 0 && kalCostWithFees > 0) {
          trade.kalFillPrice = avgPrice;
          trade.kalCost = kalCostWithFees;
          trade.kalFees = matched.fees;
          trade.totalCost = totalCostForTrade(trade);
          // Recalculate P&L if trade was resolved with kalCost=0 (ghost resolved before backfill)
          if (trade.status === "resolved" && trade.realizedPnl != null) {
            const hedgeCost = trade.hedgeCost ?? 0;
            const payout = trade.shares;
            const oldPnl = trade.realizedPnl;
            trade.realizedPnl = Math.round((payout - trade.kalCost - trade.pmCost - hedgeCost) * 100) / 100;
            console.log(`[RECONCILE]   Backfilled kalCost + P&L fix: ${trade.match} dir=${trade.dir} → kalCost=$${kalCostWithFees.toFixed(2)} P&L ${oldPnl.toFixed(2)}→${trade.realizedPnl.toFixed(2)}`);
          } else {
            console.log(`[RECONCILE]   Backfilled kalCost: ${trade.match} dir=${trade.dir} → $${kalCostWithFees.toFixed(2)} (ts-matched, fee=$${matched.fees.toFixed(2)})`);
          }
          costsCorrected++;
          changed = true;
        } else if (trade.kalCost > 0 && Math.abs(kalCostWithFees - trade.kalCost) > 0.01) {
          const oldCost = trade.kalCost;
          trade.kalCost = kalCostWithFees;
          trade.kalFillPrice = avgPrice;
          trade.totalCost = totalCostForTrade(trade);
          console.log(`[RECONCILE]   Fixed kalCost: ${trade.match} $${oldCost.toFixed(2)}→$${kalCostWithFees.toFixed(2)} (ts-matched, fee=$${matched.fees.toFixed(2)})`);
          costsCorrected++;
          changed = true;
        }
      }
    }
  }

  // (c2) PM cost repair using CLOB getTrades() API + on-chain fallback
  const pmRepairResult = await repairPmCostsFromClob(trades);
  let pmClobRepaired = pmRepairResult.repaired;
  if (pmRepairResult.changed) changed = true;

  // (d0) Fix corrupted kalCost from old settlement-based reconciler.
  //      The old reconciler used aggregate settlement data which double-counted when
  //      multiple trades shared a Kalshi ticker. Detect and fix: if kalCost is >50%
  //      above kalFillPrice × shares, it was inflated by settlement aggregation.
  let kalCostFixed = 0;
  for (const trade of trades) {
    const fp = trade.kalFillPrice ?? 0;
    const cost = trade.kalCost ?? 0;
    const sh = trade.shares ?? 0;
    if (fp > 0 && cost > 0 && sh > 0) {
      const expected = fp * sh;
      if (cost > expected * 1.5) {
        const corrected = Math.round(expected * 100) / 100;
        console.log(`[RECONCILE]   Fix kalCost: ${trade.match} — was $${cost.toFixed(2)}, corrected to $${corrected.toFixed(2)} (${sh}×${fp})`);
        trade.kalCost = corrected;
        trade.totalCost = totalCostForTrade(trade);
        kalCostFixed++;
        changed = true;
      }
    }
  }

  // (d0b) Backfill missing fill prices and fix costs for hedge-complete trades.
  //       Determines which side was the initial entry vs the hedge using a heuristic:
  //       if kalFillPrice × shares ≈ hedgeCost, then kalFillPrice was backfilled → PM-initial.
  //       Otherwise kalFillPrice is the real entry price → KAL-initial.
  //       Uses hedgeCost (per-trade fill cost from resolveArbTrade) as ground truth for hedge side.
  //       NOTE: The hedge can go to EITHER exchange (KAL or PM opposite token).
  //       New trades have per-exchange cost tracking, so this heuristic is mainly for legacy data.
  for (const trade of trades) {
    const hc = trade.hedgeCost ?? 0;
    if (hc <= 0 || trade.resolutionMethod !== "hedge-complete") continue;
    const sh = trade.shares ?? 0;
    if (sh <= 0) continue;

    // Skip if costs are already set and consistent with totalCost.
    // New trades (initialExchange set) have per-exchange cost tracking from resolveArbTrade.
    // One side can be legitimately 0 when the hedge went entirely to PM opposite token,
    // so don't require both > 0 — only require totalCost consistency.
    // Partial-fill trades can have 3 cost components: kalCost + pmCost + hedgeCost
    // (e.g., partial KAL fill + PM initial + PM opposite hedge). In that case,
    // totalCost = kalCost + pmCost + hedgeCost, and costSum < totalCost is expected.
    const costSum = Math.round(((trade.kalCost ?? 0) + (trade.pmCost ?? 0)) * 100) / 100;
    const costSumWithHedge = Math.round((costSum + (trade.hedgeCost ?? 0)) * 100) / 100;
    if (trade.initialExchange && (Math.abs(costSum - trade.totalCost) < 0.05 || Math.abs(costSumWithHedge - trade.totalCost) < 0.05)) {
      continue;
    }
    // Legacy trades (no initialExchange): require both costs > 0 to skip
    if ((trade.kalCost ?? 0) > 0 && (trade.pmCost ?? 0) > 0
      && Math.abs(costSum - trade.totalCost) < 0.05) {
      continue;
    }

    const kalFP = trade.kalFillPrice ?? 0;

    // Determine which side was initial. Use initialExchange field if present (new trades),
    // otherwise fall back to cost-based heuristic (legacy data).
    const pmFP = trade.pmFillPrice ?? 0;
    const isPmInitial = trade.initialExchange
      ? trade.initialExchange === "pm"
      : (trade.pmCost > 0 && trade.kalCost === 0)
        || (pmFP > 0 && kalFP === 0)
        || (kalFP > 0 && Math.abs(kalFP * sh - hc) < 0.10);

    if (isPmInitial) {
      // PM-initial → hedge could be KAL or PM-opposite.
      // Without per-exchange breakdown, assume hedge went to KAL (legacy behavior).
      if (kalFP === 0) {
        trade.kalFillPrice = Math.round((hc / sh) * 100) / 100;
        changed = true;
      }
      const kalFeesLeg = trade.kalFees ?? 0;
      const correctHcKal = Math.round((hc + kalFeesLeg) * 100) / 100;
      if (Math.abs(trade.kalCost - correctHcKal) > 0.01) {
        trade.kalCost = correctHcKal;
        changed = true;
      }
      // Backfill pmCost from initialCost if still 0 (PM was initial, cost = totalCost - hedgeCost)
      if (trade.pmCost === 0 && pmFP > 0) {
        trade.pmCost = Math.round(pmFP * sh * 100) / 100;
        changed = true;
      }
    } else {
      // KAL-initial → hedge could be PM or KAL-opposite (soccer 3-way dirs G-I).
      const kalFees = trade.kalFees ?? 0;
      const correctKalCost = Math.round((kalFP * sh + kalFees) * 100) / 100;
      if (Math.abs(trade.kalCost - correctKalCost) > 0.01) {
        trade.kalCost = correctKalCost;
        changed = true;
      }
      // Only backfill PM cost if hedge actually went to PM (not KAL-opposite).
      // If hedgeCost > 0 and pmCost === 0, check if the trade already has totalCost
      // that accounts for hedgeCost via the KAL side (totalCost ≈ kalCost + hedgeCost).
      // Soccer 3-way KAL-hedged trades have hedgeCost on the KAL side, not PM.
      const kalHedged = hc > 0 && Math.abs(trade.totalCost - (trade.kalCost + hc)) < 0.10;
      if (!kalHedged) {
        // Hedge went to PM — backfill pmFillPrice + pmCost from hedgeCost
        if (pmFP === 0) {
          trade.pmFillPrice = Math.round((hc / sh) * 100) / 100;
          changed = true;
        }
        if (trade.pmCost === 0) {
          trade.pmCost = Math.round(hc * 100) / 100;
          changed = true;
        }
      }
    }
    // Recalculate totalCost from both sides (kalCost already includes kalFees, hedgeCost added when one leg is 0)
    const newTotal = totalCostForTrade(trade);
    if (Math.abs(trade.totalCost - newTotal) > 0.01) {
      trade.totalCost = newTotal;
      changed = true;
    }
  }

  // (d0) Repair resolved settlement trades where hedge fills were lost.
  //      If a trade was resolved as "settlement" with hedgeCost=0 and negative P&L,
  //      but Kalshi fills show buys on BOTH sides of the ticker, the hedge actually filled.
  for (const trade of trades) {
    if (trade.status !== "resolved") continue;
    if (trade.resolutionMethod !== "settlement") continue;
    if ((trade.realizedPnl ?? 0) >= 0) continue; // only repair losses
    if ((trade.hedgeCost ?? 0) > 0) continue;     // hedge already recorded
    if ((trade.pmCost ?? 0) > 0) continue;         // PM leg exists, not a one-sided KAL trade

    const kalSide = kalSideForDir(trade.dir);
    const kalOppSide = kalSide === "yes" ? "no" : "yes";
    const oppFills = fillsByTickerSide.get(`${trade.kalTicker}:${kalOppSide}`);
    if (!oppFills || oppFills.totalShares <= 0) continue;

    // Found hedge fills on opposite side that were never recorded
    const hedgeShares = Math.min(oppFills.totalShares, trade.shares);
    const hedgeProportion = hedgeShares / oppFills.totalShares;
    const hedgeCost = Math.round((oppFills.totalCostDollars + oppFills.totalFeeDollars) * hedgeProportion * 100) / 100;
    const payout = trade.shares; // both sides covered → $1 per share
    const totalCost = Math.round((trade.kalCost + hedgeCost) * 100) / 100;
    const pnl = Math.round((payout - totalCost) * 100) / 100;

    console.log(
      `[RECONCILE]   REPAIR: ${trade.match} — found lost KAL hedge: ${hedgeShares}×${kalOppSide.toUpperCase()} cost=$${hedgeCost.toFixed(2)}. ` +
      `P&L corrected: $${(trade.realizedPnl ?? 0).toFixed(2)} → $${pnl.toFixed(2)}`
    );
    trade.resolutionMethod = "hedge-complete";
    trade.hedgeCost = hedgeCost;
    trade.totalCost = totalCost;
    trade.realizedPnl = pnl;
    changed = true;
    costsCorrected++;
  }

  // (d) Verify and fix P&L for all resolved trades
  const pnlResult = await verifyAndFixPnl(trades, settlementByTicker);
  let pnlFixed = pnlResult.fixed;
  if (pnlResult.changed) changed = true;

  // (e) Recover orphaned fills from pending_fills.json (crash recovery)
  // Group pending fills by ticker+slug to consolidate crash-loop duplicates into one trade.
  let recoveredFromPending = 0;
  const pendingFills = getIncompletePendingFills();
  if (pendingFills.length > 0) {
    console.log(`[RECONCILE] Found ${pendingFills.length} incomplete pending fill(s) — checking for orphaned positions...`);

    // Group by kalTicker+pmSlug so crash-loop fills become one recovery trade
    const pfGroups = new Map<string, typeof pendingFills>();
    for (const pf of pendingFills) {
      const key = `${pf.kalTicker}||${pf.pmSlug}`;
      const group = pfGroups.get(key) ?? [];
      group.push(pf);
      pfGroups.set(key, group);
    }

    for (const [, group] of pfGroups) {
      const pf = group[0]; // use first fill for metadata (match, dir, etc.)

      // Check if a trade was already logged for this group
      const alreadyLogged = trades.some(t =>
        t.kalTicker === pf.kalTicker && t.pmSlug === pf.pmSlug &&
        Math.abs(new Date(t.ts).getTime() - new Date(pf.ts).getTime()) < 60_000
      );
      if (alreadyLogged) {
        for (const p of group) completePendingFill(p.id);
        continue;
      }

      // Check if position actually exists on the exchange
      let hasPosition = false;
      // Use sum of pending fill shares (NOT exchange position, which includes other trades)
      let actualShares = group.reduce((sum, p) => sum + p.shares, 0);
      // Weighted average price across fills
      const totalCostCents = group.reduce((sum, p) => sum + p.shares * p.price, 0);
      const avgPrice = actualShares > 0 ? Math.round(totalCostCents / actualShares * 100) / 100 : pf.price;

      if (pf.exchange === "kal") {
        const kalPos = kalPosMap.get(pf.kalTicker);
        if (kalPos && (kalPos.yesCount > 0 || kalPos.noCount > 0)) {
          hasPosition = true;
          // Cap at actual exchange position to avoid over-counting
          const exchangeShares = Math.max(kalPos.yesCount, kalPos.noCount);
          if (actualShares > exchangeShares) {
            console.log(`[RECONCILE]   NOTE: ${group.length} pending fills sum to ${actualShares} shares but exchange shows ${exchangeShares} — using exchange count`);
            actualShares = exchangeShares;
          }
        }
      } else {
        const pmPos = pmPositions.find(p =>
          String(p.slug ?? p.marketSlug ?? "") === pf.pmSlug
        );
        if (pmPos && Number(pmPos.size ?? pmPos.amount ?? 0) >= 1) {
          hasPosition = true;
          const exchangeShares = Math.round(Number(pmPos.size ?? pmPos.amount ?? 0));
          if (actualShares > exchangeShares) {
            console.log(`[RECONCILE]   NOTE: ${group.length} pending fills sum to ${actualShares} shares but PM shows ${exchangeShares} — using PM count`);
            actualShares = exchangeShares;
          }
        }
      }

      if (hasPosition) {
        const rawKalCost = pf.exchange === "kal" ? Math.round(actualShares * avgPrice * 100) / 100 : 0;
        const pmCost = pf.exchange === "pm" ? Math.round(actualShares * avgPrice * 100) / 100 : 0;
        // Calculate Kalshi fees: KALSHI_FEE_RATE × P × (1-P) per contract
        const kalFees = pf.exchange === "kal"
          ? Math.round(actualShares * KALSHI_FEE_RATE * avgPrice * (1 - avgPrice) * 100) / 100
          : 0;
        const kalCost = rawKalCost + kalFees; // kalCost includes fees (matches normal trade behavior)
        console.log(`[RECONCILE]   RECOVERED: ${pf.match} — ${actualShares} shares on ${pf.exchange} @ ${avgPrice} (${group.length} pending fill(s), fees=$${kalFees.toFixed(2)})`);
        trades.push({
          id: `arb-recovered-${Date.now()}`,
          ts: pf.ts,
          match: pf.match,
          dir: pf.dir as ArbDir,
          status: "hedging",
          shares: actualShares,
          kalTicker: pf.kalTicker,
          kalFillPrice: pf.exchange === "kal" ? avgPrice : 0,
          kalCost,
          pmOutcome: pf.pmOutcome,
          pmSlug: pf.pmSlug,
          pmTokenId: pf.pmTokenId,
          pmFillPrice: pf.exchange === "pm" ? avgPrice : 0,
          pmCost,
          totalCost: kalCost + pmCost,
          projectedEdge: 0,
          projectedProfit: 0,
          initialExchange: pf.exchange,
          kalFees,
        });
        changed = true;
        recoveredFromPending++;
      }
      for (const p of group) completePendingFill(p.id);
    }
    if (recoveredFromPending > 0) {
      console.log(`[RECONCILE]   Recovered ${recoveredFromPending} orphaned trade(s) from pending fills`);
    }
  }

  // (e2) Detect & auto-recover untracked positions.
  // Positions stay on exchanges until settlement, so resolved trades still hold positions.
  // Compare exchange position vs ALL trade records (resolved + active) to find truly excess shares.
  let untrackedKal = 0;
  let untrackedPm = 0;
  let autoRecoveredPositions = 0;
  for (const [ticker, pos] of kalPosMap) {
    const posCount = Math.max(pos.yesCount, pos.noCount);
    const posSide = pos.yesCount >= pos.noCount ? "yes" : "no";
    if (posCount <= 0) continue;

    // Count shares tracked across ALL trades (resolved + active) for this ticker
    const allTrackedShares = trades
      .filter(t => t.kalTicker === ticker)
      .reduce((s, t) => s + t.shares, 0);
    const excessShares = posCount - allTrackedShares;
    if (excessShares <= 0) continue;

    // Skip if there's an active hedge on this ticker — the hedge loop is still buying
    // contracts, so the current position count is mid-flight and will change.
    // Auto-recovering now would create duplicate hedging trades.
    const hasActiveHedge = trades.some(t => t.kalTicker === ticker && t.status === "hedging");
    if (hasActiveHedge) {
      console.log(`[RECONCILE]   Skipping KAL auto-recover for ${ticker} — active hedge in progress (excess=${excessShares}, hedging trade exists)`);
      continue;
    }

    // We have excess Kalshi shares not accounted for in any trade record
    const resolvedRef = trades.find(t => t.kalTicker === ticker);
    if (resolvedRef) {
      // Use position's average price or fall back to trade reference
      const avgPrice = pos.avgPriceCents > 0 ? pos.avgPriceCents / 100 : resolvedRef.kalFillPrice;
      const kalFees = Math.round(excessShares * KALSHI_FEE_RATE * avgPrice * (1 - avgPrice) * 100) / 100;
      const kalCost = Math.round((excessShares * avgPrice + kalFees) * 100) / 100;

      console.log(`[RECONCILE]   AUTO-RECOVER: ${resolvedRef.match} — ${excessShares}× ${posSide.toUpperCase()} on ${ticker} (exchange=${posCount}, tracked=${allTrackedShares}, avg ${(avgPrice * 100).toFixed(0)}¢, fees=$${kalFees.toFixed(2)})`);
      trades.push({
        id: `arb-recovered-${Date.now()}-${ticker.slice(-6)}`,
        ts: new Date().toISOString(),
        match: resolvedRef.match,
        dir: resolvedRef.dir,
        status: "hedging",
        shares: excessShares,
        kalTicker: ticker,
        kalFillPrice: avgPrice,
        kalCost,
        pmOutcome: resolvedRef.pmOutcome,
        pmSlug: resolvedRef.pmSlug,
        pmTokenId: resolvedRef.pmTokenId,
        pmFillPrice: 0,
        pmCost: 0,
        totalCost: kalCost,
        projectedEdge: 0,
        projectedProfit: 0,
        initialExchange: "kal",
        kalFees,
      });
      changed = true;
      autoRecoveredPositions++;
    } else {
      console.log(`[RECONCILE]   Untracked Kalshi position: ${ticker} ${posCount}× ${posSide.toUpperCase()} (no matching resolved trade — cannot auto-recover)`);
      untrackedKal++;
    }
  }
  for (const p of pmPositions) {
    const size = Number(p.size ?? p.amount ?? 0);
    if (size < 1) continue;
    const outcome = String(p.outcome ?? p.title ?? "");
    const slug = String(p.slug ?? p.marketSlug ?? "");
    const tracked = trades.some(t =>
      t.status !== "resolved" && (
        (slug && t.pmSlug === slug) ||
        (outcome && t.pmOutcome && namesMatch(outcome, t.pmOutcome))
      )
    );
    if (!tracked) {
      // Check if there's excess PM shares beyond what resolved trades account for
      const pmShares = Math.round(size);
      // Only auto-recover PM positions for RECENT matches (≤3 days old).
      // Older positions are likely unredeemed winning tokens — don't hedge them.
      const slugDate = slug.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      const daysSinceMatch = slugDate
        ? (Date.now() - new Date(slugDate).getTime()) / 86_400_000
        : 999;
      if (daysSinceMatch > 3) {
        // Old match — just log, don't create hedging trade
        console.log(`[RECONCILE]   Stale PM position: ${outcome} ${pmShares}× on ${slug} (match ${slugDate ?? "?"}, ${Math.round(daysSinceMatch)}d ago — skipping auto-recover)`);
        continue;
      }
      // Resolved trades' PM positions are still held until settlement, so
      // only flag/recover if PM > all trades (resolved + active) for this slug
      const allTrackedPmShares = trades
        .filter(t => t.pmSlug === slug)
        .reduce((s, t) => s + t.shares, 0);
      if (pmShares > allTrackedPmShares) {
        const excess = pmShares - allTrackedPmShares;
        // Skip if there's an active hedge on this slug — the hedge loop is still buying
        // contracts on the opposite exchange, so position counts are mid-flight.
        const hasActiveHedgePm = trades.some(t => t.pmSlug === slug && t.status === "hedging");
        if (hasActiveHedgePm) {
          console.log(`[RECONCILE]   Skipping PM auto-recover for ${slug} — active hedge in progress (excess=${excess}, hedging trade exists)`);
          continue;
        }
        // Skip recovery for markets that already settled — resolved trades still hold PM tokens
        // until redeemed, so excess is expected and doesn't need hedging.
        const isMarketSettled = trades.some(t =>
          t.pmSlug === slug &&
          t.status === "resolved" &&
          (t.resolutionMethod === "settlement" || t.resolutionMethod === "market-settled" || t.resolutionMethod === "both-legs")
        );
        if (isMarketSettled) {
          console.log(`[RECONCILE]   Skipping PM auto-recover for ${slug} — market already settled (excess=${excess} PM shares)`);
          continue;
        }
        const resolvedRef = trades.find(t => t.pmSlug === slug);
        if (resolvedRef) {
          // Try actual fill price from pending_fills first (PM positions API avgPrice can be market price, not cost basis)
          const pfMatch = loadPendingFills().find(pf =>
            pf.exchange === "pm" && pf.pmSlug === slug && pf.pmOutcome === outcome && pf.price > 0
          );
          const estPriceRaw = pfMatch?.price || resolvedRef.pmFillPrice || resolvedRef.kalFillPrice || (resolvedRef.totalCost > 0 ? resolvedRef.totalCost / Math.max(resolvedRef.shares, 1) : 0);
          // Cap estPrice: if it would make combined cost >= $1/share, use a conservative estimate instead.
          // The hedge loop will enforce the real max via maxKalPrice = 1 - pmCostBasis - edge.
          const estPrice = estPriceRaw < 1 - MIN_EDGE ? estPriceRaw : 0;
          const pmCost = Math.round(excess * estPrice * 100) / 100;
          console.log(`[RECONCILE]   AUTO-RECOVER: ${excess} excess PM ${outcome} shares on ${slug} (est. $${estPrice}/share${pfMatch ? " from pending fill" : ""})`);
          trades.push({
            id: `arb-recovered-${Date.now()}-pm`,
            ts: new Date().toISOString(),
            match: resolvedRef.match,
            dir: resolvedRef.dir,
            status: "hedging",
            shares: excess,
            kalTicker: resolvedRef.kalTicker,
            kalFillPrice: 0,
            kalCost: 0,
            pmOutcome: outcome,
            pmSlug: slug,
            pmTokenId: resolvedRef.pmTokenId,
            pmFillPrice: estPrice,
            pmCost,
            totalCost: pmCost,
            projectedEdge: 0,
            projectedProfit: 0,
            initialExchange: "pm",
          });
          changed = true;
          autoRecoveredPositions++;
        } else {
          console.log(`[RECONCILE]   Untracked PM position: ${outcome} ${excess}× excess on ${slug} (no trade ref — cannot auto-recover)`);
          untrackedPm++;
        }
      }
    }
  }

  // Defensive invariant: totalCost MUST equal kalCost + pmCost (+ hedgeCost when one leg is 0) for resolved trades.
  // kalCost already includes kalFees (baked in at resolve time). hedgeCost is only additive for hedge-only legs.
  // Skip trades with initialExchange set (new-style) — verifyAndFixPnl() already computed their
  // totalCost with smarter hedge-cost logic that avoids double-counting merged costs.
  for (const trade of trades) {
    if (trade.status !== "resolved") continue;
    if (!trade.initialExchange) {
      const expected = totalCostForTrade(trade);
      if (Math.abs(trade.totalCost - expected) > 0.01) {
        console.log(`[RECONCILE]   Invariant fix: ${trade.match} totalCost $${trade.totalCost.toFixed(2)}→$${expected.toFixed(2)} (kalCost+hedgeCost+pmCost)`);
        trade.totalCost = expected;
        changed = true;
      }
      // Also fix P&L if it doesn't match shares - totalCost.
      // Only apply for hedge-complete trades where payout is always $1/share.
      // Settlement-method trades have conditional payouts (win/lose) and are
      // already handled correctly by verifyAndFixPnl() above.
      if (trade.realizedPnl != null && trade.resolutionMethod === "hedge-complete") {
        const correctPnl = Math.round((trade.shares - expected) * 100) / 100;
        if (Math.abs(trade.realizedPnl - correctPnl) > 0.01) {
          console.log(`[RECONCILE]   P&L fix: ${trade.match} realizedPnl $${trade.realizedPnl.toFixed(2)}→$${correctPnl.toFixed(2)}`);
          trade.realizedPnl = correctPnl;
          changed = true;
        }
      }
    }
  }

  if (changed && !DRY_RUN) {
    saveArbTrades(trades);
    writeReconcileAudit(trades);
  }
  // Signal the hedge loop to re-scan for new hedging trades created by auto-recovery
  if (autoRecoveredPositions > 0) {
    setReconcileRecoveredTrades(true);
  }
  console.log(
    `[RECONCILE] Done: ${staleResolved} stale resolved, ${filledToResolved} filled→resolved, ` +
    `${kalCostFixed} kalCost fixed, ${costsCorrected} costs corrected, ${pnlFixed} P&L fixed, ` +
    `${pmClobRepaired} PM cost repaired, ${untrackedKal} untracked KAL, ` +
    `${untrackedPm} untracked PM, ${recoveredFromPending} recovered from pending, ` +
    `${autoRecoveredPositions} auto-recovered positions`
  );
}

// ─── PM position helpers (module-level, shared by executeArb + monitorLoop) ──

export function getPmFunder(): string {
  if (_cachedFunder) return _cachedFunder;
  const w = new Wallet(process.env.POLY_WALLET_PRIVATE_KEY ?? "");
  _cachedFunder = process.env.POLY_FUNDER || w.address;
  return _cachedFunder;
}

export async function fetchPmPositionsCached(maxAgeMs = 5000): Promise<PmPosition[]> {
  if (_pmPosCache && Date.now() - _pmPosCache.ts < maxAgeMs) return _pmPosCache.data;
  const f = getPmFunder();
  const db = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
  const raw = await polyFetch<unknown>(`${db}/positions?user=${encodeURIComponent(f)}&sizeThreshold=0.1`);
  const data: PmPosition[] = Array.isArray(raw) ? (raw as PmPosition[]) :
    Array.isArray((raw as { positions?: unknown[] })?.positions) ? ((raw as { positions: PmPosition[] }).positions) : [];
  _pmPosCache = { data, ts: Date.now() };
  return data;
}

export function sumPmHeld(pmPositions: PmPosition[], tokenId: string): number {
  return Math.round(pmPositions.reduce((sum, p) => {
    const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
    const sz = Number(p.size ?? p.amount ?? 0);
    return tid === tokenId ? sum + sz : sum;
  }, 0));
}

// ─── Execution metadata extractors ────────────────────────────────────────────

export function extractPmMeta(v: unknown) {
  if (!v || typeof v !== "object") return {};
  const obj = v as PmOrderResponse;
  // Check nested .order field — some SDK versions wrap the response
  const inner = obj.order ?? obj;
  const txHashes = inner.transactionsHashes ?? obj.transactionsHashes;
  const txHash = Array.isArray(txHashes) ? txHashes[0] : inner.transactionHash ?? obj.transactionHash ?? obj.txHash;
  const orderId = inner.orderID ?? inner.orderId ?? obj.orderID ?? obj.orderId;
  const status = inner.status ?? obj.status;
  return { orderId, status, txHash };
}

export function extractKalMeta(v: unknown): { orderId: unknown; status: unknown; filled: number; fees: number; fillCostCents: number } {
  if (!v || typeof v !== "object") return { orderId: null, status: null, filled: 0, fees: 0, fillCostCents: 0 };
  const obj = v as KalshiOrder;
  const order = obj.order ?? obj;
  // Kalshi API returns _fp (string) fields; older responses use integer cents fields
  const rawFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled_contracts ?? order.filled ?? 0);
  const filled = Number.isFinite(rawFilled) ? rawFilled : 0;
  // Fees: _dollars fields are dollar strings, legacy fields are integer cents
  const takerFeesDollars = Number(order.taker_fees_dollars ?? 0);
  const makerFeesDollars = Number(order.maker_fees_dollars ?? 0);
  const takerFeesCents = Number(order.taker_fees ?? 0);
  const makerFeesCents = Number(order.maker_fees ?? 0);
  const rawFees = (takerFeesDollars + makerFeesDollars) || ((takerFeesCents + makerFeesCents) / 100);
  const fees = Number.isFinite(rawFees) ? rawFees : 0;
  // Fill cost: _dollars fields are dollar strings, legacy fields are integer cents
  const takerFillCostDollars = Number(order.taker_fill_cost_dollars ?? 0);
  const makerFillCostDollars = Number(order.maker_fill_cost_dollars ?? 0);
  const takerFillCostCents = Number(order.taker_fill_cost ?? 0);
  const makerFillCostCents = Number(order.maker_fill_cost ?? 0);
  const rawFillCost = (takerFillCostDollars + makerFillCostDollars) * 100 || (takerFillCostCents + makerFillCostCents);
  const fillCostCents = Number.isFinite(rawFillCost) ? rawFillCost : 0;
  return { orderId: order.order_id ?? order.orderId, status: order.status, filled, fees, fillCostCents };
}
