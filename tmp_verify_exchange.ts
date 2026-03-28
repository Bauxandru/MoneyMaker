import dotenv from "dotenv";
dotenv.config();
import { fetchAllKalshiFills } from "./src/kalshiTrade.js";

async function main() {
  console.log("Fetching Kalshi fills...");
  const fills = await fetchAllKalshiFills();
  console.log(`Got ${fills.length} fills\n`);

  // Check FaZe vs Monte ticker
  const fazeFills = fills.filter(f => f.ticker === "KXCS2MAP-26MAR08MNTEFAZE-1-MNTE");
  console.log("=== KXCS2MAP-26MAR08MNTEFAZE-1-MNTE (FaZe vs Monte) ===");
  console.log(`Total fills: ${fazeFills.length}`);
  let fazeTotal = 0;
  for (const f of fazeFills) {
    fazeTotal += f.count;
    console.log(`  ${f.ts} | ${f.action} ${f.side} ${f.count}@${f.yesPrice}c | taker=${f.isTaker} | fee=$${f.feeCost}`);
  }
  console.log(`Total contracts: ${fazeTotal}\n`);

  // Check Aurora vs paiN
  const auroraFills = fills.filter(f => f.ticker === "KXCS2MAP-26MAR08AURPAIN-1-PAIN");
  console.log("=== KXCS2MAP-26MAR08AURPAIN-1-PAIN (Aurora vs paiN) ===");
  console.log(`Total fills: ${auroraFills.length}`);
  let auroraTotal = 0;
  for (const f of auroraFills) {
    auroraTotal += f.count;
    console.log(`  ${f.ts} | ${f.action} ${f.side} ${f.count}@${f.yesPrice}c | taker=${f.isTaker} | fee=$${f.feeCost}`);
  }
  console.log(`Total contracts: ${auroraTotal}\n`);

  // Check MOUZ vs Yandex
  const mouzFills = fills.filter(f => f.ticker === "KXDOTA2GAME-26MAR08MOUZTY-TY");
  console.log("=== KXDOTA2GAME-26MAR08MOUZTY-TY (MOUZ vs Yandex) ===");
  console.log(`Total fills: ${mouzFills.length}`);
  let mouzTotal = 0;
  for (const f of mouzFills) {
    mouzTotal += f.count;
    console.log(`  ${f.ts} | ${f.action} ${f.side} ${f.count}@${f.yesPrice}c | taker=${f.isTaker} | fee=$${f.feeCost}`);
  }
  console.log(`Total contracts: ${mouzTotal}\n`);

  // Check ALL today's tickers
  console.log("=== ALL FILLS TODAY (Mar 8) ===");
  const todayFills = fills.filter(f => f.ts && f.ts.startsWith("2026-03-08"));
  const byTicker = new Map<string, { count: number; fills: number }>();
  for (const f of todayFills) {
    const entry = byTicker.get(f.ticker) || { count: 0, fills: 0 };
    entry.count += f.count;
    entry.fills++;
    byTicker.set(f.ticker, entry);
  }
  for (const [ticker, data] of [...byTicker.entries()].sort((a,b) => b[1].count - a[1].count)) {
    console.log(`  ${ticker}: ${data.count} contracts (${data.fills} fills)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
