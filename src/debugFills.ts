/**
 * debugFills.ts — Dump all Kalshi fills and check which arb_trades tickers have no matching fills.
 * Usage: npx tsx src/debugFills.ts
 */
import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import { fetchAllKalshiFills } from "./kalshiTrade.js";

const fills = await fetchAllKalshiFills();
console.log(`Total fills: ${fills.length}`);

// Show unique tickers from fills
const fillTickers = new Set(fills.filter(f => f.action === "buy").map(f => f.ticker));
console.log(`\nUnique buy-fill tickers: ${fillTickers.size}`);

// Load arb trades and find ones with kalCost=0
const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
const zeroCostTrades = trades.filter((t: any) => t.kalCost === 0 && t.kalTicker);

console.log(`\nTrades with kalCost=0: ${zeroCostTrades.length}`);
for (const t of zeroCostTrades) {
  const hasFill = fillTickers.has(t.kalTicker);
  console.log(`  ${t.kalTicker} (${t.match} dir=${t.dir}) → fills found: ${hasFill}`);
  if (!hasFill) {
    // Check if any fill ticker partially matches
    const partial = [...fillTickers].filter(ft => {
      const base = t.kalTicker.replace(/-\d+-/, "-").replace(/-[A-Z]+$/, "");
      return ft.includes(base.split("-").slice(0, 2).join("-"));
    });
    if (partial.length > 0) console.log(`    Partial matches: ${partial.join(", ")}`);
  }
}

// Also show all fills for ASTHERO as example
console.log(`\nAll fills containing "ASTHERO":`);
for (const f of fills) {
  if (f.ticker.includes("ASTHERO")) {
    console.log(`  ${f.ticker} action=${f.action} side=${f.side} count=${f.count} yesPrice=${f.yesPrice} noPrice=${f.noPrice}`);
  }
}
