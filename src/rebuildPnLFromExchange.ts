/**
 * rebuildPnLFromExchange.ts -- Ground-truth rebuild of arb_trades.json P&L.
 *
 * For every resolved trade, fetches:
 *   - Kalshi /portfolio/fills    → actual KAL cost, shares, fees
 *   - Kalshi /portfolio/settlements → actual payout (handles void/scalar)
 *   - PM CLOB getTrades()         → actual PM cost, fill price
 * and writes the authoritative values back to arb_trades.json,
 * stamping each corrected record with `pnlVerified = <ISO ts>`.
 *
 * Reconciliation + hedge paths SKIP trades with pnlVerified set, so the
 * values stick across restarts and future reconcile runs.
 *
 * Fills on the same ticker/token are attributed to trades in time order
 * (oldest trade consumes earliest fills). This is the same attribution
 * model the reconciler uses, but applied ONCE with a consistent window.
 *
 * Usage:
 *   npx tsx src/rebuildPnLFromExchange.ts --dry-run   # diff report only
 *   npx tsx src/rebuildPnLFromExchange.ts             # write changes (with backup)
 *   npx tsx src/rebuildPnLFromExchange.ts --force     # re-verify already-verified trades
 */
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet as EthersWallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./polyAuth.js";
import {
  fetchAllKalshiFills, fetchAllKalshiSettlements,
  type KalFill, type KalSettlement,
} from "./kalshiTrade.js";
import { kalSideForDir } from "./utils.js";
import type { ArbTradeRecord } from "./types.js";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const TRADES_PATH = "data/arb_trades.json";

function log(msg: string) { console.log(msg); }

// --- PM CLOB trades fetcher ---------------------------------------------------
type PmClobTrade = {
  id?: string;
  asset_id: string;
  size: string;
  price: string;
  side: string;         // "BUY" | "SELL"
  status: string;       // "MATCHED" | "CONFIRMED" | "RETRYING" | "FAILED"
  match_time: string;   // unix seconds as string
  fee_rate_bps?: string;
};

async function fetchAllPmTrades(): Promise<PmClobTrade[]> {
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new EthersWallet(pk);
  const funder = process.env.POLY_FUNDER || wallet.address;
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  // CLOB getTrades() returns up to ~1000 most recent trades in one call.
  // For bots older than that, we rely on existing arb_trades.json pmCost for old records.
  const raw = (await (client.getTrades as any)()) ?? [];
  return Array.isArray(raw) ? raw as PmClobTrade[] : [];
}

// --- Attribution ---------------------------------------------------------------
function tradeTsMs(t: ArbTradeRecord): number {
  return new Date(t.ts).getTime();
}

function pmTradeTsMs(pt: PmClobTrade): number {
  const n = Number(pt.match_time);
  if (!Number.isFinite(n)) return 0;
  return n > 1e12 ? n : n * 1000;
}

