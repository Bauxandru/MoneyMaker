import dotenv from "dotenv";
dotenv.config();
import { readFileSync, writeFileSync, copyFileSync } from "fs";
import { fetchAllKalshiFills } from "./src/kalshiTrade.js";

async function main() {
  const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
  console.log(`Total trades before: ${trades.length}`);

  console.log("Fetching Kalshi fills...");
  const kalFills = await fetchAllKalshiFills();
  const tickersWithFills = new Set(kalFills.map(f => f.ticker));

  // Keep only trades from Mar 4+ that have real Kalshi fills (or are backfills)
  const kept = trades.filter((t: any) => {
    // Remove anything before Mar 4
    if (t.ts < "2026-03-04") return false;
    // Keep backfills
    if (t.id.startsWith("backfill-")) return true;
    // Keep only if Kalshi ticker has real fills
    return tickersWithFills.has(t.kalTicker);
  });

  const removed = trades.length - kept.length;
  console.log(`Keeping: ${kept.length}`);
  console.log(`Removing: ${removed}`);

  // Backup
  copyFileSync("data/arb_trades.json", "data/arb_trades.backup_preclean.json");
  console.log("Backup: data/arb_trades.backup_preclean.json");

  // Write
  writeFileSync("data/arb_trades.json", JSON.stringify(kept, null, 2), "utf8");
  console.log("Done. arb_trades.json updated.");

  // Summary
  const pnl = kept.reduce((s: number, t: any) => s + (t.realizedPnl || 0), 0);
  console.log(`\nRemaining trades: ${kept.length}, P&L: $${pnl.toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
