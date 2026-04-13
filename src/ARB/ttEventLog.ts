/**
 * ttEventLog.ts -- Append-only exchange event log with JSONL persistence,
 * monotonic sequence counter, write queue, log rotation, in-memory index,
 * and fill-detected dedup guard.
 *
 * Module-level mutable state:
 *   _seq                -- monotonic sequence counter
 *   _allEvents          -- flat array of all loaded events
 *   _tradeIndex         -- Map<tradeId, ExchangeEvent[]>
 *   _orderIndex         -- Map<orderId, ExchangeEvent[]>
 *   _fillCumMap         -- Map<orderId, number> (highest cumulativeFilled seen)
 *   _writeQueue         -- pending JSONL lines to flush
 *   _flushScheduled     -- whether a microtask flush is pending
 */

import fs from "fs";
import path from "path";
import { atomicWriteFileSync } from "./ttConfig.js";

console.log("[EVENT-LOG] Module loaded");

// --- File paths ----------------------------------------------------------------

const DATA_DIR = "data";
const EVENTS_PATH = path.join(DATA_DIR, "exchange_events.jsonl");
const SEQ_PATH = path.join(DATA_DIR, "event_seq.txt");

// --- Rotation config -----------------------------------------------------------

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB (was 5 MB — increased to avoid rotation during active sessions)
const MAX_ROTATIONS = 3;

// --- Event type definitions ----------------------------------------------------

export interface BaseEvent {
  seq: number;
  ts: string;
  tradeId: string;
  exchange: "kal" | "pm";
  orderId: string;
}

export interface OrderPlacedEvent extends BaseEvent {
  type: "order-placed";
  role: "initial" | "hedge-complete" | "hedge-exit";
  side: string;
  ticker: string;
  tokenId: string;
  requestedShares: number;
  limitPrice: number;
  orderType: string;
}

export interface FillDetectedEvent extends BaseEvent {
  type: "fill-detected";
  ticker: string;
  tokenId: string;
  side: string;
  fillShares: number;
  fillPrice: number;
  fillCost: number;
  fees: number;
  cumulativeFilled: number;
  source: "order-response" | "ws-matched" | "ws-mined" | "rest-poll" | "onchain" | "clob-trades" | "fills-reconcile";
}

export interface OrderCancelledEvent extends BaseEvent {
  type: "order-cancelled";
  ticker: string;
  filledBeforeCancel: number;
  reason: string;
}

export interface SettlementDetectedEvent extends BaseEvent {
  type: "settlement-detected";
  ticker: string;
  result: string;
  settlementValue: number;
  payout: number;
  source: "kal-ws" | "kal-api" | "pm-resolution" | "reconcile";
}

export interface PositionSnapshotEvent extends BaseEvent {
  type: "position-snapshot";
  ticker: string;
  tokenId: string;
  sharesHeld: number;
  source: "kal-api" | "pm-onchain" | "pm-clob";
}

export interface FillCorrectionEvent extends BaseEvent {
  type: "fill-correction";
  ticker: string;
  tokenId: string;
  field: string;          // which field is being corrected (e.g. "fillPrice", "fillCost", "fees")
  oldValue: number;
  newValue: number;
  reason: string;         // why the correction was made (e.g. "reconcile-api-mismatch")
}

export type ExchangeEvent =
  | OrderPlacedEvent
  | FillDetectedEvent
  | OrderCancelledEvent
  | SettlementDetectedEvent
  | PositionSnapshotEvent
  | FillCorrectionEvent;

// --- Module-level mutable state ------------------------------------------------

let _seq = 0;

const _allEvents: ExchangeEvent[] = [];
const _tradeIndex = new Map<string, ExchangeEvent[]>();
const _orderIndex = new Map<string, ExchangeEvent[]>();

/** Highest cumulativeFilled seen per orderId -- used for fill-detected dedup. */
const _fillCumMap = new Map<string, number>();

/** Pending JSONL lines waiting to be flushed to disk. */
const _writeQueue: string[] = [];

// --- Sequence counter persistence ----------------------------------------------

