import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";
import { fetchAllKalshiFills, fetchAllKalshiSettlements } from "./kalshiTrade.js";

async function main() {
  console.log("=== METANOIA WOLVES FULL AUDIT ===\n");

  // -- 1. Kalshi fills --
  console.log("--- KALSHI FILLS ---");
  const allKalFills = await fetchAllKalshiFills();
  const mwKalFills = allKalFills.filter(f =>
    f.ticker?.toUpperCase().includes("MW") ||
    f.ticker?.toUpperCase().includes("METANOIA") ||
    f.ticker?.toUpperCase().includes("BACMW") ||
    f.ticker?.toUpperCase().includes("MWBHE") ||
    f.ticker?.toUpperCase().includes("PAINAMW")
  );
  console.log(`Found ${mwKalFills.length} Kalshi fills with MW/METANOIA:`);
  let kalTotalSpent = 0;
  let kalTotalFees = 0;
  for (const f of mwKalFills) {
    const cost = (f as any).count * (f as any).price / 100; // cents to dollars
    console.log(`  ${f.ticker} | ${f.action} ${f.side} x${(f as any).count} @ ${(f as any).price}c | cost=$${((f as any).count * (f as any).price / 100).toFixed(2)} | fee=$${f.feeCost?.toFixed(2)} | ${(f as any).created_time || (f as any).ts}`);
    if (f.action === "buy") {
      kalTotalSpent += (f as any).count * (f as any).price / 100;
      kalTotalFees += f.feeCost || 0;
    }
  }
  console.log(`Kalshi total spent: $${kalTotalSpent.toFixed(2)}, total fees: $${kalTotalFees.toFixed(2)}\n`);

  // -- 2. Kalshi settlements --
  console.log("--- KALSHI SETTLEMENTS ---");
  const allSettlements = await fetchAllKalshiSettlements();
  const mwSettlements = allSettlements.filter((s: any) =>
    s.ticker?.toUpperCase().includes("MW") ||
    s.ticker?.toUpperCase().includes("METANOIA") ||
    s.ticker?.toUpperCase().includes("BACMW") ||
    s.ticker?.toUpperCase().includes("PAINAMW")
  );
  console.log(`Found ${mwSettlements.length} Kalshi settlements:`);
  for (const s of mwSettlements) {
    console.log(`  ${JSON.stringify(s)}`);
  }
  console.log("");

  // -- 3. PM CLOB fills --
  console.log("--- PM CLOB FILLS ---");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  const pmFills = (await client.getTrades()) as any[];

  // Token IDs from the trades
  const tokenIds: Record<string, string> = {
    "Back to Back (arb-1773763165187)": "58372017685980635646784362638300423909987201684642588122185701032502552065402",
    "MW token (arb-1773763165187 other side)": "112322018357526834859700464391179829707565101189304210843630272088404644364147",
    "paiN Academy (arb-1773418063006)": "60762272445890283906186828654560086870808925997056192870739799964732131635246",
    "MW (arb-1773418063006 other)": "72769451865083851058999281502094505803552854417442680541920137415269668328191",
    "MW (arb-1773940910103 BHE)": "60195534319873465425150234758782279226204047380656388696139063626506017571489",
    "BHE token": "42965093639936702498498580088639943661694015050548449793424741608564789855596",
  };

  for (const [label, tokenId] of Object.entries(tokenIds)) {
    const fills = pmFills.filter((f: any) => f.asset_id === tokenId);
    if (fills.length > 0) {
      console.log(`\n  ${label} (${tokenId.slice(0,15)}...):`);
      let totalShares = 0;
      let totalCost = 0;
      for (const f of fills) {
        const size = Number(f.size);
        const price = Number(f.price);
        const side = f.side;
        const fee = Number(f.fee_rate_bps || 0);
        console.log(`    ${side} ${size} @ $${price.toFixed(3)} = $${(size*price).toFixed(2)} | fee_bps=${fee} | status=${f.status} | ${f.match_time || f.created_at || '?'}`);
        if (side === "BUY" && f.status === "CONFIRMED") {
          totalShares += size;
          totalCost += size * price;
        }
      }
      console.log(`    TOTAL: ${totalShares} shares, $${totalCost.toFixed(2)} cost`);
    }
  }

  // Also check for ANY fills with METANOIA-related tokens we might have missed
  console.log("\n  --- Searching ALL PM fills for unknown MW tokens ---");
  const knownTokens = new Set(Object.values(tokenIds));
  // We can't easily search by name, but let's check if there are fills we don't know about
  // by looking at fills near the trade timestamps
  const mar17Fills = pmFills.filter((f: any) => {
    const ts = f.match_time || f.created_at || "";
    return ts.includes("2026-03-17") || ts.includes("2026-03-18");
  });
  console.log(`  PM fills on Mar 17-18: ${mar17Fills.length} total`);
  const mar17Unknown = mar17Fills.filter((f: any) => !knownTokens.has(f.asset_id));
  // Show just BUY fills
  const mar17Buys = mar17Fills.filter((f: any) => f.side === "BUY");
  console.log(`  PM BUY fills on Mar 17-18: ${mar17Buys.length}`);
  for (const f of mar17Buys) {
    const inKnown = knownTokens.has(f.asset_id) ? "KNOWN" : "UNKNOWN";
    console.log(`    ${inKnown} | ${Number(f.size)} @ $${Number(f.price).toFixed(3)} = $${(Number(f.size)*Number(f.price)).toFixed(2)} | token=${f.asset_id?.slice(0,20)}... | ${f.match_time || f.created_at}`);
  }

  // -- 4. Compare with trade records --
  console.log("\n\n--- TRADE RECORD COMPARISON ---");
  const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
  const mwTrades = trades.filter((t: any) => JSON.stringify(t).toUpperCase().includes("METANOIA"));

  for (const t of mwTrades) {
    console.log(`\nTrade ${t.id}:`);
    console.log(`  Record: ${t.shares} shares, KAL $${t.kalCost} + PM $${t.pmCost} = $${t.totalCost}, P&L $${t.realizedPnl}`);

    // Find matching Kalshi fills
    if (t.kalTicker) {
      const kf = mwKalFills.filter(f => f.ticker === t.kalTicker && f.action === "buy");
      const kShares = kf.reduce((s: number, f: any) => s + f.count, 0);
      const kCost = kf.reduce((s: number, f: any) => s + f.count * f.price / 100, 0);
      const kFees = kf.reduce((s: number, f: any) => s + (f.feeCost || 0), 0);
      console.log(`  Kalshi ACTUAL: ${kShares} shares, cost $${kCost.toFixed(2)}, fees $${kFees.toFixed(2)}, total $${(kCost + kFees).toFixed(2)}`);
      if (kShares !== t.shares) console.log(`  [!] SHARE MISMATCH: record=${t.shares} actual=${kShares}`);
      if (Math.abs(kCost + kFees - t.kalCost) > 0.02) console.log(`  [!] COST MISMATCH: record=$${t.kalCost} actual=$${(kCost + kFees).toFixed(2)}`);
    }

    // Find matching PM fills
    if (t.pmTokenId) {
      const pf = pmFills.filter((f: any) => f.asset_id === t.pmTokenId && f.side === "BUY" && f.status === "CONFIRMED");
      const pShares = pf.reduce((s: number, f: any) => s + Number(f.size), 0);
      const pCost = pf.reduce((s: number, f: any) => s + Number(f.size) * Number(f.price), 0);
      console.log(`  PM ACTUAL: ${pShares} shares, cost $${pCost.toFixed(2)}`);
      if (pShares !== t.shares) console.log(`  [!] PM SHARE MISMATCH: record=${t.shares} actual=${pShares}`);
      if (Math.abs(pCost - t.pmCost) > 0.02) console.log(`  [!] PM COST MISMATCH: record=$${t.pmCost} actual=$${pCost.toFixed(2)}`);
    }
  }

  // -- 5. Check PM open orders for current trade --
  console.log("\n\n--- PM OPEN ORDERS ---");
  try {
    const openOrders = await (client as any).getOpenOrders();
    const mwOrders = (Array.isArray(openOrders) ? openOrders : []).filter((o: any) => {
      const tokenIds = Object.values(tokenIds);
      return true; // show all for now
    });
    console.log(`Total open PM orders: ${Array.isArray(openOrders) ? openOrders.length : 0}`);
    if (Array.isArray(openOrders)) {
      for (const o of openOrders) {
        console.log(`  ${o.side} ${o.original_size} @ $${o.price} | filled=${o.size_matched} | token=${(o.asset_id || '').slice(0,20)}... | status=${o.status}`);
      }
    }
  } catch (e: any) {
    console.log("Could not fetch open orders:", e.message);
  }
}

main().catch(e => console.error("AUDIT ERROR:", e));
