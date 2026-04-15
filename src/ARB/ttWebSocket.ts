/**
 * ttWebSocket.ts -- Live WebSocket orderbook feeds for Kalshi and Polymarket.
 * Maintains real-time orderbook state in Maps, read synchronously by scan/exec.
 *
 * Module-level mutable state:
 *   wsKalBooks / wsPmBooks       -- live orderbook Maps
 *   _kalWs / _pmWs               -- WebSocket instances
 *   _priceHistory / _lastSampleTs -- momentum tracking buffers
 *   pmServiceDown*                -- PM 425 backoff state
 */

import crypto from "crypto";
import fs from "fs";
import WebSocket from "ws";
import { KAL_WS_STALE_MS, PM_WS_STALE_MS } from "./ttConfig.js";
import type { WsBookSide, WsLiveBook, WsPmBook } from "./ttTypes.js";
import { audit } from "./ttAuditLog.js";
import { readPolyApiCredsFromEnv } from "../polyAuth.js";

// --- Kalshi WS auth ----------------------------------------------------------

function _loadKalshiPK(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return "";
}
const _kalshiPK = _loadKalshiPK();

function _kalshiWsSign(ts: string): string {
  if (!_kalshiPK) return "";
  const data = `${ts}GET/trade-api/ws/v2`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer.sign({ key: _kalshiPK, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

// --- Raw WS event logger ------------------------------------------------------
// Appends every Kalshi fill, Kalshi order update, and PM trade event verbatim to
// data/raw_ws_events.jsonl. Purpose: when a trade record's price disagrees with
// post-hoc /portfolio/fills data (e.g. bot recorded 0.22 but exchange shows 0.74),
// we need the actual WS payload we consumed at the time. Without this log we're
// guessing about what Kalshi/PM sent. Rotates at 20MB, keeps 2 rotated files.
const RAW_WS_LOG_PATH = "data/raw_ws_events.jsonl";
const RAW_WS_LOG_MAX_BYTES = 20 * 1024 * 1024;
let _rawWsLogSize = -1; // -1 = unchecked; 0+ = cached byte count
function logRawWsEvent(source: "kal-fill" | "kal-order" | "kal-lifecycle" | "pm-trade", payload: unknown): void {
  try {
    if (_rawWsLogSize < 0) {
      try { _rawWsLogSize = fs.existsSync(RAW_WS_LOG_PATH) ? fs.statSync(RAW_WS_LOG_PATH).size : 0; }
      catch { _rawWsLogSize = 0; }
    }
    if (_rawWsLogSize > RAW_WS_LOG_MAX_BYTES) {
      try {
        if (fs.existsSync(RAW_WS_LOG_PATH + ".1")) fs.renameSync(RAW_WS_LOG_PATH + ".1", RAW_WS_LOG_PATH + ".2");
        fs.renameSync(RAW_WS_LOG_PATH, RAW_WS_LOG_PATH + ".1");
      } catch { /* best-effort */ }
      _rawWsLogSize = 0;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), source, payload }) + "\n";
    fs.appendFileSync(RAW_WS_LOG_PATH, line);
    _rawWsLogSize += line.length;
  } catch { /* never let logging break the WS handler */ }
}

// --- In-memory live orderbook state ------------------------------------------

export const wsKalBooks = new Map<string, WsLiveBook>();
export const wsPmBooks = new Map<string, WsPmBook>();

let _kalWs: WebSocket | null = null;
let _kalWsReady = false;
let _kalWsSubId = 0;
const _kalWsSubs = new Set<string>();
let _kalWsPingIv: ReturnType<typeof setInterval> | null = null;

// --- Kalshi fill, order, and market lifecycle channels -----------------------

export type KalFillEvent = {
  trade_id: string;
  order_id: string;
  market_ticker: string;
  is_taker: boolean;
  side: "yes" | "no";
  yes_price_dollars: string;
  count_fp: string;
  fee_cost: string;
  action: string;
  ts: number;
  purchased_side: string;
};

export type KalOrderEvent = {
  order_id: string;
  ticker: string;
  status: "resting" | "executed" | "canceled";
  side: string;
  is_yes: boolean;
  yes_price_dollars: string;
  fill_count_fp: string;
  remaining_count_fp: string;
  initial_count_fp: string;
  taker_fill_cost_dollars: string;
  maker_fill_cost_dollars: string;
  taker_fees_dollars: string;
  maker_fees_dollars: string;
  created_time: string;
  last_update_time: string;
};

export type KalMarketLifecycleEvent = {
  event_type: "created" | "activated" | "deactivated" | "determined" | "settled" | "close_date_updated";
  market_ticker: string;
  result?: string;           // "YES" or "NO" on determined
  settlement_value?: string; // "1.0000" or "0.0000" on determined
  determination_ts?: number;
  settled_ts?: number;
};

// Kalshi fill waiters: orderId -> resolve callback
const _kalFillWaiters = new Map<string, (evt: KalFillEvent) => void>();

// Recent fill buffer: stores last 30s of fills so execution can check after HTTP response.
// The WS fill often arrives BEFORE the HTTP response, so the fill is already buffered
// by the time we get the orderId from HTTP.
const _recentKalFills = new Map<string, KalFillEvent>();
const RECENT_FILL_TTL = 30_000; // 30s buffer

/** Get a recent KAL fill by orderId (from WS buffer). Returns null if not found. */
export function getRecentKalFill(orderId: string): KalFillEvent | null {
  const fill = _recentKalFills.get(orderId);
  if (!fill) return null;
  if (Date.now() - fill.ts * 1000 > RECENT_FILL_TTL) {
    _recentKalFills.delete(orderId);
    return null;
  }
  return fill;
}

/** Wait for a KAL fill to appear in the buffer (or arrive via WS). */
export async function waitForKalFillData(orderId: string, timeoutMs = 500): Promise<KalFillEvent | null> {
  // Check buffer first (WS likely already arrived before HTTP response)
  const buffered = getRecentKalFill(orderId);
  if (buffered) return buffered;
  // Not in buffer yet — wait briefly for WS to deliver it
  return waitForKalFillWs(orderId, timeoutMs);
}

// Kalshi order status waiters: orderId -> resolve callback
const _kalOrderWaiters = new Map<string, (evt: KalOrderEvent) => void>();

// Market settlement cache: ticker -> { result, settlementValue }
const _kalSettledMarkets = new Map<string, { result: string; settlementValue: number; ts: number }>();

// --- Persistent KAL fill listeners (for hedge GTC orders) ---
// Unlike one-shot waiters, these stay registered until explicitly removed.
// Multiple fills on the same order trigger the callback each time.
const _kalPersistentFillListeners = new Map<string, (evt: KalFillEvent) => void>();
const _kalPersistentOrderListeners = new Map<string, (evt: KalOrderEvent) => void>();

/** Register a persistent listener for fills on a Kalshi order. Stays active until unregistered. */
export function registerKalFillListener(orderId: string, callback: (evt: KalFillEvent) => void): void {
  _kalPersistentFillListeners.set(orderId, callback);
}

/** Register a persistent listener for order status changes. */
export function registerKalOrderListener(orderId: string, callback: (evt: KalOrderEvent) => void): void {
  _kalPersistentOrderListeners.set(orderId, callback);
}

/** Unregister persistent listeners for an order. */
export function unregisterKalListeners(orderId: string): void {
  _kalPersistentFillListeners.delete(orderId);
  _kalPersistentOrderListeners.delete(orderId);
}

/** Register a one-shot waiter for a Kalshi fill. Returns fill event or null on timeout. */
export function waitForKalFillWs(orderId: string, timeoutMs = 15_000): Promise<KalFillEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _kalFillWaiters.delete(orderId);
      resolve(null);
    }, timeoutMs);
    _kalFillWaiters.set(orderId, (evt) => {
      clearTimeout(timer);
      _kalFillWaiters.delete(orderId);
      resolve(evt);
    });
  });
}