function loadSeq(): number {
  try {
    const raw = fs.readFileSync(SEQ_PATH, "utf8").trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function persistSeq(): void {
  atomicWriteFileSync(SEQ_PATH, String(_seq));
}

// --- In-memory index helpers ---------------------------------------------------

function indexEvent(evt: ExchangeEvent): void {
  // Trade index
  let tradeList = _tradeIndex.get(evt.tradeId);
  if (!tradeList) {
    tradeList = [];
    _tradeIndex.set(evt.tradeId, tradeList);
  }
  tradeList.push(evt);

  // Order index
  let orderList = _orderIndex.get(evt.orderId);
  if (!orderList) {
    orderList = [];
    _orderIndex.set(evt.orderId, orderList);
  }
  orderList.push(evt);

  // Fill cumulative tracker
  if (evt.type === "fill-detected") {
    const prev = _fillCumMap.get(evt.orderId) ?? 0;
    if (evt.cumulativeFilled > prev) {
      _fillCumMap.set(evt.orderId, evt.cumulativeFilled);
    }
  }
}

// --- Log rotation --------------------------------------------------------------

function rotateIfNeeded(): void {
  let size: number;
  try {
    size = fs.statSync(EVENTS_PATH).size;
  } catch {
    return; // file doesn't exist yet
  }
  if (size < MAX_FILE_BYTES) return;

  // Shift existing rotations: .3 -> delete, .2 -> .3, .1 -> .2, current -> .1
  for (let i = MAX_ROTATIONS; i >= 1; i--) {
    const src = i === 1 ? EVENTS_PATH : `${EVENTS_PATH}.${i - 1}`;
    const dst = `${EVENTS_PATH}.${i}`;
    try {
      if (i === MAX_ROTATIONS) {
        // Delete oldest if it exists
        try { fs.unlinkSync(dst); } catch { /* ok */ }
      }
      fs.renameSync(src, dst);
    } catch {
      // Source doesn't exist -- skip
    }
  }
  // After rotation, the main file has been renamed to .1, so new writes
  // will create a fresh file automatically via appendFileSync.
}

// --- Write queue (serializes concurrent appends) -------------------------------

function enqueueLine(line: string): void {
  _writeQueue.push(line);
  // Flush synchronously — reliability over batching.
  // The event log is append-only and writes are small (1 JSON line).
  flushQueue();
}

function flushQueue(): void {
  if (_writeQueue.length === 0) return;

  try {
    // Check rotation before writing
    rotateIfNeeded();

    // Ensure data dir exists
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

    // Batch all pending lines into a single write
    const batch = _writeQueue.splice(0, _writeQueue.length).join("\n") + "\n";
    fs.appendFileSync(EVENTS_PATH, batch, "utf8");

    // Persist the sequence counter after successful write
    persistSeq();
  } catch (err) {
    console.error(`[EVENT-LOG] Flush failed: ${(err as Error).message} (${_writeQueue.length} events lost)`);
    _writeQueue.length = 0; // clear to prevent infinite retry
  }
}

// --- Public API ----------------------------------------------------------------

/**
 * Load existing events from the JSONL file on disk into memory.
 * Reads rotated files (.1, .2, .3) first, then the main file, so events
 * are loaded in chronological order. This ensures trades that span a
 * rotation boundary still have all their events available.
 * Call this once at startup before any other event log operations.
 */
export function loadEventsFromDisk(): void {
  console.log("[EVENT-LOG] loadEventsFromDisk() called");
  // Reset state
  _allEvents.length = 0;
  _tradeIndex.clear();
  _orderIndex.clear();
  _fillCumMap.clear();

  // Load sequence counter
  _seq = loadSeq();

  let maxSeq = _seq;
  let totalLoaded = 0;

  // Build list of files to read: rotated files (oldest first), then main file
  const files: string[] = [];
  for (let i = MAX_ROTATIONS; i >= 1; i--) {
    const rotated = `${EVENTS_PATH}.${i}`;
    if (fs.existsSync(rotated)) files.push(rotated);
  }
  if (fs.existsSync(EVENTS_PATH)) files.push(EVENTS_PATH);

  for (const filePath of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed) as ExchangeEvent;
        _allEvents.push(evt);
        indexEvent(evt);
        if (evt.seq > maxSeq) maxSeq = evt.seq;
        totalLoaded++;
      } catch {
        // Corrupted line -- skip but don't crash
      }
    }
  }

  if (files.length > 1) {
    console.log(`[EVENT-LOG] Loaded ${totalLoaded} events from ${files.length} files (including ${files.length - 1} rotated)`);
  }

  // Ensure seq is at least as high as any event loaded from disk
  if (maxSeq > _seq) {
    _seq = maxSeq;
    persistSeq();
  }
}

/**
 * Append an exchange event. Assigns seq and ts automatically.
 * For fill-detected events, skips if cumulativeFilled for the same orderId
 * hasn't increased (dedup guard).
 */
