/** Quick orderbook debug test. Run: npx tsx src/_bookTest.ts */
import dotenv from "dotenv";
dotenv.config();
import { fetchKalshiOrderbook } from "./kalshiTrade.js";

const ticker = process.argv[2] || "KXCS2GAME-26MAR04NEMEYE-NEM";

async function main() {
  console.log(`Fetching orderbook for: ${ticker}\n`);
  const book = await fetchKalshiOrderbook(ticker);
  console.log(`YES bids (${book.yes.length}):`);
  for (const [p, s] of book.yes) console.log(`  ${p}¢ × ${s}`);
  console.log(`\nNO bids (${book.no.length}):`);
  for (const [p, s] of book.no) console.log(`  ${p}¢ × ${s}`);

  // Derive YES asks from NO bids
  const yesAsks = book.no.map(([np, s]) => [100 - np, s] as [number, number]).filter(([p]) => p > 0 && p < 100).sort((a, b) => a[0] - b[0]);
  console.log(`\nDerived YES asks (${yesAsks.length}):`);
  for (const [p, s] of yesAsks.slice(0, 10)) console.log(`  ${p}¢ × ${s}`);

  if (book.yes.length === 0 && book.no.length === 0) {
    console.log("\nBoth sides empty! Fetching raw response...");
    // Re-fetch with raw logging
    const { kalshiSignedFetch } = await import("./kalshiTrade.js") as any;
    if (typeof kalshiSignedFetch === "function") {
      const raw = await kalshiSignedFetch("GET", `/markets/${ticker}/orderbook`);
      console.log("\nRaw API response:");
      console.log(JSON.stringify(raw, null, 2).slice(0, 2000));
    }
  }
}

main().catch(e => console.error("Error:", e));
