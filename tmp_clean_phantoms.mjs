import { readFileSync, writeFileSync } from 'fs';
const trades = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
console.log(`Before: ${trades.length} trades`);

// Remove all Mar 8 trades after 09:00 UTC (all are phantoms from dry-run bot)
// Real Mar 8 trades: Bebop (06:14) and MOUZ (08:22) — keep those
const clean = trades.filter(t => {
  if (t.ts < '2026-03-08T09:00:00') return true; // keep everything before 09:00
  console.log(`  REMOVING: ${t.ts} | ${t.match} | ${t.shares}sh | ${t.status}`);
  return false;
});

console.log(`\nAfter: ${clean.length} trades`);
writeFileSync('data/arb_trades.json', JSON.stringify(clean, null, 2));
console.log('Saved.');