/** Register a one-shot waiter for a Kalshi order status change. */
export function waitForKalOrderWs(orderId: string, timeoutMs = 15_000): Promise<KalOrderEvent | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _kalOrderWaiters.delete(orderId);
      resolve(null);
    }, timeoutMs);
    _kalOrderWaiters.set(orderId, (evt) => {
      clearTimeout(timer);
      _kalOrderWaiters.delete(orderId);
      resolve(evt);
    });
  });
}

/** Check if a market has settled (from WS lifecycle events). */
export function getKalSettlement(ticker: string): { result: string; settlementValue: number } | null {
  return _kalSettledMarkets.get(ticker) ?? null;
}

/** Check if a market has settled as YES or NO. */
export function isKalMarketSettled(ticker: string): boolean {
  return _kalSettledMarkets.has(ticker);
}

let _pmWs: WebSocket | null = null;
let _pmWsReady = false;
let _pmPingInterval: ReturnType<typeof setInterval> | null = null;
const _pmWsSubs = new Set<string>();

// --- Book accessor helpers ---------------------------------------------------

/** Convert WsBookSide Map -> sorted [price, size][] array. */
export function wsBookToArray(m: WsBookSide): [number, number][] {
  const arr: [number, number][] = [];
  for (const [price, size] of m) {
    if (size > 0) arr.push([price, size]);
  }
  return arr.sort((a, b) => a[0] - b[0]);
}

/** Get Kalshi orderbook from WS cache (null if stale/missing). */
export function getWsKalBook(ticker: string): { yes: [number, number][]; no: [number, number][] } | null {
  const book = wsKalBooks.get(ticker);
  if (!book || Date.now() - book.ts > KAL_WS_STALE_MS) return null;
  return { yes: wsBookToArray(book.yes), no: wsBookToArray(book.no) };
}

