import { fetchKalshiMarket } from './src/kalshiTrade.js';

const market = await fetchKalshiMarket("KXATPCHALLENGERMATCH-26MAR24BARING-ING");
console.log(JSON.stringify(market, null, 2));
process.exit(0);
