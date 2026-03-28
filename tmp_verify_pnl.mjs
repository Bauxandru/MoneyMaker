import { readFileSync } from 'fs';
const t = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
let pnl = 0, wins = 0, losses = 0;
for (const x of t) {
  if (x.realizedPnl != null) {
    pnl += x.realizedPnl;
    if (x.realizedPnl > 0) wins++;
    else if (x.realizedPnl < 0) losses++;
  }
}
console.log(`Trades: ${t.length}, P&L: $${pnl.toFixed(2)}, Wins: ${wins}, Losses: ${losses}`);
const mglz = t.filter(x => x.kalTicker && x.kalTicker.includes('MGLZMOUZ'));
console.log(`Mongolz records: ${mglz.length}`, mglz.map(x => `${x.id} ${x.shares}sh`));

// Check for any other duplicates (same kalTicker, different records)
const tickerCounts = {};
for (const x of t) {
  if (x.kalTicker) tickerCounts[x.kalTicker] = (tickerCounts[x.kalTicker] || 0) + 1;
}
const dupes = Object.entries(tickerCounts).filter(([k,v]) => v > 1);
if (dupes.length > 0) {
  console.log(`\nDuplicate tickers: ${dupes.length}`);
  for (const [ticker, count] of dupes) {
    const records = t.filter(x => x.kalTicker === ticker);
    console.log(`  ${ticker}: ${count} records`);
    for (const r of records) console.log(`    ${r.id} ${r.shares}sh ${r.match} ${r.status}`);
  }
} else {
  console.log('\nNo duplicate tickers found.');
}