/** Get PM ask depth from WS cache (null if stale/missing). Cents -> decimal. */
export function getWsPmAsks(tokenId: string): [number, number][] | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  const arr: [number, number][] = [];
  for (const [price, size] of book.asks) {
    if (size > 0) arr.push([price / 100, size]);
  }
  return arr.sort((a, b) => a[0] - b[0]);
}

/** Get Kalshi best YES or NO ask from WS cache. */
export function getWsKalBestAsk(ticker: string, side: "yes" | "no"): number | null {
  const book = wsKalBooks.get(ticker);
  if (!book || Date.now() - book.ts > KAL_WS_STALE_MS) return null;
  const oppSide = side === "yes" ? book.no : book.yes;
  let bestBidCents = 0;
  for (const [price, size] of oppSide) {
    if (size > 0 && price > bestBidCents) bestBidCents = price;
  }
  if (bestBidCents === 0) return null;
  return (100 - bestBidCents) / 100;
}

/** Get PM best ask price from WS cache. */
export function getWsPmBestAsk(tokenId: string): number | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  let best = Infinity;
  for (const [price, size] of book.asks) {
    if (size > 0 && price < best) best = price;
  }
  return best === Infinity ? null : best / 100;
}

export function getWsPmBestBid(tokenId: string): number | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  let best = 0;
  for (const [price, size] of book.bids) {
    if (size > 0 && price > best) best = price;
  }
  return best === 0 ? null : best / 100;
}

/** Get PM bids from WS cache (mirrors getWsPmAsks). Highest bid first. */
export function getWsPmBids(tokenId: string): [number, number][] | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  const arr: [number, number][] = [];
  for (const [price, size] of book.bids) {
    if (size > 0) arr.push([price / 100, size]);
  }
  return arr.sort((a, b) => b[0] - a[0]);
}

// --- Rolling Price Buffer (momentum detection) ------------------------------

const MOMENTUM_WINDOW_MS = 60_000;
const MOMENTUM_SAMPLE_INTERVAL_MS = 500;
interface PriceSample { ts: number; ask: number }
const _priceHistory = new Map<string, PriceSample[]>();
const _lastSampleTs = new Map<string, number>();

let _lastPrunedTs = 0;
const PRUNE_INTERVAL_MS = 300_000; // prune stale keys every 5min

export function recordPrice(key: string, ask: number): void {
  const now = Date.now();
  const lastTs = _lastSampleTs.get(key) ?? 0;
  if (now - lastTs < MOMENTUM_SAMPLE_INTERVAL_MS) return;
  _lastSampleTs.set(key, now);
  let buf = _priceHistory.get(key);
  if (!buf) { buf = []; _priceHistory.set(key, buf); }
  buf.push({ ts: now, ask });
  while (buf.length > 0 && buf[0].ts < now - MOMENTUM_WINDOW_MS) buf.shift();
  // Periodic prune: remove keys with no samples in the last MOMENTUM_WINDOW_MS
  if (now - _lastPrunedTs > PRUNE_INTERVAL_MS) {
    _lastPrunedTs = now;
    for (const [k, samples] of _priceHistory) {
      if (samples.length === 0 || samples[samples.length - 1].ts < now - MOMENTUM_WINDOW_MS) {
        _priceHistory.delete(k);
        _lastSampleTs.delete(k);
      }
    }
  }
}

/** Price change over windowMs. Positive = rising (more expensive). */
export function getMomentum(key: string, windowMs: number = 10_000): number {
  const buf = _priceHistory.get(key);
  if (!buf || buf.length < 2) return 0;
  const cutoff = Date.now() - windowMs;
  let oldest: PriceSample | null = null;
  for (const s of buf) {
    if (s.ts >= cutoff) { oldest = s; break; }
  }
  if (!oldest) oldest = buf[buf.length - 2];
  const latest = buf[buf.length - 1];
  if (oldest.ts === latest.ts) return 0;
  return latest.ask - oldest.ask;
}

// --- Kalshi WebSocket --------------------------------------------------------

