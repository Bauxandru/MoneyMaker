/**
 * Repair script for arb_trades.json using REAL exchange data.
 *
 * Data sources:
 *   - PM costs:  CLOB getTrades() API -- exact fill prices for ALL trades (not just current positions)
 *   - KAL costs: fetchAllKalshiFills() -- exact per-fill prices including fees
 *   - KAL P&L:  fetchAllKalshiSettlements() -- exact revenue/cost/fees for settled markets
 *
 * Creates data/arb_trades.backup.json before modifying.
 *
 * Usage: npm run repair:trades
 */

import dotenv from "dotenv";
dotenv.config();

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join } from "path";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./polyAuth.js";
import { fetchAllKalshiFills, fetchAllKalshiSettlements, type KalFill, type KalSettlement } from "./kalshiTrade.js";
import { type ArbTradeRecord, type ClobTrade } from "./types.js";
import { r2, kalSideForDir, totalCostForTrade } from "./utils.js";

const DATA_DIR = join(import.meta.dirname ?? ".", "..", "data");
const TRADES_PATH = join(DATA_DIR, "arb_trades.json");
const BACKUP_PATH = join(DATA_DIR, "arb_trades.backup.json");

// --- Terminal colors ---------------------------------------------------------
const C = {
  reset: "\x1b[0m",
  bold:  "\x1b[1m",
  dim:   "\x1b[2m",
  red:   "\x1b[31m",
  green: "\x1b[32m",
  yellow:"\x1b[33m",
  blue:  "\x1b[34m",
  magenta:"\x1b[35m",
  cyan:  "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen:"\x1b[42m",
  bgYellow:"\x1b[43m",
};
const tag = (color: string, label: string) => `${color}${C.bold}[${label}]${C.reset}`;
const val = (v: string | number) => `${C.cyan}${v}${C.reset}`;
const old = (v: string | number) => `${C.red}${v}${C.reset}`;
const nw = (v: string | number) => `${C.green}${v}${C.reset}`;
const arrow = `${C.dim}->${C.reset}`;
const warn = (msg: string) => `${C.yellow}${C.bold}${msg}${C.reset}`;

// Use shared type for all trade operations
type ArbTrade = ArbTradeRecord;

// --- Fetch PM CLOB trades ------------------------------------------------------

// ClobTrade imported from types.ts

/** Extract our actual fill size from a CLOB trade.
 *  When trader_side === "MAKER", the size field is the TAKER's total -- our fill is
 *  the sum of maker_orders where maker_address matches our wallet/funder. */
function getOurFillSize(ct: ClobTrade, ourAddresses: Set<string>): { size: number; cost: number } {
  if (ct.trader_side === "MAKER" && ct.maker_orders && ct.maker_orders.length > 0) {
    let totalSize = 0;
    let totalCost = 0;
    for (const mo of ct.maker_orders) {
      if (ourAddresses.has(mo.maker_address.toLowerCase())) {
        const s = Number(mo.matched_amount);
        totalSize += s;
        totalCost += s * Number(ct.price);
      }
    }
    return { size: totalSize, cost: totalCost };
  }
  const size = Number(ct.size);
  return { size, cost: size * Number(ct.price) };
}

/** Group CLOB fills by token ID, preserving individual fill details for timestamp matching.
 *  Normalizes fill sizes to our actual fills (not counterparty totals). */
function buildPmClobFills(clobTrades: ClobTrade[], ourAddresses: Set<string>): Map<string, ClobTrade[]> {
  const map = new Map<string, ClobTrade[]>();
  for (const ct of clobTrades) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    // Normalize: replace size with our actual fill size
    const { size } = getOurFillSize(ct, ourAddresses);
    if (size <= 0) continue; // Not our fill at all
    const normalized = { ...ct, size: String(size) };
    const list = map.get(ct.asset_id) ?? [];
    list.push(normalized);
    map.set(ct.asset_id, list);
  }
  return map;
}

/**
 * Match PM CLOB fills to an arb trade by timestamp.
 * Tries multiple candidate timestamps with different windows:
 *   - tradeTs: 60s window (initial entry -- both-legs trades)
 *   - resolvedTs: 300s window (hedge fill -- hedge-complete trades)
 * Collects fills greedily by proximity until shares are covered.
 * Returns { price, size, feeBps, totalCost } of matched fills, or null.
 */
