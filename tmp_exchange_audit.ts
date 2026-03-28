import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { fetchAllKalshiFills, fetchAllKalshiSettlements } from "./src/kalshiTrade.js";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { resolvePolyApiCreds } from "./src/polyAuth.js";

async function main() {
  const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));

  // 1. Fetch ALL Kalshi fills
  console.log("Fetching Kalshi fills...");
  const kalFills = await fetchAllKalshiFills();
  console.log(`  ${kalFills.length} Kalshi fills total`);

  // Group by ticker
  const kalByTicker = new Map<string, { buys: number; sells: number; totalCost: number; totalFees: number; fills: any[] }>();
  for (const f of kalFills) {
    const entry = kalByTicker.get(f.ticker) || { buys: 0, sells: 0, totalCost: 0, totalFees: 0, fills: [] };
    if (f.action === "buy") {
      entry.buys += f.count;
      const price = f.side === "yes" ? f.yesPrice : f.noPrice;
      entry.totalCost += f.count * price / 100;
    } else {
      entry.sells += f.count;
    }
    entry.totalFees += f.feeCost;
    entry.fills.push(f);
    kalByTicker.set(f.ticker, entry);
  }

  const settlements = await fetchAllKalshiSettlements();
  const settledTickers = new Set(settlements.map((s: any) => s.ticker));

  console.log("\n=== KALSHI OPEN POSITIONS (buys - sells > 0) ===");
  for (const [ticker, pos] of [...kalByTicker.entries()].sort()) {
    const net = pos.buys - pos.sells;
    if (net <= 0) continue;
    const settled = settledTickers.has(ticker) ? "SETTLED" : "OPEN";
    const tracked = trades.find((t: any) => t.kalTicker === ticker);
    const trackedStr = tracked ? `tracked (${tracked.shares}sh)` : "*** NOT TRACKED ***";
    console.log(`  ${ticker}: ${net} contracts, cost=$${pos.totalCost.toFixed(2)}, fees=$${pos.totalFees.toFixed(2)}, ${settled}, ${trackedStr}`);
  }

  // 2. Fetch ALL PM CLOB trades
  console.log("\nFetching PM CLOB trades...");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  interface ClobTrade {
    asset_id: string; size: string; price: string; fee_rate_bps: string;
    side: string; status: string; match_time: string; outcome: string;
    market: string; title: string;
  }
  const clobTrades = (await client.getTrades()) as unknown as ClobTrade[];
  console.log(`  ${clobTrades.length} PM CLOB trades total`);

  // Group PM trades by asset_id (token)
  const pmByToken = new Map<string, { buys: number; sells: number; totalCost: number; trades: ClobTrade[] }>();
  for (const ct of clobTrades) {
    if (ct.status !== "CONFIRMED") continue;
    const entry = pmByToken.get(ct.asset_id) || { buys: 0, sells: 0, totalCost: 0, trades: [] };
    const size = Number(ct.size);
    const price = Number(ct.price);
    if (ct.side === "BUY") {
      entry.buys += size;
      entry.totalCost += size * price;
    } else {
      entry.sells += size;
    }
    entry.trades.push(ct);
    pmByToken.set(ct.asset_id, entry);
  }

  // Find PM tokens with net positive positions
  console.log("\n=== PM TOKENS WITH NET BUYS > 0 (recent, unsettled) ===");
  // Only show tokens with trades after Mar 4
  for (const [tokenId, pos] of pmByToken) {
    const net = pos.buys - pos.sells;
    if (net <= 0) continue;
    const recentTrades = pos.trades.filter(t => {
      const ts = Number(t.match_time) * 1000;
      return ts > new Date("2026-03-04").getTime();
    });
    if (recentTrades.length === 0) continue;

    const tracked = trades.find((t: any) => t.pmTokenId === tokenId);
    const trackedStr = tracked ? `tracked (${tracked.shares}sh, ${tracked.match})` : "*** NOT TRACKED ***";

    // Show individual trades for untracked positions
    console.log(`  token=${tokenId.slice(0, 30)}... | net=${net} | cost=$${pos.totalCost.toFixed(2)} | ${trackedStr}`);
    if (!tracked) {
      for (const t of recentTrades) {
        const ts = new Date(Number(t.match_time) * 1000).toISOString();
        console.log(`    ${ts} | ${t.side} ${t.size}@${t.price} | fee=${t.fee_rate_bps}bps`);
      }
    }
  }

  // 3. Cross-reference: trades in arb_trades.json that don't match exchange positions
  console.log("\n=== TRADES WITH NO MATCHING EXCHANGE POSITION ===");
  for (const t of trades) {
    if (t.status !== "resolved" && t.status !== "filled") continue;
    const kalPos = kalByTicker.get(t.kalTicker);
    const kalNet = kalPos ? kalPos.buys - kalPos.sells : 0;
    const pmPos = pmByToken.get(t.pmTokenId);
    const pmNet = pmPos ? pmPos.buys - pmPos.sells : 0;
    if (kalNet <= 0 && pmNet <= 0 && !settledTickers.has(t.kalTicker)) {
      console.log(`  ${t.match} (${t.id}): NO exchange position found — kalNet=${kalNet}, pmNet=${pmNet}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