export function connectKalshiWs(): void {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId || !_kalshiPK) {
    console.log("[WS] Kalshi keys not configured, WS disabled");
    return;
  }

  const wsUrl = "wss://api.elections.kalshi.com/trade-api/ws/v2";
  const ts = Date.now().toString();
  const sig = _kalshiWsSign(ts);

  _kalWs = new WebSocket(wsUrl, {
    headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts },
  });

  _kalWs.on("open", () => {
    console.log("[WS] Kalshi connected");
    _kalWsReady = true;

    // Subscribe to user-level channels (no ticker needed — receives ALL fills/orders)
    _kalWsSubId++;
    _kalWs!.send(JSON.stringify({ id: _kalWsSubId, cmd: "subscribe", params: { channels: ["fill", "user_orders"] } }));

    // Subscribe to per-ticker channels
    for (const ticker of _kalWsSubs) _kalWsSubscribe(ticker);
    if (_kalWsPingIv) clearInterval(_kalWsPingIv);
    _kalWsPingIv = setInterval(() => { _kalWs?.ping(); }, 30000);
  });

  _kalWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "orderbook_snapshot") {
        const ticker = msg.msg?.market_ticker;
        if (!ticker) return;
        const book: WsLiveBook = { yes: new Map(), no: new Map(), ts: Date.now() };
        for (const [p, s] of (msg.msg.yes_dollars_fp || msg.msg.yes || [])) {
          const pc = Math.round(Number(p) * 100), sz = Number(s);
          if (Number.isFinite(pc) && pc > 0 && pc < 100 && Number.isFinite(sz) && sz > 0) book.yes.set(pc, sz);
        }
        for (const [p, s] of (msg.msg.no_dollars_fp || msg.msg.no || [])) {
          const pc = Math.round(Number(p) * 100), sz = Number(s);
          if (Number.isFinite(pc) && pc > 0 && pc < 100 && Number.isFinite(sz) && sz > 0) book.no.set(pc, sz);
        }
        wsKalBooks.set(ticker, book);
        { const ya = getWsKalBestAsk(ticker, "yes"); if (ya !== null) recordPrice(`kal:${ticker}:yes`, ya); }
        { const na = getWsKalBestAsk(ticker, "no"); if (na !== null) recordPrice(`kal:${ticker}:no`, na); }
      } else if (msg.type === "orderbook_delta") {
        const ticker = msg.msg?.market_ticker;
        if (!ticker) return;
        let book = wsKalBooks.get(ticker);
        if (!book) { book = { yes: new Map(), no: new Map(), ts: Date.now() }; wsKalBooks.set(ticker, book); }
        const side = msg.msg.side === "no" ? book.no : book.yes;
        const cents = Math.round(Number(msg.msg.price_dollars || msg.msg.price || 0) * 100);
        const delta = Number(msg.msg.delta_fp || msg.msg.delta || 0);
        if (!Number.isFinite(cents) || cents <= 0 || cents >= 100 || !Number.isFinite(delta)) { book.ts = Date.now(); return; }
        const cur = side.get(cents) || 0;
        const newSize = cur + delta;
        if (newSize <= 0) side.delete(cents); else side.set(cents, newSize);
        book.ts = Date.now();
        { const ya = getWsKalBestAsk(ticker, "yes"); if (ya !== null) recordPrice(`kal:${ticker}:yes`, ya); }
        { const na = getWsKalBestAsk(ticker, "no"); if (na !== null) recordPrice(`kal:${ticker}:no`, na); }

      // --- Kalshi fill channel ---
      } else if (msg.type === "fill") {
        const fill = msg.msg as KalFillEvent;
        logRawWsEvent("kal-fill", fill);
        const oid = fill?.order_id;
        if (oid) {
          // Buffer recent fills so execution can check after HTTP response
          _recentKalFills.set(oid, fill);
          // Prune old entries periodically
          if (_recentKalFills.size > 100) {
            const cutoff = Date.now() - RECENT_FILL_TTL;
            for (const [k, v] of _recentKalFills) { if (v.ts * 1000 < cutoff) _recentKalFills.delete(k); }
          }
          // One-shot waiter
          if (_kalFillWaiters.has(oid)) _kalFillWaiters.get(oid)!(fill);
          // Persistent listener (hedge GTC tracking)
          if (_kalPersistentFillListeners.has(oid)) _kalPersistentFillListeners.get(oid)!(fill);
        }

      // --- Kalshi user_orders channel ---
      } else if (msg.type === "user_order") {
        const order = msg.msg as KalOrderEvent;
        logRawWsEvent("kal-order", order);
        const oid = order?.order_id;
        if (oid) {
          // One-shot waiter
          if (_kalOrderWaiters.has(oid)) _kalOrderWaiters.get(oid)!(order);
          // Persistent listener (hedge GTC tracking)
          if (_kalPersistentOrderListeners.has(oid)) _kalPersistentOrderListeners.get(oid)!(order);
        }

      // --- Kalshi market lifecycle channel ---
      } else if (msg.type === "market_lifecycle_v2") {
        const evt = msg.msg as KalMarketLifecycleEvent;
        logRawWsEvent("kal-lifecycle", evt);
        if (evt.event_type === "determined" && evt.market_ticker) {
          const result = (evt.result ?? "").toUpperCase();
          const sv = Number(evt.settlement_value ?? (result === "YES" ? 1 : 0));
          _kalSettledMarkets.set(evt.market_ticker, { result, settlementValue: sv, ts: Date.now() });
          // Only log for our watched markets — suppress crypto/forex/unrelated noise
          if (_kalWsSubs.has(evt.market_ticker)) {
            console.log(`[KAL-WS] Market determined: ${evt.market_ticker} result=${result} sv=${sv}`);
          }
        } else if (evt.event_type === "settled" && evt.market_ticker) {
          if (!_kalSettledMarkets.has(evt.market_ticker)) {
            _kalSettledMarkets.set(evt.market_ticker, { result: "unknown", settlementValue: 0, ts: Date.now() });
          }
          if (_kalWsSubs.has(evt.market_ticker)) {
            console.log(`[KAL-WS] Market settled: ${evt.market_ticker}`);
          }
        }
      }
    } catch (err) { console.error("[WS] Kalshi message parse error:", (err as Error).message); }
  });

  _kalWs.on("close", () => {
    console.log("[WS] Kalshi disconnected, reconnecting in 3s...");
    _kalWsReady = false;
    wsKalBooks.clear();
    setTimeout(connectKalshiWs, 3000);
  });
  _kalWs.on("error", (err) => { console.error("[WS] Kalshi error:", (err as Error).message); });
}

