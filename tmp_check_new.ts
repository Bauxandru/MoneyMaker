import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { fetchAllKalshiFills } from "./src/kalshiTrade.js";

async function main() {
  const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
  const mar8 = trades.filter((t: any) => t.ts >= "2026-03-08");

  console.log("Fetching Kalshi fills...");
  const fills = await fetchAllKalshiFills();

  for (const t of mar8) {
    const ticker = t.kalTicker;
    const arbMs = new Date(t.ts).getTime();
    const matchingFills = fills.filter((f: any) =>
      f.ticker === ticker && f.action === "buy" && Math.abs(new Date(f.ts).getTime() - arbMs) < 120_000
    );
    const totalFilled = matchingFills.reduce((s: number, f: any) => s + f.count, 0);

    console.log(`${t.id} | ${t.match} | ticker=${ticker}`);
    console.log(`  arb ts=${t.ts} | shares=${t.shares} | status=${t.status}`);
    console.log(`  Kalshi fills within 2min: ${matchingFills.length} fills, ${totalFilled} contracts`);
    for (const f of matchingFills) {
      console.log(`    ${f.ts} | ${f.action} ${f.side} ${f.count}@${f.yesPrice}c | taker=${f.isTaker}`);
    }
    console.log("");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