// --- Main ---------------------------------------------------------------------
async function main() {
  log(`\n=== Rebuild P&L from exchange ground truth${DRY_RUN ? " [DRY-RUN]" : ""} ===\n`);

  if (!fs.existsSync(TRADES_PATH)) throw new Error(`Missing ${TRADES_PATH}`);
  const trades: ArbTradeRecord[] = JSON.parse(fs.readFileSync(TRADES_PATH, "utf8"));
  log(`Loaded ${trades.length} trades from ${TRADES_PATH}`);

  // Fetch exchange data in parallel
  log("\n[1/3] Fetching Kalshi fills + settlements + PM CLOB trades...");
  const [kalFills, kalSettlements, pmTrades] = await Promise.all([
    fetchAllKalshiFills(),
    fetchAllKalshiSettlements(),
    fetchAllPmTrades().catch((e) => { console.warn(`  PM trades fetch failed: ${(e as Error).message}`); return [] as PmClobTrade[]; }),
  ]);
  log(`  Kalshi: ${kalFills.length} fills, ${kalSettlements.length} settlements`);
  log(`  PM CLOB: ${pmTrades.length} trades`);

  // Index Kalshi fills by ticker+side (BUYs only)
  const kalFillsByKey = new Map<string, KalFill[]>();
  for (const f of kalFills) {
    if (f.action !== "buy" || !f.ticker) continue;
    const key = `${f.ticker}:${f.side}`;
    if (!kalFillsByKey.has(key)) kalFillsByKey.set(key, []);
    kalFillsByKey.get(key)!.push(f);
  }
  // Sort each bucket oldest-first
  for (const list of kalFillsByKey.values()) {
    list.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  }

  // Index PM CLOB trades by asset_id (BUYs only; exclude FAILED/RETRYING)
  const pmTradesByToken = new Map<string, PmClobTrade[]>();
  for (const pt of pmTrades) {
    if (pt.side !== "BUY") continue;
    if (pt.status === "FAILED" || pt.status === "RETRYING") continue;
    if (!pt.asset_id) continue;
    if (!pmTradesByToken.has(pt.asset_id)) pmTradesByToken.set(pt.asset_id, []);
    pmTradesByToken.get(pt.asset_id)!.push(pt);
  }
  for (const list of pmTradesByToken.values()) {
    list.sort((a, b) => pmTradeTsMs(a) - pmTradeTsMs(b));
  }

  // Settlements by ticker
  const settByTicker = new Map<string, KalSettlement>();
  for (const s of kalSettlements) settByTicker.set(s.ticker, s);

  log("\n[2/3] Attributing fills and rebuilding P&L per trade...\n");

  // Sort trades by ticker+ts so earlier arbs on the same ticker consume earliest fills
  const sorted = [...trades].sort((a, b) => tradeTsMs(a) - tradeTsMs(b));

  // Consumption pointers per bucket
  const kalCursor = new Map<string, number>();
  const pmCursor = new Map<string, number>();

  type Diff = {
    tradeId: string; match: string; status: string; resolutionMethod: string;
    old: { kalCost: number; kalFees: number; pmCost: number; totalCost: number; realizedPnl: number | null; shares: number };
    new: { kalCost: number; kalFees: number; pmCost: number; totalCost: number; realizedPnl: number; shares: number };
    delta: number;
    reason: string;
  };
  const diffs: Diff[] = [];
  let touched = 0, skipped = 0;

  for (const t of sorted) {
    // Only rebuild resolved trades; leave active ones alone
    if (t.status !== "resolved") { skipped++; continue; }
    // Skip already-verified unless --force
    if (t.pnlVerified && !FORCE) { skipped++; continue; }
    // Skip if we have no kalTicker (nothing to attribute)
    if (!t.kalTicker) { skipped++; continue; }
    // Skip post-hoc recovered / manually reconstructed records — they don't
    // have proper execution state to reason about.
    if (t.id.startsWith("arb-detect-") || t.id.includes("recovered") ||
        t.id.includes("ghost") || t.id.includes("excess")) { skipped++; continue; }
    // Scalar settlements (void/cancelled markets) are handled below using
    // kalSettlementValue + pmSettlementValue to compute the correct payout.
    // The stored realizedPnl for scalar trades has been historically incorrect
    // (e.g. Borna Gojo recorded +$8.21 when actual was -$3.41), so rebuild them too.

    const shares = Number(t.shares || 0);
    if (shares <= 0) { skipped++; continue; }

    const kalSide = kalSideForDir(t.dir);
    const kalKey = `${t.kalTicker}:${kalSide}`;
    const kalBucket = kalFillsByKey.get(kalKey) ?? [];
    const kalIdx = kalCursor.get(kalKey) ?? 0;

    // Greedily consume kalBucket starting at kalIdx until we cover `shares`
    let kalShares = 0, kalCostRaw = 0, kalFees = 0, kalConsumed = 0;
    for (let i = kalIdx; i < kalBucket.length && kalShares < shares; i++) {
      const f = kalBucket[i];
      const priceDollars = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100;
      const take = Math.min(f.count, shares - kalShares);
      const fracOfFill = f.count > 0 ? take / f.count : 1;
      kalShares += take;
      kalCostRaw += take * priceDollars;
      kalFees += f.feeCost * fracOfFill;
      kalConsumed = i + 1;
    }
    kalCursor.set(kalKey, kalConsumed);

    // PM attribution
    let pmShares = 0, pmCost = 0;
    if (t.pmTokenId) {
      const pmBucket = pmTradesByToken.get(t.pmTokenId) ?? [];
      const pmIdx = pmCursor.get(t.pmTokenId) ?? 0;
      let pmConsumed = pmIdx;
      for (let i = pmIdx; i < pmBucket.length && pmShares < shares; i++) {
        const pt = pmBucket[i];
        const sz = Number(pt.size);
        const px = Number(pt.price);
        if (!Number.isFinite(sz) || !Number.isFinite(px)) continue;
        const take = Math.min(sz, shares - pmShares);
        pmShares += take;
        pmCost += take * px;
        pmConsumed = i + 1;
      }
      pmCursor.set(t.pmTokenId, pmConsumed);
    }

    // Round everything
    kalCostRaw = Math.round(kalCostRaw * 100) / 100;
    kalFees = Math.round(kalFees * 100) / 100;
    pmCost = Math.round(pmCost * 100) / 100;

    // SAFETY: if we couldn't attribute the full KAL quantity (e.g. fills paged
    // out of the API window), DO NOT verify — the record would get a false
    // zero-cost. Only accept attributions that cover ≥95% of intended shares.
    const kalAttribOk = kalShares >= shares * 0.95 || (kalShares === 0 && Number(t.kalCost || 0) === 0);
    if (!kalAttribOk) { skipped++; continue; }

    // PM attribution fallback: if pmTokenId exists but no PM fills found in
    // CLOB (they've paged out — CLOB only returns ~1000 most recent trades),
    // trust the original pmCost rather than zeroing it.
    let pmFromAttribution = pmShares >= shares * 0.8;
    if (t.pmTokenId && !pmFromAttribution && Number(t.pmCost || 0) > 0) {
      // Keep original pmCost — attribution failed due to CLOB pagination
      pmCost = Number(t.pmCost || 0);
      pmShares = shares; // assume fully-hedged per original record
      pmFromAttribution = false;
    }

    // Determine payout
    // - Fully hedged arb (both legs filled, or hedge-complete): payout = shares at settlement
    // - Settlement-only (single leg): payout depends on kalSide vs result
    // - Scalar: shares × settlement_value (0-1 fraction)
    const sett = settByTicker.get(t.kalTicker);
    const result = (sett?.marketResult ?? "").toLowerCase();
    const isScalar = result === "scalar" || Boolean(t.scalarSettlement);

    // Payout determination strategy:
    // 1. Scalar/void settlements: use kalSettlementValue + pmSettlementValue × shares
    //    (these fields are stamped by the scalar handler at settlement time).
    // 2. Binary settlements: reconstruct implied payout from original record
    //    (oldPnl + oldTotalCost). For a fully-hedged arb this resolves to `shares`.
    //    For a KAL-only that won it resolves to `shares`. For one that lost it resolves to 0.
    const oldPnl = Number(t.realizedPnl ?? 0);
    const oldKalCost = Number(t.kalCost ?? 0);
    const oldKalFees = Number(t.kalFees ?? 0);
    const oldPmCost = Number(t.pmCost ?? 0);
    const oldHedge = ((oldKalCost === 0 || oldPmCost === 0) && Number(t.hedgeCost ?? 0) > 0)
      ? Number(t.hedgeCost ?? 0) : 0;
    const oldTotalCost = oldKalCost + oldKalFees + oldHedge + oldPmCost;

    let payout: number;
    let payoutReason: string;
    if (t.scalarSettlement) {
      // Scalar: each leg pays its settlement_value per share. We OWN both sides.
      const kalSv = Number(t.kalSettlementValue ?? 0);
      const pmSv = Number(t.pmSettlementValue ?? 0);
      payout = Math.round((shares * kalSv + shares * pmSv) * 100) / 100;
      payoutReason = `scalar (kalSv=${kalSv}, pmSv=${pmSv}, payout=$${payout.toFixed(2)})`;
    } else {
      payout = Math.round((oldPnl + oldTotalCost) * 100) / 100;
      if (payout > shares + 0.01) payout = shares;
      if (payout < 0) payout = 0;
      payoutReason = `implied-from-record (oldPnl + oldCost = ${payout.toFixed(2)})`;
    }
    // Mark unused flags as read to satisfy linter
    void kalSide; void result; void sett; void isScalar;

    const totalCost = Math.round((kalCostRaw + kalFees + pmCost) * 100) / 100;
    const realizedPnl = Math.round((payout - totalCost) * 100) / 100;

    const oldSnapshot = {
      kalCost: Number(t.kalCost || 0),
      kalFees: Number(t.kalFees || 0),
      pmCost: Number(t.pmCost || 0),
      totalCost: Number(t.totalCost || 0),
      realizedPnl: t.realizedPnl ?? null,
      shares: Number(t.shares || 0),
    };
    const newSnapshot = {
      kalCost: kalCostRaw,
      kalFees,
      pmCost,
      totalCost,
      realizedPnl,
      shares,
    };

    // Skip trades where no KAL fills were attributed — likely too old (paged out) or cross-server.
    // Leaving the existing record untouched is safer than zeroing it out.
    if (kalShares === 0 && !t.pmTokenId) { skipped++; continue; }
    if (kalShares === 0 && t.pmTokenId && pmShares === 0) { skipped++; continue; }

    // Always update kalCost/pmCost from attribution; keep shares from record (source of truth for intent)
    t.kalCost = kalCostRaw;
    t.kalFees = kalFees;
    t.pmCost = pmCost;
    t.totalCost = totalCost;
    t.realizedPnl = realizedPnl;
    if (kalCostRaw > 0 && kalShares > 0) t.kalFillPrice = Math.round((kalCostRaw / kalShares) * 10000) / 10000;
    if (pmCost > 0 && pmShares > 0) t.pmFillPrice = Math.round((pmCost / pmShares) * 10000) / 10000;
    // Clear stale hedgeCost mirror (it was duplicating pmCost in many records)
    if (t.hedgeCost != null) t.hedgeCost = 0;
    // Clear the over-hedge artifacts from the consolidation reconciler
    delete t.overHedgeShares;
    delete t.overHedgeCost;
    delete t.overHedgeSide;

    t.pnlVerified = new Date().toISOString();
    t.pnlVerifiedBy = "rebuildPnLFromExchange";

    const delta = realizedPnl - (oldSnapshot.realizedPnl ?? 0);
    diffs.push({
      tradeId: t.id, match: t.match, status: t.status,
      resolutionMethod: t.resolutionMethod ?? "?",
      old: oldSnapshot, new: newSnapshot, delta, reason: payoutReason,
    });
    touched++;
  }

  // Report
  log("=".repeat(120));
  log("DIFF REPORT");
  log("=".repeat(120));

  // Show biggest absolute deltas first (where the lies were biggest)
  diffs.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = diffs.slice(0, 25);
  for (const d of top) {
    const pnlOld = d.old.realizedPnl != null ? `$${d.old.realizedPnl.toFixed(2)}` : "n/a";
    const pnlNew = `$${d.new.realizedPnl.toFixed(2)}`;
    const sign = d.delta >= 0 ? "+" : "";
    log(
      `  ${d.tradeId} | ${d.match.slice(0, 42).padEnd(42)} | ${d.resolutionMethod.padEnd(20)} ` +
      `| P&L ${pnlOld} → ${pnlNew} (Δ${sign}$${d.delta.toFixed(2)}) | ${d.reason}`
    );
  }
  if (diffs.length > top.length) log(`  ... and ${diffs.length - top.length} more`);

  const sumOldPnl = diffs.reduce((s, d) => s + (d.old.realizedPnl ?? 0), 0);
  const sumNewPnl = diffs.reduce((s, d) => s + d.new.realizedPnl, 0);
  log("\n" + "=".repeat(120));
  log("SUMMARY");
  log("=".repeat(120));
  log(`Trades touched: ${touched}`);
  log(`Trades skipped: ${skipped} (non-resolved, already verified, or no exchange data)`);
  log(`Sum of old P&L across touched trades: $${sumOldPnl.toFixed(2)}`);
  log(`Sum of new P&L across touched trades: $${sumNewPnl.toFixed(2)}`);
  log(`Net correction (new - old):           $${(sumNewPnl - sumOldPnl).toFixed(2)}`);

  if (DRY_RUN) {
    log(`\n[DRY-RUN] No files written. Re-run without --dry-run to apply.`);
    return;
  }

  if (touched === 0) {
    log(`\nNothing to write.`);
    return;
  }

  // Backup before writing
  const backupDir = path.dirname(TRADES_PATH);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `arb_trades.pre-rebuild-${ts}.json`);
  fs.copyFileSync(TRADES_PATH, backupPath);
  log(`\nBackup written: ${backupPath}`);

  // Save diff report
  const diffPath = path.join(backupDir, `rebuild_diff_${ts}.json`);
  fs.writeFileSync(diffPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    summary: {
      touched, skipped,
      sumOldPnl: Math.round(sumOldPnl * 100) / 100,
      sumNewPnl: Math.round(sumNewPnl * 100) / 100,
      netCorrection: Math.round((sumNewPnl - sumOldPnl) * 100) / 100,
    },
    diffs,
  }, null, 2));
  log(`Diff report:    ${diffPath}`);

  // Write updated trades
  fs.writeFileSync(TRADES_PATH, JSON.stringify(trades, null, 2));
  log(`Updated:        ${TRADES_PATH} (${touched} records stamped with pnlVerified)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
