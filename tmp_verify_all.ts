import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { fetchAllKalshiFills } from "./src/kalshiTrade.js";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { resolvePolyApiCreds } from "./src/polyAuth.js";

interface ClobTrade {
  asset_id: string;
  size: string;
  price: string;
  fee_rate_bps: string;
  side: string;
  status: string;
  match_time: string;
}

async function main() {
  const trades = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));
  console.log(`Trades to verify: ${trades.length}\n`);

  // Fetch Kalshi fills
  console.log("Fetching Kalshi fills...");
  const kalFills = await fetchAllKalshiFills();
  console.log(`  ${kalFills.length} Kalshi fills`);

  // Fetch PM CLOB trades
  console.log("Fetching PM CLOB trades...");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  const clobTrades = (await client.getTrades()) as unknown as ClobTrade[];
  console.log(`  ${clobTrades.length} PM CLOB trades\n`);

  // Index Kalshi fills by ticker
  const kalByTicker = new Map<string, typeof kalFills>();
  for (const f of kalFills) {
    if (f.action !== "buy") continue;
    const list = kalByTicker.get(f.ticker) ?? [];
    list.push(f);
    kalByTicker.set(f.ticker, list);
  }

  // Index PM fills by token
  const pmByToken = new Map<string, ClobTrade[]>();
  for (const ct of clobTrades) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    const list = pmByToken.get(ct.asset_id) ?? [];
    list.push(ct);
    pmByToken.set(ct.asset_id, list);
  }

  // Check each trade
  let bothVerified = 0, kalOnly = 0, pmOnly = 0, neither = 0;
  const issues: string[] = [];

  console.log("Match".padEnd(40) + " | Date       | Shares | KAL fill | PM fill  | Status");
  console.log("-".repeat(120));

  for (const t of trades) {
    const arbMs = new Date(t.ts).getTime();
    const date = t.ts.slice(0, 10);

    // Match Kalshi fill by ticker + timestamp proximity
    const kalCandidates = kalByTicker.get(t.kalTicker) ?? [];
    let kalMatch = false;
    let kalFillCount = 0;
    for (const f of kalCandidates) {
      const fillMs = new Date(f.ts).getTime();
      if (Math.abs(fillMs - arbMs) < 120_000) {
        kalMatch = true;
        kalFillCount += f.count;
      }
    }

    // Match PM fill by tokenId + timestamp proximity
    let pmMatch = false;
    let pmFillSize = 0;
    if (t.pmTokenId) {
      const pmCandidates = pmByToken.get(t.pmTokenId) ?? [];
      for (const ct of pmCandidates) {
        const fillMs = Number(ct.match_time) * 1000;
        if (Math.abs(fillMs - arbMs) < 120_000) {
          pmMatch = true;
          pmFillSize += Number(ct.size);
        }
      }
    }

    const kalStatus = kalMatch ? `YES (${kalFillCount})` : "NO";
    const pmStatus = pmMatch ? `YES (${pmFillSize})` : (t.pmTokenId ? "NO" : "no tokenId");

    if (kalMatch && pmMatch) bothVerified++;
    else if (kalMatch) kalOnly++;
    else if (pmMatch) pmOnly++;
    else neither++;

    const flag = (!kalMatch || !pmMatch) ? " ***" : "";
    const match = t.match.slice(0, 40).padEnd(40);
    console.log(`${match} | ${date} | ${String(t.shares).padStart(6)} | ${kalStatus.padEnd(8)} | ${pmStatus.padEnd(8)} | ${t.resolutionMethod || t.status}${flag}`);

    if (!kalMatch && !pmMatch) {
      issues.push(`${t.id} ${t.match} (${date}) — NO fills on either exchange`);
    } else if (!kalMatch) {
      issues.push(`${t.id} ${t.match} (${date}) — Kalshi fill missing (ticker=${t.kalTicker})`);
    } else if (!pmMatch) {
      issues.push(`${t.id} ${t.match} (${date}) — PM fill missing (tokenId=${t.pmTokenId?.slice(0,16) || 'none'})`);
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(`Both exchanges verified: ${bothVerified}`);
  console.log(`Kalshi only: ${kalOnly}`);
  console.log(`PM only: ${pmOnly}`);
  console.log(`Neither: ${neither}`);

  if (issues.length > 0) {
    console.log(`\n=== ISSUES (${issues.length}) ===`);
    for (const i of issues) console.log(`  ${i}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
