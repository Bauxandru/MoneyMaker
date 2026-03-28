/**
 * Analysis: What if we never hedged and just placed the initial (higher-price) bet?
 * Shows every trade with both the no-hedge and actual P&L side by side.
 */
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

interface Trade {
  id: string;
  ts: string;
  match: string;
  dir: string;
  status: string;
  shares: number;
  kalTicker: string;
  kalFillPrice: number;
  kalCost: number;
  pmOutcome: string;
  pmSlug: string;
  pmFillPrice: number;
  pmCost: number;
  totalCost: number;
  projectedEdge: number;
  projectedProfit: number;
  realizedPnl?: number;
  resolutionMethod?: string;
  resolvedTs?: string;
  hedgeCost?: number;
}

import { fetchAllKalshiSettlements } from "./kalshiTrade.js";

async function main() {
  const trades: Trade[] = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));

  console.log("Fetching Kalshi settlements...");
  let settlements: Array<{ ticker: string; revenue: number; yesCount: number; noCount: number }> = [];
  try {
    settlements = await fetchAllKalshiSettlements();
    console.log(`Got ${settlements.length} settlements.\n`);
  } catch (e) {
    console.warn(`Could not fetch settlements: ${(e as Error).message}\n`);
  }
  const settlementMap = new Map<string, { revenue: number; yesCount: number; noCount: number }>();
  for (const s of settlements) {
    settlementMap.set(s.ticker, s);
  }

  interface Result {
    idx: number;
    match: string;
    date: string;
    initialSide: string;
    initialPrice: number;
    initialCost: number;
    shares: number;
    method: string;
    actualPnl: number;
    didInitialWin: boolean | null;
    noHedgePnl: number;
  }

  const results: Result[] = [];
  let idx = 0;

  for (const t of trades) {
    if (t.status !== "resolved" && t.status !== "filled") continue;

    // Skip the 2000-share PARIVISION backfill outlier
    if (t.match === "PARIVISION" && t.shares === 2000) continue;

    idx++;
    const kalFP = t.kalFillPrice || 0;
    const pmFP = t.pmFillPrice || 0;
    const kalCost = t.kalCost || 0;
    const pmCost = t.pmCost || 0;
    const shares = t.shares || 0;
    const pnl = t.realizedPnl ?? 0;
    const method = t.resolutionMethod || "";

    let initialSide: string;
    let initialPrice: number;

    if (pmCost === 0 && kalCost > 0 && pmFP === 0) {
      initialSide = "kal";
      initialPrice = kalFP;
    } else if (kalCost === 0 && pmCost > 0 && kalFP === 0) {
      initialSide = "pm";
      initialPrice = pmFP;
    } else {
      if (kalFP >= pmFP) {
        initialSide = "kal";
        initialPrice = kalFP;
      } else {
        initialSide = "pm";
        initialPrice = pmFP;
      }
    }

    let initialCost: number;
    if (initialSide === "kal") {
      initialCost = kalCost > 0 ? kalCost : kalFP * shares;
    } else {
      initialCost = pmCost > 0 ? pmCost : pmFP * shares;
    }

    let didInitialWin: boolean | null = null;
    const settleData = settlementMap.get(t.kalTicker);

    if (settleData) {
      const kalYesWon = settleData.revenue > 0;
      if (initialSide === "kal") {
        didInitialWin = kalYesWon;
      } else {
        didInitialWin = !kalYesWon;
      }
    } else if (method === "settlement" && pmCost === 0 && kalCost > 0) {
      didInitialWin = pnl > 0;
    } else if (method === "settlement" && kalCost === 0 && pmCost > 0) {
      didInitialWin = pnl > 0;
    }

    const noHedgePnl = didInitialWin === true
      ? Math.round((shares - initialCost) * 100) / 100
      : didInitialWin === false
        ? Math.round(-initialCost * 100) / 100
        : 0; // unknown

    results.push({
      idx,
      match: t.match,
      date: t.ts.slice(5, 10), // MM-DD
      initialSide,
      initialPrice: Math.round(initialPrice * 100) / 100,
      initialCost: Math.round(initialCost * 100) / 100,
      shares,
      method,
      actualPnl: pnl,
      didInitialWin,
      noHedgePnl,
    });
  }

  // Print chronological detailed list
  console.log("=== EVERY TRADE: NO-HEDGE vs ACTUAL (excl. PARIVISION 2000-share outlier) ===\n");
  console.log(
    `${"#".padStart(3)}  ${"Date".padEnd(5)}  ${"W/L".padEnd(4)}  ${"Match".padEnd(50)}  ${"Side".padEnd(3)}  ${"@Price".padEnd(6)}  ${"Shrs".padStart(4)}  ${"Cost".padStart(7)}  ${"NoHedge".padStart(9)}  ${"Actual".padStart(9)}  ${"Diff".padStart(9)}`
  );
  console.log("-".repeat(125));

  let runningNoHedge = 0;
  let runningActual = 0;

  for (const r of results) {
    const tag = r.didInitialWin === null ? "??" : r.didInitialWin ? "WIN" : "LOSS";
    const noHedgeStr = r.didInitialWin === null
      ? "??.??".padStart(9)
      : (r.noHedgePnl >= 0 ? "+" : "-") + "$" + Math.abs(r.noHedgePnl).toFixed(2).padStart(6);
    const actualStr = (r.actualPnl >= 0 ? "+" : "-") + "$" + Math.abs(r.actualPnl).toFixed(2).padStart(6);
    const diff = r.didInitialWin !== null ? r.actualPnl - r.noHedgePnl : 0;
    const diffStr = r.didInitialWin === null
      ? "".padStart(9)
      : (diff >= 0 ? "+" : "-") + "$" + Math.abs(diff).toFixed(2).padStart(6);

    if (r.didInitialWin !== null) runningNoHedge += r.noHedgePnl;
    runningActual += r.actualPnl;

    console.log(
      `${String(r.idx).padStart(3)}  ${r.date}  ${tag.padEnd(4)}  ${r.match.padEnd(50)}  ${r.initialSide.toUpperCase().padEnd(3)}  ${("$" + r.initialPrice.toFixed(2)).padStart(6)}  ${String(r.shares).padStart(4)}  ${("$" + r.initialCost.toFixed(2)).padStart(7)}  ${noHedgeStr}  ${actualStr}  ${diffStr}`
    );
  }

  // Summary
  const known = results.filter(r => r.didInitialWin !== null);
  const wins = known.filter(r => r.didInitialWin === true);
  const losses = known.filter(r => r.didInitialWin === false);
  const unknown = results.filter(r => r.didInitialWin === null);

  const totalNoHedge = known.reduce((s, r) => s + r.noHedgePnl, 0);
  const totalActual = results.reduce((s, r) => s + r.actualPnl, 0);

  console.log("-".repeat(125));
  console.log(
    `${"".padStart(3)}  ${"".padEnd(5)}  ${"".padEnd(4)}  ${"TOTALS".padEnd(50)}  ${"".padEnd(3)}  ${"".padEnd(6)}  ${"".padStart(4)}  ${"".padStart(7)}  ${(totalNoHedge >= 0 ? "+" : "-") + "$" + Math.abs(totalNoHedge).toFixed(2).padStart(6)}  ${(totalActual >= 0 ? "+" : "-") + "$" + Math.abs(totalActual).toFixed(2).padStart(6)}  ${((totalActual - totalNoHedge) >= 0 ? "+" : "-") + "$" + Math.abs(totalActual - totalNoHedge).toFixed(2).padStart(6)}`
  );

  console.log(`\n========== SUMMARY ==========\n`);
  console.log(`Trades: ${results.length} total (excl. PARIVISION outlier)`);
  console.log(`Known outcomes: ${known.length}  |  ${wins.length} wins  |  ${losses.length} losses  |  win rate: ${((wins.length / known.length) * 100).toFixed(1)}%`);
  if (unknown.length > 0) console.log(`Unknown: ${unknown.length}`);
  console.log("");
  console.log(`NO-HEDGE total P&L:  $${totalNoHedge.toFixed(2)}`);
  console.log(`ACTUAL total P&L:    $${totalActual.toFixed(2)}`);
  console.log(`Hedging ${totalActual >= totalNoHedge ? "gained" : "lost"} you: $${Math.abs(totalActual - totalNoHedge).toFixed(2)}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