export function appendEvent(event: Omit<ExchangeEvent, "seq" | "ts">): void {
  console.log("[EVENT-LOG] appendEvent:", event.type, event.tradeId);
  try {
    // Dedup guard for fill-detected events
    if (event.type === "fill-detected") {
      const fillEvt = event as Omit<FillDetectedEvent, "seq" | "ts">;
      const prev = _fillCumMap.get(fillEvt.orderId) ?? 0;
      if (fillEvt.cumulativeFilled <= prev) {
        return; // no new fill -- skip
      }
    }

    // Assign monotonic seq and timestamp
    _seq++;
    const fullEvent = {
      ...event,
      seq: _seq,
      ts: new Date().toISOString(),
    } as ExchangeEvent;

    // Update in-memory structures
    _allEvents.push(fullEvent);
    indexEvent(fullEvent);

    // Enqueue for disk write
    enqueueLine(JSON.stringify(fullEvent));
  } catch (err) {
    console.error(`[EVENT-LOG] Failed to append event: ${(err as Error).message}`, event.type, event.tradeId);
  }
}

/**
 * Returns all events for a given tradeId.
 */
export function getTradeEvents(tradeId: string): ExchangeEvent[] {
  return _tradeIndex.get(tradeId) ?? [];
}

/**
 * Returns all events for a given orderId.
 */
export function getOrderEvents(orderId: string): ExchangeEvent[] {
  return _orderIndex.get(orderId) ?? [];
}

/**
 * Returns all events loaded in memory.
 */
export function getAllEvents(): ExchangeEvent[] {
  return _allEvents;
}

/**
 * Returns the highest cumulativeFilled seen for a given orderId.
 * Used externally for dedup decisions before calling appendEvent.
 */
export function getLastFillCumulative(orderId: string): number {
  return _fillCumMap.get(orderId) ?? 0;
}

// --- Phase 3: Compute trade record from events --------------------------------

/**
 * Computed trade snapshot derived purely from exchange events.
 * Fields mirror ArbTradeRecord where applicable, but only include
 * what events can prove — no projectedEdge, match name, etc.
 */
export interface ComputedTradeRecord {
  tradeId: string;
  firstEventTs: string;
  lastEventTs: string;
  eventCount: number;

  // Kalshi leg
  kalTicker: string;
  kalShares: number;           // total filled shares on KAL (initial + hedge)
  kalInitialShares: number;    // shares from initial role orders
  kalHedgeShares: number;      // shares from hedge role orders
  kalInitialCost: number;      // cost of initial leg fills
  kalHedgeCost: number;        // cost of hedge leg fills
  kalTotalCost: number;        // initial + hedge
  kalFees: number;
  kalAvgFillPrice: number;     // weighted avg across all fills

  // PM leg
  pmTokenId: string;
  pmShares: number;
  pmInitialShares: number;
  pmHedgeShares: number;
  pmInitialCost: number;
  pmHedgeCost: number;
  pmTotalCost: number;
  pmFees: number;
  pmAvgFillPrice: number;

  // Combined
  totalCost: number;           // kalTotalCost + pmTotalCost (incl fees)
  totalFees: number;

  // Settlement (if detected)
  settled: boolean;
  settlementResult?: string;
  settlementPayout?: number;
  computedPnl?: number;        // settlementPayout - totalCost (only if settled)

  // Corrections applied
  corrections: Array<{ field: string; oldValue: number; newValue: number; reason: string }>;
}

/**
 * Reconstruct a trade's financial state purely from its exchange events.
 * Returns null if no events exist for the tradeId.
 */
