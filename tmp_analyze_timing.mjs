import { readFileSync } from 'fs';

const metrics = JSON.parse(readFileSync('data/execution_metrics.json', 'utf8'));
const trades = JSON.parse(readFileSync('data/arb_trades.json', 'utf8'));

console.log(`Total exec metrics: ${metrics.length}`);
const outcomes = {};
for (const m of metrics) { outcomes[m.outcome] = (outcomes[m.outcome] || 0) + 1; }
console.log('Outcomes:', JSON.stringify(outcomes, null, 2));
console.log('');

// Show sample of a filled metric
const filled = metrics.filter(m => m.outcome === 'both-filled' || m.outcome === 'filled' || m.outcome === 'both-legs');
const partial = metrics.filter(m => m.outcome === 'hedge-entry' || m.outcome === 'partial-unhedged');
console.log(`Filled/both-legs: ${filled.length}, Partial-unhedged: ${partial.length}`);

if (filled.length > 0) {
  console.log('\nSample filled metric:');
  console.log(JSON.stringify(filled[0], null, 2));
}

// === DETAILED TIMING ANALYSIS ===
const allSuccessful = [...filled, ...partial];
console.log(`\n========================================`);
console.log(`=== EXECUTION TIMING: ${allSuccessful.length} successful trades ===`);
console.log(`========================================\n`);

// First leg analysis
const pmFirstTrades = allSuccessful.filter(m => m.firstLeg === 'pm');
const kalFirstTrades = allSuccessful.filter(m => m.firstLeg === 'kal');
console.log(`Execution order: PM first=${pmFirstTrades.length}, KAL first=${kalFirstTrades.length}\n`);

// Timing breakdown
const stats = (arr, label) => {
  if (arr.length === 0) { console.log(`${label}: no data`); return; }
  const s = [...arr].sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  const med = s[Math.floor(s.length / 2)];
  const p10 = s[Math.floor(s.length * 0.1)];
  const p90 = s[Math.floor(s.length * 0.9)];
  console.log(`${label} (${s.length} samples):`);
  console.log(`  avg=${avg.toFixed(0)}ms  median=${med}ms  p10=${p10}ms  p90=${p90}ms  min=${s[0]}ms  max=${s[s.length - 1]}ms`);
};

// Total execution time
stats(allSuccessful.map(m => m.totalMs).filter(v => v > 0), 'Total execution time');
console.log('');

// First leg order placement time
stats(allSuccessful.map(m => m.firstLegOrderMs).filter(v => v > 0), 'First leg ORDER placement');
// First leg confirm time
stats(allSuccessful.map(m => m.firstLegConfirmMs).filter(v => v > 0), 'First leg CONFIRM/poll');
// Second leg order time
stats(allSuccessful.map(m => m.secondLegOrderMs).filter(v => v > 0), 'Second leg ORDER placement');
// Second leg confirm time
stats(allSuccessful.map(m => m.secondLegConfirmMs).filter(v => v > 0), 'Second leg CONFIRM/verify');
// Book fetch time
stats(allSuccessful.map(m => m.bookFetchMs).filter(v => v > 0), 'Kalshi book fetch (between legs)');

console.log('\n');

// === PER-EXCHANGE BREAKDOWN ===
console.log('=== PER-EXCHANGE ORDER LATENCY ===\n');

// When PM is first
const pmOrderMs_whenFirst = pmFirstTrades.map(m => m.firstLegOrderMs).filter(v => v > 0);
const pmConfirmMs_whenFirst = pmFirstTrades.map(m => m.firstLegConfirmMs).filter(v => v > 0);
const kalOrderMs_whenSecond = pmFirstTrades.map(m => m.secondLegOrderMs).filter(v => v > 0);
const kalConfirmMs_whenSecond = pmFirstTrades.map(m => m.secondLegConfirmMs).filter(v => v > 0);

console.log('--- When PM goes FIRST (PM → KAL) ---');
stats(pmOrderMs_whenFirst, '  PM order placement');
stats(pmConfirmMs_whenFirst, '  PM fill confirm/poll');
stats(pmFirstTrades.map(m => m.bookFetchMs).filter(v => v > 0), '  KAL book fetch');
stats(kalOrderMs_whenSecond, '  KAL order placement');
stats(kalConfirmMs_whenSecond, '  KAL fill confirm');
console.log('');

