import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { fetchAllKalshiFills, fetchAllKalshiSettlements } from "./src/kalshiTrade.js";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { resolvePolyApiCreds } from "./src/polyAuth.js";
import { fetchJsonWithRetry } from "./src/http.js";

const KAL_BASE = "https://api.elections.kalshi.com/trade-api/v2";

async function main() {
  // 1. Load arb_trades.json
  const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
  console.log(`=== ARB TRADES (${trades.length} total) ===\n`);

  // Active trades (not fully resolved)
  const active = trades.filter((t: any) => t.status === "filled" || t.status === "hedging");
  const resolved = trades.filter((t: any) => t.status === "resolved");
  console.log(`Active/open: ${active.length}, Resolved: ${resolved.length}\n`);

  if (active.length > 0) {
    console.log("--- ACTIVE TRADES ---");
    for (const t of active) {
      console.log(`  ${t.id} | ${t.match} | status=${t.status} | method=${t.resolutionMethod || '--'}`);
      console.log(`    shares=${t.shares} kal=${t.kalTicker} dir=${t.dir}`);
      console.log(`    kalCost=$${t.kalCost} pmCost=$${t.pmCost} totalCost=$${t.totalCost} pnl=$${t.realizedPnl ?? '?'}`);
    }
    console.log("");
  }

  // 2. Fetch Kalshi open positions
  console.log("=== KALSHI POSITIONS (from fills) ===");
  const fills = await fetchAllKalshiFills();
  const settlements = await fetchAllKalshiSettlements();
  const settledTickers = new Set(settlements.map((s: any) => s.ticker));

  // Group fills by ticker
  const posByTicker = new Map<string, { buys: number; sells: number; cost: number; fees: number }>();
  for (const f of fills) {
    const entry = posByTicker.get(f.ticker) || { buys: 0, sells: 0, cost: 0, fees: 0 };
    if (f.action === "buy") {
      entry.buys += f.count;
      const price = f.side === "yes" ? f.yesPrice : f.noPrice;
      entry.cost += f.count * price / 100;
    } else {
      entry.sells += f.count;
    }
    entry.fees += f.feeCost;
    posByTicker.set(f.ticker, entry);
  }

  // Open positions = buys - sells > 0 and not settled
  console.log("\nTicker".padEnd(50) + " | Net | Cost    | Fees   | Settled?");
  console.log("-".repeat(100));
  for (const [ticker, pos] of [...posByTicker.entries()].sort()) {
    const net = pos.buys - pos.sells;
    if (net <= 0) continue;
    const settled = settledTickers.has(ticker) ? "YES" : "no";
    console.log(`${ticker.padEnd(50)} | ${String(net).padStart(3)} | $${pos.cost.toFixed(2).padStart(7)} | $${pos.fees.toFixed(2).padStart(5)} | ${settled}`);
  }

  // 3. Fetch PM positions
  console.log("\n=== POLYMARKET POSITIONS ===");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  // Get positions from data API
  const dataApi = "https://data-api.polymarket.com";
  const pmPositions = await fetchJsonWithRetry(`${dataApi}/positions?user=${encodeURIComponent(funder!)}&sizeThreshold=0.1`) as any;
  const pmPos = Array.isArray(pmPositions) ? pmPositions : (pmPositions?.positions || []);

  console.log(`\nPM positions: ${pmPos.length}`);
  for (const p of pmPos) {
    const size = Number(p.size || p.shares || 0);
    if (size < 0.5) continue;
    const title = p.market?.question || p.title || p.slug || "?";
    const outcome = p.outcome || p.asset?.outcome || "?";
    const avgPrice = p.avgPrice || p.avg_price || "?";
    const curPrice = p.curPrice || p.cur_price || "?";
    console.log(`  ${title.slice(0, 60)}`);
    console.log(`    outcome=${outcome} size=${size} avgPrice=${avgPrice} curPrice=${curPrice}`);
    console.log(`    tokenId=${(p.asset_id || p.asset?.token_id || p.tokenId || "?").slice(0, 30)}...`);
  }

  // 4. Dashboard stats computation
  console.log("\n=== DASHBOARD P&L COMPUTATION ===");
  let totalPnl = 0;
  let capitalDeployed = 0;
  let wins = 0, losses = 0;

  for (const t of trades) {
    if (t.status !== "resolved") continue;
    const pnl = t.realizedPnl ?? 0;
    totalPnl += pnl;
    capitalDeployed += t.totalCost ?? 0;
    if (pnl > 0) wins++;
    else if (pnl < 0) losses++;
  }

  console.log(`Resolved trades: ${resolved.length}`);
  console.log(`Total P&L: $${totalPnl.toFixed(2)}`);
  console.log(`Capital deployed: $${capitalDeployed.toFixed(2)}`);
  console.log(`Wins: ${wins}, Losses: ${losses}, Breakeven: ${resolved.length - wins - losses}`);

  // 5. Cross-reference: arb trades vs actual positions
  console.log("\n=== CROSS-REFERENCE: Active arb trades vs exchange positions ===\n");
  for (const t of active) {
    const kalPos = posByTicker.get(t.kalTicker);
    const kalNet = kalPos ? kalPos.buys - kalPos.sells : 0;
    const kalSettled = settledTickers.has(t.kalTicker);

    let pmHeld = 0;
    if (t.pmTokenId) {
      for (const p of pmPos) {
        const tokenId = p.asset_id || p.asset?.token_id || p.tokenId || "";
        if (tokenId === t.pmTokenId) {
          pmHeld = Number(p.size || p.shares || 0);
        }
      }
    }

    const kalOk = kalNet >= t.shares;
    const pmOk = pmHeld >= t.shares * 0.9;

    console.log(`${t.match} (${t.id})`);
    console.log(`  Expected: ${t.shares} shares on each exchange`);
    console.log(`  Kalshi:   ${kalNet} contracts (${kalSettled ? 'SETTLED' : 'open'}) ${kalOk ? 'OK' : '*** MISMATCH ***'}`);
    console.log(`  PM:       ${pmHeld.toFixed(1)} shares ${pmOk ? 'OK' : '*** MISMATCH ***'}`);
    console.log("");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
