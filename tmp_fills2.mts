import 'dotenv/config';
import { fetchAllKalshiFills } from './src/kalshiTrade.js';
const fills = await fetchAllKalshiFills();
// Search for Zhukayev with correct ticker
const zh = fills.filter((f: any) => f.ticker?.includes('KXATPCHALLENGER'));
process.stdout.write('ATP Challenger fills: ' + zh.length + '\n');
zh.forEach((f: any) => process.stdout.write(JSON.stringify(f) + '\n'));
// Also search all fills from around 17:44 UTC
const around = fills.filter((f: any) => {
  const ts = new Date(f.ts).getTime();
  const target = new Date('2026-03-24T17:44:00Z').getTime();
  return Math.abs(ts - target) < 300000; // within 5 min
});
process.stdout.write('\nFills around 17:44 UTC: ' + around.length + '\n');
around.forEach((f: any) => process.stdout.write(JSON.stringify(f) + '\n'));
