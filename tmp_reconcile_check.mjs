import { readFileSync } from 'fs';
const log = JSON.parse(readFileSync('data/reconcile_audit.json','utf8'));
console.log(`Reconcile entries: ${log.length}`);
// Show recent entries that modified the Vici trade
for (const entry of log) {
  const viciChanges = (entry.changes || []).filter(c => c.match && c.match.includes('Vici'));
  if (viciChanges.length > 0) {
    console.log(`\n${entry.ts} | trigger=${entry.trigger} | changes=${entry.changeCount}`);
    for (const c of viciChanges) {
      console.log(`  ${c.tradeId} ${c.match} | ${c.field}: ${c.oldValue} -> ${c.newValue}`);
    }
  }
}
// Show last 3 entries
console.log('\n=== LAST 3 ENTRIES ===');
for (const entry of log.slice(-3)) {
  console.log(`${entry.ts} | trigger=${entry.trigger} | changes=${entry.changeCount}`);
  for (const c of (entry.changes || []).slice(0, 5)) {
    console.log(`  ${c.tradeId} ${c.field}: ${JSON.stringify(c.oldValue)} -> ${JSON.stringify(c.newValue)}`);
  }
}
