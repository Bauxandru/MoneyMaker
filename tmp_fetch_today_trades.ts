import dotenv from "dotenv";
dotenv.config();

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./src/polyAuth.js";

const TARGET_DATE = "2026-03-24";

async function main() {
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);

  console.log("=== Polymarket CLOB Trade Fetcher ===");
  console.log(`Wallet address: ${wallet.address}`);
  console.log(`POLY_FUNDER:    ${funder ?? "(not set)"}`);
  console.log(`Target date:    ${TARGET_DATE}`);
  console.log(`Host:           ${host}`);
  console.log();

  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  // Fetch ALL trades (getTrades with no params auto-paginates)
  console.log("Fetching all CLOB trades...");
  const allTrades: any[] = (await client.getTrades()) as any[];
  console.log(`Total trades returned: ${allTrades.length}`);

  // Show a sample to understand match_time format
  if (allTrades.length > 0) {
    console.log(`\nSample match_time value: "${allTrades[0].match_time}" (type: ${typeof allTrades[0].match_time})`);
    console.log(`Sample raw trade keys: ${Object.keys(allTrades[0]).join(", ")}`);
    console.log(`Sample raw trade: ${JSON.stringify(allTrades[0], null, 2)}`);
  }

  // Filter to target date BUY trades
  const todayBuys = allTrades.filter((t) => {
    if (t.side !== "BUY") return false;
    const mt = t.match_time;
    // Handle both ISO string and Unix seconds
    let dateStr: string;
    if (typeof mt === "number" || /^\d+$/.test(mt)) {
      const ms = Number(mt) < 1e12 ? Number(mt) * 1000 : Number(mt);
      dateStr = new Date(ms).toISOString().slice(0, 10);
    } else {
      dateStr = new Date(mt).toISOString().slice(0, 10);
    }
    return dateStr === TARGET_DATE;
  });

  console.log(`\nBUY trades on ${TARGET_DATE}: ${todayBuys.length}`);

  if (todayBuys.length === 0) {
    console.log("No BUY trades found for today. Showing all trade dates for reference:");
    const dateCounts = new Map<string, number>();
    for (const t of allTrades) {
      const mt = t.match_time;
      let dateStr: string;
      if (typeof mt === "number" || /^\d+$/.test(mt)) {
        const ms = Number(mt) < 1e12 ? Number(mt) * 1000 : Number(mt);
        dateStr = new Date(ms).toISOString().slice(0, 10);
      } else {
        dateStr = new Date(mt).toISOString().slice(0, 10);
      }
      dateCounts.set(dateStr, (dateCounts.get(dateStr) ?? 0) + 1);
    }
    const sorted = [...dateCounts.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [d, c] of sorted.slice(0, 20)) {
      console.log(`  ${d}: ${c} trades`);
    }
    return;
  }

  // Group by asset_id
  const grouped = new Map<string, any[]>();
  for (const t of todayBuys) {
    const arr = grouped.get(t.asset_id) ?? [];
    arr.push(t);
    grouped.set(t.asset_id, arr);
  }

  console.log(`Unique token IDs: ${grouped.size}\n`);
  console.log("=".repeat(120));

  for (const [assetId, fills] of grouped) {
    const totalShares = fills.reduce((s, f) => s + Number(f.size), 0);
    const totalCost = fills.reduce((s, f) => s + Number(f.size) * Number(f.price), 0);
    const avgPrice = totalCost / totalShares;

    console.log(`\nToken ID: ${assetId}`);
    console.log(`  Total shares bought: ${totalShares.toFixed(4)}`);
    console.log(`  Total cost (USDC):   ${totalCost.toFixed(6)}`);
    console.log(`  Avg price:           ${avgPrice.toFixed(6)}`);
    console.log(`  Number of fills:     ${fills.length}`);
    console.log(`  Individual fills:`);

    for (let i = 0; i < fills.length; i++) {
      const f = fills[i];
      const mt = f.match_time;
      let timeStr: string;
      if (typeof mt === "number" || /^\d+$/.test(mt)) {
        const ms = Number(mt) < 1e12 ? Number(mt) * 1000 : Number(mt);
        timeStr = new Date(ms).toISOString();
      } else {
        timeStr = mt;
      }
      console.log(`    [${i + 1}] size=${f.size}, price=${f.price}, match_time=${timeStr}, fee_rate_bps=${f.fee_rate_bps}, id=${f.id ?? "N/A"}, order_id=${f.order_id ?? "N/A"}, status=${f.status ?? "N/A"}, trader_side=${f.trader_side ?? "N/A"}`);
    }

    // Dump full raw JSON for every fill
    console.log(`  Full raw fills JSON:`);
    for (let i = 0; i < fills.length; i++) {
      console.log(`    --- fill ${i + 1} ---`);
      console.log(`    ${JSON.stringify(fills[i])}`);
    }
  }

  console.log("\n" + "=".repeat(120));
  console.log("Done.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
