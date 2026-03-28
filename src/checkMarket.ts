import dotenv from "dotenv";
dotenv.config();
import { fetchKalshiMarket } from "./kalshiTrade.js";
const ticker = process.argv[2] ?? "KXDOTA2GAME-26FEB25PARILIQUID-PARI";
const mkt = await fetchKalshiMarket(ticker);
console.log("ticker:", ticker);
console.log("status:", mkt.status);
console.log("result:", mkt.result);
console.log("title:", mkt.title);
