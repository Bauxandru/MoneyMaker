import { fetchAllKalshiSettlements, fetchAllKalshiFills } from './src/kalshiTrade.js';

const settlements = await fetchAllKalshiSettlements();
console.log("Total settlements:", settlements.length);

const s = settlements.find(s => s.ticker.includes('BARING'));
console.log('\nIngildsen settlement:', JSON.stringify(s, null, 2));

// settDivisor detection
if (settlements.length > 0) {
  const s0 = settlements[0];
  const tc = (s0.yesCount || 0) + (s0.noCount || 0);
  const ratio = tc > 0 ? s0.revenue / tc : 'N/A';
  console.log('\nFirst settlement (s0):', JSON.stringify(s0));
  console.log('settDivisor: tc=' + tc + ', revenue/tc=' + ratio + ', divisor=' + (tc > 0 && ratio <= 1.5 ? 1 : 100));
}

const fills = await fetchAllKalshiFills();
const f = fills.filter(f => f.ticker.includes('BARING'));
console.log('\nIngildsen fills:', JSON.stringify(f, null, 2));

process.exit(0);
