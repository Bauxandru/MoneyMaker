import 'dotenv/config';
import { fetchAllKalshiFills } from './src/kalshiTrade.js';
const fills = await fetchAllKalshiFills();
process.stdout.write('Total fills: ' + fills.length + '\n');
const zh = fills.filter((f: any) => f.ticker?.includes('ZHUVAN'));
process.stdout.write('Zhukayev fills: ' + zh.length + '\n');
zh.forEach((f: any) => process.stdout.write(JSON.stringify(f) + '\n'));
const cir = fills.filter((f: any) => f.ticker?.includes('CIRGAU'));
process.stdout.write('Cirstea fills: ' + cir.length + '\n');
cir.forEach((f: any) => process.stdout.write(JSON.stringify(f) + '\n'));
// Search broader
const zh2 = fills.filter((f: any) => f.ticker?.includes('ZHU') || f.ticker?.includes('VAN'));
process.stdout.write('\nBroader search (ZHU/VAN): ' + zh2.length + '\n');
zh2.forEach((f: any) => process.stdout.write(JSON.stringify(f) + '\n'));
