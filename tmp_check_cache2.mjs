import { readFileSync } from 'fs';
const cache = JSON.parse(readFileSync('discovery_cache.json','utf8'));
const all = cache.watchlist || [];
console.log('Total watchlist entries:', all.length);

// Find mongolz
const mongolz = all.filter(e => JSON.stringify(e).toLowerCase().includes('mongolz'));
console.log('\nMongolz entries:', mongolz.length);
for (const e of mongolz) {
  console.log(`  matchCode=${e.matchCode} pmSlug=${e.pmSlug}`);
  console.log(`    kal1=${e.kal1?.ticker} (${e.kal1?.surname})`);
  console.log(`    kal2=${e.kal2?.ticker} (${e.kal2?.surname})`);
}

// Duplicate matchCodes
const counts = {};
for (const e of all) { counts[e.matchCode] = (counts[e.matchCode] || 0) + 1; }
const dupes = Object.entries(counts).filter(([k, v]) => v > 1);
console.log('\nDuplicate matchCodes:', dupes.length);
for (const [mc, count] of dupes) {
  console.log(`  ${mc}: ${count} entries`);
  const entries = all.filter(e => e.matchCode === mc);
  for (const e of entries) {
    console.log(`    pmSlug=${e.pmSlug}`);
  }
}
