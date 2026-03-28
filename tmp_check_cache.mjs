import { readFileSync } from 'fs';
const cache = JSON.parse(readFileSync('discovery_cache.json','utf8'));

// Find all entries with mongolz or mouz in any field
const all = Array.isArray(cache) ? cache : Object.values(cache);
console.log('Total cache entries:', all.length);

const mongolz = all.filter(e => {
  const s = JSON.stringify(e).toLowerCase();
  return s.includes('mongolz') || s.includes('mglz');
});

console.log('\nMongolz/MGLZ entries:', mongolz.length);
for (const e of mongolz) {
  console.log(`  matchCode=${e.matchCode}`);
  console.log(`    pmSlug=${e.pmSlug}`);
  console.log(`    kal1=${e.kal1?.ticker} (${e.kal1?.surname})`);
  console.log(`    kal2=${e.kal2?.ticker} (${e.kal2?.surname})`);
  console.log('');
}

// Also check for duplicate matchCodes in the full cache
const matchCodeCounts = {};
for (const e of all) {
  matchCodeCounts[e.matchCode] = (matchCodeCounts[e.matchCode] || 0) + 1;
}
const dupeMatchCodes = Object.entries(matchCodeCounts).filter(([k, v]) => v > 1);
console.log('Duplicate matchCodes:', dupeMatchCodes.length);
for (const [mc, count] of dupeMatchCodes) {
  console.log(`  ${mc}: ${count} entries`);
  const entries = all.filter(e => e.matchCode === mc);
  for (const e of entries) {
    console.log(`    pmSlug=${e.pmSlug}`);
  }
}
