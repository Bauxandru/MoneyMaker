import { readFileSync } from "fs";
const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
const hc = trades.filter((t: any) => t.resolutionMethod === "hedge-complete");

const bothFilled = hc.filter((t: any) => (t.pmCost > 0 || t.pmFillPrice > 0) && (t.kalCost > 0 || t.kalFillPrice > 0));
const oneLeg = hc.filter((t: any) => {
  const hasPm = t.pmCost > 0 || t.pmFillPrice > 0;
  const hasKal = t.kalCost > 0 || t.kalFillPrice > 0;
  return !(hasPm && hasKal);
});

let bfPnl = 0, olPnl = 0;
bothFilled.forEach((t: any) => bfPnl += (t.realizedPnl || 0));
oneLeg.forEach((t: any) => olPnl += (t.realizedPnl || 0));

console.log("=== HEDGE-COMPLETE: BOTH LEGS FILLED ===");
console.log(`Count: ${bothFilled.length}, P&L: $${bfPnl.toFixed(2)}\n`);
bothFilled.forEach((t: any) => {
  console.log(`  $${(t.realizedPnl || 0).toFixed(2).padStart(7)} | ${t.match.slice(0, 30).padEnd(30)} kal=$${t.kalCost.toFixed(2)} pm=$${t.pmCost.toFixed(2)} total=$${t.totalCost.toFixed(2)} shares=${t.shares}`);
});

console.log(`\n=== HEDGE-COMPLETE: ONE LEG MISSING ===`);
console.log(`Count: ${oneLeg.length}, P&L: $${olPnl.toFixed(2)}\n`);
oneLeg.forEach((t: any) => {
  const missing = (t.pmCost === 0 && t.pmFillPrice === 0) ? "PM missing" : "KAL missing";
  console.log(`  $${(t.realizedPnl || 0).toFixed(2).padStart(7)} | ${t.match.slice(0, 30).padEnd(30)} ${missing} kal=$${t.kalCost.toFixed(2)} pm=$${t.pmCost.toFixed(2)}`);
});