function matchClobFillsToTrade(
  fills: ClobTrade[],
  candidateTimestamps: string[],
  targetShares: number,
  usedFillIndices: Set<number>
): { avgPrice: number; totalSize: number; feeBps: number; totalCost: number } | null {
  // Try each candidate timestamp, pick the one that matches the most shares
  let bestResult: { avgPrice: number; totalSize: number; feeBps: number; totalCost: number; matched: number[] } | null = null;

  for (const ts of candidateTimestamps) {
    if (!ts) continue;
    const refSec = new Date(ts).getTime() / 1000;
    // For resolved timestamps (hedge fills), use wider 300s window
    const maxWindow = ts === candidateTimestamps[0] ? 60 : 300;

    const candidates: { idx: number; dist: number }[] = [];
    for (let i = 0; i < fills.length; i++) {
      if (usedFillIndices.has(i)) continue;
      const raw = fills[i].match_time;
      const fillSec = /^\d+$/.test(raw) ? Number(raw) : new Date(raw).getTime() / 1000;
      const dist = Math.abs(fillSec - refSec);
      if (dist <= maxWindow) candidates.push({ idx: i, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    let totalSize = 0;
    let totalCost = 0;
    let totalFee = 0;
    const matched: number[] = [];

    for (const c of candidates) {
      if (totalSize >= targetShares) break;
      const f = fills[c.idx];
      const size = Number(f.size);
      const price = Number(f.price);
      const feeBps = Number(f.fee_rate_bps);
      totalSize += size;
      totalCost += size * price;
      totalFee += size * price * (feeBps / 10000);
      matched.push(c.idx);
    }

    if (totalSize === 0) continue;
    // Prefer the match that covers the most shares (closest to target)
    if (!bestResult || Math.abs(totalSize - targetShares) < Math.abs(bestResult.totalSize - targetShares)) {
      const avgFeeBps = totalCost > 0 ? (totalFee / totalCost) * 10000 : 0;
      bestResult = {
        avgPrice: totalCost / totalSize,
        totalSize,
        feeBps: avgFeeBps,
        totalCost: totalCost + totalFee,
        matched,
      };
    }
  }

  if (!bestResult || bestResult.totalSize < targetShares * 0.5) return null;

  for (const idx of bestResult.matched) usedFillIndices.add(idx);
  return {
    avgPrice: bestResult.avgPrice,
    totalSize: bestResult.totalSize,
    feeBps: bestResult.feeBps,
    totalCost: bestResult.totalCost,
  };
}

// --- Kalshi fill matching (timestamp-based, same approach as PM CLOB) ----------

/** Group Kalshi fills by ticker+side key, preserving individual fill details */
function buildKalFillsByTickerSide(fills: KalFill[]): Map<string, KalFill[]> {
  const map = new Map<string, KalFill[]>();
  for (const f of fills) {
    if (f.action !== "buy" || !f.ticker) continue;
    const key = `${f.ticker}:${f.side}`;
    const list = map.get(key) ?? [];
    list.push(f);
    map.set(key, list);
  }
  return map;
}

/**
 * Match Kalshi fills to an arb trade by timestamp proximity.
 * No time window -- fills can span hours (initial entry + hedge fills).
 * Sorts ALL unmatched fills by distance to trade timestamp, then greedily
 * collects until share count is reached. For shared tickers, the closest
 * fills are consumed first, so each trade gets its own fills.
 * Returns { costCents, fees, shares } of matched fills, or null.
 */
function matchKalFillsToTrade(
  fills: KalFill[],
  tradeTs: string,
  tradeShares: number,
  usedIndices: Set<number>
): { costCents: number; fees: number; shares: number } | null {
  const tradeSec = new Date(tradeTs).getTime() / 1000;

  // Sort ALL unmatched fills by distance to trade timestamp (no window limit)
  const candidates: { idx: number; dist: number }[] = [];
  for (let i = 0; i < fills.length; i++) {
    if (usedIndices.has(i)) continue;
    if (!fills[i].ts) continue;
    const fillSec = new Date(fills[i].ts).getTime() / 1000;
    const dist = Math.abs(fillSec - tradeSec);
    candidates.push({ idx: i, dist });
  }
  candidates.sort((a, b) => a.dist - b.dist);

  // Greedily collect fills until we reach the trade's share count
  let totalShares = 0;
  let totalCostCents = 0;
  let totalFees = 0;
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

  for (const idx of matched) usedIndices.add(idx);
  return { costCents: totalCostCents, fees: totalFees, shares: totalShares };
}

// --- Main ---------------------------------------------------------------------

async function main() {
  if (!existsSync(TRADES_PATH)) {
    console.log("No arb_trades.json found -- nothing to repair.");
    return;
  }

  copyFileSync(TRADES_PATH, BACKUP_PATH);
  console.log(`Backup created: ${BACKUP_PATH}`);

  const trades: ArbTrade[] = JSON.parse(readFileSync(TRADES_PATH, "utf8"));
  console.log(`Loaded ${trades.length} trades.`);

  // -- Fetch real exchange data -----------------------------------------------
  console.log("\nFetching exchange data...");

  let kalFills: KalFill[] = [];
  let kalSettlements: KalSettlement[] = [];
  let clobTrades: ClobTrade[] = [];

  // Kalshi fills + settlements
  try {
    [kalFills, kalSettlements] = await Promise.all([
      fetchAllKalshiFills(),
      fetchAllKalshiSettlements(),
    ]);
    console.log(`  ${C.blue}Kalshi:${C.reset} ${val(kalFills.length)} fills, ${val(kalSettlements.length)} settlements`);
  } catch (e) {
    console.error(`  Kalshi fetch failed: ${(e as Error).message}`);
  }

  // PM CLOB trades (exact fill prices for ALL historical trades)
  try {
    const pk = process.env.POLY_WALLET_PRIVATE_KEY;
    if (!pk) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
    const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
    const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
    const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
    const funder = process.env.POLY_FUNDER;
    const wallet = new Wallet(pk);
    const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
    const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
    clobTrades = (await client.getTrades()) as unknown as ClobTrade[];
    console.log(`  ${C.magenta}PM CLOB:${C.reset} ${val(clobTrades.length)} trades`);
  } catch (e) {
    console.error(`  PM CLOB fetch failed: ${(e as Error).message}`);
  }

  // Build set of our addresses for PM fill attribution
  const ourAddresses = new Set<string>();
  const pkVal = process.env.POLY_WALLET_PRIVATE_KEY;
  if (pkVal) ourAddresses.add(new Wallet(pkVal).address.toLowerCase());
  const funderVal = process.env.POLY_FUNDER;
  if (funderVal) ourAddresses.add(funderVal.toLowerCase());

  const pmClobFills = buildPmClobFills(clobTrades, ourAddresses);
  const kalFillsByTickerSide = buildKalFillsByTickerSide(kalFills);
  const settlementMap = new Map<string, KalSettlement>();
  for (const s of kalSettlements) {
    if (s.ticker) settlementMap.set(s.ticker, s);
  }

  console.log(`  ${C.magenta}PM CLOB:${C.reset} ${val(pmClobFills.size)} unique token IDs with BUY fills`);

  // Track which fill indices have been used to prevent double-assignment
  const usedPmFillIndices = new Map<string, Set<number>>();
  const usedKalFillIndices = new Map<string, Set<number>>();

  // -- Pass 0: Consolidate duplicate trades per ticker ----------------------
  // When ghost/recovered trades duplicate a normal trade on the same ticker,
  // merge all records into ONE using actual exchange data as the source of truth.
  console.log(`\n${C.bold}${C.white}--- Pass 0: Consolidating duplicate trades per ticker ---${C.reset}\n`);

  let consolidated = 0;
  {
    // Group trades by kalTicker
    const byTicker = new Map<string, { idx: number; trade: ArbTrade }[]>();
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      if (!t.kalTicker) continue;
      const list = byTicker.get(t.kalTicker) ?? [];
      list.push({ idx: i, trade: t });
      byTicker.set(t.kalTicker, list);
    }

    const removeIndices = new Set<number>();

    for (const [ticker, group] of byTicker) {
      if (group.length <= 1) continue;

      // Only consolidate if there are ghost/recovered/excess duplicates
      const hasGhost = group.some(g => g.trade.id.includes("ghost") || g.trade.id.includes("recovered") || g.trade.id.includes("excess"));
      if (!hasGhost) continue;

      // Get actual Kalshi data for this ticker
      const kalSummary = { yesBought: 0, noBought: 0, yesCost: 0, noCost: 0, yesFees: 0, noFees: 0 };
      for (const f of kalFills) {
        if (f.action !== "buy" || f.ticker !== ticker) continue;
        const price = f.side === "yes" ? f.yesPrice : f.noPrice;
        if (f.side === "yes") { kalSummary.yesBought += f.count; kalSummary.yesCost += f.count * price / 100; kalSummary.yesFees += f.feeCost; }
        else { kalSummary.noBought += f.count; kalSummary.noCost += f.count * price / 100; kalSummary.noFees += f.feeCost; }
      }

      // Determine which dir/side this position is (take from most common dir in group)
      const dirCounts = new Map<string, number>();
      for (const g of group) {
        dirCounts.set(g.trade.dir, (dirCounts.get(g.trade.dir) ?? 0) + g.trade.shares);
      }
      const primaryDir = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const kalSide = kalSideForDir(primaryDir);
      const actualKalShares = kalSide === "yes" ? kalSummary.yesBought : kalSummary.noBought;
      const actualKalCostRaw = kalSide === "yes" ? kalSummary.yesCost : kalSummary.noCost;
      const actualKalFees = r2(kalSide === "yes" ? kalSummary.yesFees : kalSummary.noFees);
      const actualKalCost = r2(actualKalCostRaw + actualKalFees);
      const actualKalFillPrice = actualKalShares > 0 ? r2(actualKalCostRaw / actualKalShares) : 0;

      // Get actual PM data for this token
      const pmTokenId = group[0].trade.pmTokenId;
      const pmSlug = group[0].trade.pmSlug;
      let actualPmShares = 0;
      let actualPmCost = 0;
      let actualPmFillPrice = 0;
      if (pmTokenId) {
        const pmFills = pmClobFills.get(pmTokenId) ?? [];
        for (const f of pmFills) {
          const size = Number(f.size);
          const price = Number(f.price);
          actualPmShares += size;
          actualPmCost += size * price;
        }
        actualPmFillPrice = actualPmShares > 0 ? r2(actualPmCost / actualPmShares) : 0;
        actualPmCost = r2(actualPmCost);
      }

      // Check for Kalshi settlement
      const settlement = settlementMap.get(ticker);

      // Choose the "primary" trade to keep (prefer the normal/original one)
      const primary = group.find(g => !g.trade.id.includes("ghost") && !g.trade.id.includes("recovered") && !g.trade.id.includes("excess"))
        ?? group.sort((a, b) => new Date(a.trade.ts).getTime() - new Date(b.trade.ts).getTime())[0];

      // Collect all hedge costs that represent real exit trades (money spent selling back positions)
      // Only count hedgeCost from trades that were hedge-complete with a SELL exit, not phantom values
      let realHedgeCost = 0;
      for (const g of group) {
        if (g.trade.resolutionMethod === "hedge-complete" && (g.trade.hedgeCost ?? 0) > 0) {
          // hedgeCost is only "real" if it represents selling back a position
          // For PM-initial trades: hedgeCost = KAL cost (if KAL hedge filled) -> already in kalCost
          // For KAL-initial trades: hedgeCost = PM cost (if PM hedge filled) -> already in pmCost
          // So hedgeCost should NOT be added separately -- it's already captured in leg costs
        }
      }

      // Determine status
      let status: string = "resolved";
      let resolutionMethod: string | undefined;
      let resolvedTs: string | undefined;
      const anyHedging = group.some(g => g.trade.status === "hedging");

      if (settlement) {
        status = "resolved";
        resolutionMethod = "settlement";
        resolvedTs = settlement.settledTime ?? group[group.length - 1].trade.resolvedTs;
      } else if (actualKalShares > 0 && actualPmShares > 0 && !anyHedging) {
        // Both legs filled
        const allResolved = group.every(g => g.trade.status === "resolved");
        if (allResolved) {
          status = "resolved";
          // If any was both-legs, use that; otherwise hedge-complete
          resolutionMethod = group.some(g => g.trade.resolutionMethod === "both-legs") ? "both-legs" : "hedge-complete";
          resolvedTs = group.reduce((latest, g) => {
            const ts = g.trade.resolvedTs ?? g.trade.ts;
            return !latest || ts > latest ? ts : latest;
          }, "" as string);
        } else {
          status = "hedging";
        }
      } else if (anyHedging) {
        status = "hedging";
      }

      // Determine arb shares = min(KAL fills, PM fills). Excess on either side is over-hedge.
      const arbShares = Math.min(actualKalShares, Math.round(actualPmShares)) || actualKalShares || Math.round(actualPmShares);

      // Cap BOTH sides to only the shares that match the arb (excess = over-hedge loss)
      const cappedPmShares = Math.min(Math.round(actualPmShares), arbShares);
      const cappedPmCost = actualPmShares > 0
        ? r2(cappedPmShares * (actualPmCost / actualPmShares))
        : 0;
      const cappedKalShares = Math.min(actualKalShares, arbShares);
      const cappedKalCost = actualKalShares > 0
        ? r2(cappedKalShares * (actualKalCostRaw / actualKalShares) + actualKalFees * (cappedKalShares / actualKalShares))
        : 0;

      // Track excess costs separately
      const excessKalCost = r2(actualKalCost - cappedKalCost);
      const excessPmCost = r2(actualPmCost - cappedPmCost);
      const totalExcessCost = r2(excessKalCost + excessPmCost);

      // Calculate P&L using only arb-matched costs
      const totalCost = r2(cappedKalCost + cappedPmCost);
      let realizedPnl: number | undefined;
      if (status === "resolved") {
        if (settlement) {
          const kalSideWon = (kalSide === "yes" && settlement.marketResult === "yes") || (kalSide === "no" && settlement.marketResult === "no");
          const hasKal = cappedKalCost > 0;
          const hasPm = cappedPmCost > 0;
          const kalPayout = (hasKal && kalSideWon) ? cappedKalShares : 0;
          const pmPayout = (hasPm && !kalSideWon) ? cappedPmShares : 0;
          realizedPnl = r2(kalPayout + pmPayout - totalCost);
        } else if (resolutionMethod === "both-legs" || resolutionMethod === "hedge-complete") {
          // Guaranteed $1/share payout for matched arb
          realizedPnl = r2(arbShares - totalCost);
        }
      }

      // Build the merged IDs list for audit trail
      const mergedFrom = group.filter(g => g !== primary).map(g => g.trade.id);

      // Update primary trade with actual data
      const t = primary.trade;

      console.log(`  ${tag(C.bgYellow, "CONSOLIDATE")} ${C.bold}${t.match}${C.reset} (${ticker})`);
      console.log(`    ${C.dim}Merging ${group.length} records into 1. Removing: ${mergedFrom.join(", ")}${C.reset}`);
      console.log(`    ${C.dim}KAL: ${actualKalShares} ${kalSide} fills -> ${cappedKalShares} arb-matched, cost $${cappedKalCost} (fees $${actualKalFees})${C.reset}`);
      console.log(`    ${C.dim}PM:  ${actualPmShares.toFixed(1)} total fills -> ${cappedPmShares} arb-matched @ ${actualPmFillPrice} = $${cappedPmCost}${C.reset}`);
      if (totalExcessCost > 0.01) {
        console.log(`    ${C.yellow}Excess: KAL $${excessKalCost} + PM $${excessPmCost} = $${totalExcessCost} (over-hedge, separate from arb P&L)${C.reset}`);
      }
      console.log(`    ${C.dim}Arb: ${arbShares} shares, cost $${totalCost}, P&L: $${realizedPnl ?? "TBD"}${C.reset}`);

      t.shares = arbShares;
      t.kalFillPrice = actualKalFillPrice;
      t.kalCost = cappedKalCost;
      t.kalFees = r2(actualKalFees * (cappedKalShares / Math.max(1, actualKalShares)));
      t.pmFillPrice = actualPmFillPrice;
      t.pmCost = cappedPmCost;
      t.totalCost = totalCost;
      t.hedgeCost = resolutionMethod === "hedge-complete" ? (t.initialExchange === "kal" ? cappedPmCost : cappedKalCost) : undefined;
      // Track excess as over-hedge
      if (actualKalShares > arbShares || Math.round(actualPmShares) > arbShares) {
        t.overHedgeShares = Math.max(actualKalShares - arbShares, Math.round(actualPmShares) - arbShares);
        t.overHedgeCost = totalExcessCost;
        t.overHedgeSide = (actualKalShares > arbShares) ? kalSide as "yes" | "no" : "yes";
      }
      t.status = status as any;
      t.resolutionMethod = resolutionMethod as any;
      if (resolvedTs) t.resolvedTs = resolvedTs;
      if (realizedPnl != null) t.realizedPnl = realizedPnl;
      t.kalYesFills = kalSummary.yesBought;
      t.kalNoFills = kalSummary.noBought;

      // Clear ghost-related fields
      delete t.overHedgeShares;
      delete t.overHedgeCost;
      delete t.overHedgeSide;

      // Mark other records for removal
      for (const g of group) {
        if (g !== primary) removeIndices.add(g.idx);
      }
      consolidated++;
    }

    // Remove merged records (iterate in reverse to preserve indices)
    if (removeIndices.size > 0) {
      const sortedRemove = [...removeIndices].sort((a, b) => b - a);
      for (const idx of sortedRemove) {
        console.log(`    ${C.red}Removing:${C.reset} ${trades[idx].id} (${trades[idx].match})`);
        trades.splice(idx, 1);
      }
      console.log(`  ${C.green}Removed ${removeIndices.size} duplicate records${C.reset}`);
    }
  }

  console.log(`\n${C.bold}${C.white}--- Repairing trades from exchange data ---${C.reset}\n`);

  let pmFixed = 0;
  let kalFixed = 0;
  let kalFeesFixed = 0;
  let pnlFixed = 0;
  let stuckFixed = 0;
  let costSumFixed = 0;
  let hedgeCostFixed = 0;
  let sharesWarnings = 0;

  // -- Pass 1: Sort trades by timestamp for deterministic fill assignment ----
  // Process oldest first so greedy fill matchers consume in chronological order.
  const sortedIndices = trades.map((_, i) => i);
  sortedIndices.sort((a, b) => new Date(trades[a].ts).getTime() - new Date(trades[b].ts).getTime());

  for (const ti of sortedIndices) {
    const t = trades[ti];

    // 0. Fix stuck "filled" backfill trades
    if (t.status === "filled" && t.realizedPnl != null && t.id.startsWith("backfill")) {
      console.log(`  ${tag(C.yellow, "STUCK")} ${C.bold}${t.match}${C.reset} (${t.id}): filled ${arrow} resolved (settlement)`);
      t.status = "resolved";
      t.resolutionMethod = "settlement";
      t.resolvedTs = t.resolvedTs ?? t.ts;
      stuckFixed++;
    }

    // Skip backfills for cost/pnl corrections
    if (t.id.startsWith("backfill")) continue;

    // --- 1. Correct KAL cost from real Kalshi fills (timestamp-matched) ------
    // Run FIRST so we know actual shares filled, then use that for PM matching.
    // Skip settlement trades (step 5 handles those with higher accuracy).
    if (t.status === "resolved" && t.kalTicker && t.resolutionMethod !== "settlement") {
      const kalSide = kalSideForDir(t.dir);
      const kalKey = `${t.kalTicker}:${kalSide}`;
      const kalFillList = kalFillsByTickerSide.get(kalKey);
      if (kalFillList && kalFillList.length > 0) {
        let usedKal = usedKalFillIndices.get(kalKey);
        if (!usedKal) { usedKal = new Set(); usedKalFillIndices.set(kalKey, usedKal); }

        const matched = matchKalFillsToTrade(kalFillList, t.ts, t.shares, usedKal);
        if (matched) {
          const avgPrice = r2(matched.costCents / matched.shares / 100);
          const kalCostWithFees = r2(matched.costCents / 100 + matched.fees);

          // Warn if actual shares differ from recorded (possible split-position issue)
          if (matched.shares !== t.shares) {
            console.log(`  ${tag(C.bgRed, "SHARES-WARN")} ${C.bold}${t.match}${C.reset}: recorded ${old(t.shares)} shares but matched ${nw(matched.shares)} from Kalshi fills`);
            sharesWarnings++;
          }

          if (Math.abs(kalCostWithFees - t.kalCost) > 0.01 || Math.abs(avgPrice - t.kalFillPrice) > 0.01) {
            console.log(`  ${tag(C.blue, "KAL")} ${C.bold}${t.match}${C.reset}: kalFP ${old(t.kalFillPrice)} ${arrow} ${nw(avgPrice)}, kalCost ${old("$" + t.kalCost)} ${arrow} ${nw("$" + kalCostWithFees)} (${val(matched.shares)} shares, fee=${val("$" + matched.fees.toFixed(2))})`);
            t.kalFillPrice = avgPrice;
            t.kalCost = kalCostWithFees;
            kalFixed++;
          }

          // Fix kalFees from matched fill data
          const correctFees = r2(matched.fees);
          if (t.kalFees == null || Math.abs((t.kalFees ?? 0) - correctFees) > 0.005) {
            console.log(`  ${tag(C.blue, "KAL-FEES")} ${C.bold}${t.match}${C.reset}: ${old("$" + (t.kalFees ?? 0).toFixed(2))} ${arrow} ${nw("$" + correctFees.toFixed(2))}`);
            t.kalFees = correctFees;
            kalFeesFixed++;
          }
        }
      }
    }

    // --- 2. Correct PM cost from CLOB trade fills (timestamp-matched) -----
    // For both-legs: PM filled at trade creation time -> use t.ts
    // For hedge-complete: PM filled during hedge cycle -> use t.resolvedTs
    if (t.status === "resolved" && t.pmTokenId && (t.resolutionMethod === "hedge-complete" || t.resolutionMethod === "both-legs")) {
      const fills = pmClobFills.get(t.pmTokenId);
      if (fills && fills.length > 0) {
        let used = usedPmFillIndices.get(t.pmTokenId);
        if (!used) { used = new Set(); usedPmFillIndices.set(t.pmTokenId, used); }

        // Build candidate timestamps: trade creation + resolve time (for hedge fills)
        const candidateTs: string[] = [t.ts];
        if (t.resolvedTs && t.resolutionMethod === "hedge-complete") {
          candidateTs.push(t.resolvedTs);
        }

        const matched = matchClobFillsToTrade(fills, candidateTs, t.shares, used);
        if (matched) {
          // pmFillPrice = average fill price (fee-exclusive); pmCost = total cost including fees
          let realPmFP = r2(matched.avgPrice);
          const costPerShareWithFees = matched.totalCost / matched.totalSize;
          let realPmCost = r2(t.shares * costPerShareWithFees);
          // Binary market price inversion guard: CLOB may report the complementary price
          // (e.g., 0.87 instead of 0.13 for a BUY on the underdog token).
          // Detect: if using CLOB price makes combined cost > $1/share, invert.
          const combinedWithClob = (t.kalCost + realPmCost) / Math.max(t.shares, 1);
          if (combinedWithClob > 1.0 && realPmFP > 0.5) {
            const invertedFP = r2(1 - realPmFP);
            const invertedCost = r2(t.shares * (1 - costPerShareWithFees));
            const combinedInverted = (t.kalCost + invertedCost) / Math.max(t.shares, 1);
            if (combinedInverted < 1.0) {
              console.log(`  ${tag(C.yellow, "PM-INVERT")} ${C.bold}${t.match}${C.reset}: CLOB price ${realPmFP} -> inverted to ${invertedFP} (combined $${combinedWithClob.toFixed(2)}/sh -> $${combinedInverted.toFixed(2)}/sh)`);
              realPmFP = invertedFP;
              realPmCost = invertedCost;
            }
          }
          if (Math.abs(realPmCost - t.pmCost) > 0.01 || Math.abs(realPmFP - t.pmFillPrice) > 0.01) {
            console.log(`  ${tag(C.magenta, "PM-CLOB")} ${C.bold}${t.match}${C.reset}: pmFP ${old(t.pmFillPrice)} ${arrow} ${nw(realPmFP)}, pmCost ${old("$" + t.pmCost)} ${arrow} ${nw("$" + realPmCost)} (${val(matched.totalSize)} fills @ ${val(matched.avgPrice.toFixed(4))})`);
            t.pmFillPrice = realPmFP;
            t.pmCost = realPmCost;
            pmFixed++;
          }
        }
      }
    }

    // --- 3. Fix totalCost = kalCost + hedgeCost (when applicable) + pmCost -
    if (t.status === "resolved" && (t.resolutionMethod === "hedge-complete" || t.resolutionMethod === "both-legs")) {
      const sum = totalCostForTrade(t);
      if (Math.abs(sum - t.totalCost) > 0.02) {
        console.log(`  ${tag(C.yellow, "COST-SUM")} ${C.bold}${t.match}${C.reset}: ${old("$" + t.totalCost)} ${arrow} ${nw("$" + sum)}`);
        t.totalCost = sum;
        costSumFixed++;
      }
    }

    // --- 3b. Fix hedgeCost for hedge-complete trades ---------------------
    // hedgeCost = cost of the hedge leg (opposite to initialExchange).
    // If initialExchange=kal -> hedgeCost = pmCost (PM was hedge).
    // If initialExchange=pm  -> hedgeCost = kalCost (KAL was hedge).
    //   Exception: PM-initial trades where KAL never filled (kalCost=0) -- hedge went
    //   through PM opposite token. Keep existing hedgeCost (set at trade creation).
    if (t.resolutionMethod === "hedge-complete" && t.status === "resolved") {
      const isPmInitial = t.initialExchange === "pm";
      const correctHedgeCost = isPmInitial
        ? (t.kalCost > 0 ? t.kalCost : (t.hedgeCost ?? 0))  // preserve existing if KAL never filled
        : t.pmCost;
      if (t.hedgeCost == null || Math.abs((t.hedgeCost ?? 0) - correctHedgeCost) > 0.02) {
        console.log(`  ${tag(C.cyan, "HEDGE-COST")} ${C.bold}${t.match}${C.reset}: ${old("$" + (t.hedgeCost ?? 0).toFixed(2))} ${arrow} ${nw("$" + correctHedgeCost.toFixed(2))} ${C.dim}(initial=${t.initialExchange})${C.reset}`);
        t.hedgeCost = r2(correctHedgeCost);
        hedgeCostFixed++;
      }
    }

    // --- 4. Recalculate P&L for hedge-complete and both-legs trades -----
    //     both-legs / hedge-complete with BOTH legs filled: $1/share payout -> pnl = shares - totalCost.
    //     hedge-complete with one leg = 0: round-trip on one exchange -> pnl = hedgeCost - cost of filled leg.
    if ((t.resolutionMethod === "hedge-complete" || t.resolutionMethod === "both-legs") && t.status === "resolved") {
      const correctPnl = r2(t.shares - t.totalCost);
      if (t.realizedPnl == null || Math.abs(t.realizedPnl - correctPnl) > 0.02) {
        const pnlColor = correctPnl >= 0 ? C.green : C.red;
        console.log(`  ${tag(pnlColor, "PNL")} ${C.bold}${t.match}${C.reset}: ${old("$" + (t.realizedPnl ?? 0).toFixed(2))} ${arrow} ${pnlColor}${C.bold}$${correctPnl.toFixed(2)}${C.reset} ${C.dim}(${t.resolutionMethod})${C.reset}`);
        t.realizedPnl = correctPnl;
        pnlFixed++;
      }
    }

    // --- 5. Settlement trades: per-trade P&L using market result ---------
    //     Don't use aggregate settlement cost/revenue (yesCost+noCost, revenue) --
    //     it sums ALL fills for the ticker, double-counting when trades share a ticker.
    //     Instead, use per-trade kalCost (already set by step 1 from timestamp-matched fills)
    //     and determine payout from market result.
    if (t.resolutionMethod === "settlement" && t.status === "resolved") {
      const settlement = settlementMap.get(t.kalTicker);
      if (settlement) {
        const kalSide = kalSideForDir(t.dir);
        const kalSideWon = (kalSide === "yes" && settlement.marketResult === "yes") || (kalSide === "no" && settlement.marketResult === "no");
        const hasKal = t.kalCost > 0 || t.kalFillPrice > 0;
        const hasPm = t.pmCost > 0 || t.pmFillPrice > 0;
        const kalPayout = (hasKal && kalSideWon) ? t.shares : 0;
        const pmPayout = (hasPm && !kalSideWon) ? t.shares : 0;
        const correctPnl = r2(kalPayout + pmPayout - t.kalCost - t.pmCost);

        if (t.realizedPnl == null || Math.abs(t.realizedPnl - correctPnl) > 0.02) {
          const sPnlColor = correctPnl >= 0 ? C.green : C.red;
          console.log(`  ${tag(sPnlColor, "PNL-SETTLE")} ${C.bold}${t.match}${C.reset}: ${old("$" + (t.realizedPnl ?? 0).toFixed(2))} ${arrow} ${sPnlColor}${C.bold}$${correctPnl.toFixed(2)}${C.reset} ${C.dim}(kalWon=${kalSideWon} kalPay=$${kalPayout} pmPay=$${pmPayout})${C.reset}`);
          t.realizedPnl = correctPnl;
          pnlFixed++;
        }
      }
    }
  }

  // -- Pass: Exchange Reconcile -- store actual fill breakdown per ticker ------
  // Groups ALL Kalshi fills by ticker (regardless of side), then distributes them
  // to arb trades. Any excess beyond what trades account for = over-hedge.
  console.log(`\n${C.bold}${C.white}--- Exchange Reconcile: storing actual fill breakdown ---${C.reset}\n`);
  let overHedgeFixed = 0;
  let fillBreakdownFixed = 0;

  // Group ALL Kalshi BUY fills by ticker -> { yesFills, noFills, yesCost, noCost, yesFees, noFees }
  const kalTickerSummary = new Map<string, { yesBought: number; noBought: number; yesCost: number; noCost: number; yesFees: number; noFees: number }>();
  for (const f of kalFills) {
    if (f.action !== "buy") continue;
    if (!kalTickerSummary.has(f.ticker)) kalTickerSummary.set(f.ticker, { yesBought: 0, noBought: 0, yesCost: 0, noCost: 0, yesFees: 0, noFees: 0 });
    const g = kalTickerSummary.get(f.ticker)!;
    const price = f.side === "yes" ? f.yesPrice : f.noPrice;
    if (f.side === "yes") { g.yesBought += f.count; g.yesCost += f.count * price / 100; g.yesFees += f.feeCost; }
    else { g.noBought += f.count; g.noCost += f.count * price / 100; g.noFees += f.feeCost; }
  }

  // Group trades by kalTicker
  const tradesByTicker = new Map<string, ArbTrade[]>();
  for (const t of trades) {
    if (!t.kalTicker) continue;
    const list = tradesByTicker.get(t.kalTicker) ?? [];
    list.push(t);
    tradesByTicker.set(t.kalTicker, list);
  }

  for (const [ticker, kal] of kalTickerSummary) {
    const tickerTrades = tradesByTicker.get(ticker);
    if (!tickerTrades || tickerTrades.length === 0) continue;

    // Store actual fill counts on each trade
    // For tickers with ONE trade, all fills belong to that trade
    // For tickers with MULTIPLE trades, distribute proportionally by shares
    const totalTradeYes = tickerTrades.reduce((s, t) => s + ((t.dir === "A" || t.dir === "B") ? t.shares : 0), 0);
    const totalTradeNo = tickerTrades.reduce((s, t) => s + ((t.dir === "C" || t.dir === "D") ? t.shares : 0), 0);

    if (tickerTrades.length === 1) {
      const t = tickerTrades[0];
      const changed = t.kalYesFills !== kal.yesBought || t.kalNoFills !== kal.noBought;
      if (changed) {
        t.kalYesFills = kal.yesBought;
        t.kalNoFills = kal.noBought;
        fillBreakdownFixed++;
        console.log(`  ${tag(C.cyan, "FILLS")} ${C.bold}${t.match}${C.reset} (${ticker}): YES=${kal.yesBought} NO=${kal.noBought}`);
      }

      // Detect over-hedge: more fills on one side than expected
      const initialSide = (t.dir === "A" || t.dir === "B") ? "yes" : "no";
      const expectedInitial = t.shares;
      // For hedge-complete trades, we expect initial side + possibly opposite side = shares each
      let expectedYes = (initialSide === "yes") ? expectedInitial : 0;
      let expectedNo = (initialSide === "no") ? expectedInitial : 0;
      // If hedge-complete with Kalshi opposite hedge: only expect opposite fills
      // when the hedge actually went to Kalshi (pmCost === 0 means KAL-hedged).
      // When pmCost > 0, the hedge went to PM -- ALL opposite Kalshi fills are excess (over-hedge).
      if (t.resolutionMethod === "hedge-complete" && (t.pmCost === 0 || !t.pmCost)) {
        if (initialSide === "yes" && kal.noBought > 0) expectedNo = t.shares;
        if (initialSide === "no" && kal.yesBought > 0) expectedYes = t.shares;
      }

      const excessYes = Math.max(0, kal.yesBought - expectedYes);
      const excessNo = Math.max(0, kal.noBought - expectedNo);
      if (excessYes > 0 || excessNo > 0) {
        const excessSide = excessYes > excessNo ? "yes" : "no";
        const excessCount = excessSide === "yes" ? excessYes : excessNo;
        const excessCost = r2(excessSide === "yes"
          ? (kal.yesCost + kal.yesFees) * (excessYes / Math.max(1, kal.yesBought))
          : (kal.noCost + kal.noFees) * (excessNo / Math.max(1, kal.noBought)));

        if (t.overHedgeShares !== excessCount || t.overHedgeSide !== excessSide) {
          console.log(`  ${tag(C.red, "OVER-HEDGE")} ${C.bold}${t.match}${C.reset}: ${excessCount} excess ${excessSide.toUpperCase()} ($${excessCost.toFixed(2)})`);
          t.overHedgeShares = excessCount;
          t.overHedgeCost = excessCost;
          t.overHedgeSide = excessSide;
          overHedgeFixed++;
        }
      } else if (t.overHedgeShares) {
        // Clear stale over-hedge data
        delete t.overHedgeShares;
        delete t.overHedgeCost;
        delete t.overHedgeSide;
      }
    } else {
      // Multiple trades on same ticker -- store total fills on first, proportional on rest
      // Just store aggregate fill counts on all trades
      for (const t of tickerTrades) {
        if (t.kalYesFills !== kal.yesBought || t.kalNoFills !== kal.noBought) {
          t.kalYesFills = kal.yesBought;
          t.kalNoFills = kal.noBought;
          fillBreakdownFixed++;
        }
      }
    }
  }

  // Save
  writeFileSync(TRADES_PATH, JSON.stringify(trades, null, 2), "utf8");

  const totalFixes = consolidated + pmFixed + kalFixed + kalFeesFixed + hedgeCostFixed + costSumFixed + pnlFixed + stuckFixed + overHedgeFixed + fillBreakdownFixed;
  const summaryColor = totalFixes === 0 ? C.green : C.yellow;
  console.log(`\n${summaryColor}${C.bold}=== Repair complete ===${C.reset}`);
  const line = (label: string, count: number, color: string) =>
    console.log(`  ${color}${label.padEnd(24)}${C.reset} ${count > 0 ? C.bold + C.yellow + count + C.reset : C.dim + "0" + C.reset}`);
  line("Consolidated (merged):", consolidated, consolidated > 0 ? C.bgYellow : C.dim);
  line("PM costs from CLOB:", pmFixed, C.magenta);
  line("KAL costs from fills:", kalFixed, C.blue);
  line("KAL fees fixed:", kalFeesFixed, C.blue);
  line("Hedge cost fixes:", hedgeCostFixed, C.cyan);
  line("Cost-sum fixes:", costSumFixed, C.yellow);
  line("P&L fixes:", pnlFixed, C.green);
  line("Stuck trades:", stuckFixed, C.yellow);
  line("Shares warnings:", sharesWarnings, sharesWarnings > 0 ? C.red : C.dim);
  line("Fill breakdowns set:", fillBreakdownFixed, C.cyan);
  line("Over-hedges detected:", overHedgeFixed, overHedgeFixed > 0 ? C.red : C.dim);
  console.log(`  ${C.white}${"Total trades:".padEnd(24)}${C.reset} ${C.bold}${trades.length}${C.reset}`);
  console.log(`  ${C.white}${"Total fixes applied:".padEnd(24)}${C.reset} ${totalFixes > 0 ? C.bold + C.yellow + totalFixes : C.bold + C.green + "0 (clean!)"}${C.reset}\n`);
}

main().catch(e => {
  console.error("Repair failed:", e);
  process.exit(1);
});
