import dotenv from "dotenv";
dotenv.config();
import { readFileSync, writeFileSync } from "fs";
import { fetchAllKalshiFills } from "./src/kalshiTrade.js";

interface ArbTrade {
  id: string;
  ts: string;
  match: string;
  dir: string;
  shares: number;
  kalTicker: string;
  kalFillPrice: number;
  kalCost: number;
  pmOutcome: string;
  pmSlug: string;
  pmTokenId?: string;
  pmFillPrice: number;
  pmCost: number;
  totalCost: number;
  status: string;
  resolutionMethod?: string;
  realizedPnl?: number;
  [key: string]: any;
}

async function main() {
  const trades: ArbTrade[] = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
  console.log(`Total trades in arb_trades.json: ${trades.length}\n`);

  console.log("Fetching Kalshi fills...");
  const kalFills = await fetchAllKalshiFills();
  console.log(`Got ${kalFills.length} Kalshi fills\n`);

  // Build set of all Kalshi tickers that have real fills
  const tickersWithFills = new Set<string>();
  const fillsByTicker = new Map<string, { totalContracts: number; fills: number }>();
  for (const f of kalFills) {
    tickersWithFills.add(f.ticker);
    const entry = fillsByTicker.get(f.ticker) || { totalContracts: 0, fills: 0 };
    entry.totalContracts += f.count;
    entry.fills++;
    fillsByTicker.set(f.ticker, entry);
  }

  // Check each trade
  const real: ArbTrade[] = [];
  const fake: ArbTrade[] = [];
  const uncertain: ArbTrade[] = [];

  for (const t of trades) {
    const hasFill = tickersWithFills.has(t.kalTicker);
    // Backfill trades (from repair script) are real by definition
    const isBackfill = t.id.startsWith("backfill-");

    if (hasFill || isBackfill) {
      real.push(t);
    } else {
      fake.push(t);
    }
  }

  console.log(`=== RESULTS ===`);
  console.log(`Real (have Kalshi fills or are backfills): ${real.length}`);
  console.log(`Fake (no Kalshi fills found): ${fake.length}\n`);

  // Show all fake trades
  if (fake.length > 0) {
    console.log(`=== FAKE TRADES (no exchange fills) ===\n`);
    for (const t of fake) {
      console.log(`  ${t.id} | ${t.ts} | ${t.match} | ${t.kalTicker}`);
      console.log(`    status=${t.status} method=${t.resolutionMethod || '--'} shares=${t.shares} cost=$${t.totalCost.toFixed(2)} pnl=$${t.realizedPnl ?? '?'}`);
    }
  }

  // Show date breakdown
  console.log(`\n=== BY DATE ===`);
  const byDate = new Map<string, { real: number; fake: number }>();
  for (const t of real) {
    const date = t.ts.slice(0, 10);
    const entry = byDate.get(date) || { real: 0, fake: 0 };
    entry.real++;
    byDate.set(date, entry);
  }
  for (const t of fake) {
    const date = t.ts.slice(0, 10);
    const entry = byDate.get(date) || { real: 0, fake: 0 };
    entry.fake++;
    byDate.set(date, entry);
  }
  for (const [date, counts] of [...byDate.entries()].sort()) {
    const flag = counts.fake > 0 ? ` *** ${counts.fake} FAKE ***` : '';
    console.log(`  ${date}: ${counts.real} real, ${counts.fake} fake${flag}`);
  }

  // Summary
  const fakePnl = fake.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  const realPnl = real.reduce((s, t) => s + (t.realizedPnl || 0), 0);
  console.log(`\nReal P&L total: $${realPnl.toFixed(2)}`);
  console.log(`Fake P&L total: $${fakePnl.toFixed(2)} (inflating dashboard)`);
  console.log(`\nTo clean: remove ${fake.length} fake trades`);
}

main().catch(e => { console.error(e); process.exit(1); });
