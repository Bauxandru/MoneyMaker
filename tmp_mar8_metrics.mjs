import { readFileSync } from 'fs';
const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));
const mar8Filled = metrics.filter(m => m.ts >= '2026-03-08' && (m.outcome === 'both-filled' || m.outcome === 'hedge-entry'));
console.log(`Mar 8 filled/hedge metrics: ${mar8Filled.length}\n`);
for (const m of mar8Filled) {
  console.log(`${m.id} | ${m.ts} | ${m.match}`);
  console.log(`  dir=${m.dir} outcome=${m.outcome} shares=${m.shares} firstLeg=${m.firstLeg}`);
  console.log(`  totalMs=${m.totalMs} bookFetchMs=${m.bookFetchMs}`);
  console.log(`  firstLegOrderMs=${m.firstLegOrderMs} firstLegConfirmMs=${m.firstLegConfirmMs}`);
  console.log(`  secondLegOrderMs=${m.secondLegOrderMs} secondLegConfirmMs=${m.secondLegConfirmMs}`);
  console.log(`  failReason=${m.failReason || 'none'}`);
  const realTiming = m.firstLegOrderMs > 50 || m.secondLegOrderMs > 50;
  console.log(`  >>> ${realTiming ? 'REAL timing' : 'FAKE timing (0ms = dry-run)'}`);
  console.log('');
}
