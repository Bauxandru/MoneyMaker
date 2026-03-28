import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('data/arb_trades.json','utf8'));

// Get all today's trades (Mar 8)
const today = data.filter(t => t.ts && t.ts.startsWith('2026-03-08'));
console.log('Today (Mar 8) trades:', today.length);

// Group by match
const byMatch = {};
for (const t of today) {
  if (!byMatch[t.match]) byMatch[t.match] = [];
  byMatch[t.match].push(t);
}

console.log('\n=== TODAY TRADES BY MATCH ===\n');
for (const [match, trades] of Object.entries(byMatch).sort((a,b) => b[1].length - a[1].length)) {
  if (trades.length > 1) {
    console.log(`${match}: ${trades.length} trades`);
    let totalShares = 0, totalCost = 0, totalPnl = 0;
    for (const t of trades) {
      totalShares += t.shares;
      totalCost += t.totalCost;
      totalPnl += (t.realizedPnl || 0);
      const gap = trades.indexOf(t) > 0 ?
        (new Date(t.ts).getTime() - new Date(trades[trades.indexOf(t)-1].ts).getTime()) + 'ms gap' : '';
      console.log(`  ${t.id} | ${t.shares}sh | $${t.totalCost} | kal=${t.kalTicker} | dir=${t.dir} | pnl=$${t.realizedPnl || '?'} | ${gap}`);
    }
    console.log(`  TOTAL: ${totalShares} shares, $${totalCost.toFixed(2)} cost, $${totalPnl.toFixed(2)} pnl`);
    console.log('');
  }
}

// Check: are they all the same kalTicker + same dir, or different?
console.log('\n=== FAZE vs MONTE DETAIL ===');
const faze = data.filter(t => t.match.includes('FaZe') && t.match.includes('Monte'));
for (const t of faze) {
  console.log(JSON.stringify({
    id: t.id,
    ts: t.ts,
    dir: t.dir,
    kalTicker: t.kalTicker,
    kalFillPrice: t.kalFillPrice,
    kalCost: t.kalCost,
    pmOutcome: t.pmOutcome,
    pmFillPrice: t.pmFillPrice,
    pmCost: t.pmCost,
    totalCost: t.totalCost,
    shares: t.shares,
    status: t.status,
    resolutionMethod: t.resolutionMethod,
    realizedPnl: t.realizedPnl,
    initialExchange: t.initialExchange,
  }, null, 2));
  console.log('');
}

console.log('\n=== AURORA vs PAIN DETAIL ===');
const aurora = data.filter(t => t.match.includes('Aurora') && t.match.includes('paiN'));
for (const t of aurora) {
  console.log(JSON.stringify({
    id: t.id,
    ts: t.ts,
    dir: t.dir,
    kalTicker: t.kalTicker,
    kalFillPrice: t.kalFillPrice,
    kalCost: t.kalCost,
    pmOutcome: t.pmOutcome,
    pmFillPrice: t.pmFillPrice,
    pmCost: t.pmCost,
    totalCost: t.totalCost,
    shares: t.shares,
    realizedPnl: t.realizedPnl,
  }, null, 2));
  console.log('');
}
