/**
 * ttWalletFirst.ts -- Wallet-first startup reconciliation.
 *
 * Problem: hedge_state.json can drift from reality (crash, reconcile bugs,
 * shared-wallet writes from another bot). Trades marked `hedging` in
 * arb_trades.json may have no hedge_state entry, so the bot won't actively
 * hedge them. And orphan backfill trades (one-legged) can't be hedged until
 * paired with their matching market on the other exchange.
 *
 * This module enhances startup reconciliation by:
 *   1. Pairing orphan backfill trades (one leg only) with the matching market
 *      via the Discovery cache → promoting them to hedgeable state.
 *   2. Running the existing `recoverOrphanedHedgeTrades()` to rebuild
 *      hedge_state entries for any `hedging` trade that lacks one.
 *   3. Enriching reconstructed positions with full leg metadata from the
 *      Discovery cache (fills in tickSize, negRisk, feeRate, pmOppLeg that the
 *      legacy recovery path leaves as stubs).
 *   4. Purging stale hedge_state entries whose trade is already resolved or
 *      missing from arb_trades.json.
 *
 * Enabled via WALLET_FIRST_STARTUP=true env flag. Default: false (legacy
 * behavior preserved).
 */

import type { WatchEntry, HedgeState, UnhedgedPosition, ArbTradeRecord, PmLeg, KalshiLeg, HedgeOrder } from "./ttTypes.js";
import { loadDiscoveryCache, discoverWatchlist } from "./ttDiscovery.js";
import {
  loadArbTrades, saveArbTrades, loadHedgeStates, saveHedgeStates,
  recoverOrphanedHedgeTrades,
  loadManualHedgeFlags, saveManualHedgeFlags, type ManualHedgeFlag,
} from "./ttPersistence.js";
import { fetchPmPositionsCached } from "./ttReconcile.js";
import { audit } from "./ttAuditLog.js";
import { getKalshiPositionMap } from "../kalshiTrade.js";
import crypto from "crypto";

console.log("[WALLET-FIRST] Module loaded");

// ── Helper: build lookup indexes over the discovery watchlist ───────────────
interface PairEntry {
  kalLeg: KalshiLeg;
  pmLeg: PmLeg;
  pmOppLeg: PmLeg;
  pmSlug: string;
}

function buildWatchlistIndexes(watchlist: WatchEntry[]): {
  byKalTicker: Map<string, PairEntry>;
  byPmTokenId: Map<string, PairEntry>;
} {
  const byKalTicker = new Map<string, PairEntry>();
  const byPmTokenId = new Map<string, PairEntry>();
  for (const w of watchlist) {
    const p1: PairEntry = { kalLeg: w.kal1, pmLeg: w.pm1, pmOppLeg: w.pm2, pmSlug: w.pmSlug };
    const p2: PairEntry = { kalLeg: w.kal2, pmLeg: w.pm2, pmOppLeg: w.pm1, pmSlug: w.pmSlug };
    byKalTicker.set(w.kal1.ticker, p1);
    byKalTicker.set(w.kal2.ticker, p2);
    byPmTokenId.set(w.pm1.tokenId, p1);
    byPmTokenId.set(w.pm2.tokenId, p2);
    if (w.kal3 && w.pm3) {
      const p3: PairEntry = { kalLeg: w.kal3, pmLeg: w.pm3, pmOppLeg: w.pm1, pmSlug: w.pmSlug };
      byKalTicker.set(w.kal3.ticker, p3);
      byPmTokenId.set(w.pm3.tokenId, p3);
    }
  }
  return { byKalTicker, byPmTokenId };
}

// ── Load discovery cache, fall back to fresh discovery ──────────────────────
async function loadOrRefreshDiscovery(forceFresh: boolean): Promise<WatchEntry[]> {
  if (!forceFresh) {
    const cached = loadDiscoveryCache();
    if (cached && cached.watchlist && cached.watchlist.length > 0) {
      console.log(`[WALLET-FIRST] Using cached discovery: ${cached.watchlist.length} pairs`);
      return cached.watchlist;
    }
  }
  console.log(`[WALLET-FIRST] Running fresh discovery...`);
  try {
    const fresh = await discoverWatchlist();
    console.log(`[WALLET-FIRST] Fresh discovery: ${fresh.watchlist.length} pairs`);
    return fresh.watchlist;
  } catch (e) {
    console.warn(`[WALLET-FIRST] Discovery failed: ${(e as Error).message}`);
    return [];
  }
}

