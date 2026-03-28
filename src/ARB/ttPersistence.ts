/**
 * ttPersistence.ts — All file-based load/save functions for arb trades,
 * hedge states, pending fills, execution metrics, depth opportunities,
 * and book snapshots. Includes in-memory caching for loadArbTrades().
 *
 * Module-level mutable state:
 *   _allHedgeStates        — current hedge state array (set externally by hedge cycle)
 *   _reconcileRecoveredTrades — flag for reconcile-triggered hedge pickup
 *   _activePendingFillId   — pending fill currently being executed
 *   kalBookCache           — short-lived Kalshi orderbook pre-cache
 *   _arbTradesCache / _arbTradesCacheTs — in-memory arb trades cache
 */

import fs from "fs";
import path from "path";
import { atomicWriteFileSync, DRY_RUN } from "./ttConfig.js";
import { pushTradeData } from "../dashboardPush.js";
import type {
  ArbTradeRecord, ExecMetric,
  HedgeState, HedgeOrder, UnhedgedPosition, PersistedHedgeEntry,
  PendingFill, DepthLevel, DepthOpportunity, BookTrack,
} from "./ttTypes.js";

// ─── File paths ──────────────────────────────────────────────────────────────

export const HEDGE_STATE_PATH = "hedge_state.json";
export const ARB_LOG_PATH = path.join("data", "arb_trades.json");
export const PENDING_FILLS_PATH = path.join("data", "pending_fills.json");
export const METRICS_PATH = path.join("data", "execution_metrics.json");
export const DEPTH_OPP_PATH = path.join("data", "depth_opportunities.json");
export const BOOK_SNAPSHOTS_PATH = path.join("data", "book_snapshots.json");

const DEPTH_OPP_MAX = 500;
const BOOK_TRACK_MAX = 200;

// ─── Module-level mutable state ──────────────────────────────────────────────

/** Current hedge states — set by the hedge cycle, read by saveHedgeState wrapper. */
export let _allHedgeStates: HedgeState[] = [];
export function setAllHedgeStates(states: HedgeState[]): void { _allHedgeStates = states; }

/** Flag set by reconcilePositions when auto-recovered trades need hedge pickup. */
export let _reconcileRecoveredTrades = false;
export function setReconcileRecoveredTrades(v: boolean): void { _reconcileRecoveredTrades = v; }

/** Active pending fill ID for current execution — set before order placement. */
export let _activePendingFillId: string | null = null;
export function setActivePendingFillId(v: string | null): void { _activePendingFillId = v; }

/** Kalshi orderbook pre-cache (3s TTL). */
export const kalBookCache = new Map<string, { book: { yes: [number, number][]; no: [number, number][] }; ts: number }>();
export const BOOK_CACHE_TTL = 3000;

// ─── In-memory arb trades cache ──────────────────────────────────────────────
// loadArbTrades() is called ~22× per cycle. Cache with invalidation on save.

let _arbTradesCache: ArbTradeRecord[] | null = null;
let _arbTradesCacheTs = 0;
const ARB_CACHE_TTL = 2000; // 2s — covers a full poll cycle

// ─── Hedge state persistence ─────────────────────────────────────────────────

/** Compatibility wrapper: saves the full _allHedgeStates array. */
export function saveHedgeState(_singleState: HedgeState | null): void {
  saveHedgeStates(_allHedgeStates);
}

