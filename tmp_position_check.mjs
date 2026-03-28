import { readFileSync } from 'fs';

// From the screenshots, the user has these exchange positions:
// KALSHI:
//   - Bebop vs ex-RUBY: Yes·ex-RUBY, 10 contracts, 28¢
//   - Bilibili Gaming: No·Bilibili Gaming, 10 contracts, 38¢ (was 20¢ now changed)
//   - Paris Gentle Mates: Yes·Paris Gentle Mates, 11 contracts, 83¢
//   - The Mongolz vs MOUZ: (visible but cut off)
//
// POLYMARKET:
//   - Bilibili Gaming 61¢, 10 shares (41¢→68¢ now)
//   - JD Gaming 30¢, 10 shares (new!)
//   - Bebop 41¢, 10 shares
//   - Vancouver Surge 12¢, 22 shares
//   - TheMongolz 29¢, 10 shares
//   + Backpack FDV positions (unrelated)

// The real Bilibili trade: dir=D, 10sh
// D = buy KAL P2 NO + buy PM P2
// Match: "JD Gaming vs Bilibili Gaming" → P1=JD, P2=Bilibili
// So: KAL Bilibili NO (10) ✓ + PM Bilibili (10) ✓
// This covers the Bilibili positions on both exchanges.

// But PM also shows JD Gaming 30¢, 10 shares. Where did this come from?
// Check if there's an older trade in arb_trades.json for JD Gaming
const trades = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
const jdg = trades.filter(t => t.match && (t.match.includes('JD Gaming') || t.match.includes('Bilibili')));
console.log('=== JD Gaming / Bilibili trades in arb_trades.json ===');
for (const t of jdg) {
  console.log(`  ${t.id} | ${t.ts.slice(0,10)} | ${t.match} | ${t.shares}sh | dir=${t.dir} | ${t.status}`);
  console.log(`    kalTicker=${t.kalTicker}`);
  console.log(`    pmSlug=${t.pmSlug} pmOutcome=${t.pmOutcome}`);
  console.log(`    pmTokenId=${(t.pmTokenId||'').slice(0,30)}...`);
}

// Check metrics: any hedge-entry for Bilibili?
const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));
const blgHedge = metrics.filter(m =>
  m.match && (m.match.includes('Bilibili') || m.match.includes('JD Gaming')) &&
  m.outcome === 'hedge-entry' &&
  (m.firstLegOrderMs > 50 || m.secondLegOrderMs > 50)
);
console.log('\n=== REAL hedge-entry metrics for Bilibili/JD ===');
console.log(`Found: ${blgHedge.length}`);
for (const m of blgHedge) {
  console.log(`  ${m.ts} | ${m.match} | ${m.outcome} | dir=${m.dir} | ${m.shares}sh`);
}

// Check: Vancouver Surge 22 shares on PM — our trade was 11 shares. Mismatch?
const van = trades.filter(t => t.match && t.match.includes('Vancouver'));
console.log('\n=== Vancouver trades ===');
for (const t of van) {
  console.log(`  ${t.id} | ${t.match} | ${t.shares}sh | pmOutcome=${t.pmOutcome} | ${t.status}`);
}

// Summary: what SHOULD be tracked but ISN'T
console.log('\n=== PORTFOLIO vs TRACKING ANALYSIS ===');
console.log('Kalshi positions from screenshot:');
console.log('  1. Bebop NO→ex-RUBY YES, 10 contracts → tracked ✓');
console.log('  2. Bilibili NO, 10 contracts → NOT tracked (deleted real trade)');
console.log('  3. Paris Gentle Mates YES, 11 contracts → tracked ✓');
console.log('  4. Mongolz MOUZ, ? contracts → tracked ✓');
console.log('');
console.log('PM positions from screenshot:');
console.log('  1. Bilibili Gaming 61¢, 10sh → NOT tracked (part of deleted trade)');
console.log('  2. JD Gaming 30¢, 10sh → UNKNOWN origin');
console.log('  3. Bebop 41¢, 10sh → tracked ✓');
console.log('  4. Vancouver Surge 12¢, 22sh → tracked (11sh trade) + 11 extra??');
console.log('  5. TheMongolz 29¢, 10sh → tracked ✓');