// When KAL is first
const kalOrderMs_whenFirst = kalFirstTrades.map(m => m.firstLegOrderMs).filter(v => v > 0);
const kalConfirmMs_whenFirst = kalFirstTrades.map(m => m.firstLegConfirmMs).filter(v => v > 0);
const pmOrderMs_whenSecond = kalFirstTrades.map(m => m.secondLegOrderMs).filter(v => v > 0);
const pmConfirmMs_whenSecond = kalFirstTrades.map(m => m.secondLegConfirmMs).filter(v => v > 0);

console.log('--- When KAL goes FIRST (KAL → PM) ---');
stats(kalOrderMs_whenFirst, '  KAL order placement');
stats(kalConfirmMs_whenFirst, '  KAL fill confirm');
stats(kalFirstTrades.map(m => m.bookFetchMs).filter(v => v > 0), '  KAL book fetch');
stats(pmOrderMs_whenSecond, '  PM order placement');
stats(pmConfirmMs_whenSecond, '  PM fill confirm');
console.log('');

// === INDIVIDUAL TRADE TABLE ===
console.log('=== INDIVIDUAL TRADES (sorted by total time) ===\n');
const sorted = allSuccessful
  .filter(m => m.totalMs > 0)
  .sort((a, b) => a.totalMs - b.totalMs);

console.log('Match'.padEnd(40) + ' | Order | Total  | 1st Order | 1st Fill | Book  | 2nd Order | 2nd Fill | Edge');
console.log('-'.repeat(140));

for (const m of sorted) {
  const match = (m.match || '?').padEnd(40).slice(0, 40);
  const order = (m.firstLeg === 'pm' ? 'PM→KAL' : 'KAL→PM').padEnd(6);
  const total = `${m.totalMs}ms`.padStart(7);
  const f1o = m.firstLegOrderMs > 0 ? `${m.firstLegOrderMs}ms`.padStart(9) : '    -    ';
  const f1c = m.firstLegConfirmMs > 0 ? `${m.firstLegConfirmMs}ms`.padStart(8) : '   -    ';
  const bk = m.bookFetchMs > 0 ? `${m.bookFetchMs}ms`.padStart(6) : '  -   ';
  const f2o = m.secondLegOrderMs > 0 ? `${m.secondLegOrderMs}ms`.padStart(9) : '    -    ';
  const f2c = m.secondLegConfirmMs > 0 ? `${m.secondLegConfirmMs}ms`.padStart(8) : '   -    ';
  const edge = m.edge ? `${(m.edge * 100).toFixed(1)}%`.padStart(5) : '  ?  ';

  console.log(`${match} | ${order} | ${total} | ${f1o} | ${f1c} | ${bk} | ${f2o} | ${f2c} | ${edge}`);
}

// === OUTLIER INVESTIGATION (8-10s gap trades) ===
console.log('\n=== SLOW TRADES (total > 5000ms) ===\n');
const slow = sorted.filter(m => m.totalMs > 5000);
for (const m of slow) {
  console.log(`${m.match} (${m.ts})`);
  console.log(`  Total: ${m.totalMs}ms | Order: ${m.firstLeg === 'pm' ? 'PM→KAL' : 'KAL→PM'} | Edge: ${(m.edge * 100).toFixed(2)}%`);
  console.log(`  1st order: ${m.firstLegOrderMs}ms | 1st confirm: ${m.firstLegConfirmMs}ms`);
  console.log(`  Book fetch: ${m.bookFetchMs}ms`);
  console.log(`  2nd order: ${m.secondLegOrderMs}ms | 2nd confirm: ${m.secondLegConfirmMs}ms`);
  const bottleneck = Math.max(m.firstLegOrderMs, m.firstLegConfirmMs, m.bookFetchMs, m.secondLegOrderMs, m.secondLegConfirmMs);
  const bottleneckName = bottleneck === m.firstLegOrderMs ? '1st order' :
    bottleneck === m.firstLegConfirmMs ? '1st confirm' :
    bottleneck === m.bookFetchMs ? 'book fetch' :
    bottleneck === m.secondLegOrderMs ? '2nd order' : '2nd confirm';
  console.log(`  Bottleneck: ${bottleneckName} (${bottleneck}ms)`);
  console.log('');
}
