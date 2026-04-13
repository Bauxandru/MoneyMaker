/**
 * Backfill untracked PM fills into arb_trades.json.
 * - Resolves each token to a market via Gamma API
 * - Checks settlement outcome (resolved_at, winner)
 * - Calculates P&L: won -> shares - cost, lost -> -cost
 * - Creates "pm-backfill" trade records
 */
import dotenv from "dotenv";
dotenv.config();
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";
import fs from "fs";

interface ArbTrade {
  id: string;
  match: string;
  pmTokenId?: string;
  pmSlug?: string;
  kalTicker?: string;
  shares: number;
  pmCost: number;
  pmFillPrice: number;
  kalCost: number;
  kalFillPrice: number;
  totalCost: number;
  realizedPnl: number;
  status: string;
  dir: string;
  resolutionMethod?: string;
  tradeTs: string;
  resolvedTs?: string;
  [k: string]: unknown;
}

function getOurFillSize(
  ct: any,
  ourAddresses: Set<string>
): { size: number; cost: number; price: number } {
  if (
    ct.trader_side === "MAKER" &&
    ct.maker_orders &&
    ct.maker_orders.length > 0
  ) {
    let totalSize = 0;
    let totalCost = 0;
    for (const mo of ct.maker_orders) {
      if (ourAddresses.has(mo.maker_address.toLowerCase())) {
        const s = Number(mo.matched_amount);
        totalSize += s;
        totalCost += s * Number(ct.price);
      }
    }
    const price = totalSize > 0 ? totalCost / totalSize : Number(ct.price);
    return { size: totalSize, cost: totalCost, price };
  }
  const size = Number(ct.size);
  const price = Number(ct.price);
  return { size, cost: size * price, price };
}

