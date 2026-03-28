/**
 * Exchange audit script — compares arb_trades.json against actual Kalshi fills/positions
 * and Polymarket CLOB trades for 2026-03-24.
 */
import dotenv from "dotenv";
dotenv.config();

import { readFileSync } from "fs";
import { join } from "path";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./src/polyAuth.js";
import { fetchAllKalshiFills, getKalshiPositionMap } from "./src/kalshiTrade.js";

const DATA_DIR = join(import.meta.dirname ?? ".", "data");
const TRADES_PATH = join(DATA_DIR, "arb_trades.json");
const TODAY = "2026-03-24";

// ─── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", white: "\x1b[37m",
};

function r2(n: number) { return Math.round(n * 100) / 100; }

// ─── 1. Load today's arb trades ─────────────────────────────────────────────
const allTrades = JSON.parse(readFileSync(TRADES_PATH, "utf8")) as any[];
const todayTrades = allTrades.filter((t: any) => t.ts && t.ts.startsWith(TODAY));

console.log(`\n${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}  EXCHANGE AUDIT — ${TODAY}${C.reset}`);
console.log(`${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`  Recorded trades today: ${C.cyan}${todayTrades.length}${C.reset}\n`);

// Group recorded trades by kalTicker
type RecGroup = {
  trades: any[];
  totalShares: number;
  totalKalCost: number;
  totalKalFees: number;
  totalPmCost: number;
  avgKalFillPrice: number;
  avgPmFillPrice: number;
};
const recByTicker = new Map<string, RecGroup>();
for (const t of todayTrades) {
  const tk = t.kalTicker;
  if (!recByTicker.has(tk)) {
    recByTicker.set(tk, { trades: [], totalShares: 0, totalKalCost: 0, totalKalFees: 0, totalPmCost: 0, avgKalFillPrice: 0, avgPmFillPrice: 0 });
  }
  const g = recByTicker.get(tk)!;
  g.trades.push(t);
  g.totalShares += t.shares ?? 0;
  g.totalKalCost += t.kalCost ?? 0;
  g.totalKalFees += t.kalFees ?? 0;
  g.totalPmCost += t.pmCost ?? 0;
}
for (const [, g] of recByTicker) {
  g.avgKalFillPrice = g.totalShares > 0 ? r2(g.totalKalCost / g.totalShares) : 0;
  g.avgPmFillPrice = g.totalShares > 0 ? r2(g.totalPmCost / g.totalShares) : 0;
}

// ─── 2. Fetch Kalshi fills ──────────────────────────────────────────────────
console.log(`${C.dim}Fetching Kalshi fills...${C.reset}`);
const allKalFills = await fetchAllKalshiFills();
const todayKalFills = allKalFills.filter(f => f.ts.startsWith(TODAY));
console.log(`  Total Kalshi fills (all time): ${allKalFills.length}`);
console.log(`  Kalshi fills today: ${C.cyan}${todayKalFills.length}${C.reset}\n`);

// Group Kalshi fills by ticker
type KalGroup = {
  fills: typeof todayKalFills;
  totalYesBought: number;
  totalNoBought: number;
  totalCost: number;
  totalFees: number;
  avgPrice: number;
};
const kalByTicker = new Map<string, KalGroup>();
for (const f of todayKalFills) {
  if (!kalByTicker.has(f.ticker)) {
    kalByTicker.set(f.ticker, { fills: [], totalYesBought: 0, totalNoBought: 0, totalCost: 0, totalFees: 0, avgPrice: 0 });
  }
  const g = kalByTicker.get(f.ticker)!;
  g.fills.push(f);
  if (f.action === "buy") {
    if (f.side === "yes") {
      g.totalYesBought += f.count;
      g.totalCost += f.count * (f.yesPrice / 100);
    } else {
      g.totalNoBought += f.count;
      g.totalCost += f.count * (f.noPrice / 100);
    }
  }
  g.totalFees += f.feeCost;
}
for (const [, g] of kalByTicker) {
  const total = g.totalYesBought + g.totalNoBought;
  g.avgPrice = total > 0 ? r2(g.totalCost / total) : 0;
}

// ─── 3. Fetch Kalshi positions ──────────────────────────────────────────────
console.log(`${C.dim}Fetching Kalshi positions...${C.reset}`);
const kalPositions = await getKalshiPositionMap();
const nonZeroPositions = [...kalPositions.entries()].filter(([, v]) => v.yesCount > 0 || v.noCount > 0);
console.log(`  Non-zero Kalshi positions: ${C.cyan}${nonZeroPositions.length}${C.reset}\n`);

// ─── 4. Fetch PM CLOB trades ───────────────────────────────────────────────
console.log(`${C.dim}Fetching Polymarket CLOB trades...${C.reset}`);
const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
const funder = process.env.POLY_FUNDER;
const wallet = new Wallet(pk);
const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

const pmAllTrades = (await client.getTrades()) as any[];
// match_time is Unix epoch seconds, not ISO string
const pmTodayTrades = pmAllTrades.filter((t: any) => {
  const mt = Number(t.match_time || 0);
  if (mt > 0) {
    const iso = new Date(mt * 1000).toISOString();
    return iso.startsWith(TODAY);
  }
  const ts = t.created_at || t.timestamp || "";
  return ts.startsWith(TODAY);
});
console.log(`  Total PM CLOB trades (returned): ${pmAllTrades.length}`);
console.log(`  PM CLOB trades today: ${C.cyan}${pmTodayTrades.length}${C.reset}`);
console.log(`  Wallet: ${wallet.address}`);
console.log(`  Funder: ${funder}\n`);

// Group PM trades by asset_id (token ID)
type PmGroup = {
  fills: any[];
  totalBuyShares: number;
  totalBuyCost: number;
  avgBuyPrice: number;
};
const pmByToken = new Map<string, PmGroup>();
const ourAddresses = new Set([wallet.address.toLowerCase(), (funder || "").toLowerCase()].filter(Boolean));

for (const t of pmTodayTrades) {
  if (t.side !== "BUY" || t.status !== "CONFIRMED") continue;
  const tokenId = t.asset_id || "";
  if (!pmByToken.has(tokenId)) {
    pmByToken.set(tokenId, { fills: [], totalBuyShares: 0, totalBuyCost: 0, avgBuyPrice: 0 });
  }
  const g = pmByToken.get(tokenId)!;
  // Check if we are maker or taker to get correct fill size
  let size = Number(t.size);
  if (t.trader_side === "MAKER" && t.maker_orders?.length > 0) {
    let ourSize = 0;
    for (const mo of t.maker_orders) {
      if (ourAddresses.has(mo.maker_address?.toLowerCase())) {
        ourSize += Number(mo.matched_amount);
      }
    }
    if (ourSize > 0) size = ourSize;
  }
  g.fills.push({ ...t, ourSize: size });
  g.totalBuyShares += size;
  g.totalBuyCost += size * Number(t.price);
}
for (const [, g] of pmByToken) {
  g.avgBuyPrice = g.totalBuyShares > 0 ? r2(g.totalBuyCost / g.totalBuyShares) : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── OUTPUT: COMPARISON TABLE ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}  KALSHI FILLS vs RECORDED TRADES${C.reset}`);
