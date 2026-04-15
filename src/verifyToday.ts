/**
 * verifyToday.ts -- Ground-truth verification for today's arb trades.
 *
 * Cross-checks arb_trades.json against:
 *   1. Kalshi /portfolio/fills  (authoritative fill data)
 *   2. Kalshi /portfolio/settlements (authoritative settlement outcome)
 *   3. Kalshi /portfolio/positions (current positions)
 *   4. PM CLOB getTrades() (PM fill prices)
 *   5. Polygon RPC balanceOf (on-chain conditional token balance)
 *
 * Output: per-trade diff + summary report. Writes JSON to data/verify_today.json.
 *
 * Usage:
 *   npx tsx src/verifyToday.ts           # today (UTC)
 *   npx tsx src/verifyToday.ts 2026-04-14 # specific date
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet as EthersWallet } from "@ethersproject/wallet";
import { Wallet } from "ethers";
import { resolvePolyApiCreds } from "./polyAuth.js";
import { getOnChainBalanceWithFallback } from "./polyChain.js";

dotenv.config();

// --- CLI -----------------------------------------------------------------------
const DATE = process.argv[2] || new Date().toISOString().slice(0, 10);
console.log(`\n=== Verifying trades for ${DATE} ===\n`);

// --- Kalshi signed GET --------------------------------------------------------
function loadKalshiKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH");
  return fs.readFileSync(p, "utf8");
}

const KAL_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

function signKal(method: string, urlPath: string, timestamp: string, pem: string) {
  const s = crypto.createSign("RSA-SHA256");
  s.update(`${timestamp}${method.toUpperCase()}${urlPath}`);
  s.end();
  return s.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

async function kalGet(pathAndQuery: string): Promise<any> {
  const keyId = process.env.KALSHI_API_KEY_ID!;
  const pem = loadKalshiKey();
  const url = new URL(`${KAL_BASE}${pathAndQuery}`);
  const ts = Date.now().toString();
  const sig = signKal("GET", url.pathname, ts, pem);
  const res = await fetch(url.toString(), {
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Kalshi ${res.status} ${res.statusText} on ${pathAndQuery}`);
  return res.json();
}

// --- PM CLOB client -----------------------------------------------------------
let _pmClient: ClobClient | null = null;
async function pmClient(): Promise<ClobClient> {
  if (_pmClient) return _pmClient;
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new EthersWallet(pk);
  const funder = process.env.POLY_FUNDER || wallet.address;
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  _pmClient = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  return _pmClient;
}

// --- Main ---------------------------------------------------------------------
async function main() {
  // 1. Load trade journal
  const tradesPath = "data/arb_trades.json";
  if (!fs.existsSync(tradesPath)) throw new Error(`Missing ${tradesPath}`);
  const allTrades: any[] = JSON.parse(fs.readFileSync(tradesPath, "utf8"));
  const todayTrades = allTrades.filter((t) => String(t.ts ?? "").startsWith(DATE));
  console.log(`Trades on ${DATE}: ${todayTrades.length}`);
  if (todayTrades.length === 0) return;

  // 2. Kalshi fills (paginated)
  console.log("\n[1/5] Fetching Kalshi fills...");
  const kalFills: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = `/portfolio/fills?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await kalGet(qs);
    const items = r.fills ?? r.data ?? [];
    kalFills.push(...items);
    cursor = r.cursor;
    if (!cursor || items.length < 1000) break;
  }
  const todayFills = kalFills.filter((f) => String(f.created_time ?? "").startsWith(DATE));
  console.log(`  Total fills fetched: ${kalFills.length} | Today's: ${todayFills.length}`);

  const fillsByTicker = new Map<string, any[]>();
  for (const f of todayFills) {
    const tk = f.ticker ?? f.market_ticker ?? "";
    if (!fillsByTicker.has(tk)) fillsByTicker.set(tk, []);
    fillsByTicker.get(tk)!.push(f);
  }

  // 3. Kalshi settlements
  console.log("\n[2/5] Fetching Kalshi settlements...");
  const settResp = await kalGet("/portfolio/settlements?limit=200");
  const settlements = (settResp.settlements ?? settResp.data ?? []) as any[];
  const settByTicker = new Map<string, any>();
  for (const s of settlements) settByTicker.set(s.ticker ?? s.market_ticker ?? "", s);
  const todaySett = settlements.filter((s) => String(s.settled_time ?? "").startsWith(DATE));
  console.log(`  Settlements fetched: ${settlements.length} | Today's: ${todaySett.length}`);

  // 4. Kalshi current positions
  console.log("\n[3/5] Fetching Kalshi current positions...");
  const posResp = await kalGet("/portfolio/positions?count_filter=position&limit=500");
  const kalPos = (posResp.market_positions ?? posResp.data ?? []) as any[];
  const kalPosByTicker = new Map<string, any>();
  for (const p of kalPos) kalPosByTicker.set(p.ticker ?? p.market_ticker ?? "", p);
  console.log(`  Kalshi positions: ${kalPos.length}`);

  // 5. PM CLOB trades (all of them — filtered by timestamp below)
  console.log("\n[4/5] Fetching PM CLOB trades...");
  let pmTrades: any[] = [];
  try {
    const client = await pmClient();
    pmTrades = (await (client.getTrades as any)()) ?? [];
    if (!Array.isArray(pmTrades)) pmTrades = [];
  } catch (e) {
    console.warn(`  [WARN] PM getTrades failed: ${(e as Error).message}`);
  }
  // PM trades use `match_time` (unix seconds) or `last_update` (ms). Normalize.
  function pmTradeTsIso(t: any): string {
    const mt = t.match_time ?? t.last_update ?? t.created_at;
    if (!mt) return "";
    const n = Number(mt);
    if (!Number.isFinite(n)) return "";
    const ms = n > 1e12 ? n : n * 1000; // seconds vs ms
    return new Date(ms).toISOString();
  }
  const todayPmTrades = pmTrades.filter((t) => pmTradeTsIso(t).startsWith(DATE));
  const pmTradesByToken = new Map<string, any[]>();
  for (const pt of todayPmTrades) {
    const tid = pt.asset_id ?? pt.tokenId ?? pt.asset ?? "";
    if (!pmTradesByToken.has(tid)) pmTradesByToken.set(tid, []);
    pmTradesByToken.get(tid)!.push(pt);
  }
  console.log(`  PM CLOB trades: ${pmTrades.length} | Today's: ${todayPmTrades.length}`);

  // 6. Per-trade verification
  console.log("\n[5/5] Verifying each trade against ground truth...\n");
  console.log("=".repeat(130));

  type Diff = {
    tradeId: string;
    match: string;
    status: string;
    recorded: { shares: number; kalCost: number; pmCost: number; totalCost: number; realizedPnl: number | null };
    kalActual: { fillCount: number; shares: number; cost: number; fees: number } | null;
    pmActual: { fillCount: number; shares: number; cost: number; avgPrice: number } | null;
    onChainBalance: number | null;
    settlement: { result: string; payout: number } | null;
    kalCostDelta: number;
    pmCostDelta: number;
    severity: "ok" | "minor" | "corrupt";
    flags: string[];
  };
  const diffs: Diff[] = [];

  for (const t of todayTrades) {
    const d: Diff = {
      tradeId: t.id,
      match: t.match,
      status: t.status,
      recorded: {
        shares: Number(t.shares ?? 0),
        kalCost: Number(t.kalCost ?? 0),
        pmCost: Number(t.pmCost ?? 0),
        totalCost: Number(t.totalCost ?? 0),
        realizedPnl: t.realizedPnl ?? null,
      },
      kalActual: null,
      pmActual: null,
      onChainBalance: null,
      settlement: null,
      kalCostDelta: 0,
      pmCostDelta: 0,
      severity: "ok",
      flags: [],
    };

    // Kalshi fills
    const kfills = fillsByTicker.get(t.kalTicker) ?? [];
    if (kfills.length > 0) {
      let shares = 0, cost = 0, fees = 0;
      for (const f of kfills) {
        const count = Number(f.count_fp ?? f.count ?? 0);
        const side = f.side ?? "";
        const yesP = Number(f.yes_price_dollars ?? f.yes_price ?? 0);
        const noP = Number(f.no_price_dollars ?? f.no_price ?? 0);
        const p = side === "no" ? noP : yesP;
        shares += count;
        cost += count * p;
        fees += Number(f.fee_cost ?? 0);
      }
      d.kalActual = { fillCount: kfills.length, shares, cost, fees };
      d.kalCostDelta = d.recorded.kalCost - cost;

      if (Math.abs(d.kalCostDelta) > 0.50) {
        d.severity = "corrupt";
        d.flags.push(`KAL cost off by $${d.kalCostDelta.toFixed(2)} (recorded $${d.recorded.kalCost.toFixed(2)} vs actual $${cost.toFixed(2)})`);
      } else if (Math.abs(d.kalCostDelta) > 0.10) {
        if (d.severity === "ok") d.severity = "minor";
        d.flags.push(`KAL cost minor drift $${d.kalCostDelta.toFixed(2)}`);
      }
      if (Math.abs(shares - d.recorded.shares) > 0.5) {
        d.severity = "corrupt";
        d.flags.push(`KAL share count mismatch: recorded=${d.recorded.shares} vs actual=${shares}`);
      }
    } else {
      d.flags.push("no KAL fills found for ticker today");
    }

    // Kalshi settlement
    const sett = settByTicker.get(t.kalTicker);
    if (sett) {
      const result = sett.market_result ?? "?";
      const yesCount = Number(sett.yes_count_fp ?? 0);
      const noCount = Number(sett.no_count_fp ?? 0);
      const payout = result === "yes" ? yesCount : result === "no" ? noCount : 0;
      d.settlement = { result, payout };
    }

    // PM CLOB actual fills for token
    const pts = pmTradesByToken.get(t.pmTokenId) ?? [];
    if (pts.length > 0) {
      let shares = 0, cost = 0;
      for (const pt of pts) {
        const size = Number(pt.size ?? pt.matched_amount ?? 0);
        const price = Number(pt.price ?? 0);
        shares += size;
        cost += size * price;
      }
      const avg = shares > 0 ? cost / shares : 0;
      d.pmActual = { fillCount: pts.length, shares, cost, avgPrice: avg };
      d.pmCostDelta = d.recorded.pmCost - cost;

      if (Math.abs(d.pmCostDelta) > 0.50) {
        d.severity = "corrupt";
        d.flags.push(`PM cost off by $${d.pmCostDelta.toFixed(2)} (recorded $${d.recorded.pmCost.toFixed(2)} vs actual $${cost.toFixed(2)})`);
      } else if (Math.abs(d.pmCostDelta) > 0.10) {
        if (d.severity === "ok") d.severity = "minor";
        d.flags.push(`PM cost minor drift $${d.pmCostDelta.toFixed(2)}`);
      }
    }

    // On-chain PM balance (current, post-settlement may be zero)
    if (t.pmTokenId) {
      try {
        const bal = await getOnChainBalanceWithFallback(t.pmTokenId);
        d.onChainBalance = bal;
      } catch (e) {
        d.flags.push(`on-chain query failed: ${(e as Error).message}`);
      }
    }

    // Sanity: kalFillPrice > 1.0 impossible for binary
    if (Number(t.kalFillPrice ?? 0) > 1.0) {
      d.severity = "corrupt";
      d.flags.push(`IMPOSSIBLE kalFillPrice=${t.kalFillPrice} (binary max=1.0)`);
    }

    diffs.push(d);

    // Per-trade console output
    const badge = d.severity === "corrupt" ? "❌ CORRUPT" : d.severity === "minor" ? "⚠️  MINOR" : "✅ OK";
    console.log(`\n${badge} | ${d.tradeId} | ${d.match} | ${d.status} | ${d.recorded.shares} shares`);
    console.log(`  recorded:   kalCost=$${d.recorded.kalCost.toFixed(2)}  pmCost=$${d.recorded.pmCost.toFixed(2)}  total=$${d.recorded.totalCost.toFixed(2)}  P&L=${d.recorded.realizedPnl != null ? '$' + Number(d.recorded.realizedPnl).toFixed(2) : 'n/a'}`);
    if (d.kalActual) {
      console.log(`  KAL actual: ${d.kalActual.fillCount} fills, ${d.kalActual.shares} shares, cost=$${d.kalActual.cost.toFixed(2)}, fees=$${d.kalActual.fees.toFixed(2)}  (Δ cost=$${d.kalCostDelta.toFixed(2)})`);
    }
    if (d.pmActual) {
      console.log(`  PM actual:  ${d.pmActual.fillCount} fills, ${d.pmActual.shares.toFixed(2)} shares @ avg ${(d.pmActual.avgPrice * 100).toFixed(1)}c = $${d.pmActual.cost.toFixed(2)}  (Δ cost=$${d.pmCostDelta.toFixed(2)})`);
    }
    if (d.settlement) {
      console.log(`  settlement: result=${d.settlement.result}  payout=$${d.settlement.payout.toFixed(2)}`);
    }
    if (d.onChainBalance !== null) {
      console.log(`  on-chain:   ${d.onChainBalance.toFixed(4)} shares of pmTokenId`);
    }
    for (const f of d.flags) console.log(`  ⚠ ${f}`);
  }

  // 7. Summary
  console.log("\n" + "=".repeat(130));
  console.log("SUMMARY");
  console.log("=".repeat(130));
  const ok = diffs.filter((d) => d.severity === "ok").length;
  const minor = diffs.filter((d) => d.severity === "minor").length;
  const corrupt = diffs.filter((d) => d.severity === "corrupt").length;
  const recordedPnl = todayTrades.reduce((s, t) => s + Number(t.realizedPnl ?? 0), 0);
  const phantomLoss = diffs
    .filter((d) => d.severity === "corrupt")
    .reduce((s, d) => s + Math.max(0, d.kalCostDelta) + Math.max(0, d.pmCostDelta), 0);

  console.log(`\nTrades by severity: ✅ ok=${ok}  ⚠️ minor=${minor}  ❌ corrupt=${corrupt}  (total ${diffs.length})`);
  console.log(`Recorded P&L for ${DATE}: $${recordedPnl.toFixed(2)}`);
  console.log(`Estimated phantom loss from corruption (recorded − actual cost): $${phantomLoss.toFixed(2)}`);
  console.log(`Estimated real P&L: $${(recordedPnl + phantomLoss).toFixed(2)}`);

  // Unmatched Kalshi tickers (fills today for markets we don't have a trade for)
  const tradeTickers = new Set(todayTrades.map((t) => t.kalTicker));
  const unmatched = [...fillsByTicker.keys()].filter((k) => !tradeTickers.has(k));
  if (unmatched.length > 0) {
    console.log(`\nUnmatched Kalshi tickers (fills on exchange but no trade record): ${unmatched.length}`);
    for (const tk of unmatched) {
      const fs_ = fillsByTicker.get(tk)!;
      const shares = fs_.reduce((s, f) => s + Number(f.count_fp ?? f.count ?? 0), 0);
      console.log(`  ${tk}: ${fs_.length} fills, ${shares} shares`);
    }
  }

  // 8. Write report
  const outPath = "data/verify_today.json";
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    date: DATE,
    generatedAt: new Date().toISOString(),
    summary: { ok, minor, corrupt, recordedPnl, phantomLoss, estimatedRealPnl: recordedPnl + phantomLoss },
    diffs,
    unmatchedTickers: unmatched,
  }, null, 2));
  console.log(`\nReport written to ${outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
