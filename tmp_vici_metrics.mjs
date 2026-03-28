import { readFileSync } from 'fs';
const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));
const vici = metrics.filter(m => m.match && (m.match.includes('Vici') || m.match.includes('VGLIQUID')));
console.log(`Total Vici metrics: ${vici.length}`);
const outcomes = {};
for (const m of vici) {
  outcomes[m.outcome] = (outcomes[m.outcome] || 0) + 1;
}
console.log('Outcomes:', outcomes);

// Show any that aren't abort-pre-first
const nonAbort = vici.filter(m => m.outcome !== 'abort-pre-first');
console.log(`\nNon-abort metrics: ${nonAbort.length}`);
for (const m of nonAbort) {
  console.log(`  ${m.id} | ${m.ts} | dir=${m.dir} | outcome=${m.outcome} | firstLeg=${m.firstLeg}`);
  console.log(`    firstFilled=${m.firstLegFilled} secondFilled=${m.secondLegFilled} totalMs=${m.totalMs}`);
  console.log(`    failReason=${m.failReason || 'none'}`);
}

// Check: was there a "both-filled" or "hedge-entry" for this match?
const filled = vici.filter(m => m.outcome === 'both-filled' || m.outcome === 'hedge-entry');
console.log(`\nFilled metrics: ${filled.length}`);
