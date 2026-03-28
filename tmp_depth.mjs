import { readFileSync } from 'fs';
const data = JSON.parse(readFileSync('data/depth_opportunities.json','utf8'));
const groups = {};
for (const d of data) {
  const key = d.match + '|' + d.dir;
  if (!groups[key] || d.edge > groups[key].edge || (d.edge === groups[key].edge && d.kalTotalContracts > groups[key].kalTotalContracts)) {
    groups[key] = d;
  }
}
const sorted = Object.values(groups).sort((a,b) => b.edge - a.edge);
for (const d of sorted) {
  const kalLvls = d.kalLevels.map(l => l.size + '@' + (l.price*100) + 'c').join(' + ') || 'EMPTY';
  const pmLvls = d.pmLevels.map(l => Math.round(l.size) + '@' + (l.price*100) + 'c').join(' + ') || 'EMPTY';
  console.log('--- ' + d.match + ' [dir ' + d.dir + '] ---');
  console.log('  Edge: ' + (d.edge*100).toFixed(2) + '%  |  Outcome: ' + d.outcome + (d.failReason ? ' (' + d.failReason + ')' : ''));
  console.log('  KAL best ask: ' + (d.kalAsk*100) + 'c  |  Book: ' + kalLvls);
  console.log('      Total: ' + d.kalTotalContracts + ' contracts = $' + d.kalTotalCostUsd.toFixed(2) + '  avg ' + (d.kalAvgPrice ? (d.kalAvgPrice*100).toFixed(1) + 'c' : '-'));
  console.log('  PM  best ask: ' + (d.pmAsk*100) + 'c  |  Book: ' + pmLvls);
  console.log('      Total: ' + Math.round(d.pmTotalShares) + ' shares = $' + d.pmTotalCostUsd.toFixed(2) + '  avg ' + (d.pmAvgPrice ? (d.pmAvgPrice*100).toFixed(1) + 'c' : '-'));
  console.log('  Max investable: $' + d.maxInvestableUsd.toFixed(2) + '  |  Projected P&L: $' + d.projectedPnlUsd.toFixed(2));
  console.log('');
}
console.log('Total unique match+dir combos: ' + sorted.length);
console.log('Total records: ' + data.length);
