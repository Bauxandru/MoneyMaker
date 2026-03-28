/**
 * Analyze maximum deployable capital per arb opportunity.
 * For each open market pair, checks orderbook depth on both Kalshi and PM
 * and calculates how many shares you can trade while maintaining positive edge.
 *
 * Usage: npx tsx src/analyzeDepth.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { fetchKalshiOrderbook } from "./kalshiTrade.js";
import { fetchJsonWithRetry } from "./http.js";

const KAL_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const CLOB_BASE = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

// Fees — matching tradeTennis.ts exactly
// Kalshi taker fee: 7% × P × (1-P) per contract. Max ~1.75¢ at P=0.50.
const KALSHI_FEE_RATE = 0.07;
// PM fee: 0 for tennis/esports markets
const PM_FEE_RATE = 0;

function estimateFees(kalAsk: number, pmAsk: number): number {
  const kalFee = KALSHI_FEE_RATE * kalAsk * (1 - kalAsk);
  const pmFee = PM_FEE_RATE * pmAsk * (1 - pmAsk);
  return kalFee + pmFee;
}

interface KalMarket {
  ticker: string;
  title: string;
  yes_ask: number;
  no_ask: number;
  status: string;
}

type AnyRecord = Record<string, unknown>;

// ─── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function deriveYesAsks(noBids: [number, number][]): [number, number][] {
  return noBids
    .map(([price, size]): [number, number] => [100 - price, size])
    .filter(([p]) => p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}

function deriveNoAsks(yesBids: [number, number][]): [number, number][] {
  return yesBids
    .map(([price, size]): [number, number] => [100 - price, size])
    .filter(([p]) => p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}

// Sweep orderbook levels, return total qty available up to maxPriceCents
function sweepAll(levels: [number, number][], maxPriceCents: number): { qty: number; avgPrice: number; levels: { price: number; size: number }[] } {
  let totalQty = 0;
  let totalCost = 0;
  const lvls: { price: number; size: number }[] = [];
  for (const [price, size] of levels) {
    if (price > maxPriceCents) break;
    totalQty += size;
    totalCost += size * price;
    lvls.push({ price, size });
  }
  return { qty: totalQty, avgPrice: totalQty > 0 ? totalCost / totalQty : 0, levels: lvls };
}

// Fetch PM CLOB orderbook for a token
async function fetchPmBook(tokenId: string): Promise<{ asks: [number, number][]; bids: [number, number][] }> {
  const book = await fetchJsonWithRetry(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`) as AnyRecord;
  const parseLevel = (entry: AnyRecord): [number, number] => [Number(entry.price ?? 0), Number(entry.size ?? 0)];
  const asks = Array.isArray(book.asks) ? book.asks.map(parseLevel).sort((a: [number, number], b: [number, number]) => a[0] - b[0]) : [];
  const bids = Array.isArray(book.bids) ? book.bids.map(parseLevel).sort((a: [number, number], b: [number, number]) => b[0] - a[0]) : [];
  return { asks, bids };
}

// Sweep PM asks up to a max price (decimal, e.g. 0.65)
function sweepPmAsks(asks: [number, number][], maxPrice: number): { qty: number; avgPrice: number } {
  let totalQty = 0;
  let totalCost = 0;
  for (const [price, size] of asks) {
    if (price > maxPrice) break;
    totalQty += size;
    totalCost += size * price;
  }
  return { qty: totalQty, avgPrice: totalQty > 0 ? totalCost / totalQty : 0 };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== ARB DEPTH ANALYSIS ===\n");
  console.log("Fetching open Kalshi markets...\n");

  // Fetch all open markets from relevant series
  const series = ["KXATPMATCH", "KXCS2GAME", "KXCS2MAP", "KXLOLGAME", "KXLOLMAP", "KXVALGAME", "KXVALMAP", "KXWTAMATCH"];
  const allMarkets: KalMarket[] = [];

  for (const s of series) {
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ series_ticker: s, status: "open", limit: "200" });
      if (cursor) params.set("cursor", cursor);
      const data = await fetchJsonWithRetry(`${KAL_BASE}/markets?${params}`) as AnyRecord;
      const markets = (data.markets ?? []) as KalMarket[];
      allMarkets.push(...markets);
      cursor = String(data.cursor ?? "");
      if (!cursor || markets.length < 200) break;
      await sleep(200);
    }
  }

  console.log(`Found ${allMarkets.length} open Kalshi markets\n`);

  // Group by match (pair of player markets)
  const matchGroups = new Map<string, KalMarket[]>();
  for (const m of allMarkets) {
    // Match code = ticker without the player suffix (last dash-segment)
    const parts = m.ticker.split("-");
    const matchCode = parts.slice(0, -1).join("-");
    const group = matchGroups.get(matchCode) ?? [];
    group.push(m);
    matchGroups.set(matchCode, group);
  }

  // Only pairs (2 markets per match)
  const pairs = [...matchGroups.entries()].filter(([, v]) => v.length === 2);
  console.log(`${pairs.length} complete match pairs\n`);

  // Build PM slug for each pair and analyze depth
  interface Result {
    match: string; dir: string; rawEdge: number; netEdge: number;
    kalMaxQty: number; pmMaxQty: number; maxShares: number; maxCapital: number;
    kalBestAsk: number; pmBestAsk: number;
  }
  const results: Result[] = [];
  const nearMisses: Result[] = [];

  let dbgNoPm = 0, dbgNoBook = 0, dbgChecked = 0;

  for (const [matchCode, [kal1, kal2]] of pairs) {
    // Extract player surnames from titles
    const extractSurname = (title: string): string => {
      const m = title.match(/Will (.+?) win/);
      if (!m) return "";
      const fullName = m[1];
      const parts = fullName.trim().split(/\s+/);
      return parts[parts.length - 1]; // last word = surname
    };

    const sur1 = extractSurname(kal1.title);
    const sur2 = extractSurname(kal2.title);
    if (!sur1 || !sur2) continue;

    // Determine sport from series
    const seriesTicker = matchCode.split("-")[0];
    const SERIES_PREFIXES: Record<string, string[]> = {
      KXATPMATCH: ["atp"], KXWTAMATCH: ["wta"],
      KXCS2GAME: ["cs2"], KXCS2MAP: ["cs2"],
      KXLOLGAME: ["lol"], KXLOLMAP: ["lol"],
      KXVALGAME: ["valorant", "val"], KXVALMAP: ["valorant", "val"],
    };
    const prefixes = SERIES_PREFIXES[seriesTicker] ?? ["atp"];
    const isTennis = seriesTicker.includes("ATP") || seriesTicker.includes("WTA");

    // Extract date from ticker (e.g., 26MAR06 → 2026-03-06)
    const dateMatch = matchCode.match(/(\d{2})([A-Z]{3})(\d{2})/);
    if (!dateMatch) continue;
    const months: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
    const dateStr = `20${dateMatch[1]}-${months[dateMatch[2]] ?? "01"}-${dateMatch[3]}`;

    // Build PM slug variants (match tradeTennis.ts logic)
    const t1 = sur1.toLowerCase().slice(0, 7);
    const t2 = sur2.toLowerCase().slice(0, 7);
    const t1s = sur1.toLowerCase().slice(0, 6);
    const t2s = sur2.toLowerCase().slice(0, 6);
    const slugVariants: string[] = [];
    for (const pfx of prefixes) {
      if (isTennis) {
        slugVariants.push(
          `${pfx}-${t1}-${t2}-${dateStr}`, `${pfx}-${t2}-${t1}-${dateStr}`,
          `${pfx}-${t1s}-${t2s}-${dateStr}`, `${pfx}-${t2s}-${t1s}-${dateStr}`,
        );
      } else {
        slugVariants.push(
          `${pfx}-${t1}-${t2}-${dateStr}`, `${pfx}-${t2}-${t1}-${dateStr}`,
          `${pfx}-${t1}-${t2}`, `${pfx}-${t2}-${t1}`,
        );
      }
    }
    // Generic "X-vs-Y" patterns (esports)
    if (!isTennis) {
      slugVariants.push(
        `${t1}-vs-${t2}`, `${t2}-vs-${t1}`,
        `${t1}-vs-${t2}-${dateStr}`, `${t2}-vs-${t1}-${dateStr}`,
      );
    }

    // Try each slug variant against both /markets and /events
    let pmMarket: AnyRecord | null = null;
    for (const slug of [...new Set(slugVariants)]) {
      // Try market-level
      try {
        const pmData = await fetchJsonWithRetry(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`) as AnyRecord[];
        if (Array.isArray(pmData) && pmData.length > 0 && !pmData[0].closed) { pmMarket = pmData[0]; break; }
      } catch { /* skip */ }
      // Try event-level
      try {
        const evData = await fetchJsonWithRetry(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`) as AnyRecord[];
        const evArr = Array.isArray(evData) ? evData : [];
        for (const ev of evArr) {
          for (const m of (Array.isArray(ev.markets) ? ev.markets as AnyRecord[] : [])) {
            if (m.closed) continue;
            const outs = JSON.parse(String(m.outcomes ?? "[]"));
            const toks = JSON.parse(String(m.clobTokenIds ?? "[]"));
            if (outs.length === 2 && toks.length >= 2) { pmMarket = m; break; }
          }
          if (pmMarket) break;
        }
      } catch { /* skip */ }
      if (pmMarket) break;
      await sleep(50);
    }

    if (!pmMarket) { dbgNoPm++; if (dbgNoPm <= 5) console.log(`  [no PM] ${slugVariants[0]} (${sur1} vs ${sur2})`); continue; }

    const outcomes: string[] = JSON.parse(String(pmMarket.outcomes ?? "[]"));
    const tokenIds: string[] = JSON.parse(String(pmMarket.clobTokenIds ?? "[]"));
    if (outcomes.length < 2 || tokenIds.length < 2) continue;

    // Match PM outcomes to Kalshi players
    const matchOutcome = (surname: string): number => {
      const surLower = surname.toLowerCase();
      for (let i = 0; i < outcomes.length; i++) {
        const outLower = outcomes[i].toLowerCase();
        if (outLower.includes(surLower) || surLower.includes(outLower.split(" ").pop() ?? "")) return i;
      }
      return -1;
    };

    const pm1Idx = matchOutcome(sur1);
    const pm2Idx = matchOutcome(sur2);
    if (pm1Idx === -1 || pm2Idx === -1) continue;

    // Fetch orderbooks
    let kalBook: { yes: [number, number][]; no: [number, number][] } | null = null;
    let pm1Book: { asks: [number, number][]; bids: [number, number][] };
    let pm2Book: { asks: [number, number][]; bids: [number, number][] };

    try {
      [kalBook, pm1Book, pm2Book] = await Promise.all([
        fetchKalshiOrderbook(kal1.ticker).catch(() => null),
        fetchPmBook(tokenIds[pm1Idx]),
        fetchPmBook(tokenIds[pm2Idx]),
      ]);
    } catch { continue; }

    if (!kalBook) { dbgNoBook++; if (dbgNoBook <= 3) console.log(`  [no KAL book] ${kal1.ticker}`); continue; }

    const matchName = `${sur1} vs ${sur2}`;

    // Check all 4 directions
    // Dir A: buy KAL P1 YES + PM P2 → kalYesAsk levels + PM P2 asks
    // Dir B: buy KAL P2 YES + PM P1
    // Dir C: buy KAL P1 NO  + PM P1
    // Dir D: buy KAL P2 NO  + PM P2

    const directions: { dir: string; kalAsks: [number, number][]; pmAsks: [number, number][]; pmOutcome: string }[] = [
      { dir: "A", kalAsks: deriveYesAsks(kalBook.no), pmAsks: pm2Book.asks, pmOutcome: outcomes[pm2Idx] },
      { dir: "B", kalAsks: deriveYesAsks(kalBook.no.length > 0 ? kalBook.no : []), pmAsks: pm1Book.asks, pmOutcome: outcomes[pm1Idx] },
      { dir: "C", kalAsks: deriveNoAsks(kalBook.yes), pmAsks: pm1Book.asks, pmOutcome: outcomes[pm1Idx] },
      { dir: "D", kalAsks: deriveNoAsks(kalBook.yes), pmAsks: pm2Book.asks, pmOutcome: outcomes[pm2Idx] },
    ];

    // For dir B, we need KAL P2's book
    let kal2Book: { yes: [number, number][]; no: [number, number][] } | null = null;
    try {
      kal2Book = await fetchKalshiOrderbook(kal2.ticker).catch(() => null);
    } catch { /* skip */ }

    if (kal2Book) {
      directions[1].kalAsks = deriveYesAsks(kal2Book.no);
      directions[3].kalAsks = deriveNoAsks(kal2Book.yes);
    }

    for (const { dir, kalAsks, pmAsks } of directions) {
      if (kalAsks.length === 0 || pmAsks.length === 0) continue;

      const bestKalAsk = kalAsks[0][0] / 100;
      const bestPmAsk = pmAsks[0][0];
      const rawEdge = 1 - bestKalAsk - bestPmAsk;
      const netEdge = rawEdge - estimateFees(bestKalAsk, bestPmAsk);

      dbgChecked++;
      if (rawEdge <= 0) continue;

      // Sweep depth for profitable shares
      const fees = estimateFees(bestKalAsk, bestPmAsk);
      const kalMaxCents = Math.floor((1 - bestPmAsk - fees) * 100);
      const pmMaxPrice = 1 - bestKalAsk - fees;
      const kalDepth = sweepAll(kalAsks, kalMaxCents);
      const pmDepth = sweepPmAsks(pmAsks, pmMaxPrice);
      const maxShares = Math.min(kalDepth.qty, Math.floor(pmDepth.qty));
      const kalAvgPrice = kalDepth.avgPrice / 100;
      const pmAvgPrice = pmDepth.avgPrice;
      const maxCapital = maxShares > 0 ? Math.round(maxShares * (kalAvgPrice + pmAvgPrice) * 100) / 100 : 0;

      const entry: Result = {
        match: matchName, dir, rawEdge, netEdge,
        kalMaxQty: kalDepth.qty, pmMaxQty: Math.floor(pmDepth.qty),
        maxShares, maxCapital, kalBestAsk: bestKalAsk, pmBestAsk: bestPmAsk,
      };

      if (netEdge > 0 && maxShares > 0) {
        results.push(entry);
      } else {
        nearMisses.push(entry);
      }
    }

    await sleep(100); // rate limit
  }

  console.log(`\nScan: ${pairs.length} pairs → ${pairs.length - dbgNoPm} PM matched → ${pairs.length - dbgNoPm - dbgNoBook} with books → ${dbgChecked} directions checked\n`);

  // Sort results by capital, near-misses by raw edge
  results.sort((a, b) => b.maxCapital - a.maxCapital);
  nearMisses.sort((a, b) => b.rawEdge - a.rawEdge);

  const printRow = (r: Result) => {
    console.log(
      r.match.slice(0, 30).padEnd(31) +
      r.dir.padEnd(5) +
      ((r.rawEdge * 100).toFixed(1) + "%").padStart(6).padEnd(9) +
      ((r.netEdge * 100).toFixed(1) + "%").padStart(6).padEnd(9) +
      ("$" + r.kalBestAsk.toFixed(2)).padStart(6).padEnd(9) +
      ("$" + r.pmBestAsk.toFixed(2)).padStart(6).padEnd(9) +
      String(r.maxShares).padStart(7).padEnd(10) +
      ("$" + r.maxCapital.toFixed(0)).padStart(8).padEnd(10)
    );
  };

  const header =
    "MATCH".padEnd(31) + "DIR".padEnd(5) + "RAW %".padEnd(9) + "NET %".padEnd(9) +
    "KAL ASK".padEnd(9) + "PM ASK".padEnd(9) + "SHARES".padEnd(10) + "MAX $".padEnd(10);

  if (results.length > 0) {
    console.log(`=== ${results.length} PROFITABLE OPPORTUNITIES (net edge > 0) ===\n`);
    console.log(header);
    console.log("-".repeat(92));
    let total = 0;
    for (const r of results) { total += r.maxCapital; printRow(r); }
    console.log("-".repeat(92));
    console.log(`TOTAL MAX DEPLOYABLE: $${total.toFixed(2)} across ${results.length} opportunities\n`);
  } else {
    console.log("No profitable arb opportunities (net edge > 0) found right now.\n");
  }

  if (nearMisses.length > 0) {
    console.log(`=== ${nearMisses.length} NEAR-MISS OPPORTUNITIES (raw edge > 0 but fees eat profit) ===\n`);
    console.log(header);
    console.log("-".repeat(92));
    for (const r of nearMisses.slice(0, 15)) printRow(r);
    if (nearMisses.length > 15) console.log(`  ... and ${nearMisses.length - 15} more`);
    console.log("");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