export function computeTradeFromEvents(tradeId: string): ComputedTradeRecord | null {
  const events = getTradeEvents(tradeId);
  if (events.length === 0) return null;

  const result: ComputedTradeRecord = {
    tradeId,
    firstEventTs: events[0].ts,
    lastEventTs: events[events.length - 1].ts,
    eventCount: events.length,
    kalTicker: "", kalShares: 0, kalInitialShares: 0, kalHedgeShares: 0,
    kalInitialCost: 0, kalHedgeCost: 0, kalTotalCost: 0, kalFees: 0, kalAvgFillPrice: 0,
    pmTokenId: "", pmShares: 0, pmInitialShares: 0, pmHedgeShares: 0,
    pmInitialCost: 0, pmHedgeCost: 0, pmTotalCost: 0, pmFees: 0, pmAvgFillPrice: 0,
    totalCost: 0, totalFees: 0,
    settled: false, corrections: [],
  };

  // Track per-order role (initial vs hedge) from order-placed events
  const orderRoles = new Map<string, "initial" | "hedge-complete" | "hedge-exit">();

  // Pass 1: collect order roles
  for (const evt of events) {
    if (evt.type === "order-placed") {
      orderRoles.set(evt.orderId, evt.role);
      if (evt.exchange === "kal" && !result.kalTicker) result.kalTicker = evt.ticker;
      if (evt.exchange === "pm" && !result.pmTokenId) result.pmTokenId = evt.tokenId;
    }
  }

  // Track cumulative fills per orderId to compute deltas (avoid double-counting)
  const orderCumFilled = new Map<string, number>();

  // Pass 2: accumulate fills, settlements, corrections
  for (const evt of events) {
    if (evt.type === "fill-detected") {
      // Compute delta: only count the NEW shares from this event
      const prevCum = orderCumFilled.get(evt.orderId) ?? 0;
      if (evt.cumulativeFilled <= prevCum) continue; // duplicate, skip
      const deltaShares = evt.cumulativeFilled - prevCum;
      orderCumFilled.set(evt.orderId, evt.cumulativeFilled);

      // Use event's fillCost if available, otherwise estimate from price
      const deltaCost = evt.fillCost > 0 ? evt.fillCost : deltaShares * evt.fillPrice;

      const role = orderRoles.get(evt.orderId) ?? "initial";
      const isHedge = role === "hedge-complete" || role === "hedge-exit";

      if (evt.exchange === "kal") {
        if (!result.kalTicker) result.kalTicker = evt.ticker;
        result.kalShares += deltaShares;
        result.kalFees += evt.fees;
        if (isHedge) {
          result.kalHedgeShares += deltaShares;
          result.kalHedgeCost += deltaCost + evt.fees;
        } else {
          result.kalInitialShares += deltaShares;
          result.kalInitialCost += deltaCost + evt.fees;
        }
      } else {
        if (!result.pmTokenId) result.pmTokenId = evt.tokenId;
        result.pmShares += deltaShares;
        result.pmFees += evt.fees;
        if (isHedge) {
          result.pmHedgeShares += deltaShares;
          result.pmHedgeCost += deltaCost + evt.fees;
        } else {
          result.pmInitialShares += deltaShares;
          result.pmInitialCost += deltaCost + evt.fees;
        }
      }
    } else if (evt.type === "settlement-detected") {
      result.settled = true;
      result.settlementResult = evt.result;
      result.settlementPayout = evt.payout;
    } else if (evt.type === "fill-correction") {
      result.corrections.push({
        field: evt.field, oldValue: evt.oldValue,
        newValue: evt.newValue, reason: evt.reason,
      });
      // Apply correction: adjust costs if fillCost or fillPrice was corrected
      // Corrections are applied as deltas (newValue - oldValue) to the affected exchange
      if (evt.field === "fillCost") {
        const delta = evt.newValue - evt.oldValue;
        if (evt.exchange === "kal") result.kalInitialCost += delta;
        else result.pmInitialCost += delta;
      }
    }
  }

  // Compute totals
  result.kalTotalCost = result.kalInitialCost + result.kalHedgeCost;
  result.pmTotalCost = result.pmInitialCost + result.pmHedgeCost;
  result.totalCost = result.kalTotalCost + result.pmTotalCost;
  result.totalFees = result.kalFees + result.pmFees;

  // Weighted average fill prices
  if (result.kalShares > 0) {
    result.kalAvgFillPrice = Math.round(((result.kalTotalCost - result.kalFees) / result.kalShares) * 100) / 100;
  }
  if (result.pmShares > 0) {
    result.pmAvgFillPrice = Math.round(((result.pmTotalCost - result.pmFees) / result.pmShares) * 100) / 100;
  }

  // P&L if settled
  if (result.settled && result.settlementPayout != null) {
    result.computedPnl = Math.round((result.settlementPayout - result.totalCost) * 100) / 100;
  }

  return result;
}

/**
 * Returns all unique tradeIds that have events in the log.
 */
export function getAllTradeIds(): string[] {
  return Array.from(_tradeIndex.keys());
}

// --- Phase 2: Shadow comparison ------------------------------------------------

export interface ShadowDiscrepancy {
  tradeId: string;
  match: string;
  field: string;
  jsonValue: number;
  eventValue: number;
  diff: number;
  severity: "info" | "warning" | "error";
}

/**
 * Compare arb_trades.json records against event-computed records.
 * Only compares resolved trades (both systems have settled).
 * Returns discrepancies found.
 */
