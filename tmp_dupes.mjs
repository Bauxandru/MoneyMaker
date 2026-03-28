import { readFileSync } from 'fs';
const data = JSON.parse(readFileSync('data/arb_trades.json','utf8'));

// Find duplicates: same match + same timestamp
const groups = {};
for (const t of data) {
  const key = t.match + '|' + t.ts;
  if (!groups[key]) groups[key] = [];
  groups[key].push(t);
}
const dupes = Object.entries(groups).filter(([k,v]) => v.length > 1);
console.log('Duplicate groups (same match + same ts):', dupes.length);
console.log('');
for (const [key, trades] of dupes) {
  console.log('=== ' + key + ' (' + trades.length + ' records) ===');
  for (const t of trades) {
    console.log('  id=' + t.id + ' status=' + t.status + ' method=' + (t.resolutionMethod||'--') + ' shares=' + t.shares);
    console.log('    kalTicker=' + t.kalTicker + ' pmTokenId=' + (t.pmTokenId || 'none').slice(0,20) + '...');
    console.log('    kalCost=' + t.kalCost + ' pmCost=' + t.pmCost + ' totalCost=' + t.totalCost + ' pnl=' + t.realizedPnl);
  }
  console.log('');
}

// Also check: same ID duplicates
const byId = {};
for (const t of data) {
  if (!byId[t.id]) byId[t.id] = 0;
  byId[t.id]++;
}
const idDupes = Object.entries(byId).filter(([k,v]) => v > 1);
console.log('Duplicate IDs:', idDupes.length);
for (const [id, count] of idDupes) {
  console.log('  ' + id + ' appears ' + count + ' times');
}

// Check the specific ones from screenshot
console.log('\n=== FAZE vs MONTE (Mar 8 ~07:55) ===');
const faze = data.filter(t => t.match.includes('FaZe') && t.match.includes('Monte'));
console.log('Total FaZe vs Monte records:', faze.length);
for (const t of faze) {
  console.log('  ' + t.id + ' ts=' + t.ts + ' status=' + t.status + ' method=' + (t.resolutionMethod||'--'));
}

console.log('\n=== AURORA vs PAIN (Mar 8 ~07:49) ===');
const aurora = data.filter(t => t.match.includes('Aurora') && t.match.includes('paiN'));
console.log('Total Aurora vs paiN records:', aurora.length);
for (const t of aurora) {
  console.log('  ' + t.id + ' ts=' + t.ts + ' status=' + t.status + ' method=' + (t.resolutionMethod||'--'));
}

console.log('\n=== MOUZ vs YANDEX (Mar 8 ~07:29) ===');
const mouz = data.filter(t => t.match.includes('MOUZ') && t.match.includes('Yandex'));
console.log('Total MOUZ vs Yandex records:', mouz.length);
for (const t of mouz) {
  console.log('  ' + t.id + ' ts=' + t.ts + ' status=' + t.status + ' method=' + (t.resolutionMethod||'--'));
}

// Check recent trades with status "filled" vs method "--"
console.log('\n=== TRADES WITH NO RESOLUTION METHOD ===');
const noMethod = data.filter(t => !t.resolutionMethod);
console.log('Total trades with no resolutionMethod:', noMethod.length);
for (const t of noMethod) {
  console.log('  ' + t.id + ' ts=' + t.ts + ' match=' + t.match + ' status=' + t.status);
}
