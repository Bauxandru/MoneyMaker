import { readFileSync } from 'fs';

// 1. What's in arb_trades.json?
const trades = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
const mar8 = trades.filter(t => t.ts >= '2026-03-08');
console.log('=== ARB_TRADES.JSON ===');
console.log(`Total: ${trades.length}, Mar 8: ${mar8.length}`);
for (const t of mar8) {
  console.log(`  ${t.id} | ${t.match} | ${t.shares}sh | ${t.status} | ${t.dir}`);
  console.log(`    kal=${t.kalTicker} pm=${t.pmSlug} pmToken=${(t.pmTokenId||'').slice(0,20)}...`);
}

// 2. What execution metrics show REAL fills (orderMs > 50)?
const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));
const realFills = metrics.filter(m =>
  (m.outcome === 'both-filled' || m.outcome === 'hedge-entry') &&
  (m.firstLegOrderMs > 50 || m.secondLegOrderMs > 50)
);
console.log(`\n=== REAL EXECUTION METRICS (orderMs > 50) ===`);
console.log(`Total: ${realFills.length}`);
for (const m of realFills) {
  console.log(`  ${m.ts} | ${m.match} | ${m.outcome} | dir=${m.dir} | ${m.shares}sh`);
  console.log(`    1st=${m.firstLeg} orderMs=${m.firstLegOrderMs} confirmMs=${m.firstLegConfirmMs}`);
  console.log(`    2nd orderMs=${m.secondLegOrderMs} confirmMs=${m.secondLegConfirmMs} totalMs=${m.totalMs}`);
  console.log(`    kalPrice=${m.expectedKalPrice} pmPrice=${m.expectedPmPrice}`);
}

// 3. Check for Bilibili/JD Gaming specifically
console.log('\n=== ALL BILIBILI/JD METRICS ===');
const blg = metrics.filter(m => m.match && (m.match.includes('Bilibili') || m.match.includes('JD Gaming')));
console.log(`Total: ${blg.length}`);
const blgFilled = blg.filter(m => m.outcome === 'both-filled' || m.outcome === 'hedge-entry');
console.log(`Filled/hedge: ${blgFilled.length}`);
for (const m of blgFilled) {
  const real = m.firstLegOrderMs > 50 || m.secondLegOrderMs > 50;
  console.log(`  ${m.ts} | ${m.match} | ${m.outcome} | dir=${m.dir} | ${m.shares}sh | ${real ? 'REAL' : 'FAKE'}`);
  console.log(`    1stOrderMs=${m.firstLegOrderMs} 2ndOrderMs=${m.secondLegOrderMs} totalMs=${m.totalMs}`);
}

// 4. Cross-reference: what REAL fills are NOT in arb_trades.json?
console.log('\n=== REAL FILLS NOT IN ARB_TRADES.JSON ===');
for (const m of realFills) {
  // Find matching trade by timestamp proximity
  const mTs = new Date(m.ts).getTime();
  const match = trades.find(t => Math.abs(new Date(t.ts).getTime() - mTs) < 5000);
  if (!match) {
    console.log(`  MISSING: ${m.ts} | ${m.match} | ${m.outcome} | ${m.shares}sh | dir=${m.dir}`);
  }
}
