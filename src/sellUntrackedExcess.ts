/**
 * sellUntrackedExcess.ts -- Sell the on-chain PM excess (on-chain > recorded shares)
 * for each corrupt trade, but only if current best bid > our avg buy price (profitable exit).
 *
 * Reads data/verify_today.json (run verifyToday.ts first).
 * LIVE ORDERS -- no dry run. Requires POLY_WALLET_PRIVATE_KEY and approved CLOB allowance.
 *
 * Usage:
 *   npx tsx src/verifyToday.ts 2026-04-14     # refresh verify report
 *   npx tsx src/sellUntrackedExcess.ts         # execute
 */
import fs from "fs";
import dotenv from "dotenv";
import { placePmFAKSell } from "./ARB/ttPmOrders.js";

dotenv.config();

const GAMMA = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const CLOB = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

type Diff = {
  tradeId: string;
  match: string;
  status: string;
  recorded: { shares: number; kalCost: number; pmCost: number; totalCost: number; realizedPnl: number | null };
  kalActual: { fillCount: number; shares: number; cost: number; fees: number } | null;
  pmActual: { fillCount: number; shares: number; cost: number; avgPrice: number } | null;
  onChainBalance: number | null;
  settlement: { result: string; payout: number } | null;
  severity: "ok" | "minor" | "corrupt";
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
  return (await r.json()) as T;
}

/** Get tickSize + negRisk for a token via gamma. */
async function getMarketForToken(tokenId: string): Promise<{ tickSize: number; negRisk: boolean } | null> {
  try {
    const data = await fetchJson<any[]>(`${GAMMA}/markets?clob_token_ids=${encodeURIComponent(tokenId)}`);
    const m = Array.isArray(data) ? data[0] : null;
    if (!m) return null;
    return {
      tickSize: Number(m.orderPriceMinTickSize ?? 0.01),
      negRisk: Boolean(m.negRisk),
    };
  } catch (e) {
    console.warn(`  [MKT] gamma fetch failed: ${(e as Error).message}`);
    return null;
  }
}

/** Get current best bid (price at which we can sell instantly). */
async function getBestBid(tokenId: string): Promise<number | null> {
  try {
    const book = await fetchJson<{ bids?: Array<{ price: string; size: string }> }>(
      `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    if (!Array.isArray(book.bids) || book.bids.length === 0) return null;
    let best = 0;
    for (const b of book.bids) {
      const p = Number(b.price);
      if (Number.isFinite(p) && p > best) best = p;
    }
    return best > 0 ? best : null;
  } catch (e) {
    console.warn(`  [BOOK] fetch failed: ${(e as Error).message}`);
    return null;
  }
}

async function main() {
  const reportPath = "data/verify_today.json";
  if (!fs.existsSync(reportPath)) {
    console.error(`Missing ${reportPath} -- run verifyToday.ts first.`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as { diffs: Diff[]; date: string };
  console.log(`\n=== Sell untracked PM excess for ${report.date} ===\n`);

  // Need trades to get pmTokenId (not stored in verify report)
  const trades: any[] = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
  const tradeById = new Map(trades.map((t) => [t.id, t]));

  // Find candidates: on-chain > recorded.shares
  const candidates: Array<{ diff: Diff; excess: number; trade: any }> = [];
  for (const d of report.diffs) {
    if (d.onChainBalance == null) continue;
    const excess = d.onChainBalance - d.recorded.shares;
    if (excess < 1) continue; // fractional or none
    const trade = tradeById.get(d.tradeId);
    if (!trade || !trade.pmTokenId) continue;
    candidates.push({ diff: d, excess: Math.floor(excess), trade });
  }

  console.log(`Candidates with on-chain excess >= 1 share: ${candidates.length}\n`);
  if (candidates.length === 0) return;

  let fired = 0, skipped = 0, failed = 0, totalRecovered = 0;

  for (const { diff, excess, trade } of candidates) {
    console.log(`\n--- ${diff.match} | trade ${diff.tradeId} ---`);
    console.log(`  onChain=${diff.onChainBalance} recorded=${diff.recorded.shares} excess=${excess}`);

    // Compute avg buy price: prefer actual CLOB data, else recorded cost/shares
    let avgBuy: number;
    if (diff.pmActual && diff.pmActual.shares > 0) {
      avgBuy = diff.pmActual.avgPrice;
      console.log(`  avg buy (from CLOB actual): ${(avgBuy * 100).toFixed(1)}c`);
    } else if (diff.recorded.shares > 0 && diff.recorded.pmCost > 0) {
      avgBuy = diff.recorded.pmCost / diff.recorded.shares;
      console.log(`  avg buy (from record): ${(avgBuy * 100).toFixed(1)}c`);
    } else {
      console.log(`  [SKIP] no avg buy price available`);
      skipped++;
      continue;
    }

    const tokenId = trade.pmTokenId as string;
    const [market, bestBid] = await Promise.all([getMarketForToken(tokenId), getBestBid(tokenId)]);
    if (!market) {
      console.log(`  [SKIP] market info unavailable`);
      skipped++;
      continue;
    }
    if (bestBid == null) {
      console.log(`  [SKIP] no bids on book`);
      skipped++;
      continue;
    }
    console.log(`  market: tickSize=${market.tickSize} negRisk=${market.negRisk}  bestBid=${(bestBid * 100).toFixed(1)}c`);

    if (bestBid <= avgBuy) {
      console.log(`  [SKIP] bestBid ${(bestBid * 100).toFixed(1)}c <= avgBuy ${(avgBuy * 100).toFixed(1)}c (not profitable)`);
      skipped++;
      continue;
    }

    // Fire FAK SELL at bestBid for `excess` shares
    const projectedRevenue = bestBid * excess;
    console.log(`  ★ PLACING FAK SELL ${excess} shares @ ${(bestBid * 100).toFixed(1)}c (projected revenue $${projectedRevenue.toFixed(2)})`);
    try {
      const res = await placePmFAKSell(tokenId, bestBid, excess, market.tickSize, market.negRisk, false /* NOT dry-run */);
      console.log(`  RESULT:`, JSON.stringify(res));
      fired++;
      totalRecovered += projectedRevenue;
    } catch (e) {
      console.error(`  FAILED: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log("\n" + "=".repeat(90));
  console.log("SUMMARY");
  console.log("=".repeat(90));
  console.log(`Candidates: ${candidates.length}`);
  console.log(`  Fired:     ${fired}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`Projected revenue (if all fills): $${totalRecovered.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
