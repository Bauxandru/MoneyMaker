import 'dotenv/config';
import { fetchAllKalshiFills } from './src/kalshiTrade.js';

// Find all tickers where bot bought BOTH yes and no (pair redemption issue)
const fills = await fetchAllKalshiFills();
const tickerSides = new Map<string, { yesBuys: number; noBuys: number; yesCost: number; noCost: number }>();

for (const f of fills) {
  if (f.action !== 'buy') continue;
  if (!tickerSides.has(f.ticker)) tickerSides.set(f.ticker, { yesBuys: 0, noBuys: 0, yesCost: 0, noCost: 0 });
  const e = tickerSides.get(f.ticker)!;
  const price = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100;
  if (f.side === 'yes') { e.yesBuys += f.count; e.yesCost += f.count * price; }
  else { e.noBuys += f.count; e.noCost += f.count * price; }
}

console.log('Tickers with BOTH yes and no buys:');
for (const [ticker, e] of tickerSides) {
  if (e.yesBuys > 0 && e.noBuys > 0) {
    const pairs = Math.min(e.yesBuys, e.noBuys);
    console.log(`  ${ticker}: ${e.yesBuys} YES ($${e.yesCost.toFixed(2)}) + ${e.noBuys} NO ($${e.noCost.toFixed(2)}) → ${pairs} pairs = $${pairs.toFixed(2)} redemption`);
  }
}

process.exit(0);