console.log(`${C.bold}═══════════════════════════════════════════════════════════════${C.reset}\n`);

// Collect all unique tickers from both sides
const allTickers = new Set([...recByTicker.keys(), ...kalByTicker.keys()]);
const sortedTickers = [...allTickers].sort();

let kalDiscrepancies = 0;
for (const ticker of sortedTickers) {
  const rec = recByTicker.get(ticker);
  const kal = kalByTicker.get(ticker);
  const pos = kalPositions.get(ticker);

  // Only show tickers relevant to today
  const isTodayRec = rec && rec.trades.some((t: any) => t.ts?.startsWith(TODAY));
  const isTodayKal = kal !== undefined;
  if (!isTodayRec && !isTodayKal) continue;

  console.log(`${C.bold}${C.cyan}  ${ticker}${C.reset}`);

  // Recorded data
  if (rec) {
    console.log(`    ${C.dim}RECORDED:${C.reset}  shares=${rec.totalShares}  kalCost=$${r2(rec.totalKalCost)}  kalFees=$${r2(rec.totalKalFees)}  avgPrice=$${rec.avgKalFillPrice}  trades=${rec.trades.length}`);
    for (const t of rec.trades) {
      console.log(`      ${C.dim}${t.id}${C.reset}  sh=${t.shares}  kalCost=$${t.kalCost}  kalFillPrice=$${t.kalFillPrice}  kalFees=$${t.kalFees ?? "?"}  dir=${t.dir}  status=${t.status}  yesFills=${t.kalYesFills ?? "?"}  noFills=${t.kalNoFills ?? "?"}`);
    }
  } else {
    console.log(`    ${C.red}RECORDED:  MISSING — no arb_trades.json entry!${C.reset}`);
  }

  // Exchange data
  if (kal) {
    console.log(`    ${C.dim}EXCHANGE:${C.reset}  yesBought=${kal.totalYesBought}  noBought=${kal.totalNoBought}  cost=$${r2(kal.totalCost)}  fees=$${r2(kal.totalFees)}  avgPrice=$${kal.avgPrice}  fills=${kal.fills.length}`);
    for (const f of kal.fills) {
      console.log(`      ${C.dim}fill${C.reset}  action=${f.action}  side=${f.side}  count=${f.count}  yesP=${f.yesPrice}c  noP=${f.noPrice}c  fee=$${f.feeCost}  ts=${f.ts}`);
    }
  } else {
    console.log(`    ${C.yellow}EXCHANGE:  NO FILLS TODAY — may be from previous day or unfilled${C.reset}`);
  }

  // Position
  if (pos) {
    console.log(`    ${C.dim}POSITION:${C.reset}  yesCount=${pos.yesCount}  noCount=${pos.noCount}  avgPriceCents=${pos.avgPriceCents}`);
  }

  // Compare
  if (rec && kal) {
    const recTotal = rec.totalShares;
    const kalTotal = kal.totalYesBought + kal.totalNoBought;
    const shareMatch = recTotal === kalTotal;
    const costDiff = Math.abs(r2(rec.totalKalCost) - r2(kal.totalCost));
    const feeDiff = Math.abs(r2(rec.totalKalFees) - r2(kal.totalFees));
    const costMatch = costDiff < 0.02;
    const feeMatch = feeDiff < 0.02;

    if (shareMatch && costMatch && feeMatch) {
      console.log(`    ${C.green}✓ MATCH${C.reset}  shares=${recTotal} cost_diff=$${costDiff} fee_diff=$${feeDiff}`);
    } else {
      kalDiscrepancies++;
      console.log(`    ${C.red}${C.bold}✗ DISCREPANCY${C.reset}`);
      if (!shareMatch) console.log(`      ${C.red}Shares: recorded=${recTotal} vs exchange=${kalTotal}${C.reset}`);
      if (!costMatch) console.log(`      ${C.red}Cost: recorded=$${r2(rec.totalKalCost)} vs exchange=$${r2(kal.totalCost)} (diff=$${costDiff})${C.reset}`);
      if (!feeMatch) console.log(`      ${C.red}Fees: recorded=$${r2(rec.totalKalFees)} vs exchange=$${r2(kal.totalFees)} (diff=$${feeDiff})${C.reset}`);
    }
  } else if (rec && !kal) {
    // Recorded but no fills today — could be a carryover from yesterday
    console.log(`    ${C.yellow}⚠ RECORDED BUT NO KALSHI FILLS TODAY${C.reset}`);
  } else if (!rec && kal) {
    kalDiscrepancies++;
    console.log(`    ${C.red}${C.bold}✗ UNRECORDED KALSHI FILLS${C.reset}`);
  }
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}  POLYMARKET CLOB vs RECORDED TRADES${C.reset}`);
console.log(`${C.bold}═══════════════════════════════════════════════════════════════${C.reset}\n`);

// Map recorded trades by pmTokenId
const recByPmToken = new Map<string, RecGroup>();
for (const t of todayTrades) {
  const token = t.pmTokenId || "";
  if (!token) continue;
  if (!recByPmToken.has(token)) {
    recByPmToken.set(token, { trades: [], totalShares: 0, totalKalCost: 0, totalKalFees: 0, totalPmCost: 0, avgKalFillPrice: 0, avgPmFillPrice: 0 });
  }
  const g = recByPmToken.get(token)!;
  g.trades.push(t);
  g.totalShares += t.shares ?? 0;
  g.totalPmCost += t.pmCost ?? 0;
}
for (const [, g] of recByPmToken) {
  g.avgPmFillPrice = g.totalShares > 0 ? r2(g.totalPmCost / g.totalShares) : 0;
}

const allPmTokens = new Set([...recByPmToken.keys(), ...pmByToken.keys()]);
let pmDiscrepancies = 0;

for (const tokenId of allPmTokens) {
  const rec = recByPmToken.get(tokenId);
  const pm = pmByToken.get(tokenId);

  if (!rec && !pm) continue;

  const label = rec?.trades[0]?.match || rec?.trades[0]?.pmSlug || tokenId.slice(0, 20) + "...";
  console.log(`${C.bold}${C.magenta}  ${label}${C.reset}  ${C.dim}token=${tokenId.slice(0, 30)}...${C.reset}`);

  if (rec) {
    console.log(`    ${C.dim}RECORDED:${C.reset}  shares=${rec.totalShares}  pmCost=$${r2(rec.totalPmCost)}  avgPmPrice=$${rec.avgPmFillPrice}`);
    for (const t of rec.trades) {
      console.log(`      ${C.dim}${t.id}${C.reset}  sh=${t.shares}  pmCost=$${t.pmCost}  pmFillPrice=$${t.pmFillPrice}  pmSlug=${t.pmSlug}`);
    }
  } else {
    console.log(`    ${C.red}RECORDED:  MISSING${C.reset}`);
  }

  if (pm) {
    console.log(`    ${C.dim}EXCHANGE:${C.reset}  buyShares=${r2(pm.totalBuyShares)}  buyCost=$${r2(pm.totalBuyCost)}  avgBuyPrice=$${pm.avgBuyPrice}  fills=${pm.fills.length}`);
    for (const f of pm.fills) {
      const mt = Number(f.match_time || 0);
      const tsStr = mt > 0 ? new Date(mt * 1000).toISOString() : (f.created_at || "?");
      console.log(`      ${C.dim}fill${C.reset}  size=${f.ourSize}  price=$${f.price}  side=${f.side}  trader_side=${f.trader_side || "?"}  ts=${tsStr}`);
    }
  } else {
    console.log(`    ${C.yellow}EXCHANGE:  NO PM FILLS TODAY${C.reset}`);
  }

  // Compare
  if (rec && pm) {
    const shareMatch = Math.abs(rec.totalShares - pm.totalBuyShares) < 0.5;
    const costDiff = Math.abs(r2(rec.totalPmCost) - r2(pm.totalBuyCost));
    const costMatch = costDiff < 0.02;

    if (shareMatch && costMatch) {
      console.log(`    ${C.green}✓ MATCH${C.reset}  shares_diff=${Math.abs(rec.totalShares - pm.totalBuyShares)} cost_diff=$${costDiff}`);
    } else {
      pmDiscrepancies++;
      console.log(`    ${C.red}${C.bold}✗ DISCREPANCY${C.reset}`);
      if (!shareMatch) console.log(`      ${C.red}Shares: recorded=${rec.totalShares} vs exchange=${r2(pm.totalBuyShares)}${C.reset}`);
      if (!costMatch) console.log(`      ${C.red}Cost: recorded=$${r2(rec.totalPmCost)} vs exchange=$${r2(pm.totalBuyCost)} (diff=$${costDiff})${C.reset}`);
    }
  } else if (rec && !pm) {
    console.log(`    ${C.yellow}⚠ RECORDED BUT NO PM FILLS TODAY${C.reset}`);
  } else if (!rec && pm) {
    pmDiscrepancies++;
    console.log(`    ${C.red}${C.bold}✗ UNRECORDED PM FILLS${C.reset}`);
  }
  console.log("");
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── SUMMARY ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`${C.bold}  SUMMARY${C.reset}`);
console.log(`${C.bold}═══════════════════════════════════════════════════════════════${C.reset}`);
console.log(`  Recorded trades today:     ${todayTrades.length}`);
console.log(`  Unique Kalshi tickers:     ${recByTicker.size} recorded / ${kalByTicker.size} on exchange`);
console.log(`  Unique PM tokens:          ${recByPmToken.size} recorded / ${pmByToken.size} on exchange`);
console.log(`  Kalshi fills today:        ${todayKalFills.length}`);
console.log(`  PM CLOB fills today:       ${pmTodayTrades.filter((t: any) => t.side === "BUY" && t.status === "CONFIRMED").length}`);
console.log(`  Non-zero Kalshi positions: ${nonZeroPositions.length}`);
console.log(`  ${C.bold}Kalshi discrepancies:    ${kalDiscrepancies > 0 ? C.red : C.green}${kalDiscrepancies}${C.reset}`);
console.log(`  ${C.bold}PM discrepancies:        ${pmDiscrepancies > 0 ? C.red : C.green}${pmDiscrepancies}${C.reset}`);

// Show non-zero positions that might be open
if (nonZeroPositions.length > 0) {
  console.log(`\n${C.bold}  OPEN KALSHI POSITIONS:${C.reset}`);
  for (const [ticker, pos] of nonZeroPositions) {
    const inTrades = recByTicker.has(ticker);
    const flag = inTrades ? "" : ` ${C.red}(NOT in arb_trades)${C.reset}`;
    console.log(`    ${ticker}: YES=${pos.yesCount} NO=${pos.noCount} avgCents=${pos.avgPriceCents}${flag}`);
  }
}

console.log(`\n${C.bold}═══════════════════════════════════════════════════════════════${C.reset}\n`);
