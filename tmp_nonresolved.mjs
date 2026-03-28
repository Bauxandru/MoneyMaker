import { readFileSync } from 'fs';
const t = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
const nonResolved = t.filter(x => x.status !== 'resolved');
console.log('Non-resolved trades:', nonResolved.length);
for (const x of nonResolved) {
  console.log(`  ${x.id} | ${x.match} | status=${x.status} | pnl=${x.realizedPnl} | shares=${x.shares}`);
}
