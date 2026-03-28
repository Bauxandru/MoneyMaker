import { readFileSync } from 'fs';

const trades = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));

// Build a set of REAL exec IDs (orderMs > 50)
const realMetrics = new Set();
const fakeMetrics = new Set();
for (const m of metrics) {
  if (m.outcome !== 'both-filled' && m.outcome !== 'hedge-entry') continue;
  const real = m.firstLegOrderMs > 50 || m.secondLegOrderMs > 50;
  if (real) realMetrics.add(m.ts.slice(0, 19)); // truncate to seconds
  else fakeMetrics.add(m.ts.slice(0, 19));
}

console.log('=== ALL TRADES — cross-referenced with execution metrics ===\n');
let phantomCount = 0;
for (const t of trades) {
  const tradeTs = t.ts.slice(0, 19);
  // Find closest metric within 5 seconds
  let matchedReal = false;
  let matchedFake = false;
  for (const rts of realMetrics) {
    if (Math.abs(new Date(tradeTs).getTime() - new Date(rts).getTime()) < 5000) matchedReal = true;
  }
  for (const fts of fakeMetrics) {
    if (Math.abs(new Date(tradeTs).getTime() - new Date(fts).getTime()) < 5000) matchedFake = true;
  }

  let verdict = 'NO METRIC';
  if (matchedReal && !matchedFake) verdict = 'REAL';
  else if (matchedFake && !matchedReal) verdict = 'PHANTOM';
  else if (matchedReal && matchedFake) verdict = 'REAL+FAKE';  // both instances tried
  else verdict = 'NO METRIC FOUND';

  if (verdict === 'PHANTOM') phantomCount++;

  const flag = verdict === 'PHANTOM' ? ' *** DELETE ***' : '';
  console.log(`${t.ts.slice(0,19)} | ${t.match.slice(0,35).padEnd(35)} | ${t.shares}sh | ${verdict}${flag}`);
}
console.log(`\nTotal trades: ${trades.length}, Phantoms: ${phantomCount}`);
