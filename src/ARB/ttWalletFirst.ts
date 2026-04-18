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

import type { WatchEntry, HedgeState, PmLeg, KalshiLeg } from "./ttTypes.js";
import { loadDiscoveryCache, discoverWatchlist } from "./ttDiscovery.js";
import {
  loadArbTrades, saveArbTrades, loadHedgeStates, saveHedgeStates,
  recoverOrphanedHedgeTrades,
} from "./ttPersistence.js";
import { audit } from "./ttAuditLog.js";
import { getKalshiPositionMap } from "../kalshiTrade.js";

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

// ── Main entry point ────────────────────────────────────────────────────────
export async function runWalletFirstStartup(opts: { forceDiscovery?: boolean } = {}): Promise<{
  orphansPaired: number;
  orphansUnmatched: number;
  hedgeStatesRecovered: number;
  positionsEnriched: number;
  kalPositionsLinked: number;
  stalePurged: number;
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

  console.log(
    `[WALLET-FIRST] Complete. paired=${paired} unmatched=${unmatched} ` +
    `recovered=${recovered.length} kalLinked=${kalPositionsLinked} ` +
    `enriched=${positionsEnriched} stalePurged=${purged}`
  );

  return {
    orphansPaired: paired,
    orphansUnmatched: unmatched,
    hedgeStatesRecovered: recovered.length,
    positionsEnriched,
    kalPositionsLinked,
    stalePurged: purged,
  };
}
