/** Check market status. Run: npx tsx src/_checkMarket.ts TICKER */
import dotenv from "dotenv";
dotenv.config();
import { fetchKalshiMarket } from "./kalshiTrade.js";

const ticker = process.argv[2] || "KXCS2GAME-26MAR04ECSSIN-SIN";
fetchKalshiMarket(ticker).then(m => {
  console.log(`Ticker: ${ticker}`);
  console.log(`Status: ${m.status}`);
  console.log(`Result: ${m.result ?? "n/a"}`);
  console.log(`Yes ask: ${m.yes_ask}  No ask: ${m.no_ask}`);
}).catch(e => console.error("Error:", e.message));