export function _kalWsSubscribe(ticker: string): void {
  _kalWsSubs.add(ticker);
  if (!_kalWsReady || !_kalWs) return;
  _kalWsSubId++;
  _kalWs.send(JSON.stringify({ id: _kalWsSubId, cmd: "subscribe", params: { channels: ["orderbook_delta", "market_lifecycle_v2"], market_ticker: ticker } }));
}

// --- Polymarket WebSocket ----------------------------------------------------

export function connectPmWs(): void {
  _pmWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

  _pmWs.on("open", () => {
    console.log("[WS] Polymarket connected");
    _pmWsReady = true;
    if (_pmWsSubs.size > 0) {
      _pmWs!.send(JSON.stringify({ assets_ids: [..._pmWsSubs], type: "market" }));
    }
    if (_pmPingInterval) clearInterval(_pmPingInterval);
    _pmPingInterval = setInterval(() => {
      if (_pmWs?.readyState === WebSocket.OPEN) _pmWs.send("PING");
    }, 10000);
  });

  _pmWs.on("message", (raw) => {
    try {
      const str = raw.toString();
      if (str === "PONG") return;
      const msgs = JSON.parse(str);
      const events = Array.isArray(msgs) ? msgs : [msgs];
      for (const evt of events) {
        if (evt.event_type === "book") {
          const tokenId = evt.asset_id;
          if (!tokenId) continue;
          let book = wsPmBooks.get(tokenId);
          if (!book) { book = { bids: new Map(), asks: new Map(), ts: Date.now() }; wsPmBooks.set(tokenId, book); }
          book.bids.clear(); book.asks.clear();
          for (const l of (evt.bids || [])) {
            const p = Math.round(Number(l.price) * 100), s = Number(l.size);
            if (p > 0 && s > 0) book.bids.set(p, s);
          }
          for (const l of (evt.asks || [])) {
            const p = Math.round(Number(l.price) * 100), s = Number(l.size);
            if (p > 0 && s > 0) book.asks.set(p, s);
          }
          book.ts = Date.now();
          { const ba = getWsPmBestAsk(tokenId); if (ba !== null) recordPrice(`pm:${tokenId}`, ba); }
        } else if (evt.event_type === "price_change") {
          for (const ch of (evt.price_changes || [])) {
            const aid = ch.asset_id || evt.asset_id;
            if (!aid) continue;
            let book = wsPmBooks.get(aid);
            if (!book) { book = { bids: new Map(), asks: new Map(), ts: Date.now() }; wsPmBooks.set(aid, book); }
            const side = ch.side === "BUY" ? book.bids : book.asks;
            const p = Math.round(Number(ch.price) * 100), s = Number(ch.size);
            if (s <= 0) side.delete(p); else side.set(p, s);
            book.ts = Date.now();
            if (ch.side !== "BUY") { const ba = getWsPmBestAsk(aid); if (ba !== null) recordPrice(`pm:${aid}`, ba); }
          }
        }
      }
    } catch (err) { console.error("[WS] Polymarket message parse error:", (err as Error).message); }
  });

  _pmWs.on("close", () => {
    console.log("[WS] Polymarket disconnected, clearing books, reconnecting in 3s...");
    _pmWsReady = false;
    wsPmBooks.clear(); // Prevent stale PM prices from being used during reconnect gap
    setTimeout(connectPmWs, 3000);
  });
  _pmWs.on("error", (err) => { console.error("[WS] Polymarket error:", (err as Error).message); });
}

export function _pmWsSubscribe(tokenId: string): void {
  const isNew = !_pmWsSubs.has(tokenId);
  _pmWsSubs.add(tokenId);
  // Send subscription message immediately if WS is connected and this is a new token.
  // Previously, tokens added after initial subscribeWatchlist() were never subscribed
  // until the next WS reconnect, causing stale/missing book data.
  if (isNew && _pmWsReady && _pmWs?.readyState === WebSocket.OPEN) {
    _pmWs.send(JSON.stringify({ assets_ids: [tokenId], type: "market" }));
  }
}

// --- Polymarket User WebSocket (fill confirmations) --------------------------

let _pmUserWs: WebSocket | null = null;
let _pmUserWsReady = false;
let _pmUserPingIv: ReturnType<typeof setInterval> | null = null;