// ── Phase 1: Pair orphan backfill trades via Discovery ──────────────────────
// `arb-backfill-kal-*` trades have only kalTicker; find matching PM token.
// `arb-backfill-pm-*` trades have only pmTokenId; find matching KAL ticker.
// On match, updates the trade record in-place and persists.
export async function pairOrphanBackfills(watchlist: WatchEntry[]): Promise<{
  paired: number;
  unmatched: number;
  unmatchedIds: string[];
}> {
  const trades = loadArbTrades();
  const orphans = trades.filter(t =>
    t.status === "hedging" &&
    typeof t.id === "string" &&
    t.id.startsWith("arb-backfill-") &&
    (
      (!t.kalTicker && !!t.pmTokenId) ||
      (!!t.kalTicker && !t.pmTokenId)
    )
  );

  if (orphans.length === 0) {
    console.log(`[WALLET-FIRST] No orphan backfill trades to pair`);
    return { paired: 0, unmatched: 0, unmatchedIds: [] };
  }

  console.log(`[WALLET-FIRST] Pairing ${orphans.length} orphan backfill trade(s)`);
  const { byKalTicker, byPmTokenId } = buildWatchlistIndexes(watchlist);

  let paired = 0;
  const unmatchedIds: string[] = [];
  let changed = false;

  for (const t of orphans) {
    if (t.kalTicker && !t.pmTokenId) {
      // KAL-held orphan — look up PM counterpart
      const m = byKalTicker.get(t.kalTicker);
      if (m) {
        t.pmTokenId = m.pmLeg.tokenId;
        t.pmOutcome = m.pmLeg.outcome;
        t.pmSlug = m.pmSlug;
        paired++;
        changed = true;
        console.log(
          `[WALLET-FIRST] Paired KAL orphan ${t.id.slice(0, 50)}` +
          ` (${t.kalTicker}) → PM ${m.pmLeg.outcome}`
        );
        audit({
          module: "persist", fn: "pairOrphanBackfills", action: "orphan-paired",
          tradeId: t.id, kalTicker: t.kalTicker, pmSlug: t.pmSlug, shares: t.shares,
          trigger: "wallet-first-startup",
          context: { direction: "kal→pm", pmTokenId: t.pmTokenId, pmOutcome: t.pmOutcome },
        });
      } else {
        unmatchedIds.push(t.id);
        console.warn(
          `[WALLET-FIRST] No Discovery match for KAL orphan ${t.id.slice(0, 50)}` +
          ` (${t.kalTicker}) — manual action required`
        );
      }
    } else if (!t.kalTicker && t.pmTokenId) {
      // PM-held orphan — look up KAL counterpart
      const m = byPmTokenId.get(t.pmTokenId);
      if (m) {
        t.kalTicker = m.kalLeg.ticker;
        paired++;
        changed = true;
        console.log(
          `[WALLET-FIRST] Paired PM orphan ${t.id.slice(0, 50)}` +
          ` (${t.pmOutcome || t.pmTokenId.slice(0, 10)}) → KAL ${m.kalLeg.ticker}`
        );
        audit({
          module: "persist", fn: "pairOrphanBackfills", action: "orphan-paired",
          tradeId: t.id, kalTicker: t.kalTicker, pmSlug: t.pmSlug, shares: t.shares,
          trigger: "wallet-first-startup",
          context: { direction: "pm→kal", pmTokenId: t.pmTokenId },
        });
      } else {
        unmatchedIds.push(t.id);
        console.warn(
          `[WALLET-FIRST] No Discovery match for PM orphan ${t.id.slice(0, 50)}` +
          ` (${t.pmOutcome || "no-outcome"}) — manual action required`
        );
      }
    }
  }

  if (changed) saveArbTrades(trades);
  return { paired, unmatched: unmatchedIds.length, unmatchedIds };
}

// ── Phase 3: Enrich reconstructed positions with watchlist leg metadata ─────
// `recoverOrphanedHedgeTrades()` creates positions with stub legs (yesAsk=0,
// missing pmOppLeg, default tickSize/negRisk). This fills them in so the hedge
// cycle has the data it needs.
export function enrichPositionsWithWatchlist(
  states: HedgeState[],
  watchlist: WatchEntry[]
): { enriched: number } {
  const { byKalTicker, byPmTokenId } = buildWatchlistIndexes(watchlist);
  let enriched = 0;

  for (const hs of states) {
    const pos = hs.position;
    const m =
      (pos.kalLeg?.ticker && byKalTicker.get(pos.kalLeg.ticker)) ||
      (pos.pmLeg?.tokenId && byPmTokenId.get(pos.pmLeg.tokenId));
    if (!m) continue;

    let changedHere = false;

    // Enrich kalLeg if stubbed (yesAsk=0 indicates no fresh data)
    if (!pos.kalLeg.surname || (pos.kalLeg.yesAsk === 0 && pos.kalLeg.noAsk === 0)) {
      pos.kalLeg = {
        ticker: pos.kalLeg.ticker || m.kalLeg.ticker,
        surname: m.kalLeg.surname,
        yesAsk: m.kalLeg.yesAsk,
        noAsk: m.kalLeg.noAsk,
        yesAskSize: m.kalLeg.yesAskSize,
        noAskSize: m.kalLeg.noAskSize,
      };
      changedHere = true;
    }

    // Enrich pmLeg if tickSize missing (defaulted to 0.01 by recovery path)
    if (!pos.pmLeg.minSize || pos.pmLeg.feeRate == null || !pos.pmLeg.outcome) {
      pos.pmLeg = {
        outcome: pos.pmLeg.outcome || m.pmLeg.outcome,
        tokenId: pos.pmLeg.tokenId || m.pmLeg.tokenId,
        noTokenId: pos.pmLeg.noTokenId || m.pmLeg.noTokenId,
        tickSize: m.pmLeg.tickSize,
        minSize: m.pmLeg.minSize,
        negRisk: m.pmLeg.negRisk,
        feeRate: m.pmLeg.feeRate,
      };
      changedHere = true;
    }

    // Populate pmOppLeg if missing (critical for hedge cycle on KAL-held positions)
    if (!pos.pmOppLeg) {
      pos.pmOppLeg = m.pmOppLeg;
      changedHere = true;
    }

    if (changedHere) enriched++;
  }

  return { enriched };
}

