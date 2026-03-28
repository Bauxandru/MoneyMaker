/**
 * ttWebSocket.ts — Live WebSocket orderbook feeds for Kalshi and Polymarket.
 * Maintains real-time orderbook state in Maps, read synchronously by scan/exec.
 *
 * Module-level mutable state:
 *   wsKalBooks / wsPmBooks       — live orderbook Maps
 *   _kalWs / _pmWs               — WebSocket instances
 *   _priceHistory / _lastSampleTs — momentum tracking buffers
 *   pmServiceDown*                — PM 425 backoff state
 */

import crypto from "crypto";
import fs from "fs";
import WebSocket from "ws";
import { KAL_WS_STALE_MS, PM_WS_STALE_MS } from "./ttConfig.js";
import type { WsBookSide, WsLiveBook, WsPmBook } from "./ttTypes.js";

// ─── Kalshi WS auth ──────────────────────────────────────────────────────────

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

// ─── In-memory live orderbook state ──────────────────────────────────────────

export const wsKalBooks = new Map<string, WsLiveBook>();
export const wsPmBooks = new Map<string, WsPmBook>();

let _kalWs: WebSocket | null = null;
let _kalWsReady = false;
let _kalWsSubId = 0;
const _kalWsSubs = new Set<string>();
let _kalWsPingIv: ReturnType<typeof setInterval> | null = null;

let _pmWs: WebSocket | null = null;
let _pmWsReady = false;
let _pmPingInterval: ReturnType<typeof setInterval> | null = null;
const _pmWsSubs = new Set<string>();

// ─── Book accessor helpers ───────────────────────────────────────────────────

/** Convert WsBookSide Map → sorted [price, size][] array. */
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

/** Get PM ask depth from WS cache (null if stale/missing). Cents → decimal. */
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

// ─── Rolling Price Buffer (momentum detection) ──────────────────────────────

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

// ─── Kalshi WebSocket ────────────────────────────────────────────────────────

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
          book.yes.set(Math.round(Number(p) * 100), Number(s));
        }
        for (const [p, s] of (msg.msg.no_dollars_fp || msg.msg.no || [])) {
          book.no.set(Math.round(Number(p) * 100), Number(s));
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
        const cur = side.get(cents) || 0;
        const newSize = cur + delta;
        if (newSize <= 0) side.delete(cents); else side.set(cents, newSize);
        book.ts = Date.now();
        { const ya = getWsKalBestAsk(ticker, "yes"); if (ya !== null) recordPrice(`kal:${ticker}:yes`, ya); }
        { const na = getWsKalBestAsk(ticker, "no"); if (na !== null) recordPrice(`kal:${ticker}:no`, na); }
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
  _kalWs.send(JSON.stringify({ id: _kalWsSubId, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_ticker: ticker } }));
}

// ─── Polymarket WebSocket ────────────────────────────────────────────────────

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
    console.log("[WS] Polymarket disconnected, reconnecting in 3s...");
    _pmWsReady = false;
    setTimeout(connectPmWs, 3000);
  });
  _pmWs.on("error", (err) => { console.error("[WS] Polymarket error:", (err as Error).message); });
}

export function _pmWsSubscribe(tokenId: string): void {
  _pmWsSubs.add(tokenId);
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

// ─── PM service-down backoff ─────────────────────────────────────────────────

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
  console.warn(`[PM] Service down — backing off ${(delay / 1000).toFixed(0)}s (failure #${pmConsecutive425})`);
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