export function saveHedgeStates(states: HedgeState[]): void {
  try {
    if (states.length === 0) {
      if (fs.existsSync(HEDGE_STATE_PATH)) fs.unlinkSync(HEDGE_STATE_PATH);
    } else {
      const data: PersistedHedgeEntry[] = states.map(s => ({
        position: s.position,
        activeOrders: [...s.activeOrders.entries()],
        kalNextRetryAt: s.kalNextRetryAt,
        lastCompleteExchange: s.lastCompleteExchange,
        pmOnlyCycles: s.pmOnlyCycles,
      }));
      atomicWriteFileSync(HEDGE_STATE_PATH, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error(`[HEDGE] Failed to save hedge state: ${(err as Error).message}`);
  }
}

export function loadHedgeStates(): HedgeState[] {
  try {
    if (!fs.existsSync(HEDGE_STATE_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(HEDGE_STATE_PATH, "utf8"));

    // Backwards compat: old format was a single PersistedHedgeEntry object, new format is array.
    const entries: PersistedHedgeEntry[] = Array.isArray(raw) ? raw : [raw];

    const result: HedgeState[] = [];
    for (const entry of entries) {
      if (!entry.position || entry.position.sharesHeld <= 0) continue;
      // Backwards compat: old hedge states won't have tradeId — match from arb_trades.json
      if (!entry.position.tradeId) {
        const trades = loadArbTrades();
        const match = trades.find(t => t.kalTicker === entry.position.kalLeg?.ticker && t.status === "hedging");
        entry.position.tradeId = match?.id ?? `arb-recovered-${Date.now()}`;
      }
      // Backwards compat: old hedge states won't have kalSide — default to "yes"
      if (!entry.position.kalSide) entry.position.kalSide = "yes";
      // Backwards compat: old hedge states won't have P&L tracking fields
      if (entry.position.initialShares == null) entry.position.initialShares = entry.position.sharesHeld;
      if (entry.position.initialCost == null) {
        const cb = entry.position.heldExchange === "pm" ? entry.position.pmCostBasis : entry.position.kalCostBasis;
        entry.position.initialCost = entry.position.initialShares * cb;
      }
      if (entry.position.hedgeFillCost == null) entry.position.hedgeFillCost = 0;
      if (entry.position.hedgeFillCostKal == null) entry.position.hedgeFillCostKal = 0;
      if (entry.position.hedgeFillCostPm == null) entry.position.hedgeFillCostPm = 0;
      const restoredOrders = new Map<string, HedgeOrder>(
        (entry.activeOrders ?? []).map(([oid, ho]) => [oid, { ...ho, fetchFailures: ho.fetchFailures ?? 0, placedAt: ho.placedAt ?? Date.now() }])
      );
      result.push({ position: entry.position, activeOrders: restoredOrders, kalNextRetryAt: entry.kalNextRetryAt ?? 0, lastCompleteExchange: entry.lastCompleteExchange, pmOnlyCycles: entry.pmOnlyCycles ?? 0 });
    }
    if (result.length === 0 && fs.existsSync(HEDGE_STATE_PATH)) fs.unlinkSync(HEDGE_STATE_PATH);
    return result;
  } catch (err) {
    console.error(`[HEDGE] Failed to load hedge state: ${(err as Error).message}`);
    return [];
  }
}

// ─── Pending fill persistence ────────────────────────────────────────────────

export function loadPendingFills(): PendingFill[] {
  try {
    if (!fs.existsSync(PENDING_FILLS_PATH)) return [];
    return JSON.parse(fs.readFileSync(PENDING_FILLS_PATH, "utf8"));
  } catch { return []; }
}

export function savePendingFills(fills: PendingFill[]): void {
  atomicWriteFileSync(PENDING_FILLS_PATH, JSON.stringify(fills, null, 2));
}

export function addPendingFill(fill: PendingFill): void {
  const fills = loadPendingFills();
  fills.push(fill);
  savePendingFills(fills);
}

export function completePendingFill(id: string): void {
  const fills = loadPendingFills();
  const f = fills.find(x => x.id === id);
  if (f) {
    f.completed = true;
    savePendingFills(fills);
  }
}

export function getIncompletePendingFills(): PendingFill[] {
  return loadPendingFills().filter(f => !f.completed);
}

// ─── Arb trade persistence (with in-memory cache) ────────────────────────────

export function loadArbTrades(): ArbTradeRecord[] {
  const now = Date.now();
  if (_arbTradesCache && now - _arbTradesCacheTs < ARB_CACHE_TTL) {
    return [..._arbTradesCache]; // shallow copy — callers may mutate (push/splice)
  }
  try {
    if (!fs.existsSync(ARB_LOG_PATH)) { _arbTradesCache = []; _arbTradesCacheTs = now; return []; }
    const trades: ArbTradeRecord[] = JSON.parse(fs.readFileSync(ARB_LOG_PATH, "utf8"));
    _arbTradesCache = trades;
    _arbTradesCacheTs = now;
    return trades;
  } catch { _arbTradesCache = []; _arbTradesCacheTs = now; return []; }
}

export function saveArbTrades(trades: ArbTradeRecord[]): void {
  atomicWriteFileSync(ARB_LOG_PATH, JSON.stringify(trades, null, 2));
  // Invalidate cache on write so next read picks up fresh data
  _arbTradesCache = trades;
  _arbTradesCacheTs = Date.now();
}

export function logArbTrade(record: ArbTradeRecord): void {
  if (DRY_RUN) return; // Don't persist simulated trades to dashboard
  const trades = loadArbTrades();
  trades.push(record);
  saveArbTrades(trades);
  console.log(`[P&L] Logged arb: ${record.match} dir=${record.dir} status=${record.status} cost=$${record.totalCost.toFixed(2)}`);
  // Auto-complete pending fill — this trade is now safely persisted
  if (_activePendingFillId) {
    completePendingFill(_activePendingFillId);
    console.log(`[PENDING] Completed pending fill ${_activePendingFillId}`);
    setActivePendingFillId(null);
  }
  // Push updated trades to central dashboard (fire-and-forget)
  pushTradeData(trades, loadMetrics()).catch(() => {});
}

export function resolveArbTrade(kalTicker: string, updates: Partial<ArbTradeRecord>, tradeId?: string): void {
  if (DRY_RUN) return;
  const trades = loadArbTrades();
  let idx = -1;
  if (tradeId) {
    idx = trades.findIndex(t => t.id === tradeId);
  }
  if (idx === -1) {
    for (let i = trades.length - 1; i >= 0; i--) {
      if (trades[i].kalTicker === kalTicker && trades[i].status === "hedging") { idx = i; break; }
    }
  }
  if (idx === -1) return;
  Object.assign(trades[idx], updates);
  saveArbTrades(trades);
  const rpnl = updates.realizedPnl != null ? ` P&L=$${updates.realizedPnl.toFixed(2)}` : "";
  console.log(`[P&L] Resolved: ${trades[idx].match} method=${updates.resolutionMethod}${rpnl}`);
}

// ─── Execution metrics persistence ───────────────────────────────────────────

export function loadMetrics(): ExecMetric[] {
  try { if (!fs.existsSync(METRICS_PATH)) return []; return JSON.parse(fs.readFileSync(METRICS_PATH, "utf8")); } catch { return []; }
}

export function appendMetric(m: ExecMetric): void {
  const metrics = loadMetrics();
  metrics.push(m);
  if (metrics.length > 500) metrics.splice(0, metrics.length - 500);
  atomicWriteFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2));
}

// ─── Depth opportunity persistence ───────────────────────────────────────────

export function loadDepthOpportunities(): DepthOpportunity[] {
  try { if (!fs.existsSync(DEPTH_OPP_PATH)) return []; return JSON.parse(fs.readFileSync(DEPTH_OPP_PATH, "utf8")); } catch { return []; }
}

export function appendDepthOpportunity(opp: DepthOpportunity): void {
  const all = loadDepthOpportunities();
  all.push(opp);
  if (all.length > DEPTH_OPP_MAX) all.splice(0, all.length - DEPTH_OPP_MAX);
  atomicWriteFileSync(DEPTH_OPP_PATH, JSON.stringify(all, null, 2));
}

// ─── Full depth sweep (no qty limit) ─────────────────────────────────────────

export function sweepFullProfitableDepth(
  askLevels: [number, number][],
  maxPrice: number,
  isCents: boolean
): { levels: DepthLevel[]; totalQty: number; totalCost: number; avgPrice: number } {
  // Ensure ascending sort — callers usually pass sorted arrays, but guard against mistakes
  const sorted = askLevels.length > 1 && askLevels[0][0] > askLevels[1][0]
    ? [...askLevels].sort((a, b) => a[0] - b[0])
    : askLevels;
  const levels: DepthLevel[] = [];
  let totalQty = 0, totalCost = 0;
  for (const [price, size] of sorted) {
    if (price > maxPrice) break;
    const priceDecimal = isCents ? price / 100 : price;
    levels.push({ price: priceDecimal, size });
    totalQty += size;
    totalCost += size * priceDecimal;
  }
  return { levels, totalQty, totalCost, avgPrice: totalQty > 0 ? totalCost / totalQty : 0 };
}

// ─── Book snapshot persistence ───────────────────────────────────────────────

export function loadBookSnapshots(): BookTrack[] {
  try { if (!fs.existsSync(BOOK_SNAPSHOTS_PATH)) return []; return JSON.parse(fs.readFileSync(BOOK_SNAPSHOTS_PATH, "utf8")); } catch { return []; }
}

export function saveBookTrack(track: BookTrack): void {
  const all = loadBookSnapshots();
  all.push(track);
  if (all.length > BOOK_TRACK_MAX) all.splice(0, all.length - BOOK_TRACK_MAX);
  atomicWriteFileSync(BOOK_SNAPSHOTS_PATH, JSON.stringify(all, null, 2));
}