async function main() {
  const tradesPath = "data/arb_trades.json";
  const trades: ArbTrade[] = JSON.parse(fs.readFileSync(tradesPath, "utf8"));
  const knownTokens = new Set<string>();
  for (const t of trades) {
    if (t.pmTokenId) knownTokens.add(t.pmTokenId);
  }

  // Fetch PM fills
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  const ourAddresses = new Set<string>();
  ourAddresses.add(wallet.address.toLowerCase());
  if (funder) ourAddresses.add(funder.toLowerCase());

  console.log("Fetching PM CLOB trades...");
  const pmFills = (await client.getTrades()) as any[];
  console.log(`Total PM fills: ${pmFills.length}`);

  // Group untracked fills by token with correct fill sizes
  const byToken = new Map<
    string,
    { totalBought: number; totalCost: number; avgPrice: number; fills: any[] }
  >();
  for (const ct of pmFills) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    if (knownTokens.has(ct.asset_id)) continue;
    const { size, cost } = getOurFillSize(ct, ourAddresses);
    if (size <= 0) continue;
    if (!byToken.has(ct.asset_id))
      byToken.set(ct.asset_id, {
        totalBought: 0,
        totalCost: 0,
        avgPrice: 0,
        fills: [],
      });
    const g = byToken.get(ct.asset_id)!;
    g.totalBought += size;
    g.totalCost += cost;
    g.fills.push({ ...ct, _ourSize: size, _ourCost: cost });
  }
  // Calculate avg price
  for (const [, v] of byToken) {
    v.avgPrice = v.totalCost / v.totalBought;
  }

  // Filter to >= 5 shares (skip dust)
  const filtered = [...byToken.entries()]
    .filter(([, v]) => v.totalBought >= 5)
    .sort((a, b) => b[1].totalCost - a[1].totalCost);

  console.log(`\nUntracked PM tokens (>=5 shares): ${filtered.length}`);

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const newTrades: ArbTrade[] = [];
  let totalPnl = 0;
  let resolved = 0;
  let unresolved = 0;
  let skippedNonEsports = 0;

  for (const [tokenId, data] of filtered) {
    let mkt: any = null;
    try {
      const resp = await fetch(
        "https://gamma-api.polymarket.com/markets?clob_token_ids=" + tokenId
      );
      const markets = (await resp.json()) as any[];
      mkt = markets[0];
      await delay(100);
    } catch {}

    if (!mkt) {
      console.log(
        `  SKIP: No market found for token ${tokenId.slice(0, 20)}...`
      );
      continue;
    }

    const question = mkt.question || "Unknown";
    const slug = mkt.slug || "";

    // Skip non-esports/non-tennis (politics, crypto, macro)
    const isEsportsTennis =
      /counter-strike|cs2-|valorant|val-|lol-|dota2-|esport|atp-|wta-|tennis|open:|match|game\d|map\d|bo[135]/i.test(
        slug + " " + question
      );
    if (!isEsportsTennis) {
      skippedNonEsports++;
      continue;
    }

    // Find our outcome and check resolution
    const ourToken = mkt.tokens?.find((t: any) => t.token_id === tokenId);
    const ourOutcome = ourToken?.outcome ?? "?";
    const resolvedAt = mkt.resolved_at || mkt.end_date_iso;
    const isResolved = mkt.closed || mkt.resolved_at;
    const winnerOutcome = mkt.tokens?.find(
      (t: any) => Number(t.price) > 0.95 || t.winner === true
    )?.outcome;

    // Determine if we won
    let won: boolean | null = null;
    if (isResolved && winnerOutcome) {
      won = ourOutcome === winnerOutcome;
    }

    const shares = Math.round(data.totalBought);
    const cost = Math.round(data.totalCost * 100) / 100;
    const price = Math.round(data.avgPrice * 100) / 100;

    let pnl = 0;
    let status = "unresolved";
    let resMethod = "pm-backfill";

    if (won === true) {
      pnl = Math.round((shares - cost) * 100) / 100;
      status = "resolved";
      resMethod = "pm-backfill-won";
    } else if (won === false) {
      pnl = -cost;
      status = "resolved";
      resMethod = "pm-backfill-lost";
    }

    const fillTs =
      data.fills[0]?.match_time || data.fills[0]?.created_at || "0";

    const sym = won === true ? "[OK] WON" : won === false ? "[X] LOST" : "? OPEN";
    const pnlStr =
      pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    console.log(
      `  ${sym.padEnd(7)} ${shares.toString().padStart(4)} shares @ $${price.toFixed(2)} = $${cost.toFixed(2).padStart(7)} -> ${pnlStr.padStart(8)} | ${ourOutcome.padEnd(20).slice(0, 20)} | ${question.slice(0, 60)}`
    );

    if (won !== null) {
      totalPnl += pnl;
      resolved++;
    } else {
      unresolved++;
    }

    // Create trade record
    const trade: ArbTrade = {
      id: `pm-backfill-${fillTs}`,
      match: question.replace(/^(Counter-Strike|Valorant|LoL|Dota 2|CS2): /, ""),
      pmTokenId: tokenId,
      pmSlug: slug,
      kalTicker: undefined,
      shares,
      pmCost: cost,
      pmFillPrice: price,
      kalCost: 0,
      kalFillPrice: 0,
      totalCost: cost,
      realizedPnl: pnl,
      status,
      dir: "PM-ONLY",
      resolutionMethod: resMethod,
      tradeTs: fillTs,
      resolvedTs: isResolved ? String(Math.floor(Date.now() / 1000)) : undefined,
      _backfillNote: "Auto-created from untracked PM CLOB fills -- no Kalshi counterpart found",
    };

    newTrades.push(trade);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`Resolved: ${resolved} | Unresolved: ${unresolved} | Skipped (non-esports): ${skippedNonEsports}`);
  console.log(`Total P&L from backfilled trades: $${totalPnl.toFixed(2)}`);
  console.log(`New trade records to add: ${newTrades.length}`);

  if (newTrades.length === 0) {
    console.log("\nNo trades to add.");
    return;
  }

  // Backup and write
  const backup = tradesPath.replace(".json", ".pre-backfill.json");
  fs.copyFileSync(tradesPath, backup);
  console.log(`\nBackup: ${backup}`);

  trades.push(...newTrades);
  fs.writeFileSync(tradesPath, JSON.stringify(trades, null, 2));
  console.log(`Written ${newTrades.length} new trades to ${tradesPath} (total: ${trades.length})`);
}

main().catch((e) => console.error("ERROR:", e));