// ── Phase 2.5: Pair PM-only hedge_state entries with live Kalshi positions ─
// After Phase 1+2, hedge_state may have entries with kalTicker set but
// kalCostBasis=0 / initialCost=0 — because the trade was born from auto-backfill-pm
// and Phase 1 only populated the ticker (not the cost basis, which it can't know
// without querying Kalshi). If Kalshi actually holds shares on that ticker, the
// position IS hedged on-chain but the dashboard shows it as naked because the
// trade + hedge_state records have kalCost=0.
//
// This phase queries live Kalshi positions and backfills cost/fillPrice fields
// on any hedge_state (and its matching arb trade) where KAL has shares for the
// ticker. Conservatively ONLY populates missing data — never overwrites existing
// values. If KAL shares ≈ PM shares, the normal hedge cycle will then see
// sharesHeld=0 and resolve the trade naturally.
export async function pairWithLiveKalPositions(): Promise<{ linked: number; skipped: number; duplicateClaims: number }> {
  let linked = 0, skipped = 0, duplicateClaims = 0;
  let kalMap: Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>;
  try {
    kalMap = await getKalshiPositionMap();
  } catch (e) {
    console.warn(`[WALLET-FIRST] Live Kalshi position fetch failed: ${(e as Error).message} — skipping phase 2.5`);
    return { linked: 0, skipped: 0, duplicateClaims: 0 };
  }
  if (kalMap.size === 0) {
    console.log(`[WALLET-FIRST] No live Kalshi positions to pair against`);
    return { linked: 0, skipped: 0, duplicateClaims: 0 };
  }

  const states = loadHedgeStates();
  const trades = loadArbTrades();
  const tradeById = new Map(trades.map(t => [t.id, t]));
  let statesChanged = false;
  let tradesChanged = false;

  // Dedup: each (kalTicker, side) can be claimed by AT MOST ONE hedge_state record.
  // Without this, two PM records on the same market (e.g. Arsenal Over + Arsenal Under
  // both in arb_trades) would both grab the KAL YES position's cost basis, double-counting.
  const claimedTickerSide = new Set<string>();

  for (const hs of states) {
    const pos = hs.position;
    const ticker = pos.kalLeg?.ticker;
    if (!ticker) { skipped++; continue; }

    const kalPos = kalMap.get(ticker);
    if (!kalPos) { skipped++; continue; }

    const yesCount = kalPos.yesCount ?? 0;
    const noCount = kalPos.noCount ?? 0;
    const avgPrice = (kalPos.avgPriceCents ?? 0) / 100;
    if ((yesCount === 0 && noCount === 0) || avgPrice === 0) { skipped++; continue; }

    // Only link if cost basis not already populated (never overwrite real data)
    const needsUpdate = !pos.kalCostBasis || pos.kalCostBasis === 0 || !pos.initialCost || pos.initialCost === 0;
    if (!needsUpdate) { skipped++; continue; }

    // Determine side by which count is non-zero (YES vs NO)
    const side: "yes" | "no" = yesCount > 0 ? "yes" : "no";
    const shares = side === "yes" ? yesCount : noCount;

    // Skip if another record already claimed this (ticker, side). Prevents the
    // Arsenal-style double-attribution seen 2026-04-18: 2 PM records on same
    // EPL market each grabbed the full 16-share KAL YES cost basis.
    const claimKey = `${ticker}:${side}`;
    if (claimedTickerSide.has(claimKey)) {
      duplicateClaims++;
      console.warn(`[WALLET-FIRST] Skipping ${ticker} ${side.toUpperCase()} for trade ${pos.tradeId.slice(0, 40)} — already claimed by another record`);
      continue;
    }
    claimedTickerSide.add(claimKey);

    // Populate hedge_state position
    pos.kalCostBasis = avgPrice;
    pos.kalSide = side;
    // initialCost represents the cost of the leg we're hedging FROM; preserve heldExchange semantics
    if (pos.heldExchange === "kal") {
      pos.initialCost = shares * avgPrice;
    } else if (pos.heldExchange === "pm") {
      // For PM-held positions: the KAL position is the HEDGE side. Record as hedgeFillCostKal.
      if (!pos.hedgeFillCostKal || pos.hedgeFillCostKal === 0) {
        pos.hedgeFillCostKal = shares * avgPrice;
        if (!pos.hedgeFillCost || pos.hedgeFillCost === 0) pos.hedgeFillCost = pos.hedgeFillCostKal;
      }
    }
    statesChanged = true;

    // Update the matching trade record too
    const trade = tradeById.get(pos.tradeId);
    if (trade && (!trade.kalCost || trade.kalCost === 0)) {
      trade.kalCost = shares * avgPrice;
      trade.kalFillPrice = avgPrice;
      tradesChanged = true;
    }

    linked++;
    console.log(
      `[WALLET-FIRST] Paired live KAL position: ${ticker.slice(0, 40)} ${side.toUpperCase()} ` +
      `${shares}×${(avgPrice * 100).toFixed(1)}¢ = $${(shares * avgPrice).toFixed(2)} → trade ${pos.tradeId.slice(0, 40)}`
    );
    audit({
      module: "persist", fn: "pairWithLiveKalPositions", action: "kal-position-linked",
      tradeId: pos.tradeId, kalTicker: ticker, shares,
      trigger: "wallet-first-startup",
      context: { side, avgPrice, heldExchange: pos.heldExchange },
    });
  }

  if (statesChanged) saveHedgeStates(states);
  if (tradesChanged) saveArbTrades(trades);
  return { linked, skipped, duplicateClaims };
}

// ── Phase 4: Purge stale hedge_state entries ────────────────────────────────
// A stale entry is one whose tradeId doesn't appear in arb_trades.json, OR
// whose trade is already resolved. These leftover entries cause the hedge
// cycle to operate on ghost positions.
export function purgeStaleHedgeStates(): { purged: number; purgedIds: string[] } {
  const trades = loadArbTrades();
  const tradeById = new Map(trades.map(t => [t.id, t]));
  const current = loadHedgeStates();

  const purgedIds: string[] = [];
  const kept = current.filter(hs => {
    const trade = tradeById.get(hs.position.tradeId);
    if (!trade) {
      purgedIds.push(`${hs.position.tradeId} (no matching trade)`);
      return false;
    }
    if (trade.status === "resolved") {
      purgedIds.push(`${hs.position.tradeId} (trade already resolved)`);
      return false;
    }
    return true;
  });

  if (purgedIds.length > 0) {
    saveHedgeStates(kept);
    audit({
      module: "persist", fn: "purgeStaleHedgeStates", action: "stale-states-purged",
      tradeId: "", kalTicker: "", shares: 0,
      trigger: "wallet-first-startup",
      context: { count: purgedIds.length, purged: purgedIds.slice(0, 10) },
    });
  }

  return { purged: purgedIds.length, purgedIds };
}

// ── Phase 5: wallet-first hedge scan ────────────────────────────────────────
// Walks the live Kalshi + Polymarket wallets, groups holdings by match (via
// watchlist + pair_history), and computes per-outcome payout exposure.
// Surfaces positions that are imbalanced (gap in $ payout across outcomes)
// or lack a watchlist counterpart for manual review via the dashboard.
//
// Per user spec (2026-04-20): does NOT auto-create synthetic trades or hedge
// orders. Detection + flagging only. Every flag is persisted to
// data/hedge_manual_flags.json with a stable id; rescans preserve `ignored`
// markers so dismissed flags stay dismissed.
//
// Flag is raised when max_payout - min_payout >= GAP_TOLERANCE_USD (default
// $1 — equivalent to 1 share imbalance). Costs are summed from both sides.
const GAP_TOLERANCE_USD = 1.0;

type WalletPositionsByMatch = {
  matchKey: string;                // pmSlug when watchlisted, else orphan-*
  matchName: string;
  entry: WatchEntry | null;
  kalByTicker: Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>;
  pmByTokenId: Map<string, { shares: number; avgPrice: number; outcome: string; title?: string }>;
};

