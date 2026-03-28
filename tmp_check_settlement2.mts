import { fetchAllKalshiSettlements } from './src/kalshiTrade.js';
const settlements = await fetchAllKalshiSettlements();

const results = new Map<string, number>();
for (const s of settlements) {
  results.set(s.marketResult, (results.get(s.marketResult) || 0) + 1);
}
console.log('All marketResult values:');
for (const [k, v] of results) console.log('  ' + k + ': ' + v);

const scalars = settlements.filter(s => s.marketResult === 'scalar');
console.log('\nScalar settlements (' + scalars.length + '):');
for (const s of scalars) {
  const isRefund = s.revenue > 0 && Math.abs(s.revenue - s.yesCost - s.noCost) < 10;
  console.log('  ' + s.ticker + ' rev=' + s.revenue + ' yesCost=' + s.yesCost + ' noCost=' + s.noCost + (isRefund ? ' ← REFUND' : ''));
}

// Show a few yes/no for comparison
const yes = settlements.filter(s => s.marketResult === 'yes').slice(0, 3);
console.log('\nSample YES results:');
for (const s of yes) console.log('  ' + s.ticker + ' rev=' + s.revenue + ' yesCost=' + s.yesCost + ' noCost=' + s.noCost);

const no = settlements.filter(s => s.marketResult === 'no').slice(0, 3);
console.log('Sample NO results:');
for (const s of no) console.log('  ' + s.ticker + ' rev=' + s.revenue + ' yesCost=' + s.yesCost + ' noCost=' + s.noCost);

process.exit(0);
