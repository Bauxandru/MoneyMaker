import dotenv from "dotenv";
dotenv.config();

import { fetchAllKalshiFills } from "./src/kalshiTrade.js";

const TARGET_DATE = "2026-03-24";

async function main() {
  console.log(`Fetching all Kalshi fills...`);
  const allFills = await fetchAllKalshiFills();
  console.log(`Total fills returned by API: ${allFills.length}`);

  // Filter to today only
  const todayFills = allFills.filter(f => f.ts.startsWith(TARGET_DATE));
  console.log(`Fills on ${TARGET_DATE}: ${todayFills.length}\n`);

  if (todayFills.length === 0) {
    console.log("No fills found for today.");
    return;
  }

  // Group by ticker
  const byTicker = new Map<string, typeof todayFills>();
  for (const f of todayFills) {
    const arr = byTicker.get(f.ticker) ?? [];
    arr.push(f);
    byTicker.set(f.ticker, arr);
  }

  // Sort tickers alphabetically
  const sortedTickers = [...byTicker.keys()].sort();

  for (const ticker of sortedTickers) {
    const fills = byTicker.get(ticker)!;
    let totalYesBought = 0;
    let totalNoBought = 0;
    let totalCostCents = 0;
    let totalFees = 0;

    for (const f of fills) {
      if (f.action === "buy" && f.side === "yes") {
        totalYesBought += f.count;
        totalCostCents += f.yesPrice * f.count;
      } else if (f.action === "buy" && f.side === "no") {
        totalNoBought += f.count;
        totalCostCents += f.noPrice * f.count;
      } else if (f.action === "sell" && f.side === "yes") {
        // selling yes = effectively buying no exposure; cost is negative (proceeds)
        totalCostCents -= f.yesPrice * f.count;
      } else if (f.action === "sell" && f.side === "no") {
        totalCostCents -= f.noPrice * f.count;
      }
      totalFees += f.feeCost;
    }

    console.log("=".repeat(80));
    console.log(`TICKER: ${ticker}`);
    console.log(`  Total YES bought: ${totalYesBought}`);
    console.log(`  Total NO bought:  ${totalNoBought}`);
    console.log(`  Total cost:       $${(totalCostCents / 100).toFixed(2)} (net of sells)`);
    console.log(`  Total fees:       $${totalFees.toFixed(4)}`);
    console.log(`  Fills (${fills.length}):`);
    for (const f of fills) {
      console.log(`    - ${f.ts} | action=${f.action} side=${f.side} count=${f.count} yesPrice=${f.yesPrice}c noPrice=${f.noPrice}c fee=$${f.feeCost}`);
    }
    console.log();
  }

  // Grand totals
  let grandYes = 0, grandNo = 0, grandCostCents = 0, grandFees = 0;
  for (const f of todayFills) {
    if (f.action === "buy" && f.side === "yes") { grandYes += f.count; grandCostCents += f.yesPrice * f.count; }
    else if (f.action === "buy" && f.side === "no") { grandNo += f.count; grandCostCents += f.noPrice * f.count; }
    else if (f.action === "sell" && f.side === "yes") { grandCostCents -= f.yesPrice * f.count; }
    else if (f.action === "sell" && f.side === "no") { grandCostCents -= f.noPrice * f.count; }
    grandFees += f.feeCost;
  }
  console.log("=".repeat(80));
  console.log("GRAND TOTALS:");
  console.log(`  Tickers traded:   ${sortedTickers.length}`);
  console.log(`  Total YES bought: ${grandYes}`);
  console.log(`  Total NO bought:  ${grandNo}`);
  console.log(`  Total cost:       $${(grandCostCents / 100).toFixed(2)}`);
  console.log(`  Total fees:       $${grandFees.toFixed(4)}`);
  console.log(`  Total fills:      ${todayFills.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