export type PmTradeEvent = {
  asset_id: string;
  event_type: "trade";
  id: string;          // trade id
  price: string;
  size: string;
  side: string;        // "BUY" | "SELL"
  status: string;      // "MATCHED" | "MINED" | "CONFIRMED" | "RETRYING" | "FAILED"
  taker_order_id: string;
  timestamp: string;
  maker_orders?: { order_id: string; matched_amount: string; price: string }[];
};

// Pending fill waiters: orderId -> waiter state
type PmFillWaiter = {
  resolve: (evt: PmTradeEvent | null) => void;
  timer: ReturnType<typeof setTimeout>;
  matchedEvt: PmTradeEvent | null;   // stored MATCHED event (not yet on-chain)
  requireMined: boolean;              // if true, only resolve on CONFIRMED/MINED
};
const _pmFillWaiters = new Map<string, PmFillWaiter>();

// Ghost fill handler: called when a WS trade event is a verified ghost fill.
// Set by runARB.ts to route to handleGhostFill.
let _pmGhostFillHandler: ((tokenId: string, shares: number, tradeId: string) => void) | null = null;

// Ghost fill verification: checks pending fills to confirm this is a real ghost.
// Set by runARB.ts (provides access to pending fills without circular imports).
let _pmGhostVerifier: ((tokenId: string) => { isGhost: boolean; pendingFillId: string } | null) | null = null;

/** Register the ghost fill handler and verifier (called once at startup from runARB.ts). */
export function setPmGhostFillHandler(
  handler: (tokenId: string, shares: number, tradeId: string) => void,
  verifier: (tokenId: string) => { isGhost: boolean; pendingFillId: string } | null,
): void {
  _pmGhostFillHandler = handler;
  _pmGhostVerifier = verifier;
}

/** Register a one-shot waiter for a specific order fill. Returns a promise that
 *  resolves with the trade event when the order is confirmed on-chain, or null on timeout.
 *
 *  When requireMined=true (default), MATCHED events are stored but the waiter keeps
 *  waiting for CONFIRMED/MINED (on-chain proof). On timeout, resolves with the stored
 *  MATCHED event if one arrived (caller can check status to know it's unconfirmed).
 *
 *  When requireMined=false (DEFAULT), resolves immediately on MATCHED. This is
 *  fast-path: PM CLOB matches in 1-15ms vs 2-4s wait for on-chain MINED. Per
 *  the audit of 42 cycles + 11 days of bot history, MATCHED→MINED conversion
 *  is 100% (zero FAILED events ever), so MATCHED is a reliable proceed signal.
 *  Set PM_REQUIRE_MINED=true in env to force the slower on-chain wait.
 *
 *  TIMEOUT: as of 2026-04-15, there is NO time limit. We wait until Polymarket's
 *  executor either delivers the requested status or declares FAILED. The prior
 *  15-20s timeouts were the direct cause of false hedge-mode entries when the
 *  executor queue was slow but the order was still alive. A hard safety cap is
 *  kept at 30 minutes to prevent zombie waiters if the WS connection dies
 *  silently; a loud warning is logged if this fires, so it's detectable. Set
 *  PM_WAIT_MAX_MS=0 in env to disable the safety cap entirely. */
const PM_WAIT_MAX_MS_DEFAULT = Number(process.env.PM_WAIT_MAX_MS ?? 30 * 60_000);
const PM_REQUIRE_MINED_DEFAULT = process.env.PM_REQUIRE_MINED === "true";
export function waitForPmFillWs(orderId: string, timeoutMs?: number, requireMined: boolean = PM_REQUIRE_MINED_DEFAULT): Promise<PmTradeEvent | null> {
  const safetyCap = timeoutMs ?? PM_WAIT_MAX_MS_DEFAULT;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (safetyCap > 0) {
      timer = setTimeout(() => {
        const w = _pmFillWaiters.get(orderId);
        const storedEvt = w?.matchedEvt ?? null;
        _pmFillWaiters.delete(orderId);
        console.error(
          `[PM-USER-WS] SAFETY-CAP HIT for order ${orderId.slice(0, 16)}... after ${safetyCap / 60_000}min. ` +
          `WS likely disconnected without delivering MINED/FAILED. Resolving with ${storedEvt ? "stored MATCHED event" : "null"}; ` +
          `reconciliation will settle this trade.`
        );
        resolve(storedEvt);
      }, safetyCap);
    }
    _pmFillWaiters.set(orderId, { resolve, timer: timer as ReturnType<typeof setTimeout>, matchedEvt: null, requireMined });
  });
}

/** Extract actual fill cost from a PM trade event's maker_orders breakdown.
 *  Returns { totalCost, totalShares, avgPrice } or null if no breakdown available.
 *  For binary markets, CLOB may report the complementary price (maker's perspective).
 *  The caller should validate: if avgPrice > 0.50 and combined cost > $1/share, use 1 - avgPrice. */
