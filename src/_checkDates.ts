import dotenv from "dotenv";
dotenv.config();
import { fetchAllKalshiFills } from "./kalshiTrade.js";

async function main() {
  const fills = await fetchAllKalshiFills();
  console.log("KAL sample ts:", fills.slice(0, 3).map(f => f.ts));
  console.log("After 2026-03-14:", fills.filter(f => f.ts >= "2026-03-14").length, "/", fills.length);
  console.log("Before 2026-03-14:", fills.filter(f => f.ts < "2026-03-14").length);
}
main().catch(e => console.error(e));
