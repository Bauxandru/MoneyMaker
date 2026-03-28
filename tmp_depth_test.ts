import dotenv from "dotenv";
dotenv.config();
import { fetchKalshiOrderbook } from "./src/kalshiTrade.js";
import { fetchJsonWithRetry } from "./src/http.js";

const KAL_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// Fetch a batch of open markets and compare listing vs orderbook depth
async function main() {
  const series = ["KXATPMATCH", "KXWTAMATCH", "KXCS2GAME"];

  for (const s of series) {
    const res = await fetchJsonWithRetry(`${KAL_BASE}/markets?series_ticker=${s}&status=open&limit=10`) as any;
    const markets = res.markets ?? [];

    for (const m of markets) {
      const ticker = m.ticker;
      const yesAsk = m.yes_ask ?? m.yes_ask_dollars;
      const noAsk = m.no_ask ?? m.no_ask_dollars;
      const yesAskSize = m.yes_ask_size_fp ?? m.yes_ask_size ?? "?";
      const yesBidSize = m.yes_bid_size_fp ?? m.yes_bid_size ?? "?";

      // Fetch orderbook
      let book: { yes: [number, number][]; no: [number, number][] } | null = null;
      try {
        book = await fetchKalshiOrderbook(ticker);
      } catch (e) {
        console.log(`  [ERROR] ${ticker}: ${(e as Error).message}`);
      }

      const yesBids = book?.yes?.length ?? 0;
      const noBids = book?.no?.length ?? 0;

      // Derive asks from opposite bids
      const derivedYesAsks = (book?.no ?? [])
        .map(([p, s]) => [100 - p, s] as [number, number])
        .filter(([p]) => p > 0 && p < 100);
      const derivedNoAsks = (book?.yes ?? [])
        .map(([p, s]) => [100 - p, s] as [number, number])
        .filter(([p]) => p > 0 && p < 100);

      const hasYesAsk = yesAsk !== undefined && yesAsk !== null;
      const yesAskEmpty = derivedYesAsks.length === 0;
      const noAskEmpty = derivedNoAsks.length === 0;

      // Flag cases where listing shows ask but orderbook derivation is empty
      const flag = (hasYesAsk && yesAskEmpty) ? " *** MISMATCH ***" : "";

      console.log(`${ticker}${flag}`);
      console.log(`  Listing: yesAsk=${yesAsk}  noAsk=${noAsk}  yesAskSize=${yesAskSize}  yesBidSize=${yesBidSize}`);
      console.log(`  Book: ${yesBids} YES bids, ${noBids} NO bids → ${derivedYesAsks.length} derived YES asks, ${derivedNoAsks.length} derived NO asks`);
      if (derivedYesAsks.length > 0) console.log(`    YES asks: ${derivedYesAsks.slice(0, 3).map(([p,s]) => `${s}@${p}c`).join(", ")}`);
      if (derivedNoAsks.length > 0) console.log(`    NO asks: ${derivedNoAsks.slice(0, 3).map(([p,s]) => `${s}@${p}c`).join(", ")}`);
      if (flag) console.log(`    → Listing has yesAsk=${yesAsk} with size=${yesAskSize} but no NO bids to derive from!`);
      console.log();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