export function shadowCompare(
  jsonTrades: Array<{
    id: string; match: string; status: string;
    kalCost: number; pmCost: number; totalCost: number;
    kalFees?: number; hedgeCost?: number; realizedPnl?: number;
    shares: number; kalFillPrice: number; pmFillPrice: number;
  }>,
  /** Only compare trades on or after this ISO date (skip historical). */
  cutoverDate?: string,
): ShadowDiscrepancy[] {
  const discrepancies: ShadowDiscrepancy[] = [];

  for (const jt of jsonTrades) {
    // Only compare resolved trades — in-flight trades will naturally diverge
    if (jt.status !== "resolved") continue;
    // Skip trades before cutover (no events for them)
    if (cutoverDate && jt.id < cutoverDate) continue;

    const computed = computeTradeFromEvents(jt.id);
    if (!computed || computed.eventCount === 0) continue; // no events for this trade

    const match = jt.match;
    const tolerance = 0.02; // $0.02 tolerance for rounding

    // Compare KAL initial cost (JSON kalCost vs event kalInitialCost)
    const kalCostDiff = Math.abs(jt.kalCost - computed.kalInitialCost);
    if (kalCostDiff > tolerance) {
      discrepancies.push({
        tradeId: jt.id, match, field: "kalCost",
        jsonValue: jt.kalCost, eventValue: computed.kalInitialCost,
        diff: kalCostDiff,
        severity: kalCostDiff > 0.50 ? "error" : "warning",
      });
    }

    // Compare PM cost
    const pmCostDiff = Math.abs(jt.pmCost - computed.pmInitialCost);
    if (pmCostDiff > tolerance) {
      discrepancies.push({
        tradeId: jt.id, match, field: "pmCost",
        jsonValue: jt.pmCost, eventValue: computed.pmInitialCost,
        diff: pmCostDiff,
        severity: pmCostDiff > 0.50 ? "error" : "warning",
      });
    }

    // Compare hedge cost (JSON hedgeCost vs event kal+pm hedge costs)
    const jsonHedge = jt.hedgeCost ?? 0;
    const eventHedge = computed.kalHedgeCost + computed.pmHedgeCost;
    const hedgeDiff = Math.abs(jsonHedge - eventHedge);
    if (hedgeDiff > tolerance) {
      discrepancies.push({
        tradeId: jt.id, match, field: "hedgeCost",
        jsonValue: jsonHedge, eventValue: eventHedge,
        diff: hedgeDiff,
        severity: hedgeDiff > 1.0 ? "error" : "warning",
      });
    }

    // Compare KAL fees
    const jsonFees = jt.kalFees ?? 0;
    if (Math.abs(jsonFees - computed.kalFees) > tolerance) {
      discrepancies.push({
        tradeId: jt.id, match, field: "kalFees",
        jsonValue: jsonFees, eventValue: computed.kalFees,
        diff: Math.abs(jsonFees - computed.kalFees),
        severity: "info",
      });
    }

    // Compare total cost
    const jsonTotal = jt.totalCost;
    const eventTotal = computed.totalCost;
    const totalDiff = Math.abs(jsonTotal - eventTotal);
    if (totalDiff > tolerance) {
      discrepancies.push({
        tradeId: jt.id, match, field: "totalCost",
        jsonValue: jsonTotal, eventValue: eventTotal,
        diff: totalDiff,
        severity: totalDiff > 1.0 ? "error" : "warning",
      });
    }
  }

  return discrepancies;
}

// --- Shadow comparison background runner ---------------------------------------

let _lastShadowTs = 0;
const SHADOW_INTERVAL_MS = 60_000; // run every 60s

/**
 * Called from the main loop. Runs shadow comparison if enough time has elapsed.
 * Logs discrepancies to console. Returns discrepancy count (0 = clean).
 */
export function maybeShadowCompare(
  jsonTrades: Array<{
    id: string; match: string; status: string;
    kalCost: number; pmCost: number; totalCost: number;
    kalFees?: number; hedgeCost?: number; realizedPnl?: number;
    shares: number; kalFillPrice: number; pmFillPrice: number;
  }>,
  cutoverDate?: string,
): number {
  const now = Date.now();
  if (now - _lastShadowTs < SHADOW_INTERVAL_MS) return 0;
  _lastShadowTs = now;

  const discs = shadowCompare(jsonTrades, cutoverDate);
  if (discs.length > 0) {
    const errors = discs.filter(d => d.severity === "error").length;
    const warnings = discs.filter(d => d.severity === "warning").length;
    console.log(`[SHADOW] ${discs.length} discrepancies (${errors} errors, ${warnings} warnings):`);
    for (const d of discs.slice(0, 10)) {
      console.log(`  [SHADOW] ${d.tradeId.slice(0, 20)} ${d.match}: ${d.field} json=${d.jsonValue.toFixed(2)} events=${d.eventValue.toFixed(2)} diff=$${d.diff.toFixed(2)} [${d.severity}]`);
    }
    if (discs.length > 10) console.log(`  [SHADOW] ...and ${discs.length - 10} more`);
  }
  return discs.length;
}