export function extractPmFillCost(evt: PmTradeEvent): { totalCost: number; totalShares: number; avgPrice: number } | null {
  // Prefer top-level price/size — this is from the taker's perspective (our side)
  const topP = Number(evt.price), topS = Number(evt.size);
  if (topP > 0 && topS > 0) {
    return { totalCost: topP * topS, totalShares: topS, avgPrice: topP };
  }
  // Fallback to maker_orders breakdown
  if (!evt.maker_orders || evt.maker_orders.length === 0) return null;
  let totalCost = 0, totalShares = 0;
  for (const mo of evt.maker_orders) {
    const price = Number(mo.price);
    const qty = Number(mo.matched_amount);
    if (price > 0 && qty > 0) {
      totalCost += price * qty;
      totalShares += qty;
    }
  }
  if (totalShares === 0) return null;
  return { totalCost, totalShares, avgPrice: totalCost / totalShares };
}

/** Route a WS trade event to a waiter. Returns true if the waiter was resolved or matched. */
function _resolveWaiterIfReady(w: PmFillWaiter, orderId: string, evt: PmTradeEvent, isOnChain: boolean): boolean {
  if (isOnChain || !w.requireMined) {
    // CONFIRMED/MINED or waiter doesn't require on-chain → resolve immediately
    if (w.timer) clearTimeout(w.timer);
    _pmFillWaiters.delete(orderId);
    w.resolve(evt);
    return true;
  }
  // MATCHED but waiter requires on-chain confirmation → store event, keep waiting
  w.matchedEvt = evt;
  return true; // still "matched" for ghost fill suppression (we know about this order)
}

/** Check if PM User WS is connected and ready. */
export function isPmUserWsReady(): boolean { return _pmUserWsReady; }

export function connectPmUserWs(): void {
  const creds = readPolyApiCredsFromEnv();
  if (!creds) {
    console.log("[PM-USER-WS] API credentials not configured, User WS disabled");
    return;
  }

  _pmUserWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/user");

  _pmUserWs.on("open", () => {
    console.log("[PM-USER-WS] Connected, sending auth...");

    // Auth + subscribe via message body (not HTTP headers)
    _pmUserWs!.send(JSON.stringify({
      auth: {
        apiKey: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      },
      type: "user",
    }));

    // Mark ready after auth sent. The old approach (wait for first trade event)
    // caused a race: if no trades happened before the first execution,
    // isPmUserWsReady() returned false and all WS verification was skipped.
    // The WS is usable as soon as auth is sent — incoming trade events will
    // be processed regardless of _pmUserWsReady state.
    _pmUserWsReady = true;
    console.log("[PM-USER-WS] Ready (auth sent)");

    if (_pmUserPingIv) clearInterval(_pmUserPingIv);
    _pmUserPingIv = setInterval(() => {
      if (_pmUserWs?.readyState === WebSocket.OPEN) _pmUserWs.send("PING");
    }, 10_000);
  });

  _pmUserWs.on("message", (raw) => {
    try {
      const str = raw.toString();
      if (str === "PONG") return;

      // Log first trade event for confirmation (auth already marked ready on connect)
      if (!_pmUserWsReady) {
        _pmUserWsReady = true; // safety: ensure ready if somehow missed
      }

      const msgs = JSON.parse(str);
      const events: PmTradeEvent[] = Array.isArray(msgs) ? msgs : [msgs];

      for (const evt of events) {
        if (evt.event_type !== "trade") continue;
        const status = evt.status?.toUpperCase();
        if (status !== "MATCHED" && status !== "CONFIRMED" && status !== "MINED" && status !== "FAILED" && status !== "RETRYING") continue;
        logRawWsEvent("pm-trade", evt);

        // FAILED: executor gave up → transaction is dead, resolve waiter immediately
        if (status === "FAILED") {
          const takerId = evt.taker_order_id;
          if (takerId && _pmFillWaiters.has(takerId)) {
            const w = _pmFillWaiters.get(takerId)!;
            if (w.timer) clearTimeout(w.timer);
            _pmFillWaiters.delete(takerId);
            evt.status = "FAILED"; // ensure status is uppercase for caller
            w.resolve(evt);
            console.warn(`[PM-USER-WS] Order FAILED: ${takerId.slice(0, 16)}... — transaction dead, no on-chain settlement`);
          }
          continue;
        }

        // RETRYING: on-chain tx reverted, executor retrying — log and keep waiting
        if (status === "RETRYING") {
          console.warn(`[PM-USER-WS] Order RETRYING: ${evt.taker_order_id?.slice(0, 16)}... — executor retrying on-chain tx`);
          continue;
        }

        // Resolve any waiter for this taker order
        let matched = false;
        const isOnChain = status === "CONFIRMED" || status === "MINED";
        const takerId = evt.taker_order_id;
        if (takerId && _pmFillWaiters.has(takerId)) {
          matched = _resolveWaiterIfReady(_pmFillWaiters.get(takerId)!, takerId, evt, isOnChain);
        }
        // Also check maker orders (in case our order was the resting side)
        if (evt.maker_orders) {
          for (const mo of evt.maker_orders) {
            if (mo.order_id && _pmFillWaiters.has(mo.order_id)) {
              matched = _resolveWaiterIfReady(_pmFillWaiters.get(mo.order_id)!, mo.order_id, evt, isOnChain) || matched;
            }
          }
        }
        // No waiter matched — verify if this is a ghost fill
        if (!matched && _pmGhostVerifier && _pmGhostFillHandler) {
          const tokenId = evt.asset_id;
          const result = _pmGhostVerifier(tokenId);
          if (result && result.isGhost) {
            const shares = Math.round(Number(evt.size) || 0);
            if (shares > 0) {
              console.log(`[PM-USER-WS] Verified ghost fill: ${shares} shares token=...${tokenId.slice(-12)} pendingFill=${result.pendingFillId}`);
              audit({ module: "ws", fn: "pmUserWsHandler", action: "ws-ghost-fill-verified", shares, trigger: "pm-user-ws-trade-event", context: { tokenId, pendingFillId: result.pendingFillId, evtId: evt.id, evtStatus: evt.status, evtSize: evt.size, evtPrice: evt.price } });
              _pmGhostFillHandler(tokenId, shares, evt.id || "ws-ghost");
            }
          }
        }
      }
    } catch (err) { console.error("[PM-USER-WS] Parse error:", (err as Error).message); }
  });

  _pmUserWs.on("close", () => {
    console.log("[PM-USER-WS] Disconnected, reconnecting in 3s...");
    _pmUserWsReady = false;
    setTimeout(connectPmUserWs, 3000);
  });
  _pmUserWs.on("error", (err) => { console.error("[PM-USER-WS] Error:", (err as Error).message); });
}

