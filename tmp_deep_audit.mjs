import { readFileSync } from 'fs';
const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));

// Check ALL filled metrics around 09:18 - maybe I missed some with borderline timing
const around918 = metrics.filter(m => {
  if (!m.ts) return false;
  const ts = new Date(m.ts).getTime();
  const target = new Date('2026-03-08T09:15:00Z').getTime();
  return ts > target && ts < target + 600000; // 10 min window
});

console.log('=== ALL metrics 09:15-09:25 UTC ===');
for (const m of around918) {
  if (m.outcome === 'abort-pre-first') continue; // skip aborts
  console.log(`${m.ts} | ${m.match} | ${m.outcome} | dir=${m.dir} | ${m.shares}sh`);
  console.log(`  1stLeg=${m.firstLeg} orderMs=${m.firstLegOrderMs} confirmMs=${m.firstLegConfirmMs}`);
  console.log(`  2ndOrderMs=${m.secondLegOrderMs} 2ndConfirmMs=${m.secondLegConfirmMs}`);
  console.log(`  totalMs=${m.totalMs} failReason=${m.failReason || 'none'}`);
  console.log(`  kalPrice=${m.expectedKalPrice} pmPrice=${m.expectedPmPrice}`);
  console.log('');
}

// Also check: did the real trade (dir=D, 10sh) have firstLeg=pm?
// If PM was first, and PM bought Bilibili... but then what bought JD Gaming?
const realTrade = around918.find(m => m.firstLegOrderMs > 50);
if (realTrade) {
  console.log('=== THE REAL TRADE ===');
  console.log(JSON.stringify(realTrade, null, 2));
}

// Check Vancouver: our trade has 11sh but PM shows 22sh
console.log('\n=== Vancouver metrics ===');
const van = metrics.filter(m => m.match && m.match.includes('Vancouver'));
const vanFilled = van.filter(m => m.outcome === 'both-filled' || m.outcome === 'hedge-entry');
console.log(`Total: ${van.length}, Filled: ${vanFilled.length}`);
for (const m of vanFilled) {
  const real = m.firstLegOrderMs > 50 || m.secondLegOrderMs > 50;
  console.log(`  ${m.ts} | ${m.outcome} | ${m.shares}sh | dir=${m.dir} | ${real ? 'REAL' : 'FAKE'} | totalMs=${m.totalMs}`);
}
