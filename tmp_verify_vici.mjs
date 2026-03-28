import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";

// Check 1: What is DRY_RUN set to?
console.log("=== ENV CHECK ===");
console.log("DRY_RUN env:", process.env.DRY_RUN);
console.log("DRY_RUN parsed:", process.env.DRY_RUN === "false" ? false : true);
console.log("");

// Check 2: Look at the trade record
const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
const vici = trades.filter(t => t.match && t.match.includes("Vici"));
console.log("=== VICI TRADE RECORDS ===");
for (const t of vici) {
  console.log(JSON.stringify(t, null, 2));
}
console.log("");

// Check 3: Look at ALL today's trades (Mar 8)
const today = trades.filter(t => t.ts >= "2026-03-08");
console.log(`=== ALL MAR 8 TRADES (${today.length}) ===`);
for (const t of today) {
  console.log(`  ${t.id} | ${t.match} | dir=${t.dir} | shares=${t.shares} | status=${t.status} | pnl=${t.realizedPnl}`);
  console.log(`    kalTicker=${t.kalTicker} kalFP=${t.kalFillPrice} kalCost=${t.kalCost}`);
  console.log(`    pmSlug=${t.pmSlug} pmFP=${t.pmFillPrice} pmCost=${t.pmCost}`);
}
console.log("");

// Check 4: Look at execution metrics around the trade time
const metrics = JSON.parse(readFileSync("data/execution_metrics.json", "utf8"));
const viciMetrics = metrics.filter(m => m.match && m.match.includes("Vici") && m.outcome === "both-filled");
console.log("=== VICI 'both-filled' METRICS ===");
for (const m of viciMetrics) {
  console.log(JSON.stringify(m, null, 2));
}