function _flagId(kalTickers: string[], pmTokenIds: string[]): string {
  const key = [...kalTickers].sort().join(",") + "|" + [...pmTokenIds].sort().join(",");
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

// Find the WatchEntry object containing a given kalTicker / pmTokenId.
function _findEntryFor(kalTicker: string | null, pmTokenId: string | null, watchlist: WatchEntry[]): WatchEntry | null {
  for (const w of watchlist) {
    if (kalTicker) {
      if (w.kal1?.ticker === kalTicker || w.kal2?.ticker === kalTicker || w.kal3?.ticker === kalTicker) return w;
    }
    if (pmTokenId) {
      if (w.pm1?.tokenId === pmTokenId || w.pm2?.tokenId === pmTokenId || w.pm3?.tokenId === pmTokenId) return w;
      if (w.pm1?.noTokenId === pmTokenId || w.pm2?.noTokenId === pmTokenId || w.pm3?.noTokenId === pmTokenId) return w;
    }
  }
  return null;
}

// Compute $-payout per outcome for a match given wallet positions. Returns one
// payout entry per outcome (2 for binary, 3 for soccer 3-way). Each entry
// is the total $ the user would receive (shares × $1) if that outcome wins.
//
// Kalshi YES on ticker X = pays $1 if ticker X settles YES.
// Kalshi NO on ticker X = pays $1 if ticker X settles NO.
// PM token T = pays $1 if that outcome wins.
//
// For 2-way moneyline (kal1=TeamA, kal2=TeamB, pm1=TeamA, pm2=TeamB):
//   payout(A wins) = kal1.yes + kal2.no + pm1
//   payout(B wins) = kal1.no + kal2.yes + pm2
// For 3-way soccer (kal1=Home, kal2=Away, kal3=Draw):
//   payout(Home) = kal1.yes + kal2.no + kal3.no + pm1
//   payout(Away) = kal1.no + kal2.yes + kal3.no + pm2
//   payout(Draw) = kal1.no + kal2.no + kal3.yes + pm3
// For isBinary (single-ticker totals/spreads): kal1===kal2, 2 outcomes labeled
// by pm1.outcome / pm2.outcome.
function _computePayouts(
  wpm: WalletPositionsByMatch,
): Array<{ outcome: string; payout: number }> {
  const entry = wpm.entry;
  if (!entry) {
    // No watchlist info — flatten raw positions. Outcome labels from PM position data.
    const out: Array<{ outcome: string; payout: number }> = [];
    for (const [ticker, k] of wpm.kalByTicker) {
      if (k.yesCount > 0) out.push({ outcome: `${ticker}:yes`, payout: k.yesCount });
      if (k.noCount > 0) out.push({ outcome: `${ticker}:no`, payout: k.noCount });
    }
    for (const [tid, p] of wpm.pmByTokenId) {
      out.push({ outcome: p.outcome || `pm:${tid.slice(0, 8)}`, payout: p.shares });
    }
    return out;
  }

  const kal1 = wpm.kalByTicker.get(entry.kal1?.ticker) ?? { yesCount: 0, noCount: 0, avgPriceCents: 0 };
  const kal2 = wpm.kalByTicker.get(entry.kal2?.ticker) ?? { yesCount: 0, noCount: 0, avgPriceCents: 0 };
  const kal3 = entry.kal3 ? (wpm.kalByTicker.get(entry.kal3.ticker) ?? { yesCount: 0, noCount: 0, avgPriceCents: 0 }) : null;
  const pm1 = (wpm.pmByTokenId.get(entry.pm1?.tokenId)?.shares) ?? 0;
  const pm2 = (wpm.pmByTokenId.get(entry.pm2?.tokenId)?.shares) ?? 0;
  const pm3 = entry.pm3 ? ((wpm.pmByTokenId.get(entry.pm3.tokenId)?.shares) ?? 0) : 0;

  if (entry.is3Way && entry.kal3 && entry.pm3) {
    return [
      { outcome: entry.pm1?.outcome || "Home", payout: kal1.yesCount + kal2.noCount + (kal3?.noCount ?? 0) + pm1 },
      { outcome: entry.pm2?.outcome || "Away", payout: kal1.noCount + kal2.yesCount + (kal3?.noCount ?? 0) + pm2 },
      { outcome: entry.pm3?.outcome || "Draw", payout: kal1.noCount + kal2.noCount + (kal3?.yesCount ?? 0) + pm3 },
    ];
  }
  if (entry.isBinary) {
    // Single-ticker totals/spreads (kal1 === kal2). YES/NO on kal1 pair with pm1/pm2.
    return [
      { outcome: entry.pm1?.outcome || "YES", payout: kal1.yesCount + pm1 },
      { outcome: entry.pm2?.outcome || "NO",  payout: kal1.noCount  + pm2 },
    ];
  }
  // 2-way moneyline
  return [
    { outcome: entry.pm1?.outcome || "Team1", payout: kal1.yesCount + kal2.noCount + pm1 },
    { outcome: entry.pm2?.outcome || "Team2", payout: kal1.noCount + kal2.yesCount + pm2 },
  ];
}

// Determine whether a match is eligible for AUTO-HEDGE (synthetic arb trade +
// hedge_state entry creation) based on the wallet holdings and the watchlist
// pairing. Per user spec 2026-04-20:
//   - Only one-sided positions (KAL-only OR PM-only, not both) auto-hedge.
//   - Both-sides-present = MANUAL review (too many ways for auto-action to
//     misread an intentional stacked bet as an over-fill).
//   - `trust + add`: if hedge_state already tracks any of these tickers or
//     tokens, skip creation (existing hedge cycle handles it).
type AutoHedgePlan = {
  eligible: boolean;
  reason: string;
  heldExchange?: "kal" | "pm";
  sharesHeld?: number;
  initialCost?: number;
  kalLeg?: KalshiLeg;
  kalOppLeg?: KalshiLeg | null;  // opposite Kalshi ticker for cross-KAL hedge (2-way moneyline only)
  pmLeg?: PmLeg;
  pmOppLeg?: PmLeg | null;
  kalSide?: "yes" | "no";
  kalCostBasis?: number;
  pmCostBasis?: number;
};

function _planAutoHedge(
  wpm: WalletPositionsByMatch,
  existingStates: HedgeState[],
  existingTradesByKalTicker: Map<string, string>,
  existingTradesByPmTokenId: Map<string, string>,
): AutoHedgePlan {
  if (!wpm.entry) return { eligible: false, reason: "no-watchlist-entry" };

  // trust + add: skip if any existing hedge_state already covers this match's legs
  for (const hs of existingStates) {
    const ht = hs.position.kalLeg?.ticker;
    const pt = hs.position.pmLeg?.tokenId;
    if (ht && wpm.kalByTicker.has(ht)) return { eligible: false, reason: `already tracked by hedge_state ${hs.position.tradeId.slice(0, 40)}` };
    if (pt && wpm.pmByTokenId.has(pt)) return { eligible: false, reason: `already tracked by hedge_state ${hs.position.tradeId.slice(0, 40)}` };
  }

  // BUGFIX 2026-04-20: also check arb_trades.json for ANY trade (resolved or
  // hedging) touching this kalTicker or pmTokenId. Resolved trades are purged
  // from hedge_state (Phase 4), so the old check alone missed them and created
  // synthetic duplicates for already-paired positions. If wallet shares exceed
  // what the trade(s) account for (genuine over-fill), the extra exposure
  // will land in the manual-flag path downstream — NOT auto-hedged, because
  // we can't tell over-fill from an intentional stacked bet.
  for (const kt of wpm.kalByTicker.keys()) {
    const tradeId = existingTradesByKalTicker.get(kt);
    if (tradeId) return { eligible: false, reason: `already tracked by arb_trades ${tradeId.slice(0, 40)}` };
  }
  for (const pt of wpm.pmByTokenId.keys()) {
    const tradeId = existingTradesByPmTokenId.get(pt);
    if (tradeId) return { eligible: false, reason: `already tracked by arb_trades ${tradeId.slice(0, 40)}` };
  }

  const kalSize = wpm.kalByTicker.size;
  const pmSize = wpm.pmByTokenId.size;
  if (kalSize > 0 && pmSize > 0) return { eligible: false, reason: "both-sides-present (manual review)" };
  if (kalSize === 0 && pmSize === 0) return { eligible: false, reason: "no-wallet-positions" };

  const entry = wpm.entry;

  if (kalSize > 0) {
    // KAL-only — one ticker, determine which side (yes/no)
    for (const [ticker, kp] of wpm.kalByTicker) {
      const side: "yes" | "no" = kp.yesCount > 0 ? "yes" : "no";
      const shares = side === "yes" ? kp.yesCount : kp.noCount;
      if (shares <= 0) continue;
      const avgPrice = kp.avgPriceCents / 100;
      let kalLeg: KalshiLeg | null = null;
      let kalOppLeg: KalshiLeg | null = null;
      let pmLeg: PmLeg | null = null;
      let pmOppLeg: PmLeg | null = null;
      // Arb mapping:
      //   YES on kalN → opposite PM = pm[other]  (pair wins on either outcome)
      //   NO  on kalN → same-index PM = pmN      (pair wins on either outcome)
      // kalOppLeg = the OTHER Kalshi ticker on the same match. Only meaningful for
      // 2-way moneyline where kal1.ticker !== kal2.ticker (distinct markets per
      // player). For isBinary totals/spreads, kal1 === kal2 so no paired ticker.
      const hasSeparateKalMarkets = entry.kal1?.ticker && entry.kal2?.ticker && entry.kal1.ticker !== entry.kal2.ticker;
      if (entry.kal1?.ticker === ticker) {
        kalLeg = entry.kal1;
        if (hasSeparateKalMarkets) kalOppLeg = entry.kal2;
        pmLeg = side === "yes" ? entry.pm2 : entry.pm1;
        pmOppLeg = side === "yes" ? entry.pm1 : entry.pm2;
      } else if (entry.kal2?.ticker === ticker) {
        kalLeg = entry.kal2;
        if (hasSeparateKalMarkets) kalOppLeg = entry.kal1;
        pmLeg = side === "yes" ? entry.pm1 : entry.pm2;
        pmOppLeg = side === "yes" ? entry.pm2 : entry.pm1;
      } else if (entry.kal3?.ticker === ticker && entry.pm3) {
        kalLeg = entry.kal3;
        // 3-way draw market — no single "opposite" Kalshi ticker, so no kalOppLeg
        pmLeg = side === "yes" ? entry.pm1 : entry.pm3;
        pmOppLeg = side === "yes" ? entry.pm3 : entry.pm1;
      }
      if (!kalLeg || !pmLeg) continue;
      return {
        eligible: true, reason: `KAL-only ${shares}×${side} on ${ticker} — auto-create hedge (gap=${shares}, venue=${shares < 5 ? "KAL-vs-KAL" : "PM"})`,
        heldExchange: "kal", sharesHeld: shares, initialCost: shares * avgPrice,
        kalLeg, kalOppLeg, pmLeg, pmOppLeg, kalSide: side, kalCostBasis: avgPrice,
      };
    }
    return { eligible: false, reason: "kal-only but no usable ticker mapping" };
  }

  // PM-only
  for (const [tid, p] of wpm.pmByTokenId) {
    let pmLeg: PmLeg | null = null;
    let pmOppLeg: PmLeg | null = null;
    let kalLeg: KalshiLeg | null = null;
    let kalOppLeg: KalshiLeg | null = null;
    const kalSide: "yes" | "no" = "no"; // PM pmN ↔ KAL kalN NO side (opposite outcomes)
    const hasSeparateKalMarkets = entry.kal1?.ticker && entry.kal2?.ticker && entry.kal1.ticker !== entry.kal2.ticker;
    if (entry.pm1?.tokenId === tid) {
      pmLeg = entry.pm1; pmOppLeg = entry.pm2; kalLeg = entry.kal1;
      if (hasSeparateKalMarkets) kalOppLeg = entry.kal2;
    } else if (entry.pm2?.tokenId === tid) {
      pmLeg = entry.pm2; pmOppLeg = entry.pm1; kalLeg = entry.kal2;
      if (hasSeparateKalMarkets) kalOppLeg = entry.kal1;
    } else if (entry.pm3?.tokenId === tid) {
      pmLeg = entry.pm3; pmOppLeg = entry.pm1; kalLeg = entry.kal3 ?? entry.kal1;
    }
    if (!pmLeg || !kalLeg) continue;
    return {
      eligible: true, reason: `PM-only ${p.shares}×${p.outcome} on ${tid.slice(0, 20)}… — auto-create hedge (gap=${p.shares}, venue=${p.shares >= 5 ? "PM-vs-PM" : "KAL"})`,
      heldExchange: "pm", sharesHeld: p.shares, initialCost: p.shares * p.avgPrice,
      kalLeg, kalOppLeg, pmLeg, pmOppLeg, kalSide, pmCostBasis: p.avgPrice,
    };
  }
  return { eligible: false, reason: "pm-only but no usable token mapping" };
}

// Create a synthetic arb_trade + hedge_state entry for an auto-hedge-eligible
// match. The hedge cycle will then run against this entry normally and place
// GTC bids to close the gap on the next cycle.
function _createSyntheticHedge(wpm: WalletPositionsByMatch, plan: AutoHedgePlan, flagId: string):
  { trade: ArbTradeRecord; state: HedgeState } | null
{
  if (!plan.eligible || !plan.kalLeg || !plan.pmLeg || !plan.heldExchange || plan.sharesHeld == null) return null;

  const tradeId = `arb-wallet-scan-${flagId}-${Date.now()}`;
  const ts = new Date().toISOString();
  const shares = Math.round(plan.sharesHeld); // integer shares (KAL constraint)
  const kalCost = plan.heldExchange === "kal" ? (plan.initialCost ?? 0) : 0;
  const pmCost = plan.heldExchange === "pm" ? (plan.initialCost ?? 0) : 0;

  const trade: ArbTradeRecord = {
    id: tradeId,
    ts,
    match: wpm.matchName,
    dir: plan.heldExchange === "kal"
      ? (plan.kalSide === "yes" ? "A" : "C")
      : (plan.kalSide === "yes" ? "A" : "C"),
    edge: 0,
    shares,
    cost: plan.initialCost ?? 0,
    fees: 0,
    kalTicker: plan.kalLeg.ticker,
    kalFillPrice: plan.kalCostBasis ?? 0,
    kalCost,
    kalFees: 0,
    pmTokenId: plan.pmLeg.tokenId,
    pmOutcome: plan.pmLeg.outcome,
    pmSlug: wpm.entry?.pmSlug ?? "",
    pmFillPrice: plan.pmCostBasis ?? 0,
    pmCost,
    pmFees: 0,
    totalCost: plan.initialCost ?? 0,
    status: "hedging",
    initialExchange: plan.heldExchange,
    projectedEdge: 0,
    projectedProfit: 0,
  } as ArbTradeRecord;

  const position: UnhedgedPosition = {
    tradeId,
    heldExchange: plan.heldExchange,
    pmLeg: plan.pmLeg,
    pmOppLeg: plan.pmOppLeg ?? null,
    pmCostBasis: plan.pmCostBasis ?? 0,
    kalLeg: plan.kalLeg,
    kalOppLeg: plan.kalOppLeg ?? null,
    kalCostBasis: plan.kalCostBasis ?? 0,
    kalSide: plan.kalSide ?? "yes",
    sharesHeld: shares,
    initialShares: shares,
    initialCost: plan.initialCost ?? 0,
    hedgeFillCost: 0,
    hedgeFillCostKal: 0,
    hedgeFillCostPm: 0,
    kalFees: 0,
    initialKalFees: 0,
  };
  const state: HedgeState = {
    position,
    activeOrders: new Map<string, HedgeOrder>(),
    kalNextRetryAt: 0,
    pmOnlyCycles: 0,
  };
  return { trade, state };
}

// Total $ cost across all wallet legs in the match.
function _computeCost(wpm: WalletPositionsByMatch): number {
  let c = 0;
  for (const k of wpm.kalByTicker.values()) {
    c += ((k.yesCount + k.noCount) * k.avgPriceCents) / 100;
  }
  for (const p of wpm.pmByTokenId.values()) {
    c += p.shares * p.avgPrice;
  }
  return c;
}

export async function scanWalletAndFlagHedgeTargets(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number;                 // matches examined
  balanced: number;                // matches within gap tolerance
  flagged: number;                 // new or updated flags (manual review needed)
  autoHedged: number;              // synthetic trades + hedge_state created
  skippedIgnored: number;          // pre-ignored flags
  flags: ManualHedgeFlag[];        // the flag set (full, including ignored)
}> {
  const { dryRun = false } = opts;

  // 1. Fetch live wallets
  let kalMap: Map<string, { yesCount: number; noCount: number; avgPriceCents: number; marketExposureCents: number; feesPaidCents: number }>;
  try { kalMap = await getKalshiPositionMap(); }
  catch (e) {
    console.warn(`[WALLET-FIRST] KAL wallet fetch failed: ${(e as Error).message}`);
    kalMap = new Map();
  }
  let pmPositions: Array<{ asset?: string; tokenId?: string; size?: number | string; avgPrice?: number | string; outcome?: string; title?: string; }>;
  try { pmPositions = await fetchPmPositionsCached(0); }
  catch (e) {
    console.warn(`[WALLET-FIRST] PM wallet fetch failed: ${(e as Error).message}`);
    pmPositions = [];
  }

  // 2. Load watchlist + indexes
  const cache = loadDiscoveryCache();
  const watchlist = (cache && cache.watchlist) || [];
  const { byKalTicker, byPmTokenId } = buildWatchlistIndexes(watchlist);

  // 3. Group wallet holdings by match (pmSlug) — orphan entries get their own bucket.
  const matches = new Map<string, WalletPositionsByMatch>();
  const getOrCreate = (key: string, entry: WatchEntry | null, name: string): WalletPositionsByMatch => {
    let m = matches.get(key);
    if (!m) { m = { matchKey: key, matchName: name, entry, kalByTicker: new Map(), pmByTokenId: new Map() }; matches.set(key, m); }
    return m;
  };

  for (const [ticker, kalPos] of kalMap) {
    if (kalPos.yesCount === 0 && kalPos.noCount === 0) continue;
    const w = _findEntryFor(ticker, null, watchlist);
    const key = w ? w.pmSlug : `orphan-kal:${ticker}`;
    const name = w ? `${w.kal1?.surname ?? ""} vs ${w.kal2?.surname ?? ""}`.trim() || ticker : ticker;
    const m = getOrCreate(key, w, name);
    m.kalByTicker.set(ticker, { yesCount: kalPos.yesCount, noCount: kalPos.noCount, avgPriceCents: kalPos.avgPriceCents });
  }

  // Skip PM positions that have already settled (awaiting redemption). A PM
  // winner stays in the wallet until the user redeems it, and a PM loser
  // stays as a zero-value position. Either way, these shares don't need
  // hedging — they're post-resolution. Including them caused the scan to
  // mis-classify "resolved arb with PM winner pending redemption" as
  // "PM-only needs KAL hedge" and create bogus synthetic trades (the
  // 2026-04-20 21-duplicate incident). Filtering them here makes the scan
  // correct WITHOUT requiring arb_trades.json — the bot can operate
  // journal-free for this decision.
  const nowMsForSettled = Date.now();
  for (const p of pmPositions) {
    const tid = String(p.asset ?? p.tokenId ?? "");
    if (!tid) continue;
    const shares = Number(p.size ?? 0);
    if (!(shares > 0)) continue;
    // Settled = market ended OR currentValue/size ratio near 0 or 1.
    const curVal = Number((p as { currentValue?: number | string }).currentValue ?? 0);
    const ratio = shares > 0 ? curVal / shares : 0;
    const endStr = (p as { endDate?: string }).endDate;
    const endMs = endStr ? new Date(endStr).getTime() : NaN;
    const endPast = Number.isFinite(endMs) && endMs < nowMsForSettled;
    const settled = endPast || ratio > 0.95 || ratio < 0.05;
    if (settled) continue;  // post-resolution; not an unhedged exposure
    const avgPrice = Number(p.avgPrice ?? 0);
    const outcome = String(p.outcome ?? "");
    const title = p.title != null ? String(p.title) : undefined;
    const w = _findEntryFor(null, tid, watchlist);
    const key = w ? w.pmSlug : `orphan-pm:${tid}`;
    const name = w ? `${w.kal1?.surname ?? ""} vs ${w.kal2?.surname ?? ""}`.trim() || (title ?? tid) : (title ?? `pm:${tid.slice(0, 12)}…`);
    const m = getOrCreate(key, w, name);
    m.pmByTokenId.set(tid, { shares, avgPrice, outcome, title });
  }

  // 4. For each match, compute payouts + classify
  const existingFlags = loadManualHedgeFlags();
  const existingById = new Map(existingFlags.map(f => [f.id, f]));
  const existingStates = loadHedgeStates();
  // Also index arb_trades.json (resolved + hedging) so _planAutoHedge can
  // skip positions that are already paired via a journaled trade. Without
  // this, resolved trades — which get purged from hedge_state by Phase 4 —
  // produce duplicate synthetic entries in Phase 5 (bug observed 2026-04-20).
  const existingTrades = loadArbTrades();
  const existingTradesByKalTicker = new Map<string, string>();
  const existingTradesByPmTokenId = new Map<string, string>();
  for (const t of existingTrades) {
    if (t.kalTicker && !existingTradesByKalTicker.has(t.kalTicker)) existingTradesByKalTicker.set(t.kalTicker, t.id);
    if (t.pmTokenId && !existingTradesByPmTokenId.has(t.pmTokenId)) existingTradesByPmTokenId.set(t.pmTokenId, t.id);
  }
  const now = Date.now();
  const nextFlags: ManualHedgeFlag[] = [];
  const newTrades: ArbTradeRecord[] = [];
  const newStates: HedgeState[] = [];

  let balanced = 0;
  let flagged = 0;
  let autoHedged = 0;
  let skippedIgnored = 0;

  for (const wpm of matches.values()) {
    const payouts = _computePayouts(wpm);
    const cost = _computeCost(wpm);
    const kalTickers = [...wpm.kalByTicker.keys()].sort();
    const pmTokenIds = [...wpm.pmByTokenId.keys()].sort();
    const id = _flagId(kalTickers, pmTokenIds);

    const max = payouts.reduce((s, p) => p.payout > s ? p.payout : s, 0);
    const min = payouts.reduce((s, p) => p.payout < s ? p.payout : s, Infinity);
    const gap = Number.isFinite(min) ? max - min : 0;

    let classification: ManualHedgeFlag["classification"];
    let reason: string;

    if (!wpm.entry) {
      classification = "no-watchlist-match";
      reason = wpm.kalByTicker.size > 0 && wpm.pmByTokenId.size === 0
        ? `KAL-only position on ${kalTickers[0]} — no watchlist entry, no PM counterpart to hedge with`
        : wpm.pmByTokenId.size > 0 && wpm.kalByTicker.size === 0
        ? `PM-only position on ${pmTokenIds[0]?.slice(0, 12)}… — no watchlist entry`
        : `Holdings in both wallets but no shared watchlist entry`;
    } else if (gap < GAP_TOLERANCE_USD) {
      balanced++;
      continue;
    } else {
      // Imbalanced with watchlist entry → re-check (user directive #1: verify before flagging)
      const hasBothSides = wpm.kalByTicker.size > 0 && wpm.pmByTokenId.size > 0;
      if (hasBothSides && max >= min * 2) {
        classification = "over-fill";
        reason = `One side has ≥2x the payout of the other — likely PM over-fill or duplicate arb attempt. max=$${max.toFixed(2)} min=$${min.toFixed(2)}`;
      } else if (wpm.kalByTicker.size === 0) {
        classification = "imbalance";
        reason = `PM-only exposure of $${max.toFixed(2)} with no KAL counterpart — KAL leg likely failed to fill`;
      } else if (wpm.pmByTokenId.size === 0) {
        classification = "imbalance";
        reason = `KAL-only exposure of $${max.toFixed(2)} with no PM counterpart — PM leg likely failed to fill`;
      } else {
        classification = "imbalance";
        reason = `Gap of $${gap.toFixed(2)} between outcome payouts`;
      }
    }

    // AUTO-HEDGE path: for clean one-sided imbalances (KAL-only or PM-only)
    // with a watchlist entry, create a synthetic arb_trade + hedge_state so
    // the regular hedge cycle picks it up and places GTC bids to close the
    // gap. Skip: over-fills, no-watchlist, both-sides-present, pre-ignored.
    if (classification === "imbalance") {
      const plan = _planAutoHedge(wpm, [...existingStates, ...newStates], existingTradesByKalTicker, existingTradesByPmTokenId);
      if (plan.eligible) {
        const created = _createSyntheticHedge(wpm, plan, id);
        if (created) {
          // Don't auto-hedge positions that are already flagged as ignored by the user.
          const prior = existingById.get(id);
          if (prior?.ignored) {
            skippedIgnored++;
            nextFlags.push({ ...prior, lastSeenAt: now, gap, costExposure: cost, payouts });
            continue;
          }
          autoHedged++;
          newTrades.push(created.trade);
          newStates.push(created.state);
          console.log(
            `[WALLET-FIRST] AUTO-HEDGE ${wpm.matchName}: ${plan.reason} → tradeId=${created.trade.id.slice(0, 50)}`,
          );
          audit({
            module: "persist", fn: "scanWalletAndFlagHedgeTargets", action: "auto-hedge-created",
            tradeId: created.trade.id, kalTicker: created.trade.kalTicker ?? "",
            shares: created.state.position.sharesHeld,
            trigger: "wallet-first-startup",
            context: { matchName: wpm.matchName, heldExchange: plan.heldExchange, gap, cost },
          });
          continue; // auto-hedged → don't also emit a manual flag
        }
      }
    }

    const prior = existingById.get(id);
    if (prior?.ignored) {
      skippedIgnored++;
      // Keep the ignored flag in the file but refresh lastSeenAt.
      nextFlags.push({ ...prior, lastSeenAt: now, gap, costExposure: cost, payouts });
      continue;
    }
    flagged++;
    nextFlags.push({
      id,
      matchKey: wpm.matchKey,
      matchName: wpm.matchName,
      classification,
      reason,
      kalTickers,
      pmTokenIds,
      gap,
      costExposure: cost,
      payouts,
      firstSeenAt: prior?.firstSeenAt ?? now,
      lastSeenAt: now,
      ignored: false,
    });
  }

  // 5. Persist (unless dry-run). Stale flags (not re-seen this scan) drop out
  //    UNLESS they're ignored — we keep ignored flags for ~30 days so the user
  //    doesn't have to re-dismiss the same situation repeatedly.
  const STALE_IGNORE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const nextIds = new Set(nextFlags.map(f => f.id));
  for (const f of existingFlags) {
    if (nextIds.has(f.id)) continue;
    if (f.ignored && f.ignoredAt && (now - f.ignoredAt) < STALE_IGNORE_TTL_MS) {
      nextFlags.push(f);
    }
  }
  nextFlags.sort((a, b) => b.costExposure - a.costExposure);

  if (!dryRun) {
    saveManualHedgeFlags(nextFlags);
    // Persist auto-hedge synthetics. Merge with existing state — don't clobber.
    if (newTrades.length > 0) {
      const allTrades = loadArbTrades();
      allTrades.push(...newTrades);
      saveArbTrades(allTrades);
    }
    if (newStates.length > 0) {
      const allStates = loadHedgeStates();
      allStates.push(...newStates);
      saveHedgeStates(allStates);
    }
  }

  console.log(
    `[WALLET-FIRST] Scan complete. matches=${matches.size} balanced=${balanced} ` +
    `auto-hedged=${autoHedged} flagged=${flagged} pre-ignored=${skippedIgnored}${dryRun ? " (DRY RUN, not persisted)" : ""}`,
  );
  for (const f of nextFlags.filter(ff => !ff.ignored).slice(0, 10)) {
    console.log(`  [FLAG] ${f.matchName} — ${f.classification}: ${f.reason} (cost=$${f.costExposure.toFixed(2)} gap=$${f.gap.toFixed(2)})`);
  }

  return { scanned: matches.size, balanced, flagged, autoHedged, skippedIgnored, flags: nextFlags };
}

// ── Main entry point ────────────────────────────────────────────────────────
export async function runWalletFirstStartup(opts: { forceDiscovery?: boolean } = {}): Promise<{
  orphansPaired: number;
  orphansUnmatched: number;
  hedgeStatesRecovered: number;
  positionsEnriched: number;
  kalPositionsLinked: number;
  stalePurged: number;
  walletScanFlagged: number;
  walletScanBalanced: number;
  walletScanAutoHedged: number;
}> {
  console.log(`[WALLET-FIRST] Starting wallet-first hedge state reconstruction...`);

  const watchlist = await loadOrRefreshDiscovery(!!opts.forceDiscovery);

  // Phase 1: Pair orphan backfill trades with their counterpart market
  const { paired, unmatched } = watchlist.length > 0
    ? await pairOrphanBackfills(watchlist)
    : { paired: 0, unmatched: 0 };

  // Phase 2: Rebuild hedge_state for hedging trades that lack one
  const recovered = recoverOrphanedHedgeTrades();

  // Phase 2.5: Backfill kalCost/kalFillPrice from live Kalshi positions
  // (dashboard was showing orphans as unhedged because Phase 1 only set the
  // ticker — not the cost basis. Querying Kalshi gives us the actual fill data.)
  const { linked: kalPositionsLinked } = await pairWithLiveKalPositions();

  // Phase 3: Enrich all hedge states with watchlist leg metadata
  let positionsEnriched = 0;
  if (watchlist.length > 0) {
    const allStates = loadHedgeStates();
    const { enriched } = enrichPositionsWithWatchlist(allStates, watchlist);
    if (enriched > 0) saveHedgeStates(allStates);
    positionsEnriched = enriched;
  }

  // Phase 4: Purge stale hedge_state entries
  const { purged } = purgeStaleHedgeStates();

  // Phase 5: Wallet-first hedge scan — surface imbalances and orphan exposures
  // for manual review. Does NOT auto-create hedge orders. Writes to
  // data/hedge_manual_flags.json; dashboard displays with an Ignore action.
  const { flagged: walletScanFlagged, balanced: walletScanBalanced, autoHedged: walletScanAutoHedged } = await scanWalletAndFlagHedgeTargets();

  console.log(
    `[WALLET-FIRST] Complete. paired=${paired} unmatched=${unmatched} ` +
    `recovered=${recovered.length} kalLinked=${kalPositionsLinked} ` +
    `enriched=${positionsEnriched} stalePurged=${purged} ` +
    `scanAutoHedged=${walletScanAutoHedged} scanFlagged=${walletScanFlagged} scanBalanced=${walletScanBalanced}`
  );

  return {
    orphansPaired: paired,
    orphansUnmatched: unmatched,
    hedgeStatesRecovered: recovered.length,
    positionsEnriched,
    kalPositionsLinked,
    stalePurged: purged,
    walletScanFlagged,
    walletScanBalanced,
    walletScanAutoHedged,
  };
}
