import "dotenv/config";
import { fetchAllKalshiSettlements, fetchAllKalshiFills } from "./kalshiTrade.js";

const TICKERS = [
  "KXCS2MAP-26MAR083DMAXFUT-2-FUT",
  "KXCS2MAP-26MAR083DMAXFUT-2-3DMAX",
  "KXCS2GAME-26MAR04M80TL-TL",
  "KXCS2GAME-26MAR04M80TL-M80",
  "KXWTAMATCH-26MAR04BIRSEL-SEL",
  "KXWTAMATCH-26MAR04BIRSEL-BIR",
  "KXCS2GAME-26MAR04MNTEPRV-MNTE",
  "KXCS2GAME-26MAR04MNTEPRV-PRV",
];

const tickerSet = new Set(TICKERS);

async function main() {
  console.log("=== Fetching settlements ===");
  const settlements = await fetchAllKalshiSettlements();
  const matched = settlements.filter(s => tickerSet.has(s.ticker));

  if (matched.length === 0) {
    console.log("No settlements found for any of the 8 tickers.");
    // Show all unique tickers that partially match to help debug
    const partial = settlements.filter(s =>
      TICKERS.some(t => {
        const base = t.split("-").slice(0, -1).join("-");
        return s.ticker.startsWith(base.substring(0, 15));
      })
    );
    if (partial.length > 0) {
      console.log("\nPartial matches in settlements:");
      for (const s of partial) {
        console.log(`  ${s.ticker}  result=${s.marketResult}  revenue=${s.revenue}  yesCount=${s.yesCount}  noCount=${s.noCount}`);
      }
    }
  } else {
    console.log(`Found ${matched.length} settlement(s):\n`);
    for (const s of matched) {
      console.log(`  ticker:       ${s.ticker}`);
      console.log(`  marketResult: ${s.marketResult}`);
      console.log(`  revenue:      ${s.revenue} cents`);
      console.log(`  yesCost:      ${s.yesCost} cents`);
      console.log(`  noCost:       ${s.noCost} cents`);
      console.log(`  feeCost:      ${s.feeCost}`);
      console.log(`  yesCount:     ${s.yesCount}`);
      console.log(`  noCount:      ${s.noCount}`);
      console.log(`  settledTime:  ${s.settledTime}`);
      console.log();
    }
  }

  console.log("\n=== Fetching fills ===");
  const fills = await fetchAllKalshiFills();
  const matchedFills = fills.filter(f => tickerSet.has(f.ticker));

  if (matchedFills.length === 0) {
    console.log("No fills found for any of the 8 tickers.");
  } else {
    console.log(`Found ${matchedFills.length} fill(s):\n`);
    for (const f of matchedFills) {
      console.log(`  ticker=${f.ticker}  action=${f.action}  side=${f.side}  count=${f.count}  yesPrice=${f.yesPrice}  noPrice=${f.noPrice}  fee=$${f.feeCost}  ts=${f.ts}`);
    }
  }

  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });
