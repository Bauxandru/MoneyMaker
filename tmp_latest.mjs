import { readFileSync, statSync } from 'fs';

// Check file modification time
const stat = statSync('data/arb_trades.json');
console.log('arb_trades.json last modified:', stat.mtime.toISOString());
console.log('Current time:', new Date().toISOString());
console.log('Seconds ago:', Math.round((Date.now() - stat.mtime.getTime()) / 1000));

const trades = JSON.parse(readFileSync('data/arb_trades.json','utf8'));
console.log(`\nTotal trades: ${trades.length}`);

// Show last 10 trades
console.log('\n=== LAST 10 TRADES ===');
for (const t of trades.slice(-10)) {
  console.log(`${t.ts} | ${t.match} | ${t.shares}sh | ${t.status} | ${t.dir}`);
}

// Check execution_metrics.json too
const mStat = statSync('data/execution_metrics.json');
console.log('\nexecution_metrics.json last modified:', mStat.mtime.toISOString());
console.log('Seconds ago:', Math.round((Date.now() - mStat.mtime.getTime()) / 1000));

const metrics = JSON.parse(readFileSync('data/execution_metrics.json','utf8'));
const last5 = metrics.slice(-5);
console.log('\n=== LAST 5 METRICS ===');
for (const m of last5) {
  console.log(`${m.ts} | ${m.match} | ${m.outcome} | ${m.totalMs}ms`);
}
