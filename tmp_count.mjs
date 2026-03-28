import { readFileSync } from 'fs';
const t = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
console.log('Array length:', t.length);
console.log('Resolved:', t.filter(x => x.status === 'resolved').length);
console.log('With pnl > 0:', t.filter(x => x.realizedPnl > 0).length);
console.log('With pnl = 0:', t.filter(x => x.realizedPnl === 0).length);
console.log('With pnl < 0:', t.filter(x => x.realizedPnl < 0).length);
console.log('With pnl null:', t.filter(x => x.realizedPnl == null).length);