/** Subscribe all watchlist entries to WS feeds. */
export function subscribeWatchlist(watchlist: { kal1: { ticker: string }; kal2: { ticker: string }; kal3?: { ticker: string }; pm1: { tokenId: string; noTokenId?: string }; pm2: { tokenId: string; noTokenId?: string }; pm3?: { tokenId: string; noTokenId?: string } }[]): void {
  for (const e of watchlist) {
    _kalWsSubscribe(e.kal1.ticker);
    _kalWsSubscribe(e.kal2.ticker);
    if (e.kal3) _kalWsSubscribe(e.kal3.ticker);
    _pmWsSubs.add(e.pm1.tokenId);
    _pmWsSubs.add(e.pm2.tokenId);
    if (e.pm3) _pmWsSubs.add(e.pm3.tokenId);
    if (e.pm1.noTokenId) _pmWsSubs.add(e.pm1.noTokenId);
    if (e.pm2.noTokenId) _pmWsSubs.add(e.pm2.noTokenId);
    if (e.pm3?.noTokenId) _pmWsSubs.add(e.pm3.noTokenId);
  }
  if (_pmWsReady && _pmWs && _pmWsSubs.size > 0) {
    _pmWs.send(JSON.stringify({ assets_ids: [..._pmWsSubs], type: "market" }));
  }
  console.log(`[WS] Subscribed to ${_kalWsSubs.size} Kalshi tickers + ${_pmWsSubs.size} PM tokens`);
}

// --- PM service-down backoff -------------------------------------------------

let pmServiceDownUntil = 0;
let pmConsecutive425 = 0;
const PM_BACKOFF_BASE_MS = 30_000;
const PM_BACKOFF_MAX_MS  = 300_000;

export function isPmServiceDown(): boolean {
  return Date.now() < pmServiceDownUntil;
}

export function markPmDown(): void {
  pmConsecutive425++;
  const delay = Math.min(PM_BACKOFF_MAX_MS, PM_BACKOFF_BASE_MS * Math.pow(2, pmConsecutive425 - 1));
  pmServiceDownUntil = Date.now() + delay;
  console.warn(`[PM] Service down -- backing off ${(delay / 1000).toFixed(0)}s (failure #${pmConsecutive425})`);
}

export function markPmUp(): void {
  if (pmConsecutive425 > 0) {
    console.log(`[PM] Service recovered after ${pmConsecutive425} failures.`);
    pmConsecutive425 = 0;
    pmServiceDownUntil = 0;
  }
}

/** Returns true if the PM response is a 425 / "service not ready" error. */
export function getPmServiceDownUntil(): number { return pmServiceDownUntil; }
export function getPmWsReady(): boolean { return _pmWsReady; }
export function getPmWsSubs(): Set<string> { return _pmWsSubs; }

export function isPm425(res: unknown): boolean {
  if (!res || typeof res !== "object") return false;
  const obj = res as { status?: number; error?: string };
  if (obj.status === 425) return true;
  if (typeof obj.error === "string" && obj.error.includes("not ready")) return true;
  return false;
}
