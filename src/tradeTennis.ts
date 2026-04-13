/**
 * tradeTennis.ts
 *
 * Continuously monitors Kalshi KXATPMATCH vs Polymarket ATP categorical markets
 * and executes cross-platform arbitrage when edge > MIN_EDGE.
 *
 * Arb logic:
 *   For a match between P1 and P2:
 *     Direction A: Buy KAL_P1_YES + PM_P2_token  -> edge = 1 - kalP1YesAsk - pmP2Ask
 *     Direction B: Buy KAL_P2_YES + PM_P1_token  -> edge = 1 - kalP2YesAsk - pmP1Ask
 *   Both legs pay $1 in every outcome -> guaranteed profit if edge > 0.
 *
 * Execution order: KALSHI FIRST (IOC), then Polymarket sized to actual Kalshi fills.
 *   - If Kalshi fills 0 -> abort, PM never fires -> no exposure.
 *   - If Kalshi fills N contracts -> place PM FOK for exactly N shares.
 *   - If PM fails after Kalshi filled -> recovery: buy PM P1_token to own both sides.
 *
 * Safety guards:
 *   - DRY_RUN defaults to TRUE. Must set DRY_RUN=false explicitly for live trading.
 *   - MAX_CONTRACTS per trade (default 5 -- prevents over-committing on thin books).
 *   - Cooldown applied before every trade attempt (not just successes).
 *   - No retry on the same match while on cooldown.
 *
 * Env vars:
 *   DRY_RUN=true/false            (default true -- MUST be false for live trading)
 *   TRADE_USD=10                  budget per arb (default $10)
 *   MAX_CONTRACTS=5               max Kalshi contracts per trade (default 5)
 *   MIN_EDGE=0.02                 minimum edge to trade (default 2%)
 *   POLL_INTERVAL_MS=0            ms between poll cycles (default 0 = max speed)
 *   TRADE_COOLDOWN_MS=60000       ms to wait after any trade attempt (default 60s)
 *   MIN_DEPTH_MULT=2              require Nx order size depth on counterpart (default 2, 0=off)
 *   POLY_ORDER_TYPE=FOK           PM order type: FOK | GTC (default FOK)
 *   KALSHI_REQUEST_INTERVAL_MS=50   (20 req/s -- Basic tier safe)
 *   POLY_GAMMA_INTERVAL_MS=35      (~29 req/s -- gamma-api 30/s limit)
 *   POLY_CLOB_INTERVAL_MS=7        (~143 req/s -- clob-api 150/s limit)
 *   POLY_WALLET_PRIVATE_KEY=...
 *   POLY_CHAIN_ID=137
 *   POLY_SIGNATURE_TYPE=0
 *   POLY_FUNDER=...
 *   KALSHI_API_KEY_ID=...
 *   KALSHI_PRIVATE_KEY=... or KALSHI_PRIVATE_KEY_PATH=...
 *
 * Usage:
 *   DRY_RUN=true npx tsx src/tradeTennis.ts
 *   DRY_RUN=false TRADE_USD=10 MAX_CONTRACTS=3 MIN_EDGE=0.01 npx tsx src/tradeTennis.ts
 */

import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";
import { fetchJsonWithRetry, createRateLimitedFetcher } from "./http.js";
import { placeKalshiOrder, getKalshiOrder, cancelKalshiOrder, buildKalshiGTCOrder, getKalshiPosition, getKalshiPositionMap, fetchKalshiOrderbook, fetchAllKalshiFills, fetchAllKalshiSettlements, fetchKalshiMarket, getKalshiBalance, fetchOpenKalshiOrders, type KalFill, type KalSettlement } from "./kalshiTrade.js";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./polyAuth.js";
import { getOnChainBalance, getOnChainBalanceWithFallback, getUsdcBalance, scanTransferHistory, subscribeToFills, subscribeToSettlements, isFillSubscriptionActive, getChainStatus, getPolygonProvider } from "./polyChain.js";
import { type ArbTradeRecord, type ExecMetric } from "./types.js";
import { sleep, numEnv, boolEnv, strEnv, r2, pickString, parseJsonArray, normCents, normDollarsOrCents, bestAskFromSide, bestBidFromSide, kalSideForDir, totalCostForTrade } from "./utils.js";
import { isLateGame, isMatchFinished, isMatchCancelled, getMatchState } from "./liveScores.js";

// --- Atomic file write (write-to-temp + rename) ------------------------------
// Prevents data corruption if the process crashes mid-write.
function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, filePath);
}

// --- Terminal colors (auto-colorize [TAG] patterns in console.log) ------------
const _C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  white: "\x1b[37m", bgRed: "\x1b[41m", bgGreen: "\x1b[42m",
};
const _tagColors: Record<string, string> = {
  // Trading execution -- bright green
  "LIVE":           _C.green + _C.bold,
  "ARB FOUND":      _C.green + _C.bold,
  "ARB EXECUTE":    _C.green + _C.bold,
  "BOTH FILLED":    _C.green + _C.bold,
  // Dry run -- yellow
  "DRY":            _C.yellow + _C.bold,
  // Depth & liquidity -- yellow
  "DEPTH":          _C.yellow,
  "DEPTH FIX":      _C.yellow + _C.dim,
  "DEPTH OPP":      _C.yellow,
  "DEPTH CHECK":    _C.yellow + _C.bold,
  // Hedging -- cyan
  "HEDGE":          _C.cyan,
  "HEDGE MODE":     _C.cyan + _C.bold,
  "HEDGE RESUME":   _C.cyan,
  "HEDGE-ONLY":     _C.cyan,
  // Safety & abort -- red
  "SAFETY ABORT":   _C.red + _C.bold,
  "ABORT":          _C.red,
  "CIRCUIT BREAKER":_C.bgRed + _C.white + _C.bold,
  "CANC-MON":       _C.red,
  // Cooldowns -- dim red/yellow
  "SOFT COOLDOWN":  _C.yellow + _C.bold,
  "ABORT COOLDOWN": _C.yellow,
  "SKIP":           _C.dim,
  "ARB SKIP":       _C.dim,
  // P&L -- colored by value in line
  "P&L":            _C.green + _C.bold,
  // Data & reconciliation -- magenta
  "RECONCILE":      _C.magenta,
  "PM-CLOB":        _C.magenta,
  // Startup & system -- blue
  "STARTUP":        _C.blue,
  "SYNC":           _C.blue,
  "DISCOVER":       _C.blue + _C.dim,
  "STATIC":         _C.blue + _C.dim,
  // Orders
  "PM LEG":         _C.magenta,
  "KAL LEG":        _C.blue,
  "IMMEDIATE PM HEDGE": _C.cyan + _C.bold,
  // Websocket -- dim
  "WS":             _C.dim,
  "WS DIAG":        _C.dim,
  // Cost tracking
  "COST":           _C.cyan + _C.dim,
  // Chain events
  "CHAIN":          _C.magenta + _C.dim,
  "PM FILL":        _C.green,
  // Timing
  "TIMING":         _C.dim,
  "POLL":           _C.dim,
  // Cycle -- dim (high frequency)
  "CYCLE":          _C.dim,
};
// P&L value coloring: detect $X.XX or -$X.XX and color green/red
const _colorPnl = (s: string): string =>
  s.replace(/P&L=([+-]?\$[\d.]+)/g, (_, v) =>
    v.startsWith("-") || v.startsWith("-$")
      ? `P&L=${_C.red}${_C.bold}${v}${_C.reset}`
      : `P&L=${_C.green}${_C.bold}${v}${_C.reset}`);

const _origLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string") {
    let s = args[0] as string;
    // Colorize [TAG] patterns
    s = s.replace(/\[([A-Z][A-Z0-9 &/_-]*)\]/g, (match, tag) => {
      const c = _tagColors[tag];
      return c ? `${c}[${tag}]${_C.reset}` : match;
    });
    // Colorize P&L values
    s = _colorPnl(s);
    // Colorize *** ARB *** markers
    s = s.replace(/\*\*\* ARB \*\*\*/g, `${_C.green}${_C.bold}*** ARB ***${_C.reset}`);
    // Colorize edge percentages in cycle lines
    s = s.replace(/best=([\d.]+%)/g, (_, pct) => {
      const n = parseFloat(pct);
      const c = n >= 1 ? _C.green + _C.bold : n >= 0.5 ? _C.yellow : _C.dim;
      return `best=${c}${pct}${_C.reset}`;
    });
    // Colorize abort-cooldown in match lines
    s = s.replace(/\[abort-cooldown (\d+s)\]/g, `${_C.red}${_C.dim}[cooldown $1]${_C.reset}`);
    args[0] = s;
  }
  _origLog(...args);
};

// --- Env setup ----------------------------------------------------------------

import { loadCsvConfig } from "./csvConfig.js";
import { validateLicense, startPeriodicRevalidation, isLicenseValid } from "./licenseClient.js";
import { pushTradeData, startPeriodicPush } from "./dashboardPush.js";

// Load from settings.csv if present, otherwise fall back to .env
if (!loadCsvConfig("./settings.csv")) {
  dotenv.config();
}

// DRY_RUN defaults to TRUE for safety -- must set DRY_RUN=false explicitly
const DRY_RUN = boolEnv("DRY_RUN", true);
const TRADE_USD = numEnv("TRADE_USD", 10);
const MAX_CONTRACTS = Math.max(1, Math.floor(numEnv("MAX_CONTRACTS", 999)));
const MIN_EDGE = numEnv("MIN_EDGE", 0.02);
// POLL_INTERVAL_MS: also accepts TRADE_LOOP_MIN_INTERVAL_MS (trade.ts alias)
// With WS feeds active, the poll cycle does zero API calls (pure Map reads),
// so this is just a sleep to yield the event loop. 0 = max speed.
const POLL_INTERVAL_MS = Math.max(0,
  numEnv("POLL_INTERVAL_MS", numEnv("TRADE_LOOP_MIN_INTERVAL_MS", 0)));
// TRADE_COOLDOWN_MS: also accepts TRADE_LOOP_COOLDOWN_MS (trade.ts alias)
const TRADE_COOLDOWN_MS = numEnv("TRADE_COOLDOWN_MS", numEnv("TRADE_LOOP_COOLDOWN_MS", 60000));
// HEDGE_TARGET: "payout" = hedge fills accepted at breakeven (1 - costBasis);
//               "profit"  = hedge fills only at original MIN_EDGE profit
const HEDGE_TARGET = strEnv("HEDGE_TARGET", "payout") === "payout" ? "payout" : "profit";
// STRICT_HEDGE: when true, suppress exit orders in hedge mode -- only complete orders
const STRICT_HEDGE = boolEnv("STRICT_HEDGE", false);
// Single-exchange hedging: try PM-only for this many cycles before switching to KAL-only.
// Each hedge cycle is ~400ms, so 15 cycles ≈ 6 seconds.
const PM_ONLY_MAX_CYCLES = numEnv("PM_ONLY_MAX_CYCLES", 15);
// FORCE_DISCOVER: when true, skip discovery cache and scan all markets fresh
const FORCE_DISCOVER = boolEnv("FORCE_DISCOVER", false);
// Circuit breaker: stop opening new arbs when thresholds are hit.
// Existing hedge cycles continue -- only NEW arb execution is blocked.
const MAX_CONSECUTIVE_ERRORS = numEnv("MAX_CONSECUTIVE_ERRORS", 5);
const MAX_HEDGE_POSITIONS = numEnv("MAX_HEDGE_POSITIONS", 8);
// WS orderbook staleness thresholds (ms). Kalshi snapshots persist until replaced; PM updates frequently.
const KAL_WS_STALE_MS = numEnv("KAL_WS_STALE_MS", 600_000);   // 10 min default
const PM_WS_STALE_MS  = numEnv("PM_WS_STALE_MS",   30_000);    // 30 sec default
// Discovery cache TTL (ms). 0 = date-based (stale at midnight UTC, legacy behavior).
const DISCOVERY_CACHE_TTL_MS = numEnv("DISCOVERY_CACHE_TTL_MS", 3_600_000); // 1 hour default
// Liquidity depth check: require counterpart exchange to have at least Nx our
// order size available before executing.  Prevents one-legged exposure when the
// other side has thin liquidity.  Set to 0 to disable.
const MIN_DEPTH_MULT = numEnv("MIN_DEPTH_MULT", 2);
// PM minimum order size: per-market `orderMinSize` field (typically 5 shares).
// PM CLOB enforces $1 minimum for any order that is "marketable" (bid >= ask).
// This applies to FOK/IOC AND GTC bids that would immediately match.
const PM_MARKETABLE_MIN_VALUE = 1.0;
// Fee rates for accurate edge calculation.
// KALSHI_FEE_RATE: Kalshi taker fee multiplier. Formula: rate x P x (1-P) per contract.
//   Standard rate is 7% (0.07). Max fee ≈ 1.75c/contract at P=0.50.
// PM_FEE_RATE: Polymarket taker fee. ATP tennis markets currently have ZERO fees.
//   Set > 0 only if trading fee-enabled markets (crypto, NCAAB, Serie A).
const KALSHI_FEE_RATE = numEnv("KALSHI_FEE_RATE", 0.07);
const PM_FEE_RATE = numEnv("PM_FEE_RATE", 0);
// KAL_MAKER_MODE: when true, first tries a GTC bid at ask-1c (maker fee: 1.75%)
// instead of IOC at ask (taker fee: 7%). Falls back to IOC after KAL_MAKER_WAIT_MS.
const KAL_MAKER_MODE = boolEnv("KAL_MAKER_MODE", false);
const KAL_MAKER_WAIT_MS = numEnv("KAL_MAKER_WAIT_MS", 5000);
const KAL_MAKER_POLL_MS = 500; // poll interval while waiting for maker fill
const PM_ORDER_TYPE_RAW = (process.env.POLY_ORDER_TYPE ?? "FOK").toUpperCase();
const PM_ORDER_TYPE: OrderType =
  PM_ORDER_TYPE_RAW in OrderType
    ? (OrderType as Record<string, OrderType>)[PM_ORDER_TYPE_RAW]
    : OrderType.FOK;

// Disable system proxy
for (const k of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"])
  delete process.env[k];
process.env.NODE_USE_ENV_PROXY = "false";

// --- Live WebSocket orderbook feeds ------------------------------------------
// Maintains real-time orderbook state for both Kalshi and Polymarket via WS.
// Data is stored in Maps and read synchronously by the scan loop and executeArb.

// Kalshi WS auth (reuses same key/signing as kalshiTrade.ts)
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

// In-memory live orderbook state
type WsBookSide = Map<number, number>; // priceCents -> size
interface WsLiveBook {
  yes: WsBookSide;
  no: WsBookSide;
  ts: number; // last update timestamp
}

const wsKalBooks = new Map<string, WsLiveBook>(); // ticker -> book
const wsPmBooks = new Map<string, { bids: WsBookSide; asks: WsBookSide; ts: number }>(); // tokenId -> book

let _kalWs: WebSocket | null = null;
let _kalWsReady = false;
let _kalWsSubId = 0;
const _kalWsSubs = new Set<string>();
let _kalWsPingIv: ReturnType<typeof setInterval> | null = null;

let _pmWs: WebSocket | null = null;
let _pmWsReady = false;
let _pmPingInterval: ReturnType<typeof setInterval> | null = null;
const _pmWsSubs = new Set<string>();

// Convert WsBookSide Map -> sorted [price, size][] array (same format as fetchKalshiOrderbook)
function wsBookToArray(m: WsBookSide): [number, number][] {
  const arr: [number, number][] = [];
  for (const [price, size] of m) {
    if (size > 0) arr.push([price, size]);
  }
  return arr.sort((a, b) => a[0] - b[0]);
}

// Get Kalshi orderbook from WS cache (returns null if not available/stale)
// KAL snapshots remain valid until replaced by a new snapshot/delta -- use long TTL (10min).
// Low-activity markets may not get deltas for minutes but the snapshot is still the true state.
function getWsKalBook(ticker: string): { yes: [number, number][]; no: [number, number][] } | null {
  const book = wsKalBooks.get(ticker);
  if (!book || Date.now() - book.ts > KAL_WS_STALE_MS) return null;
  return { yes: wsBookToArray(book.yes), no: wsBookToArray(book.no) };
}

// Get PM ask depth from WS cache (returns null if not available/stale)
function getWsPmAsks(tokenId: string): [number, number][] | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  const arr: [number, number][] = [];
  for (const [price, size] of book.asks) {
    if (size > 0) arr.push([price / 100, size]); // convert cents -> decimal for PM
  }
  return arr.sort((a, b) => a[0] - b[0]);
}

// Get Kalshi best YES or NO ask from WS cache (returns null if not available)
// YES ask = 100 - best NO bid;  NO ask = 100 - best YES bid
function getWsKalBestAsk(ticker: string, side: "yes" | "no"): number | null {
  const book = wsKalBooks.get(ticker);
  if (!book || Date.now() - book.ts > KAL_WS_STALE_MS) return null;
  // To buy YES, we need the cheapest YES ask = 100 - highest NO bid
  // To buy NO, we need the cheapest NO ask = 100 - highest YES bid
  const oppSide = side === "yes" ? book.no : book.yes;
  let bestBidCents = 0;
  for (const [price, size] of oppSide) {
    if (size > 0 && price > bestBidCents) bestBidCents = price;
  }
  if (bestBidCents === 0) return null;
  return (100 - bestBidCents) / 100; // cents -> decimal
}

// Get PM best ask price from WS cache (returns null if not available)
function getWsPmBestAsk(tokenId: string): number | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  let best = Infinity;
  for (const [price, size] of book.asks) {
    if (size > 0 && price < best) best = price;
  }
  return best === Infinity ? null : best / 100; // cents -> decimal
}

function getWsPmBestBid(tokenId: string): number | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  let best = 0;
  for (const [price, size] of book.bids) {
    if (size > 0 && price > best) best = price;
  }
  return best === 0 ? null : best / 100;
}

// --- Rolling Price Buffer (momentum detection) --------------------------------
// Tracks last 60 seconds of best-ask snapshots per market, sampled on every WS
// update.  Used at arb-execution time to determine which leg's price is "moving
// against us" so we can fill that leg first.
const MOMENTUM_WINDOW_MS = 60_000;
const MOMENTUM_SAMPLE_INTERVAL_MS = 500; // don't record more than 2 samples/sec per key
interface PriceSample { ts: number; ask: number }
const _priceHistory = new Map<string, PriceSample[]>();
const _lastSampleTs = new Map<string, number>();

function recordPrice(key: string, ask: number): void {
  const now = Date.now();
  const lastTs = _lastSampleTs.get(key) ?? 0;
  if (now - lastTs < MOMENTUM_SAMPLE_INTERVAL_MS) return; // throttle
  _lastSampleTs.set(key, now);
  let buf = _priceHistory.get(key);
  if (!buf) { buf = []; _priceHistory.set(key, buf); }
  buf.push({ ts: now, ask });
  // Trim old samples
  while (buf.length > 0 && buf[0].ts < now - MOMENTUM_WINDOW_MS) buf.shift();
}

/** Returns price change over the last `windowMs` for a given market key.
 *  Positive = price rising (getting more expensive for us).
 *  Returns 0 if insufficient data. */
function getMomentum(key: string, windowMs: number = 10_000): number {
  const buf = _priceHistory.get(key);
  if (!buf || buf.length < 2) return 0;
  const cutoff = Date.now() - windowMs;
  // Find oldest sample within window
  let oldest: PriceSample | null = null;
  for (const s of buf) {
    if (s.ts >= cutoff) { oldest = s; break; }
  }
  if (!oldest) oldest = buf[buf.length - 2]; // fallback: second-to-last
  const latest = buf[buf.length - 1];
  if (oldest.ts === latest.ts) return 0;
  return latest.ask - oldest.ask;
}

function connectKalshiWs() {
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
        // Record best asks for momentum tracking
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
        // Record best asks for momentum tracking
        { const ya = getWsKalBestAsk(ticker, "yes"); if (ya !== null) recordPrice(`kal:${ticker}:yes`, ya); }
        { const na = getWsKalBestAsk(ticker, "no"); if (na !== null) recordPrice(`kal:${ticker}:no`, na); }
      }
    } catch (err) { console.error("[WS] Kalshi message parse error:", (err as Error).message); }
  });

  _kalWs.on("close", () => {
    console.log("[WS] Kalshi disconnected, reconnecting in 3s...");
    _kalWsReady = false;
    wsKalBooks.clear(); // invalidate all cached books on disconnect
    setTimeout(connectKalshiWs, 3000);
  });
  _kalWs.on("error", (err) => { console.error("[WS] Kalshi error:", (err as Error).message); });
}

function _kalWsSubscribe(ticker: string) {
  _kalWsSubs.add(ticker);
  if (!_kalWsReady || !_kalWs) return;
  _kalWsSubId++;
  _kalWs.send(JSON.stringify({ id: _kalWsSubId, cmd: "subscribe", params: { channels: ["orderbook_delta"], market_ticker: ticker } }));
}

function connectPmWs() {
  _pmWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

  _pmWs.on("open", () => {
    console.log("[WS] Polymarket connected");
    _pmWsReady = true;
    // Batch subscribe all tokens in one message (avoids rate-limiting from 142 individual sends)
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
          // Record best ask for momentum tracking
          { const ba = getWsPmBestAsk(tokenId); if (ba !== null) recordPrice(`pm:${tokenId}`, ba); }
        } else if (evt.event_type === "price_change") {
          // price_changes[] has per-entry asset_id (may differ from top-level)
          for (const ch of (evt.price_changes || [])) {
            const aid = ch.asset_id || evt.asset_id;
            if (!aid) continue;
            let book = wsPmBooks.get(aid);
            if (!book) { book = { bids: new Map(), asks: new Map(), ts: Date.now() }; wsPmBooks.set(aid, book); }
            const side = ch.side === "BUY" ? book.bids : book.asks;
            const p = Math.round(Number(ch.price) * 100), s = Number(ch.size);
            if (s <= 0) side.delete(p); else side.set(p, s);
            book.ts = Date.now();
            // Record best ask for momentum tracking
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

function _pmWsSubscribe(tokenId: string) {
  _pmWsSubs.add(tokenId);
  // Don't send individual messages here -- batch subscribe is done on open
  // and via subscribeWatchlist. Only send for dynamic additions after startup.
}

// Subscribe all watchlist entries to WS feeds
function subscribeWatchlist(watchlist: { kal1: { ticker: string }; kal2: { ticker: string }; kal3?: { ticker: string }; pm1: { tokenId: string; noTokenId?: string }; pm2: { tokenId: string; noTokenId?: string }; pm3?: { tokenId: string; noTokenId?: string } }[]) {
  for (const e of watchlist) {
    _kalWsSubscribe(e.kal1.ticker);
    _kalWsSubscribe(e.kal2.ticker);
    if (e.kal3) _kalWsSubscribe(e.kal3.ticker);
    _pmWsSubs.add(e.pm1.tokenId);
    _pmWsSubs.add(e.pm2.tokenId);
    if (e.pm3) _pmWsSubs.add(e.pm3.tokenId);
    // Subscribe to NO tokens for soccer J/K/L dirs
    if (e.pm1.noTokenId) _pmWsSubs.add(e.pm1.noTokenId);
    if (e.pm2.noTokenId) _pmWsSubs.add(e.pm2.noTokenId);
    if (e.pm3?.noTokenId) _pmWsSubs.add(e.pm3.noTokenId);
  }
  // Send batched PM subscription if WS is already connected
  if (_pmWsReady && _pmWs && _pmWsSubs.size > 0) {
    _pmWs.send(JSON.stringify({ assets_ids: [..._pmWsSubs], type: "market" }));
  }
  console.log(`[WS] Subscribed to ${_kalWsSubs.size} Kalshi tickers + ${_pmWsSubs.size} PM tokens`);
}

// --- PM service-down backoff -------------------------------------------------
// When PM CLOB returns 425 "service not ready", back off to avoid hammering it.
// Exponential backoff: 30s -> 60s -> 120s -> max 300s. Resets on any successful PM order.
let pmServiceDownUntil = 0;          // timestamp -- skip PM orders until this time
let pmConsecutive425 = 0;            // consecutive 425 failures
const PM_BACKOFF_BASE_MS = 30_000;   // 30s initial backoff
const PM_BACKOFF_MAX_MS  = 300_000;  // 5 min max backoff

function isPmServiceDown(): boolean {
  return Date.now() < pmServiceDownUntil;
}

function markPmDown(): void {
  pmConsecutive425++;
  const delay = Math.min(PM_BACKOFF_MAX_MS, PM_BACKOFF_BASE_MS * Math.pow(2, pmConsecutive425 - 1));
  pmServiceDownUntil = Date.now() + delay;
  console.warn(`[PM] Service down -- backing off ${(delay / 1000).toFixed(0)}s (failure #${pmConsecutive425})`);
}

function markPmUp(): void {
  if (pmConsecutive425 > 0) {
    console.log(`[PM] Service recovered after ${pmConsecutive425} failures.`);
    pmConsecutive425 = 0;
    pmServiceDownUntil = 0;
  }
}

/** Returns true if the PM response is a 425 / "service not ready" error. */
function isPm425(res: unknown): boolean {
  if (!res || typeof res !== "object") return false;
  const obj = res as { status?: number; error?: string };
  if (obj.status === 425) return true;
  if (typeof obj.error === "string" && obj.error.includes("not ready")) return true;
  return false;
}

// --- Small utils --------------------------------------------------------------

// --- API response types ------------------------------------------------------
// Lightweight interfaces covering the fields we actually read from each API.
// All fields optional -- external APIs may omit any field at any time.

/** Kalshi market object (from /markets/{ticker} or nested inside events). */
type KalshiMarket = {
  ticker?: string;
  title?: string;
  subtitle?: string;
  status?: string;
  state?: string;
  result?: string;
  settlement_value?: string | number;
  close_time?: string;
  expected_expiration_time?: string;
  yes_ask?: number;
  yes_bid?: number;
  no_ask?: number;
  yes_ask_dollars?: number;
  yes_bid_dollars?: number;
  no_ask_dollars?: number;
  yes_ask_size_fp?: number;
  yes_ask_size?: number;
  yes_bid_size_fp?: number;
  yes_bid_size?: number;
  no_ask_size_fp?: number;
  no_ask_size?: number;
  remaining_count?: number;
  yes_sub_title?: string;
};

/** Kalshi event object (from /events/{ticker}). */
type KalshiEvent = {
  event_ticker?: string;
  ticker?: string;
  title?: string;
  name?: string;
  category?: string;
  event_category?: string;
  series_category?: string;
  markets?: KalshiMarket[];
};

/** Kalshi order object (from getOrder / placeOrder responses). */
type KalshiOrder = {
  order_id?: string;
  orderId?: string;
  status?: string;
  fill_count?: number;
  fill_count_fp?: string;    // "13.00" -- newer API format
  filled_count?: number;
  filled_contracts?: number;
  filled?: number;
  remaining_count?: number;
  taker_fees?: number;
  maker_fees?: number;
  taker_fees_dollars?: string;   // "0.1234" -- newer API format
  maker_fees_dollars?: string;
  taker_fill_cost?: number;       // actual fill cost in cents (taker)
  maker_fill_cost?: number;       // actual fill cost in cents (maker)
  taker_fill_cost_dollars?: string; // "11.18" -- newer API format
  maker_fill_cost_dollars?: string;
  order?: KalshiOrder;
};

/** Polymarket Gamma API market object. */
type GammaMarket = {
  slug?: string;
  marketSlug?: string;
  question?: string;
  title?: string;
  outcomes?: string | string[];
  clobTokenIds?: string | string[];
  tokens?: Array<{ token_id?: string; outcome?: string }>;
  active?: boolean;
  closed?: boolean;
  sportsMarketType?: string;
  _eventSlug?: string;  // transient -- set by discovery code
  [key: string]: unknown; // allow arbitrary fields for forward compat
};

/** Polymarket Gamma API event object. */
type GammaEvent = {
  slug?: string;
  markets?: GammaMarket[];
  [key: string]: unknown;
};

/** Polymarket positions API entry. */
type PmPosition = {
  asset?: string;
  tokenId?: string;
  conditionId?: string;
  size?: number | string;
  amount?: number | string;
  slug?: string;
  marketSlug?: string;
  outcome?: string;
  title?: string;
  avgPrice?: number | string;
  averagePrice?: number | string;
  price?: number | string;
};

/** Polymarket CLOB order response. */
type PmOrderResponse = {
  orderID?: string;
  orderId?: string;
  status?: string | number;  // string for order status, number for HTTP error codes
  order_status?: string;
  transactionsHashes?: string[];
  transactionHash?: string;
  txHash?: string;
  order?: PmOrderResponse;
};

/** CLOB orderbook entry (could be array [price, size] or object). */
type ClobBookEntry = { price?: number; size?: number } | [number, number];

// Helper: parse Gamma API response that could be an array or { events: [...] } or { markets: [...] }
function parseGammaEvents(raw: unknown): GammaEvent[] {
  if (Array.isArray(raw)) return raw as GammaEvent[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events as GammaEvent[];
    if (Array.isArray(obj.markets)) return [{ markets: obj.markets as GammaMarket[] }];
  }
  return [];
}

function parseGammaMarkets(raw: unknown): GammaMarket[] {
  if (Array.isArray(raw)) return raw as GammaMarket[];
  return [];
}

function parseKalshiMarkets(res: { markets?: KalshiMarket[] }): KalshiMarket[] {
  return Array.isArray(res.markets) ? res.markets : [];
}

function fmtPct(v: number, d = 1): string { return (v * 100).toFixed(d) + "%"; }
function ts(): string { return new Date().toISOString().replace("T", " ").slice(0, 23); }

// Estimate total fees for one arb direction (per share).
// Kalshi taker fee: KALSHI_FEE_RATE x P x (1 - P) per contract.
//   Kalshi rounds the TOTAL fee for N contracts, not per-contract.
//   Actual total = round(N x rate x P x (1-P) x 100) / 100.
// PM fee: PM_FEE_RATE x P x (1-P) per share (currently 0 for tennis).
// Returns the exact per-share fee cost (no rounding) for accurate edge calculation.
// Rounding only matters at order time when computing total cost for N shares.
function estimateFees(kalAsk: number, pmAsk: number): number {
  const kalFee = KALSHI_FEE_RATE * kalAsk * (1 - kalAsk);
  const pmFee = PM_FEE_RATE * pmAsk * (1 - pmAsk);
  return kalFee + pmFee;
}

// --- Rate-limited fetch helpers -----------------------------------------------

const retryOpts = { timeoutMs: 12000, maxRetries: 3, baseDelayMs: 600, maxDelayMs: 8000, jitterMs: 200 };
const kalFetch = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 50), retryOpts);
// Two separate PM queues -- gamma (discovery, 30/s) and CLOB (orderbook, 150/s) don't block each other.
const polyFetch = createRateLimitedFetcher(numEnv("POLY_GAMMA_INTERVAL_MS", 35), retryOpts);       // gamma-api.polymarket.com -- 30/s limit
const polyClobFetch = createRateLimitedFetcher(numEnv("POLY_CLOB_INTERVAL_MS", 7), retryOpts);     // clob.polymarket.com -- 150/s limit

// --- Types --------------------------------------------------------------------

type KalshiLeg = {
  ticker: string;
  surname: string;
  yesAsk: number;
  noAsk: number;
  yesAskSize?: number;  // top-of-book depth from yes_ask_size_fp (0 if unknown)
  noAskSize?: number;   // top-of-book depth (inferred from yes_bid_size_fp)
};

type PmLeg = {
  outcome: string;
  tokenId: string;
  noTokenId?: string;  // NO token for binary sub-markets (soccer 3-way)
  tickSize: number;
  minSize: number;
  negRisk: boolean;
};

type WatchEntry = {
  matchCode: string;
  pmSlug: string;
  date: string;
  kal1: KalshiLeg;
  kal2: KalshiLeg;
  pm1: PmLeg;
  pm2: PmLeg;
  // Soccer 3-way: optional 3rd legs (Draw on KAL, Draw on PM)
  kal3?: KalshiLeg;  // Draw market on Kalshi (ticker ends -TIE)
  pm3?: PmLeg;       // Draw market on PM (slug ends -draw)
  is3Way?: boolean;   // true for soccer/3-outcome markets
  // Non-moneyline binary: single-ticker KAL market (spreads, totals, game totals)
  // kal1 = kal2 = same ticker; pm1 = YES outcome; pm2 = NO/opposing outcome
  // Only dirs A (KAL YES + PM NO) and C (KAL NO + PM YES) are valid arbs.
  isBinary?: boolean;
};

// --- Hedge mode types ---------------------------------------------------------

type UnhedgedPosition = {
  tradeId: string;              // links back to ArbTradeRecord.id for precise resolution
  heldExchange: "pm" | "kal";  // which side we currently hold
  pmLeg: PmLeg;
  pmOppLeg: PmLeg | null;       // the OTHER PM outcome token (held-PM only: buy this to complete arb entirely on PM)
  pmCostBasis: number;          // price paid per PM share (0 if not held yet)
  kalLeg: KalshiLeg;
  kalCostBasis: number;         // price paid per Kalshi contract (0 if not held yet)
  kalSide: "yes" | "no";       // which KAL side was bought (dirs A/B=yes, C/D=no)
  sharesHeld: number;           // unhedged shares/contracts remaining
  initialShares: number;        // original number of shares at trade entry
  initialCost: number;          // cost of the first leg (the one that filled at trade time)
  hedgeFillCost: number;        // accumulates actual cost of hedge fills (completing leg)
  hedgeFillCostKal: number;     // portion of hedgeFillCost spent on Kalshi
  hedgeFillCostPm: number;      // portion of hedgeFillCost spent on Polymarket
  kalFees: number;              // accumulated Kalshi fees (initial + hedge fills)
  initialKalFees: number;       // Kalshi fees from initial fill only (for accurate resolve)
};

// Resting GTC order placed in the book (complete = buy missing leg, exit = sell existing)
type HedgeOrder = {
  role: "complete" | "exit";
  exchange: "pm" | "kal";
  orderId: string;
  price: number;                // price at which order was placed
  shares: number;               // original size
  filledSoFar: number;          // cumulative fills seen so far (for delta tracking)
  fetchFailures: number;        // consecutive status-check errors; order removed after 3
  placedAt: number;             // Date.now() when placed -- used for timeout rotation
  // Transient tracking fields (not persisted, used within hedge cycle)
  _lastFeeSeen?: number;        // cumulative Kalshi fees from last poll (for delta calc)
  _feeDelta?: number;           // fee increment since last poll
  _lastLogKey?: string;         // dedup key for status logging
};

type HedgeState = {
  position: UnhedgedPosition;
  activeOrders: Map<string, HedgeOrder>; // orderId -> HedgeOrder
  kalNextRetryAt: number;               // timestamp: don't retry Kalshi until after this
  lastCompleteExchange?: "pm" | "kal";  // for sequential hedge rotation
  pmOnlyCycles: number;                 // consecutive cycles with no PM fill (for single-exchange hedging)
};

// --- Execution metrics (ExecMetric type imported from types.ts) -------------

// --- Arb P&L tracking --------------------------------------------------------

// ArbTradeRecord imported from ./types.ts (shared with dashboard + repairTrades)

// --- Player name / slug helpers -----------------------------------------------

function extractEntityName(title: string): string {
  // Tennis: "Will Vacherot win the Vacherot vs Monfils match?"
  const mWin = title.match(/^Will\s+(.+?)\s+win\b/i);
  if (mWin) return mWin[1].trim();
  // NBA/soccer: "Will the Utah Jazz beat the Sacramento Kings?" -> "Utah Jazz"
  const mBeat = title.match(/^Will\s+(?:the\s+)?(.+?)\s+beat\b/i);
  if (mBeat) return mBeat[1].trim();
  // Soccer tie/draw: "Will the match end in a tie/draw?" -> "Tie"/"Draw"
  if (/\b(?:tie|draw)\b/i.test(title)) {
    if (/\bdraw\b/i.test(title)) return "Draw";
    return "Tie";
  }
  // Generic fallback: "Will X [verb] ..." -- capture up to common verbs
  const mGeneric = title.match(/^Will\s+(?:the\s+)?(.+?)\s+(?:defeat|advance|qualify|make|reach|finish)\b/i);
  if (mGeneric) return mGeneric[1].trim();
  return "";
}

function pmSlugToken(fullName: string): string {
  const last = fullName.trim().split(/\s+/).pop() ?? fullName;
  return last.toLowerCase().slice(0, 7);
}

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function parseDateFromTicker(ticker: string): string {
  // Kalshi ticker date format is YYMMMDD, e.g. "26FEB25" = year 2026, Feb, day 25
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  return `20${m[1]}-${MONTHS[m[2].toUpperCase()] ?? "01"}-${m[3].padStart(2, "0")}`;
}

function matchCodePrefix(ticker: string): string {
  return ticker.replace(/-[^-]+$/, "");
}

// Map Kalshi series prefix -> Polymarket slug prefix for fast slug-guessing.
// Add entries as new series are discovered.
const SERIES_TO_PM_PREFIX: Record<string, string> = {
  // Esports
  KXATPMATCH: "atp",    KXWTAMATCH: "wta",
  KXATPCHALLENGERMATCH: "atp",   // ATP Challenger -- same PM "atp-" prefix
  KXWTACHALLENGERMATCH: "wta",   // WTA Challenger / WTA 125 -- same PM "wta-" prefix
  KXATPSETWINNER: "atp",        // ATP Set 1 Winners -- same PM "atp-" prefix
  KXATPGAMETOTAL: "atp",        // ATP Match Totals -- same PM "atp-" prefix
  KXCS2GAME: "cs2",     KXCS2MAP: "cs2",     KXCS2TOTALMAPS: "cs2",
  KXLOLGAME: "lol",     KXLOLMAP: "lol",     KXLOLTOTALMAPS: "lol",
  KXDOTA2GAME: "dota2", KXDOTA2MAP: "dota2",
  KXVALORANTGAME: "val",  KXVALORANTMAP: "val",
  KXCSGAME: "cs2",        KXCSMAP: "cs2",
  KXCODGAME: "codmw",     KXCODMAP: "codmw",
  // Basketball -- NBA + international (PM uses "bk" prefix for intl basketball)
  KXNBAGAME: "nba",     KXNBASPREAD: "nba",   KXNBATOTAL: "nba",
  KXNBLGAME: "bknbl",
  KXCBAGAME: "bkcba",
  KXKBLGAME: "bkkbl",
  KXACBGAME: "bkacb",         // no PM markets currently
  KXBBLGAME: "bkbbl",         // no PM markets currently
  KXBSLGAME: "bkbsl",         // no PM markets currently
  KXVTBGAME: "bkvtb",         // no PM markets currently
  KXABAGAME: "bkaba",         // no PM markets currently
  KXEUROLEAGUEGAME: "euroleague",
  KXARGLNBGAME: "bkarg",        // Argentina Liga Nacional Basketball
  KXBBSERIEAGAME: "bkseriea",   // Italy Serie A Basketball
  // Hockey -- NHL
  KXNHLGAME: "nhl",     KXNHLSPREAD: "nhl",   KXNHLTOTAL: "nhl",
  // Baseball
  KXMLBGAME: "mlb",
  KXMLBSTGAME: "mlb",  // Spring Training
  // College basketball
  KXNCAAMBGAME: "cbb",   KXNCAAMBSPREAD: "cbb",   // NCAA Men's Basketball (March Madness)
  KXNCAAWBGAME: "cwbb",  // NCAA Women's Basketball
  // Soccer -- Top 5 leagues (moneyline + spreads + totals)
  KXEPLGAME: "epl",         KXEPLSPREAD: "epl",         KXEPLTOTAL: "epl",
  KXLALIGAGAME: "lal",      KXLALIGASPREAD: "lal",      KXLALIGATOTAL: "lal",
  KXBUNDESLIGAGAME: "bun",  KXBUNDESLIGASPREAD: "bun",  KXBUNDESLIGATOTAL: "bun",
  KXSERIEAGAME: "sea",      KXSERIEASPREAD: "sea",      KXSERIEATOTAL: "sea",
  KXLIGUE1GAME: "fl1",      KXLIGUE1SPREAD: "fl1",      KXLIGUE1TOTAL: "fl1",
  // Soccer -- MLS
  KXMLSGAME: "mls",         KXMLSSPREAD: "mls",         KXMLSTOTAL: "mls",
  // Soccer -- European cups
  KXUCLGAME: "ucl",         KXUCLSPREAD: "ucl",         KXUCLTOTAL: "ucl",
  KXUELGAME: "uel",         KXUELSPREAD: "uel",         KXUELTOTAL: "uel",
  // Soccer -- Other European leagues
  KXEFLCHAMPIONSHIPGAME: "elc",
  KXSCOTTISHPREMGAME: "scop",
  KXEREDIVISIEGAME: "ere",
  KXLIGAPORTUGALGAME: "por",
  KXSUPERLIGGAME: "tur",
  KXBELGIANPLGAME: "bel",      // needs verification
  KXEKSTRAKLASAGAME: "pol",     // needs verification
  KXSLGREECEGAME: "gre",       // needs verification
  KXSWISSLEAGUEGAME: "swi",    // needs verification
  KXDENSUPERLIGAGAME: "den",
  KXHNLGAME: "cro",            // needs verification
  // Soccer -- Second divisions
  KXBUNDESLIGA2GAME: "bl2",
  KXLALIGA2GAME: "es2",
  KXSERIEBGAME: "itsb",
  // Soccer -- Americas
  KXLIGAMXGAME: "mex",
  KXBRASILEIROGAME: "bra",     KXBRASILEIROSPREAD: "bra",   KXBRASILEIROTOTAL: "bra",
  KXARGPREMDIVGAME: "arg",
  KXDIMAYORGAME: "col1",
  KXCHLLDPGAME: "chi1",
  KXECULPGAME: "ecu",          // needs verification
  KXURYPDGAME: "uru",          // needs verification
  KXVENFUTVEGAME: "ven",       // needs verification
  KXAPFDDHGAME: "par",         // needs verification
  KXUSLGAME: "usl",            // needs verification
  KXNWSLGAME: "nwsl",          // needs verification
  KXCONCACAFCCUPGAME: "conc",  // needs verification
  // Soccer -- Asia / Middle East / Other
  KXSAUDIPLGAME: "spl",       KXSAUDIPLSPREAD: "spl",     KXSAUDIPLTOTAL: "spl",
  KXKLEAGUEGAME: "kor",
  KXJLEAGUEGAME: "j1-100",
  KXALEAGUEGAME: "aus",
  KXCHNSLGAME: "chi",
  KXTHAIL1GAME: "tha",         // needs verification
  KXAFCCLGAME: "afc",          // needs verification
  // Soccer -- International
  KXINTLFRIENDLYGAME: "fif",
  KXFIFAGAME: "uef",           // FIFA/UEFA qualifiers
  // Soccer -- Cups (seasonal, may have 0 open markets)
  KXFACUPGAME: "efa",
  KXEFLCUPGAME: "efl",
  // Soccer -- Women
  KXEWSLGAME: "ewsl",          // needs verification
};
const TENNIS_SERIES = new Set(["KXATPMATCH", "KXWTAMATCH", "KXATPCHALLENGERMATCH", "KXWTACHALLENGERMATCH"]);
const NBA_SERIES = new Set(["KXNBAGAME"]);
const NHL_SERIES = new Set(["KXNHLGAME"]);
const MLB_SERIES = new Set(["KXMLBGAME", "KXMLBSTGAME"]);
const CBB_SERIES = new Set(["KXNCAAMBGAME", "KXNCAAWBGAME"]);

// Non-moneyline series: single-ticker binary markets (spreads, totals, game totals)
// Each Kalshi event contains MANY markets (one per line). Each market is independently
// matchable to a PM market. Discovery creates isBinary WatchEntries with kal1=kal2.
const NON_MONEYLINE_BINARY_SERIES = new Set([
  "KXNBASPREAD", "KXNBATOTAL",       // NBA spreads & totals
  "KXNHLSPREAD", "KXNHLTOTAL",       // NHL spreads & totals
  "KXNCAAMBSPREAD",                    // CBB spreads
  "KXATPGAMETOTAL",                    // ATP match totals
  "KXCS2TOTALMAPS", "KXLOLTOTALMAPS", // CS2/LoL total maps
  // Soccer spreads & totals -- all major leagues
  "KXEPLSPREAD", "KXEPLTOTAL",
  "KXMLSSPREAD", "KXMLSTOTAL",
  "KXUCLSPREAD", "KXUCLTOTAL",
  "KXUELSPREAD", "KXUELTOTAL",
  "KXLALIGASPREAD", "KXLALIGATOTAL",
  "KXSERIEASPREAD", "KXSERIEATOTAL",
  "KXBUNDESLIGASPREAD", "KXBUNDESLIGATOTAL",
  "KXLIGUE1SPREAD", "KXLIGUE1TOTAL",
  "KXBRASILEIROSPREAD", "KXBRASILEIROTOTAL",
  "KXSAUDIPLSPREAD", "KXSAUDIPLTOTAL",
  "KXARGPREMDIVSPREAD", "KXARGPREMDIVTOTAL",     // if Kalshi adds these
  "KXKLEAGUESPREAD", "KXKLEAGUETOTAL",           // if Kalshi adds these
]);
// Set-winner series: 2-market events (like moneyline) but for set outcomes
const SET_WINNER_SERIES = new Set(["KXATPSETWINNER"]);

// CBB name aliases: Kalshi abbreviations -> expanded name that appears in PM outcomes.
// Only needed where Kalshi's entity name is NOT a substring of PM's "School Mascot" format.
const CBB_NAME_ALIASES: Record<string, string> = {
  "uconn": "connecticut",
  "conn": "connecticut",           // Kalshi sub_title uses CONN
  "smu": "southern methodist",
  "ucf": "central florida",
  "byu": "brigham young",
  "vcu": "virginia commonwealth",
  "umass": "massachusetts",
  "ole miss": "mississippi",
  "usc": "southern california",
  "lsu": "louisiana state",
  "unlv": "nevada las vegas",
  "utep": "texas el paso",
  "unc": "north carolina",
  "uab": "alabama birmingham",
  "utsa": "texas san antonio",
};

/** Expand known CBB abbreviations before matching. */
function cbbExpandName(name: string): string {
  const n = name.toLowerCase().trim();
  return CBB_NAME_ALIASES[n] ?? n;
}

/** CBB-aware name matching: try namesMatch, then try with alias expansion. */
function cbbNamesMatch(kalName: string, pmOutcome: string): boolean {
  if (namesMatch(kalName, pmOutcome)) return true;
  const expanded = cbbExpandName(kalName);
  if (expanded !== kalName.toLowerCase().trim() && namesMatch(expanded, pmOutcome)) return true;
  // Also try expanding PM side (rare, but PM could use abbreviation in outcome)
  const pmExpanded = cbbExpandName(pmOutcome);
  if (pmExpanded !== pmOutcome.toLowerCase().trim() && namesMatch(kalName, pmExpanded)) return true;
  return false;
}

const SOCCER_SERIES = new Set([
  // Top 5 + MLS
  "KXEPLGAME", "KXLALIGAGAME", "KXBUNDESLIGAGAME", "KXSERIEAGAME", "KXLIGUE1GAME", "KXMLSGAME",
  // European cups
  "KXUCLGAME", "KXUELGAME",
  // Other European
  "KXEFLCHAMPIONSHIPGAME", "KXSCOTTISHPREMGAME", "KXEREDIVISIEGAME", "KXLIGAPORTUGALGAME",
  "KXSUPERLIGGAME", "KXBELGIANPLGAME", "KXEKSTRAKLASAGAME", "KXSLGREECEGAME",
  "KXSWISSLEAGUEGAME", "KXDENSUPERLIGAGAME", "KXHNLGAME",
  // Second divisions
  "KXBUNDESLIGA2GAME", "KXLALIGA2GAME", "KXSERIEBGAME",
  // Americas
  "KXLIGAMXGAME", "KXBRASILEIROGAME", "KXARGPREMDIVGAME", "KXDIMAYORGAME",
  "KXCHLLDPGAME", "KXECULPGAME", "KXURYPDGAME", "KXVENFUTVEGAME", "KXAPFDDHGAME",
  "KXUSLGAME", "KXNWSLGAME", "KXCONCACAFCCUPGAME",
  // Asia / Middle East / Other
  "KXSAUDIPLGAME", "KXKLEAGUEGAME", "KXJLEAGUEGAME", "KXALEAGUEGAME",
  "KXCHNSLGAME", "KXTHAIL1GAME", "KXAFCCLGAME",
  // International
  "KXINTLFRIENDLYGAME", "KXFIFAGAME",
  // Cups
  "KXFACUPGAME", "KXEFLCUPGAME",
  // Women
  "KXEWSLGAME",
  // Spreads & totals (same leagues -- for slug guessing via soccerNameToAbbr)
  "KXEPLSPREAD", "KXEPLTOTAL",
  "KXMLSSPREAD", "KXMLSTOTAL",
  "KXUCLSPREAD", "KXUCLTOTAL",
  "KXUELSPREAD", "KXUELTOTAL",
  "KXLALIGASPREAD", "KXLALIGATOTAL",
  "KXSERIEASPREAD", "KXSERIEATOTAL",
  "KXBUNDESLIGASPREAD", "KXBUNDESLIGATOTAL",
  "KXLIGUE1SPREAD", "KXLIGUE1TOTAL",
  "KXBRASILEIROSPREAD", "KXBRASILEIROTOTAL",
  "KXSAUDIPLSPREAD", "KXSAUDIPLTOTAL",
]);

// Soccer 3-way direction type:
//   A-F: 3-leg YES combos (buy YES on all 3 outcomes across platforms)
//   G-L: 2-leg NO combos (buy NO on one outcome + YES on same outcome on other platform)
type SoccerDir = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";
// Combined direction type for all sports
type ArbDir = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";

// NBA team full name -> 3-letter PM slug abbreviation
// NHL team name -> PM slug abbreviation (3-letter codes used in polymarket slugs)
const NHL_TEAM_ABBRS: Record<string, string> = {
  "anaheim ducks": "ana", "arizona coyotes": "ari", "boston bruins": "bos",
  "buffalo sabres": "buf", "calgary flames": "cal", "carolina hurricanes": "car",
  "chicago blackhawks": "chi", "colorado avalanche": "col", "columbus blue jackets": "cbj",
  "dallas stars": "dal", "detroit red wings": "det", "edmonton oilers": "edm",
  "florida panthers": "fla", "los angeles kings": "lak", "minnesota wild": "min",
  "montreal canadiens": "mon", "nashville predators": "nsh", "new jersey devils": "nj",
  "new york islanders": "nyi", "new york rangers": "nyr", "ottawa senators": "ott",
  "philadelphia flyers": "phi", "pittsburgh penguins": "pit", "san jose sharks": "sj",
  "seattle kraken": "sea", "st. louis blues": "stl", "st louis blues": "stl",
  "tampa bay lightning": "tb", "toronto maple leafs": "tor", "utah hockey club": "utah", "utah mammoth": "utah",
  "vancouver canucks": "van", "vegas golden knights": "las", "washington capitals": "wsh",
  "winnipeg jets": "wpg",
};

const NBA_TEAM_ABBRS: Record<string, string> = {
  "atlanta hawks": "atl", "boston celtics": "bos", "brooklyn nets": "bkn",
  "charlotte hornets": "cha", "chicago bulls": "chi", "cleveland cavaliers": "cle",
  "dallas mavericks": "dal", "denver nuggets": "den", "detroit pistons": "det",
  "golden state warriors": "gsw", "houston rockets": "hou", "indiana pacers": "ind",
  "los angeles clippers": "lac", "los angeles lakers": "lal", "memphis grizzlies": "mem",
  "miami heat": "mia", "milwaukee bucks": "mil", "minnesota timberwolves": "min",
  "new orleans pelicans": "nop", "new york knicks": "nyk", "oklahoma city thunder": "okc",
  "orlando magic": "orl", "philadelphia 76ers": "phi", "phoenix suns": "phx",
  "portland trail blazers": "por", "sacramento kings": "sac", "san antonio spurs": "sas",
  "toronto raptors": "tor", "utah jazz": "uta", "washington wizards": "was",
};

// EPL team name -> 3-letter PM slug abbreviation
// Kalshi uses codes like CFC, WHU, MCI in tickers; PM uses first-3-chars of name like che, wes, mac
// This maps the Kalshi entity name (from title) to PM's 3-char slug code
const SOCCER_TEAM_ABBRS: Record<string, string> = {
  // EPL
  "arsenal": "ars", "aston villa": "ast", "bournemouth": "bou", "brentford": "bre",
  "brighton": "bri", "burnley": "bur", "chelsea": "che", "crystal palace": "cry",
  "everton": "eve", "fulham": "ful", "ipswich": "ips", "leeds": "lee",
  "leicester": "lei", "liverpool": "liv", "luton": "lut", "manchester city": "mac",
  "man city": "mac", "manchester united": "mau", "man united": "mau", "man utd": "mau",
  "newcastle": "new", "nottingham forest": "not", "nottingham": "not",
  "sheffield united": "she", "southampton": "sou", "sunderland": "sun",
  "tottenham": "tot", "west ham": "wes", "wolverhampton": "wol", "wolves": "wol",
  // La Liga
  "atletico madrid": "mad", "atletico": "mad", "real madrid": "rea",
  "real sociedad": "rea", "athletic bilbao": "bil", "athletic": "bil",
  "real betis": "bet", "celta vigo": "cel", "celta": "cel",
  "rayo vallecano": "ray", "deportivo alaves": "ala", "alaves": "ala",
  "espanyol": "esp", "las palmas": "las", "cadiz": "cad",
  // Bundesliga
  "bayern munich": "bay", "bayern": "bay", "borussia dortmund": "dor", "dortmund": "dor",
  "rb leipzig": "lei", "leipzig": "lei", "bayer leverkusen": "b04", "leverkusen": "b04",
  "eintracht frankfurt": "ein", "frankfurt": "ein", "borussia monchengladbach": "mon",
  "sc freiburg": "fre", "freiburg": "fre", "vfb stuttgart": "stu", "stuttgart": "stu",
  "union berlin": "uni", "werder bremen": "wer", "bremen": "wer",
  "hoffenheim": "hof", "wolfsburg": "wol", "augsburg": "aug", "heidenheim": "hei",
  "mainz": "mai", "bochum": "boc", "st pauli": "stp", "hamburg": "hsv",
  "koln": "koe", "cologne": "koe", "gladbach": "moe", "monchengladbach": "moe",
  // Ligue 1
  "monaco": "asm", "as monaco": "asm", "nice": "ogc", "ogc nice": "ogc",
  "psg": "psg", "paris saint-germain": "psg", "paris": "pfc",
  "lyon": "lyo", "olympique lyonnais": "lyo",
  "marseille": "mar", "olympique marseille": "mar",
  "lille": "lil", "lens": "rcl", "rc lens": "rcl",
  "rennes": "ren", "stade rennais": "ren",
  "strasbourg": "str", "rc strasbourg": "str",
  "toulouse": "tou", "nantes": "nan", "montpellier": "mon",
  "lorient": "lor", "le havre": "hac", "metz": "met",
  "stade brest": "sbr", "brest": "sbr", "clermont": "cle",
  "auxerre": "aja", "angers": "ang", "reims": "rei",
  // MLS (first 3 chars works for most)
  "toronto": "tor", "toronto fc": "tor",
  "new york red bulls": "nyr", "ny red bulls": "nyr",
  "philadelphia union": "phi",
  "atlanta united": "atl", "atlanta": "atl",
  "inter miami": "mia",
  "la galaxy": "lag", "los angeles galaxy": "lag",
  "lafc": "laf", "los angeles fc": "laf",
  "seattle sounders": "sea", "portland timbers": "por",
  "nashville sc": "nas", "columbus crew": "col",
  "charlotte fc": "clf", "new york city fc": "nyc",
  "new england revolution": "ner",
  "orlando city": "orl", "chicago fire": "cfc",
  "houston dynamo": "hou", "fc dallas": "dal",
  "sporting kc": "skc", "kansas city": "skc",
  "minnesota united": "min", "austin fc": "aus",
  "real salt lake": "rsl", "colorado rapids": "cor",
  "san jose earthquakes": "sje", "vancouver whitecaps": "van",
  "st louis city": "stl",
  "dc united": "dcu",
};

function soccerNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (SOCCER_TEAM_ABBRS[norm]) return SOCCER_TEAM_ABBRS[norm];
  // Partial match: entity contains or is contained by a known name
  for (const [full, abbr] of Object.entries(SOCCER_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  // Fallback: first 3 chars of name
  return norm.replace(/[^a-z]/g, "").slice(0, 3);
}

// MLB team name -> 3-letter PM slug abbreviation
// Kalshi sub_title uses city names ("Los Angeles D"), PM slug uses standard 3-letter codes
const MLB_TEAM_ABBRS: Record<string, string> = {
  "arizona diamondbacks": "ari", "diamondbacks": "ari", "arizona": "ari",
  "atlanta braves": "atl", "braves": "atl",
  "baltimore orioles": "bal", "orioles": "bal", "baltimore": "bal",
  "boston red sox": "bos", "red sox": "bos",
  "chicago cubs": "chc", "cubs": "chc", "chicago c": "chc",
  "chicago white sox": "cws", "white sox": "cws", "chicago ws": "cws",
  "cincinnati reds": "cin", "reds": "cin", "cincinnati": "cin",
  "cleveland guardians": "cle", "guardians": "cle", "cleveland": "cle",
  "colorado rockies": "col", "rockies": "col", "colorado": "col",
  "detroit tigers": "det", "tigers": "det", "detroit": "det",
  "houston astros": "hou", "astros": "hou",
  "kansas city royals": "kc", "royals": "kc",
  "los angeles angels": "laa", "angels": "laa", "los angeles a": "laa",
  "los angeles dodgers": "lad", "dodgers": "lad", "los angeles d": "lad",
  "miami marlins": "mia", "marlins": "mia",
  "milwaukee brewers": "mil", "brewers": "mil", "milwaukee": "mil",
  "minnesota twins": "min", "twins": "min",
  "new york mets": "nym", "mets": "nym", "new york m": "nym",
  "new york yankees": "nyy", "yankees": "nyy", "new york y": "nyy",
  "oakland athletics": "oak", "athletics": "oak", "oakland": "oak", "a's": "oak",
  "philadelphia phillies": "phi", "phillies": "phi",
  "pittsburgh pirates": "pit", "pirates": "pit", "pittsburgh": "pit",
  "san diego padres": "sd", "padres": "sd", "san diego": "sd",
  "san francisco giants": "sf", "giants": "sf", "san francisco": "sf",
  "seattle mariners": "sea", "mariners": "sea", "seattle": "sea",
  "st. louis cardinals": "stl", "st louis cardinals": "stl", "cardinals": "stl",
  "tampa bay rays": "tb", "rays": "tb", "tampa bay": "tb",
  "texas rangers": "tex", "rangers": "tex", "texas": "tex",
  "toronto blue jays": "tor", "blue jays": "tor",
  "washington nationals": "wsh", "nationals": "wsh",
};

function mlbNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (MLB_TEAM_ABBRS[norm]) return MLB_TEAM_ABBRS[norm];
  for (const [full, abbr] of Object.entries(MLB_TEAM_ABBRS)) {
    const parts = full.split(" ");
    const nickname = parts[parts.length - 1];
    const city = parts.slice(0, -1).join(" ");
    if (norm === nickname || norm === city) return abbr;
  }
  for (const [full, abbr] of Object.entries(MLB_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  return "";
}

function nbaNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  // Full name match ("Utah Jazz" -> "uta")
  if (NBA_TEAM_ABBRS[norm]) return NBA_TEAM_ABBRS[norm];
  // City-only or nickname match ("Sacramento" -> "sac", "Jazz" -> "uta")
  for (const [full, abbr] of Object.entries(NBA_TEAM_ABBRS)) {
    const parts = full.split(" ");
    const nickname = parts[parts.length - 1]; // "kings", "jazz"
    const city = parts.slice(0, -1).join(" "); // "sacramento", "utah"
    if (norm === nickname || norm === city) return abbr;
  }
  // Partial: entity name contains team name or vice versa
  for (const [full, abbr] of Object.entries(NBA_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  return "";
}

function nhlNameToAbbr(entityName: string): string {
  const norm = entityName.toLowerCase().trim().replace(/^the\s+/, "");
  if (NHL_TEAM_ABBRS[norm]) return NHL_TEAM_ABBRS[norm];
  for (const [full, abbr] of Object.entries(NHL_TEAM_ABBRS)) {
    const parts = full.split(" ");
    const nickname = parts[parts.length - 1];
    const city = parts.slice(0, -1).join(" ");
    if (norm === nickname || norm === city) return abbr;
  }
  for (const [full, abbr] of Object.entries(NHL_TEAM_ABBRS)) {
    if (norm.includes(full) || full.includes(norm)) return abbr;
  }
  // Handle Kalshi abbreviated format: "TOR Maple Leafs" -> strip first token, match nickname
  const spaceIdx = norm.indexOf(" ");
  if (spaceIdx > 0 && spaceIdx <= 4) {
    const nicknamePart = norm.slice(spaceIdx + 1); // "maple leafs", "rangers", "blue jackets", etc.
    for (const [full, abbr] of Object.entries(NHL_TEAM_ABBRS)) {
      const parts = full.split(" ");
      // Try matching against nickname portion (everything after city)
      // e.g., "toronto maple leafs" -> city=["toronto"] nick=["maple","leafs"]
      for (let i = 1; i < parts.length; i++) {
        if (nicknamePart === parts.slice(i).join(" ")) return abbr;
      }
    }
  }
  // Handle Kalshi spread abbreviations: "New York R" -> Rangers, "New York I" -> Islanders
  if (norm === "new york r") return "nyr";
  if (norm === "new york i") return "nyi";
  return "";
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function namesMatch(kalName: string, pmOutcome: string): boolean {
  const k = normalizeName(kalName);
  const p = normalizeName(pmOutcome);
  if (!k || !p) return false;
  if (k === p) return true;
  if (p.includes(k) || k.includes(p)) return true;
  const kw = k.split(" "), pw = p.split(" ");
  const [shorter, longer] = kw.length <= pw.length ? [kw, pw] : [pw, kw];
  // Word-token overlap (guards against short noise tokens)
  if (shorter.length === 1 && shorter[0].length >= 4 && shorter.every(w => longer.includes(w))) return true;
  if (shorter.length > 1 && shorter.every(w => longer.includes(w))) return true;
  // Abbreviation fallback: Polymarket esports markets often use abbreviated outcome labels
  // e.g. "SE1" -> strip digits -> "se" -> matches initials of "Sakura Esports"
  //      "WC1" -> strip digits -> "wc" -> is a prefix of "wildcard"
  for (const [full, abbr] of [[k, p], [p, k]] as [string, string][]) {
    const a = abbr.replace(/\d+$/, "").replace(/\s/g, ""); // strip trailing digits and spaces
    if (a.length < 2) continue;
    const words = full.split(" ").filter(w => w.length > 0);
    const initials = words.map(w => w[0]).join("");
    if (initials === a) return true;                          // "se" = initials of "sakura esports"
    if (full.replace(/\s/g, "").startsWith(a)) return true;  // "wildcard" starts with "wc"
  }
  return false;
}

/** Fuzzy name match for international sports where Kalshi and PM use very different team names.
 *  Strips common European prefixes (BC, KK, FK, FC, Saski, etc.) and checks for shared
 *  significant words (>=5 chars). Only safe when scoped to specific series -- NOT for use globally. */
function fuzzyIntlNamesMatch(kalName: string, pmName: string): boolean {
  const k = normalizeName(kalName);
  const p = normalizeName(pmName);
  if (!k || !p) return false;
  // If standard namesMatch already works, defer to it
  if (namesMatch(kalName, pmName)) return true;
  const EURO_PREFIXES = /^(bc|kk|fk|fc|sc|sk|as|ia|saski|real|sporting|instituto|samsung|seoul)\s+/i;
  const kStripped = k.replace(EURO_PREFIXES, "").split(" ").filter(w => w.length >= 4);
  const pStripped = p.replace(EURO_PREFIXES, "").split(" ").filter(w => w.length >= 4);
  if (kStripped.length > 0 && pStripped.length > 0) {
    const shared = kStripped.filter(w => pStripped.some(pw => pw === w || pw.startsWith(w) || w.startsWith(pw)));
    if (shared.length >= 1 && shared[0].length >= 5) return true;
  }
  return false;
}

function parseDateFromEventTitle(title: string): string {
  const m = title.match(/\(\s*(\w{3})\s+(\d{1,2})(?:,?\s*(\d{4}))?\s*\)/);
  if (!m) return "";
  const month = MONTHS[m[1].toUpperCase()];
  if (!month) return "";
  const year = m[3] ?? new Date().getFullYear().toString();
  return `${year}-${month}-${m[2].padStart(2, "0")}`;
}

async function searchPolymarketByNames(
  name1: string, name2: string, gammaBase: string
): Promise<GammaMarket | null> {
  // Helper: accept a market if its two outcomes match both names
  function marketMatchesNames(m: GammaMarket): boolean {
    if (m.closed) return false;
    const outcomes = parseJsonArray(m.outcomes ?? "");
    const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
    if (outcomes.length !== 2 || tokenIds.length < 2) return false;
    return outcomes.some((o: string) => namesMatch(name1, o)) &&
           outcomes.some((o: string) => namesMatch(name2, o));
  }

  // Strategy 1: search events with both names combined
  try {
    const q = encodeURIComponent(`${name1} ${name2}`);
    const raw = await polyFetch<unknown>(`${gammaBase}/events?search=${q}&active=true&limit=10`);
    for (const ev of parseGammaEvents(raw)) {
      for (const m of (ev.markets ?? [])) {
        if (marketMatchesNames(m)) return m;
      }
    }
  } catch { /* fall through */ }

  // Strategy 2: search markets by name1 alone
  try {
    const raw = await polyFetch<unknown>(`${gammaBase}/markets?search=${encodeURIComponent(name1)}&active=true&limit=20`);
    for (const m of parseGammaMarkets(raw)) {
      if (marketMatchesNames(m)) return m;
    }
  } catch { /* ignore */ }

  // Strategy 3: search markets by name2 alone (handles cases where name1 search misses it)
  try {
    const raw = await polyFetch<unknown>(`${gammaBase}/markets?search=${encodeURIComponent(name2)}&active=true&limit=20`);
    for (const m of parseGammaMarkets(raw)) {
      if (marketMatchesNames(m)) return m;
    }
  } catch { /* ignore */ }

  // Strategy 4: search events by name2 alone (catches esports events indexed differently)
  try {
    const raw = await polyFetch<unknown>(`${gammaBase}/events?search=${encodeURIComponent(name2)}&active=true&limit=10`);
    for (const ev of parseGammaEvents(raw)) {
      for (const m of (ev.markets ?? [])) {
        if (marketMatchesNames(m)) return m;
      }
    }
  } catch { /* ignore */ }

  return null;
}

// --- Discovery caching --------------------------------------------------------

const DISCOVERY_CACHE_PATH = "discovery_cache.json";

type DiscoveryCache = {
  date: string;              // "YYYY-MM-DD" -- legacy date check (used when DISCOVERY_CACHE_TTL_MS=0)
  savedAt?: number;          // epoch ms -- used for TTL-based invalidation
  watchlist: WatchEntry[];
  noMatchPairs: string[];    // sorted normalized name pairs that had no PM match
};

function saveDiscoveryCache(watchlist: WatchEntry[], noMatchPairs: string[]): void {
  try {
    const data: DiscoveryCache = {
      date: new Date().toISOString().slice(0, 10),
      savedAt: Date.now(),
      watchlist,
      noMatchPairs,
    };
    atomicWriteFileSync(DISCOVERY_CACHE_PATH, JSON.stringify(data, null, 2));
    console.log(`[DISCOVER] Saved cache: ${watchlist.length} pairs, ${noMatchPairs.length} no-match pairs`);
  } catch (err) {
    console.error(`[DISCOVER] Failed to save cache: ${(err as Error).message}`);
  }
}

function loadDiscoveryCache(): DiscoveryCache | null {
  try {
    if (!fs.existsSync(DISCOVERY_CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(DISCOVERY_CACHE_PATH, "utf8")) as DiscoveryCache;
    // TTL-based invalidation (preferred); falls back to date-based for legacy caches
    if (DISCOVERY_CACHE_TTL_MS > 0 && raw.savedAt) {
      const ageMs = Date.now() - raw.savedAt;
      if (ageMs > DISCOVERY_CACHE_TTL_MS) {
        console.log(`[DISCOVER] Cache expired (age ${Math.round(ageMs / 60000)}min > TTL ${Math.round(DISCOVERY_CACHE_TTL_MS / 60000)}min) -- will re-discover`);
        return null;
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      if (raw.date !== today) {
        console.log(`[DISCOVER] Cache is stale (${raw.date} vs today ${today}) -- will re-discover`);
        return null;
      }
    }
    if (!Array.isArray(raw.watchlist) || !raw.watchlist.length) return null;
    return raw;
  } catch (err) {
    console.error(`[DISCOVER] Failed to load cache: ${(err as Error).message}`);
    return null;
  }
}

// --- Static pairs loader ------------------------------------------------------
// Reads data/static_pairs.csv with columns: kalshi, pm
// Each row has a Kalshi URL and a Polymarket URL.
// Fetches both APIs on startup to build WatchEntry objects.

const STATIC_PAIRS_PATH = path.join("data", "static_pairs.csv");

function parseStaticPairsCsv(): { kalshiUrl: string; pmUrl: string }[] {
  if (!fs.existsSync(STATIC_PAIRS_PATH)) return [];
  const raw = fs.readFileSync(STATIC_PAIRS_PATH, "utf8").trim();
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length < 2) return []; // header only or empty
  // Skip header row
  const pairs: { kalshiUrl: string; pmUrl: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length < 2 || !cols[0] || !cols[1]) continue;
    pairs.push({ kalshiUrl: cols[0], pmUrl: cols[1] });
  }
  return pairs;
}

// Extract Kalshi event ticker from URL.
// URL formats:
//   https://kalshi.com/markets/kxncaambgame/..../kxncaambgame-26jan28uclaore
//   https://kalshi.com/markets/KXNBAPTS/.../KXNBAPTS-26FEB06NOPMIN
// The event ticker is the LAST path segment.
function extractKalshiEventTicker(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
  } catch {
    // Maybe it's just a ticker, not a URL
    return url.trim();
  }
}

// Extract PM slug from URL.
// URL formats:
//   https://polymarket.com/sports/cbb/cbb-soumis-pvam-2025-11-24
//   https://polymarket.com/event/some-slug
// The slug is the LAST path segment.
function extractPmSlug(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
  } catch {
    return url.trim();
  }
}

async function loadStaticPairs(): Promise<WatchEntry[]> {
  const csvPairs = parseStaticPairsCsv();
  if (!csvPairs.length) return [];

  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const entries: WatchEntry[] = [];

  for (const pair of csvPairs) {
    const eventTicker = extractKalshiEventTicker(pair.kalshiUrl);
    const pmSlug = extractPmSlug(pair.pmUrl);
    if (!eventTicker || !pmSlug) {
      console.warn(`[STATIC] SKIP -- missing ticker or slug: kal=${pair.kalshiUrl} pm=${pair.pmUrl}`);
      continue;
    }

    console.log(`[STATIC] Loading: ${eventTicker} ↔ ${pmSlug}`);

    // -- Fetch Kalshi event with nested markets --
    let kalNames: string[] = [], kalAsks: number[] = [], kalNoAsks: number[] = [], kalTickers: string[] = [];
    let kalYesAskSizes: number[] = [], kalNoAskSizes: number[] = [];
    try {
      const evRes = await kalFetch<{ event?: KalshiEvent }>(`${kalBase}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
      const ev = evRes.event ?? evRes as unknown as KalshiEvent;
      const mlist = ev.markets ?? [];
      if (mlist.length !== 2) {
        console.warn(`[STATIC] SKIP -- Kalshi event ${eventTicker} has ${mlist.length} markets (need 2)`);
        continue;
      }
      for (const m of mlist) {
        const name = extractEntityName(pickString(m.title ?? m.subtitle ?? ""));
        const yesAsk = m.yes_ask_dollars !== undefined
          ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
        const noAsk = m.no_ask_dollars !== undefined
          ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
        kalNames.push(name || pickString(m.ticker ?? ""));
        kalAsks.push(yesAsk ?? 0);
        kalNoAsks.push(noAsk ?? 1);
        kalTickers.push(pickString(m.ticker ?? ""));
        kalYesAskSizes.push(Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0);
        kalNoAskSizes.push(Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0);
      }
      if (kalNames.length !== 2 || !kalTickers[0] || !kalTickers[1]) {
        console.warn(`[STATIC] SKIP -- could not parse Kalshi markets for ${eventTicker}`);
        continue;
      }
    } catch (err) {
      console.warn(`[STATIC] SKIP -- Kalshi fetch failed for ${eventTicker}: ${(err as Error).message}`);
      continue;
    }

    // -- Fetch PM market from slug --
    let pmMarket: GammaMarket | null = null;
    try {
      const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(pmSlug)}`);
      const ml = parseGammaMarkets(raw);
      if (ml.length > 0) pmMarket = ml[0];
    } catch (err) { console.warn(`[DISC] PM /markets fetch failed for ${pmSlug}: ${(err as Error).message}`); }
    // Also try /events?slug= if /markets didn't work
    if (!pmMarket) {
      try {
        const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(pmSlug)}`);
        const events = parseGammaEvents(raw);
        if (events.length > 0) {
          const markets = events[0].markets ?? [];
          // Find the moneyline market (2 outcomes)
          for (const m of markets) {
            const oc = parseJsonArray(m.outcomes ?? "");
            if (oc.length === 2) { pmMarket = m; break; }
          }
        }
      } catch (err) { console.warn(`[DISC] PM /events fetch failed for ${pmSlug}: ${(err as Error).message}`); }
    }

    if (!pmMarket) {
      console.warn(`[STATIC] SKIP -- PM market not found for slug: ${pmSlug}`);
      continue;
    }

    const outcomes = parseJsonArray(pmMarket.outcomes ?? "");
    const tokenIds = parseJsonArray(pmMarket.clobTokenIds ?? "");
    if (outcomes.length !== 2 || tokenIds.length < 2) {
      console.warn(`[STATIC] SKIP -- PM ${pmSlug} has ${outcomes.length} outcomes (need 2)`);
      continue;
    }

    const tickSize = Number(pmMarket.orderPriceMinTickSize ?? 0.01);
    const minSize = Number(pmMarket.orderMinSize ?? 1);
    const negRisk = Boolean(pmMarket.negRisk);

    // -- Map Kalshi names to PM outcomes --
    function findPmToken(kalName: string): { outcome: string; tokenId: string } | null {
      for (let i = 0; i < outcomes.length; i++) {
        if (namesMatch(kalName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
      }
      return null;
    }

    let pm1Info = findPmToken(kalNames[0]);
    let pm2Info = findPmToken(kalNames[1]);

    if (!pm1Info || !pm2Info || pm1Info.tokenId === pm2Info.tokenId) {
      console.warn(`[STATIC] SKIP -- outcome mismatch: KAL=[${kalNames[0]}, ${kalNames[1]}] PM=${JSON.stringify(outcomes)}`);
      continue;
    }

    // -- Cross-validate token mapping via CLOB prices --
    // Only swap when name matches were ambiguous -- price divergence is expected for arb opportunities.
    const staticPm1Confident = namesMatch(kalNames[0], pm1Info.outcome);
    const staticPm2Confident = namesMatch(kalNames[1], pm2Info.outcome);
    const staticBothConfident = staticPm1Confident && staticPm2Confident;
    try {
      const [ask1, ask2] = await Promise.all([
        fetchPmAsk(pm1Info.tokenId, clobBase),
        fetchPmAsk(pm2Info.tokenId, clobBase),
      ]);
      if (ask1 !== null && ask2 !== null && kalAsks[0] > 0 && kalAsks[1] > 0) {
        const diff_correct = Math.abs(kalAsks[0] - ask1) + Math.abs(kalAsks[1] - ask2);
        const diff_swapped = Math.abs(kalAsks[0] - ask2) + Math.abs(kalAsks[1] - ask1);
        if (diff_swapped < diff_correct - 0.10) {
          if (staticBothConfident) {
            console.log(`[STATIC] Price divergence for ${pmSlug} -- names confident, NOT swapping`);
          } else {
            console.warn(`[STATIC] TOKEN SWAP DETECTED for ${pmSlug} -- swapping pm1↔pm2`);
            [pm1Info, pm2Info] = [pm2Info, pm1Info];
          }
        }
      }
    } catch {}

    const date = parseDateFromTicker(kalTickers[0]) || "";
    const matchCode = kalTickers[0].includes("-") ? matchCodePrefix(kalTickers[0]) : eventTicker;

    entries.push({
      matchCode, pmSlug, date,
      kal1: { ticker: kalTickers[0], surname: kalNames[0], yesAsk: kalAsks[0], noAsk: kalNoAsks[0], yesAskSize: kalYesAskSizes[0] ?? 0, noAskSize: kalNoAskSizes[0] ?? 0 },
      kal2: { ticker: kalTickers[1], surname: kalNames[1], yesAsk: kalAsks[1], noAsk: kalNoAsks[1], yesAskSize: kalYesAskSizes[1] ?? 0, noAskSize: kalNoAskSizes[1] ?? 0 },
      pm1: { outcome: pm1Info.outcome, tokenId: pm1Info.tokenId, tickSize, minSize, negRisk },
      pm2: { outcome: pm2Info.outcome, tokenId: pm2Info.tokenId, tickSize, minSize, negRisk },
    });
    console.log(`[STATIC] LOADED: ${kalNames[0]} vs ${kalNames[1]} -> ${pmSlug}`);
  }

  return entries;
}

// --- Discovery ----------------------------------------------------------------

type KalEntity = { ticker: string; name: string; yesAsk: number; noAsk: number; yesAskSize?: number; noAskSize?: number };
type KalCandidate = {
  matchCode: string; eventTicker: string; eventTitle: string; date: string;
  e1: KalEntity;
  e2: KalEntity;
  e3?: KalEntity;  // Draw/Tie market (soccer 3-way)
  is3Way?: boolean;
  isBinary?: boolean;           // single-ticker binary (spreads, totals, game totals)
  binarySlugSuffix?: string;    // PM slug suffix to append to moneyline base slug
  binarySlugSuffixAlt?: string; // alt suffix (spreads: try both home/away)
  marketType: string; // "moneyline" | "map_1" | "map_2" | "spread" | "total" | "game_total" | "match_total" | "set_winner"
};

const SPORTS_KEYWORDS = ["sport", "esport", "tennis", "soccer", "basketball", "baseball", "hockey", "football", "golf", "mma", "boxing", "rugby", "cricket", "gaming", "match"];
const POLITICS_BLOCKLIST = ["republican", "democrat", "democratic", "congress", "senate", "house seat", "governor", "president", "election", "primary", "ballot", "mayor", "representative"];
const SKIP_MARKET_KEYWORDS = [
  "handicap", "spread", "cover",
  "total games", "total maps", "total rounds", "total sets",
  "over ", "under ",
  "first blood", "first kill", "first tower", "first baron",
  "+1.5", "-1.5", "+2.5", "-2.5", "+0.5", "-0.5",
  "game-handicap",
];
const NON_MONEYLINE_KEYWORDS = [
  ...SKIP_MARKET_KEYWORDS,
  "game 1", "game 2", "game 3", "game 4", "game 5",
  "game-1", "game-2", "game-3", "game-4", "game-5",
  "map 1", "map 2", "map 3", "map 4", "map 5",
  "map-1", "map-2", "map-3", "map-4", "map-5",
  "round 1", "round 2", "round 3", "round 4", "round 5",
  "round-1", "round-2", "round-3", "round-4", "round-5",
  "set 1", "set 2", "set 3", "set 4", "set 5",
  "set-1", "set-2", "set-3", "set-4", "set-5",
  "game-winner", "map-winner",
];

function detectMapType(allTitles: string): string | null {
  const m = allTitles.match(/\b(?:map|game)\s*(\d+)\b/i);
  return m ? `map_${m[1]}` : null;
}

function isNonMoneyline(slug: string, market?: GammaMarket): boolean {
  const text = [slug, market ? pickString(market.question ?? market.title ?? "") : ""].join(" ").toLowerCase();
  return NON_MONEYLINE_KEYWORDS.some(kw => text.includes(kw));
}

/** Parse team names from non-moneyline event title for namePairKey matching. */
function parseNonMoneylineTeams(title: string, seriesPrefix: string): [string, string] | null {
  // NBA/CBB/NHL/Soccer: "Orlando at Los Angeles L: Spread ..." or "Crystal Palace at Tottenham: Spreads ..."
  // Soccer spread/total series all use the same "Away at Home:" format
  if (seriesPrefix.includes("NBA") || seriesPrefix.includes("NCAAMB") || seriesPrefix.includes("NHL") ||
      seriesPrefix.endsWith("SPREAD") || seriesPrefix.endsWith("TOTAL")) {
    const m = title.match(/^(.+?)\s+at\s+(.+?):/);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  // ATP: "Jack Draper vs Daniil Medvedev: Total Games ..."
  if (seriesPrefix.includes("ATP")) {
    const m = title.match(/^(.+?)\s+vs\s+(.+?):/);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  // CS2/LoL: "League Name: Team1 vs. Team2 Total Maps ..."
  if (seriesPrefix.includes("CS2") || seriesPrefix.includes("LOL")) {
    const afterColon = title.split(": ").slice(1).join(": ");
    const m = afterColon.match(/^(.+?)\s+vs\.?\s+(.+?)\s+Total/i);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  return null;
}

/** Build PM slug suffix(es) from a binary KAL market ticker.
 *  Returns the suffix to append to the moneyline base slug, plus a display label. */
function buildBinarySlugSuffix(
  ticker: string, series: string
): { suffix: string; suffixAlt?: string; type: string; label: string; teamAbbr?: string; lineNum?: string } | null {
  const parts = ticker.split("-");
  const lastPart = parts[parts.length - 1]; // e.g., "LAL8", "233", "3"

  // Spreads: NBA, CBB, NHL, and all soccer leagues (KXEPL, KXMLS, KXUCL, etc.)
  if (series === "KXNBASPREAD" || series === "KXNCAAMBSPREAD" || series === "KXNHLSPREAD" || series.endsWith("SPREAD")) {
    // Ticker suffix: {TEAM_ABBR}{NUMBER} e.g., "LAL8" -> "LAL wins by >8.5"
    const m = lastPart.match(/^([A-Z]+)(\d+)$/i);
    if (!m) return null;
    const lineNum = m[2]; // integer part; actual line = lineNum.5
    const teamAbbr = m[1].toUpperCase();
    // Caller must determine home/away from event title to pick correct suffix.
    // Return both variants + teamAbbr so caller can disambiguate.
    return {
      suffix: `spread-home-${lineNum}pt5`,
      suffixAlt: `spread-away-${lineNum}pt5`,
      type: "spread",
      label: `${teamAbbr} -${lineNum}.5`,
      teamAbbr,
      lineNum,
    };
  }

  // Totals: NBA, NHL, and all soccer leagues
  if (series === "KXNBATOTAL" || series === "KXNHLTOTAL" || series.endsWith("TOTAL")) {
    // Ticker suffix: {NUMBER} e.g., "233" -> PM "total-233pt5"
    if (!/^\d+$/.test(lastPart)) return null;
    return {
      suffix: `total-${lastPart}pt5`,
      type: "total",
      label: `O/U ${lastPart}.5`,
    };
  }

  if (series === "KXATPGAMETOTAL") {
    // Ticker suffix: {NUMBER} e.g., "27" -> PM "match-total-27pt5"
    // ATP games are integers: KAL "over 27" = PM ">27.5"
    if (!/^\d+$/.test(lastPart)) return null;
    return {
      suffix: `match-total-${lastPart}pt5`,
      type: "match_total",
      label: `Match O/U ${lastPart}.5`,
    };
  }

  if (series === "KXCS2TOTALMAPS" || series === "KXLOLTOTALMAPS") {
    // Ticker suffix: {N} e.g., "3" -> "over 2.5 maps" -> PM "total-games-2pt5"
    // Suffix N = minimum count for YES, line = N - 0.5, PM integer part = N - 1
    const count = parseInt(lastPart, 10);
    if (isNaN(count) || count < 2) return null;
    const pmLine = count - 1; // suffix 3 -> 2.5 -> "2pt5"
    return {
      suffix: `total-games-${pmLine}pt5`,
      type: "game_total",
      label: `Maps O/U ${pmLine}.5`,
    };
  }

  return null;
}

/** Phase 1: Scan all open Kalshi events and build candidate list of head-to-head pairs. */
async function fetchKalshiCandidates(kalBase: string): Promise<KalCandidate[]> {
  const candidates: KalCandidate[] = [];
  let cursor = "";

  while (true) {
    const q = new URLSearchParams({ status: "open", limit: "200", with_nested_markets: "true" });
    if (cursor) q.set("cursor", cursor);
    let res: { events?: KalshiEvent[]; cursor?: string; next_cursor?: string };
    try { res = await kalFetch<typeof res>(`${kalBase}/events?${q}`); }
    catch (err) { console.error(`[DISCOVER] Kalshi events error: ${(err as Error).message}`); break; }

    const events = res.events ?? [];
    if (!events.length) break;

    for (const ev of events) {
      const eventTicker = pickString(ev.event_ticker ?? ev.ticker ?? "");
      const eventTitle  = pickString(ev.title ?? ev.name ?? "");
      const mlist = (ev.markets ?? [])
        .filter(m => { const st = pickString(m.status ?? "").toLowerCase(); return !st || st === "active"; });

      const category = pickString(ev.category ?? ev.event_category ?? ev.series_category ?? "").toLowerCase();
      if (category && !SPORTS_KEYWORDS.some(k => category.includes(k))) continue;

      // -- Extract series prefix for non-moneyline branching ---------------
      const evSeriesPrefix = eventTicker.split("-")[0]?.toUpperCase() ?? "";

      // -- Non-moneyline binary series (spreads, totals, game totals) ------
      // These events have MANY markets per event (one per line value).
      // Extract each market as an independent binary candidate.
      if (NON_MONEYLINE_BINARY_SERIES.has(evSeriesPrefix)) {
        const teamNames = parseNonMoneylineTeams(eventTitle, evSeriesPrefix);
        if (!teamNames) {
          console.log(`[DISCOVER] SKIP (cant parse teams for ${evSeriesPrefix}): "${eventTitle}"`);
          continue;
        }

        const sampleTicker = mlist[0] ? pickString(mlist[0].ticker ?? "") : "";
        const date = parseDateFromTicker(sampleTicker) || parseDateFromEventTitle(eventTitle);

        for (const m of mlist) {
          const ticker = pickString(m.ticker ?? "");
          const yesAsk = m.yes_ask_dollars !== undefined
            ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
          if (yesAsk === null) continue;
          const noAsk = m.no_ask_dollars !== undefined
            ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
          const yesAskSz = Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0;
          const noAskSz = Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0;

          const slugInfo = buildBinarySlugSuffix(ticker, evSeriesPrefix);
          if (!slugInfo) continue;

          // For spreads: determine if this ticker's team is home or away so we
          // match the CORRECT PM market (same team, same line).  Kalshi has
          // separate tickers per team (DET1 = "Det >1.5", LAL1 = "LAL >1.5") --
          // matching DET1 to PM "Lakers -1.5" would NOT be an arb because a
          // close game makes both positions lose.
          let finalSuffix = slugInfo.suffix;
          let finalSuffixAlt = slugInfo.suffixAlt;
          if (slugInfo.type === "spread" && slugInfo.teamAbbr) {
            // teamNames = [awayName, homeName] from parseNonMoneylineTeams
            // Kalshi market title: "Away at Home: Spread TEAM wins by over N.5 Points?"
            const mTitle = pickString(m.title ?? m.subtitle ?? "").toLowerCase();
            const awayLower = teamNames[0].toLowerCase();
            const homeLower = teamNames[1].toLowerCase();
            // Check which team name appears after "spread" in the title
            const spreadIdx = mTitle.indexOf("spread");
            const afterSpread = spreadIdx >= 0 ? mTitle.slice(spreadIdx) : mTitle;
            if (afterSpread.includes(homeLower)) {
              // This ticker is about the HOME team -> use spread-home only
              finalSuffix = `spread-home-${slugInfo.lineNum}pt5`;
              finalSuffixAlt = undefined;
            } else if (afterSpread.includes(awayLower)) {
              // This ticker is about the AWAY team -> use spread-away only
              finalSuffix = `spread-away-${slugInfo.lineNum}pt5`;
              finalSuffixAlt = undefined;
            }
            // If neither matches (shouldn't happen), keep both as fallback
          }

          const entity: KalEntity = {
            ticker, name: slugInfo.label, yesAsk, noAsk: noAsk ?? 1,
            yesAskSize: yesAskSz, noAskSize: noAskSz,
          };
          // Use team names as e1.name / e2.name so namePairKey matches moneyline
          // Store the display label in the ticker surname for dashboard display
          candidates.push({
            matchCode: eventTicker, eventTicker, eventTitle, date,
            marketType: slugInfo.type, isBinary: true,
            binarySlugSuffix: finalSuffix,
            binarySlugSuffixAlt: finalSuffixAlt,
            e1: { ...entity, name: teamNames[0] },
            e2: { ...entity, name: teamNames[1] },
          });
        }
        continue;
      }

      // -- Set winner series (KXATPSETWINNER): 2-market events, Set 1 only -
      const isSetWinner = SET_WINNER_SERIES.has(evSeriesPrefix);
      if (isSetWinner) {
        // PM only has "first-set-winner" -- skip Set 2, 3, etc.
        const titleLower = eventTitle.toLowerCase();
        if (!titleLower.includes("set 1") && !eventTicker.endsWith("-1")) continue;
        // Fall through to normal 2-market processing (but skip SKIP_MARKET_KEYWORDS)
      }

      if (mlist.length !== 2 && mlist.length !== 3) continue;

      const names: string[] = [], asks: number[] = [], noAsks: number[] = [], tickers: string[] = [];
      const yesAskSizes: number[] = [], noAskSizes: number[] = [];
      for (const m of mlist) {
        // Prefer yes_sub_title (clean name: "Sacramento", "Tie", "Vacherot")
        // Fall back to title parsing for older/different formats
        const yesSubTitle = pickString(m.yes_sub_title ?? "");
        const name = yesSubTitle || extractEntityName(pickString(m.title ?? m.subtitle ?? ""));
        if (!name) continue;
        const yesAsk = m.yes_ask_dollars !== undefined
          ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
        if (yesAsk === null) continue;
        const noAsk = m.no_ask_dollars !== undefined
          ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
        const yesAskSz = Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0;
        const noAskSz = Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0;
        names.push(name); asks.push(yesAsk); noAsks.push(noAsk ?? 1); tickers.push(pickString(m.ticker ?? ""));
        yesAskSizes.push(yesAskSz); noAskSizes.push(noAskSz);
      }

      // 3-way soccer events: exactly 3 markets (Home, Away, Tie)
      const is3Way = mlist.length === 3 && names.length === 3;
      if (!is3Way && names.length !== 2) continue;
      if (is3Way && names.length !== 3) continue;

      const nameLower = names.join(" ").toLowerCase();
      if (POLITICS_BLOCKLIST.some(kw => nameLower.includes(kw))) continue;

      const allTitles = [eventTitle, ...mlist.map(m => pickString(m.title ?? m.subtitle ?? ""))].join(" ").toLowerCase();
      // Skip non-moneyline keywords -- but NOT for set-winner events (their titles contain "set 1")
      if (!isSetWinner && SKIP_MARKET_KEYWORDS.some(kw => allTitles.includes(kw))) continue;

      const detectedMap = detectMapType(allTitles);
      const marketType = isSetWinner ? "set_winner" : (detectedMap ?? "moneyline");

      if (is3Way) {
        // Soccer 3-way: identify Home, Away, Tie markets
        // Tie market has "tie" or "draw" in the entity name or ticker ends with -TIE
        let homeIdx = -1, awayIdx = -1, tieIdx = -1;
        for (let i = 0; i < 3; i++) {
          const nm = names[i].toLowerCase();
          const tk = tickers[i].toLowerCase();
          if (nm === "tie" || nm === "draw" || tk.endsWith("-tie") || tk.endsWith("-draw")) {
            tieIdx = i;
          }
        }
        if (tieIdx === -1) continue; // can't identify tie market
        // Remaining two are Home and Away (order as listed)
        const teamIdxs = [0, 1, 2].filter(i => i !== tieIdx);
        homeIdx = teamIdxs[0]; awayIdx = teamIdxs[1];

        const priceSum = asks[homeIdx] + asks[awayIdx] + asks[tieIdx];
        if (priceSum < 0.85 || priceSum > 1.30) continue;

        const date = parseDateFromTicker(tickers[0]) || parseDateFromEventTitle(eventTitle);
        const code = tickers[homeIdx].includes("-") ? matchCodePrefix(tickers[homeIdx]) : eventTicker;
        candidates.push({ matchCode: code, eventTicker, eventTitle, date, marketType, is3Way: true,
          e1: { ticker: tickers[homeIdx], name: names[homeIdx], yesAsk: asks[homeIdx], noAsk: noAsks[homeIdx], yesAskSize: yesAskSizes[homeIdx], noAskSize: noAskSizes[homeIdx] },
          e2: { ticker: tickers[awayIdx], name: names[awayIdx], yesAsk: asks[awayIdx], noAsk: noAsks[awayIdx], yesAskSize: yesAskSizes[awayIdx], noAskSize: noAskSizes[awayIdx] },
          e3: { ticker: tickers[tieIdx], name: names[tieIdx], yesAsk: asks[tieIdx], noAsk: noAsks[tieIdx], yesAskSize: yesAskSizes[tieIdx], noAskSize: noAskSizes[tieIdx] } });
      } else {
        const priceSum = asks[0] + asks[1];
        if (priceSum < 0.85 || priceSum > 1.20) continue;

        const date = parseDateFromTicker(tickers[0]) || parseDateFromEventTitle(eventTitle);
        const code = tickers[0].includes("-") ? matchCodePrefix(tickers[0]) : eventTicker;
        candidates.push({ matchCode: code, eventTicker, eventTitle, date, marketType,
          e1: { ticker: tickers[0], name: names[0], yesAsk: asks[0], noAsk: noAsks[0], yesAskSize: yesAskSizes[0], noAskSize: noAskSizes[0] },
          e2: { ticker: tickers[1], name: names[1], yesAsk: asks[1], noAsk: noAsks[1], yesAskSize: yesAskSizes[1], noAskSize: noAskSizes[1] } });
      }
    }

    cursor = pickString(res.next_cursor ?? res.cursor ?? "");
    if (!cursor) break;
  }

  candidates.sort((a, b) => {
    const aML = a.marketType === "moneyline" ? 0 : 1;
    const bML = b.marketType === "moneyline" ? 0 : 1;
    if (aML !== bML) return aML - bML;
    const aKnown = SERIES_TO_PM_PREFIX[(a.e1.ticker.split("-")[0] ?? "").toUpperCase()] ? 0 : 1;
    const bKnown = SERIES_TO_PM_PREFIX[(b.e1.ticker.split("-")[0] ?? "").toUpperCase()] ? 0 : 1;
    return aKnown - bKnown;
  });

  const binaryCount = candidates.filter(c => c.isBinary).length;
  const spreadCount = candidates.filter(c => c.marketType === "spread").length;
  if (binaryCount > 0) {
    console.log(`[DISCOVER] Kalshi candidates: ${candidates.length} total, ${binaryCount} binary (${spreadCount} spreads)`);
  }

  return candidates;
}

/** Phase 2a: Pre-fetch all active PM sports events by tag (bulk fetch, scan locally). */
async function prefetchPmSportsMarkets(gammaBase: string): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  // Fetch multiple sport tags -- Gamma API tag_slug works on /events endpoint
  // Soccer is excluded -- handled by separate soccer scanner command.
  const sportTags = [
    "esports", "nba", "basketball", "baseball", "mlb",
    "dota-2", "valorant", "call-of-duty",        // esports sub-tags (PM splits them)
    "nbl", "cba", "kbl",                          // international basketball (PM uses own tags)
    "march-madness", "ncaa",                       // NCAA basketball (march-madness is subset of ncaa)
    "cwbb",                                        // NCAA women's basketball games
    "tennis",                                      // ATP + WTA match-level events (moneyline, set-winner, totals)
    "nhl",                                         // NHL hockey (match-level events)
    "soccer",                                      // Soccer spreads & totals (EPL, MLS, La Liga, etc.)
    "euroleague",                                  // EuroLeague basketball
  ];
  const seenTokenIds = new Set<string>();
  for (const tag of sportTags) {
    try {
      let offset = 0;
      while (true) {
        const raw = await polyFetch<unknown>(
          `${gammaBase}/events?tag_slug=${tag}&active=true&closed=false&limit=200&offset=${offset}`
        );
        const events = parseGammaEvents(raw);
        if (!events.length) break;
        for (const ev of events) {
          for (const m of (ev.markets ?? [])) {
            if (m.closed) continue;
            const outcomes = parseJsonArray(m.outcomes ?? "");
            const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
            if (outcomes.length !== 2 || tokenIds.length < 2) continue;
            // Deduplicate across tags (soccer may overlap with specific league tags)
            const tid = tokenIds[0];
            if (seenTokenIds.has(tid)) continue;
            seenTokenIds.add(tid);
            m._eventSlug = pickString(ev.slug ?? "");
            markets.push(m);
          }
        }
        if (events.length < 200) break;
        offset += 200;
      }
    } catch (err) {
      console.error(`[DISCOVER] PM ${tag} prefetch failed: ${(err as Error).message}`);
    }
  }
  console.log(`[DISCOVER] PM sports prefetch: ${markets.length} 2-outcome markets (tags: ${sportTags.join(", ")})`);
  return markets;
}

async function discoverWatchlist(): Promise<{ watchlist: WatchEntry[]; noMatchPairs: string[] }> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";

  // -- Phase 1 + 2a: Run in PARALLEL (independent data sources) -------------
  const t0 = performance.now();
  const [candidates, pmEsportsMarkets] = await Promise.all([
    fetchKalshiCandidates(kalBase),
    prefetchPmSportsMarkets(gammaBase),
  ]);
  console.log(`[DISCOVER] Kalshi: ${candidates.length} head-to-head pairs | PM prefetch: ${pmEsportsMarkets.length} markets (${((performance.now() - t0) / 1000).toFixed(1)}s parallel)`);

  // Build event slug index for fast soccer 3-way lookups (Step E) -- avoids re-fetching events from API
  const pmEventIndex = new Map<string, GammaMarket[]>();
  for (const m of pmEsportsMarkets) {
    const evSlug = pickString(m._eventSlug ?? "");
    if (evSlug) {
      let arr = pmEventIndex.get(evSlug);
      if (!arr) { arr = []; pmEventIndex.set(evSlug, arr); }
      arr.push(m);
    }
  }
  console.log(`[DISCOVER] PM event index: ${pmEventIndex.size} events cached`);

  // -- Load slug cache from previous discovery (speeds up re-discovery) -------
  // Even with FORCE_DISCOVER, we can reuse known PM slug mappings from last run
  // to skip expensive slug-guessing API calls. The slug is validated against
  // the prefetch anyway, so stale entries are harmless (just won't match).
  const slugCache = new Map<string, string>(); // namePairKey -> pmSlug
  const noMatchCache = new Set<string>(); // namePairKey known to have no PM match
  try {
    const prevCache = loadDiscoveryCache();
    if (prevCache) {
      for (const entry of prevCache.watchlist) {
        const key = [normalizeName(entry.kal1.surname), normalizeName(entry.kal2.surname)].sort().join("|");
        slugCache.set(key, entry.pmSlug);
      }
      if (!FORCE_DISCOVER) {
        for (const pair of prevCache.noMatchPairs) {
          noMatchCache.add(pair.replace(/:moneyline$/, "")); // strip marketType suffix for lookup
        }
      }
      console.log(`[DISCOVER] Slug cache: ${slugCache.size} known slugs, ${noMatchCache.size} known no-match from previous run`);
    }
  } catch { /* ignore */ }

  // -- Phase 2: For each Kalshi pair, find matching Polymarket market ---------
  const watchlist: WatchEntry[] = [];
  // seenPairs: player pairs already processed (matched or not-found) -- skip duplicates.
  // Key: sorted normalized names joined by "|" + ":" + marketType.
  const seenPairs = new Set<string>();
  const noMatchPairs: string[] = [];
  // matchedSlugs: PM slugs already in the watchlist -- prevents same PM token appearing
  // multiple times when several Kalshi market types (KXLOLMAP, KXLOLGAME) all point
  // to the same PM market, which would create fake arbs.
  const matchedSlugs = new Set<string>();
  // Cache moneyline PM base slugs by player pair, so map_N candidates can derive
  // their PM slug as {baseSlug}-gameN without re-doing the full matching.
  const moneylineBaseSlugs = new Map<string, string>(); // pairKey -> PM base slug

  function esportsSlugToken(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // These series have PM slugs that can't be guessed from team names -- rely on
  // prefetch name-matching (Step C) instead of slug guessing (Step A).
  const OPAQUE_SLUG_SERIES = new Set([
    "KXUCLGAME", "KXUELGAME",                         // UCL/UEL use codes like cfc1, psg1
    "KXJLEAGUEGAME",                                   // J1 uses j1-100- prefix
    "KXCONCACAFCCUPGAME", "KXAFCCLGAME",               // cup competitions with opaque codes
    "KXINTLFRIENDLYGAME", "KXFIFAGAME",                // international matches
    "KXFACUPGAME", "KXEFLCUPGAME",                     // domestic cups
    "KXEWSLGAME",                                       // women's
    // International basketball -- PM slug patterns unknown, rely on name matching
    "KXNBLGAME", "KXCBAGAME", "KXKBLGAME", "KXACBGAME",
    "KXBBLGAME", "KXBSLGAME", "KXVTBGAME", "KXABAGAME",
    "KXEUROLEAGUEGAME", "KXARGLNBGAME", "KXBBSERIEAGAME",
    // College basketball -- PM slug abbreviations are custom, rely on name matching
    "KXNCAAMBGAME", "KXNCAAWBGAME",
  ]);

  for (const cand of candidates) {
    const { e1, e2, marketType } = cand;
    const seriesPrefix = (e1.ticker.split("-")[0] ?? "").toUpperCase();

    // Whitelist: only scan tennis, esports, basketball, baseball, hockey
    const ALLOWED_SERIES = new Set([
      // Tennis
      "KXATPMATCH", "KXWTAMATCH",
      "KXATPCHALLENGERMATCH",     // ATP Challenger tours
      "KXWTACHALLENGERMATCH",     // WTA Challenger / WTA 125
      // Esports
      "KXCS2GAME", "KXCS2MAP", "KXLOLGAME", "KXLOLMAP",
      "KXDOTA2GAME", "KXDOTA2MAP",  // Dota 2 (BO3/BO5 = binary, BO2 = 3-way with TIE -> auto-skipped)
      "KXVALORANTGAME", "KXVALORANTMAP",
      "KXCODGAME", "KXCODMAP",
      // Hockey -- NHL
      "KXNHLGAME",
      // Basketball -- NBA + international leagues
      "KXNBAGAME",
      "KXNBLGAME",          // NBL (Australia)
      "KXCBAGAME",          // CBA (China)
      "KXKBLGAME",          // KBL (South Korea)
      "KXACBGAME",          // ACB (Spain)
      "KXBBLGAME",          // BBL (Germany)
      "KXBSLGAME",          // BSL (Turkey)
      "KXVTBGAME",          // VTB (Russia)
      "KXABAGAME",          // ABA League
      "KXEUROLEAGUEGAME",   // EuroLeague
      "KXARGLNBGAME",       // Argentina Liga Nacional Basketball
      "KXBBSERIEAGAME",     // Italy Serie A Basketball
      // Baseball
      "KXMLBGAME",          // MLB regular season
      "KXMLBSTGAME",        // MLB Spring Training
      // College basketball
      "KXNCAAMBGAME",       // NCAA Men's Basketball
      "KXNCAAWBGAME",       // NCAA Women's Basketball
      // Non-moneyline: spreads, totals, set winners, game totals
      "KXATPSETWINNER",     // ATP Set 1 Winners (2-market events like moneyline)
      "KXNBASPREAD",        // NBA Spreads (single-ticker binary)
      "KXNBATOTAL",         // NBA Totals (single-ticker binary)
      "KXNHLSPREAD",        // NHL Spreads (single-ticker binary)
      "KXNHLTOTAL",         // NHL Totals (single-ticker binary)
      "KXNCAAMBSPREAD",     // CBB Spreads (single-ticker binary)
      "KXATPGAMETOTAL",     // ATP Match Totals (single-ticker binary)
      "KXCS2TOTALMAPS",     // CS2 Total Maps (single-ticker binary)
      "KXLOLTOTALMAPS",     // LoL Total Maps (single-ticker binary)
      // Soccer spreads & totals (no moneyline -- user only wants non-ML)
      "KXEPLSPREAD", "KXEPLTOTAL",
      "KXMLSSPREAD", "KXMLSTOTAL",
      "KXUCLSPREAD", "KXUCLTOTAL",
      "KXUELSPREAD", "KXUELTOTAL",
      "KXLALIGASPREAD", "KXLALIGATOTAL",
      "KXSERIEASPREAD", "KXSERIEATOTAL",
      "KXBUNDESLIGASPREAD", "KXBUNDESLIGATOTAL",
      "KXLIGUE1SPREAD", "KXLIGUE1TOTAL",
      "KXBRASILEIROSPREAD", "KXBRASILEIROTOTAL",
      "KXSAUDIPLSPREAD", "KXSAUDIPLTOTAL",
    ]);
    if (seriesPrefix && !ALLOWED_SERIES.has(seriesPrefix)) continue;

    // Skip if we already processed this player pair + type (either found or not found).
    // Kalshi sometimes lists the same match in multiple event structures.
    const namePairKey = [normalizeName(e1.name), normalizeName(e2.name)].sort().join("|");
    const pairKey = `${namePairKey}:${marketType}`;
    if (seenPairs.has(pairKey)) continue;
    const pmPrefix = SERIES_TO_PM_PREFIX[seriesPrefix] ?? "";

    let pmMarket: GammaMarket | null = null, pmSlug = "";

    // Step C (FIRST -- free, no API calls): scan pre-fetched sports markets by name matching
    if (pmEsportsMarkets.length > 0) {
      for (const m of pmEsportsMarkets) {
        const mSlug = pickString(m.slug ?? m._eventSlug ?? "");
        if (isNonMoneyline(mSlug, m)) continue;
        // Sport-prefix filter: only scan PM markets whose slug starts with the expected prefix.
        // Prevents cross-sport false matches (e.g. CS2 Kalshi pair matching a LoL PM market).
        if (pmPrefix && mSlug && !mSlug.startsWith(pmPrefix + "-")) continue;
        const outcomes = parseJsonArray(m.outcomes ?? "");
        const mTitle = pickString(m.question ?? m.title ?? "").toLowerCase();
        const isCBB = CBB_SERIES.has(seriesPrefix);
        const FUZZY_INTL_SERIES = new Set(["KXEUROLEAGUEGAME", "KXKBLGAME", "KXARGLNBGAME", "KXBBSERIEAGAME", "KXACBGAME", "KXNBLGAME"]);
        const isFuzzyIntl = FUZZY_INTL_SERIES.has(seriesPrefix);
        const nm = isCBB ? cbbNamesMatch : isFuzzyIntl ? fuzzyIntlNamesMatch : namesMatch;
        // Require each player to match a DIFFERENT outcome (prevents "Daniel" matching both)
        const e1Matches = outcomes.filter((o: string) => nm(e1.name, o));
        const e2Matches = outcomes.filter((o: string) => nm(e2.name, o));
        const matchByOutcomes = e1Matches.length > 0 && e2Matches.length > 0 &&
            !(e1Matches.length === 1 && e2Matches.length === 1 && e1Matches[0] === e2Matches[0]);
        const matchByTitle = mTitle.includes(normalizeName(e1.name)) && mTitle.includes(normalizeName(e2.name));
        // CBB alias expansion for title matching (e.g., "UConn" -> "connecticut" ⊂ title)
        const matchByTitleCBB = isCBB && !matchByTitle &&
            mTitle.includes(cbbExpandName(e1.name)) && mTitle.includes(cbbExpandName(e2.name));
        if (matchByOutcomes || matchByTitle || matchByTitleCBB) {
          pmMarket = m;
          pmSlug = mSlug;
          break;
        }
      }
    }

    // Step A0: try cached slug from previous discovery (free, no API call)
    if (!pmMarket && slugCache.has(namePairKey)) {
      const cachedSlug = slugCache.get(namePairKey)!;
      // Look up the cached slug in the prefetch data (validate it still exists)
      for (const m of pmEsportsMarkets) {
        const mSlug = pickString(m.slug ?? m._eventSlug ?? "");
        if (mSlug === cachedSlug || pickString(m._eventSlug ?? "") === cachedSlug) {
          pmMarket = m;
          pmSlug = cachedSlug;
          break;
        }
      }
      // If not in prefetch, try fetching directly (one API call vs many slug guesses)
      if (!pmMarket) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(cachedSlug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && ml[0].active && !ml[0].closed && ml[0].clobTokenIds) {
            pmMarket = ml[0]; pmSlug = cachedSlug;
          }
        } catch { /* skip */ }
      }
      if (!pmMarket) {
        // Also try as event slug
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(cachedSlug)}`);
          for (const ev of parseGammaEvents(raw)) {
            for (const m of (ev.markets ?? [])) {
              if (m.closed) continue;
              const outcomes = parseJsonArray(m.outcomes ?? "");
              const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
              if (outcomes.length !== 2 || tokenIds.length < 2) continue;
              pmMarket = m;
              pmMarket._eventSlug = pickString(ev.slug ?? cachedSlug);
              pmSlug = pickString(m.slug ?? cachedSlug);
              break;
            }
            if (pmMarket) break;
          }
        } catch { /* skip */ }
      }
    }

    // Skip early if this pair was already known to have no PM match (saves all API calls)
    if (!pmMarket && noMatchCache.has(namePairKey) && marketType === "moneyline") {
      // Still mark as processed but don't waste API calls
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    // -- Outcome verification helper -------------------------------------------
    // After slug/event lookup (Steps A/B/D), verify that at least one PM outcome
    // matches at least one Kalshi entity name.  Without this, a slug guess that
    // happens to return a valid but WRONG market is silently accepted -- causing
    // cross-match trades (e.g. CS2 pair matched to a LoL market with NaVi).
    function outcomesSanityCheck(market: GammaMarket | null): boolean {
      if (!market) return false;
      const oc = parseJsonArray(market.outcomes ?? "");
      if (oc.length < 2) return false;
      const any1 = oc.some((o: string) => namesMatch(e1.name, o));
      const any2 = oc.some((o: string) => namesMatch(e2.name, o));
      return any1 && any2;  // BOTH players must match an outcome (prevents cross-match trades)
    }

    // Step A: slug guessing (API calls -- only if prefetch + cache didn't match)
    if (!pmMarket && pmPrefix && cand.date && !OPAQUE_SLUG_SERIES.has(seriesPrefix)) {
      const isTennis = TENNIS_SERIES.has(seriesPrefix);
      let slugVariants: string[];
      if (isTennis) {
        const t1 = pmSlugToken(e1.name), t2 = pmSlugToken(e2.name);
        slugVariants = [
          `${pmPrefix}-${t1}-${t2}-${cand.date}`,
          `${pmPrefix}-${t2}-${t1}-${cand.date}`,
          `${pmPrefix}-${t1.slice(0,6)}-${t2.slice(0,6)}-${cand.date}`,
          `${pmPrefix}-${t2.slice(0,6)}-${t1.slice(0,6)}-${cand.date}`,
        ];
      } else if (NBA_SERIES.has(seriesPrefix)) {
        const a1 = nbaNameToAbbr(e1.name), a2 = nbaNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else if (NHL_SERIES.has(seriesPrefix)) {
        const a1 = nhlNameToAbbr(e1.name), a2 = nhlNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else if (MLB_SERIES.has(seriesPrefix)) {
        const a1 = mlbNameToAbbr(e1.name), a2 = mlbNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else if (SOCCER_SERIES.has(seriesPrefix)) {
        const a1 = soccerNameToAbbr(e1.name), a2 = soccerNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else {
        // Esports: try full team names, last-word only, and short variants
        const f1 = esportsSlugToken(e1.name), f2 = esportsSlugToken(e2.name);
        const l1 = (e1.name.split(/\s+/).pop() ?? e1.name).toLowerCase();
        const l2 = (e2.name.split(/\s+/).pop() ?? e2.name).toLowerCase();
        slugVariants = [
          `${pmPrefix}-${f1}-${f2}-${cand.date}`,
          `${pmPrefix}-${f2}-${f1}-${cand.date}`,
          `${pmPrefix}-${l1}-${l2}-${cand.date}`,
          `${pmPrefix}-${l2}-${l1}-${cand.date}`,
          `${pmPrefix}-${f1}-${f2}`,
          `${pmPrefix}-${f2}-${f1}`,
        ];
      }
      for (const slug of [...new Set(slugVariants)]) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && ml[0].active && !ml[0].closed && ml[0].clobTokenIds && !isNonMoneyline(slug, ml[0])) {
            if (outcomesSanityCheck(ml[0])) {
              pmMarket = ml[0]; pmSlug = slug; break;
            }
          }
        } catch { /* skip */ }
        // Also try as event slug -- esports often have event-level slugs
        if (!pmMarket) {
          try {
            const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(slug)}`);
            for (const ev of parseGammaEvents(raw)) {
              for (const m of (ev.markets ?? [])) {
                if (m.closed) continue;
                const outcomes = parseJsonArray(m.outcomes ?? "");
                const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
                if (outcomes.length !== 2 || tokenIds.length < 2) continue;
                const mSlug = pickString(m.slug ?? slug);
                if (isNonMoneyline(mSlug, m)) continue;
                if (!outcomesSanityCheck(m)) continue;
                pmMarket = m;
                pmMarket._eventSlug = pickString(ev.slug ?? slug);
                pmSlug = mSlug;
                break;
              }
              if (pmMarket) break;
            }
          } catch { /* skip */ }
        }
        if (pmMarket) break;
      }
    }

    // Step B: generic slug guessing for unknown series (esports, UFC, darts, etc.)
    // Polymarket esports slugs typically follow "{team1}-vs-{team2}" at the EVENT level.
    // We try both /markets?slug= and /events?slug= since Polymarket has both hierarchies.
    // IMPORTANT: Skip Step B when pmPrefix is known -- Step A already tried sport-prefixed
    // slug variants.  Generic (unprefixed) slugs risk cross-sport false matches because
    // the same org can compete in multiple games (e.g. TNC in CS2 and MLBB).
    if (!pmMarket && !pmPrefix) {
      const s1 = esportsSlugToken(e1.name), s2 = esportsSlugToken(e2.name);
      const genericSlugs = [...new Set([
        `${s1}-vs-${s2}`,
        `${s2}-vs-${s1}`,
        ...(cand.date ? [
          `${s1}-vs-${s2}-${cand.date}`,
          `${s2}-vs-${s1}-${cand.date}`,
        ] : []),
      ])];
      for (const slug of genericSlugs) {
        if (pmMarket) break;
        // Try market-level slug first
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && !ml[0].closed && ml[0].clobTokenIds && !isNonMoneyline(slug, ml[0])) {
            if (outcomesSanityCheck(ml[0])) {
              pmMarket = ml[0]; pmSlug = slug; break;
            }
          }
        } catch { /* skip */ }
        // Then try event-level slug and pick the first valid 2-outcome market inside it
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(slug)}`);
          for (const ev of parseGammaEvents(raw)) {
            for (const m of (ev.markets ?? [])) {
              if (m.closed) continue;
              const outcomes = parseJsonArray(m.outcomes ?? "");
              const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
              if (outcomes.length !== 2 || tokenIds.length < 2) continue;
              const mSlug = pickString(m.slug ?? slug);
              if (isNonMoneyline(mSlug, m)) continue;
              if (!outcomesSanityCheck(m)) continue;
              pmMarket = m;
              pmMarket._eventSlug = pickString(ev.slug ?? slug);
              pmSlug = mSlug; break;
            }
            if (pmMarket) break;
          }
        } catch { /* skip */ }
      }
    }

    // Step D: search API fallback (last resort -- mostly broken)
    // Skip for known series (they should be caught by prefetch or slug guess).
    // Only use for completely unknown series as a last-ditch effort.
    if (!pmMarket && !pmPrefix && !OPAQUE_SLUG_SERIES.has(seriesPrefix)) {
      const candidate = await searchPolymarketByNames(e1.name, e2.name, gammaBase);
      if (candidate) {
        const cSlug = pickString(candidate.slug ?? candidate.marketSlug ?? "");
        if (!isNonMoneyline(cSlug, candidate)) {
          pmMarket = candidate;
          pmSlug = cSlug;
        }
      }
    }

    // -- Type-aware PM resolution ----------------------------------------------
    // Steps A-D above find the MONEYLINE PM market (they filter isNonMoneyline).
    // For non-moneyline Kalshi candidates, we derive the PM slug from the cached
    // moneyline base slug or the just-found market's event slug.

    if (cand.isBinary) {
      // -- Binary (spreads, totals, game totals): derive PM slug from base slug + suffix --
      let baseSlug = moneylineBaseSlugs.get(namePairKey) ?? "";
      // NHL spread/total names ("Toronto") differ from moneyline names ("TOR Maple Leafs")
      // -- try abbreviation-based alias key
      if (!baseSlug && seriesPrefix.includes("NHL")) {
        const a1 = nhlNameToAbbr(e1.name), a2 = nhlNameToAbbr(e2.name);
        if (a1 && a2) {
          const abbrKey = [a1, a2].sort().join("|");
          baseSlug = moneylineBaseSlugs.get(abbrKey) ?? "";
        }
      }
      if (!baseSlug && pmMarket) {
        baseSlug = pickString(pmMarket._eventSlug ?? pmSlug);
      }
      if (!baseSlug) {
        // Binary needs moneyline base slug -- skip if not available
        console.log(`[DISCOVER] SKIP (no base slug for binary ${marketType}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      // Try primary slug suffix, then alt (for spreads: home/away)
      const suffixes = [cand.binarySlugSuffix!, ...(cand.binarySlugSuffixAlt ? [cand.binarySlugSuffixAlt] : [])];
      let found = false;
      for (const sfx of suffixes) {
        const slug = `${baseSlug}-${sfx}`;
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && !ml[0].closed && ml[0].clobTokenIds) {
            pmMarket = ml[0]; pmSlug = slug; found = true;
            console.log(`[DISCOVER] Resolved binary ${marketType} -> PM slug: ${slug}`);
            break;
          }
        } catch { /* skip */ }
      }
      if (!found) {
        console.log(`[DISCOVER] SKIP (binary PM slug not found, tried: ${suffixes.map(s => `${baseSlug}-${s}`).join(", ")}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

    } else if (marketType === "set_winner") {
      // -- Set winner: derive PM slug from base slug + first-set-winner-{P1}-vs-{P2} --
      let baseSlug = moneylineBaseSlugs.get(namePairKey) ?? "";
      if (!baseSlug && pmMarket) {
        baseSlug = pickString(pmMarket._eventSlug ?? pmSlug);
      }
      // Guard: if baseSlug already contains a set-winner suffix (e.g. PM search returned the
      // set-winner market itself rather than moneyline), strip it to avoid double-suffix.
      baseSlug = baseSlug.replace(/-first-set-winner-.+$/, "");
      if (!baseSlug) {
        console.log(`[DISCOVER] NOT FOUND (no base slug for set_winner): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      // PM uses last-name-only tokens, try both orders, both lowercase and capitalized
      const lastN1 = e1.name.split(/\s+/).pop() ?? e1.name;
      const lastN2 = e2.name.split(/\s+/).pop() ?? e2.name;
      const slugVariants = [
        // Capitalized (PM often uses "Dietrich-vs-Glinka")
        `${baseSlug}-first-set-winner-${lastN1}-vs-${lastN2}`,
        `${baseSlug}-first-set-winner-${lastN2}-vs-${lastN1}`,
        // Lowercase
        `${baseSlug}-first-set-winner-${lastN1.toLowerCase()}-vs-${lastN2.toLowerCase()}`,
        `${baseSlug}-first-set-winner-${lastN2.toLowerCase()}-vs-${lastN1.toLowerCase()}`,
      ];
      let found = false;
      for (const slug of [...new Set(slugVariants)]) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && !ml[0].closed && ml[0].clobTokenIds) {
            pmMarket = ml[0]; pmSlug = slug; found = true;
            console.log(`[DISCOVER] Resolved set_winner -> PM slug: ${slug}`);
            break;
          }
        } catch { /* skip */ }
      }
      if (!found) {
        console.log(`[DISCOVER] NOT FOUND (set_winner PM slug): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

    } else if (marketType !== "moneyline") {
      // -- Map N: derive PM slug from moneyline base slug --
      const mapNum = marketType.replace("map_", ""); // "1", "2", etc.
      let baseSlug = moneylineBaseSlugs.get(namePairKey) ?? "";

      if (!baseSlug && pmMarket) {
        baseSlug = pickString(pmMarket._eventSlug ?? pmSlug);
      }

      if (!baseSlug) {
        console.log(`[DISCOVER] NOT FOUND (no base slug for ${marketType}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      const mapSlug = `${baseSlug}-game${mapNum}`;
      try {
        const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(mapSlug)}`);
        const ml = parseGammaMarkets(raw);
        if (ml.length && !ml[0].closed && ml[0].clobTokenIds) {
          pmMarket = ml[0]; pmSlug = mapSlug;
          console.log(`[DISCOVER] Resolved ${marketType} -> PM slug: ${mapSlug}`);
        } else {
          console.log(`[DISCOVER] NOT FOUND (PM ${mapSlug} doesn't exist): ${e1.name} vs ${e2.name}`);
          seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
        }
      } catch {
        console.log(`[DISCOVER] NOT FOUND (PM ${mapSlug} fetch failed): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
    } else {
      // -- Moneyline: validate PM market is actually moneyline --
      if (!pmMarket || !pmSlug) {
        console.log(`[DISCOVER] NOT FOUND on PM: ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      const pmSportsType = pickString(pmMarket.sportsMarketType ?? "").toLowerCase();
      if (pmSportsType && pmSportsType !== "moneyline") {
        console.log(`[DISCOVER] SKIP (PM sportsMarketType=${pmSportsType}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      const pmCheckText = [pmSlug, pickString(pmMarket.question ?? pmMarket.title ?? "")].join(" ").toLowerCase();
      if (NON_MONEYLINE_KEYWORDS.some(kw => pmCheckText.includes(kw))) {
        console.log(`[DISCOVER] SKIP (non-moneyline PM: ${pmSlug}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      // Cache moneyline base slug for map_N / binary / set_winner candidates to use
      moneylineBaseSlugs.set(namePairKey, pmSlug);
      // NHL moneyline names ("TOR Maple Leafs") differ from spread/total names ("Toronto").
      // Store an abbreviation-based alias so binary candidates can find the base slug.
      if (seriesPrefix === "KXNHLGAME") {
        const a1 = nhlNameToAbbr(e1.name), a2 = nhlNameToAbbr(e2.name);
        if (a1 && a2) {
          const abbrKey = [a1, a2].sort().join("|");
          moneylineBaseSlugs.set(abbrKey, pmSlug);
        }
      }
    }

    // Bug 3 fix: if this PM slug is already in the watchlist (another Kalshi market type
    // matched to the same PM market), skip -- prevents same PM token from being traded
    // from multiple Kalshi angles (e.g. KXLOLMAP + KXLOLGAME both -> same handicap slug).
    if (matchedSlugs.has(pmSlug)) {
      console.log(`[DISCOVER] SKIP (dup PM slug ${pmSlug}): ${e1.name} vs ${e2.name}`);
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    // -- Binary (non-moneyline) WatchEntry creation -------------------------
    // For binary candidates (spreads, totals, game totals): kal1=kal2=same ticker,
    // pm1=first outcome token, pm2=second outcome token.
    // Only dirs A (KAL YES + PM2) and C (KAL NO + PM1) produce valid arbs.
    if (cand.isBinary) {
      if (!pmMarket) { seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue; }
      const outcomes = parseJsonArray(pmMarket.outcomes ?? "");
      const tokenIds = parseJsonArray(pmMarket.clobTokenIds ?? "");
      if (outcomes.length !== 2 || tokenIds.length < 2) {
        console.log(`[DISCOVER] SKIP (binary ${outcomes.length} outcomes): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      const tickSize = Number(pmMarket.orderPriceMinTickSize ?? 0.01);
      const minSize  = Number(pmMarket.orderMinSize ?? 1);
      const negRisk  = Boolean(pmMarket.negRisk);

      // For binary markets: kal1 = kal2 = same Kalshi market
      // pm1 = first PM outcome (Over / team covers), pm2 = second PM outcome (Under / opp team)
      // KAL YES and PM outcome[0] must track the SAME underlying proposition.
      // SAFETY CHECK for spreads: verify PM outcome[0] matches the KAL ticker's team.
      // If mismatched (e.g. DET1 matched to "Lakers -1.5"), it's NOT an arb.
      if (marketType === "spread") {
        const pmQuestion = pickString(pmMarket.question ?? pmMarket.title ?? "").toLowerCase();
        const kalLabel = cand.e1.ticker.split("-").pop() ?? "";
        const kalTeamAbbr = kalLabel.replace(/\d+$/, "").toUpperCase();
        const pmOutcome0 = outcomes[0].toLowerCase();
        // Check: does PM outcome[0] or question reference the KAL ticker's team?
        // Use sport-specific name-to-abbr, otherwise substring match
        const pmAbbr = (nbaNameToAbbr(outcomes[0]) || nhlNameToAbbr(outcomes[0]) || soccerNameToAbbr(outcomes[0])).toUpperCase();
        const teamMatch = pmAbbr === kalTeamAbbr ||
          pmOutcome0.startsWith(kalTeamAbbr.toLowerCase()) ||
          kalTeamAbbr.length >= 3 && pmOutcome0.includes(kalTeamAbbr.toLowerCase());
        if (!teamMatch) {
          console.log(`[DISCOVER] SKIP (spread team mismatch: KAL=${kalTeamAbbr} PM_outcome0=${outcomes[0]}): ${pmSlug}`);
          seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
        }
      }
      const kalEntity = cand.e1; // same ticker as e2 (cloned)
      // e1.name/e2.name were overridden to teamNames -- use them for display surnames
      // so match shows "Detroit vs Los Angeles L" instead of duplicate team names
      const surname1 = cand.e1.name;
      const surname2 = cand.e2.name;
      seenPairs.add(pairKey);
      matchedSlugs.add(pmSlug);
      watchlist.push({
        matchCode: cand.matchCode, pmSlug, date: cand.date, isBinary: true,
        kal1: { ticker: kalEntity.ticker, surname: surname1, yesAsk: kalEntity.yesAsk, noAsk: kalEntity.noAsk, yesAskSize: kalEntity.yesAskSize ?? 0, noAskSize: kalEntity.noAskSize ?? 0 },
        kal2: { ticker: kalEntity.ticker, surname: surname2, yesAsk: kalEntity.yesAsk, noAsk: kalEntity.noAsk, yesAskSize: kalEntity.yesAskSize ?? 0, noAskSize: kalEntity.noAskSize ?? 0 },
        pm1: { outcome: outcomes[0], tokenId: tokenIds[0], tickSize, minSize, negRisk },
        pm2: { outcome: outcomes[1], tokenId: tokenIds[1], tickSize, minSize, negRisk },
      });
      console.log(`[DISCOVER] MATCHED BINARY [${seriesPrefix}] ${marketType}: ${surname1} vs ${surname2} -> ${pmSlug} (${outcomes[0]}/${outcomes[1]})`);
      continue;
    }

    // -- Step E: Soccer 3-way discovery --------------------------------------
    // For 3-way candidates, we need to find 3 separate PM binary markets
    // inside the PM event (home-win, draw, away-win).
    if (cand.is3Way && cand.e3) {
      // Get PM event sub-markets -- try prefetch cache first (free), then API fallback
      const eventSlug = (pmMarket as any)?._eventSlug ?? pmSlug;
      let pmEventMarkets: GammaMarket[] = pmEventIndex.get(eventSlug) ?? [];
      // Prefetch only stores 2-outcome markets; for 3-way we need all sub-markets from the event
      // If we got some from cache, great. If not enough, fetch from API.
      if (pmEventMarkets.length < 3) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(eventSlug)}`);
          for (const ev of parseGammaEvents(raw)) {
            pmEventMarkets = (ev.markets ?? []).filter(m => !m.closed);
          }
        } catch { /* skip */ }
      }
      if (pmEventMarkets.length < 3) {
        console.log(`[DISCOVER] SKIP (3-way PM event has ${pmEventMarkets.length} markets): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      // Match each PM sub-market to: Home team, Away team, Draw
      // Use slug SUFFIX (last segment after date) to avoid false matches -- the event base
      // slug contains both team abbreviations (e.g. epl-tot-not-2026-03-22), so .includes()
      // would match both teams on every sub-market.
      let pmHome: GammaMarket | null = null, pmAway: GammaMarket | null = null, pmDraw: GammaMarket | null = null;
      const a1 = soccerNameToAbbr(e1.name), a2 = soccerNameToAbbr(e2.name);
      for (const m of pmEventMarkets) {
        const mSlug = pickString(m.slug ?? "").toLowerCase();
        const mTitle = pickString(m.question ?? m.title ?? "").toLowerCase();
        const outcomes = parseJsonArray(m.outcomes ?? "");
        if (outcomes.length !== 2) continue; // each sub-market is binary YES/NO
        // Extract slug suffix: last segment after the date (e.g. "tot" from "epl-tot-not-2026-03-22-tot")
        const slugSuffix = mSlug.split("-").pop() ?? "";
        if (mSlug.endsWith("-draw") || slugSuffix === "draw" || mTitle.includes("draw") || mTitle.includes("tie")) {
          pmDraw = m;
        } else if (namesMatch(e1.name, mTitle) || slugSuffix === a1) {
          pmHome = m;
        } else if (namesMatch(e2.name, mTitle) || slugSuffix === a2) {
          pmAway = m;
        }
      }
      if (!pmHome || !pmAway || !pmDraw) {
        console.log(`[DISCOVER] SKIP (3-way PM can't map all 3: home=${!!pmHome} away=${!!pmAway} draw=${!!pmDraw}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      // Extract YES tokenId from each binary sub-market (index 0 = YES)
      const extractYesToken = (m: GammaMarket): { outcome: string; tokenId: string; noTokenId: string; tickSize: number; minSize: number; negRisk: boolean } | null => {
        const outcomes = parseJsonArray(m.outcomes ?? "");
        const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
        if (outcomes.length < 2 || tokenIds.length < 2) return null;
        // YES token is typically index 0, but verify by checking outcome label
        const yesIdx = outcomes.findIndex((o: string) => o.toLowerCase() === "yes");
        const idx = yesIdx >= 0 ? yesIdx : 0;
        const noIdx = idx === 0 ? 1 : 0;
        return {
          outcome: pickString(m.question ?? m.title ?? outcomes[idx]),
          tokenId: tokenIds[idx],
          noTokenId: tokenIds[noIdx],
          tickSize: Number(m.orderPriceMinTickSize ?? 0.01),
          minSize: Number(m.orderMinSize ?? 1),
          negRisk: Boolean(m.negRisk),
        };
      };
      const pm1Token = extractYesToken(pmHome);
      const pm2Token = extractYesToken(pmAway);
      const pm3Token = extractYesToken(pmDraw);
      if (!pm1Token || !pm2Token || !pm3Token) {
        console.log(`[DISCOVER] SKIP (3-way PM token extraction failed): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      seenPairs.add(pairKey);
      matchedSlugs.add(pmSlug);
      watchlist.push({
        matchCode: cand.matchCode, pmSlug, date: cand.date, is3Way: true,
        kal1: { ticker: e1.ticker, surname: e1.name, yesAsk: e1.yesAsk, noAsk: e1.noAsk, yesAskSize: e1.yesAskSize ?? 0, noAskSize: e1.noAskSize ?? 0 },
        kal2: { ticker: e2.ticker, surname: e2.name, yesAsk: e2.yesAsk, noAsk: e2.noAsk, yesAskSize: e2.yesAskSize ?? 0, noAskSize: e2.noAskSize ?? 0 },
        kal3: { ticker: cand.e3.ticker, surname: cand.e3.name, yesAsk: cand.e3.yesAsk, noAsk: cand.e3.noAsk, yesAskSize: cand.e3.yesAskSize ?? 0, noAskSize: cand.e3.noAskSize ?? 0 },
        pm1: { outcome: pm1Token.outcome, tokenId: pm1Token.tokenId, noTokenId: pm1Token.noTokenId, tickSize: pm1Token.tickSize, minSize: pm1Token.minSize, negRisk: pm1Token.negRisk },
        pm2: { outcome: pm2Token.outcome, tokenId: pm2Token.tokenId, noTokenId: pm2Token.noTokenId, tickSize: pm2Token.tickSize, minSize: pm2Token.minSize, negRisk: pm2Token.negRisk },
        pm3: { outcome: pm3Token.outcome, tokenId: pm3Token.tokenId, noTokenId: pm3Token.noTokenId, tickSize: pm3Token.tickSize, minSize: pm3Token.minSize, negRisk: pm3Token.negRisk },
      });
      console.log(`[DISCOVER] MATCHED 3-WAY [${seriesPrefix}]: ${e1.name} vs ${e2.name} (draw) -> ${pmSlug}`);
      continue;
    }

    // Step E: outcome mapping (2-way tennis/NBA/esports/set-winners)
    if (!pmMarket) { seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue; }
    const outcomes = parseJsonArray(pmMarket.outcomes ?? "");
    const tokenIds = parseJsonArray(pmMarket.clobTokenIds ?? "");
    if (outcomes.length !== 2 || tokenIds.length < 2) {
      console.log(`[DISCOVER] SKIP (${outcomes.length} outcomes): ${e1.name} vs ${e2.name}`);
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    const tickSize = Number(pmMarket.orderPriceMinTickSize ?? 0.01);
    const minSize  = Number(pmMarket.orderMinSize ?? 1);
    const negRisk  = Boolean(pmMarket.negRisk);

    function findToken(entityName: string): { outcome: string; tokenId: string } | null {
      for (let i = 0; i < outcomes.length; i++)
        if (namesMatch(entityName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
      // NBA fallback: Kalshi uses city names ("Sacramento"), PM uses nicknames ("Kings")
      // Try matching via NBA_TEAM_ABBRS (both map to the same 3-letter code)
      if (NBA_SERIES.has(seriesPrefix)) {
        const entityAbbr = nbaNameToAbbr(entityName);
        if (entityAbbr) {
          for (let i = 0; i < outcomes.length; i++) {
            if (nbaNameToAbbr(outcomes[i]) === entityAbbr) return { outcome: outcomes[i], tokenId: tokenIds[i] };
          }
        }
      }
      // MLB fallback: Kalshi uses city names ("Los Angeles D"), PM uses full names ("Los Angeles Dodgers")
      if (MLB_SERIES.has(seriesPrefix)) {
        const entityAbbr = mlbNameToAbbr(entityName);
        if (entityAbbr) {
          for (let i = 0; i < outcomes.length; i++) {
            if (mlbNameToAbbr(outcomes[i]) === entityAbbr) return { outcome: outcomes[i], tokenId: tokenIds[i] };
          }
        }
      }
      // NHL fallback: Kalshi uses "UTA Mammoth", PM uses "Utah"
      if (NHL_SERIES.has(seriesPrefix)) {
        const entityAbbr = nhlNameToAbbr(entityName);
        if (entityAbbr) {
          for (let i = 0; i < outcomes.length; i++) {
            if (nhlNameToAbbr(outcomes[i]) === entityAbbr) return { outcome: outcomes[i], tokenId: tokenIds[i] };
          }
        }
      }
      // CBB fallback: Kalshi uses abbreviations ("UConn"), PM uses full names ("Connecticut Huskies")
      if (CBB_SERIES.has(seriesPrefix)) {
        for (let i = 0; i < outcomes.length; i++) {
          if (cbbNamesMatch(entityName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
        }
      }
      // International basketball fallback: fuzzy word matching for Euroleague, KBL, Argentine, etc.
      const FUZZY_INTL_SERIES2 = new Set(["KXEUROLEAGUEGAME", "KXKBLGAME", "KXARGLNBGAME", "KXBBSERIEAGAME", "KXACBGAME", "KXNBLGAME"]);
      if (FUZZY_INTL_SERIES2.has(seriesPrefix)) {
        for (let i = 0; i < outcomes.length; i++) {
          if (fuzzyIntlNamesMatch(entityName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
        }
      }
      return null;
    }
    let pm1Info = findToken(e1.name), pm2Info = findToken(e2.name);
    if (!pm1Info || !pm2Info || pm1Info.tokenId === pm2Info.tokenId) {
      console.log(`[DISCOVER] OUTCOME MISMATCH: ${e1.name}/${e2.name} vs PM ${JSON.stringify(outcomes)}`);
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    // -- Cross-validate PM tokenId mapping by fetching actual CLOB prices ------
    // IMPORTANT: Only apply price-based swap when BOTH name matches are ambiguous
    // (e.g. abbreviation-only matches). When findToken() made confident name matches,
    // trust the names -- price divergence between platforms is expected (that's the arb).
    const pm1NameConfident = namesMatch(e1.name, pm1Info.outcome);
    const pm2NameConfident = namesMatch(e2.name, pm2Info.outcome);
    const bothNamesConfident = pm1NameConfident && pm2NameConfident;

    const clobBaseDiscover = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
    try {
      const [ask1, ask2] = await Promise.all([
        fetchPmAsk(pm1Info.tokenId, clobBaseDiscover),
        fetchPmAsk(pm2Info.tokenId, clobBaseDiscover),
      ]);
      if (ask1 !== null && ask2 !== null && e1.yesAsk > 0 && e2.yesAsk > 0) {
        const diff_correct = Math.abs(e1.yesAsk - ask1) + Math.abs(e2.yesAsk - ask2);
        const diff_swapped = Math.abs(e1.yesAsk - ask2) + Math.abs(e2.yesAsk - ask1);
        if (diff_swapped < diff_correct - 0.10) {
          if (bothNamesConfident) {
            // Names matched confidently -- price divergence is the arb opportunity, not a mapping error.
            // Log but do NOT swap.
            console.log(
              `[DISCOVER] Price divergence (expected for arb): ${e1.name}/${e2.name}` +
              ` KAL=[${fmtPct(e1.yesAsk)},${fmtPct(e2.yesAsk)}]` +
              ` PM=[${fmtPct(ask1)},${fmtPct(ask2)}]` +
              ` diff_correct=${diff_correct.toFixed(2)} diff_swapped=${diff_swapped.toFixed(2)}` +
              ` -- names confident, NOT swapping`
            );
          } else {
            console.warn(
              `[DISCOVER] [!] TOKEN SWAP DETECTED: ${e1.name}/${e2.name}` +
              ` KAL=[${fmtPct(e1.yesAsk)},${fmtPct(e2.yesAsk)}]` +
              ` PM=[${fmtPct(ask1)},${fmtPct(ask2)}]` +
              ` diff_correct=${diff_correct.toFixed(2)} diff_swapped=${diff_swapped.toFixed(2)}` +
              ` -- swapping pm1↔pm2`
            );
            [pm1Info, pm2Info] = [pm2Info, pm1Info];
          }
        }
      }
    } catch (e) {
      console.warn(`[DISCOVER] Token validation fetch failed: ${(e as Error).message}`);
    }

    seenPairs.add(pairKey);
    matchedSlugs.add(pmSlug);
    watchlist.push({
      matchCode: cand.matchCode, pmSlug, date: cand.date,
      kal1: { ticker: e1.ticker, surname: e1.name, yesAsk: e1.yesAsk, noAsk: e1.noAsk, yesAskSize: e1.yesAskSize ?? 0, noAskSize: e1.noAskSize ?? 0 },
      kal2: { ticker: e2.ticker, surname: e2.name, yesAsk: e2.yesAsk, noAsk: e2.noAsk, yesAskSize: e2.yesAskSize ?? 0, noAskSize: e2.noAskSize ?? 0 },
      pm1: { outcome: pm1Info.outcome, tokenId: pm1Info.tokenId, tickSize, minSize, negRisk },
      pm2: { outcome: pm2Info.outcome, tokenId: pm2Info.tokenId, tickSize, minSize, negRisk },
    });
    console.log(`[DISCOVER] MATCHED [${seriesPrefix || cand.eventTicker}] ${marketType}: ${e1.name} vs ${e2.name} -> ${pmSlug} (tick=${tickSize} negRisk=${negRisk})`);
  }

  console.log(`[DISCOVER] Watchlist: ${watchlist.length} matched cross-platform pairs`);
  return { watchlist, noMatchPairs };
}

// --- Price polling ------------------------------------------------------------

async function refreshKalshiPrices(watchlist: WatchEntry[]): Promise<void> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  // Derive unique series tickers from the watchlist (e.g. "KXATPMATCH", "KXDOTA2GAME")
  const seriesSet = new Set<string>();
  for (const entry of watchlist) {
    const s1 = entry.kal1.ticker.split("-")[0];
    const s2 = entry.kal2.ticker.split("-")[0];
    if (s1) seriesSet.add(s1.toUpperCase());
    if (s2) seriesSet.add(s2.toUpperCase());
    if (entry.kal3) { const s3 = entry.kal3.ticker.split("-")[0]; if (s3) seriesSet.add(s3.toUpperCase()); }
  }
  const priceMap = new Map<string, { yes: number; no: number; yesAskSize: number; noAskSize: number }>();
  for (const series of seriesSet) {
    let cursor = "";
    try {
      while (true) {
        const q = new URLSearchParams({ series_ticker: series, status: "open", limit: "200" });
        if (cursor) q.set("cursor", cursor);
        const res = await kalFetch<{ markets?: KalshiMarket[]; next_cursor?: string; cursor?: string }>(`${kalBase}/markets?${q}`);
        const mlist = res.markets ?? [];
        for (const m of mlist) {
          const ticker = pickString(m.ticker ?? "");
          const yesAsk =
            m.yes_ask_dollars !== undefined ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
          const noAsk =
            m.no_ask_dollars !== undefined ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
          const yesAskSz = Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0;
          const noAskSz = Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0;
          if (ticker && yesAsk !== null) priceMap.set(ticker, { yes: yesAsk, no: noAsk ?? 1, yesAskSize: yesAskSz, noAskSize: noAskSz });
        }
        cursor = pickString(res.next_cursor ?? res.cursor ?? "");
        if (!cursor || mlist.length < 200) break;
      }
    } catch (err) {
      console.error(`[POLL] Kalshi ${series} error: ${(err as Error).message}`);
    }
  }
  for (const entry of watchlist) {
    const p1 = priceMap.get(entry.kal1.ticker);
    const p2 = priceMap.get(entry.kal2.ticker);
    if (p1) { entry.kal1.yesAsk = p1.yes; entry.kal1.noAsk = p1.no; entry.kal1.yesAskSize = p1.yesAskSize; entry.kal1.noAskSize = p1.noAskSize; }
    if (p2) { entry.kal2.yesAsk = p2.yes; entry.kal2.noAsk = p2.no; entry.kal2.yesAskSize = p2.yesAskSize; entry.kal2.noAskSize = p2.noAskSize; }
    if (entry.kal3) {
      const p3 = priceMap.get(entry.kal3.ticker);
      if (p3) { entry.kal3.yesAsk = p3.yes; entry.kal3.noAsk = p3.no; entry.kal3.yesAskSize = p3.yesAskSize; entry.kal3.noAskSize = p3.noAskSize; }
    }
  }
}

async function fetchPmAsk(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await polyClobFetch<{ asks?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    return bestAskFromSide(book.asks);
  } catch {
    return null;
  }
}

/** Direct PM book fetch -- bypasses polyQueue for use in parallel batch loops. */
async function fetchPmAskDirect(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await fetchJsonWithRetry<{ asks?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`, {}, retryOpts
    );
    return bestAskFromSide(book.asks);
  } catch {
    return null;
  }
}

async function fetchPmBidDirect(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await fetchJsonWithRetry<{ bids?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`, {}, retryOpts
    );
    return bestBidFromSide(book.bids);
  } catch {
    return null;
  }
}

// Fetch PM ask-side depth: returns [[price, size], ...] sorted ascending by price.
// Each entry is [askPrice (0-1 decimal), shares available].
async function fetchPmAskDepth(tokenId: string, clobBase: string): Promise<[number, number][]> {
  try {
    const book = await polyClobFetch<{ asks?: ClobBookEntry[] }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    if (!Array.isArray(book.asks)) return [];
    const levels: [number, number][] = [];
    for (const entry of book.asks as ClobBookEntry[]) {
      let price = 0, size = 0;
      if (Array.isArray(entry)) {
        price = Number(entry[0]);
        size = Number(entry[1]);
      } else if (entry && typeof entry === "object") {
        price = Number(entry.price ?? 0);
        size = Number(entry.size ?? 0);
      }
      if (price > 0 && price < 1 && size > 0) levels.push([price, size]);
    }
    levels.sort((a, b) => a[0] - b[0]);
    return levels;
  } catch {
    return [];
  }
}

// Sweep PM ask levels up to maxPrice, returning total available shares.
function sweepPmDepth(
  askLevels: [number, number][],
  maxPrice: number
): { totalQty: number; avgPrice: number } {
  let totalQty = 0, totalCost = 0;
  for (const [price, size] of askLevels) {
    if (price > maxPrice) break;
    totalQty += size;
    totalCost += size * price;
  }
  return { totalQty, avgPrice: totalQty > 0 ? totalCost / totalQty : 0 };
}

async function fetchKalshiSingleMarket(ticker: string): Promise<{ ask: number | null; bid: number | null; noAsk: number | null }> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  try {
    const res = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
    const mkt = res.market ?? res as unknown as KalshiMarket;
    const ask = mkt.yes_ask_dollars !== undefined
      ? normDollarsOrCents(mkt.yes_ask_dollars) : normCents(mkt.yes_ask);
    const bid = mkt.yes_bid_dollars !== undefined
      ? normDollarsOrCents(mkt.yes_bid_dollars) : normCents(mkt.yes_bid);
    const noAsk = mkt.no_ask_dollars !== undefined
      ? normDollarsOrCents(mkt.no_ask_dollars) : normCents(mkt.no_ask);
    return { ask, bid, noAsk };
  } catch {
    return { ask: null, bid: null, noAsk: null };
  }
}

// --- PM client factory --------------------------------------------------------

// Cached PM ClobClient -- avoids recreating Wallet + ClobClient + creds on every call.
// resolvePolyApiCreds already has its own module-level cache, but we also avoid
// the ~10ms overhead of new Wallet() + new ClobClient() constructor per call.
let _pmClientCache: { client: ClobClient; createdAt: number } | null = null;
const PM_CLIENT_TTL = 30 * 60_000; // 30 minutes -- re-derive if creds might have rotated

async function createPmClient() {
  if (_pmClientCache && Date.now() - _pmClientCache.createdAt < PM_CLIENT_TTL) {
    return _pmClientCache;
  }
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);
  const funder = process.env.POLY_FUNDER || wallet.address;
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  _pmClientCache = { client: new ClobClient(host, chainId, wallet, creds, sigType, funder), createdAt: Date.now() };
  return _pmClientCache;
}

// PM CLOB requires makerAmount (= price * size in USDC) to have <=2 decimal places.
// When tick=0.001, certain (price, shares) combos produce 3+ dp costs (e.g. 0.929*16=14.864).
// Fix: floor the total cost to 2dp and derive an adjusted price that the CLOB will accept.
function pmSafePrice(price: number, shares: number): number {
  if (shares <= 0) return price;
  const costCents = Math.floor(price * shares * 100);   // floor to 2dp in cents
  return costCents / 100 / shares;
}

async function placePmGTCAsk(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "SELL", type: "GTC" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.SELL },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.GTC
  );
}

async function placePmGTCBid(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "BUY", type: "GTC" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.GTC
  );
}

async function cancelPmOrder(orderId: string, dryRun: boolean): Promise<void> {
  if (dryRun) { console.log(`  [DRY] cancelPmOrder ${orderId}`); return; }
  const { client } = await createPmClient();
  // CLOB client expects { orderID: string }, not a raw string
  await (client as unknown as { cancelOrder(p: { orderID: string }): Promise<unknown> }).cancelOrder({ orderID: orderId });
}

/** Safety-net: cancel ALL open PM orders for a given asset (token). Used when orderId is unknown. */
async function cancelAllPmOrdersForToken(tokenId: string): Promise<number> {
  const { client } = await createPmClient();
  type OpenOrder = { id?: string; orderID?: string; status?: string; asset_id?: string };
  const orders = await (client as unknown as { getOpenOrders(p?: { asset_id?: string }): Promise<OpenOrder[]> })
    .getOpenOrders({ asset_id: tokenId });
  let cancelled = 0;
  for (const o of (Array.isArray(orders) ? orders : [])) {
    const oid = o.id ?? o.orderID;
    if (!oid) continue;
    try {
      await (client as unknown as { cancelOrder(p: { orderID: string }): Promise<unknown> }).cancelOrder({ orderID: oid });
      cancelled++;
    } catch { /* may already be gone */ }
  }
  return cancelled;
}

async function getPmOrderFills(orderId: string): Promise<{ filledShares: number; status: string }> {
  const { client } = await createPmClient();
  const order = await (client as unknown as { getOrder(id: string): Promise<PmOrderResponse & { size_matched?: number; filled?: number }> }).getOrder(orderId);
  const filledShares = Number(order.size_matched ?? order.filled ?? 0);
  const status = String(order.status ?? "unknown");
  return { filledShares, status };
}

// --- Kalshi IOC order builder -------------------------------------------------
// Builds an Immediate-Or-Cancel Kalshi YES order. IOC fills whatever resting volume
// is available and cancels the rest -- no exposure if the book is thin.

type KalshiOrderRequest = {
  ticker: string;
  side: "yes" | "no";
  action: "buy";
  type: "limit";
  time_in_force: "immediate_or_cancel";
  yes_price?: number;
  no_price?: number;
  count: number;
  count_fp: string;
  buy_max_cost: number;
  client_order_id?: string;
};

function buildKalshiIOCOrder(ticker: string, limitPriceDec: number, count: number, side: "yes" | "no" = "yes"): KalshiOrderRequest {
  // Kalshi limit price: to sweep the book up to our profitability boundary, use the
  // market best ask (snapshot). IOC will fill at any price <= this limit.
  const cents = Math.max(1, Math.min(99, Math.round(limitPriceDec * 100)));
  const maxCost = Math.round(count * cents); // in cents
  return {
    ticker,
    side,
    action: "buy",
    type: "limit",
    time_in_force: "immediate_or_cancel",
    yes_price: side === "yes" ? cents : undefined,
    no_price: side === "no" ? cents : undefined,
    count,
    count_fp: `${count}.00`,
    buy_max_cost: maxCost,
  };
}

// Derive YES ask levels from the NO bid side of the Kalshi orderbook.
// Kalshi orderbook: `yes` = YES bids, `no` = NO bids.
// A NO bid at Xc is equivalent to a YES ask at (100-X)c.
// Returns [[yesAskCents, size], ...] sorted ascending (cheapest YES ask first).
function deriveYesAsks(noBids: [number, number][]): [number, number][] {
  return noBids
    .map(([noPrice, size]) => [100 - noPrice, size] as [number, number])
    .filter(([p]) => p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}

// Derive NO ask levels from the YES bid side of the Kalshi orderbook.
// A YES bid at Xc is equivalent to a NO ask at (100-X)c.
// Returns [[noAskCents, size], ...] sorted ascending (cheapest NO ask first).
function deriveNoAsks(yesBids: [number, number][]): [number, number][] {
  return yesBids
    .map(([yesPrice, size]) => [100 - yesPrice, size] as [number, number])
    .filter(([p]) => p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}

// Walk Kalshi orderbook ask levels to find enough depth for the required qty.
// Returns the total available qty, worst price level (for IOC limit), and weighted avg price.
// Returns null if no volume at all or best ask already above maxPriceCents.
function sweepKalshiDepth(
  askLevels: [number, number][],  // [[priceCents, size], ...] sorted ascending
  minContracts: number,
  maxPriceCents: number
): { totalQty: number; worstPrice: number; avgPrice: number } | null {
  if (askLevels.length === 0) return null;
  let totalQty = 0;
  let totalCost = 0;
  let worstPrice = 0;
  for (const [priceCents, size] of askLevels) {
    if (priceCents > maxPriceCents) break; // beyond profitability
    const take = Math.min(size, minContracts - totalQty);
    if (take <= 0) break; // already have enough
    totalQty += take;
    totalCost += take * priceCents;
    worstPrice = priceCents;
    if (totalQty >= minContracts) break;
  }
  if (totalQty === 0) return null;
  return { totalQty, worstPrice, avgPrice: totalCost / totalQty };
}

// --- Polymarket execution (token-based) ---------------------------------------

async function placePmOrder(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) {
    return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares };
  }
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    PM_ORDER_TYPE
  );
}

// --- PM pre-sign / post (two-step order for parallel execution) ---------------
// Pre-sign the PM order while Kalshi IOC is in flight, then post immediately
// after Kalshi fills. Saves ~100-200ms of EIP-712 signing overhead.

/** Pre-sign a PM order (Step 1). Returns a signed order ready to post. */
async function preSignPmOrder(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
): Promise<unknown> {
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).createOrder(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
  );
}

/** Post a pre-signed PM order (Step 2). Submits to CLOB for matching. */
async function postPreSignedPmOrder(signedOrder: unknown): Promise<unknown> {
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).postOrder(signedOrder, PM_ORDER_TYPE);
}

// Dedicated FOK order for hedge IOC sweeps -- always uses FOK regardless of PM_ORDER_TYPE config.
// This prevents a GTC config from accidentally placing resting orders during aggressive sweeps.
async function placePmFOK(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) {
    return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, type: "FOK" };
  }
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FOK
  );
}

// FOK SELL -- aggressive sell into bids. Used by cancellation monitor for emergency exits.
async function placePmFOKSell(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) {
    return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "SELL", type: "FOK" };
  }
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.SELL },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FOK
  );
}

// --- PM order status polling --------------------------------------------------
// When Polymarket returns status=delayed the order is on-chain but not yet confirmed.
// This can take 1–30 seconds. We poll until it resolves before deciding to hedge.

async function waitForPmOrderFill(
  orderId: string,
  timeoutMs = 12_000,
  tokenId?: string,
  preBalance = 0 // on-chain balance BEFORE order was placed -- detect increments, not totals
): Promise<"matched" | "cancelled" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500; // fixed 500ms -- no backoff, detect fills ASAP

  while (Date.now() < deadline) {
    await sleep(pollInterval);

    // Primary: check on-chain balance (authoritative, faster than CLOB API)
    if (tokenId) {
      try {
        const bal = await getOnChainBalance(tokenId);
        if (bal > preBalance) {
          console.log(`  [PM FILL] On-chain balance confirms fill: ${bal} shares (was ${preBalance} before order)`);
          return "matched";
        }
        // bal <= preBalance -> not yet settled on-chain, continue polling
        // bal === -1 -> RPC error, fall through to CLOB API check
      } catch { /* fall through to CLOB API */ }
    }

    // Fallback: CLOB API order status
    try {
      const { client } = await createPmClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await (client as any).getOrder(orderId);
      const resp = raw as PmOrderResponse;
      const order = resp?.order ?? resp;
      const status = String(order?.status ?? order?.order_status ?? "");
      if (status === "matched") return "matched";
      if (status === "cancelled" || status === "unmatched" || status === "rejected") return "cancelled";
    } catch { /* retry */ }
  }
  return "timeout";
}

// --- Hedge state persistence --------------------------------------------------

const HEDGE_STATE_PATH = "hedge_state.json";

type PersistedHedgeEntry = {
  position: UnhedgedPosition;
  activeOrders: Array<[string, HedgeOrder]>;
  kalNextRetryAt: number;
  lastCompleteExchange?: "pm" | "kal";
  pmOnlyCycles?: number;
};

// Module-level reference for the compatibility wrapper below
let _allHedgeStates: HedgeState[] = [];
// Flag set by reconcilePositions when auto-recovered trades need hedge pickup
let _reconcileRecoveredTrades: boolean = false;

// Compatibility wrapper: runHedgeCycle calls saveHedgeState(state) for a SINGLE state,
// but we need to persist the entire array. This re-saves the full array.
function saveHedgeState(_singleState: HedgeState | null): void {
  saveHedgeStates(_allHedgeStates);
}

function saveHedgeStates(states: HedgeState[]): void {
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

// --- Arb P&L persistence ------------------------------------------------------

const ARB_LOG_PATH = path.join("data", "arb_trades.json");
const PENDING_FILLS_PATH = path.join("data", "pending_fills.json");

// --- Pending fill log (crash recovery) --------------------------------------
// Write intent BEFORE placing an order so that if the bot crashes between fill
// and logArbTrade(), reconcile can recover the orphaned position on restart.

interface PendingFill {
  id: string;           // unique key, e.g. "pf-1710412800000"
  ts: string;           // ISO timestamp of intent
  exchange: "pm" | "kal";
  tokenIdOrTicker: string;
  side: string;         // "BUY" / "yes" / "no"
  shares: number;
  price: number;
  match: string;
  dir: string;
  pmSlug: string;
  pmTokenId: string;
  pmOutcome: string;
  kalTicker: string;
  completed?: boolean;  // set true after logArbTrade succeeds
}

function loadPendingFills(): PendingFill[] {
  try {
    if (!fs.existsSync(PENDING_FILLS_PATH)) return [];
    return JSON.parse(fs.readFileSync(PENDING_FILLS_PATH, "utf8"));
  } catch { return []; }
}

function savePendingFills(fills: PendingFill[]): void {
  atomicWriteFileSync(PENDING_FILLS_PATH, JSON.stringify(fills, null, 2));
}

function addPendingFill(fill: PendingFill): void {
  const fills = loadPendingFills();
  fills.push(fill);
  savePendingFills(fills);
}

function completePendingFill(id: string): void {
  const fills = loadPendingFills();
  const f = fills.find(x => x.id === id);
  if (f) {
    f.completed = true;
    savePendingFills(fills);
  }
}

function getIncompletePendingFills(): PendingFill[] {
  return loadPendingFills().filter(f => !f.completed);
}

// --- Ghost fill detection (WSS callback) -------------------------------------
// When a PM fill arrives on-chain via WSS, check if it matches an incomplete
// pending fill from a previous "pm-delayed-zero" abort. If found, look for
// a hedging trade on the same market and resolve it, or trigger reconciliation.

async function handleGhostFill(tokenId: string, shares: number, txHash: string): Promise<void> {
  const pendingFills = loadPendingFills();
  const ghostPf = pendingFills.find(pf =>
    !pf.completed && pf.exchange === "pm" && pf.pmTokenId === tokenId
  );
  if (!ghostPf) return; // Not a ghost fill -- normal fill, ignore

  // Guard: if this pending fill belongs to the CURRENTLY RUNNING execution, skip.
  // The WSS on-chain event fires 2-4s before the PM API poll confirms -- during that
  // window the pending fill is still incomplete but the execution is actively waiting
  // for it. Let the execution path handle it; don't create a duplicate ghost trade.
  if (_activePendingFillId === ghostPf.id) {
    console.log(`[GHOST] Skipping -- pending fill ${ghostPf.id} belongs to active execution (WSS arrived before PM API confirm). Execution will handle it.`);
    return;
  }

  console.warn(
    `\n[GHOST] Detected ghost fill: ${shares}x token=...${tokenId.slice(-12)} (tx=${txHash.slice(0, 18)}...)` +
    `\n[GHOST] Matches pending fill ${ghostPf.id}: ${ghostPf.match} ${ghostPf.pmOutcome} @$${ghostPf.price}` +
    `\n[GHOST] This was a delayed PM order that appeared to fail but settled on-chain.`
  );

  // Mark pending fill as completed
  completePendingFill(ghostPf.id);

  // Look for a "hedging" trade on the same KAL ticker that needs PM shares
  const trades = loadArbTrades();
  const hedgingTrade = trades.find(t =>
    t.status === "hedging" && t.kalTicker === ghostPf.kalTicker && t.pmCost === 0
  );

  if (hedgingTrade) {
    // The hedge trade was waiting for PM shares -- they just arrived as a ghost fill!
    // Use the actual fill price from the CLOB API if possible, fall back to pending fill price
    const actualPrice = ghostPf.price;
    const pmCost = Math.round(hedgingTrade.shares * actualPrice * 100) / 100;
    const totalCost = Math.round((hedgingTrade.kalCost + pmCost) * 100) / 100;
    const costPerShare = totalCost / Math.max(hedgingTrade.shares, 1);

    if (costPerShare < 1) {
      // Profitable -- resolve the trade
      hedgingTrade.status = "resolved";
      hedgingTrade.resolutionMethod = "hedge-complete";
      hedgingTrade.resolvedTs = new Date().toISOString();
      hedgingTrade.pmFillPrice = actualPrice;
      hedgingTrade.pmCost = pmCost;
      hedgingTrade.totalCost = totalCost;
      hedgingTrade.realizedPnl = Math.round((hedgingTrade.shares - totalCost) * 100) / 100;
      saveArbTrades(trades);
      console.warn(
        `[GHOST] Resolved trade ${hedgingTrade.id}: ${hedgingTrade.match} -- ghost PM fill @${(actualPrice * 100).toFixed(0)}c ` +
        `combined $${costPerShare.toFixed(2)}/sh -> P&L=$${hedgingTrade.realizedPnl!.toFixed(2)}`
      );
    } else {
      // Cost >= $1 -- linking them would be a guaranteed loss.
      // Treat as 2 independent unhedged positions, each hedging at breakeven via normal hedge loop.
      // Don't link ghost PM to the KAL trade -- create a separate trade for the ghost PM position.
      console.warn(
        `[GHOST] Combined cost $${costPerShare.toFixed(2)}/sh >= $1.00 for ${hedgingTrade.match}. ` +
        `Treating as 2 independent positions -- each will hedge at breakeven.`
      );
      const ghostTrade: ArbTradeRecord = {
        id: `arb-ghost-${Date.now()}-pm`,
        ts: new Date().toISOString(),
        match: ghostPf.match,
        dir: ghostPf.dir as ArbTradeRecord["dir"],
        status: "hedging",
        shares: Math.min(shares, hedgingTrade.shares),
        kalTicker: ghostPf.kalTicker,
        kalFillPrice: 0,
        kalCost: 0,
        pmOutcome: ghostPf.pmOutcome,
        pmSlug: ghostPf.pmSlug,
        pmTokenId: ghostPf.pmTokenId,
        pmFillPrice: actualPrice,
        pmCost: Math.round(Math.min(shares, hedgingTrade.shares) * actualPrice * 100) / 100,
        totalCost: Math.round(Math.min(shares, hedgingTrade.shares) * actualPrice * 100) / 100,
        projectedEdge: 0,
        projectedProfit: 0,
        initialExchange: "pm",
      };
      trades.push(ghostTrade);
      saveArbTrades(trades);
      console.warn(
        `[GHOST] Created ghost trade ${ghostTrade.id}: ${ghostTrade.shares}x${ghostPf.pmOutcome} @${(actualPrice * 100).toFixed(0)}c -- ` +
        `will hedge at max ${((1 - actualPrice) * 100).toFixed(0)}c on KAL. ` +
        `Original KAL trade ${hedgingTrade.id} stays in hedge mode -- will hedge at max ${((1 - hedgingTrade.kalCost / Math.max(hedgingTrade.shares, 1)) * 100).toFixed(0)}c on PM.`
      );
    }
  } else {
    // No matching hedging trade -- create a new hedge trade for the ghost PM position.
    const ghostTrade: ArbTradeRecord = {
      id: `arb-ghost-${Date.now()}-pm`,
      ts: new Date().toISOString(),
      match: ghostPf.match,
      dir: ghostPf.dir as ArbTradeRecord["dir"],
      status: "hedging",
      shares,
      kalTicker: ghostPf.kalTicker,
      kalFillPrice: 0,
      kalCost: 0,
      pmOutcome: ghostPf.pmOutcome,
      pmSlug: ghostPf.pmSlug,
      pmTokenId: ghostPf.pmTokenId,
      pmFillPrice: ghostPf.price,
      pmCost: Math.round(shares * ghostPf.price * 100) / 100,
      totalCost: Math.round(shares * ghostPf.price * 100) / 100,
      projectedEdge: 0,
      projectedProfit: 0,
      initialExchange: "pm",
    };
    const trades = loadArbTrades();
    trades.push(ghostTrade);
    saveArbTrades(trades);
    // Signal the main loop to pick up this new hedging trade immediately
    _reconcileRecoveredTrades = true;
    console.warn(
      `[GHOST] Created orphan ghost trade ${ghostTrade.id}: ${shares}x${ghostPf.pmOutcome} @${(ghostPf.price * 100).toFixed(0)}c -- ` +
      `entering hedge mode (max KAL hedge = ${((1 - ghostPf.price) * 100).toFixed(0)}c).`
    );
  }
}

// --- Kalshi orderbook pre-cache ----------------------------------------------
const kalBookCache = new Map<string, { book: { yes: [number, number][]; no: [number, number][] }; ts: number }>();
const BOOK_CACHE_TTL = 3000; // 3s -- stale books fall through to live fetch

function loadArbTrades(): ArbTradeRecord[] {
  try {
    if (!fs.existsSync(ARB_LOG_PATH)) return [];
    return JSON.parse(fs.readFileSync(ARB_LOG_PATH, "utf8"));
  } catch { return []; }
}

function saveArbTrades(trades: ArbTradeRecord[]): void {
  atomicWriteFileSync(ARB_LOG_PATH, JSON.stringify(trades, null, 2));
}

// Active pending fill ID for current execution -- set before order placement,
// auto-completed when logArbTrade succeeds. Cleared on abort (no exposure).
let _activePendingFillId: string | null = null;

function logArbTrade(record: ArbTradeRecord): void {
  if (DRY_RUN) return; // Don't persist simulated trades to dashboard
  const trades = loadArbTrades();
  trades.push(record);
  saveArbTrades(trades);
  console.log(`[P&L] Logged arb: ${record.match} dir=${record.dir} status=${record.status} cost=$${record.totalCost.toFixed(2)}`);
  // Auto-complete pending fill -- this trade is now safely persisted
  if (_activePendingFillId) {
    completePendingFill(_activePendingFillId);
    console.log(`[PENDING] Completed pending fill ${_activePendingFillId}`);
    _activePendingFillId = null;
  }
  // Push updated trades to central dashboard (fire-and-forget)
  pushTradeData(trades, loadMetrics()).catch(() => {});
}

// --- Execution metrics persistence ------------------------------------------

const METRICS_PATH = path.join("data", "execution_metrics.json");

function loadMetrics(): ExecMetric[] {
  try { if (!fs.existsSync(METRICS_PATH)) return []; return JSON.parse(fs.readFileSync(METRICS_PATH, "utf8")); } catch { return []; }
}

function appendMetric(m: ExecMetric): void {
  const metrics = loadMetrics();
  metrics.push(m);
  if (metrics.length > 500) metrics.splice(0, metrics.length - 500);
  atomicWriteFileSync(METRICS_PATH, JSON.stringify(metrics, null, 2));
}

// --- Depth opportunity logger ------------------------------------------------
// Logs the FULL profitable depth available on both sides whenever an arb is found,
// regardless of our budget limit. Helps assess whether more capital would help.

interface DepthLevel { price: number; size: number }

interface DepthOpportunity {
  id: string;
  ts: string;
  match: string;
  dir: string;
  edge: number;
  kalAsk: number;
  pmAsk: number;
  outcome: "executed" | "aborted";
  failReason?: string;
  // Kalshi full depth at profitable prices
  kalLevels: DepthLevel[];
  kalTotalContracts: number;
  kalTotalCostUsd: number;
  kalAvgPrice: number;
  // PM full depth at profitable prices
  pmLevels: DepthLevel[];
  pmTotalShares: number;
  pmTotalCostUsd: number;
  pmAvgPrice: number;
  // Combined
  maxProfitableShares: number; // min(kalTotal, pmTotal)
  maxInvestableUsd: number;    // shares x (kalAvg + pmAvg)
  projectedPnlUsd: number;    // shares x edge (approx)
  budgetShares: number;        // what we actually trade with our budget
}

const DEPTH_OPP_PATH = path.join("data", "depth_opportunities.json");
const DEPTH_OPP_MAX = 500;

function loadDepthOpportunities(): DepthOpportunity[] {
  try { if (!fs.existsSync(DEPTH_OPP_PATH)) return []; return JSON.parse(fs.readFileSync(DEPTH_OPP_PATH, "utf8")); } catch { return []; }
}

function appendDepthOpportunity(opp: DepthOpportunity): void {
  const all = loadDepthOpportunities();
  all.push(opp);
  if (all.length > DEPTH_OPP_MAX) all.splice(0, all.length - DEPTH_OPP_MAX);
  atomicWriteFileSync(DEPTH_OPP_PATH, JSON.stringify(all, null, 2));
}

// Sweep ALL profitable depth (no qty limit) -- returns every level and totals
function sweepFullProfitableDepth(
  askLevels: [number, number][],
  maxPrice: number,
  isCents: boolean
): { levels: DepthLevel[]; totalQty: number; totalCost: number; avgPrice: number } {
  const levels: DepthLevel[] = [];
  let totalQty = 0, totalCost = 0;
  for (const [price, size] of askLevels) {
    if (price > maxPrice) break;
    const priceDecimal = isCents ? price / 100 : price;
    levels.push({ price: priceDecimal, size });
    totalQty += size;
    totalCost += size * priceDecimal;
  }
  return { levels, totalQty, totalCost, avgPrice: totalQty > 0 ? totalCost / totalQty : 0 };
}

// --- Continuous book snapshot tracker -----------------------------------------
// On arb discovery, samples both orderbooks every 500ms for 20s and saves to disk.
// Lets you audit exactly what the books looked like around execution time.

interface BookSample {
  t: number;          // ms offset from tracker start
  kalYesBids: [number, number][];  // [priceCents, size][] -- YES bids (resting buy YES)
  kalNoBids: [number, number][];   // NO bids (resting buy NO)
  kalYesAsks: [number, number][];  // derived YES asks (100 - noBidPrice) -- cost to BUY YES
  kalNoAsks: [number, number][];   // derived NO asks (100 - yesBidPrice) -- cost to BUY NO
  pmAsks: [number, number][];  // [priceDecimal, size][]
  pmBids: [number, number][];  // [priceDecimal, size][]
  source: "ws" | "rest" | "mixed";
}

interface BookTrack {
  id: string;         // matches arb trade id (arb-{ts})
  ts: string;         // ISO start time
  phase: "discovery" | "execution";  // when this tracker was started
  match: string;
  dir: string;
  kalTicker: string;
  pmTokenId: string;
  pmOutcome: string;
  kalAskAtDiscovery: number;
  pmAskAtDiscovery: number;
  edge: number;
  samples: BookSample[];
}

const BOOK_SNAPSHOTS_PATH = path.join("data", "book_snapshots.json");
const BOOK_TRACK_MAX = 200;
const BOOK_TRACK_DURATION_MS = 20_000;
const BOOK_TRACK_INTERVAL_MS = 50;

function loadBookSnapshots(): BookTrack[] {
  try { if (!fs.existsSync(BOOK_SNAPSHOTS_PATH)) return []; return JSON.parse(fs.readFileSync(BOOK_SNAPSHOTS_PATH, "utf8")); } catch { return []; }
}

function saveBookTrack(track: BookTrack): void {
  const all = loadBookSnapshots();
  all.push(track);
  if (all.length > BOOK_TRACK_MAX) all.splice(0, all.length - BOOK_TRACK_MAX);
  atomicWriteFileSync(BOOK_SNAPSHOTS_PATH, JSON.stringify(all, null, 2));
}

function startBookTracker(
  kalTicker: string,
  pmTokenId: string,
  meta: { match: string; dir: string; pmOutcome: string; kalAsk: number; pmAsk: number; edge: number; tradeTs: number },
  phase: "discovery" | "execution" = "discovery"
): void {
  const track: BookTrack = {
    id: `arb-${meta.tradeTs}`,
    ts: new Date().toISOString(),
    phase,
    match: meta.match,
    dir: meta.dir,
    kalTicker,
    pmTokenId,
    pmOutcome: meta.pmOutcome,
    kalAskAtDiscovery: meta.kalAsk,
    pmAskAtDiscovery: meta.pmAsk,
    edge: meta.edge,
    samples: [],
  };
  const startMs = Date.now();

  const takeSample = () => {
    const t = Date.now() - startMs;
    let source: BookSample["source"] = "ws";

    // Kalshi: WS first -- capture full book (both bids and derived asks)
    const kalWs = getWsKalBook(kalTicker);
    let kalYesBids: [number, number][] = [];
    let kalNoBids: [number, number][] = [];
    let kalYesAsks: [number, number][] = [];
    let kalNoAsks: [number, number][] = [];
    if (kalWs) {
      // All bids sorted ascending by price
      kalYesBids = kalWs.yes;  // full YES bids
      kalNoBids = kalWs.no;    // full NO bids
      // Derived asks: YES ask = 100 - NO bid price, NO ask = 100 - YES bid price
      kalYesAsks = kalNoBids.map(([p, s]) => [100 - p, s] as [number, number]).sort((a, b) => a[0] - b[0]);
      kalNoAsks = kalYesBids.map(([p, s]) => [100 - p, s] as [number, number]).sort((a, b) => a[0] - b[0]);
    } else {
      source = "rest";
      // Fire-and-forget REST fetch -- will appear in next sample
      fetchKalshiOrderbook(kalTicker).then(book => {
        if (book) {
          const wsBook: WsLiveBook = {
            yes: new Map(book.yes.map(([p, s]) => [p, s])),
            no: new Map(book.no.map(([p, s]) => [p, s])),
            ts: Date.now(),
          };
          wsKalBooks.set(kalTicker, wsBook);
        }
      }).catch(() => {});
    }

    // PM: WS first -- capture top 20 levels
    const pmWsAsks = getWsPmAsks(pmTokenId);
    const pmWsBids = getWsPmBids(pmTokenId);
    const pmAsks: [number, number][] = pmWsAsks ? pmWsAsks.slice(0, 20) : [];
    const pmBids: [number, number][] = pmWsBids ? pmWsBids.slice(0, 20) : [];
    if (!pmWsAsks && source === "ws") source = "mixed";

    track.samples.push({ t, kalYesBids, kalNoBids, kalYesAsks, kalNoAsks, pmAsks, pmBids, source });
  };

  // Take first sample immediately
  takeSample();

  const iv = setInterval(() => {
    if (Date.now() - startMs >= BOOK_TRACK_DURATION_MS) {
      clearInterval(iv);
      try { saveBookTrack(track); } catch (e) { console.error(`[BOOK TRACK] Save failed:`, e); }
      console.log(`[BOOK TRACK] Saved ${track.samples.length} ${phase} samples for ${meta.match} (${BOOK_TRACK_DURATION_MS / 1000}s)`);
      return;
    }
    takeSample();
  }, BOOK_TRACK_INTERVAL_MS);
}

// Helper: get PM bids from WS cache (mirrors getWsPmAsks)
function getWsPmBids(tokenId: string): [number, number][] | null {
  const book = wsPmBooks.get(tokenId);
  if (!book || Date.now() - book.ts > PM_WS_STALE_MS) return null;
  const arr: [number, number][] = [];
  for (const [price, size] of book.bids) {
    if (size > 0) arr.push([price / 100, size]); // convert cents -> decimal
  }
  return arr.sort((a, b) => b[0] - a[0]); // highest bid first
}

function resolveArbTrade(kalTicker: string, updates: Partial<ArbTradeRecord>, tradeId?: string): void {
  if (DRY_RUN) return; // Don't modify trade records in dry-run mode
  const trades = loadArbTrades();
  let idx = -1;
  // Prefer matching by tradeId (precise); fall back to ticker+status (legacy)
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

// --- Post-Resolution Fill Audit (Option D) ----------------------------------
// After resolving a hedge-complete trade, checks Kalshi fills for untracked buys
// (e.g., race condition where GTC fills after cancel). Corrects costs and P&L.
async function postResolutionFillAudit(kalTicker: string, tradeId: string): Promise<void> {
  try {
    const allFills = await fetchAllKalshiFills();
    const tickerFills = allFills.filter(f => f.ticker === kalTicker && f.action === "buy");
    if (tickerFills.length === 0) return;

    // Sum actual KAL buys from exchange
    let actualBuyCost = 0;
    let actualFees = 0;
    let actualBuyCount = 0;
    for (const f of tickerFills) {
      const price = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100;
      actualBuyCost += f.count * price;
      actualFees += f.feeCost;
      actualBuyCount += f.count;
    }
    actualBuyCost = Math.round(actualBuyCost * 100) / 100;
    actualFees = Math.round(actualFees * 100) / 100;

    // Load the trade and check for discrepancy
    const trades = loadArbTrades();
    const trade = trades.find(t => t.id === tradeId);
    if (!trade || trade.status !== "resolved") return;

    // Compare: are there more fills on exchange than tracked?
    const trackedKalCost = trade.kalCost ?? 0;
    const trackedKalFees = trade.kalFees ?? 0;
    const totalExchangeCost = actualBuyCost + actualFees;
    const totalTrackedCost = trackedKalCost + trackedKalFees;
    const discrepancy = Math.abs(totalExchangeCost - totalTrackedCost);

    if (discrepancy < 0.02) return; // within rounding tolerance

    // Check if another trade shares this ticker (shared ticker = don't audit)
    const sharedCount = trades.filter(t => t.kalTicker === kalTicker).length;
    if (sharedCount > 1) {
      console.log(`[AUDIT] Ticker ${kalTicker} shared by ${sharedCount} trades -- skipping fill audit`);
      return;
    }

    console.warn(
      `\n[AUDIT] [!] Fill discrepancy for ${kalTicker} (trade ${tradeId}):\n` +
      `  Exchange: ${actualBuyCount} buys, cost=$${actualBuyCost.toFixed(2)}, fees=$${actualFees.toFixed(2)}, total=$${totalExchangeCost.toFixed(2)}\n` +
      `  Tracked:  kalCost=$${trackedKalCost.toFixed(2)}, kalFees=$${trackedKalFees.toFixed(2)}, total=$${totalTrackedCost.toFixed(2)}\n` +
      `  Δ = $${discrepancy.toFixed(2)} -- correcting trade record`
    );

    // Correct the trade: update kalCost to include ALL exchange buys
    const correctedKalCost = actualBuyCost;
    const correctedKalFees = actualFees;
    const correctedTotalCost = Math.round((correctedKalCost + correctedKalFees + (trade.pmCost ?? 0)) * 100) / 100;
    const correctedPnl = Math.round((trade.shares - correctedTotalCost) * 100) / 100;

    trade.kalCost = correctedKalCost;
    trade.kalFees = correctedKalFees;
    trade.totalCost = correctedTotalCost;
    trade.realizedPnl = correctedPnl;
    trade.resolutionNote = `audit-corrected: +$${discrepancy.toFixed(2)} untracked KAL fills (${actualBuyCount} buys vs ${trade.shares} shares)`;
    saveArbTrades(trades);

    console.log(
      `[AUDIT] Corrected: kalCost=$${correctedKalCost.toFixed(2)} totalCost=$${correctedTotalCost.toFixed(2)} P&L=$${correctedPnl.toFixed(2)}`
    );
  } catch (e) {
    console.warn(`[AUDIT] Post-resolution fill audit failed: ${(e as Error).message}`);
  }
}

// --- Position Reconciliation -------------------------------------------------
// Fetches ground truth from both exchanges and corrects arb_trades.json.
// Runs on startup + every hour to keep P&L log accurate.

let _reconcileSnapshot = new Map<string, Record<string, unknown>>();
let _reconcileTrigger = "startup";

// -- Reconcile sub-steps (extracted for readability) --------------------------

/** (c2) Repair PM costs using CLOB getTrades() API + on-chain fallback. Mutates trades in place. */
async function repairPmCostsFromClob(trades: ArbTradeRecord[]): Promise<{ repaired: number; changed: boolean }> {
  let repaired = 0;
  let changed = false;
  // Include resolved trades with pmCost=0 -- section (a) may have resolved via settlement
  // before CLOB repair ran, leaving pmCost=0 on trades that actually had PM fills.
  const needRepair = trades.filter(t => t.pmTokenId && t.pmCost === 0 && t.pmFillPrice === 0);
  if (needRepair.length === 0) return { repaired, changed };

  // Retry CLOB getTrades() up to 5 times with exponential backoff.
  // No estimated fallback -- we only use actual exchange data.
  const MAX_CLOB_RETRIES = 5;
  type ClobFill = { asset_id: string; size: string; price: string; fee_rate_bps: string; side: string; status: string; match_time: string };
  let clobTrades: ClobFill[] | null = null;
  for (let attempt = 1; attempt <= MAX_CLOB_RETRIES; attempt++) {
    try {
      const { client } = await createPmClient();
      clobTrades = (await client.getTrades()) as unknown as ClobFill[];
      break;
    } catch (e) {
      console.warn(`[RECONCILE]   PM CLOB fetch attempt ${attempt}/${MAX_CLOB_RETRIES} failed: ${(e as Error).message}`);
      if (attempt < MAX_CLOB_RETRIES) {
        const delayMs = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
        console.log(`[RECONCILE]   Retrying in ${(delayMs / 1000).toFixed(0)}s...`);
        await sleep(delayMs);
      } else {
        console.error(`[RECONCILE]   PM CLOB fetch failed after ${MAX_CLOB_RETRIES} attempts. ${needRepair.length} trades left unrepaired.`);
      }
    }
  }

  if (clobTrades) {
    const pmFillsByToken = new Map<string, ClobFill[]>();
    for (const ct of clobTrades) {
      if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
      const list = pmFillsByToken.get(ct.asset_id) ?? [];
      list.push(ct);
      pmFillsByToken.set(ct.asset_id, list);
    }
    const usedPmIdx = new Map<string, Set<number>>();

    for (const trade of needRepair) {
      const fills = pmFillsByToken.get(trade.pmTokenId!);
      if (!fills || fills.length === 0) continue;
      let used = usedPmIdx.get(trade.pmTokenId!);
      if (!used) { used = new Set(); usedPmIdx.set(trade.pmTokenId!, used); }

      const tradeSec = new Date(trade.ts).getTime() / 1000;
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < fills.length; i++) {
        if (used.has(i)) continue;
        const rawMt = fills[i].match_time;
        const fillSec = /^\d+(\.\d+)?$/.test(rawMt) ? Number(rawMt) : new Date(rawMt).getTime() / 1000;
        const dist = Math.abs(fillSec - tradeSec);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      // Hedge trades may have PM fills minutes/hours after KAL fill -- allow wider window
      const maxDistSec = (trade.status === "resolved" || trade.initialExchange === "kal") ? 7200 : 60;
      if (bestIdx < 0 || bestDist > maxDistSec) continue;
      used.add(bestIdx);

      const f = fills[bestIdx];
      const price = Number(f.price);
      const feeBps = Number(f.fee_rate_bps);
      const feePerShare = price * (feeBps / 10000);
      const avgPrice = Math.round((price + feePerShare) * 100) / 100;
      trade.pmFillPrice = avgPrice;
      trade.pmCost = Math.round(trade.shares * avgPrice * 100) / 100;
      trade.totalCost = totalCostForTrade(trade);
      // Recalculate P&L for resolved trades that were settled with pmCost=0
      if (trade.status === "resolved" && trade.realizedPnl != null) {
        const hedgeCost = trade.hedgeCost ?? 0;
        const payout = trade.shares; // arb guarantees $1/share when both legs exist
        const oldPnl = trade.realizedPnl;
        trade.realizedPnl = Math.round((payout - trade.kalCost - trade.pmCost - hedgeCost) * 100) / 100;
        console.log(`[RECONCILE]   PM CLOB P&L fix: ${trade.match} -> P&L $${oldPnl.toFixed(2)}->$${trade.realizedPnl.toFixed(2)} (pmCost was missing)`);
      }
      console.log(`[RECONCILE]   PM CLOB repair: ${trade.match} -> pmFP=${avgPrice} pmCost=$${trade.pmCost.toFixed(2)} (ts-matched)`);
      repaired++;
      changed = true;
    }
  }
  return { repaired, changed };
}

/** (d) Verify and fix P&L for all resolved trades. Mutates trades in place. */
async function verifyAndFixPnl(
  trades: ArbTradeRecord[],
  settlementByTicker: Map<string, KalSettlement>
): Promise<{ fixed: number; changed: boolean }> {
  let fixed = 0;
  let changed = false;

  for (const trade of trades) {
    if (trade.status !== "resolved") continue;
    // Scalar-settled trades have manually-verified P&L from actual settlement values.
    // Never overwrite with the binary formula.
    if (trade.scalarSettlement) continue;

    let correctPnl: number;

    if (trade.resolutionMethod === "hedge-complete") {
      const payout = trade.shares;
      // New-style trades (initialExchange set): the hedge loop already merged hedge costs into
      // kalCost+pmCost (e.g., PM-initial -> pmCost = initialCost + hedgeFillCostPm). Don't double-count.
      // EXCEPTION: partial-fill trades have 3 independent cost components (kalCost + pmCost + hedgeCost)
      // when both KAL partially filled AND PM hedge covered remaining. Detect by checking if
      // both kalCost > 0 AND pmCost > 0 AND hedgeCost > 0 AND hedgeCost ≠ kalCost/pmCost.
      // Legacy trades (no initialExchange): hedgeCost may need to be added if one side is 0.
      let hc: number;
      const hedgeCostVal = trade.hedgeCost ?? 0;
      if (!trade.initialExchange) {
        // Legacy: add hedgeCost when one side is 0
        hc = ((trade.pmCost === 0 || trade.kalCost === 0) && hedgeCostVal > 0) ? hedgeCostVal : 0;
      } else if (hedgeCostVal > 0 && trade.kalCost > 0 && trade.pmCost > 0
        && Math.abs(hedgeCostVal - trade.kalCost) > 0.05
        && Math.abs(hedgeCostVal - trade.pmCost) > 0.05) {
        // New-style partial-fill: hedgeCost is a third independent component
        hc = hedgeCostVal;
      } else {
        // New-style standard: hedgeCost is a duplicate of one leg
        hc = 0;
      }
      // kalCost already includes kalFees (baked in at resolve time) -- do NOT add kalFees again
      trade.totalCost = Math.round((trade.kalCost + hc + trade.pmCost) * 100) / 100;
      correctPnl = payout - trade.totalCost;
    } else {
      const settlement = settlementByTicker.get(trade.kalTicker);
      let kalResult = settlement?.marketResult ?? "";
      if (!kalResult) {
        try {
          const mkt = await fetchKalshiMarket(trade.kalTicker);
          kalResult = String(mkt.result ?? "").toLowerCase();
        } catch { continue; }
      }
      if (!kalResult) continue;

      const kalSide = kalSideForDir(trade.dir);
      const kalSideWon = (kalSide === "yes" && kalResult === "yes") || (kalSide === "no" && kalResult === "no");
      const hasPm = trade.pmCost > 0 || trade.pmFillPrice > 0;
      const hasKal = trade.kalCost > 0 || trade.kalFillPrice > 0;

      {
        // Same logic: new-style trades have hedge costs merged into kalCost/pmCost by the hedge loop.
        const hcS = !trade.initialExchange && ((trade.pmCost === 0 || trade.kalCost === 0) && (trade.hedgeCost ?? 0) > 0) ? (trade.hedgeCost ?? 0) : 0;
        // If hedge exists (opposite side bought on either exchange), both sides covered -> payout = shares
        const kalPayout = hcS > 0 ? trade.shares : ((hasKal && kalSideWon) ? trade.shares : 0);
        const pmPayout = hcS > 0 ? 0 : ((hasPm && !kalSideWon) ? trade.shares : 0);
        // kalCost already includes kalFees -- do NOT subtract kalFees separately
        correctPnl = kalPayout + pmPayout - trade.kalCost - hcS - trade.pmCost;
      }
      const hcS2 = !trade.initialExchange && ((trade.pmCost === 0 || trade.kalCost === 0) && (trade.hedgeCost ?? 0) > 0) ? (trade.hedgeCost ?? 0) : 0;
      trade.totalCost = Math.round((trade.kalCost + hcS2 + trade.pmCost) * 100) / 100;
    }
    correctPnl = Math.round(correctPnl * 100) / 100;

    if (trade.realizedPnl !== correctPnl) {
      const oldPnl = trade.realizedPnl;
      trade.realizedPnl = correctPnl;
      console.log(`[RECONCILE]   Fixed P&L: ${trade.match} dir=${trade.dir} method=${trade.resolutionMethod ?? "n/a"} (was $${(oldPnl ?? 0).toFixed(2)}, now $${correctPnl.toFixed(2)})`);
      fixed++;
      changed = true;
    }
  }
  return { fixed, changed };
}

/** Write reconcile audit trail to data/reconcile_audit.json. */
function writeReconcileAudit(trades: ArbTradeRecord[]): void {
  const auditChanges: { tradeId: string; match: string; field: string; oldValue: unknown; newValue: unknown }[] = [];
  const auditFields = ["status", "resolutionMethod", "kalCost", "pmCost", "totalCost", "kalFillPrice", "pmFillPrice", "realizedPnl", "resolvedTs", "hedgeCost"] as const;
  for (const t of trades) {
    const snap = _reconcileSnapshot.get(t.id);
    if (!snap) continue;
    for (const f of auditFields) {
      const oldVal = snap[f];
      const newVal = t[f as keyof ArbTradeRecord];
      if (oldVal !== newVal && !(oldVal == null && newVal == null)) {
        auditChanges.push({ tradeId: t.id, match: t.match, field: f, oldValue: oldVal, newValue: newVal });
      }
    }
  }
  if (auditChanges.length > 0) {
    const auditPath = path.join("data", "reconcile_audit.json");
    let entries: unknown[] = [];
    try { if (fs.existsSync(auditPath)) entries = JSON.parse(fs.readFileSync(auditPath, "utf8")); } catch {}
    entries.push({
      ts: new Date().toISOString(),
      trigger: _reconcileTrigger,
      changeCount: auditChanges.length,
      changes: auditChanges,
    });
    if (entries.length > 200) entries = entries.slice(entries.length - 200);
    atomicWriteFileSync(auditPath, JSON.stringify(entries, null, 2));
    console.log(`[RECONCILE] Audit: ${auditChanges.length} field changes logged.`);
  }
}

async function reconcilePositions(trigger: string = "startup"): Promise<void> {
  _reconcileTrigger = trigger;
  console.log("[RECONCILE] Fetching exchange data...");
  let kalFills: KalFill[] = [];
  let kalSettlements: KalSettlement[] = [];
  let kalPosMap = new Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>();
  let pmPositions: PmPosition[] = [];

  try {
    [kalFills, kalSettlements, kalPosMap] = await Promise.all([
      fetchAllKalshiFills(),
      fetchAllKalshiSettlements(),
      getKalshiPositionMap(),
    ]);
    console.log(`[RECONCILE] Kalshi: ${kalFills.length} fills, ${kalSettlements.length} settlements, ${kalPosMap.size} positions`);
  } catch (e) {
    console.error(`[RECONCILE] Kalshi fetch failed: ${(e as Error).message}`);
  }

  try {
    pmPositions = await fetchPmPositionsCached(0); // force fresh
    console.log(`[RECONCILE] PM: ${pmPositions.length} positions`);
  } catch (e) {
    console.error(`[RECONCILE] PM fetch failed: ${(e as Error).message}`);
  }

  // Build per-ticker+side fill arrays for timestamp-matched lookups.
  // Each fill is kept individually (not aggregated) so we can match by timestamp.
  const kalFillsByKey = new Map<string, KalFill[]>();
  for (const f of kalFills) {
    if (f.action !== "buy" || !f.ticker) continue;
    const key = `${f.ticker}:${f.side}`;
    const list = kalFillsByKey.get(key) ?? [];
    list.push(f);
    kalFillsByKey.set(key, list);
  }
  // Track which fill indices have been consumed (prevents double-assignment across trades)
  const usedKalFillIdx = new Map<string, Set<number>>();

  // Helper: match Kalshi fills to a trade by timestamp proximity (same as repairTrades.ts)
  function matchKalFillsForTrade(key: string, tradeTs: string, tradeShares: number): { costCents: number; fees: number; shares: number; avgPriceCents: number } | null {
    const fills = kalFillsByKey.get(key);
    if (!fills || fills.length === 0) return null;
    let used = usedKalFillIdx.get(key);
    if (!used) { used = new Set(); usedKalFillIdx.set(key, used); }

    const tradeSec = new Date(tradeTs).getTime() / 1000;
    const candidates: { idx: number; dist: number }[] = [];
    for (let i = 0; i < fills.length; i++) {
      if (used.has(i)) continue;
      if (!fills[i].ts) continue;
      const fillSec = new Date(fills[i].ts).getTime() / 1000;
      candidates.push({ idx: i, dist: Math.abs(fillSec - tradeSec) });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    let totalShares = 0, totalCostCents = 0, totalFees = 0;
    const matched: number[] = [];
    for (const c of candidates) {
      if (totalShares >= tradeShares) break;
      const f = fills[c.idx];
      const priceCents = f.side === "yes" ? f.yesPrice : f.noPrice;
      totalShares += f.count;
      totalCostCents += f.count * priceCents;
      totalFees += f.feeCost;
      matched.push(c.idx);
    }
    if (totalShares === 0 || totalShares < tradeShares * 0.5) return null;
    for (const idx of matched) used.add(idx);
    return { costCents: totalCostCents, fees: totalFees, shares: totalShares, avgPriceCents: totalShares > 0 ? Math.round(totalCostCents / totalShares) : 0 };
  }

  // Also keep aggregate fillsByTicker for settlement fee proportioning (step a)
  const fillsByTicker = new Map<string, { totalShares: number; totalCostCents: number; totalFeeDollars: number; side: string; avgPriceCents: number }>();
  // Per-side fills: key = "ticker:yes" or "ticker:no" -> detect hedge fills on opposite side
  const fillsByTickerSide = new Map<string, { totalShares: number; totalCostDollars: number; totalFeeDollars: number }>();
  for (const f of kalFills) {
    if (f.action !== "buy" || !f.ticker) continue;
    const costCents = f.count * (f.side === "yes" ? f.yesPrice : f.noPrice);
    // Aggregate (existing behavior)
    const existing = fillsByTicker.get(f.ticker);
    if (existing) {
      existing.totalShares += f.count;
      existing.totalCostCents += costCents;
      existing.totalFeeDollars += f.feeCost;
      existing.avgPriceCents = existing.totalShares > 0 ? Math.round(existing.totalCostCents / existing.totalShares) : 0;
    } else {
      const avg = f.count > 0 ? Math.round(costCents / f.count) : 0;
      fillsByTicker.set(f.ticker, { totalShares: f.count, totalCostCents: costCents, totalFeeDollars: f.feeCost, side: f.side, avgPriceCents: avg });
    }
    // Per-side index
    const sideKey = `${f.ticker}:${f.side}`;
    const es = fillsByTickerSide.get(sideKey);
    if (es) {
      es.totalShares += f.count;
      es.totalCostDollars += costCents / 100;
      es.totalFeeDollars += f.feeCost;
    } else {
      fillsByTickerSide.set(sideKey, { totalShares: f.count, totalCostDollars: costCents / 100, totalFeeDollars: f.feeCost });
    }
  }

  // Build settlement lookup with full data (costs, fees, market result)
  const settlementByTicker = new Map<string, KalSettlement>();
  for (const s of kalSettlements) {
    if (!s.ticker) continue;
    const existing = settlementByTicker.get(s.ticker);
    if (!existing || s.settledTime > existing.settledTime) {
      settlementByTicker.set(s.ticker, s);
    }
  }

  // Load trades and snapshot for audit trail
  const trades = loadArbTrades();
  _reconcileSnapshot = new Map();
  for (const t of trades) {
    _reconcileSnapshot.set(t.id, { status: t.status, resolutionMethod: t.resolutionMethod, kalCost: t.kalCost, pmCost: t.pmCost, totalCost: t.totalCost, kalFillPrice: t.kalFillPrice, pmFillPrice: t.pmFillPrice, realizedPnl: t.realizedPnl, resolvedTs: t.resolvedTs, hedgeCost: t.hedgeCost });
  }
  let staleResolved = 0;
  let filledToResolved = 0;
  let costsCorrected = 0;
  let changed = false;

  // -- (pre) Ghost/duplicate consolidation: merge multiple records per ticker into one --
  // When ghost/recovered/excess trades share a kalTicker with a normal trade, consolidate
  // into a single record using actual exchange data as source of truth.
  {
    const removeIds = new Set<string>();
    // Group trades by kalTicker
    const byTicker = new Map<string, ArbTradeRecord[]>();
    for (const t of trades) {
      if (!t.kalTicker) continue;
      const list = byTicker.get(t.kalTicker) ?? [];
      list.push(t);
      byTicker.set(t.kalTicker, list);
    }

    for (const [ticker, group] of byTicker) {
      if (group.length <= 1) continue;
      const hasGhost = group.some(g => g.id.includes("ghost") || g.id.includes("recovered") || g.id.includes("excess"));
      if (!hasGhost) continue;

      // Get actual Kalshi position for this ticker
      const kalPos = kalPosMap.get(ticker);
      const kalSide = kalSideForDir(group[0].dir);
      const actualShares = kalPos ? (kalSide === "yes" ? kalPos.yesCount : kalPos.noCount) : 0;

      // Get actual Kalshi fills
      const kalKey = `${ticker}:${kalSide}`;
      const kalFillList = kalFillsByKey.get(kalKey) ?? [];
      let actualKalCostRaw = 0, actualKalFees = 0;
      for (const f of kalFillList) {
        const price = f.side === "yes" ? f.yesPrice : f.noPrice;
        actualKalCostRaw += f.count * price / 100;
        actualKalFees += f.feeCost;
      }
      const totalKalFillShares = kalFillList.reduce((s, f) => s + f.count, 0);
      const actualKalCost = Math.round((actualKalCostRaw + actualKalFees) * 100) / 100;

      // Choose primary trade (prefer normal over ghost/recovered)
      const primary = group.find(g => !g.id.includes("ghost") && !g.id.includes("recovered") && !g.id.includes("excess"))
        ?? group.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())[0];
      const mergedIds = group.filter(g => g !== primary).map(g => g.id);

      // Aggregate PM costs -- use the FIRST trade's pmCost per share, don't double-count
      const pmCostPerShare = primary.pmCost > 0 && primary.shares > 0
        ? primary.pmCost / primary.shares
        : group.find(g => g.pmCost > 0 && g.shares > 0)
          ? (group.find(g => g.pmCost > 0 && g.shares > 0)!.pmCost / group.find(g => g.pmCost > 0 && g.shares > 0)!.shares)
          : 0;

      // Use max single-trade PM shares (each ghost claims same fills, don't sum)
      const uniquePmShares = Math.round(group.reduce((max, g) => Math.max(max, g.pmCost > 0 ? g.shares : 0), 0));
      const actualPmShares = uniquePmShares || primary.shares;
      const actualPmFillPrice = pmCostPerShare > 0 ? Math.round(pmCostPerShare * 100) / 100 : primary.pmFillPrice;

      // Arb shares = min(KAL fills, PM fills). Cap both sides to arb size.
      const arbShares = Math.min(totalKalFillShares, actualPmShares) || totalKalFillShares || primary.shares;
      const cappedPmShares = Math.min(actualPmShares, arbShares);
      const cappedPmCost = Math.round(cappedPmShares * pmCostPerShare * 100) / 100;
      const cappedKalShares = Math.min(totalKalFillShares, arbShares);
      const cappedKalCost = totalKalFillShares > 0
        ? Math.round((cappedKalShares * (actualKalCostRaw / totalKalFillShares) + actualKalFees * (cappedKalShares / totalKalFillShares)) * 100) / 100
        : 0;
      const excessCost = Math.round((actualKalCost - cappedKalCost + actualPmShares * pmCostPerShare - cappedPmCost) * 100) / 100;

      console.log(`[RECONCILE]   CONSOLIDATE: ${ticker} -- merging ${group.length} records -> 1. Removing: ${mergedIds.join(", ")}`);
      console.log(`[RECONCILE]     Arb: ${arbShares} shares | KAL: $${cappedKalCost} | PM: $${cappedPmCost}${excessCost > 0.01 ? ` | Excess: $${excessCost}` : ""}`);

      primary.shares = arbShares;
      primary.kalCost = cappedKalCost;
      primary.kalFillPrice = totalKalFillShares > 0 ? Math.round(actualKalCostRaw / totalKalFillShares * 100) / 100 : primary.kalFillPrice;
      primary.kalFees = Math.round(actualKalFees * (cappedKalShares / Math.max(1, totalKalFillShares)) * 100) / 100;
      primary.pmCost = cappedPmCost;
      primary.pmFillPrice = actualPmFillPrice;
      primary.totalCost = Math.round((cappedKalCost + cappedPmCost) * 100) / 100;
      primary.hedgeCost = undefined;
      primary.kalYesFills = kalFillList.filter(f => f.side === "yes").reduce((s, f) => s + f.count, 0);
      primary.kalNoFills = kalFillList.filter(f => f.side === "no").reduce((s, f) => s + f.count, 0);
      // Track over-hedge excess cost
      if (totalKalFillShares > arbShares || actualPmShares > arbShares) {
        primary.overHedgeShares = Math.max(totalKalFillShares - arbShares, actualPmShares - arbShares);
        primary.overHedgeCost = excessCost;
        primary.overHedgeSide = (totalKalFillShares > arbShares) ? kalSide as "yes" | "no" : "yes";
      } else {
        delete primary.overHedgeShares;
        delete primary.overHedgeCost;
        delete primary.overHedgeSide;
      }

      // Fix P&L with capped costs
      if (primary.status === "resolved" && (primary.resolutionMethod === "hedge-complete" || primary.resolutionMethod === "both-legs")) {
        primary.realizedPnl = Math.round((arbShares - primary.totalCost) * 100) / 100;
      }

      // Mark others for removal
      for (const g of group) {
        if (g !== primary) removeIds.add(g.id);
      }
      changed = true;
    }

    if (removeIds.size > 0) {
      for (let i = trades.length - 1; i >= 0; i--) {
        if (removeIds.has(trades[i].id)) {
          console.log(`[RECONCILE]   Removed duplicate: ${trades[i].id}`);
          trades.splice(i, 1);
        }
      }
    }
  }

  for (const trade of trades) {
    // Skip scalar-settled trades -- their P&L is manually corrected based on actual settlement
    // values and should never be recalculated using the binary formula.
    if (trade.scalarSettlement) continue;

    // (a) Fix stale "hedging" -> check if market settled
    if (trade.status === "hedging") {
      const settlement = settlementByTicker.get(trade.kalTicker);
      if (settlement) {
        const kalFee = settlement.feeCost;

        // Try to find PM cost from positions -- only if this trade's hedge actually went to PM.
        // Don't assign PM cost from positions that belong to other trades on the same slug.
        let pmCost = trade.pmCost;
        if (pmCost === 0 || trade.pmFillPrice === 0) {
          const otherPmClaimed = trades
            .filter(t => t.id !== trade.id && t.pmSlug === trade.pmSlug && t.pmCost > 0)
            .reduce((s, t) => s + t.shares, 0);
          for (const p of pmPositions) {
            const slug = String(p.slug ?? p.marketSlug ?? "");
            const outcome = String(p.outcome ?? p.title ?? "");
            if ((slug && slug === trade.pmSlug) && (outcome === "" || namesMatch(outcome, trade.pmOutcome))) {
              const avgPrice = Number(p.avgPrice ?? 0);
              const size = Number(p.size ?? p.amount ?? 0);
              const availableShares = size - otherPmClaimed;
              if (avgPrice > 0 && availableShares >= trade.shares) {
                // Sanity check: if combined cost/share >= $1, PM avgPrice is likely market price, not fill price -- skip
                const estCombined = (trade.kalCost + trade.shares * avgPrice) / Math.max(trade.shares, 1);
                if (estCombined >= 1) {
                  console.warn(`[RECONCILE]   PM avgPrice ${(avgPrice * 100).toFixed(0)}c for ${trade.match} gives combined $${estCombined.toFixed(2)}/sh >= $1.00 -- skipping PM cost backfill`);
                } else {
                  pmCost = trade.shares * avgPrice;
                  trade.pmFillPrice = avgPrice;
                  trade.pmCost = Math.round(pmCost * 100) / 100;
                }
              }
              break;
            }
          }
        }

        // Per-trade P&L -- don't use aggregate settlement kalCostExact/kalRevenue
        // as it sums ALL fills for the ticker, double-counting when multiple trades share it.
        const kalSide = kalSideForDir(trade.dir);
        const kalOppSide = kalSide === "yes" ? "no" : "yes";
        const kalSideWon = (kalSide === "yes" && settlement.marketResult === "yes") || (kalSide === "no" && settlement.marketResult === "no");
        const hasPmLeg = pmCost > 0 || trade.pmFillPrice > 0;

        // -- Check for hedge fills on OPPOSITE Kalshi side --
        // If the bot hedged by buying the opposite side on Kalshi (e.g., bought YES initially,
        // then bought NO as hedge), both sides are covered -> payout = shares x $1 regardless.
        // IMPORTANT: Only count opposite-side fills as hedges if no OTHER trade on this ticker
        // already accounts for them -- otherwise we'd fabricate hedge data from unrelated trades.
        const oppSideFills = fillsByTickerSide.get(`${trade.kalTicker}:${kalOppSide}`);
        let hedgeCostKal = trade.hedgeCost ?? 0;
        let kalHedgeShares = 0;
        if (oppSideFills && oppSideFills.totalShares > 0 && !hasPmLeg) {
          // Check if other trades already account for opposite-side fills on this ticker
          // Only count trades on the SAME opposite side (e.g., both buying NO as hedge)
          const otherTradesOppShares = trades
            .filter(t => t.id !== trade.id && t.kalTicker === trade.kalTicker &&
              t.resolutionMethod === "hedge-complete" && (t.hedgeCost ?? 0) > 0 && t.pmCost === 0)
            .reduce((s, t) => s + t.shares, 0);
          const unclaimedOppShares = Math.max(0, oppSideFills.totalShares - otherTradesOppShares);
          if (unclaimedOppShares > 0) {
            kalHedgeShares = Math.min(unclaimedOppShares, trade.shares);
            hedgeCostKal = Math.round((oppSideFills.totalCostDollars + oppSideFills.totalFeeDollars) * (kalHedgeShares / oppSideFills.totalShares) * 100) / 100;
            console.log(`[RECONCILE]   Found KAL hedge fills: ${kalHedgeShares}x${kalOppSide.toUpperCase()} cost=$${hedgeCostKal.toFixed(2)} on ${trade.kalTicker} (${unclaimedOppShares} unclaimed of ${oppSideFills.totalShares} total)`);
          }
        }

        // Payout calculation: hedged shares always pay $1, unhedged depend on result
        const hedgedShares = hasPmLeg ? trade.shares : kalHedgeShares;
        const unhedgedShares = trade.shares - hedgedShares;
        const kalPayout = hedgedShares + (kalSideWon ? unhedgedShares : 0);
        const pmPayout = (hasPmLeg && !kalSideWon) ? trade.shares : 0;

        // Keep per-trade kalCost (set by makeUnhedged). Add proportional fee if missing.
        if (trade.kalCost > 0 && trade.kalFillPrice > 0) {
          const rawCost = trade.shares * trade.kalFillPrice;
          // If kalCost ≈ shares x fillPrice, fee isn't included yet -- add proportional fee
          if (Math.abs(trade.kalCost - rawCost) < 0.05 && kalFee > 0) {
            const fillData = fillsByTicker.get(trade.kalTicker);
            const totalShares = fillData?.totalShares ?? trade.shares;
            const perTradeFee = Math.round(kalFee * (trade.shares / totalShares) * 100) / 100;
            trade.kalCost = Math.round((rawCost + perTradeFee) * 100) / 100;
          }
        } else if (trade.kalCost === 0 && fillsByTicker.has(trade.kalTicker)) {
          // kalCost lost -- backfill from proportional fill data
          const fillData = fillsByTicker.get(trade.kalTicker)!;
          const proportion = fillData.totalShares > 0 ? trade.shares / fillData.totalShares : 1;
          const backfilledKalCost = Math.round((fillData.totalCostCents / 100 + fillData.totalFeeDollars) * proportion * 100) / 100;
          const combinedPerShare = (backfilledKalCost + pmCost) / Math.max(trade.shares, 1);
          if (combinedPerShare >= 1) {
            console.log(`[RECONCILE]   WARNING: backfill for ${trade.match} gives combined cost $${combinedPerShare.toFixed(2)}/share >= $1.00 -- bad recovery, money already spent`);
          }
          trade.kalCost = backfilledKalCost;
          trade.kalFillPrice = fillData.avgPriceCents / 100;
        }

        // Include hedge cost in total
        const totalKalCost = trade.kalCost + hedgeCostKal;
        const pnl = kalPayout + pmPayout - totalKalCost - pmCost;

        trade.status = "resolved";
        trade.resolutionMethod = kalHedgeShares > 0 ? "hedge-complete" : "settlement";
        trade.resolvedTs = settlement.settledTime;
        trade.pmCost = pmCost;
        trade.hedgeCost = hedgeCostKal > 0 ? hedgeCostKal : (trade.hedgeCost ?? 0);
        trade.totalCost = Math.round((trade.kalCost + hedgeCostKal + pmCost) * 100) / 100;
        trade.realizedPnl = Math.round(pnl * 100) / 100;
        console.log(`[RECONCILE]   Resolved ${trade.match} (dir ${trade.dir}): ${trade.resolutionMethod}, kalPayout=$${kalPayout}${kalHedgeShares > 0 ? ` hedgeKal=$${hedgeCostKal.toFixed(2)}` : ""} pmPayout=$${pmPayout} P&L=$${trade.realizedPnl.toFixed(2)}`);
        staleResolved++;
        changed = true;
        continue;
      }
    }

    // (a2) Fix "hedging" trades where PM already holds the hedge tokens.
    //      This happens when the bot placed KAL, then PM filled separately (or the bot
    //      crashed after PM filled but before updating the trade record).
    //      Check if PM wallet has tokens matching the trade's pmOutcome on the same slug.
    //      IMPORTANT: Subtract PM shares already claimed by other trades on the same slug
    //      to avoid double-counting the same PM position across multiple trades.
    if (trade.status === "hedging" && trade.pmCost === 0 && trade.kalFillPrice > 0) {
      // Count PM shares already claimed by other trades on the same slug
      const otherPmSharesClaimed = trades
        .filter(t => t.id !== trade.id && t.pmSlug === trade.pmSlug && t.pmCost > 0)
        .reduce((s, t) => s + t.shares, 0);
      for (const p of pmPositions) {
        const slug = String(p.slug ?? p.marketSlug ?? "");
        const outcome = String(p.outcome ?? p.title ?? "");
        const size = Math.round(Number(p.size ?? p.amount ?? 0));
        const availableShares = size - otherPmSharesClaimed;
        const posAvgPrice = Number(p.avgPrice ?? 0);
        if (availableShares >= trade.shares && slug === trade.pmSlug && namesMatch(outcome, trade.pmOutcome)) {
          // PM holds enough UNCLAIMED shares to cover this trade's hedge.
          // Prefer actual fill price from pending_fills over PM positions API avgPrice (which can be market price).
          const pfMatch = loadPendingFills().find(pf =>
            pf.exchange === "pm" && pf.pmSlug === trade.pmSlug &&
            namesMatch(pf.pmOutcome, trade.pmOutcome) && pf.price > 0
          );
          const avgPrice = pfMatch ? pfMatch.price : posAvgPrice;
          // Validate combined cost: if cost/share >= $1, the avgPrice is unreliable -- don't resolve, let hedge loop handle it.
          const pmCost = Math.round(trade.shares * avgPrice * 100) / 100;
          const totalCost = Math.round((trade.kalCost + pmCost) * 100) / 100;
          const costPerShare = totalCost / Math.max(trade.shares, 1);
          if (costPerShare >= 1) {
            console.warn(
              `[RECONCILE]   PM wallet hedge found but avgPrice unreliable: ${trade.match} -- ` +
              `${size}x${outcome} @${(avgPrice * 100).toFixed(0)}c on PM -> combined $${costPerShare.toFixed(2)}/sh >= $1.00. ` +
              `Leaving in hedge mode (max hedge price = ${((1 - trade.kalCost / Math.max(trade.shares, 1)) * 100).toFixed(0)}c).`
            );
            break;
          }
          const payout = trade.shares;
          const realizedPnl = Math.round((payout - totalCost) * 100) / 100;
          trade.status = "resolved";
          trade.resolutionMethod = "hedge-complete";
          trade.resolvedTs = new Date().toISOString();
          trade.pmFillPrice = Math.round(avgPrice * 100) / 100;
          trade.pmCost = pmCost;
          trade.totalCost = totalCost;
          trade.realizedPnl = realizedPnl;
          console.log(
            `[RECONCILE]   PM wallet hedge found: ${trade.match} -- ` +
            `${size}x${outcome} @${(avgPrice * 100).toFixed(0)}c on PM. ` +
            `Resolved: P&L=$${realizedPnl.toFixed(2)}`
          );
          staleResolved++;
          changed = true;
          break;
        }
      }
      if (trade.status !== "hedging") continue;
    }

    // (b) Fix "filled" instant-arbs -> mark resolved if both legs have prices
    if (trade.status === "filled" && trade.kalFillPrice > 0 && trade.pmFillPrice > 0 && trade.realizedPnl != null) {
      trade.status = "resolved";
      trade.resolutionMethod = "both-legs";
      trade.resolvedTs = trade.resolvedTs ?? trade.ts;
      console.log(`[RECONCILE]   Fixed status: ${trade.match} (filled->resolved)`);
      filledToResolved++;
      changed = true;
    }

    // (b2) Fix "hedging" trades that already have both legs filled but never got resolved.
    //      This happens when hedge_state.json is lost (crash/restart) -- the hedge cycle
    //      can't find the trade, so it stays stuck in "hedging" forever.
    if (trade.status === "hedging" && trade.kalCost > 0 && trade.pmCost > 0) {
      trade.status = "resolved";
      trade.resolutionMethod = "hedge-complete";
      trade.resolvedTs = trade.resolvedTs ?? new Date().toISOString();
      trade.hedgeCost = trade.initialExchange === "pm" ? trade.kalCost : trade.pmCost;
      trade.totalCost = totalCostForTrade(trade);
      trade.realizedPnl = Math.round((trade.shares - trade.totalCost) * 100) / 100;
      console.log(`[RECONCILE]   Fixed status: ${trade.match} (hedging->resolved, both legs filled: KAL=$${trade.kalCost.toFixed(2)} PM=$${trade.pmCost.toFixed(2)} P&L=$${trade.realizedPnl.toFixed(2)})`);
      filledToResolved++;
      changed = true;
    }

    // (c) Backfill missing kalCost or fix cost discrepancies using timestamp-matched fills.
    //     Skip hedge-complete trades UNLESS kalCost=0 (ghost/recovered trades resolved before backfill).
    //     Skip resolved trades UNLESS kalCost=0 (same reason -- settlement resolved before cost was known).
    const kalNeedsBackfill = trade.kalCost === 0;
    if (trade.kalTicker && (kalNeedsBackfill || (trade.resolutionMethod !== "hedge-complete" && trade.status !== "resolved"))) {
      const kalSide = kalSideForDir(trade.dir);
      const kalKey = `${trade.kalTicker}:${kalSide}`;
      const matched = matchKalFillsForTrade(kalKey, trade.ts, trade.shares);
      if (matched) {
        const avgPrice = Math.round(matched.costCents / matched.shares) / 100;
        const kalCostWithFees = Math.round((matched.costCents / 100 + matched.fees) * 100) / 100;

        if (trade.kalCost === 0 && kalCostWithFees > 0) {
          trade.kalFillPrice = avgPrice;
          trade.kalCost = kalCostWithFees;
          trade.kalFees = matched.fees;
          trade.totalCost = totalCostForTrade(trade);
          // Recalculate P&L if trade was resolved with kalCost=0 (ghost resolved before backfill)
          if (trade.status === "resolved" && trade.realizedPnl != null) {
            const hedgeCost = trade.hedgeCost ?? 0;
            const payout = trade.shares;
            const oldPnl = trade.realizedPnl;
            trade.realizedPnl = Math.round((payout - trade.kalCost - trade.pmCost - hedgeCost) * 100) / 100;
            console.log(`[RECONCILE]   Backfilled kalCost + P&L fix: ${trade.match} dir=${trade.dir} -> kalCost=$${kalCostWithFees.toFixed(2)} P&L ${oldPnl.toFixed(2)}->${trade.realizedPnl.toFixed(2)}`);
          } else {
            console.log(`[RECONCILE]   Backfilled kalCost: ${trade.match} dir=${trade.dir} -> $${kalCostWithFees.toFixed(2)} (ts-matched, fee=$${matched.fees.toFixed(2)})`);
          }
          costsCorrected++;
          changed = true;
        } else if (trade.kalCost > 0 && Math.abs(kalCostWithFees - trade.kalCost) > 0.01) {
          const oldCost = trade.kalCost;
          trade.kalCost = kalCostWithFees;
          trade.kalFillPrice = avgPrice;
          trade.totalCost = totalCostForTrade(trade);
          console.log(`[RECONCILE]   Fixed kalCost: ${trade.match} $${oldCost.toFixed(2)}->$${kalCostWithFees.toFixed(2)} (ts-matched, fee=$${matched.fees.toFixed(2)})`);
          costsCorrected++;
          changed = true;
        }
      }
    }
  }

  // (c2) PM cost repair using CLOB getTrades() API + on-chain fallback
  const pmRepairResult = await repairPmCostsFromClob(trades);
  let pmClobRepaired = pmRepairResult.repaired;
  if (pmRepairResult.changed) changed = true;

  // (d0) Fix corrupted kalCost from old settlement-based reconciler.
  //      The old reconciler used aggregate settlement data which double-counted when
  //      multiple trades shared a Kalshi ticker. Detect and fix: if kalCost is >50%
  //      above kalFillPrice x shares, it was inflated by settlement aggregation.
  let kalCostFixed = 0;
  for (const trade of trades) {
    const fp = trade.kalFillPrice ?? 0;
    const cost = trade.kalCost ?? 0;
    const sh = trade.shares ?? 0;
    if (fp > 0 && cost > 0 && sh > 0) {
      const expected = fp * sh;
      if (cost > expected * 1.5) {
        const corrected = Math.round(expected * 100) / 100;
        console.log(`[RECONCILE]   Fix kalCost: ${trade.match} -- was $${cost.toFixed(2)}, corrected to $${corrected.toFixed(2)} (${sh}x${fp})`);
        trade.kalCost = corrected;
        trade.totalCost = totalCostForTrade(trade);
        kalCostFixed++;
        changed = true;
      }
    }
  }

  // (d0b) Backfill missing fill prices and fix costs for hedge-complete trades.
  //       Determines which side was the initial entry vs the hedge using a heuristic:
  //       if kalFillPrice x shares ≈ hedgeCost, then kalFillPrice was backfilled -> PM-initial.
  //       Otherwise kalFillPrice is the real entry price -> KAL-initial.
  //       Uses hedgeCost (per-trade fill cost from resolveArbTrade) as ground truth for hedge side.
  //       NOTE: The hedge can go to EITHER exchange (KAL or PM opposite token).
  //       New trades have per-exchange cost tracking, so this heuristic is mainly for legacy data.
  for (const trade of trades) {
    const hc = trade.hedgeCost ?? 0;
    if (hc <= 0 || trade.resolutionMethod !== "hedge-complete") continue;
    const sh = trade.shares ?? 0;
    if (sh <= 0) continue;

    // Skip if costs are already set and consistent with totalCost.
    // New trades (initialExchange set) have per-exchange cost tracking from resolveArbTrade.
    // One side can be legitimately 0 when the hedge went entirely to PM opposite token,
    // so don't require both > 0 -- only require totalCost consistency.
    // Partial-fill trades can have 3 cost components: kalCost + pmCost + hedgeCost
    // (e.g., partial KAL fill + PM initial + PM opposite hedge). In that case,
    // totalCost = kalCost + pmCost + hedgeCost, and costSum < totalCost is expected.
    const costSum = Math.round(((trade.kalCost ?? 0) + (trade.pmCost ?? 0)) * 100) / 100;
    const costSumWithHedge = Math.round((costSum + (trade.hedgeCost ?? 0)) * 100) / 100;
    if (trade.initialExchange && (Math.abs(costSum - trade.totalCost) < 0.05 || Math.abs(costSumWithHedge - trade.totalCost) < 0.05)) {
      continue;
    }
    // Legacy trades (no initialExchange): require both costs > 0 to skip
    if ((trade.kalCost ?? 0) > 0 && (trade.pmCost ?? 0) > 0
      && Math.abs(costSum - trade.totalCost) < 0.05) {
      continue;
    }

    const kalFP = trade.kalFillPrice ?? 0;

    // Determine which side was initial. Use initialExchange field if present (new trades),
    // otherwise fall back to cost-based heuristic (legacy data).
    const pmFP = trade.pmFillPrice ?? 0;
    const isPmInitial = trade.initialExchange
      ? trade.initialExchange === "pm"
      : (trade.pmCost > 0 && trade.kalCost === 0)
        || (pmFP > 0 && kalFP === 0)
        || (kalFP > 0 && Math.abs(kalFP * sh - hc) < 0.10);

    if (isPmInitial) {
      // PM-initial -> hedge could be KAL or PM-opposite.
      // Without per-exchange breakdown, assume hedge went to KAL (legacy behavior).
      if (kalFP === 0) {
        trade.kalFillPrice = Math.round((hc / sh) * 100) / 100;
        changed = true;
      }
      const kalFeesLeg = trade.kalFees ?? 0;
      const correctHcKal = Math.round((hc + kalFeesLeg) * 100) / 100;
      if (Math.abs(trade.kalCost - correctHcKal) > 0.01) {
        trade.kalCost = correctHcKal;
        changed = true;
      }
      // Backfill pmCost from initialCost if still 0 (PM was initial, cost = totalCost - hedgeCost)
      if (trade.pmCost === 0 && pmFP > 0) {
        trade.pmCost = Math.round(pmFP * sh * 100) / 100;
        changed = true;
      }
    } else {
      // KAL-initial -> hedge could be PM or KAL-opposite (soccer 3-way dirs G-I).
      const kalFees = trade.kalFees ?? 0;
      const correctKalCost = Math.round((kalFP * sh + kalFees) * 100) / 100;
      if (Math.abs(trade.kalCost - correctKalCost) > 0.01) {
        trade.kalCost = correctKalCost;
        changed = true;
      }
      // Only backfill PM cost if hedge actually went to PM (not KAL-opposite).
      // If hedgeCost > 0 and pmCost === 0, check if the trade already has totalCost
      // that accounts for hedgeCost via the KAL side (totalCost ≈ kalCost + hedgeCost).
      // Soccer 3-way KAL-hedged trades have hedgeCost on the KAL side, not PM.
      const kalHedged = hc > 0 && Math.abs(trade.totalCost - (trade.kalCost + hc)) < 0.10;
      if (!kalHedged) {
        // Hedge went to PM -- backfill pmFillPrice + pmCost from hedgeCost
        if (pmFP === 0) {
          trade.pmFillPrice = Math.round((hc / sh) * 100) / 100;
          changed = true;
        }
        if (trade.pmCost === 0) {
          trade.pmCost = Math.round(hc * 100) / 100;
          changed = true;
        }
      }
    }
    // Recalculate totalCost from both sides (kalCost already includes kalFees, hedgeCost added when one leg is 0)
    const newTotal = totalCostForTrade(trade);
    if (Math.abs(trade.totalCost - newTotal) > 0.01) {
      trade.totalCost = newTotal;
      changed = true;
    }
  }

  // (d0) Repair resolved settlement trades where hedge fills were lost.
  //      If a trade was resolved as "settlement" with hedgeCost=0 and negative P&L,
  //      but Kalshi fills show buys on BOTH sides of the ticker, the hedge actually filled.
  for (const trade of trades) {
    if (trade.status !== "resolved") continue;
    if (trade.resolutionMethod !== "settlement") continue;
    if ((trade.realizedPnl ?? 0) >= 0) continue; // only repair losses
    if ((trade.hedgeCost ?? 0) > 0) continue;     // hedge already recorded
    if ((trade.pmCost ?? 0) > 0) continue;         // PM leg exists, not a one-sided KAL trade

    const kalSide = kalSideForDir(trade.dir);
    const kalOppSide = kalSide === "yes" ? "no" : "yes";
    const oppFills = fillsByTickerSide.get(`${trade.kalTicker}:${kalOppSide}`);
    if (!oppFills || oppFills.totalShares <= 0) continue;

    // Found hedge fills on opposite side that were never recorded
    const hedgeShares = Math.min(oppFills.totalShares, trade.shares);
    const hedgeProportion = hedgeShares / oppFills.totalShares;
    const hedgeCost = Math.round((oppFills.totalCostDollars + oppFills.totalFeeDollars) * hedgeProportion * 100) / 100;
    const payout = trade.shares; // both sides covered -> $1 per share
    const totalCost = Math.round((trade.kalCost + hedgeCost) * 100) / 100;
    const pnl = Math.round((payout - totalCost) * 100) / 100;

    console.log(
      `[RECONCILE]   REPAIR: ${trade.match} -- found lost KAL hedge: ${hedgeShares}x${kalOppSide.toUpperCase()} cost=$${hedgeCost.toFixed(2)}. ` +
      `P&L corrected: $${(trade.realizedPnl ?? 0).toFixed(2)} -> $${pnl.toFixed(2)}`
    );
    trade.resolutionMethod = "hedge-complete";
    trade.hedgeCost = hedgeCost;
    trade.totalCost = totalCost;
    trade.realizedPnl = pnl;
    changed = true;
    costsCorrected++;
  }

  // (d) Verify and fix P&L for all resolved trades
  const pnlResult = await verifyAndFixPnl(trades, settlementByTicker);
  let pnlFixed = pnlResult.fixed;
  if (pnlResult.changed) changed = true;

  // (e) Recover orphaned fills from pending_fills.json (crash recovery)
  // Group pending fills by ticker+slug to consolidate crash-loop duplicates into one trade.
  let recoveredFromPending = 0;
  const pendingFills = getIncompletePendingFills();
  if (pendingFills.length > 0) {
    console.log(`[RECONCILE] Found ${pendingFills.length} incomplete pending fill(s) -- checking for orphaned positions...`);

    // Group by kalTicker+pmSlug so crash-loop fills become one recovery trade
    const pfGroups = new Map<string, typeof pendingFills>();
    for (const pf of pendingFills) {
      const key = `${pf.kalTicker}||${pf.pmSlug}`;
      const group = pfGroups.get(key) ?? [];
      group.push(pf);
      pfGroups.set(key, group);
    }

    for (const [, group] of pfGroups) {
      const pf = group[0]; // use first fill for metadata (match, dir, etc.)

      // Check if a trade was already logged for this group
      const alreadyLogged = trades.some(t =>
        t.kalTicker === pf.kalTicker && t.pmSlug === pf.pmSlug &&
        Math.abs(new Date(t.ts).getTime() - new Date(pf.ts).getTime()) < 60_000
      );
      if (alreadyLogged) {
        for (const p of group) completePendingFill(p.id);
        continue;
      }

      // Check if position actually exists on the exchange
      let hasPosition = false;
      // Use sum of pending fill shares (NOT exchange position, which includes other trades)
      let actualShares = group.reduce((sum, p) => sum + p.shares, 0);
      // Weighted average price across fills
      const totalCostCents = group.reduce((sum, p) => sum + p.shares * p.price, 0);
      const avgPrice = actualShares > 0 ? Math.round(totalCostCents / actualShares * 100) / 100 : pf.price;

      if (pf.exchange === "kal") {
        const kalPos = kalPosMap.get(pf.kalTicker);
        if (kalPos && (kalPos.yesCount > 0 || kalPos.noCount > 0)) {
          hasPosition = true;
          // Cap at actual exchange position to avoid over-counting
          const exchangeShares = Math.max(kalPos.yesCount, kalPos.noCount);
          if (actualShares > exchangeShares) {
            console.log(`[RECONCILE]   NOTE: ${group.length} pending fills sum to ${actualShares} shares but exchange shows ${exchangeShares} -- using exchange count`);
            actualShares = exchangeShares;
          }
        }
      } else {
        const pmPos = pmPositions.find(p =>
          String(p.slug ?? p.marketSlug ?? "") === pf.pmSlug
        );
        if (pmPos && Number(pmPos.size ?? pmPos.amount ?? 0) >= 1) {
          hasPosition = true;
          const exchangeShares = Math.round(Number(pmPos.size ?? pmPos.amount ?? 0));
          if (actualShares > exchangeShares) {
            console.log(`[RECONCILE]   NOTE: ${group.length} pending fills sum to ${actualShares} shares but PM shows ${exchangeShares} -- using PM count`);
            actualShares = exchangeShares;
          }
        }
      }

      if (hasPosition) {
        const rawKalCost = pf.exchange === "kal" ? Math.round(actualShares * avgPrice * 100) / 100 : 0;
        const pmCost = pf.exchange === "pm" ? Math.round(actualShares * avgPrice * 100) / 100 : 0;
        // Calculate Kalshi fees: KALSHI_FEE_RATE x P x (1-P) per contract
        const kalFees = pf.exchange === "kal"
          ? Math.round(actualShares * KALSHI_FEE_RATE * avgPrice * (1 - avgPrice) * 100) / 100
          : 0;
        const kalCost = rawKalCost + kalFees; // kalCost includes fees (matches normal trade behavior)
        console.log(`[RECONCILE]   RECOVERED: ${pf.match} -- ${actualShares} shares on ${pf.exchange} @ ${avgPrice} (${group.length} pending fill(s), fees=$${kalFees.toFixed(2)})`);
        trades.push({
          id: `arb-recovered-${Date.now()}`,
          ts: pf.ts,
          match: pf.match,
          dir: pf.dir as ArbDir,
          status: "hedging",
          shares: actualShares,
          kalTicker: pf.kalTicker,
          kalFillPrice: pf.exchange === "kal" ? avgPrice : 0,
          kalCost,
          pmOutcome: pf.pmOutcome,
          pmSlug: pf.pmSlug,
          pmTokenId: pf.pmTokenId,
          pmFillPrice: pf.exchange === "pm" ? avgPrice : 0,
          pmCost,
          totalCost: kalCost + pmCost,
          projectedEdge: 0,
          projectedProfit: 0,
          initialExchange: pf.exchange,
          kalFees,
        });
        changed = true;
        recoveredFromPending++;
      }
      for (const p of group) completePendingFill(p.id);
    }
    if (recoveredFromPending > 0) {
      console.log(`[RECONCILE]   Recovered ${recoveredFromPending} orphaned trade(s) from pending fills`);
    }
  }

  // (e2) Detect & auto-recover untracked positions.
  // Positions stay on exchanges until settlement, so resolved trades still hold positions.
  // Compare exchange position vs ALL trade records (resolved + active) to find truly excess shares.
  let untrackedKal = 0;
  let untrackedPm = 0;
  let autoRecoveredPositions = 0;
  for (const [ticker, pos] of kalPosMap) {
    const posCount = Math.max(pos.yesCount, pos.noCount);
    const posSide = pos.yesCount >= pos.noCount ? "yes" : "no";
    if (posCount <= 0) continue;

    // Count shares tracked across ALL trades (resolved + active) for this ticker
    const allTrackedShares = trades
      .filter(t => t.kalTicker === ticker)
      .reduce((s, t) => s + t.shares, 0);
    const excessShares = posCount - allTrackedShares;
    if (excessShares <= 0) continue;

    // Skip if there's an active hedge on this ticker -- the hedge loop is still buying
    // contracts, so the current position count is mid-flight and will change.
    // Auto-recovering now would create duplicate hedging trades.
    const hasActiveHedge = trades.some(t => t.kalTicker === ticker && t.status === "hedging");
    if (hasActiveHedge) {
      console.log(`[RECONCILE]   Skipping KAL auto-recover for ${ticker} -- active hedge in progress (excess=${excessShares}, hedging trade exists)`);
      continue;
    }

    // We have excess Kalshi shares not accounted for in any trade record
    const resolvedRef = trades.find(t => t.kalTicker === ticker);
    if (resolvedRef) {
      // Use position's average price or fall back to trade reference
      const avgPrice = pos.avgPriceCents > 0 ? pos.avgPriceCents / 100 : resolvedRef.kalFillPrice;
      const kalFees = Math.round(excessShares * KALSHI_FEE_RATE * avgPrice * (1 - avgPrice) * 100) / 100;
      const kalCost = Math.round((excessShares * avgPrice + kalFees) * 100) / 100;

      console.log(`[RECONCILE]   AUTO-RECOVER: ${resolvedRef.match} -- ${excessShares}x ${posSide.toUpperCase()} on ${ticker} (exchange=${posCount}, tracked=${allTrackedShares}, avg ${(avgPrice * 100).toFixed(0)}c, fees=$${kalFees.toFixed(2)})`);
      trades.push({
        id: `arb-recovered-${Date.now()}-${ticker.slice(-6)}`,
        ts: new Date().toISOString(),
        match: resolvedRef.match,
        dir: resolvedRef.dir,
        status: "hedging",
        shares: excessShares,
        kalTicker: ticker,
        kalFillPrice: avgPrice,
        kalCost,
        pmOutcome: resolvedRef.pmOutcome,
        pmSlug: resolvedRef.pmSlug,
        pmTokenId: resolvedRef.pmTokenId,
        pmFillPrice: 0,
        pmCost: 0,
        totalCost: kalCost,
        projectedEdge: 0,
        projectedProfit: 0,
        initialExchange: "kal",
        kalFees,
      });
      changed = true;
      autoRecoveredPositions++;
    } else {
      console.log(`[RECONCILE]   Untracked Kalshi position: ${ticker} ${posCount}x ${posSide.toUpperCase()} (no matching resolved trade -- cannot auto-recover)`);
      untrackedKal++;
    }
  }
  for (const p of pmPositions) {
    const size = Number(p.size ?? p.amount ?? 0);
    if (size < 1) continue;
    const outcome = String(p.outcome ?? p.title ?? "");
    const slug = String(p.slug ?? p.marketSlug ?? "");
    const tracked = trades.some(t =>
      t.status !== "resolved" && (
        (slug && t.pmSlug === slug) ||
        (outcome && t.pmOutcome && namesMatch(outcome, t.pmOutcome))
      )
    );
    if (!tracked) {
      // Check if there's excess PM shares beyond what resolved trades account for
      const pmShares = Math.round(size);
      // Only auto-recover PM positions for RECENT matches (<=3 days old).
      // Older positions are likely unredeemed winning tokens -- don't hedge them.
      const slugDate = slug.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      const daysSinceMatch = slugDate
        ? (Date.now() - new Date(slugDate).getTime()) / 86_400_000
        : 999;
      if (daysSinceMatch > 3) {
        // Old match -- just log, don't create hedging trade
        console.log(`[RECONCILE]   Stale PM position: ${outcome} ${pmShares}x on ${slug} (match ${slugDate ?? "?"}, ${Math.round(daysSinceMatch)}d ago -- skipping auto-recover)`);
        continue;
      }
      // Resolved trades' PM positions are still held until settlement, so
      // only flag/recover if PM > all trades (resolved + active) for this slug
      const allTrackedPmShares = trades
        .filter(t => t.pmSlug === slug)
        .reduce((s, t) => s + t.shares, 0);
      if (pmShares > allTrackedPmShares) {
        const excess = pmShares - allTrackedPmShares;
        // Skip if there's an active hedge on this slug -- the hedge loop is still buying
        // contracts on the opposite exchange, so position counts are mid-flight.
        const hasActiveHedgePm = trades.some(t => t.pmSlug === slug && t.status === "hedging");
        if (hasActiveHedgePm) {
          console.log(`[RECONCILE]   Skipping PM auto-recover for ${slug} -- active hedge in progress (excess=${excess}, hedging trade exists)`);
          continue;
        }
        // Skip recovery for markets that already settled -- resolved trades still hold PM tokens
        // until redeemed, so excess is expected and doesn't need hedging.
        const isMarketSettled = trades.some(t =>
          t.pmSlug === slug &&
          t.status === "resolved" &&
          (t.resolutionMethod === "settlement" || t.resolutionMethod === "market-settled" || t.resolutionMethod === "both-legs")
        );
        if (isMarketSettled) {
          console.log(`[RECONCILE]   Skipping PM auto-recover for ${slug} -- market already settled (excess=${excess} PM shares)`);
          continue;
        }
        const resolvedRef = trades.find(t => t.pmSlug === slug);
        if (resolvedRef) {
          // Try actual fill price from pending_fills first (PM positions API avgPrice can be market price, not cost basis)
          const pfMatch = loadPendingFills().find(pf =>
            pf.exchange === "pm" && pf.pmSlug === slug && pf.pmOutcome === outcome && pf.price > 0
          );
          const estPriceRaw = pfMatch?.price || resolvedRef.pmFillPrice || resolvedRef.kalFillPrice || (resolvedRef.totalCost > 0 ? resolvedRef.totalCost / Math.max(resolvedRef.shares, 1) : 0);
          // Cap estPrice: if it would make combined cost >= $1/share, use a conservative estimate instead.
          // The hedge loop will enforce the real max via maxKalPrice = 1 - pmCostBasis - edge.
          const estPrice = estPriceRaw < 1 - MIN_EDGE ? estPriceRaw : 0;
          const pmCost = Math.round(excess * estPrice * 100) / 100;
          console.log(`[RECONCILE]   AUTO-RECOVER: ${excess} excess PM ${outcome} shares on ${slug} (est. $${estPrice}/share${pfMatch ? " from pending fill" : ""})`);
          trades.push({
            id: `arb-recovered-${Date.now()}-pm`,
            ts: new Date().toISOString(),
            match: resolvedRef.match,
            dir: resolvedRef.dir,
            status: "hedging",
            shares: excess,
            kalTicker: resolvedRef.kalTicker,
            kalFillPrice: 0,
            kalCost: 0,
            pmOutcome: outcome,
            pmSlug: slug,
            pmTokenId: resolvedRef.pmTokenId,
            pmFillPrice: estPrice,
            pmCost,
            totalCost: pmCost,
            projectedEdge: 0,
            projectedProfit: 0,
            initialExchange: "pm",
          });
          changed = true;
          autoRecoveredPositions++;
        } else {
          console.log(`[RECONCILE]   Untracked PM position: ${outcome} ${excess}x excess on ${slug} (no trade ref -- cannot auto-recover)`);
          untrackedPm++;
        }
      }
    }
  }

  // Defensive invariant: totalCost MUST equal kalCost + pmCost (+ hedgeCost when one leg is 0) for resolved trades.
  // kalCost already includes kalFees (baked in at resolve time). hedgeCost is only additive for hedge-only legs.
  for (const trade of trades) {
    if (trade.status !== "resolved") continue;
    const expected = totalCostForTrade(trade);
    if (Math.abs(trade.totalCost - expected) > 0.01) {
      console.log(`[RECONCILE]   Invariant fix: ${trade.match} totalCost $${trade.totalCost.toFixed(2)}->$${expected.toFixed(2)} (kalCost+hedgeCost+pmCost)`);
      trade.totalCost = expected;
      changed = true;
    }
    // Also fix P&L if it doesn't match shares - totalCost
    if (trade.realizedPnl != null) {
      const correctPnl = Math.round((trade.shares - expected) * 100) / 100;
      if (Math.abs(trade.realizedPnl - correctPnl) > 0.01) {
        console.log(`[RECONCILE]   P&L fix: ${trade.match} realizedPnl $${trade.realizedPnl.toFixed(2)}->$${correctPnl.toFixed(2)}`);
        trade.realizedPnl = correctPnl;
        changed = true;
      }
    }
  }

  if (changed && !DRY_RUN) {
    saveArbTrades(trades);
    writeReconcileAudit(trades);
  }
  // Signal the hedge loop to re-scan for new hedging trades created by auto-recovery
  if (autoRecoveredPositions > 0) {
    _reconcileRecoveredTrades = true;
  }
  console.log(
    `[RECONCILE] Done: ${staleResolved} stale resolved, ${filledToResolved} filled->resolved, ` +
    `${kalCostFixed} kalCost fixed, ${costsCorrected} costs corrected, ${pnlFixed} P&L fixed, ` +
    `${pmClobRepaired} PM cost repaired, ${untrackedKal} untracked KAL, ` +
    `${untrackedPm} untracked PM, ${recoveredFromPending} recovered from pending, ` +
    `${autoRecoveredPositions} auto-recovered positions`
  );
}

// --- Hedge state persistence -------------------------------------------------

function loadHedgeStates(): HedgeState[] {
  try {
    if (!fs.existsSync(HEDGE_STATE_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(HEDGE_STATE_PATH, "utf8"));

    // Backwards compat: old format was a single PersistedHedgeEntry object, new format is array.
    const entries: PersistedHedgeEntry[] = Array.isArray(raw) ? raw : [raw];

    const result: HedgeState[] = [];
    for (const entry of entries) {
      if (!entry.position || entry.position.sharesHeld <= 0) continue;
      // Backwards compat: old hedge states won't have tradeId -- match from arb_trades.json
      if (!entry.position.tradeId) {
        const trades = loadArbTrades();
        const match = trades.find(t => t.kalTicker === entry.position.kalLeg?.ticker && t.status === "hedging");
        entry.position.tradeId = match?.id ?? `arb-recovered-${Date.now()}`;
      }
      // Backwards compat: old hedge states won't have kalSide -- default to "yes"
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

// --- PM position helpers (module-level, shared by executeArb + monitorLoop) --

let _pmPosCache: { data: PmPosition[]; ts: number } | null = null;
let _cachedFunder: string | null = null;
function getPmFunder(): string {
  if (_cachedFunder) return _cachedFunder;
  const w = new Wallet(process.env.POLY_WALLET_PRIVATE_KEY ?? "");
  _cachedFunder = process.env.POLY_FUNDER || w.address;
  return _cachedFunder;
}

async function fetchPmPositionsCached(maxAgeMs = 5000): Promise<PmPosition[]> {
  if (_pmPosCache && Date.now() - _pmPosCache.ts < maxAgeMs) return _pmPosCache.data;
  const f = getPmFunder();
  const db = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
  const raw = await polyFetch<unknown>(`${db}/positions?user=${encodeURIComponent(f)}&sizeThreshold=0.1`);
  const data: PmPosition[] = Array.isArray(raw) ? (raw as PmPosition[]) :
    Array.isArray((raw as { positions?: unknown[] })?.positions) ? ((raw as { positions: PmPosition[] }).positions) : [];
  _pmPosCache = { data, ts: Date.now() };
  return data;
}

function sumPmHeld(pmPositions: PmPosition[], tokenId: string): number {
  return Math.round(pmPositions.reduce((sum, p) => {
    const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
    const sz = Number(p.size ?? p.amount ?? 0);
    return tid === tokenId ? sum + sz : sum;
  }, 0));
}

// --- Execution ----------------------------------------------------------------

function extractPmMeta(v: unknown) {
  if (!v || typeof v !== "object") return {};
  const obj = v as PmOrderResponse;
  // Check nested .order field -- some SDK versions wrap the response
  const inner = obj.order ?? obj;
  const txHashes = inner.transactionsHashes ?? obj.transactionsHashes;
  const txHash = Array.isArray(txHashes) ? txHashes[0] : inner.transactionHash ?? obj.transactionHash ?? obj.txHash;
  const orderId = inner.orderID ?? inner.orderId ?? obj.orderID ?? obj.orderId;
  const status = inner.status ?? obj.status;
  return { orderId, status, txHash };
}

function extractKalMeta(v: unknown): { orderId: unknown; status: unknown; filled: number; fees: number; fillCostCents: number } {
  if (!v || typeof v !== "object") return { orderId: null, status: null, filled: 0, fees: 0, fillCostCents: 0 };
  const obj = v as KalshiOrder;
  const order = obj.order ?? obj;
  // Kalshi API returns _fp (string) fields; older responses use integer cents fields
  const rawFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled_contracts ?? order.filled ?? 0);
  const filled = Number.isFinite(rawFilled) ? rawFilled : 0;
  // Fees: _dollars fields are dollar strings, legacy fields are integer cents
  const takerFeesDollars = Number(order.taker_fees_dollars ?? 0);
  const makerFeesDollars = Number(order.maker_fees_dollars ?? 0);
  const takerFeesCents = Number(order.taker_fees ?? 0);
  const makerFeesCents = Number(order.maker_fees ?? 0);
  const rawFees = (takerFeesDollars + makerFeesDollars) || ((takerFeesCents + makerFeesCents) / 100);
  const fees = Number.isFinite(rawFees) ? rawFees : 0;
  // Fill cost: _dollars fields are dollar strings, legacy fields are integer cents
  const takerFillCostDollars = Number(order.taker_fill_cost_dollars ?? 0);
  const makerFillCostDollars = Number(order.maker_fill_cost_dollars ?? 0);
  const takerFillCostCents = Number(order.taker_fill_cost ?? 0);
  const makerFillCostCents = Number(order.maker_fill_cost ?? 0);
  const rawFillCost = (takerFillCostDollars + makerFillCostDollars) * 100 || (takerFillCostCents + makerFillCostCents);
  const fillCostCents = Number.isFinite(rawFillCost) ? rawFillCost : 0;
  return { orderId: order.order_id ?? order.orderId, status: order.status, filled, fees, fillCostCents };
}

// Returns sessionSkip + an UnhedgedPosition if one leg filled but the other didn't
async function executeArb(
  entry: WatchEntry,
  dir: ArbDir,   // Tennis/NBA: A-D | Soccer 2-leg NO: G-I | Soccer 3-leg: A-F (future)
  kalAsk: number,
  pmAsk: number,
  edge: number
): Promise<{ sessionSkip: boolean; unhedged: UnhedgedPosition | null; abortReason?: string }> {
  const execStart = performance.now();
  let tPmOrder = 0, tPmPoll = 0, tKalBook = 0, tKalOrder = 0, tKalVerify = 0, tPmVerify = 0;
  let tPreflight = 0, tDepthCheck = 0;
  let kalFeesTotal = 0; // actual Kalshi fees in dollars (from order response)
  let kalFillCostCents = 0; // actual Kalshi fill cost in cents (from order response)
  let kalFilled = 0; // actual Kalshi filled count
  let kalFilledViaMaker = false;
  const printTimings = () => {
    const total = performance.now() - execStart;
    const parts = [
      tPreflight > 0 ? `preflight=${tPreflight.toFixed(0)}ms` : null,
      tDepthCheck > 0 ? `depth=${tDepthCheck.toFixed(0)}ms` : null,
      tPmOrder > 0 ? `pm_order=${tPmOrder.toFixed(0)}ms` : null,
      tPmPoll > 0 ? `pm_poll=${tPmPoll.toFixed(0)}ms` : null,
      tKalBook > 0 ? `kal_book=${tKalBook.toFixed(0)}ms` : null,
      tKalOrder > 0 ? `kal_order=${tKalOrder.toFixed(0)}ms` : null,
      tKalVerify > 0 ? `kal_verify=${tKalVerify.toFixed(0)}ms` : null,
      tPmVerify > 0 ? `pm_verify=${tPmVerify.toFixed(0)}ms` : null,
    ].filter(Boolean).join("  ");
    console.log(`  [TIMING] Total=${total.toFixed(0)}ms  ${parts}`);
  };
  // -- Execution metric (recorded at every return) --------------------------
  const metric: ExecMetric = {
    id: `exec-${Date.now()}`,
    ts: new Date().toISOString(),
    match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
    dir, edge, shares: 0,
    firstLeg: "pm",
    outcome: "abort-safety",
    firstLegFilled: 0, secondLegFilled: 0,
    expectedKalPrice: kalAsk, expectedPmPrice: pmAsk,
    totalMs: 0,
    firstLegOrderMs: 0, firstLegConfirmMs: 0,
    secondLegOrderMs: 0, secondLegConfirmMs: 0,
    bookFetchMs: 0,
    dryRun: DRY_RUN,
  };
  const saveExecMetric = (outcome: ExecMetric["outcome"], failReason?: string) => {
    metric.outcome = outcome;
    if (failReason) metric.failReason = failReason;
    metric.totalMs = Math.round(performance.now() - execStart);
    const pmIsFirst = metric.firstLeg === "pm";
    metric.firstLegOrderMs = Math.round(pmIsFirst ? tPmOrder : tKalOrder);
    metric.firstLegConfirmMs = Math.round(pmIsFirst ? tPmPoll : tKalVerify);
    metric.secondLegOrderMs = Math.round(pmIsFirst ? tKalOrder : tPmOrder);
    metric.secondLegConfirmMs = Math.round(pmIsFirst ? tKalVerify : tPmPoll);
    metric.bookFetchMs = Math.round(tKalBook);
    metric.preflightMs = Math.round(tPreflight);
    metric.depthCheckMs = Math.round(tDepthCheck);
    metric.postVerifyMs = Math.round(tPmVerify);
    appendMetric(metric);
    // Clear pending fill on abort -- no exposure was taken.
    // EXCEPTION: "pm-delayed-zero" means the PM order timed out but may still settle on-chain later.
    // Keep the pending fill incomplete so the WSS ghost fill detector can catch it.
    if (outcome.startsWith("abort") && _activePendingFillId) {
      if (failReason === "pm-delayed-zero") {
        console.log(`[PENDING] Keeping pending fill ${_activePendingFillId} open -- order may still settle on-chain (ghost fill watch active).`);
      } else {
        completePendingFill(_activePendingFillId);
      }
      _activePendingFillId = null;
    }
  };

  // Direction mapping:
  //   2-way (tennis/NBA):
  //     A: buy KAL P1 YES + buy PM P2     B: buy KAL P2 YES + buy PM P1
  //     C: buy KAL P1 NO  + buy PM P1     D: buy KAL P2 NO  + buy PM P2
  //   3-way soccer (KAL NO side):
  //     G: buy KAL Home NO  + buy PM Home YES    (kal1 NO + pm1)
  //     H: buy KAL Draw NO  + buy PM Draw YES    (kal3 NO + pm3)
  //     I: buy KAL Away NO  + buy PM Away YES    (kal2 NO + pm2)
  //   3-way soccer (PM NO side):
  //     J: buy KAL Home YES + buy PM Home NO     (kal1 YES + pm1 NO token)
  //     K: buy KAL Draw YES + buy PM Draw NO     (kal3 YES + pm3 NO token)
  //     L: buy KAL Away YES + buy PM Away NO     (kal2 YES + pm2 NO token)
  let kalSide: "yes" | "no";
  let kalLeg: KalshiLeg;
  let pmLeg: PmLeg;
  if (dir === "G") {
    kalSide = "no"; kalLeg = entry.kal1; pmLeg = entry.pm1;
  } else if (dir === "H") {
    kalSide = "no"; kalLeg = entry.kal3!; pmLeg = entry.pm3!;
  } else if (dir === "I") {
    kalSide = "no"; kalLeg = entry.kal2; pmLeg = entry.pm2;
  } else if (dir === "J") {
    // KAL Home YES + PM Home NO -- swap pmLeg tokenId to the NO token
    kalSide = "yes"; kalLeg = entry.kal1;
    pmLeg = { ...entry.pm1, tokenId: entry.pm1.noTokenId!, outcome: `${entry.pm1.outcome} [NO]` };
  } else if (dir === "K") {
    kalSide = "yes"; kalLeg = entry.kal3!;
    pmLeg = { ...entry.pm3!, tokenId: entry.pm3!.noTokenId!, outcome: `${entry.pm3!.outcome} [NO]` };
  } else if (dir === "L") {
    kalSide = "yes"; kalLeg = entry.kal2;
    pmLeg = { ...entry.pm2, tokenId: entry.pm2.noTokenId!, outcome: `${entry.pm2.outcome} [NO]` };
  } else {
    // -- SAFETY: binary markets only allow dirs A and C ----------------------
    // Dirs B/D on binary are same-outcome bets (not arbs) -- never execute them.
    if (entry.isBinary && (dir === "B" || dir === "D")) {
      console.error(`\n[SAFETY ABORT] Binary market cannot execute dir ${dir} (only A/C are valid arbs)\n`);
      saveExecMetric("abort-safety", "binary-invalid-dir");
      return { sessionSkip: true, unhedged: null };
    }
    kalSide = kalSideForDir(dir);
    kalLeg  = (dir === "A" || dir === "C") ? entry.kal1 : entry.kal2;
    pmLeg   = (dir === "A" || dir === "D") ? entry.pm2  : entry.pm1;
  }

  // -- SAFETY: abort if token mapping looks wrong -------------------------------
  // Dirs A/B: KAL and PM should be DIFFERENT players (opposite outcomes)
  // Dirs C/D: KAL and PM should be the SAME player (KAL NO + PM YES)
  // Soccer G-L: KAL and PM are same outcome on same market -- skip name check entirely
  // Binary (isBinary): KAL and PM outcomes don't use player names (Over/Under, Yes/No) -- skip
  const isSoccer2Leg = dir === "G" || dir === "H" || dir === "I" || dir === "J" || dir === "K" || dir === "L";
  const skipNameCheck = isSoccer2Leg || !!entry.isBinary;
  const execSeriesPrefix = (entry.kal1.ticker.split("-")[0] ?? "").toUpperCase();
  // For NBA/MLB: namesMatch("Washington","Wizards") fails -- use abbreviation fallback
  const nbaNameMatch = NBA_SERIES.has(execSeriesPrefix) &&
    nbaNameToAbbr(kalLeg.surname) !== "" &&
    nbaNameToAbbr(kalLeg.surname) === nbaNameToAbbr(pmLeg.outcome);
  const mlbNameMatch = MLB_SERIES.has(execSeriesPrefix) &&
    mlbNameToAbbr(kalLeg.surname) !== "" &&
    mlbNameToAbbr(kalLeg.surname) === mlbNameToAbbr(pmLeg.outcome);
  const cbbNameMatch = CBB_SERIES.has(execSeriesPrefix) && cbbNamesMatch(kalLeg.surname, pmLeg.outcome);
  const sameName = skipNameCheck ? true : (namesMatch(kalLeg.surname, pmLeg.outcome) || nbaNameMatch || mlbNameMatch || cbbNameMatch);
  // For A/B: expect different names. For C/D: expect same names.
  // For soccer G-L and binary: sameName is forced true -- expectSame must also be true to pass.
  const expectSame = skipNameCheck ? true : (kalSide === "no");
  if (sameName !== expectSame) {
    console.error(
      `\n[SAFETY ABORT] Token mapping error! KAL=${kalLeg.surname}(${kalSide}) PM=${pmLeg.outcome}` +
      ` (dir=${dir}). Expected ${expectSame ? "same" : "different"} player names.` +
      `\n  kal1=${entry.kal1.surname} kal2=${entry.kal2.surname}` +
      `\n  pm1=${entry.pm1.outcome} (${entry.pm1.tokenId.slice(0,12)}...)` +
      `\n  pm2=${entry.pm2.outcome} (${entry.pm2.tokenId.slice(0,12)}...)\n`
    );
    saveExecMetric("abort-safety", "token-mapping");
    return { sessionSkip: true, unhedged: null };
  }

  // -- SAFETY: abort if edge is unrealistically large (> 45%) -----------------
  // Esports/tennis markets can have 20-35% legitimate cross-platform disagreements
  // due to thin liquidity and different user bases. Only block truly absurd edges.
  if (edge > 0.45) {
    console.error(
      `\n[SAFETY ABORT] Edge ${fmtPct(edge, 2)} exceeds 45% -- likely token price mapping error.` +
      ` KAL=${kalLeg.surname}@${fmtPct(kalAsk)} PM=${pmLeg.outcome}@${fmtPct(pmAsk)}\n`
    );
    saveExecMetric("abort-safety", "edge-too-large");
    return { sessionSkip: true, unhedged: null };
  }

  // -- SAFETY: abort if Kalshi market is cancelled/scalar-settled --------------
  // Before spending money, verify the Kalshi market is actually open and tradeable.
  // A market that settled as "scalar" (cancelled/voided) breaks the $1 arb guarantee.
  // Also block sibling markets (same date + series) -- Kalshi re-lists cancelled matches
  // with new tickers (e.g. FNMKOI -> FNKOIA) which will likely cancel again.
  if (_cancelledTickers.has(kalLeg.ticker)) {
    console.warn(`[SAFETY ABORT] ${kalLeg.ticker} already flagged as cancelled/scalar. Skipping.`);
    saveExecMetric("abort-safety", "market-cancelled");
    return { sessionSkip: true, unhedged: null };
  }
  const eventDateKey = extractEventDateKey(kalLeg.ticker);
  if (_cancelledEventKeys.has(eventDateKey)) {
    console.warn(
      `[SAFETY ABORT] ${kalLeg.ticker} shares event date key "${eventDateKey}" with a cancelled market. ` +
      `Sibling market likely to also cancel. Skipping.`
    );
    saveExecMetric("abort-safety", "sibling-cancelled");
    return { sessionSkip: true, unhedged: null };
  }
  if (!DRY_RUN) {
    const _tPre0 = performance.now();
    try {
      const preflightMkt = await fetchKalshiMarket(kalLeg.ticker);
      tPreflight = performance.now() - _tPre0;
      const preflightStatus = pickString(preflightMkt.status ?? preflightMkt.state ?? "").toLowerCase();
      const preflightResult = pickString(preflightMkt.result ?? "").toLowerCase();
      if (preflightStatus !== "active" && preflightStatus !== "open") {
        console.error(
          `\n[SAFETY ABORT] Kalshi market ${kalLeg.ticker} is ${preflightStatus} (result=${preflightResult || "none"}).` +
          ` Cannot trade a non-active market.\n`
        );
        if (preflightResult === "scalar") {
          _cancelledTickers.add(kalLeg.ticker);
          _cancelledEventKeys.add(extractEventDateKey(kalLeg.ticker));
        }
        saveExecMetric("abort-safety", `market-${preflightStatus}`);
        return { sessionSkip: true, unhedged: null };
      }
    } catch {
      tPreflight = performance.now() - _tPre0;
      // If we can't verify, proceed cautiously -- the order will fail anyway if market is closed
    }
  }

  // Sizing: budget-limited, capped by MAX_CONTRACTS, floored by PM minSize AND PM $1 order value
  const costPerShare = kalAsk + pmAsk;
  const sharesByBudget = Math.max(1, Math.floor(TRADE_USD / costPerShare));
  let shares = Math.min(sharesByBudget, MAX_CONTRACTS);

  // Effective PM minimum: per-market minSize (typically 5 shares) + PM $1 FOK floor
  const pmMinByFOK = pmAsk > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pmAsk) : pmLeg.minSize;
  const effectivePmMin = Math.max(pmLeg.minSize, pmMinByFOK);

  if (shares < effectivePmMin) {
    const minCost = effectivePmMin * costPerShare;
    if (effectivePmMin > MAX_CONTRACTS || minCost > TRADE_USD * 2) {
      console.warn(
        `  [SKIP] PM effective min=${effectivePmMin} (minSize=${pmLeg.minSize})` +
        ` cost=$${minCost.toFixed(2)} exceeds budget $${TRADE_USD}. PM ask too low.`
      );
      metric.shares = shares;
      saveExecMetric("abort-pre-first", "pm-min-exceeds-budget");
      return { sessionSkip: false, unhedged: null, abortReason: "soft" };
    }
    shares = effectivePmMin;
  }

  let totalCost = shares * costPerShare;
  let projectedProfit = shares * edge;
  // -- Momentum-based leg ordering --------------------------------------------
  // Determine which side's ask is rising (getting more expensive / escaping from us).
  // Buy the "hotter" side first -- if its ask is spiking, grab it before it's worse.
  // The other side is stable or getting cheaper and will likely still be there.
  // PM-first is safer (failed fill = zero exposure) but subject to 3s sports delay.
  // KAL-first is faster (instant fill) but commits capital before PM confirms.
  const kalMomentumKey = `kal:${kalLeg.ticker}:${kalSide}`;
  const pmMomentumKey = `pm:${pmLeg.tokenId}`;
  const kalMom = getMomentum(kalMomentumKey);
  const pmMom = getMomentum(pmMomentumKey);
  // Positive momentum = price rising = getting more expensive for us
  // Buy the side that is rising faster first. Default to PM-first when equal
  // (PM has thinner books and 3s sports delay means failed fill costs nothing).
  const pmFirst = pmMom >= kalMom; // PM rising more (or both equal) -> PM first
  metric.shares = shares;
  metric.firstLeg = pmFirst ? "pm" : "kal";

  const tag = DRY_RUN ? "[DRY]" : "[LIVE]";
  const momTag = `kalMom=${kalMom >= 0 ? "+" : ""}${(kalMom * 100).toFixed(1)}c pmMom=${pmMom >= 0 ? "+" : ""}${(pmMom * 100).toFixed(1)}c`;
  console.log(
    `\n${ts()} ${tag} ARB EXECUTE  dir=${dir}  edge=${fmtPct(edge, 2)}` +
    `  shares=${shares}  cost~=$${totalCost.toFixed(2)}  profit~=$${projectedProfit.toFixed(2)}` +
    `  order=${pmFirst ? "PM->KAL" : "KAL->PM"}  ${momTag}`
  );
  console.log(`  KAL: ${kalLeg.ticker} ${kalSide.toUpperCase()} @${fmtPct(kalAsk)}`);
  console.log(`  PM:  ${entry.pmSlug} outcome=${pmLeg.outcome} @${fmtPct(pmAsk)}`);

  const kalLimitCents = Math.max(1, Math.min(99, Math.floor((1 - pmAsk - MIN_EDGE) * 100)));
  const kalLimitPrice = kalLimitCents / 100;

  // -- PRE-FLIGHT DEPTH CHECK + FULL DEPTH OPPORTUNITY LOG ---------------------
  // Verify BOTH exchanges have sufficient liquidity before placing any orders.
  // Also log the FULL profitable depth available (beyond our budget) to assess
  // whether more capital would capture larger opportunities.
  if (MIN_DEPTH_MULT > 0 && !DRY_RUN) {
    const _tDepth0 = performance.now();
    const requiredDepth = shares * MIN_DEPTH_MULT;
    const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

    // Check both sides: WS first, REST fallback
    let kalBook = getWsKalBook(kalLeg.ticker);
    let pmAskLevels = getWsPmAsks(pmLeg.tokenId) ?? [];
    const wsHadKal = !!kalBook, wsHadPm = pmAskLevels.length > 0;
    if (!kalBook || pmAskLevels.length === 0) {
      const [restKal, restPm] = await Promise.all([
        !kalBook ? fetchKalshiOrderbook(kalLeg.ticker).catch(() => null) : null,
        pmAskLevels.length === 0 ? fetchPmAskDepth(pmLeg.tokenId, clobBase) : [],
      ]);
      if (!kalBook && restKal) kalBook = restKal;
      if (pmAskLevels.length === 0 && restPm && restPm.length > 0) pmAskLevels = restPm;
    }
    tDepthCheck = performance.now() - _tDepth0;
    if (wsHadKal || wsHadPm) console.log(`  [DEPTH] WS data: KAL=${wsHadKal ? "yes" : "no"} PM=${wsHadPm ? "yes" : "no"}`);

    // Compute max profitable prices for full depth sweep
    // KAL max: kalLimitCents (already = floor((1 - pmAsk - MIN_EDGE) x 100))
    // PM max: 1 - kalAsk - MIN_EDGE (what PM price still leaves MIN_EDGE profit)
    const pmBreakevenPrice = 1 - kalAsk - MIN_EDGE;

    // Sweep FULL profitable depth (no qty cap)
    let kalFull = { levels: [] as DepthLevel[], totalQty: 0, totalCost: 0, avgPrice: 0 };
    let pmFull = { levels: [] as DepthLevel[], totalQty: 0, totalCost: 0, avgPrice: 0 };
    let kalAskLevelsForCheck: [number, number][] = [];

    if (kalBook) {
      kalAskLevelsForCheck = kalSide === "yes"
        ? deriveYesAsks(kalBook.no)
        : deriveNoAsks(kalBook.yes);

      // If the orderbook-derived levels are empty but the market listing reports
      // an ask with known size (yes_ask_size_fp), inject a synthetic level.
      // This fixes the common case where a YES sell order exists but shows no NO bids.
      if (kalAskLevelsForCheck.length === 0) {
        const listingAskPrice = kalSide === "yes" ? kalLeg.yesAsk : kalLeg.noAsk;
        const listingAskSize = (kalSide === "yes" ? kalLeg.yesAskSize : kalLeg.noAskSize) ?? 0;
        console.log(`  [DEPTH FIX] Orderbook derived empty. kalSide=${kalSide} listingPrice=${(listingAskPrice*100).toFixed(0)}c listingSize=${listingAskSize} bookYes=${kalBook.yes.length}lvls bookNo=${kalBook.no.length}lvls`);
        if (listingAskSize > 0 && listingAskPrice > 0 && listingAskPrice < 1) {
          const priceCents = Math.round(listingAskPrice * 100);
          kalAskLevelsForCheck = [[priceCents, listingAskSize]];
          console.log(`  [DEPTH FIX] Orderbook empty but market lists ${kalSide} ask: ${listingAskSize} contracts @ ${priceCents}c -- using listing data`);
        }
      }

      kalFull = sweepFullProfitableDepth(kalAskLevelsForCheck, kalLimitCents, true);
    }
    if (pmAskLevels.length > 0) {
      pmFull = sweepFullProfitableDepth(pmAskLevels, pmBreakevenPrice, false);
    }

    // Log helper -- called on both abort and proceed
    const matchName = `${entry.kal1.surname} vs ${entry.kal2.surname}`;
    const logDepthOpp = (outcome: "executed" | "aborted", failReason?: string) => {
      const maxShares = Math.min(kalFull.totalQty, pmFull.totalQty);
      const avgCostPerShare = (kalFull.avgPrice || kalAsk) + (pmFull.avgPrice || pmAsk);
      const maxUsd = maxShares * avgCostPerShare;
      // Compute projected P&L by walking levels pair-wise (not averages).
      // Each level-pair: pnl = min(kalQty, pmQty) * (1 - kalPrice - pmPrice - fees(kalPrice, pmPrice))
      // Only count positive-edge pairs.
      let projPnl = 0;
      if (kalFull.levels.length > 0 && pmFull.levels.length > 0) {
        let ki = 0, pi = 0;
        let kalRem = kalFull.levels[0]?.size ?? 0;
        let pmRem = pmFull.levels[0]?.size ?? 0;
        while (ki < kalFull.levels.length && pi < pmFull.levels.length) {
          const kp = kalFull.levels[ki].price;
          const pp = pmFull.levels[pi].price;
          const pairEdge = 1 - kp - pp - estimateFees(kp, pp);
          const qty = Math.min(kalRem, pmRem);
          if (pairEdge > 0) projPnl += qty * pairEdge;
          kalRem -= qty;
          pmRem -= qty;
          if (kalRem <= 0) { ki++; if (ki >= kalFull.levels.length) break; kalRem = kalFull.levels[ki].size; }
          if (pmRem <= 0) { pi++; if (pi >= pmFull.levels.length) break; pmRem = pmFull.levels[pi].size; }
        }
      } else if (maxShares > 0) {
        // Fallback: single-level estimate
        const avgEdge = 1 - (kalFull.avgPrice || kalAsk) - (pmFull.avgPrice || pmAsk) - estimateFees(kalFull.avgPrice || kalAsk, pmFull.avgPrice || pmAsk);
        projPnl = maxShares * Math.max(0, avgEdge);
      }
      const opp: DepthOpportunity = {
        id: `depth-${Date.now()}`,
        ts: new Date().toISOString(),
        match: matchName, dir, edge, kalAsk, pmAsk,
        outcome, failReason,
        kalLevels: kalFull.levels,
        kalTotalContracts: kalFull.totalQty,
        kalTotalCostUsd: Math.round(kalFull.totalCost * 100) / 100,
        kalAvgPrice: Math.round(kalFull.avgPrice * 10000) / 10000,
        pmLevels: pmFull.levels,
        pmTotalShares: pmFull.totalQty,
        pmTotalCostUsd: Math.round(pmFull.totalCost * 100) / 100,
        pmAvgPrice: Math.round(pmFull.avgPrice * 10000) / 10000,
        maxProfitableShares: maxShares,
        maxInvestableUsd: Math.round(maxUsd * 100) / 100,
        projectedPnlUsd: Math.round(projPnl * 100) / 100,
        budgetShares: shares,
      };
      appendDepthOpportunity(opp);
      if (maxShares > shares) {
        console.log(`  [DEPTH OPP] Full profitable depth: ${maxShares} shares (we trade ${shares}) | investable=$${maxUsd.toFixed(2)} | projected P&L=$${projPnl.toFixed(2)}`);
      }
    };

    // Kalshi depth -- sweep available liquidity
    let kalAvail = 0;
    {
      if (kalAskLevelsForCheck.length > 0) {
        // Sweep ALL profitable depth (no cap) to know total available
        kalAvail = kalFull.totalQty;
      }
      // If orderbook sweep found nothing, try market listing as fallback.
      if (kalAvail === 0) {
        const listingAskQty = (kalSide === "yes" ? kalLeg.yesAskSize : kalLeg.noAskSize) ?? 0;
        const listingPriceCents = Math.round((kalSide === "yes" ? kalLeg.yesAsk : kalLeg.noAsk) * 100);
        if (listingAskQty > 0 && listingPriceCents <= kalLimitCents) {
          kalAvail = listingAskQty;
          kalAskLevelsForCheck = [[listingPriceCents, listingAskQty]];
          kalFull = sweepFullProfitableDepth(kalAskLevelsForCheck, kalLimitCents, true);
          console.log(`  [DEPTH FIX] Orderbook empty but market lists ${kalSide} ask: ${listingAskQty} contracts @ ${listingPriceCents}c`);
        }
      }
    }

    // PM depth -- sweep available liquidity
    let pmAvail = 0;
    if (pmAskLevels.length > 0) {
      pmAvail = pmFull.totalQty;
    }

    // Dynamic share sizing: reduce shares to match available depth instead of aborting
    const maxByDepth = MIN_DEPTH_MULT > 0
      ? Math.floor(Math.min(kalAvail, pmAvail) / MIN_DEPTH_MULT)
      : Infinity;
    const originalShares = shares;

    if (maxByDepth < shares) {
      if (maxByDepth < effectivePmMin) {
        // Not enough depth even for minimum PM order -- abort
        const limitingSide = kalAvail < pmAvail ? "kal" : "pm";
        const limitingAvail = Math.min(kalAvail, pmAvail);
        console.log(`  [DEPTH CHECK] Insufficient depth: ${limitingSide}=${limitingAvail} -> max ${maxByDepth} shares (need >=${effectivePmMin} for PM min). Skipping.`);
        logDepthOpp("aborted", `${limitingSide}-depth-insufficient`);
        saveExecMetric("abort-pre-first", `${limitingSide}-depth-insufficient`);
        return { sessionSkip: false, unhedged: null, abortReason: "soft" };
      }
      // Reduce shares to match depth
      shares = maxByDepth;
      metric.shares = shares;
      totalCost = shares * costPerShare;
      projectedProfit = shares * edge;
      console.log(`  [DEPTH] Adjusted shares: ${originalShares} -> ${shares} (KAL depth=${kalAvail}, PM depth=${pmAvail}, mult=${MIN_DEPTH_MULT}x)`);
      console.log(`  [DEPTH] New cost=$${totalCost.toFixed(2)}  profit=$${projectedProfit.toFixed(2)}`);
    } else {
      console.log(`  [DEPTH CHECK] OK: KAL=${kalAvail} PM=${pmAvail} (need ${requiredDepth} for ${shares} shares x ${MIN_DEPTH_MULT})`);
    }

    if (pmAskLevels.length === 0) {
      console.log(`  [DEPTH CHECK] PM book unavailable -- skipping depth check for PM side.`);
    }

    // Both sides passed -- log as executed opportunity
    logDepthOpp("executed");
  }

  // Helper: build a UnhedgedPosition when one leg is held and the other is missing.
  // pmOppLeg: when holding a PM token, the opposite PM outcome can also complete the arb
  //   Dir A: pmLeg=pm2 (held), pmOppLeg=pm1 (can buy pm1 to own both -> guaranteed $1)
  //   Dir B: pmLeg=pm1 (held), pmOppLeg=pm2
  const makeUnhedged = (held: "pm" | "kal", sharesHeld: number): UnhedgedPosition => {
    // Use actual Kalshi fill cost if available
    const kalRawCostHedge = held === "kal"
      ? (kalFillCostCents > 0 ? kalFillCostCents / 100 : sharesHeld * kalAsk)
      : 0;
    const kalCostHedge = held === "kal"
      ? Math.round((kalRawCostHedge + kalFeesTotal) * 100) / 100
      : 0;
    const actualKalPrice = held === "kal" && kalFillCostCents > 0 && kalFilled > 0
      ? Math.round((kalFillCostCents / 100 / kalFilled) * 10000) / 10000
      : kalAsk;
    const tradeId = `arb-${Date.now()}`;
    logArbTrade({
      id: tradeId,
      ts: new Date().toISOString(),
      match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
      dir,
      status: "hedging",
      shares: sharesHeld,
      kalTicker: kalLeg.ticker,
      kalFillPrice: held === "kal" ? actualKalPrice : 0,
      kalCost: kalCostHedge,
      kalFees: held === "kal" ? kalFeesTotal : 0,
      pmOutcome: pmLeg.outcome,
      pmSlug: entry.pmSlug,
      pmTokenId: pmLeg.tokenId,
      pmFillPrice: held === "pm" ? pmAsk : 0,
      pmCost: held === "pm" ? Math.round(sharesHeld * pmAsk * 100) / 100 : 0,
      totalCost: held === "pm" ? Math.round(sharesHeld * pmAsk * 100) / 100 : kalCostHedge,
      projectedEdge: edge,
      projectedProfit: sharesHeld * edge,
      initialExchange: held,
      ...(held === "kal" && kalFilledViaMaker ? { kalMakerFill: true } : {}),
    });
    const initCost = held === "pm" ? sharesHeld * pmAsk : kalCostHedge;
    return {
      tradeId,
      heldExchange: held,
      pmLeg,
      pmOppLeg: held === "pm"
        ? (dir === "G" || dir === "H" || dir === "I" || dir === "J" || dir === "K" || dir === "L")
          ? null  // 3-way soccer: no single opposite PM token completes the arb
          : ((dir === "A" || dir === "D") ? entry.pm1 : entry.pm2)
        : null,
      pmCostBasis: held === "pm" ? pmAsk : 0,
      kalLeg,
      kalCostBasis: held === "kal" && sharesHeld > 0
        ? Math.round((actualKalPrice + kalFeesTotal / sharesHeld) * 10000) / 10000
        : 0,
      kalSide,
      sharesHeld,
      initialShares: sharesHeld,
      initialCost: initCost,
      hedgeFillCost: 0,
      hedgeFillCostKal: 0,
      hedgeFillCostPm: 0,
      kalFees: held === "kal" ? kalFeesTotal : 0,
      initialKalFees: held === "kal" ? kalFeesTotal : 0,
    };
  };

  let pmOrderIdForVerify = ""; // set inside PM-first or KAL-first, used in post-fill verification
  let pmOrderPrice = pmAsk; // actual PM order price (may be capped at breakeven in KAL-first path)

  // Write pending fill intent BEFORE any order -- crash recovery breadcrumb
  if (!DRY_RUN) {
    const pfId = `pf-${Date.now()}`;
    _activePendingFillId = pfId;
    addPendingFill({
      id: pfId,
      ts: new Date().toISOString(),
      exchange: pmFirst ? "pm" : "kal",
      tokenIdOrTicker: pmFirst ? pmLeg.tokenId : kalLeg.ticker,
      side: pmFirst ? "BUY" : kalSide,
      shares,
      price: pmFirst ? pmAsk : kalAsk,
      match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
      dir,
      pmSlug: entry.pmSlug,
      pmTokenId: pmLeg.tokenId,
      pmOutcome: pmLeg.outcome,
      kalTicker: kalLeg.ticker,
    });
  }

  // Snapshot on-chain PM balance BEFORE placing any orders.
  // Used to detect incremental fills (not total balance) -- prevents false positives
  // when a prior arb on the same token left shares on-chain.
  let pmPreBalance = 0;
  if (!DRY_RUN) {
    try { const b = await getOnChainBalance(pmLeg.tokenId); if (b >= 0) pmPreBalance = b; }
    catch { /* default 0 */ }
    if (pmPreBalance > 0) console.log(`  [PRE-BAL] Existing PM on-chain balance: ${pmPreBalance} shares`);
  }

  // -- Start execution-time book tracker (20s from NOW, captures depth during actual trade) --
  startBookTracker(kalLeg.ticker, pmLeg.tokenId, {
    match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
    dir, pmOutcome: pmLeg.outcome,
    kalAsk, pmAsk, edge,
    tradeTs: Date.now(),
  }, "execution");

  if (pmFirst) {
    // -- PM first (PM is the favourite / more expensive) ---------------------

    let pmResult: unknown;
    let pmFailed = false;
    console.log(`  [PM LEG] Placing: token=${pmLeg.tokenId.slice(0,16)}... price=${pmAsk} qty=${shares} tick=${pmLeg.tickSize} negRisk=${pmLeg.negRisk}`);
    const _tPm0 = performance.now();
    try {
      pmResult = await placePmOrder(pmLeg.tokenId, pmAsk, shares, pmLeg.tickSize || 0.01, pmLeg.negRisk, DRY_RUN);
    } catch (pmErr) { pmResult = pmErr; pmFailed = true; }
    tPmOrder = performance.now() - _tPm0;
    console.log(`  [PM LEG] Response (${tPmOrder.toFixed(0)}ms): ${JSON.stringify(pmResult).slice(0, 300)}`);

    if (pmFailed) {
      console.error(`  [PM LEG] FAILED (pre-Kal): ${(pmResult as Error).message}`);
      console.log("  [ABORT] Kalshi never fired. No exposure taken.");
      saveExecMetric("abort-pre-first", "pm-order-failed");
      return { sessionSkip: false, unhedged: null };
    }

    const pmMeta = extractPmMeta(pmResult);
    if (isPm425(pmResult)) {
      markPmDown();
      console.log(`  [PM LEG] Service not ready (425). Aborting -- no exposure.`);
      saveExecMetric("abort-pre-first", "pm-425");
      return { sessionSkip: false, unhedged: null };
    }
    if (typeof pmMeta.status === "number") {
      console.log(`  [PM LEG] Rejected (HTTP ${pmMeta.status}). Aborting -- no exposure.`);
      saveExecMetric("abort-pre-first", "pm-rejected");
      return { sessionSkip: false, unhedged: null };
    }
    markPmUp();
    if (!DRY_RUN && pmMeta.status !== "matched") {
      if (pmMeta.status === "delayed" && pmMeta.orderId) {
        // Order is on-chain but not yet confirmed -- poll until it resolves
        console.log(`  [PM LEG] On-chain pending (status=delayed), polling for confirmation...`);
        const _tPoll0 = performance.now();
        const finalStatus = await waitForPmOrderFill(String(pmMeta.orderId), 20_000, pmLeg.tokenId, pmPreBalance);
        tPmPoll = performance.now() - _tPoll0;
        if (finalStatus === "matched") {
          console.log(`  [PM LEG] Confirmed filled after delay (${tPmPoll.toFixed(0)}ms).`);
        } else if (finalStatus === "cancelled") {
          console.log(`  [PM LEG] Cancelled on-chain. Aborting -- no exposure.`);
          printTimings();
          saveExecMetric("abort-pre-first", "pm-cancelled");
          return { sessionSkip: false, unhedged: null };
        } else {
          // timeout: order status unknown -- check on-chain balance, fallback to data-api
          console.warn(`  [PM LEG] Confirmation timeout -- verifying on-chain...`);
          try {
            let actualHeld = await getOnChainBalance(pmLeg.tokenId);
            if (actualHeld < 0) {
              // RPC failed -> fallback to data-api
              console.warn(`  [PM LEG] On-chain check failed, falling back to data-api...`);
              const verifyPos = await fetchPmPositionsCached(0);
              actualHeld = sumPmHeld(verifyPos, pmLeg.tokenId);
            }
            const newShares = actualHeld - pmPreBalance;
            if (newShares >= shares) {
              console.log(`  [PM LEG] Verified ${newShares} new shares on-chain (total=${actualHeld}, pre=${pmPreBalance}). Proceeding.`);
            } else if (newShares > 0) {
              console.warn(`  [PM LEG] On-chain has ${newShares} new shares (total=${actualHeld}, pre=${pmPreBalance}). Entering hedge with actual qty.`);
              printTimings();
              metric.firstLegFilled = newShares;
              saveExecMetric("hedge-entry", "pm-delayed-partial");
              return { sessionSkip: true, unhedged: makeUnhedged("pm", newShares) };
            } else {
              // On-chain shows 0 new shares, but the PM order WAS submitted on-chain
              // (just not confirmed in time). It may still settle later as a ghost fill.
              // MUST skip this match to prevent double-execution on the same market.
              console.warn(`  [PM LEG] On-chain has 0 new shares (total=${actualHeld}, pre=${pmPreBalance}) -- order likely failed but may ghost-fill. Skipping match.`);
              printTimings();
              saveExecMetric("abort-pre-first", "pm-delayed-zero");
              return { sessionSkip: true, unhedged: null };
            }
          } catch (verifyErr) {
            console.warn(`  [PM LEG] Wallet check failed: ${(verifyErr as Error).message} -- assuming filled for safety.`);
            printTimings();
            metric.firstLegFilled = shares;
            saveExecMetric("hedge-entry", "pm-wallet-check-failed");
            return { sessionSkip: true, unhedged: makeUnhedged("pm", shares) };
          }
        }
      } else {
        // Unexpected status (e.g. "live" if PM_ORDER_TYPE=GTC partially filled).
        // Cancel the PM order to prevent orphaned positions, then abort cleanly.
        console.warn(`  [PM LEG] Unexpected status=${pmMeta.status ?? "n/a"} -- cancelling PM order and aborting.`);
        if (pmMeta.orderId) {
          try { await cancelPmOrder(String(pmMeta.orderId), DRY_RUN); }
          catch (e) { console.error(`  [PM LEG] Cancel failed: ${(e as Error).message}`); }
        }
        printTimings();
        saveExecMetric("abort-pre-first", "pm-unexpected-status");
        return { sessionSkip: false, unhedged: null };
      }
    }

    const pmFilled = shares; // FOK: fully filled or rejected above
    pmOrderIdForVerify = pmMeta.orderId ? String(pmMeta.orderId) : "";
    console.log(`  [PM LEG] OK orderId=${pmMeta.orderId ?? "n/a"} filled=${pmFilled}`);

    // Complete pending fill NOW -- PM is confirmed on-chain, this is not a ghost.
    // Prevents the async chain watcher from creating a duplicate ghost trade
    // during the KAL GTC polling window (which can take 20+ seconds).
    if (_activePendingFillId) {
      completePendingFill(_activePendingFillId);
      console.log(`[PENDING] Completed pending fill ${_activePendingFillId} (PM confirmed)`);
      _activePendingFillId = null;
    }

    // -- Helper: immediate PM hedge when KAL leg fails -------------------------
    // PM tennis has 0% fees, so hedging on PM is strictly better than KAL.
    // Tries FOK buy of the opposite PM outcome token at breakeven. Returns
    // number of shares successfully hedged (0 if PM unavailable or no fill).
    const pmOppLeg = (dir === "G" || dir === "H" || dir === "I" || dir === "J" || dir === "K" || dir === "L")
      ? null  // 3-way soccer: no single opposite PM token completes the arb
      : ((dir === "A" || dir === "D") ? entry.pm1 : entry.pm2);
    const immediatePmHedge = async (unhedgedShares: number): Promise<number> => {
      if (!pmOppLeg || isPmServiceDown() || unhedgedShares < 5) return 0;
      const maxOppPrice = 1 - pmAsk; // breakeven: initial PM cost + opp token = $1
      const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
      try {
        const oppAsk = await fetchPmAsk(pmOppLeg.tokenId, clobBase);
        if (oppAsk === null || oppAsk > maxOppPrice || unhedgedShares * oppAsk < PM_MARKETABLE_MIN_VALUE) return 0;
        console.log(`  [IMMEDIATE PM HEDGE] Buying ${unhedgedShares}x${pmOppLeg.outcome} @${fmtPct(oppAsk)} (breakeven=${fmtPct(maxOppPrice)})`);
        const res = await placePmFOK(pmOppLeg.tokenId, oppAsk, unhedgedShares, pmOppLeg.tickSize, pmOppLeg.negRisk, DRY_RUN);
        const meta = extractPmMeta(res);
        if (meta.status === "matched") {
          console.log(`  [IMMEDIATE PM HEDGE] Filled ${unhedgedShares}x${pmOppLeg.outcome} @${fmtPct(oppAsk)} -- hedge complete on PM.`);
          return unhedgedShares;
        }
        if (meta.status === "delayed" && meta.orderId) {
          const finalStatus = await waitForPmOrderFill(String(meta.orderId), 20_000, pmOppLeg.tokenId);
          if (finalStatus === "matched") {
            console.log(`  [IMMEDIATE PM HEDGE] Filled (delayed) ${unhedgedShares}x${pmOppLeg.outcome} @${fmtPct(oppAsk)} -- hedge complete.`);
            return unhedgedShares;
          }
        }
      } catch (e) {
        console.error(`  [IMMEDIATE PM HEDGE] Failed: ${(e as Error).message}`);
      }
      return 0;
    };

    // -- Kalshi GTC (second leg -- PM already filled) --------------------------
    // Place a GTC limit order at the ask price. If resting liquidity exists, it
    // fills instantly (same as IOC). If the book is empty, the order rests and
    // we poll for up to 6 seconds. On timeout we cancel and enter hedge mode
    // with a breakeven GTC.
    const kalGTCOrder = buildKalshiGTCOrder(kalLeg.ticker, "buy", kalSide, kalLimitCents, pmFilled);
    console.log(`  [KAL LEG] Placing GTC: ticker=${kalLeg.ticker} side=${kalSide} limit=${kalLimitCents}c qty=${pmFilled}`);
    let kalResult: unknown;
    let kalFailed = false;
    const _tKalOrd0 = performance.now();
    try {
      kalResult = await placeKalshiOrder(kalGTCOrder, DRY_RUN);
    } catch (kalErr) { kalResult = kalErr; kalFailed = true; }
    tKalOrder = performance.now() - _tKalOrd0;
    console.log(`  [KAL LEG] Response (${tKalOrder.toFixed(0)}ms): ${JSON.stringify(kalResult).slice(0, 300)}`);

    if (kalFailed) {
      console.error(`  [KAL LEG] GTC FAILED: ${(kalResult as Error).message}`);
      // Try immediate PM hedge (0% fees) before entering slow hedge loop
      const hedged = await immediatePmHedge(pmFilled);
      if (hedged >= pmFilled) {
        // Fully hedged on PM -- record as complete trade if we have actual hedge price
        const oppAskNow = await fetchPmAsk(pmOppLeg!.tokenId, process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com").catch(() => null);
        if (oppAskNow !== null) {
          const hedgeCostPm = hedged * oppAskNow;
          const totalCostFull = pmFilled * pmAsk + hedgeCostPm;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: pmFilled, kalTicker: kalLeg.ticker, kalFillPrice: 0, kalCost: 0,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmFilled * pmAsk, totalCost: totalCostFull,
            projectedEdge: edge, projectedProfit: pmFilled * edge,
            status: "resolved", resolutionMethod: "hedge-complete",
            hedgeCost: hedgeCostPm, realizedPnl: Math.round((pmFilled - totalCostFull) * 100) / 100,
            initialExchange: "pm",
          });
          console.log(`  [IMMEDIATE PM HEDGE] Trade fully resolved on PM. P&L=$${(pmFilled - totalCostFull).toFixed(2)}`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          saveExecMetric("hedge-entry", "kal-gtc-failed-pm-hedged");
          return { sessionSkip: true, unhedged: null };
        }
        // oppAsk fetch failed -- can't record actual cost. Fall through to hedge loop for proper tracking.
        console.warn(`  [IMMEDIATE PM HEDGE] Hedged ${hedged} shares but oppAsk fetch failed. Entering hedge loop for cost tracking.`);
      }
      console.warn(`  [HEDGE MODE] Holding PM ${pmFilled}x${pmLeg.outcome} @${fmtPct(pmAsk)} -- entering hedge loop.`);
      printTimings();
      metric.firstLegFilled = pmFilled;
      saveExecMetric("hedge-entry", "kal-gtc-failed");
      return { sessionSkip: true, unhedged: makeUnhedged("pm", pmFilled - hedged) };
    }

    const kalMeta = extractKalMeta(kalResult);
    kalFilled = DRY_RUN ? shares : kalMeta.filled;
    kalFeesTotal = kalMeta.fees;
    kalFillCostCents = kalMeta.fillCostCents; // actual fill cost from Kalshi (cents, excl fees)
    const kalOrderId = kalMeta.orderId ? String(kalMeta.orderId) : "";

    // Poll for up to 6 seconds if not immediately filled
    if (!DRY_RUN && kalFilled < pmFilled && kalOrderId) {
      const GTC_POLL_MS = 20000;
      const GTC_POLL_INTERVAL = 500;
      const pollStart = Date.now();
      console.log(`  [KAL LEG] GTC not fully filled (${kalFilled}/${pmFilled}). Polling for ${GTC_POLL_MS / 1000}s...`);
      while (Date.now() - pollStart < GTC_POLL_MS && kalFilled < pmFilled) {
        await sleep(GTC_POLL_INTERVAL);
        try {
          const verify = await getKalshiOrder(kalOrderId);
          const verifiedFilled = Number(verify.fill_count_fp ?? verify.fill_count ?? verify.filled_count ?? 0);
          const verifiedStatus = String(verify.status ?? "");
          if (verifiedFilled > kalFilled) {
            kalFilled = verifiedFilled;
            console.log(`  [KAL LEG] GTC poll: filled=${kalFilled}/${pmFilled} status=${verifiedStatus}`);
          }
          // Update fees and fill cost from latest order state
          const vTaker = Number(verify.taker_fees ?? 0);
          const vMaker = Number(verify.maker_fees ?? 0);
          if (vTaker + vMaker > 0) kalFeesTotal = (vTaker + vMaker) / 100;
          const vTakerCost = Number(verify.taker_fill_cost ?? 0);
          const vMakerCost = Number(verify.maker_fill_cost ?? 0);
          if (vTakerCost + vMakerCost > 0) kalFillCostCents = vTakerCost + vMakerCost;
          if (verifiedStatus === "executed" || verifiedStatus === "canceled") break;
        } catch { /* continue polling */ }
      }
      tKalVerify = Date.now() - pollStart;
    }

    if (!DRY_RUN && kalFilled >= pmFilled) {
      console.log(`  [KAL LEG] GTC fully filled: ${kalFilled} contracts`);
    } else if (!DRY_RUN && kalFilled > 0 && kalFilled < pmFilled) {
      // Partial fill -- cancel remaining GTC, then re-check actual fill count.
      // The GTC may have filled MORE shares between the last poll and now (race condition).
      console.warn(`  [KAL LEG] GTC partial: ${kalFilled}/${pmFilled}. Cancelling remainder.`);
      try { await cancelKalshiOrder(kalOrderId, DRY_RUN); } catch { /* best effort */ }

      // -- Post-cancel reconciliation: re-check actual fills ------------------
      // Race condition: GTC can fill between last poll and cancel request.
      // Wait briefly, then get the definitive fill count from Kalshi.
      await sleep(500);
      try {
        const postCancelOrder = await getKalshiOrder(kalOrderId);
        const postCancelFilled = Number(
          postCancelOrder.fill_count ?? postCancelOrder.filled_count ??
          (postCancelOrder.fill_count_fp != null ? Math.round(Number(postCancelOrder.fill_count_fp)) : kalFilled)
        );
        if (postCancelFilled > kalFilled) {
          console.log(`  [KAL LEG] Post-cancel check: actual fills=${postCancelFilled} (was ${kalFilled}). GTC filled more before cancel.`);
          // Update fees and fill cost from final order state
          const pcTaker = Number(postCancelOrder.taker_fees ?? postCancelOrder.taker_fees_dollars ?? 0);
          const pcMaker = Number(postCancelOrder.maker_fees ?? postCancelOrder.maker_fees_dollars ?? 0);
          const pcTakerCost = Number(postCancelOrder.taker_fill_cost ?? postCancelOrder.taker_fill_cost_dollars ?? 0);
          const pcMakerCost = Number(postCancelOrder.maker_fill_cost ?? postCancelOrder.maker_fill_cost_dollars ?? 0);
          // Detect dollar-format (has decimal string like "1.3000") vs cent-format
          const isDollarFmt = String(postCancelOrder.taker_fees_dollars ?? "").includes(".");
          const feeDiv = isDollarFmt ? 1 : 100;
          if (pcTaker + pcMaker > 0) kalFeesTotal = (pcTaker + pcMaker) / feeDiv;
          if (pcTakerCost + pcMakerCost > 0) kalFillCostCents = isDollarFmt
            ? (pcTakerCost + pcMakerCost) * 100
            : pcTakerCost + pcMakerCost;
          kalFilled = postCancelFilled;
        }
      } catch (e) {
        console.warn(`  [KAL LEG] Post-cancel order check failed: ${(e as Error).message} -- using polled fill count.`);
      }

      if (kalFilled >= pmFilled) {
        // GTC fully filled after all -- treat as complete
        console.log(`  [KAL LEG] GTC fully filled after post-cancel check: ${kalFilled} contracts`);
        // Fall through to normal "both legs filled" handling below
      } else {
        const unhedgedCount = pmFilled - kalFilled;
        const hedged = await immediatePmHedge(unhedgedCount);
        const remaining = unhedgedCount - hedged;

        // -- Compute actual KAL cost for the partial fill ----------------------
        const kalRawCostPartial = kalFillCostCents > 0 ? kalFillCostCents / 100 : kalFilled * kalAsk;
        const kalCostPartial = Math.round((kalRawCostPartial + kalFeesTotal) * 100) / 100;
        const actualKalPricePartial = kalFillCostCents > 0 && kalFilled > 0
          ? Math.round((kalFillCostCents / 100 / kalFilled) * 10000) / 10000
          : kalAsk;

        if (remaining <= 0) {
          // All unhedged shares covered by PM opposite -- log complete resolved trade
          const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
          const oppAskNow = pmOppLeg ? await fetchPmAsk(pmOppLeg.tokenId, clobBase).catch(() => null) : null;
          const hedgeCostPm = Math.round(unhedgedCount * (oppAskNow ?? (1 - pmAsk)) * 100) / 100;
          const pmCostFull = Math.round(pmFilled * pmAsk * 100) / 100;
          const totalCostResolved = Math.round((kalCostPartial + pmCostFull + hedgeCostPm) * 100) / 100;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: pmFilled,
            kalTicker: kalLeg.ticker, kalFillPrice: actualKalPricePartial,
            kalCost: kalCostPartial, kalFees: kalFeesTotal,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmCostFull,
            totalCost: totalCostResolved,
            projectedEdge: edge, projectedProfit: pmFilled * edge,
            status: "resolved", resolutionMethod: "hedge-complete",
            hedgeCost: hedgeCostPm,
            realizedPnl: Math.round((pmFilled - totalCostResolved) * 100) / 100,
            initialExchange: "pm",
          });
          console.log(`  [IMMEDIATE PM HEDGE] All ${unhedgedCount} unhedged shares filled on PM. Trade logged with KAL partial=${kalFilled} cost=$${kalCostPartial.toFixed(2)}`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          metric.secondLegFilled = kalFilled;
          saveExecMetric("hedge-entry", "kal-gtc-partial-pm-hedged");
          return { sessionSkip: true, unhedged: null };
        } else {
          // Some shares still need hedge loop.
          // Log a "filled" trade for the kalFilled matched shares (PM+KAL) so costs aren't lost.
          if (kalFilled > 0) {
            const pmCostMatched = Math.round(kalFilled * pmAsk * 100) / 100;
            logArbTrade({
              id: `arb-${Date.now()}-partial`, ts: new Date().toISOString(),
              match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
              dir, shares: kalFilled,
              kalTicker: kalLeg.ticker, kalFillPrice: actualKalPricePartial,
              kalCost: kalCostPartial, kalFees: kalFeesTotal,
              pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
              pmFillPrice: pmAsk, pmCost: pmCostMatched,
              totalCost: Math.round((kalCostPartial + pmCostMatched) * 100) / 100,
              projectedEdge: edge, projectedProfit: kalFilled * edge,
              status: "filled",
              realizedPnl: Math.round((kalFilled - kalCostPartial - pmCostMatched) * 100) / 100,
              initialExchange: "pm",
            });
            console.log(`  [PARTIAL FILL] Logged ${kalFilled} matched shares (KAL+PM). ${remaining} still unhedged.`);
          }
          console.warn(`  [HEDGE MODE] ${remaining} PM shares still unhedged -- entering hedge loop.`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          metric.secondLegFilled = kalFilled;
          saveExecMetric("hedge-entry", "kal-gtc-partial");
          return { sessionSkip: true, unhedged: makeUnhedged("pm", remaining) };
        }
      }
    } else if (!DRY_RUN && kalFilled === 0) {
      // Not filled after 5s -- cancel the arb-price GTC, try immediate PM hedge
      console.warn(`  [KAL LEG] GTC unfilled after ${tKalVerify}ms. Cancelling arb-price order.`);
      try { await cancelKalshiOrder(kalOrderId, DRY_RUN); } catch { /* best effort */ }

      // -- Post-cancel reconciliation: check if KAL filled before cancel arrived --
      // Race condition: order can fill between last poll and cancel request.
      // Wait 500ms to let Kalshi settle the cancel/fill race, then re-check.
      await sleep(500);
      try {
        const postCancelOrder = await getKalshiOrder(kalOrderId);
        const postCancelFilled = Number(postCancelOrder.fill_count ?? postCancelOrder.filled_count ?? postCancelOrder.fill_count_fp ?? 0);
        if (postCancelFilled > 0) {
          const matchedShares = Math.min(postCancelFilled, pmFilled);
          const unhedgedPm = pmFilled - matchedShares;
          console.log(`  [KAL LEG] Post-cancel check: ${postCancelFilled} contracts FILLED before cancel!${unhedgedPm > 0 ? ` ${unhedgedPm} PM shares unhedged.` : " Arb complete."}`);
          const pcTaker = Number(postCancelOrder.taker_fees ?? 0);
          const pcMaker = Number(postCancelOrder.maker_fees ?? 0);
          const pcFees = (pcTaker + pcMaker) / 100;
          const pcFillCost = (Number(postCancelOrder.taker_fill_cost ?? 0) + Number(postCancelOrder.maker_fill_cost ?? 0)) / 100;
          const pcAvgPrice = pcFillCost > 0 && postCancelFilled > 0
            ? Math.round((pcFillCost / postCancelFilled) * 100) / 100
            : kalAsk;
          const kalCostActual = Math.round((pcFillCost + pcFees) * 100) / 100;
          // PM cost must match the MATCHED shares, not total PM fills
          const pmCostMatched = Math.round(matchedShares * pmAsk * 100) / 100;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: matchedShares,
            kalTicker: kalLeg.ticker, kalFillPrice: pcAvgPrice,
            kalCost: kalCostActual, kalFees: pcFees,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmCostMatched,
            totalCost: Math.round((kalCostActual + pmCostMatched) * 100) / 100,
            projectedEdge: edge, projectedProfit: matchedShares * edge,
            status: unhedgedPm > 0 ? "filled" : "resolved",
            resolutionMethod: unhedgedPm > 0 ? undefined : "both-legs",
            resolvedTs: unhedgedPm > 0 ? undefined : new Date().toISOString(),
            initialExchange: "pm",
            realizedPnl: Math.round((matchedShares - kalCostActual - pmCostMatched) * 100) / 100,
          });
          printTimings();
          metric.firstLegFilled = pmFilled;
          metric.secondLegFilled = postCancelFilled;
          if (unhedgedPm > 0) {
            // Remaining PM shares need hedging
            console.warn(`  [PARTIAL] KAL filled ${postCancelFilled}/${pmFilled}. ${unhedgedPm} PM shares entering hedge.`);
            saveExecMetric("hedge-entry", "kal-gtc-post-cancel-partial");
            return { sessionSkip: true, unhedged: makeUnhedged("pm", unhedgedPm) };
          }
          saveExecMetric("filled", "kal-gtc-post-cancel-fill");
          return { sessionSkip: true, unhedged: null };
        }
      } catch (e) {
        console.warn(`  [KAL LEG] Post-cancel order check failed: ${(e as Error).message} -- proceeding with hedge.`);
      }

      const hedged = await immediatePmHedge(pmFilled);
      if (hedged >= pmFilled) {
        // -- CRITICAL: Final KAL re-check after PM hedge ----------------------
        // The KAL GTC may have filled DURING the PM hedge (cancel/fill race).
        // If KAL filled, we're double-hedged. Sell the PM hedge back to recover.
        let kalLateFilledCount = 0;
        try {
          await sleep(300); // let Kalshi settle
          const finalKalOrder = await getKalshiOrder(kalOrderId);
          kalLateFilledCount = Number(finalKalOrder.fill_count ?? finalKalOrder.filled_count ?? finalKalOrder.fill_count_fp ?? 0);
          if (kalLateFilledCount > 0) {
            console.warn(`  [RACE DETECTED] KAL GTC filled ${kalLateFilledCount} contracts AFTER PM hedge! Selling PM hedge back.`);
            // Sell the PM opposite token (hedge) to undo the unnecessary hedge
            const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
            try {
              const oppBid = await fetchPmBestBid(pmOppLeg!.tokenId, clobBase);
              if (oppBid !== null && oppBid > 0) {
                console.log(`  [RACE RECOVERY] Selling ${hedged}x${pmOppLeg!.outcome} @ ${fmtPct(oppBid)} to undo PM hedge.`);
                await placePmGTCAsk(pmOppLeg!.tokenId, oppBid, hedged, pmOppLeg!.tickSize, pmOppLeg!.negRisk, DRY_RUN);
                console.log(`  [RACE RECOVERY] PM hedge sell order placed. KAL arb is the real second leg.`);
              } else {
                console.warn(`  [RACE RECOVERY] No PM bid available -- PM hedge stuck. KAL still filled though.`);
              }
            } catch (sellErr) {
              console.error(`  [RACE RECOVERY] PM sell failed: ${(sellErr as Error).message}`);
            }
            // Log the trade as completed via KAL (not hedge-complete)
            const lateKalFees = Number(finalKalOrder.taker_fees ?? 0) / 100 + Number(finalKalOrder.maker_fees ?? 0) / 100;
            const lateKalFillCost = (Number(finalKalOrder.taker_fill_cost ?? 0) + Number(finalKalOrder.maker_fill_cost ?? 0)) / 100;
            const lateKalAvg = lateKalFillCost > 0 && kalLateFilledCount > 0
              ? Math.round((lateKalFillCost / kalLateFilledCount) * 100) / 100 : kalAsk;
            const kalCostLate = Math.round((lateKalFillCost + lateKalFees) * 100) / 100;
            const pmCostLate = Math.round(pmFilled * pmAsk * 100) / 100;
            logArbTrade({
              id: `arb-${Date.now()}`, ts: new Date().toISOString(),
              match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
              dir, shares: Math.min(kalLateFilledCount, pmFilled),
              kalTicker: kalLeg.ticker, kalFillPrice: lateKalAvg,
              kalCost: kalCostLate, kalFees: lateKalFees,
              pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
              pmFillPrice: pmAsk, pmCost: pmCostLate,
              totalCost: Math.round((kalCostLate + pmCostLate) * 100) / 100,
              projectedEdge: edge, projectedProfit: pmFilled * edge,
              status: "filled", initialExchange: "pm",
              realizedPnl: Math.round((Math.min(kalLateFilledCount, pmFilled) - kalCostLate - pmCostLate) * 100) / 100,
            });
            console.log(`  [RACE RECOVERY] Trade logged as KAL-filled (not hedged). P&L=$${(Math.min(kalLateFilledCount, pmFilled) - kalCostLate - pmCostLate).toFixed(2)}`);
            printTimings();
            metric.firstLegFilled = pmFilled;
            metric.secondLegFilled = kalLateFilledCount;
            saveExecMetric("filled", "kal-gtc-late-fill-race-recovery");
            return { sessionSkip: true, unhedged: null };
          }
        } catch (e) {
          console.warn(`  [RACE CHECK] Final KAL order check failed: ${(e as Error).message} -- proceeding with hedge-complete.`);
        }

        const oppAskNow = await fetchPmAsk(pmOppLeg!.tokenId, process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com").catch(() => null);
        if (oppAskNow !== null) {
          const hedgeCostPm = hedged * oppAskNow;
          const totalCostFull = pmFilled * pmAsk + hedgeCostPm;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: pmFilled, kalTicker: kalLeg.ticker, kalFillPrice: 0, kalCost: 0,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmFilled * pmAsk, totalCost: totalCostFull,
            projectedEdge: edge, projectedProfit: pmFilled * edge,
            status: "resolved", resolutionMethod: "hedge-complete",
            hedgeCost: hedgeCostPm, realizedPnl: Math.round((pmFilled - totalCostFull) * 100) / 100,
            initialExchange: "pm",
          });
          console.log(`  [IMMEDIATE PM HEDGE] Trade fully resolved on PM. P&L=$${(pmFilled - totalCostFull).toFixed(2)}`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          saveExecMetric("hedge-entry", "kal-gtc-timeout-pm-hedged");
          return { sessionSkip: true, unhedged: null };
        }
        // oppAsk fetch failed -- fall through to hedge loop for proper cost tracking
        console.warn(`  [IMMEDIATE PM HEDGE] Hedged ${hedged} shares but oppAsk fetch failed. Entering hedge loop for cost tracking.`);
      }
      const remaining = pmFilled - hedged;
      console.warn(`  [HEDGE MODE] ${remaining} PM shares unhedged -- entering hedge loop.`);
      printTimings();
      metric.firstLegFilled = pmFilled;
      saveExecMetric("hedge-entry", "kal-gtc-timeout");
      return { sessionSkip: true, unhedged: makeUnhedged("pm", remaining) };
    }

  } else {
    // -- Kalshi IOC first (Kalshi is the favourite / more expensive) ----------

    // Fetch live orderbook depth: WS first -> cache -> REST fallback
    let kalBook: { yes: [number, number][]; no: [number, number][] } | null = getWsKalBook(kalLeg.ticker);
    if (kalBook) {
      console.log(`  [KAL LEG] Using WS orderbook (live)`);
    } else {
      const cachedBookKal = kalBookCache.get(kalLeg.ticker);
      kalBook = cachedBookKal && Date.now() - cachedBookKal.ts < BOOK_CACHE_TTL ? cachedBookKal.book : null;
      if (kalBook) {
        console.log(`  [KAL LEG] Using cached orderbook (${Date.now() - cachedBookKal!.ts}ms old)`);
      } else {
        const _tBook0 = performance.now();
        try { kalBook = await fetchKalshiOrderbook(kalLeg.ticker); } catch { /* proceed without */ }
        tKalBook = performance.now() - _tBook0;
      }
    }

    let kalSweepResult: { totalQty: number; worstPrice: number; avgPrice: number } | null = null;
    if (kalBook && !DRY_RUN) {
      // Derive ask levels for the side we're buying
      const askLevels = kalSide === "yes"
        ? deriveYesAsks(kalBook.no)
        : deriveNoAsks(kalBook.yes);
      if (askLevels.length === 0) {
        console.log(`  [KAL LEG] Orderbook empty. Raw: yesBids=${kalBook.yes.length} levels, noBids=${kalBook.no.length} levels.`);
        if (kalBook.yes.length > 0) console.log(`  [KAL LEG]   YES bids (top 3): ${kalBook.yes.slice(0, 3).map(l => `${l[0]}cx${l[1]}`).join(", ")}`);
        if (kalBook.no.length > 0) console.log(`  [KAL LEG]   NO bids (top 3): ${kalBook.no.slice(0, 3).map(l => `${l[0]}cx${l[1]}`).join(", ")}`);
        // DEPTH FIX: orderbook endpoint sometimes returns empty while market listing shows offers.
        // Fall back to listing data (same fix as depth-check phase).
        const listingPrice = kalSide === "yes" ? kalLeg.yesAsk : kalLeg.noAsk;
        const listingSize = (kalSide === "yes" ? kalLeg.yesAskSize : kalLeg.noAskSize) ?? 0;
        const listingCents = Math.round(listingPrice * 100);
        if (listingSize >= shares && listingCents <= kalLimitCents) {
          console.log(`  [KAL LEG] [DEPTH FIX] Using listing data: ${listingSize} contracts @ ${listingCents}c`);
          askLevels.push([listingCents, listingSize]);
        } else {
          console.log(`  [KAL LEG] Insufficient depth: 0/${shares} contracts (listing: ${listingSize}@${listingCents}c limit=${kalLimitCents}c). Skipping.`);
          saveExecMetric("abort-pre-first", "kal-depth-empty");
          return { sessionSkip: false, unhedged: null, abortReason: "soft" };
        }
      }
      console.log(`  [KAL LEG] Derived ${kalSide.toUpperCase()} asks (top 5): ${askLevels.slice(0, 5).map(l => `${l[0]}cx${l[1]}`).join(", ")}  limit=${kalLimitCents}c`);
      const sweep = sweepKalshiDepth(askLevels, shares, kalLimitCents);
      kalSweepResult = sweep;
      if (!sweep || sweep.totalQty === 0) {
        const allAvail = askLevels.reduce((s, l) => s + l[1], 0);
        console.log(`  [KAL LEG] No depth at <=${kalLimitCents}c. Total book: ${allAvail} contracts up to ${askLevels[askLevels.length - 1][0]}c. Skipping.`);
        saveExecMetric("abort-pre-first", "kal-no-depth-at-limit");
        return { sessionSkip: false, unhedged: null, abortReason: "soft" };
      }
      if (sweep.totalQty < shares) {
        console.log(`  [KAL LEG] Partial depth: ${sweep.totalQty}/${shares} at <=${kalLimitCents}c. Will attempt partial fill.`);
      }
      // Verify edge remains profitable at average fill price
      const avgEdge = 1 - (sweep.avgPrice / 100) - pmAsk - estimateFees(sweep.avgPrice / 100, pmAsk);
      if (avgEdge < MIN_EDGE) {
        console.log(`  [KAL LEG] Edge at avg fill ${fmtPct(sweep.avgPrice / 100)} drops to ${fmtPct(avgEdge)}. Skipping.`);
        saveExecMetric("abort-pre-first", "kal-edge-too-low");
        return { sessionSkip: false, unhedged: null, abortReason: "soft" };
      }
      console.log(`  [KAL LEG] Depth OK: ${sweep.totalQty} contracts across ${askLevels.filter(l => l[0] <= kalLimitCents).length} levels. Worst=${sweep.worstPrice}c Avg=${sweep.avgPrice.toFixed(1)}c`);
    }

    // -- Kalshi first leg + PM pre-sign (parallel) --------------------------
    // Two modes:
    //   KAL_MAKER_MODE=false (default): IOC at ask -> taker fee (7%)
    //   KAL_MAKER_MODE=true:  GTC bid at ask-1c -> maker fee (1.75%), fallback to IOC after timeout
    let kalIOCCount = (kalSweepResult && kalSweepResult.totalQty < shares) ? kalSweepResult.totalQty : shares;

    // Enforce Kalshi minimum = PM minimum so partial fills can never undersize PM orders
    if (kalIOCCount < effectivePmMin) {
      console.warn(`  [SKIP] Kalshi depth (${kalIOCCount}) < PM minimum (${effectivePmMin}). Skipping to avoid oversized PM leg.`);
      saveExecMetric("abort-pre-first", "kal-depth-below-pm-min");
      return { sessionSkip: false, unhedged: null, abortReason: "soft" };
    }

    // Pre-sign PM order at expected price+shares while Kalshi order is in flight
    let pmPreSigned: unknown = null;
    let pmPreSignShares = shares;
    const _tKalOrd0 = performance.now();
    let kalResult: unknown;
    let kalFailed = false;

    // Kalshi ask in cents for this side (best ask from depth check)
    const kalAskCents = kalSweepResult ? kalSweepResult.worstPrice : kalLimitCents;
    const kalMakerBidCents = Math.max(1, kalAskCents - 1);

    if (KAL_MAKER_MODE && !DRY_RUN && kalMakerBidCents < kalLimitCents) {
      // -- MAKER MODE: GTC bid at ask-1c, poll for fill, fallback to IOC --
      console.log(`  [KAL LEG] MAKER MODE: GTC bid at ${kalMakerBidCents}c (ask=${kalAskCents}c) ticker=${kalLeg.ticker} side=${kalSide} qty=${kalIOCCount}`);

      // Place GTC + pre-sign PM in parallel
      const makerOrder = buildKalshiGTCOrder(kalLeg.ticker, "buy", kalSide, kalMakerBidCents, kalIOCCount);
      const [kalRes, pmSigned] = await Promise.allSettled([
        placeKalshiOrder(makerOrder, false),
        preSignPmOrder(pmLeg.tokenId, pmAsk, shares, pmLeg.tickSize, pmLeg.negRisk),
      ]);
      if (pmSigned.status === "fulfilled") {
        pmPreSigned = pmSigned.value;
        console.log(`  [PM PRE-SIGN] Order pre-signed at ${fmtPct(pmAsk)} x ${shares} shares`);
      } else {
        console.warn(`  [PM PRE-SIGN] Failed: ${(pmSigned.reason as Error).message} -- will use normal flow`);
      }

      if (kalRes.status === "rejected") {
        console.error(`  [KAL LEG] MAKER GTC FAILED: ${(kalRes.reason as Error).message}. Falling back to IOC.`);
        // Fall through to IOC below
      } else {
        kalResult = kalRes.value;
        let makerMeta = extractKalMeta(kalResult);
        const makerOrderId = makerMeta.orderId ? String(makerMeta.orderId) : "";

        // Check if GTC filled immediately (crossed resting ask)
        if (makerMeta.filled >= kalIOCCount) {
          console.log(`  [KAL LEG] MAKER: Instant fill! ${makerMeta.filled}/${kalIOCCount} @ ${kalMakerBidCents}c (fees=$${makerMeta.fees.toFixed(2)})`);
          kalFilledViaMaker = true;
        } else {
          // Poll for fill
          console.log(`  [KAL LEG] MAKER: ${makerMeta.filled}/${kalIOCCount} instant. Polling up to ${KAL_MAKER_WAIT_MS}ms...`);
          const pollDeadline = Date.now() + KAL_MAKER_WAIT_MS;
          while (Date.now() < pollDeadline && makerMeta.filled < kalIOCCount) {
            await sleep(KAL_MAKER_POLL_MS);
            try {
              const orderStatus = await getKalshiOrder(makerOrderId);
              makerMeta = extractKalMeta(orderStatus);
              kalResult = orderStatus;
            } catch { /* poll error, continue */ }
          }

          if (makerMeta.filled > 0) {
            console.log(`  [KAL LEG] MAKER: Got ${makerMeta.filled}/${kalIOCCount} fills after ${(Date.now() + KAL_MAKER_WAIT_MS - pollDeadline + KAL_MAKER_WAIT_MS).toFixed(0)}ms`);
            kalFilledViaMaker = true;
            // Cancel remaining if partial
            if (makerMeta.filled < kalIOCCount && makerOrderId) {
              try {
                await cancelKalshiOrder(makerOrderId, false);
                console.log(`  [KAL LEG] MAKER: Cancelled remaining ${kalIOCCount - makerMeta.filled} resting contracts`);
              } catch { /* already filled or cancelled */ }
            }
          } else {
            // No fills -- cancel GTC and fall back to IOC
            console.log(`  [KAL LEG] MAKER: 0 fills after ${KAL_MAKER_WAIT_MS}ms. Cancelling GTC, falling back to IOC.`);
            if (makerOrderId) {
              try { await cancelKalshiOrder(makerOrderId, false); } catch { /* ok */ }
            }
            kalResult = undefined; // reset -- will be set by IOC below
          }
        }

        if (kalFilledViaMaker) {
          // Maker fill succeeded -- use the results
          kalFailed = false;
        }
      }
    }

    // -- IOC path (default, or maker-mode fallback) ------------------------
    if (!kalFilledViaMaker) {
      const kalIOCOrder = buildKalshiIOCOrder(kalLeg.ticker, kalLimitCents / 100, kalIOCCount, kalSide);
      console.log(`  [KAL LEG] Placing IOC: ticker=${kalLeg.ticker} side=${kalSide} limit=${kalLimitCents}c qty=${kalIOCCount}`);

      if (!DRY_RUN) {
        if (!pmPreSigned) {
          // Pre-sign PM in parallel with IOC (if not already done in maker path)
          const [kalRes, pmSigned] = await Promise.allSettled([
            placeKalshiOrder(kalIOCOrder, false),
            preSignPmOrder(pmLeg.tokenId, pmAsk, shares, pmLeg.tickSize, pmLeg.negRisk),
          ]);
          if (kalRes.status === "fulfilled") { kalResult = kalRes.value; }
          else { kalResult = kalRes.reason; kalFailed = true; }
          if (pmSigned.status === "fulfilled") {
            pmPreSigned = pmSigned.value;
            console.log(`  [PM PRE-SIGN] Order pre-signed at ${fmtPct(pmAsk)} x ${shares} shares`);
          } else {
            console.warn(`  [PM PRE-SIGN] Failed: ${(pmSigned.reason as Error).message} -- will use normal flow`);
          }
        } else {
          // PM already pre-signed during maker attempt -- just place IOC
          try {
            kalResult = await placeKalshiOrder(kalIOCOrder, false);
          } catch (kalErr) { kalResult = kalErr; kalFailed = true; }
        }
      } else {
        try {
          kalResult = await placeKalshiOrder(kalIOCOrder, true);
        } catch (kalErr) { kalResult = kalErr; kalFailed = true; }
      }
    }

    tKalOrder = performance.now() - _tKalOrd0;
    console.log(`  [KAL LEG] Response (${tKalOrder.toFixed(0)}ms)${kalFilledViaMaker ? " [MAKER]" : " [TAKER]"}: ${JSON.stringify(kalResult).slice(0, 300)}`);

    if (kalFailed) {
      console.error(`  [KAL LEG] Order FAILED (pre-PM): ${(kalResult as Error).message}`);
      console.log("  [ABORT] PM never fired. No exposure taken.");
      printTimings();
      saveExecMetric("abort-pre-first", "kal-order-failed");
      return { sessionSkip: false, unhedged: null };
    }

    const kalMeta = extractKalMeta(kalResult);
    kalFilled = DRY_RUN ? shares : kalMeta.filled;
    kalFeesTotal = kalMeta.fees;
    kalFillCostCents = kalMeta.fillCostCents;
    const kalOrderId = kalMeta.orderId ? String(kalMeta.orderId) : "";

    if (!DRY_RUN && kalFilled === 0) {
      console.log(`  [KAL LEG] 0 fills -- book was empty or pulled. No exposure.`);
      printTimings();
      saveExecMetric("abort-pre-first", "kal-ioc-no-fill");
      return { sessionSkip: false, unhedged: null };
    }

    if (!DRY_RUN && kalFilled < kalIOCCount) {
      console.log(`  [KAL LEG] Partial: ${kalFilled}/${kalIOCCount}. Proceeding with filled qty.`);
    }

    if (kalFilledViaMaker) {
      console.log(`  [KAL LEG] ★ MAKER FILL: ${kalFilled} contracts, fees=$${kalFeesTotal.toFixed(2)} (taker would be ~$${(KALSHI_FEE_RATE * kalFilled * (kalMakerBidCents/100) * (1 - kalMakerBidCents/100)).toFixed(2)})`);
      metric.kalMakerFill = true;
    }

    console.log(`  [KAL LEG] OK orderId=${kalOrderId || "n/a"} filled=${kalFilled}`);

    // Effective PM minimum: per-market minSize (typically 5 shares) + PM $1 FOK floor
    const pmMinByFOKkf = pmAsk > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pmAsk) : pmLeg.minSize;
    const effectivePmMinKF = Math.max(pmLeg.minSize, pmMinByFOKkf);
    // If Kalshi partial-filled below PM minimum, go straight to hedge -- don't oversize PM
    if (!DRY_RUN && kalFilled < effectivePmMinKF) {
      console.warn(`  [KAL LEG] Partial fill ${kalFilled} < PM minimum ${effectivePmMinKF}. Hedging instead of oversizing PM.`);
      printTimings();
      metric.firstLegFilled = kalFilled;
      saveExecMetric("hedge-entry", "kal-partial-below-pm-min");
      return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
    }
    const pmShares = DRY_RUN ? shares : kalFilled;

    // Cap PM price at breakeven based on ACTUAL KAL fill cost (not scan-time estimate).
    // Without this, slippage or fees on KAL side can push total cost > $1/share -> guaranteed loss.
    pmOrderPrice = pmAsk;
    let pmPriceWasCapped = false;
    if (!DRY_RUN && kalFillCostCents > 0 && kalFilled > 0) {
      const actualKalPerShare = (kalFillCostCents / 100 + kalFeesTotal) / kalFilled;
      const maxPmForBreakeven = 1 - actualKalPerShare;
      if (pmAsk > maxPmForBreakeven) {
        const pmTick = pmLeg.tickSize || 0.01;
        pmOrderPrice = Math.floor(maxPmForBreakeven / pmTick) * pmTick;
        pmPriceWasCapped = true;
        console.log(
          `  [PM LEG] Capping PM price: scan=${fmtPct(pmAsk)} -> breakeven=${fmtPct(maxPmForBreakeven)} -> order=${fmtPct(pmOrderPrice)}` +
          ` (KAL actual=${fmtPct(actualKalPerShare)}/share incl fees)`
        );
        if (pmOrderPrice <= 0) {
          console.warn(`  [PM LEG] Breakeven price <=0 -- KAL cost too high. Entering hedge mode.`);
          printTimings();
          metric.firstLegFilled = kalFilled;
          saveExecMetric("hedge-entry", "pm-breakeven-negative");
          return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
        }
      }
    }

    // -- PM FOK execution: single aggressive FOK at the ask ------------------
    // Sends a Fill-or-Kill at pmOrderPrice. Subject to PM's ~3-second sports
    // delay but simpler and avoids the stale-GTC problem where liquidity
    // disappears during the 5-second poll window.
    let pmFilled = false;
    let pmFinalOrderId = "";
    const _tPm0 = performance.now();

    if (DRY_RUN) {
      const dryResult = await placePmOrder(pmLeg.tokenId, pmOrderPrice, pmShares, pmLeg.tickSize, pmLeg.negRisk, true);
      tPmOrder = performance.now() - _tPm0;
      pmFilled = true;
      pmOrderIdForVerify = "";
      console.log(`  [PM LEG] [DRY] ${JSON.stringify(dryResult).slice(0, 200)}`);
    } else {
      console.log(`  [PM LEG] FOK at ${fmtPct(pmOrderPrice)} qty=${pmShares}`);
      let fokResult: unknown;
      let fokFailed = false;
      try {
        fokResult = await placePmFOK(pmLeg.tokenId, pmOrderPrice, pmShares, pmLeg.tickSize, pmLeg.negRisk, false);
      } catch (e) { fokResult = e; fokFailed = true; }

      if (fokFailed) {
        console.error(`  [PM LEG] FOK failed: ${(fokResult as Error).message} -- entering hedge.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-fok-failed");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }

      const fokMeta = extractPmMeta(fokResult);
      if (isPm425(fokResult)) {
        markPmDown();
        console.error(`  [PM LEG] Service not ready (425). Entering hedge.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-425");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
      if (typeof fokMeta.status === "number") {
        console.error(`  [PM LEG] Rejected (HTTP ${fokMeta.status}). Entering hedge.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-rejected");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
      markPmUp();

      if (fokMeta.status === "matched") {
        console.log(`  [PM LEG] FOK filled at ${fmtPct(pmOrderPrice)}`);
        pmFilled = true;
        pmFinalOrderId = fokMeta.orderId ? String(fokMeta.orderId) : "";
      } else if (fokMeta.status === "delayed" && fokMeta.orderId) {
        // FOK matched but on-chain confirmation pending -- poll for it
        console.log(`  [PM LEG] FOK delayed (on-chain pending), polling for confirmation...`);
        const _tPoll0 = performance.now();
        const finalStatus = await waitForPmOrderFill(String(fokMeta.orderId), 20_000, pmLeg.tokenId, pmPreBalance);
        tPmPoll = performance.now() - _tPoll0;
        if (finalStatus === "matched") {
          console.log(`  [PM LEG] Confirmed filled after delay (${tPmPoll.toFixed(0)}ms).`);
          pmFilled = true;
          pmFinalOrderId = String(fokMeta.orderId);
        } else {
          // Check on-chain as last resort
          try {
            const bal = await getOnChainBalance(pmLeg.tokenId);
            const newShares = bal - pmPreBalance;
            if (newShares >= pmShares) {
              console.log(`  [PM LEG] On-chain confirms ${newShares} new shares. Proceeding.`);
              pmFilled = true;
              pmFinalOrderId = String(fokMeta.orderId);
            } else if (newShares > 0) {
              console.warn(`  [PM LEG] Partial on-chain ${newShares}/${pmShares}. Hedging remainder.`);
              metric.firstLegFilled = kalFilled;
              metric.secondLegFilled = newShares;
              saveExecMetric("hedge-entry", "pm-fok-partial");
              return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled - newShares) };
            }
          } catch { /* fall through to hedge */ }
        }
      }

      if (!pmFilled) {
        // FOK not filled -- check on-chain one last time
        try {
          const bal = await getOnChainBalance(pmLeg.tokenId);
          if (bal >= pmPreBalance + pmShares) {
            console.log(`  [PM LEG] Final on-chain check: ${bal - pmPreBalance} new shares found. Proceeding.`);
            pmFilled = true;
            pmFinalOrderId = fokMeta.orderId ? String(fokMeta.orderId) : "";
          }
        } catch { /* fall through */ }
      }

      if (!pmFilled) {
        // Before entering hedge mode, check if PM wallet already holds enough shares
        // from a prior ghost fill (e.g., a previous attempt that appeared to fail but actually filled on-chain).
        try {
          const totalPmBal = await getOnChainBalance(pmLeg.tokenId);
          if (totalPmBal >= pmShares) {
            // Count PM shares already claimed by other active/resolved trades for this token
            const existingTrades = loadArbTrades();
            const claimedPmShares = existingTrades
              .filter(t => t.pmTokenId === pmLeg.tokenId && t.pmCost > 0)
              .reduce((s, t) => s + t.shares, 0);
            const unclaimedPm = totalPmBal - claimedPmShares;
            if (unclaimedPm >= pmShares) {
              console.log(
                `  [PM LEG] Ghost fill detected: PM wallet has ${totalPmBal} shares (${unclaimedPm} unclaimed) for ${pmLeg.outcome}.` +
                ` Arb already covered -- proceeding as filled.`
              );
              pmFilled = true;
              pmFinalOrderId = fokMeta.orderId ? String(fokMeta.orderId) : "";
            }
          }
        } catch (e) { console.warn(`  [PM LEG] Ghost fill check failed: ${(e as Error).message}`); }
      }

      if (!pmFilled) {
        // Cancel any orphan orders as safety net
        try {
          const n = await cancelAllPmOrdersForToken(pmLeg.tokenId);
          if (n > 0) console.log(`  [PM LEG] Safety-net: cancelled ${n} orphan orders.`);
        } catch (e) { console.warn(`  [PM LEG] Safety-net cancel failed: ${(e as Error).message}`); }
        console.warn(`  [PM LEG] FOK not filled. Hedging all ${kalFilled} Kalshi contracts.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-fok-not-filled");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
      tPmOrder = performance.now() - _tPm0;
    }

    pmOrderIdForVerify = pmFinalOrderId;
    console.log(`  [PM LEG] OK orderId=${pmFinalOrderId || "n/a"} filled=${pmShares}`);

    // Partial KAL fill: kalFilled < pmShares -> hedge the gap
    const unhedgedPmGap = pmShares - kalFilled;
    if (!DRY_RUN && unhedgedPmGap > 0) {
      console.warn(`  [PARTIAL] KAL filled ${kalFilled}, PM bought ${pmShares}. ${unhedgedPmGap} PM shares unhedged -- entering hedge.`);
      printTimings();
      const partialKalCost = Math.round((kalFilled * kalAsk + kalFeesTotal) * 100) / 100;
      const partialPmCost = Math.round(pmShares * pmAsk * 100) / 100;
      logArbTrade({
        id: `arb-${Date.now()}`,
        ts: new Date().toISOString(),
        match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
        dir,
        status: "hedging",
        shares: pmShares,
        kalTicker: kalLeg.ticker,
        kalFillPrice: kalAsk,
        kalCost: partialKalCost,
        kalFees: kalFeesTotal,
        pmOutcome: pmLeg.outcome,
        pmSlug: entry.pmSlug,
        pmTokenId: pmLeg.tokenId,
        pmFillPrice: pmAsk,
        pmCost: partialPmCost,
        totalCost: Math.round((partialKalCost + partialPmCost) * 100) / 100,
        projectedEdge: edge,
        projectedProfit,
        initialExchange: "pm",
      });
      metric.firstLegFilled = kalFilled;
      metric.secondLegFilled = pmShares;
      saveExecMetric("hedge-entry", "kal-partial-pm-gap");
      return { sessionSkip: true, unhedged: makeUnhedged("pm", unhedgedPmGap) };
    }
  }

  // -- Post-trade verification: triple-check PM fill before declaring success ---
  // Check 1: on-chain balanceOf (authoritative)
  // Check 2: CLOB API order status (orderId query)
  // Check 3: data-api positions (portfolio)
  // Only enter hedge if ALL checks fail to find the shares.
  if (!DRY_RUN) {
    const _tPmV0 = performance.now();
    let pmVerified = false;

    // Check 1: On-chain balance (authoritative) -- compare against pre-balance
    try {
      const onChainBal = await getOnChainBalanceWithFallback(pmLeg.tokenId);
      const newShares = onChainBal - pmPreBalance;
      if (newShares > 0) {
        console.log(`  [POST-FILL] [OK] On-chain verified: ${newShares} new shares (total=${onChainBal}, pre=${pmPreBalance}) PM ${pmLeg.outcome}`);
        pmVerified = true;
      } else if (onChainBal >= 0) {
        console.warn(`  [POST-FILL] On-chain: 0 new shares (total=${onChainBal}, pre=${pmPreBalance}) for ${pmLeg.outcome}. Trying other checks...`);
      } else {
        console.warn(`  [POST-FILL] On-chain check failed (RPC). Trying other checks...`);
      }
    } catch (e) {
      console.warn(`  [POST-FILL] On-chain error: ${(e as Error).message}. Trying other checks...`);
    }

    // Check 2: CLOB API order status (if we have an orderId)
    if (!pmVerified && pmOrderIdForVerify) {
      try {
        const orderCheck = await getPmOrderFills(pmOrderIdForVerify);
        if (orderCheck.status === "matched" || orderCheck.filledShares > 0) {
          console.log(`  [POST-FILL] [OK] CLOB API verified: status=${orderCheck.status} filled=${orderCheck.filledShares}`);
          pmVerified = true;
        } else {
          console.warn(`  [POST-FILL] CLOB API: status=${orderCheck.status} filled=${orderCheck.filledShares}`);
        }
      } catch (e) {
        console.warn(`  [POST-FILL] CLOB API error: ${(e as Error).message}`);
      }
    }

    // Check 3: Data-api positions (portfolio)
    if (!pmVerified) {
      try {
        const verifyPos = await fetchPmPositionsCached(0);
        const actualPm = sumPmHeld(verifyPos, pmLeg.tokenId);
        if (actualPm > 0) {
          console.log(`  [POST-FILL] [OK] Data-api verified: ${actualPm}x PM ${pmLeg.outcome}`);
          pmVerified = true;
        } else {
          console.warn(`  [POST-FILL] Data-api: 0 shares for ${pmLeg.outcome}`);
        }
      } catch (e) {
        console.warn(`  [POST-FILL] Data-api error: ${(e as Error).message}`);
      }
    }

    tPmVerify = performance.now() - _tPmV0;

    if (!pmVerified) {
      console.warn(`  [POST-FILL] [!] ALL 3 checks failed to confirm PM fill. Entering hedge for ${shares} Kalshi contracts.`);
      printTimings();
      metric.firstLegFilled = shares;
      saveExecMetric("hedge-entry", "post-verify-all-failed");
      return { sessionSkip: true, unhedged: makeUnhedged("kal", shares) };
    }
  }

  printTimings();
  console.log(`  [DONE] ${entry.kal1.surname} vs ${entry.kal2.surname}  dir=${dir}  edge=${fmtPct(edge, 2)}`);
  // Use actual Kalshi fill cost if available, otherwise fall back to snapshot
  const kalRawCost = kalFillCostCents > 0
    ? kalFillCostCents / 100
    : shares * kalAsk;
  const kalCostWithFees = Math.round((kalRawCost + kalFeesTotal) * 100) / 100;
  const actualKalFillPrice = kalFillCostCents > 0 && kalFilled > 0
    ? Math.round((kalFillCostCents / 100 / kalFilled) * 10000) / 10000
    : kalAsk;
  // Use the ACTUAL order price (which may have been capped at breakeven), not the scan-time ask.
  const actualPmFillPrice = pmOrderPrice;
  const pmCostBothLegs = Math.round(shares * actualPmFillPrice * 100) / 100;
  if (kalFillCostCents > 0) {
    console.log(`  [COST] KAL actual fill: ${kalFilled}x${(actualKalFillPrice * 100).toFixed(1)}c = $${kalRawCost.toFixed(2)} + $${kalFeesTotal.toFixed(2)} fee (snapshot was ${(kalAsk * 100).toFixed(0)}c)`);
  }
  if (actualPmFillPrice !== pmAsk) {
    console.log(`  [COST] PM price capped: scan=${fmtPct(pmAsk)} -> order=${fmtPct(actualPmFillPrice)}`);
  }
  logArbTrade({
    id: `arb-${Date.now()}`,
    ts: new Date().toISOString(),
    match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
    dir,
    status: "filled",
    shares,
    kalTicker: kalLeg.ticker,
    kalFillPrice: actualKalFillPrice,
    kalCost: kalCostWithFees,
    kalFees: kalFeesTotal,
    pmOutcome: pmLeg.outcome,
    pmSlug: entry.pmSlug,
    pmTokenId: pmLeg.tokenId,
    pmFillPrice: actualPmFillPrice,
    pmCost: pmCostBothLegs,
    totalCost: Math.round((kalCostWithFees + pmCostBothLegs) * 100) / 100,
    projectedEdge: edge,
    projectedProfit,
    realizedPnl: Math.round((shares - kalCostWithFees - pmCostBothLegs) * 100) / 100,
    initialExchange: pmFirst ? "pm" : "kal",
    ...(kalFilledViaMaker ? { kalMakerFill: true } : {}),
  });
  // Both legs filled -- skip this match for the rest of the session to prevent
  // re-arbing in the opposite direction (which would create contradictory positions).
  metric.firstLegFilled = shares;
  metric.secondLegFilled = shares;
  saveExecMetric("both-filled");
  return { sessionSkip: true, unhedged: null };
}

// --- 3-Leg execution (Soccer dirs A-F) ----------------------------------------
// A: KAL Home YES + KAL Draw YES + PM Away YES   (2 KAL + 1 PM)
// B: KAL Home YES + PM Draw YES  + KAL Away YES  (2 KAL + 1 PM)
// C: PM Home YES  + KAL Draw YES + KAL Away YES  (2 KAL + 1 PM)
// D: KAL Home YES + PM Draw YES  + PM Away YES   (1 KAL + 2 PM)
// E: PM Home YES  + KAL Draw YES + PM Away YES   (1 KAL + 2 PM)
// F: PM Home YES  + PM Draw YES  + KAL Away YES  (1 KAL + 2 PM)
//
// Strategy: place the minority-exchange side first (cheaper to unwind if it fails),
// then place the majority side. If 2 of 3 fill and the 3rd fails, enter hedge mode
// for the single missing leg (reuses existing hedge infrastructure).

type Leg3 = {
  exchange: "kal" | "pm";
  kalLeg: KalshiLeg;  // the Kalshi market for this outcome (used for hedge recovery)
  pmLeg: PmLeg;       // the PM market for this outcome (used for hedge recovery)
  side: "yes";        // always YES for 3-leg
  price: number;      // expected fill price
};

function map3LegDir(entry: WatchEntry, dir: ArbDir): Leg3[] | null {
  if (!entry.is3Way || !entry.kal3 || !entry.pm3) return null;
  // Map each dir to [leg1, leg2, leg3] where leg1 is the minority-exchange side
  switch (dir) {
    case "A": return [ // 2 KAL + 1 PM -> PM first
      { exchange: "pm",  kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // PM Away
      { exchange: "kal", kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // KAL Home
      { exchange: "kal", kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // KAL Draw
    ];
    case "B": return [
      { exchange: "pm",  kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // PM Draw
      { exchange: "kal", kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // KAL Home
      { exchange: "kal", kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // KAL Away
    ];
    case "C": return [
      { exchange: "pm",  kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // PM Home
      { exchange: "kal", kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // KAL Draw
      { exchange: "kal", kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // KAL Away
    ];
    case "D": return [ // 1 KAL + 2 PM -> KAL first
      { exchange: "kal", kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // KAL Home
      { exchange: "pm",  kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // PM Draw
      { exchange: "pm",  kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // PM Away
    ];
    case "E": return [
      { exchange: "kal", kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // KAL Draw
      { exchange: "pm",  kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // PM Home
      { exchange: "pm",  kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // PM Away
    ];
    case "F": return [
      { exchange: "kal", kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // KAL Away
      { exchange: "pm",  kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // PM Home
      { exchange: "pm",  kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // PM Draw
    ];
    default: return null;
  }
}

async function executeArb3Leg(
  entry: WatchEntry,
  dir: ArbDir,
  edge: number
): Promise<{ sessionSkip: boolean; unhedged: UnhedgedPosition | null; abortReason?: string }> {
  const execStart = performance.now();
  const legs = map3LegDir(entry, dir);
  if (!legs) return { sessionSkip: false, unhedged: null, abortReason: "soft" };

  // Compute per-leg prices from current WS/cached data
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  for (const leg of legs) {
    if (leg.exchange === "pm") {
      const ask = getWsPmBestAsk(leg.pmLeg.tokenId) ?? await fetchPmAsk(leg.pmLeg.tokenId, clobBase);
      leg.price = ask ?? 0;
    } else {
      leg.price = leg.kalLeg.yesAsk;
    }
  }

  const totalCostPerShare = legs.reduce((sum, l) => sum + l.price, 0);
  const realEdge = 1 - totalCostPerShare - legs.filter(l => l.exchange === "kal").reduce((f, l) => f + estimateFees(l.price, 0), 0);
  if (realEdge < MIN_EDGE) {
    console.log(`  [3LEG] Edge evaporated: ${fmtPct(realEdge)} < ${fmtPct(MIN_EDGE)}. Skipping.`);
    return { sessionSkip: false, unhedged: null, abortReason: "soft" };
  }

  // Sizing: budget-limited, capped at MAX_CONTRACTS, floored by PM min size
  const sharesByBudget = Math.max(1, Math.floor(TRADE_USD / totalCostPerShare));
  let shares = Math.min(sharesByBudget, MAX_CONTRACTS);
  const pmLegs = legs.filter(l => l.exchange === "pm");
  for (const pl of pmLegs) {
    const pmMinByFOK = pl.price > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pl.price) : pl.pmLeg.minSize;
    const effectiveMin = Math.max(pl.pmLeg.minSize, pmMinByFOK);
    if (shares < effectiveMin) shares = effectiveMin;
  }
  if (shares * totalCostPerShare > TRADE_USD * 2) {
    console.log(`  [3LEG] Cost too high: ${shares} x $${totalCostPerShare.toFixed(3)} = $${(shares * totalCostPerShare).toFixed(2)} > 2x budget. Skipping.`);
    return { sessionSkip: false, unhedged: null, abortReason: "soft" };
  }

  const totalCost = shares * totalCostPerShare;
  const projectedProfit = shares * realEdge;
  const tag = DRY_RUN ? "[DRY]" : "[LIVE]";
  const matchName = `${entry.kal1.surname} vs ${entry.kal2.surname}`;
  console.log(
    `\n${ts()} ${tag} 3-LEG EXECUTE  dir=${dir}  edge=${fmtPct(realEdge, 2)}` +
    `  shares=${shares}  cost~=$${totalCost.toFixed(2)}  profit~=$${projectedProfit.toFixed(2)}`
  );
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    console.log(`  Leg${i + 1}: ${l.exchange.toUpperCase()} ${l.exchange === "kal" ? l.kalLeg.ticker : l.pmLeg.outcome} YES @${fmtPct(l.price)}`);
  }

  // -- Start execution-time book tracker for the KAL leg ----------------------
  {
    const kalLeg3 = legs.find(l => l.exchange === "kal");
    const pmLeg3 = legs.find(l => l.exchange === "pm");
    if (kalLeg3 && pmLeg3) {
      startBookTracker(kalLeg3.kalLeg.ticker, pmLeg3.pmLeg.tokenId, {
        match: matchName, dir, pmOutcome: pmLeg3.pmLeg.outcome,
        kalAsk: kalLeg3.price, pmAsk: pmLeg3.price, edge: realEdge,
        tradeTs: Date.now(),
      }, "execution");
    }
  }

  // -- Execute legs sequentially ----------------------------------------------
  const filled: { leg: Leg3; fillPrice: number; fillCost: number; kalFees?: number }[] = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const legLabel = `Leg${i + 1}/${legs.length}`;

    if (leg.exchange === "pm") {
      // PM: FOK order
      console.log(`  [${legLabel}] PM FOK ${shares}x${leg.pmLeg.outcome} @${fmtPct(leg.price)}`);
      try {
        const res = await placePmFOK(leg.pmLeg.tokenId, leg.price, shares, leg.pmLeg.tickSize, leg.pmLeg.negRisk, DRY_RUN);
        const meta = extractPmMeta(res);
        if (DRY_RUN) {
          console.log(`  [${legLabel}] PM DRY OK`);
          filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
          continue;
        }
        if (meta.status === "matched") {
          console.log(`  [${legLabel}] PM filled`);
          filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
          continue;
        }
        if (meta.status === "delayed" && meta.orderId) {
          const finalStatus = await waitForPmOrderFill(String(meta.orderId), 20_000, leg.pmLeg.tokenId);
          if (finalStatus === "matched") {
            console.log(`  [${legLabel}] PM filled (delayed)`);
            filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
            continue;
          }
        }
        // PM failed -- handle partial state
        console.log(`  [${legLabel}] PM REJECTED: status=${meta.status}`);
      } catch (err) {
        console.error(`  [${legLabel}] PM ERROR: ${(err as Error).message}`);
      }
    } else {
      // KAL: limit order at listing price
      const kalLimitCents = Math.max(1, Math.min(99, Math.round(leg.price * 100)));
      console.log(`  [${legLabel}] KAL ${leg.kalLeg.ticker} YES @${kalLimitCents}c x${shares}`);
      try {
        const kalOrder = buildKalshiGTCOrder(leg.kalLeg.ticker, "buy", "yes", kalLimitCents, shares);
        const kalRes = await placeKalshiOrder(kalOrder, DRY_RUN);
        if (DRY_RUN) {
          console.log(`  [${legLabel}] KAL DRY OK`);
          filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
          continue;
        }
        const kr = kalRes as any;
        const kalFilledQty = Number(kr?.order?.count_filled ?? kr?.count_filled ?? 0);
        const kalFees = Number(kr?.order?.taker_fees ?? kr?.taker_fees ?? 0) / 100;
        const kalFillCost = Number(kr?.order?.taker_fill_cost ?? kr?.taker_fill_cost ?? 0) / 100;
        if (kalFilledQty >= shares) {
          const actualPrice = kalFillCost > 0 ? kalFillCost / kalFilledQty : leg.price;
          console.log(`  [${legLabel}] KAL filled ${kalFilledQty} @${(actualPrice * 100).toFixed(1)}c fees=$${kalFees.toFixed(3)}`);
          filled.push({ leg, fillPrice: actualPrice, fillCost: kalFillCost + kalFees, kalFees });
          continue;
        }
        // Partial or no fill -- ALWAYS cancel the GTC order to prevent orphaned positions.
        // Without cancellation, the GTC order stays resting on Kalshi, fills later,
        // and creates untracked exposure with no arb_trades entry.
        const orderId = String(kr?.order?.order_id ?? kr?.order_id ?? "");
        if (orderId) {
          try { await cancelKalshiOrder(orderId, DRY_RUN); } catch { /* order may already be gone */ }
        }
        if (kalFilledQty > 0) {
          console.log(`  [${legLabel}] KAL PARTIAL: ${kalFilledQty}/${shares} -- cancelled remaining, treating as failed`);
        }
        console.log(`  [${legLabel}] KAL FAILED/PARTIAL`);
      } catch (err) {
        console.error(`  [${legLabel}] KAL ERROR: ${(err as Error).message}`);
      }
    }

    // -- Leg failed -- handle based on how many legs already filled ---------
    if (filled.length === 0) {
      // First leg failed -- clean exit, no exposure
      console.log(`  [3LEG] First leg failed. No exposure. Aborting.`);
      return { sessionSkip: false, unhedged: null, abortReason: "soft" };
    }

    if (filled.length === 1) {
      // Only 1 of 3 filled -- try to sell it back immediately
      const f = filled[0];
      console.log(`  [3LEG] Only 1 leg filled (${f.leg.exchange}). Attempting immediate exit...`);
      if (f.leg.exchange === "pm") {
        // We hold a PM token -- we can't easily sell back via FOK, enter hedge to exit
        // Create unhedged pointing at the PM leg as held, needing KAL to "complete"
        // But actually we just want to exit. The hedge system's "exit" path will sell it.
        const tid5453 = `arb-${Date.now()}`;
        const unhedged: UnhedgedPosition = {
          tradeId: tid5453,
          heldExchange: "pm",
          pmLeg: f.leg.pmLeg,
          pmOppLeg: null,
          pmCostBasis: f.fillPrice,
          kalLeg: f.leg.kalLeg,
          kalCostBasis: 0,
          kalSide: "yes",
          sharesHeld: shares,
          initialShares: shares,
          initialCost: f.fillCost,
          hedgeFillCost: 0,
          hedgeFillCostKal: 0,
          hedgeFillCostPm: 0,
          kalFees: 0,
          initialKalFees: 0,
        };
        logArbTrade({
          id: tid5453, ts: new Date().toISOString(),
          match: matchName, dir, status: "hedging", shares,
          kalTicker: f.leg.kalLeg.ticker, kalFillPrice: 0, kalCost: 0,
          pmOutcome: f.leg.pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: f.leg.pmLeg.tokenId,
          pmFillPrice: f.fillPrice, pmCost: f.fillCost,
          totalCost: f.fillCost, projectedEdge: edge, projectedProfit: shares * edge,
          initialExchange: "pm",
        });
        return { sessionSkip: true, unhedged };
      } else {
        // We hold KAL YES -- enter hedge to acquire PM or exit
        const tid5481 = `arb-${Date.now()}`;
        const unhedged: UnhedgedPosition = {
          tradeId: tid5481,
          heldExchange: "kal",
          pmLeg: f.leg.pmLeg,
          pmOppLeg: null,
          pmCostBasis: 0,
          kalLeg: f.leg.kalLeg,
          kalCostBasis: f.fillPrice + (f.kalFees ?? 0) / shares,
          kalSide: "yes",
          sharesHeld: shares,
          initialShares: shares,
          initialCost: f.fillCost,
          hedgeFillCost: 0,
          hedgeFillCostKal: 0,
          hedgeFillCostPm: 0,
          kalFees: f.kalFees ?? 0,
          initialKalFees: f.kalFees ?? 0,
        };
        logArbTrade({
          id: tid5481, ts: new Date().toISOString(),
          match: matchName, dir, status: "hedging", shares,
          kalTicker: f.leg.kalLeg.ticker, kalFillPrice: f.fillPrice, kalCost: f.fillCost,
          kalFees: f.kalFees,
          pmOutcome: f.leg.pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: f.leg.pmLeg.tokenId,
          pmFillPrice: 0, pmCost: 0,
          totalCost: f.fillCost, projectedEdge: edge, projectedProfit: shares * edge,
          initialExchange: "kal",
        });
        return { sessionSkip: true, unhedged };
      }
    }

    // filled.length === 2, missing leg i (the one that just failed)
    // We hold 2 of 3 outcomes -- need the 3rd to complete the $1 guarantee
    const missingLeg = leg;
    console.log(`  [3LEG] 2 of 3 legs filled. Missing: ${missingLeg.exchange} ${missingLeg.exchange === "kal" ? missingLeg.kalLeg.ticker : missingLeg.pmLeg.outcome}. Entering hedge mode.`);

    // Build UnhedgedPosition for the missing leg
    // heldExchange = opposite of missing leg's exchange -> hedge tries the right exchange first
    const heldEx = missingLeg.exchange === "kal" ? "pm" as const : "kal" as const;
    const totalFilledCost = filled.reduce((s, f) => s + f.fillCost, 0);
    const totalKalFees = filled.reduce((s, f) => s + (f.kalFees ?? 0), 0);

    const tid5522 = `arb-${Date.now()}`;
    const unhedged: UnhedgedPosition = {
      tradeId: tid5522,
      heldExchange: heldEx,
      pmLeg: missingLeg.pmLeg,     // the PM version of the missing outcome
      pmOppLeg: null,              // no opposite in 3-way
      pmCostBasis: heldEx === "pm" ? filled.find(f => f.leg.exchange === "pm")?.fillPrice ?? 0 : 0,
      kalLeg: missingLeg.kalLeg,   // the KAL version of the missing outcome
      kalCostBasis: heldEx === "kal"
        ? (filled.find(f => f.leg.exchange === "kal")?.fillPrice ?? 0) + totalKalFees / Math.max(shares, 1)
        : 0,
      kalSide: "yes",
      sharesHeld: shares,
      initialShares: shares,
      initialCost: totalFilledCost,
      hedgeFillCost: 0,
      hedgeFillCostKal: 0,
      hedgeFillCostPm: 0,
      kalFees: totalKalFees,
      initialKalFees: heldEx === "kal" ? totalKalFees : 0,
    };

    // Log arb trade in hedging state -- use the missing leg's KAL ticker as the primary
    logArbTrade({
      id: tid5522, ts: new Date().toISOString(),
      match: matchName, dir, status: "hedging", shares,
      kalTicker: missingLeg.kalLeg.ticker,
      kalFillPrice: filled.find(f => f.leg.exchange === "kal")?.fillPrice ?? 0,
      kalCost: filled.filter(f => f.leg.exchange === "kal").reduce((s, f) => s + f.fillCost, 0),
      kalFees: totalKalFees,
      pmOutcome: missingLeg.pmLeg.outcome,
      pmSlug: entry.pmSlug,
      pmTokenId: missingLeg.pmLeg.tokenId,
      pmFillPrice: filled.find(f => f.leg.exchange === "pm")?.fillPrice ?? 0,
      pmCost: filled.filter(f => f.leg.exchange === "pm").reduce((s, f) => s + f.fillCost, 0),
      totalCost: totalFilledCost,
      projectedEdge: edge, projectedProfit: shares * edge,
      initialExchange: heldEx,
    });
    return { sessionSkip: true, unhedged };
  }

  // -- All 3 legs filled! ------------------------------------------------------
  const totalFilledCost = filled.reduce((s, f) => s + f.fillCost, 0);
  const totalKalFees = filled.reduce((s, f) => s + (f.kalFees ?? 0), 0);
  const realizedProfit = shares - totalFilledCost;
  console.log(
    `\n${ts()} [3LEG SUCCESS] All 3 legs filled!` +
    `  shares=${shares}  cost=$${totalFilledCost.toFixed(2)}  profit=$${realizedProfit.toFixed(2)}  kalFees=$${totalKalFees.toFixed(3)}`
  );

  // Record completed arb trade -- use first KAL leg's ticker as primary
  const firstKal = filled.find(f => f.leg.exchange === "kal");
  const firstPm = filled.find(f => f.leg.exchange === "pm");
  logArbTrade({
    id: `arb-${Date.now()}`,
    ts: new Date().toISOString(),
    match: matchName, dir,
    status: "resolved",
    shares,
    kalTicker: firstKal?.leg.kalLeg.ticker ?? legs[0].kalLeg.ticker,
    kalFillPrice: firstKal?.fillPrice ?? 0,
    kalCost: filled.filter(f => f.leg.exchange === "kal").reduce((s, f) => s + f.fillCost, 0),
    kalFees: totalKalFees,
    pmOutcome: firstPm?.leg.pmLeg.outcome ?? legs[0].pmLeg.outcome,
    pmSlug: entry.pmSlug,
    pmTokenId: firstPm?.leg.pmLeg.tokenId ?? legs[0].pmLeg.tokenId,
    pmFillPrice: firstPm?.fillPrice ?? 0,
    pmCost: filled.filter(f => f.leg.exchange === "pm").reduce((s, f) => s + f.fillCost, 0),
    totalCost: totalFilledCost,
    projectedEdge: edge, projectedProfit: shares * edge,
    realizedPnl: Math.round(realizedProfit * 100) / 100,
    resolvedTs: new Date().toISOString(),
    resolutionMethod: "both-legs",
    initialExchange: legs[0].exchange === "pm" ? "pm" : "kal",
  });

  console.log(`  [3LEG TIMING] Total=${(performance.now() - execStart).toFixed(0)}ms`);
  return { sessionSkip: true, unhedged: null };
}

// --- Hedge mode ---------------------------------------------------------------
// When one leg filled but the other failed, we stop scanning new arbs and instead:
//   "complete" order: resting GTC buy on the missing leg at max profitable price
//   "exit"     order: resting GTC sell on the held leg at the current best bid/ask
//                     (to exit at profit if the market moves in our favour)

// Helper: re-check final fills on all GTC orders, account for any last-moment fills,
// then cancel remaining orders.  Prevents losing fill accounting in the race between
// an IOC sweep and a GTC that filled during the same cycle.
async function recheckAndCancelAll(
  pos: UnhedgedPosition,
  activeOrders: Map<string, HedgeOrder>,
  dryRun: boolean
): Promise<void> {
  for (const [oid, ho] of activeOrders) {
    // Re-check final fill count before cancelling
    try {
      let latestFilled = ho.filledSoFar;
      if (ho.exchange === "pm") {
        const { filledShares } = await getPmOrderFills(oid);
        latestFilled = filledShares;
      } else {
        const order = await getKalshiOrder(oid);
        latestFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled ?? ho.filledSoFar);
        // Safety: if order shows executed but fills=0, infer from remaining_count
        const rcSt = String(order.status ?? "");
        if (latestFilled === 0 && (rcSt === "executed" || rcSt === "filled")) {
          const remaining = Number(order.remaining_count ?? ho.shares);
          const inferred = ho.shares - remaining;
          if (inferred > 0) {
            console.warn(`[HEDGE] recheckCancel: fill count missing for ${rcSt} order -- inferred ${inferred} fills`);
            latestFilled = inferred;
          }
        }
      }
      const delta = latestFilled - ho.filledSoFar;
      if (delta > 0) {
        pos.sharesHeld = Math.max(0, pos.sharesHeld - delta);
        if (ho.role === "complete") {
          pos.hedgeFillCost += delta * ho.price;
          if (ho.exchange === "kal") pos.hedgeFillCostKal += delta * ho.price;
          else pos.hedgeFillCostPm += delta * ho.price;
        }
        console.log(`[HEDGE] Late GTC fill detected: ${ho.exchange.toUpperCase()} ${ho.role} +${delta}. Remaining: ${pos.sharesHeld}`);
      }
    } catch { /* order may already be gone -- proceed to cancel */ }
    // Cancel the order
    try {
      if (ho.exchange === "pm") await cancelPmOrder(oid, dryRun);
      else await cancelKalshiOrder(oid, dryRun);
      console.log(`[HEDGE] Cancelled GTC ${ho.exchange.toUpperCase()} ${ho.role} ${oid.slice(0, 16)}... after IOC fill.`);
    } catch { /* best effort */ }
  }
  activeOrders.clear();
}

// -- Hedge Mode Strategy ------------------------------------------------------
// When only one arb leg fills, we hold an unhedged position. The bot hedges by
// racing orders on BOTH platforms simultaneously:
//
//   Holding PM token (e.g. P2):
//     • Complete order on Kalshi: GTC bid for P1 YES  -> completes the arb
//     • Complete order on PM:     GTC bid for P1 token -> completes the arb
//     • Exit order on PM:         GTC ask selling held P2 token -> exits position
//
//   Holding Kalshi YES (e.g. P1):
//     • Complete order on PM:     GTC bid for P2 token -> completes the arb
//     • Complete order on Kalshi:  GTC bid for P2 NO   -> completes the arb
//     • Exit order on Kalshi:     GTC ask selling held P1 YES -> exits position
//
// Cross-platform exit (e.g. selling PM token on Kalshi) is NOT possible -- you
// can only sell assets you hold on the platform where you hold them. Buying the
// opposite contract on the other platform would create a NEW position, not close
// the existing one. The dual complete orders already cover both fill paths.
//
// Each hedge cycle also attempts an aggressive FOK sweep on PM to fill instantly.
// -----------------------------------------------------------------------------
let _hedgeLastExitLog = "";  // deduplicate PM exit skip log
let _hedgeLogCounter = 0;    // cycle counter for periodic status summary

// --- Cancellation Monitor ----------------------------------------------------
// Polls Kalshi market status for ALL open positions (filled + hedging).
// Detects scalar settlements (match cancelled/voided) and immediately sells
// PM tokens before PM resolves 50/50, recovering maximum value.
//
// Scalar detection signals:
//   - result === "scalar"
//   - settlement_value is NOT 0, 100, or empty (fractional payout)
//
// On detection: place GTC ASK on PM at max(bestBid, 0.50) to exit fast.
// -----------------------------------------------------------------------------

// Track which kalTickers we've already processed for cancellation (avoid re-selling)
const _cancelledTickers = new Set<string>();
// Track cancelled EVENTS (not just tickers) -- e.g. "FNMKOI" and "FNKOIA" are both
// from the same match. If one settles scalar, block all sibling markets.
// Key = event keyword extracted from ticker (e.g. "26MAR09" + team combo).
const _cancelledEventKeys = new Set<string>();
let _cancMonLastRun = 0;
const CANC_MON_INTERVAL_MS = 10_000; // check every 10s

/**
 * Extract a "match fingerprint" from a Kalshi ticker to detect sibling markets.
 * E.g. KXLOLGAME-26MAR09FNMKOI-MKOI -> "KXLOLGAME-26MAR09" + sorted team codes.
 * KXLOLGAME-26MAR09FNKOIA-KOIA would share the same date prefix.
 * We use the date portion + series as key since Kalshi uses different event codes
 * for rescheduled markets of the same match.
 */
function extractEventDateKey(ticker: string): string {
  // Ticker format: SERIES-DDMMMYYTEAMS-PLAYER  e.g. KXLOLGAME-26MAR09FNMKOI-MKOI
  const parts = ticker.split("-");
  if (parts.length < 2) return ticker;
  const series = parts[0]; // KXLOLGAME
  const middle = parts[1]; // 26MAR09FNMKOI
  // Extract date portion (first 7 chars: DDMMMYY)
  const dateMatch = middle.match(/^(\d{2}[A-Z]{3}\d{2})/);
  if (!dateMatch) return ticker;
  return `${series}-${dateMatch[1]}`; // e.g. "KXLOLGAME-26MAR09"
}

type OpenPosition = {
  kalTicker: string;
  pmTokenId: string;
  pmOutcome: string;
  pmSlug: string;
  shares: number;
  pmCost: number;
  kalCost: number;
  hedgeCost: number;
  tickSize: number;
  negRisk: boolean;
  tradeId: string;
  status: "filled" | "hedging" | "resolved";
};

/** Collect all positions that need void monitoring -- includes resolved trades
 *  from the last 48h that may not have settled on Kalshi yet. */
function collectOpenPositions(watchlist: WatchEntry[]): OpenPosition[] {
  const trades = loadArbTrades();
  const positions: OpenPosition[] = [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48h lookback

  for (const t of trades) {
    if (!t.kalTicker) continue;
    // Already handled by cancellation monitor
    if (_cancelledTickers.has(t.kalTicker)) continue;
    // Skip resolved trades already marked as scalar settlement (already handled)
    if (t.status === "resolved" && t.scalarSettlement) continue;
    // For resolved trades, only include recent ones (within 48h)
    if (t.status === "resolved" && new Date(t.ts).getTime() < cutoff) continue;

    // Find the watchlist entry to get tickSize/negRisk
    const we = t.pmTokenId
      ? watchlist.find(w => w.pm1.tokenId === t.pmTokenId || w.pm2.tokenId === t.pmTokenId || (w.pm3 && w.pm3.tokenId === t.pmTokenId))
      : null;
    const pmLeg = we
      ? (we.pm1.tokenId === t.pmTokenId ? we.pm1 : we.pm2.tokenId === t.pmTokenId ? we.pm2 : we.pm3 ?? we.pm2)
      : null;

    positions.push({
      kalTicker: t.kalTicker,
      pmTokenId: t.pmTokenId ?? "",
      pmOutcome: t.pmOutcome,
      pmSlug: t.pmSlug,
      shares: t.shares,
      pmCost: t.pmCost,
      kalCost: t.kalCost ?? 0,
      hedgeCost: t.hedgeCost ?? 0,
      tickSize: pmLeg?.tickSize ?? 0.01,
      negRisk: pmLeg?.negRisk ?? false,
      tradeId: t.id,
      status: t.status as "filled" | "hedging" | "resolved",
    });
  }
  return positions;
}

/** Check if a Kalshi market settled as scalar (cancelled/voided). */
function isScalarSettlement(mkt: KalshiMarket): boolean {
  const result = pickString(mkt.result ?? "").toLowerCase();
  if (result === "scalar") return true;

  // Also check settlement_value for non-binary values.
  // Kalshi sends settlement_value on a 0–1 dollar scale: 1.0 = YES, 0.0 = NO.
  // Anything fractional (e.g. 0.14, 0.50) indicates scalar/cancelled settlement.
  const sv = Number(mkt.settlement_value ?? "");
  if (Number.isFinite(sv) && sv > 0 && sv < 1) {
    return true;
  }
  return false;
}

/** Fetch PM book and return the best bid price (highest buyer). */
async function fetchPmBestBid(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await polyClobFetch<{ bids?: unknown }>(`${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!Array.isArray(book.bids)) return null;
    const prices: number[] = [];
    for (const entry of book.bids) {
      let price: number;
      if (Array.isArray(entry)) {
        price = Number(entry[0]);
      } else if (entry && typeof entry === "object") {
        price = Number((entry as Record<string, unknown>).price ?? (entry as Record<string, unknown>)[0] ?? NaN);
      } else {
        price = Number(entry);
      }
      if (Number.isFinite(price) && price > 0 && price < 1) prices.push(price);
    }
    return prices.length ? Math.max(...prices) : null;
  } catch {
    return null;
  }
}

/**
 * Run the cancellation monitor for all open positions.
 * Called from the main loop every ~60s. For each open position:
 *   1. Fetch Kalshi market status
 *   2. If scalar settlement detected -> emergency sell PM tokens
 *   3. Update arb_trades.json with cancellation resolution
 */
async function runCancellationMonitor(watchlist: WatchEntry[], hedgeStates: HedgeState[], clobBase: string): Promise<void> {
  const now = Date.now();
  if (now - _cancMonLastRun < CANC_MON_INTERVAL_MS) return;
  _cancMonLastRun = now;

  const positions = collectOpenPositions(watchlist);
  if (positions.length === 0) return;

  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

  // Deduplicate by kalTicker (multiple trades might reference same market)
  const uniqueTickers = new Map<string, OpenPosition[]>();
  for (const p of positions) {
    const existing = uniqueTickers.get(p.kalTicker) ?? [];
    existing.push(p);
    uniqueTickers.set(p.kalTicker, existing);
  }

  for (const [ticker, posGroup] of uniqueTickers) {
    try {
      const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
      const mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
      const mktStatus = pickString(mkt.status ?? mkt.state ?? "").toLowerCase();

      // Only check finalized/settled/closed markets
      if (mktStatus !== "closed" && mktStatus !== "settled" && mktStatus !== "resolved" && mktStatus !== "finalized") {
        continue;
      }

      // Check if this is a scalar (cancelled) settlement
      if (!isScalarSettlement(mkt)) {
        // Normal binary settlement -- mark as handled so we stop polling this ticker
        _cancelledTickers.add(ticker);
        continue;
      }

      const sv = Number(mkt.settlement_value ?? 0);
      console.error(
        `\n+==================================================================+\n` +
        `|  [!] CANCELLATION DETECTED: ${ticker}\n` +
        `|  Result: ${mkt.result}  Settlement: ${sv}c  Status: ${mktStatus}\n` +
        `|  Affected positions: ${posGroup.length} trade(s)\n` +
        `+==================================================================+\n`
      );

      // Mark ticker + event as handled (blocks sibling markets too)
      _cancelledTickers.add(ticker);
      _cancelledEventKeys.add(extractEventDateKey(ticker));

      // Process each affected trade
      for (const pos of posGroup) {
        await handleCancelledPosition(pos, mkt, hedgeStates, clobBase);
      }
    } catch (err) {
      // Transient fetch error -- will retry next cycle
      console.warn(`[CANC-MON] Failed to check ${ticker}: ${(err as Error).message}`);
    }
  }
}

/**
 * Handle a position affected by a cancelled/scalar-settled Kalshi market.
 *
 * Three scenarios:
 *
 *   1. BOTH LEGS FILLED (status="filled") -- We hold PM tokens + Kalshi already settled.
 *      -> Sell PM tokens into bids (FOK at bestBid if >= 50c, else GTC ask at 50c).
 *        Kalshi side already paid out at settlement_value automatically.
 *
 *   2. ONLY PM SHARES HELD (status="hedging", heldExchange="pm") -- We hold PM tokens,
 *      Kalshi leg was being hedged.
 *      -> Cancel ALL hedge orders on BOTH exchanges, then sell PM tokens same as #1.
 *
 *   3. ONLY KALSHI POSITION (status="hedging", heldExchange="kal") -- We hold Kalshi
 *      contracts, PM leg was being hedged.
 *      -> Cancel ALL hedge orders on BOTH exchanges. Kalshi settles automatically
 *        at settlement_value (we know the exact payout). No PM tokens to sell.
 */
async function handleCancelledPosition(
  pos: OpenPosition,
  mkt: KalshiMarket,
  hedgeStates: HedgeState[],
  clobBase: string
): Promise<void> {
  const sv = Number(mkt.settlement_value ?? 0);
  const svDecimal = sv > 1 ? sv / 100 : sv; // normalize cents (1-99) to decimal (0.01-0.99)

  console.log(
    `[CANC-MON] Processing ${pos.pmOutcome} (${pos.tradeId}): ` +
    `${pos.shares} shares, pmCost=$${pos.pmCost.toFixed(2)}, ` +
    `kalSettlement=${svDecimal.toFixed(2)}, status=${pos.status}`
  );

  // -- Step 1: Cancel ALL hedge orders on BOTH exchanges ----------------------
  const matchingHs = hedgeStates.find(hs => hs.position.kalLeg.ticker === pos.kalTicker);
  if (matchingHs) {
    for (const [oid, ho] of matchingHs.activeOrders) {
      try {
        if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
        else await cancelKalshiOrder(oid, DRY_RUN);
        console.log(`[CANC-MON] Cancelled ${ho.exchange.toUpperCase()} ${ho.role} order ${oid.slice(0, 16)}...`);
      } catch { /* order may already be gone */ }
    }
    matchingHs.activeOrders.clear();
  }

  // -- Step 2: Determine if we hold PM tokens ---------------------------------
  // Scenario 3: Kalshi-only position -- no PM tokens to sell.
  const isKalshiOnly = pos.status === "hedging" && matchingHs?.position.heldExchange === "kal";
  if (isKalshiOnly) {
    console.log(
      `[CANC-MON] Kalshi-only position for ${pos.kalTicker}. ` +
      `Kalshi settles at ${fmtPct(svDecimal)} automatically. No PM tokens to sell.`
    );
    // Kalshi payout is automatic. Resolve the trade record.
    const kalCost = matchingHs!.position.initialCost + matchingHs!.position.hedgeFillCostKal;
    const kalPayout = matchingHs!.position.initialShares * svDecimal;
    const realizedPnl = Math.round((kalPayout - kalCost) * 100) / 100;
    resolveArbTrade(pos.kalTicker, {
      status: "resolved",
      resolvedTs: new Date().toISOString(),
      resolutionMethod: "settlement",
      realizedPnl,
      scalarSettlement: true,
      kalSettlementValue: svDecimal,
      pmSettlementValue: 0,
      resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}c). Kalshi-only position -- no PM tokens.`,
    }, pos.tradeId);
    console.log(
      `[CANC-MON] Trade resolved (Kalshi-only): ` +
      `kalPayout=$${kalPayout.toFixed(2)} kalCost=$${kalCost.toFixed(2)} P&L=$${realizedPnl.toFixed(2)}`
    );
    if (matchingHs) matchingHs.position.sharesHeld = 0;
    return;
  }

  // -- Scenario 4: Already-resolved trade (both-legs, hedge-complete, etc.) --
  //    Trade was resolved normally but Kalshi voided the market AFTER resolution.
  //    KAL settles automatically at settlement_value. We may still hold PM tokens
  //    that should be sold if above 50c (void settles PM at 50/50).
  if (pos.status === "resolved") {
    const kalPayout = pos.shares * svDecimal;
    const totalCostPaid = pos.kalCost + pos.pmCost + pos.hedgeCost;
    console.log(
      `[CANC-MON] Resolved trade voided: ${pos.pmOutcome} (${pos.tradeId})\n` +
      `  KAL settles at ${fmtPct(svDecimal)} -> payout $${kalPayout.toFixed(2)}\n` +
      `  Original costs: KAL=$${pos.kalCost.toFixed(2)} PM=$${pos.pmCost.toFixed(2)} hedge=$${pos.hedgeCost.toFixed(2)}`
    );

    // Check if we still hold PM tokens
    let pmHeld = 0;
    if (pos.pmTokenId) {
      try {
        pmHeld = await getOnChainBalance(pos.pmTokenId);
        console.log(`[CANC-MON] On-chain PM balance: ${pmHeld} shares`);
      } catch { pmHeld = pos.shares; /* fallback to trade record */ }
    }

    // Sell PM tokens if we hold any and can get > 50c
    let pmRevenue = 0;
    if (pmHeld > 0) {
      const bestBid = await fetchPmBestBid(pos.pmTokenId, clobBase);
      const MIN_SELL = 0.50;
      const tick = pos.tickSize || 0.01;
      if (bestBid !== null && bestBid >= MIN_SELL) {
        const sellPrice = Math.round(bestBid / tick) * tick;
        console.log(`[CANC-MON] EMERGENCY SELL PM: ${pmHeld}x ${pos.pmOutcome} @ ${fmtPct(sellPrice)} (FOK into bids)`);
        if (!DRY_RUN) {
          try {
            await placePmFOKSell(pos.pmTokenId, sellPrice, pmHeld, pos.tickSize, pos.negRisk, false);
            pmRevenue = pmHeld * sellPrice;
          } catch (err) {
            console.error(`[CANC-MON] PM sell failed: ${(err as Error).message}`);
          }
        }
      } else {
        // Place GTC ask at 50c -- PM void settles at 50/50 so this is the floor
        const gtcPrice = Math.round(MIN_SELL / tick) * tick;
        console.log(`[CANC-MON] PM GTC ASK: ${pmHeld}x ${pos.pmOutcome} @ ${fmtPct(gtcPrice)} (floor price)`);
        if (!DRY_RUN) {
          try {
            await placePmGTCAsk(pos.pmTokenId, gtcPrice, pmHeld, pos.tickSize, pos.negRisk, false);
            pmRevenue = pmHeld * gtcPrice; // estimated
          } catch (err) {
            console.error(`[CANC-MON] PM GTC failed: ${(err as Error).message}`);
          }
        }
      }
    }

    // Update trade record with scalar settlement info
    const newPnl = Math.round((kalPayout + (pmHeld > 0 ? pmRevenue : 0) - totalCostPaid) * 100) / 100;
    resolveArbTrade(pos.kalTicker, {
      scalarSettlement: true,
      kalSettlementValue: svDecimal,
      pmSettlementValue: pmHeld > 0 ? (pmRevenue / pmHeld) : 0,
      resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}c). ${pmHeld > 0 ? "PM sell attempted." : "No PM tokens held."}`,
      realizedPnl: newPnl,
    }, pos.tradeId);
    console.log(
      `[CANC-MON] Resolved trade updated: kalPayout=$${kalPayout.toFixed(2)} ` +
      `pmSell~$${pmRevenue.toFixed(2)} totalCost=$${totalCostPaid.toFixed(2)} P&L=$${newPnl.toFixed(2)}`
    );
    return;
  }

  // -- Scenarios 1 & 2: We hold PM tokens (filled/hedging) -- need to sell them -

  // Step 3: Check actual PM holdings via on-chain balance (authoritative)
  let actualShares = pos.shares;
  try {
    const held = await getOnChainBalance(pos.pmTokenId);
    if (held >= 0) {
      actualShares = held;
      console.log(`[CANC-MON] On-chain PM balance: ${actualShares} shares`);
    }
  } catch { /* use trade record shares as fallback */ }

  if (actualShares <= 0) {
    console.log(`[CANC-MON] No PM shares to sell for ${pos.pmOutcome} -- skipping sell.`);
    if (matchingHs) matchingHs.position.sharesHeld = 0;
    return;
  }

  // Step 4: Fetch PM orderbook to find best bid
  const bestBid = await fetchPmBestBid(pos.pmTokenId, clobBase);
  console.log(`[CANC-MON] PM best bid for ${pos.pmOutcome}: ${bestBid !== null ? fmtPct(bestBid) : "no bids"}`);

  // Step 5: Sell strategy
  //   - If bestBid >= 50c -> aggressive FOK sell into bids at bestBid price (instant fill)
  //   - If bestBid < 50c or no bids -> GTC ask at 50c (wait for someone to buy;
  //     PM cancellation resolves 50/50 so 50c is guaranteed floor value)
  const MIN_SELL_PRICE = 0.50;
  const tick = pos.tickSize || 0.01;
  let sellPrice: number;
  let useAggressive = false; // FOK into bids vs GTC resting ask

  if (bestBid !== null && bestBid >= MIN_SELL_PRICE) {
    sellPrice = bestBid;
    useAggressive = true; // sell INTO bids immediately
  } else {
    sellPrice = MIN_SELL_PRICE;
    useAggressive = false; // rest a GTC ask at 50c
  }

  // Round to tick size
  sellPrice = Math.round(sellPrice / tick) * tick;
  sellPrice = Math.max(sellPrice, tick);

  // PM minimum order value check ($1)
  if (actualShares * sellPrice < 1.0) {
    const minPrice = Math.ceil(1.0 / actualShares / tick) * tick;
    if (minPrice <= 1.00) {
      sellPrice = minPrice;
      console.warn(`[CANC-MON] Adjusted sell price to ${fmtPct(sellPrice)} to meet PM $1 minimum order value.`);
    } else {
      console.error(`[CANC-MON] Cannot meet PM $1 minimum with ${actualShares} shares. Manual exit needed.`);
      return;
    }
  }

  console.log(
    `[CANC-MON] EMERGENCY SELL: ${actualShares}x ${pos.pmOutcome} @ ${fmtPct(sellPrice)} ` +
    `(${useAggressive ? "FOK into bids" : "GTC ask at floor"}) ` +
    `value=$${(actualShares * sellPrice).toFixed(2)}`
  );

  // Step 6: Place the sell order
  if (DRY_RUN) {
    console.log(`[CANC-MON] [DRY] Would ${useAggressive ? "FOK SELL" : "GTC ASK"}: ${actualShares}x@${fmtPct(sellPrice)}`);
  } else {
    try {
      let result: unknown;
      if (useAggressive) {
        // Aggressive: FOK sell into existing bids -- fills instantly or fails
        result = await placePmFOKSell(pos.pmTokenId, sellPrice, actualShares, pos.tickSize, pos.negRisk, false);
      } else {
        // Passive: GTC ask resting at 50c -- waits for buyers
        result = await placePmGTCAsk(pos.pmTokenId, sellPrice, actualShares, pos.tickSize, pos.negRisk, false);
      }
      const orderId = pickString((result as Record<string, unknown>)?.orderID ?? (result as Record<string, unknown>)?.order_id ?? "");
      console.log(
        `[CANC-MON] PM ${useAggressive ? "FOK" : "GTC"} sell order placed! orderId=${orderId.slice(0, 20)}... ` +
        `${actualShares}x@${fmtPct(sellPrice)}`
      );

      // If FOK failed to fill (size_matched < size), fall back to GTC at 50c
      const sizeMatched = Number((result as Record<string, unknown>)?.size_matched ?? actualShares);
      if (useAggressive && sizeMatched < actualShares) {
        const remaining = actualShares - Math.round(sizeMatched);
        if (remaining > 0) {
          const gtcPrice = Math.round(MIN_SELL_PRICE / tick) * tick;
          console.log(`[CANC-MON] FOK partially filled (${Math.round(sizeMatched)}/${actualShares}). Placing GTC ask for ${remaining} remaining @ ${fmtPct(gtcPrice)}`);
          try {
            await placePmGTCAsk(pos.pmTokenId, gtcPrice, remaining, pos.tickSize, pos.negRisk, false);
          } catch (e2) {
            console.error(`[CANC-MON] GTC fallback failed: ${(e2 as Error).message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[CANC-MON] PM sell FAILED: ${(err as Error).message}`);
      // Fallback: try GTC if FOK failed
      if (useAggressive) {
        console.log(`[CANC-MON] FOK failed -- trying GTC ask at ${fmtPct(MIN_SELL_PRICE)}...`);
        try {
          const gtcPrice = Math.round(MIN_SELL_PRICE / tick) * tick;
          await placePmGTCAsk(pos.pmTokenId, gtcPrice, actualShares, pos.tickSize, pos.negRisk, false);
          console.log(`[CANC-MON] GTC fallback placed: ${actualShares}x@${fmtPct(gtcPrice)}`);
        } catch (e2) {
          console.error(`[CANC-MON] GTC fallback also FAILED: ${(e2 as Error).message}`);
          console.error(`[CANC-MON] MANUAL ACTION NEEDED: sell ${actualShares}x ${pos.pmOutcome} (${pos.pmTokenId.slice(0, 16)}...)`);
        }
      } else {
        console.error(`[CANC-MON] MANUAL ACTION NEEDED: sell ${actualShares}x ${pos.pmOutcome} (${pos.pmTokenId.slice(0, 16)}...)`);
      }
    }
  }

  // Step 7: Resolve trade record
  const kalPayout = pos.shares * svDecimal;
  const pmRevenue = actualShares * sellPrice; // estimated (actual depends on fill)
  const totalRevenue = kalPayout + pmRevenue;
  const totalCostEst = pos.pmCost + pos.kalCost; // PM cost + actual Kalshi cost from trade record
  const realizedPnl = Math.round((totalRevenue - totalCostEst) * 100) / 100;

  resolveArbTrade(pos.kalTicker, {
    status: "resolved",
    resolvedTs: new Date().toISOString(),
    resolutionMethod: "settlement",
    realizedPnl,
    scalarSettlement: true,
    kalSettlementValue: svDecimal,
    pmSettlementValue: sellPrice,
    resolutionNote: `Kalshi scalar settlement (${(svDecimal * 100).toFixed(0)}c). PM sold @ ${fmtPct(sellPrice)}.`,
  }, pos.tradeId);
  console.log(
    `[CANC-MON] Trade ${pos.tradeId} resolved: ` +
    `kalPayout=$${kalPayout.toFixed(2)} pmSell~$${pmRevenue.toFixed(2)} P&L~$${realizedPnl.toFixed(2)}`
  );

  // Step 8: Clear hedge state
  if (matchingHs) {
    matchingHs.position.sharesHeld = 0;
    console.log(`[CANC-MON] Cleared hedge state for ${pos.kalTicker}`);
  }
}

async function runHedgeCycle(state: HedgeState, clobBase: string): Promise<void> {
  const { position: pos, activeOrders } = state;
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  _hedgeLogCounter++;

  if (pos.sharesHeld <= 0) return;

  // -- Step 0: Check if the Kalshi market has closed/resolved ------------------
  // If the match finished, the market settles automatically -- no hedging needed.
  // Detect this by checking the market status; if closed/resolved, clear hedge.
  // ALSO: detect scalar (cancelled) settlements and trigger emergency PM sell.

  // Live score early detection (before Kalshi API call -- zero latency)
  // Derive matchCode from arb_trades log: find the "hedging" trade for this kalTicker
  const _hedgeTrade = loadArbTrades().find(t => t.kalTicker === pos.kalLeg.ticker && t.status === "hedging");
  const _hedgeMatchCode = _hedgeTrade?.match ?? "";
  if (_hedgeMatchCode) {
    const _lsFinished = isMatchFinished(_hedgeMatchCode);
    const _lsCancelled = isMatchCancelled(_hedgeMatchCode);
    if (_lsFinished) {
      const ls = getMatchState(_hedgeMatchCode);
      console.log(`[HEDGE] Live score: ${_hedgeMatchCode} FINISHED (${ls?.homeScore ?? "?"}-${ls?.awayScore ?? "?"}, ${ls?.detail}) -- checking Kalshi settlement...`);
    } else if (_lsCancelled) {
      const ls = getMatchState(_hedgeMatchCode);
      console.warn(`[HEDGE] Live score: ${_hedgeMatchCode} ${ls?.status?.toUpperCase() ?? "CANCELLED"} -- scalar settlement risk!`);
    }
  }

  try {
    const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`);
    const mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
    const mktStatus = pickString(mkt.status ?? mkt.state ?? "").toLowerCase();
    if (mktStatus === "closed" || mktStatus === "settled" || mktStatus === "resolved" || mktStatus === "finalized") {
      const kalResult = pickString(mkt.result ?? "").toLowerCase();

      // -- Scalar (cancelled) settlement: emergency sell PM tokens ----------
      if (isScalarSettlement(mkt) && pos.heldExchange === "pm" && !_cancelledTickers.has(pos.kalLeg.ticker)) {
        const sv = Number(mkt.settlement_value ?? 0);
        console.error(
          `\n+==================================================================+\n` +
          `|  [!] SCALAR SETTLEMENT in hedge: ${pos.kalLeg.ticker}\n` +
          `|  Result: ${kalResult}  Settlement: ${sv}c\n` +
          `|  Holding ${pos.sharesHeld} PM shares -- triggering emergency sell!\n` +
          `+==================================================================+\n`
        );
        _cancelledTickers.add(pos.kalLeg.ticker);
        _cancelledEventKeys.add(extractEventDateKey(pos.kalLeg.ticker));

        // Cancel all hedge orders
        for (const [oid, ho] of activeOrders) {
          try {
            if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
            else await cancelKalshiOrder(oid, DRY_RUN);
          } catch { /* order may already be gone */ }
        }
        activeOrders.clear();

        // Build an OpenPosition for the emergency sell handler
        const emergencyPos: OpenPosition = {
          kalTicker: pos.kalLeg.ticker,
          pmTokenId: pos.pmLeg.tokenId,
          pmOutcome: pos.pmLeg.outcome,
          pmSlug: "", // not needed for sell
          shares: pos.sharesHeld,
          pmCost: pos.heldExchange === "pm" ? pos.initialCost + pos.hedgeFillCostPm : pos.hedgeFillCostPm,
          kalCost: pos.hedgeFillCostKal, // PM-held branch: Kalshi cost is only from hedge fills
          tickSize: pos.pmLeg.tickSize,
          negRisk: pos.pmLeg.negRisk,
          tradeId: "",
          status: "hedging",
        };
        // handleCancelledPosition will place the sell and resolve the trade
        await handleCancelledPosition(emergencyPos, mkt, [], clobBase);
        pos.sharesHeld = 0;
        return;
      }

      // -- Normal (binary) settlement: standard hedge clearance ------------
      console.warn(
        `\n[HEDGE] Market ${pos.kalLeg.ticker} is ${mktStatus}. Position settles automatically -- clearing hedge.\n`
      );
      // Cancel any resting orders (they'll fail on a closed market anyway)
      for (const [oid, ho] of activeOrders) {
        try {
          if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
          else await cancelKalshiOrder(oid, DRY_RUN);
        } catch { /* market closed -- order may already be gone */ }
      }
      activeOrders.clear();
      // Settlement P&L: we held one leg only (hedge incomplete).
      // Check Kalshi result to see if our side won or lost.
      let settlePnl: number;
      const isScalar = kalResult === "scalar" || (mkt.result === "scalar" && Number(mkt.settlement_value ?? 0) > 0);
      if (isScalar) {
        // Scalar settlement: fractional payout per share (e.g., cancelled match -> 86c)
        const sv = Number(mkt.settlement_value ?? 0);
        const svDec = sv > 1 ? sv / 100 : sv;
        const kalPayout = pos.initialShares * (pos.kalSide === "yes" ? svDec : (1 - svDec));
        const hedgedShares = pos.initialShares - pos.sharesHeld;
        settlePnl = kalPayout + hedgedShares - pos.initialCost - pos.hedgeFillCost;
      } else if (pos.heldExchange === "kal") {
        // We hold Kalshi contracts. If our side won -> payout $1/share; if lost -> $0.
        const kalWon = (pos.kalSide === "yes" && kalResult === "yes") || (pos.kalSide === "no" && kalResult === "no");
        const payout = kalWon ? pos.initialShares : 0;
        settlePnl = payout - pos.initialCost - pos.hedgeFillCost;
      } else {
        // We hold PM tokens. Kalshi market settled -> PM market should settle too.
        const kalSideWon = (pos.kalSide === "yes" && kalResult === "yes") || (pos.kalSide === "no" && kalResult === "no");
        const pmWon = !kalSideWon && kalResult !== "";
        const hedgedShares = pos.initialShares - pos.sharesHeld;
        const hedgedPayout = hedgedShares; // $1 per hedged share (both legs covered)
        const unhedgedPayout = pmWon ? pos.sharesHeld : 0; // $1 per unhedged share if PM won
        settlePnl = hedgedPayout + unhedgedPayout - pos.initialCost - pos.hedgeFillCost;
      }
      console.log(
        `[HEDGE] Settlement P&L: initial=$${pos.initialCost.toFixed(2)}` +
        ` hedgeCost=$${pos.hedgeFillCost.toFixed(2)} result=${kalResult || "unknown"}` +
        ` P&L=$${settlePnl.toFixed(2)}`
      );
      pos.sharesHeld = 0;
      const isPmInit = pos.heldExchange === "pm";
      const kalSettleTotal = isPmInit
        ? pos.hedgeFillCostKal
        : pos.initialCost + pos.hedgeFillCostKal;
      const pmSettleTotal = isPmInit
        ? pos.initialCost + pos.hedgeFillCostPm
        : pos.hedgeFillCostPm;
      const kalSettleCost = Math.round(kalSettleTotal * 100) / 100;
      const pmSettleCost = Math.round(pmSettleTotal * 100) / 100;
      resolveArbTrade(pos.kalLeg.ticker, {
        status: "resolved",
        resolvedTs: new Date().toISOString(),
        resolutionMethod: "settlement",
        hedgeCost: pos.hedgeFillCost,
        realizedPnl: settlePnl,
        kalCost: kalSettleCost,
        pmCost: pmSettleCost,
        totalCost: Math.round((kalSettleCost + pmSettleCost) * 100) / 100,
        kalFillPrice: kalSettleTotal > 0
          ? Math.round((kalSettleTotal / pos.initialShares) * 100) / 100
          : 0,
        pmFillPrice: pmSettleTotal > 0
          ? Math.round((pmSettleTotal / pos.initialShares) * 100) / 100
          : 0,
        initialExchange: pos.heldExchange,
      }, pos.tradeId);
      postResolutionFillAudit(pos.kalLeg.ticker, pos.tradeId).catch(() => {});
      return;
    }
  } catch {
    // Transient error fetching market status -- continue hedge cycle normally.
    // If the market is truly gone, order placement will fail and fetchFailures will clean up.
  }

  // -- Step 0b: Periodically verify PM-held position via on-chain balanceOf ----
  // Every ~50 hedge cycles, check the token is still in the wallet on-chain.
  // Primary: on-chain balanceOf (authoritative). Fallback: data-api.
  if (_hedgeLogCounter > 10 && _hedgeLogCounter % 50 === 0 && pos.heldExchange === "pm") {
    try {
      let held = await getOnChainBalance(pos.pmLeg.tokenId);
      if (held < 0) {
        // RPC failed -- fallback to data-api
        const positions = await fetchPmPositionsCached(0);
        held = sumPmHeld(positions, pos.pmLeg.tokenId);
      }
      if (held <= 0) {
        console.warn(
          `\n[HEDGE] [!] PM position ${pos.pmLeg.outcome} no longer exists in wallet (on-chain verified)!` +
          ` Cancelling all hedge orders and clearing.\n`
        );
        for (const [oid, ho] of activeOrders) {
          try {
            if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
            else await cancelKalshiOrder(oid, DRY_RUN);
          } catch { /* best effort */ }
        }
        activeOrders.clear();
        pos.sharesHeld = 0;
        return;
      }
    } catch (e) {
      console.warn(`[HEDGE] PM position verify failed: ${(e as Error).message}`);
    }
  }

  // -- Step 1: Check fills on all active GTC orders ----------------------------
  // Collect counterpart cancellations here to avoid mutating the map mid-iteration
  const toCancel: Array<{ oid: string; ho: HedgeOrder }> = [];

  for (const [oid, ho] of activeOrders) {
    try {
      let filledShares = 0;
      let orderDone = false;

      if (ho.exchange === "pm") {
        const { filledShares: f, status } = await getPmOrderFills(oid);
        filledShares = Math.max(0, f - ho.filledSoFar);
        ho.filledSoFar = Math.max(ho.filledSoFar, f);
        orderDone = status === "matched" || status === "cancelled";
      } else {
        const order = await getKalshiOrder(oid);
        let totalFilled = Number(order.fill_count_fp ?? order.fill_count ?? order.filled_count ?? order.filled ?? 0);
        const st = String(order.status ?? "");
        orderDone = st === "executed" || st === "filled" || st === "cancelled" || st === "expired";
        // Safety: if order is done but fill count is 0, infer from remaining_count
        if (orderDone && totalFilled === 0 && (st === "executed" || st === "filled")) {
          const remaining = Number(order.remaining_count ?? ho.shares);
          const inferred = ho.shares - remaining;
          if (inferred > 0) {
            console.warn(`[HEDGE] Fill count missing for ${st} order ${oid.slice(0,12)}... -- inferred ${inferred} fills from remaining_count=${remaining}`);
            totalFilled = inferred;
          }
        }
        filledShares = Math.max(0, totalFilled - ho.filledSoFar);
        ho.filledSoFar = Math.max(ho.filledSoFar, totalFilled);
        // Extract Kalshi fees from order response (cumulative total -> track delta)
        const kalOrdFees = (Number(order.taker_fees ?? 0) + Number(order.maker_fees ?? 0)) / 100;
        const prevFees = ho._lastFeeSeen ?? 0;
        ho._lastFeeSeen = kalOrdFees;
        ho._feeDelta = kalOrdFees - prevFees;
        // Log Kalshi order status only when it changes or every ~30s (75 cycles x 400ms)
        const logKey = `${st}:${totalFilled}`;
        if (orderDone || filledShares > 0 || ho._lastLogKey !== logKey) {
          console.log(`[HEDGE] KAL order ${oid.slice(0,12)}... status=${st} filled=${totalFilled}/${ho.shares} remaining=${order.remaining_count ?? "?"}`);
          ho._lastLogKey = logKey;
        }
      }

      if (filledShares > 0) {
        pos.sharesHeld = Math.max(0, pos.sharesHeld - filledShares);
        if (ho.role === "complete") {
          pos.hedgeFillCost += filledShares * ho.price;
          if (ho.exchange === "kal") {
            pos.hedgeFillCostKal += filledShares * ho.price;
            // Add Kalshi fee delta (not cumulative total -- prevents double-counting on incremental fills)
            const feeDelta = ho._feeDelta ?? 0;
            if (feeDelta > 0) pos.kalFees += feeDelta;
          }
          else pos.hedgeFillCostPm += filledShares * ho.price;
        }
        console.log(
          `\n[HEDGE] ${ho.exchange.toUpperCase()} ${ho.role} filled ${filledShares} @${fmtPct(ho.price)}.` +
          ` Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`
        );
        // -- Cancel-on-fill race --------------------------------------------
        // complete fills -> cancel ALL other orders (other completes + exits):
        //   arb resolved on this exchange, don't let the other complete overbuy
        // exit fills -> cancel complete orders only:
        //   position sold, no longer need to complete the hedge
        if (ho.role === "complete") {
          for (const [coid, cho] of activeOrders) {
            if (coid !== oid) toCancel.push({ oid: coid, ho: cho });
          }
        } else {
          for (const [coid, cho] of activeOrders) {
            if (cho.role === "complete" && coid !== oid) toCancel.push({ oid: coid, ho: cho });
          }
        }
      }

      ho.fetchFailures = 0; // successful fetch -- reset counter
      if (orderDone || pos.sharesHeld <= 0) activeOrders.delete(oid);
    } catch (err) {
      // Transient errors: keep the order and retry next cycle.
      // After 10 consecutive failures, CANCEL the order on the exchange before removing it
      // from tracking -- this prevents orphaned live orders that accumulate and all fill
      // simultaneously when volume finally appears (causing oversized positions).
      ho.fetchFailures = (ho.fetchFailures ?? 0) + 1;
      if (ho.fetchFailures === 1 || ho.fetchFailures % 5 === 0) {
        console.warn(`[HEDGE] Order ${oid.slice(0, 16)}... (${ho.exchange} ${ho.role}) status check fail #${ho.fetchFailures}: ${(err as Error).message ?? err}`);
      }
      if (ho.fetchFailures >= 10) {
        console.warn(`[HEDGE] Order ${oid} (${ho.exchange} ${ho.role}) failed status check 10x -- cancelling on exchange and removing.`);
        try {
          if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
          else await cancelKalshiOrder(oid, DRY_RUN);
          console.log(`[HEDGE] Cancelled orphan order ${oid.slice(0, 16)}...`);
        } catch { /* order may already be gone on the exchange -- safe to remove */ }
        activeOrders.delete(oid);
      }
    }
  }

  // -- Cancel counterpart orders collected above (deduplicated) -----------------
  const cancelSeen = new Set<string>();
  for (const { oid, ho: cho } of toCancel) {
    if (cancelSeen.has(oid)) continue;  // duplicate from multiple fills in same cycle
    cancelSeen.add(oid);
    if (!activeOrders.has(oid)) continue; // already removed (filled or expired)
    try {
      if (cho.exchange === "pm") {
        await cancelPmOrder(oid, DRY_RUN);
      } else {
        await cancelKalshiOrder(oid, DRY_RUN);
      }
      activeOrders.delete(oid);
      console.log(
        `[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} order ${oid}` +
        ` -- other side filled first (race resolved).`
      );
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // Order already gone (executed/expired) -- clean it from activeOrders
      if (msg.includes("404") || msg.includes("not_found") || msg.includes("Not Found")) {
        activeOrders.delete(oid);
        console.warn(
          `[HEDGE] ${cho.exchange.toUpperCase()} ${cho.role} order ${oid} already gone (likely filled). Removed from tracking.`
        );
      } else {
        console.error(
          `[HEDGE] Failed to cancel ${cho.exchange.toUpperCase()} ${cho.role} order ${oid}: ${msg}`
        );
      }
    }
  }

  if (pos.sharesHeld <= 0) return;

  let sharesNeeded = pos.sharesHeld;

  if (pos.heldExchange === "pm") {
    // -- Held PM token, missing the Kalshi leg ----------------------------------
    // We own pmLeg (e.g. P2_token). We need EITHER:
    //   complete-kal: buy Kalshi P1_YES at <= maxKalPrice
    //   complete-pm:  buy PM P1_token (pmOppLeg) at <= maxOppPrice  (P1+P2 tokens -> $1)
    // Simultaneously exit: sell pmLeg at best ask >= cost basis
    // First fill on any complete -> cancel the other complete + exit
    // First fill on exit -> cancel all completes
    // payout mode: accept any fill up to breakeven; profit mode: require MIN_EDGE margin
    const hedgeEdge = HEDGE_TARGET === "payout" ? 0 : MIN_EDGE;
    // Deduct estimated completing-leg fees only. pmCostBasis is the initial PM cost (0% fee on tennis).
    // KAL completing: KALSHI_FEE_RATE x P x (1-P).
    // PM opposite completing: PM_FEE_RATE x P x (1-P) (currently 0 for tennis).
    const estCompletePrice = 1 - pos.pmCostBasis;
    const kalFeeReserve = KALSHI_FEE_RATE * estCompletePrice * (1 - estCompletePrice);
    const pmOppFeeReserve = PM_FEE_RATE * estCompletePrice * (1 - estCompletePrice);
    const maxKalPrice = 1 - pos.pmCostBasis - hedgeEdge - kalFeeReserve;
    const maxOppPrice = 1 - pos.pmCostBasis - hedgeEdge - pmOppFeeReserve;
    // Safety: log breakeven calculation on first hedge cycle
    if (!state.lastCompleteExchange) {
      console.log(`[HEDGE] PM-held breakeven: pmCostBasis=${fmtPct(pos.pmCostBasis)} maxKalPrice=${fmtPct(maxKalPrice)} maxOppPrice=${fmtPct(maxOppPrice)} shares=${sharesNeeded}`);
    }

    // -- Single-exchange hedging: PM-only first, then KAL-only after PM_ONLY_MAX_CYCLES --
    const inPmPhasePH = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();

    // -- IOC sweeps: aggressively grab available asks each cycle -----------------
    // 1) Sweep Kalshi ask for pos.kalSide (throttled: back off 30s after each failure)
    if (!inPmPhasePH && Date.now() >= state.kalNextRetryAt) {
      const { ask: kalYesAsk, noAsk: kalNoAsk } = await fetchKalshiSingleMarket(pos.kalLeg.ticker);
      const kalCurrentAsk = pos.kalSide === "yes" ? kalYesAsk : kalNoAsk;
      if (kalCurrentAsk !== null && kalCurrentAsk <= maxKalPrice && sharesNeeded > 0) {
        const ioOrder = buildKalshiIOCOrder(pos.kalLeg.ticker, kalCurrentAsk, sharesNeeded, pos.kalSide);
        try {
          const res = await placeKalshiOrder(ioOrder, DRY_RUN);
          const meta = extractKalMeta(res);
          const filled = DRY_RUN ? sharesNeeded : meta.filled;
          if (filled > 0) {
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * kalCurrentAsk;
            pos.hedgeFillCostKal += filled * kalCurrentAsk;
            pos.kalFees += meta.fees;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC Kalshi ${pos.kalSide.toUpperCase()} filled ${filled}@${fmtPct(kalCurrentAsk)} fee=$${meta.fees.toFixed(2)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
            state.pmOnlyCycles = 0; // reset: switch back to PM-first on next cycle
            await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
            saveHedgeState(state);
            sharesNeeded = pos.sharesHeld;
            if (pos.sharesHeld <= 0) return;
          } else {
            state.kalNextRetryAt = Date.now() + 30_000;
          }
        } catch (e) {
          console.error(`[HEDGE] IOC Kalshi ${pos.kalSide.toUpperCase()} sweep failed: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }
    }
    // 2) Sweep PM opposite token (pmOppLeg) ask -- only in PM phase
    if (inPmPhasePH && pos.pmOppLeg && sharesNeeded >= 5) {
      const oppCurrentAsk = await fetchPmAsk(pos.pmOppLeg.tokenId, clobBase);
      if (oppCurrentAsk !== null && oppCurrentAsk <= maxOppPrice && sharesNeeded * oppCurrentAsk >= PM_MARKETABLE_MIN_VALUE) {
        try {
          const res = await placePmFOK(pos.pmOppLeg.tokenId, oppCurrentAsk, sharesNeeded, pos.pmOppLeg.tickSize, pos.pmOppLeg.negRisk, DRY_RUN);
          const meta = extractPmMeta(res);
          let filled = 0;
          if (DRY_RUN) {
            filled = sharesNeeded;
          } else if (meta.status === "matched") {
            filled = sharesNeeded;
          } else if (meta.status === "delayed" && meta.orderId) {
            console.log(`  [HEDGE] PM opp-sweep on-chain pending, polling...`);
            const finalStatus = await waitForPmOrderFill(String(meta.orderId), 20_000, pos.pmOppLeg?.tokenId);
            if (finalStatus === "matched") filled = sharesNeeded;
            // cancelled/timeout -> filled stays 0
          }
          if (filled > 0) {
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * oppCurrentAsk;
            pos.hedgeFillCostPm += filled * oppCurrentAsk;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC PM ${pos.pmOppLeg.outcome} filled ${filled}@${fmtPct(oppCurrentAsk)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
            await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
            saveHedgeState(state);
            sharesNeeded = pos.sharesHeld;
            if (pos.sharesHeld <= 0) return;
          }
        } catch (e) {
          console.error(`[HEDGE] IOC PM opposite sweep failed: ${(e as Error).message}`);
        }
      }
    }

    // -- Track PM-only cycles for single-exchange hedging --
    if (inPmPhasePH && sharesNeeded > 0) {
      state.pmOnlyCycles = (state.pmOnlyCycles ?? 0) + 1;
      if (state.pmOnlyCycles >= PM_ONLY_MAX_CYCLES) {
        console.log(`[HEDGE] PM-held: ${state.pmOnlyCycles} PM-only cycles with no fill -- switching to KAL-only`);
        // Cancel any resting PM GTC orders before switching to KAL
        for (const [oid, ho] of activeOrders) {
          if (ho.exchange === "pm") {
            try { await cancelPmOrder(oid, DRY_RUN); } catch { /* best effort */ }
            activeOrders.delete(oid);
          }
        }
      }
    }

    // -- SEQUENTIAL complete: only ONE complete order at a time (prevents double-fill) --
    // Single-exchange: GTC orders only on the active phase's exchange
    const hasAnyComplete = [...activeOrders.values()].some(o => o.role === "complete");
    if (!hasAnyComplete && sharesNeeded > 0) {
      // Re-check market status + price before placing a new order
      try {
        const recheck = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`);
        const recheckMkt = recheck.market ?? recheck as unknown as KalshiMarket;
        const recheckStatus = pickString(recheckMkt.status ?? recheckMkt.state ?? "").toLowerCase();
        if (recheckStatus === "closed" || recheckStatus === "settled" || recheckStatus === "resolved" || recheckStatus === "finalized") {
          console.log(`[HEDGE] Market ${pos.kalLeg.ticker} is now ${recheckStatus} -- skipping new order. Will resolve on next cycle.`);
          saveHedgeState(state);
          return;
        }
        // No price-based skip -- always attempt hedging regardless of current price.
      } catch { /* non-critical -- proceed with order placement */ }

      // Single-exchange hedging: only place GTC on the current phase's exchange
      const inPmNow = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();
      const pmViable = pos.pmOppLeg && !isPmServiceDown() && sharesNeeded >= 5;
      const tryOrder: Array<"kal" | "pm"> = inPmNow ? (pmViable ? ["pm"] : []) : ["kal"];
      let placed = false;

      for (const tryExchange of tryOrder) {
        if (placed) break;

      if (!placed && tryExchange === "kal") {
        // -- Try Kalshi GTC YES bid ------------------------------------------
        const kalPriceCents = Math.max(1, Math.min(99, Math.floor(maxKalPrice * 100)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", pos.kalSide, kalPriceCents, sharesNeeded);
        try {
          console.log(`[HEDGE] Placing Kalshi GTC: ticker=${pos.kalLeg.ticker} side=${pos.kalSide} price=${kalPriceCents}c qty=${sharesNeeded}`);
          const res = await placeKalshiOrder(order, DRY_RUN);
          console.log(`[HEDGE] Kalshi GTC raw response: ${JSON.stringify(res).slice(0, 300)}`);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalPriceCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            state.lastCompleteExchange = "kal";
            saveHedgeState(state);
            console.log(`[HEDGE] Placed Kalshi GTC BID ${sharesNeeded}x${pos.kalSide.toUpperCase()}@${fmtPct(kalPriceCents / 100)} (complete-kal). orderId=${oid}`);
            placed = true;
            // Verify -- if filled immediately, update and return
            try {
              const check = await getKalshiOrder(oid);
              const checkStatus = String(check.status ?? "");
              const checkRemaining = Number(check.remaining_count ?? sharesNeeded);
              console.log(`[HEDGE] Kalshi GTC verify: status=${checkStatus} remaining=${checkRemaining}`);
              if (checkStatus === "executed" || checkStatus === "filled") {
                const immediatelyFilled = sharesNeeded - checkRemaining;
                if (immediatelyFilled > 0) {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - immediatelyFilled);
                  pos.hedgeFillCost += immediatelyFilled * (kalPriceCents / 100);
                  pos.hedgeFillCostKal += immediatelyFilled * (kalPriceCents / 100);
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] Kalshi GTC filled immediately (${immediatelyFilled}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              }
            } catch (ve) {
              console.error(`[HEDGE] Kalshi GTC verify FAILED: ${(ve as Error).message}`);
            }
          } else {
            console.warn(`[HEDGE] Kalshi GTC placed but no orderId returned. Full response: ${JSON.stringify(res).slice(0, 300)}`);
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC bid: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }

      // -- Try PM GTC bid --------------------------------------------------
      if (!placed && tryExchange === "pm" && pos.pmOppLeg && !isPmServiceDown() && sharesNeeded >= 5) {
        const oppTick = pos.pmOppLeg.tickSize || 0.01;
        const oppBidPrice = Math.floor(maxOppPrice / oppTick) * oppTick;
        if (oppBidPrice > 0 && sharesNeeded * oppBidPrice >= PM_MARKETABLE_MIN_VALUE) {
          try {
            const res = await placePmGTCBid(pos.pmOppLeg.tokenId, oppBidPrice, sharesNeeded, oppTick, pos.pmOppLeg.negRisk, DRY_RUN);
            if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-opp-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "complete", exchange: "pm", orderId: oid, price: oppBidPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                state.lastCompleteExchange = "pm";
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC BID ${sharesNeeded}x${pos.pmOppLeg.outcome}@${fmtPct(oppBidPrice)} (complete-pm). orderId=${oid}`);
                if (!DRY_RUN && meta.status === "matched") {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - sharesNeeded);
                  pos.hedgeFillCost += sharesNeeded * oppBidPrice;
                  pos.hedgeFillCostPm += sharesNeeded * oppBidPrice;
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] PM GTC filled immediately (${sharesNeeded}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              } else {
                console.warn(`[HEDGE] PM GTC bid returned no orderId. Response: ${JSON.stringify(res).slice(0, 200)}`);
              }
            }
          } catch (e) {
            console.error(`[HEDGE] Failed to place PM GTC bid: ${(e as Error).message}`);
          }
        } else {
          console.warn(`[HEDGE] PM complete skipped: oppBidPrice=${oppBidPrice} (maxOpp=${fmtPct(maxOppPrice)} tick=${oppTick})`);
        }
      } else if (!placed && !pos.pmOppLeg) {
        console.warn(`[HEDGE] PM complete skipped: pmOppLeg is null`);
      }

      } // end for (tryOrder)
    }

    // -- exit: GTC ask on PM to sell our held token at cost basis (skipped if STRICT_HEDGE)
    // Always place at cost basis -- the GTC rests on the book until price comes back up.
    if (!STRICT_HEDGE) {
      const hasPmExit = [...activeOrders.values()].some(o => o.role === "exit" && o.exchange === "pm");
      if (!hasPmExit && !isPmServiceDown() && sharesNeeded >= 5) {
        const exitTick = pos.pmLeg.tickSize || 0.01;
        const exitPrice = Math.ceil(pos.pmCostBasis / exitTick) * exitTick; // round UP to nearest tick
        if (exitPrice > 0 && exitPrice < 1) {
          try {
            const res = await placePmGTCAsk(pos.pmLeg.tokenId, exitPrice, sharesNeeded, exitTick, pos.pmLeg.negRisk, DRY_RUN);
            if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-exit-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "exit", exchange: "pm", orderId: oid, price: exitPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC ASK ${sharesNeeded}x@${fmtPct(exitPrice)} (exit at cost). orderId=${oid}`);
              } else {
                console.warn(`[HEDGE] PM exit returned no orderId. Response: ${JSON.stringify(res).slice(0, 200)}`);
              }
            }
          } catch (e) {
            console.error(`[HEDGE] Failed to place PM GTC ask: ${(e as Error).message}`);
          }
        }
      }
    }

  } else {
    // -- Held Kalshi contract, missing the PM leg ------------------------------
    // We own kalLeg at pos.kalSide (YES or NO). We need EITHER:
    //   complete-pm:  buy PM token (pmLeg) at <= maxPmPrice
    //   complete-kal: buy the OPPOSITE Kalshi side at <= maxKalOppPrice  (YES+NO -> $1)
    // Simultaneously exit: sell our Kalshi side at best bid >= cost basis
    // First fill on any complete -> cancel the other complete + exit
    // First fill on exit -> cancel all completes
    // payout mode: accept any fill up to breakeven; profit mode: require MIN_EDGE margin
    const hedgeEdge2 = HEDGE_TARGET === "payout" ? 0 : MIN_EDGE;
    // Deduct estimated completing-leg fees only. kalCostBasis already includes the initial Kalshi fee.
    // PM completing: PM_FEE_RATE x P x (1-P) (currently 0 for tennis).
    // KAL opposite completing: KALSHI_FEE_RATE x P x (1-P).
    const estCompletePrice2 = 1 - pos.kalCostBasis;
    const pmFeeReserve = PM_FEE_RATE * estCompletePrice2 * (1 - estCompletePrice2);
    const kalOppFeeReserve = KALSHI_FEE_RATE * estCompletePrice2 * (1 - estCompletePrice2);
    const maxPmPrice = 1 - pos.kalCostBasis - hedgeEdge2 - pmFeeReserve;
    const maxKalOppPrice = 1 - pos.kalCostBasis - hedgeEdge2 - kalOppFeeReserve;
    // Safety: log breakeven calculation on first hedge cycle
    if (!state.lastCompleteExchange) {
      console.log(`[HEDGE] KAL-held breakeven: kalCostBasis=${fmtPct(pos.kalCostBasis)} maxPmPrice=${fmtPct(maxPmPrice)} maxKalOpp=${fmtPct(maxKalOppPrice)} shares=${sharesNeeded}`);
    }
    const hedgeKalSide: "yes" | "no" = pos.kalSide === "yes" ? "no" : "yes";

    // -- Pre-hedge reconciliation: check if original PM FOK already filled on-chain --
    // The original FOK can settle on-chain minutes after the CLOB API reported it as
    // unmatched (especially for sports markets with delayed matching). If the tokens are
    // already in the wallet, skip hedging -- the position is already complete.
    // IMPORTANT: subtract PM shares already committed to OTHER trades on the same token
    // to avoid false-positive reconciliation (e.g. trade 1 bought 9 shares, trade 2's
    // FOK failed -> wallet shows 9 but only trade 1 owns them).
    if (sharesNeeded > 0 && !DRY_RUN) {
      try {
        let pmHeld = await getOnChainBalanceWithFallback(pos.pmLeg.tokenId);
        if (pmHeld < 0) {
          // All RPCs failed -- try data-api as last resort
          const positions = await fetchPmPositionsCached(0);
          pmHeld = sumPmHeld(positions, pos.pmLeg.tokenId);
        }
        // Subtract shares already attributed to other trades on this same PM token
        const otherTradesShares = loadArbTrades()
          .filter(t => t.id !== pos.tradeId && t.pmTokenId === pos.pmLeg.tokenId &&
                       (t.status === "filled" || t.status === "hedging" || t.status === "resolved") &&
                       t.pmCost > 0)
          .reduce((sum, t) => sum + t.shares, 0);
        const availableForThisTrade = pmHeld - otherTradesShares;
        if (otherTradesShares > 0) {
          console.log(`[HEDGE] On-chain balance ${pmHeld}x but ${otherTradesShares}x committed to other trades -> ${availableForThisTrade}x available for this trade`);
        }
        if (availableForThisTrade >= sharesNeeded) {
          console.log(
            `\n[HEDGE] [OK] On-chain reconciliation: wallet holds ${availableForThisTrade}x available PM ${pos.pmLeg.outcome}` +
            ` (need ${sharesNeeded}). Original FOK likely filled late. Resolving hedge.\n`
          );
          // Try to recover actual fill price from CLOB getTrades()
          let fillPrice = 0;
          let fillCost = 0;
          try {
            const { client } = await createPmClient();
            type ClobFill = { asset_id: string; size: string; price: string; fee_rate_bps: string; side: string; status: string; match_time: string; id?: string };
            const clobTrades = (await client.getTrades()) as unknown as ClobFill[];
            const fills = clobTrades.filter(
              (ct: ClobFill) => ct.asset_id === pos.pmLeg.tokenId && ct.side === "BUY" && ct.status === "CONFIRMED"
            );
            if (fills.length > 0) {
              // Collect fill IDs already attributed to other trades to avoid double-counting
              const otherTrades = loadArbTrades().filter(
                t => t.id !== pos.tradeId && t.pmTokenId === pos.pmLeg.tokenId && t.pmCost > 0
              );
              const otherTradesShareTotal = otherTrades.reduce((s, t) => s + t.shares, 0);
              // Sort fills by time (newest first) -- this trade's fills are likely the most recent
              const sortedFills = [...fills].sort((a, b) =>
                new Date(b.match_time).getTime() - new Date(a.match_time).getTime()
              );
              // Skip fills that belong to earlier trades (by share count)
              let skipped = 0;
              let totalSize = 0;
              let totalCost = 0;
              // Walk oldest-first to attribute early fills to earlier trades
              const oldestFirst = [...sortedFills].reverse();
              for (const f of oldestFirst) {
                const sz = Number(f.size);
                if (skipped < otherTradesShareTotal) {
                  skipped += sz;
                  continue; // this fill belongs to an earlier trade
                }
                const px = Number(f.price);
                totalSize += sz;
                totalCost += sz * px;
                if (totalSize >= sharesNeeded) break; // don't over-attribute
              }
              if (totalSize > 0) {
                fillPrice = Math.round((totalCost / totalSize) * 10000) / 10000;
                fillCost = Math.round(totalCost * 100) / 100;
                console.log(`[HEDGE] Recovered PM fill from CLOB: avgPrice=${fmtPct(fillPrice)} totalCost=$${fillCost.toFixed(2)} (${totalSize} shares, skipped ${skipped} from other trades)`);
              }
            }
          } catch (e) {
            console.warn(`[HEDGE] CLOB getTrades() failed during reconciliation: ${(e as Error).message}`);
          }
          // Cancel all active hedge orders
          for (const [oid, ho] of activeOrders) {
            try {
              if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
              else await cancelKalshiOrder(oid, DRY_RUN);
              console.log(`[HEDGE] Cancelled ${ho.exchange.toUpperCase()} ${ho.role} ${oid.slice(0, 12)}...`);
            } catch { /* order may already be gone */ }
          }
          activeOrders.clear();
          // Update trade record with actual PM fill data
          const totalCost = Math.round((pos.initialCost + fillCost) * 100) / 100;
          resolveArbTrade(pos.kalLeg.ticker, {
            status: "resolved",
            resolutionMethod: "hedge-reconciled-onchain",
            pmFillPrice: fillPrice,
            pmCost: fillCost,
            totalCost,
            hedgeCost: 0,
            realizedPnl: Math.round((pos.initialShares - totalCost) * 100) / 100,
          }, pos.tradeId);
          postResolutionFillAudit(pos.kalLeg.ticker, pos.tradeId).catch(() => {});
          pos.sharesHeld = 0;
          saveHedgeState(state);
          return;
        }
      } catch (e) {
        console.warn(`[HEDGE] Pre-hedge on-chain reconciliation failed: ${(e as Error).message} -- continuing normal hedge.`);
      }
    }

    // -- Single-exchange hedging: PM-only first, then KAL-only after PM_ONLY_MAX_CYCLES --
    const inPmPhaseKH = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();

    // -- IOC sweeps: aggressively grab available asks each cycle -----------------
    // 1) Sweep PM token ask -- only in PM phase
    if (inPmPhaseKH && sharesNeeded >= 5 && !isPmServiceDown()) {
      const pmCurrentAsk = await fetchPmAsk(pos.pmLeg.tokenId, clobBase);
      if (pmCurrentAsk !== null && pmCurrentAsk <= maxPmPrice && sharesNeeded * pmCurrentAsk >= PM_MARKETABLE_MIN_VALUE) {
        try {
          const res = await placePmFOK(pos.pmLeg.tokenId, pmCurrentAsk, sharesNeeded, pos.pmLeg.tickSize, pos.pmLeg.negRisk, DRY_RUN);
          if (isPm425(res)) { markPmDown(); }
          else {
            markPmUp();
            const meta = extractPmMeta(res);
            let filled = 0;
            if (DRY_RUN) {
              filled = sharesNeeded;
            } else if (meta.status === "matched") {
              filled = sharesNeeded;
            } else if (meta.status === "delayed" && meta.orderId) {
              console.log(`  [HEDGE] PM sweep on-chain pending, polling...`);
              const finalStatus = await waitForPmOrderFill(String(meta.orderId), 20_000, pos.pmLeg.tokenId);
              if (finalStatus === "matched") filled = sharesNeeded;
            }
            if (filled > 0) {
              pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
              pos.hedgeFillCost += filled * pmCurrentAsk;
              pos.hedgeFillCostPm += filled * pmCurrentAsk;
              sharesNeeded = pos.sharesHeld;
              console.log(`\n[HEDGE] IOC PM ${pos.pmLeg.outcome} filled ${filled}@${fmtPct(pmCurrentAsk)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
              await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
              saveHedgeState(state);
              sharesNeeded = pos.sharesHeld;
              if (pos.sharesHeld <= 0) return;
            }
          }
        } catch (e) {
          console.error(`[HEDGE] IOC PM sweep failed: ${(e as Error).message}`);
        }
      }
    }
    // 2) Sweep Kalshi opposite side ask -- only in KAL phase
    if (!inPmPhaseKH && sharesNeeded > 0 && Date.now() >= state.kalNextRetryAt) {
      const { ask: kalYesAsk, noAsk: kalNoAsk } = await fetchKalshiSingleMarket(pos.kalLeg.ticker);
      // We need the opposite side: if we hold YES, sweep NO asks; if we hold NO, sweep YES asks
      const oppAsk = hedgeKalSide === "no" ? kalNoAsk : kalYesAsk;
      if (oppAsk !== null && oppAsk <= maxKalOppPrice) {
        const oppAskCents = Math.max(1, Math.min(99, Math.round(oppAsk * 100)));
        const ioOrder = buildKalshiIOCOrder(pos.kalLeg.ticker, oppAsk, sharesNeeded, hedgeKalSide);
        try {
          const res = await placeKalshiOrder(ioOrder, DRY_RUN);
          const meta = extractKalMeta(res);
          const filled = DRY_RUN ? sharesNeeded : meta.filled;
          if (filled > 0) {
            pos.sharesHeld = Math.max(0, pos.sharesHeld - filled);
            pos.hedgeFillCost += filled * (oppAskCents / 100);
            pos.hedgeFillCostKal += filled * (oppAskCents / 100);
            pos.kalFees += meta.fees;
            sharesNeeded = pos.sharesHeld;
            console.log(`\n[HEDGE] IOC Kalshi ${hedgeKalSide.toUpperCase()} filled ${filled}@${fmtPct(oppAskCents / 100)} fee=$${meta.fees.toFixed(2)}. Remaining: ${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
            state.pmOnlyCycles = 0; // reset: switch back to PM-first on next cycle
            await recheckAndCancelAll(pos, activeOrders, DRY_RUN);
            saveHedgeState(state);
            sharesNeeded = pos.sharesHeld;
            if (pos.sharesHeld <= 0) return;
          } else {
            state.kalNextRetryAt = Date.now() + 30_000;
          }
        } catch (e) {
          console.error(`[HEDGE] IOC Kalshi ${hedgeKalSide.toUpperCase()} sweep failed: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }
    }

    // -- Track PM-only cycles for single-exchange hedging --
    if (inPmPhaseKH && sharesNeeded > 0) {
      state.pmOnlyCycles = (state.pmOnlyCycles ?? 0) + 1;
      if (state.pmOnlyCycles >= PM_ONLY_MAX_CYCLES) {
        console.log(`[HEDGE] KAL-held: ${state.pmOnlyCycles} PM-only cycles with no fill -- switching to KAL-only`);
        // Cancel any resting PM GTC orders before switching to KAL
        for (const [oid, ho] of activeOrders) {
          if (ho.exchange === "pm") {
            try { await cancelPmOrder(oid, DRY_RUN); } catch { /* best effort */ }
            activeOrders.delete(oid);
          }
        }
      }
    }

    // -- SEQUENTIAL complete: only ONE complete order at a time (prevents double-fill) --
    // Single-exchange: GTC orders only on the active phase's exchange
    const hasAnyCompleteKH = [...activeOrders.values()].some(o => o.role === "complete");
    if (!hasAnyCompleteKH && sharesNeeded > 0) {
      // Re-check market status + price before placing a new order
      try {
        const recheck = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${pos.kalLeg.ticker}`);
        const recheckMkt = recheck.market ?? recheck as unknown as KalshiMarket;
        const recheckStatus = pickString(recheckMkt.status ?? recheckMkt.state ?? "").toLowerCase();
        if (recheckStatus === "closed" || recheckStatus === "settled" || recheckStatus === "resolved" || recheckStatus === "finalized") {
          console.log(`[HEDGE] Market ${pos.kalLeg.ticker} is now ${recheckStatus} -- skipping new order. Will resolve on next cycle.`);
          saveHedgeState(state);
          return;
        }
        // No price-based skip -- always attempt hedging regardless of current price.
      } catch { /* non-critical -- proceed with order placement */ }

      // Single-exchange hedging: only place GTC on the current phase's exchange
      const inPmNowKH = (state.pmOnlyCycles ?? 0) < PM_ONLY_MAX_CYCLES && !isPmServiceDown();
      const pmViableKH = !isPmServiceDown() && sharesNeeded >= 5;
      const tryOrderKH: Array<"kal" | "pm"> = inPmNowKH ? (pmViableKH ? ["pm"] : []) : ["kal"];
      let placed = false;

      for (const tryExchangeKH of tryOrderKH) {
        if (placed) break;

      if (!placed && tryExchangeKH === "pm") {
        // -- Try PM GTC BID for the needed token -----------------------------
        const pmTick = pos.pmLeg.tickSize || 0.01;
        const pmBidPrice = Math.floor(maxPmPrice / pmTick) * pmTick;
        if (pmBidPrice > 0 && sharesNeeded * pmBidPrice >= PM_MARKETABLE_MIN_VALUE) {
          try {
            const res = await placePmGTCBid(pos.pmLeg.tokenId, pmBidPrice, sharesNeeded, pmTick, pos.pmLeg.negRisk, DRY_RUN);
            if (isPm425(res)) { markPmDown(); }
            else {
              markPmUp();
              const meta = extractPmMeta(res);
              const oid = DRY_RUN ? `dry-pm-complete-${Date.now()}` : String(meta.orderId ?? "");
              if (oid) {
                activeOrders.set(oid, { role: "complete", exchange: "pm", orderId: oid, price: pmBidPrice, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
                state.lastCompleteExchange = "pm";
                saveHedgeState(state);
                console.log(`\n[HEDGE] Placed PM GTC BID ${sharesNeeded}x${pos.pmLeg.outcome}@${fmtPct(pmBidPrice)} (complete-pm). orderId=${oid}`);
                placed = true;
                if (!DRY_RUN && meta.status === "matched") {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - sharesNeeded);
                  pos.hedgeFillCost += sharesNeeded * pmBidPrice;
                  pos.hedgeFillCostPm += sharesNeeded * pmBidPrice;
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] PM GTC filled immediately (${sharesNeeded}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              }
            }
          } catch (e) {
            console.error(`[HEDGE] Failed to place PM GTC bid: ${(e as Error).message}`);
          }
        }
      }

      // -- Try Kalshi opposite-side GTC bid -------------------------------------
      if (!placed && tryExchangeKH === "kal" && sharesNeeded > 0) {
        const kalOppCents = Math.max(1, Math.min(99, Math.floor(maxKalOppPrice * 100)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "buy", hedgeKalSide, kalOppCents, sharesNeeded);
        try {
          const res = await placeKalshiOrder(order, DRY_RUN);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-opp-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "complete", exchange: "kal", orderId: oid, price: kalOppCents / 100, shares: sharesNeeded, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            state.lastCompleteExchange = "kal";
            saveHedgeState(state);
            console.log(`\n[HEDGE] Placed Kalshi GTC ${hedgeKalSide.toUpperCase()}-BID ${sharesNeeded}x@${fmtPct(kalOppCents / 100)} (complete-kal ${hedgeKalSide.toUpperCase()}). orderId=${oid}`);
            try {
              const check = await getKalshiOrder(oid);
              const checkStatus = String(check.status ?? "");
              const checkRemaining = Number(check.remaining_count ?? sharesNeeded);
              console.log(`[HEDGE] Kalshi ${hedgeKalSide.toUpperCase()} GTC verify: status=${checkStatus} remaining=${checkRemaining}`);
              if (checkStatus === "executed" || checkStatus === "filled") {
                const immediatelyFilled = sharesNeeded - checkRemaining;
                if (immediatelyFilled > 0) {
                  pos.sharesHeld = Math.max(0, pos.sharesHeld - immediatelyFilled);
                  pos.hedgeFillCost += immediatelyFilled * (kalOppCents / 100);
                  pos.hedgeFillCostKal += immediatelyFilled * (kalOppCents / 100);
                  activeOrders.delete(oid);
                  console.log(`[HEDGE] Kalshi ${hedgeKalSide.toUpperCase()} GTC filled immediately (${immediatelyFilled}). sharesHeld=${pos.sharesHeld} (hedgeCost=$${pos.hedgeFillCost.toFixed(2)})`);
                  if (pos.sharesHeld <= 0) {
                    for (const [coid, cho] of activeOrders) {
                      try {
                        if (cho.exchange === "pm") await cancelPmOrder(coid, DRY_RUN);
                        else await cancelKalshiOrder(coid, DRY_RUN);
                        console.log(`[HEDGE] Cancelled ${cho.exchange.toUpperCase()} ${cho.role} ${coid.slice(0, 12)}...`);
                      } catch { /* may already be gone */ }
                    }
                    activeOrders.clear();
                    saveHedgeState(state);
                    return;
                  }
                  sharesNeeded = pos.sharesHeld;
                }
              }
            } catch (ve) {
              console.error(`[HEDGE] Kalshi ${hedgeKalSide.toUpperCase()} GTC verify FAILED: ${(ve as Error).message}`);
            }
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC ${hedgeKalSide.toUpperCase()} bid: ${(e as Error).message}`);
          state.kalNextRetryAt = Date.now() + 30_000;
        }
      }

      } // end for (tryOrderKH)
    }

    // -- exit: sell our Kalshi side at cost basis (skipped if STRICT_HEDGE)
    // Always place at cost basis -- the GTC rests until price comes back up.
    if (!STRICT_HEDGE && pos.sharesHeld > 0) {
      const hasKalExit = [...activeOrders.values()].some(o => o.role === "exit" && o.exchange === "kal");
      if (!hasKalExit) {
        const exitCents = Math.max(1, Math.min(99, Math.ceil(pos.kalCostBasis * 100)));
        const order = buildKalshiGTCOrder(pos.kalLeg.ticker, "sell", pos.kalSide, exitCents, pos.sharesHeld);
        try {
          const res = await placeKalshiOrder(order, DRY_RUN);
          const meta = extractKalMeta(res);
          const oid = DRY_RUN ? `dry-kal-exit-${Date.now()}` : String(meta.orderId ?? "");
          if (oid) {
            activeOrders.set(oid, { role: "exit", exchange: "kal", orderId: oid, price: exitCents / 100, shares: pos.sharesHeld, filledSoFar: 0, fetchFailures: 0, placedAt: Date.now() });
            saveHedgeState(state);
            console.log(`\n[HEDGE] Placed Kalshi GTC ${pos.kalSide.toUpperCase()}-ASK ${pos.sharesHeld}x@${fmtPct(exitCents / 100)} (exit at cost). orderId=${oid}`);
          }
        } catch (e) {
          console.error(`[HEDGE] Failed to place Kalshi GTC sell: ${(e as Error).message}`);
        }
      }
    }
  }
}

// --- Startup position scan ----------------------------------------------------
// When no saved hedge_state.json exists, scan the Polymarket wallet for live
// positions and cross-reference against the current watchlist.
// If a match is found the bot automatically enters hedge mode -- no manual action needed.

async function detectUnhedgedPmPositions(watchlist: WatchEntry[], hedgeStateTickers?: Set<string>): Promise<HedgeState[]> {
  let positions: PmPosition[];
  try {
    positions = await fetchPmPositionsCached(0); // force fresh at startup
  } catch (err) {
    console.error(`[STARTUP] Failed to fetch PM positions: ${(err as Error).message}`);
    return [];
  }

  if (!positions.length) return [];
  const results: HedgeState[] = [];

  // Load resolved trades to avoid re-processing PM positions that are already accounted for.
  // When a Kalshi market settles, the KAL position disappears from the portfolio, making
  // the PM tokens look "unhedged". But the arb was already resolved -- don't re-process.
  const existingTrades = loadArbTrades();
  const resolvedSharesByPm = new Map<string, number>(); // key: "pmSlug|pmOutcome" -> total resolved shares
  const resolvedSharesByTokenId = new Map<string, number>(); // key: pmTokenId -> total resolved shares
  for (const t of existingTrades) {
    if (t.status === "resolved" || t.status === "filled") {
      const key = `${t.pmSlug}|${t.pmOutcome}`;
      resolvedSharesByPm.set(key, (resolvedSharesByPm.get(key) ?? 0) + (t.shares ?? 0));
      if (t.pmTokenId) {
        resolvedSharesByTokenId.set(t.pmTokenId, (resolvedSharesByTokenId.get(t.pmTokenId) ?? 0) + (t.shares ?? 0));
      }
    } else if (t.status === "hedging") {
      // Only count "hedging" trades as tracked if they're actually in hedge_state.json.
      // If hedge state was lost (crash/restart), these positions need to be re-detected.
      if (hedgeStateTickers?.has(t.kalTicker)) {
        const key = `${t.pmSlug}|${t.pmOutcome}`;
        resolvedSharesByPm.set(key, (resolvedSharesByPm.get(key) ?? 0) + (t.shares ?? 0));
        if (t.pmTokenId) {
          resolvedSharesByTokenId.set(t.pmTokenId, (resolvedSharesByTokenId.get(t.pmTokenId) ?? 0) + (t.shares ?? 0));
        }
      }
    }
  }

  // Build tokenId -> watchlist leg lookup.
  // 2-way: Holding pm1 -> needs kal2 YES to complete (dir=B), oppLeg=pm2
  //        Holding pm2 -> needs kal1 YES to complete (dir=A), oppLeg=pm1
  // 3-way: Holding pm1 YES -> needs kal1 NO to complete (dir=G: KAL Home NO + PM Home YES)
  //        Holding pm2 YES -> needs kal2 NO to complete (dir=I: KAL Away NO + PM Away YES)
  //        Holding pm3 YES -> needs kal3 NO to complete (dir=H: KAL Draw NO + PM Draw YES)
  //        Holding pm1 NO  -> needs kal1 YES to complete (dir=J: KAL Home YES + PM Home NO)
  //        Holding pm2 NO  -> needs kal2 YES to complete (dir=L: KAL Away YES + PM Away NO)
  //        Holding pm3 NO  -> needs kal3 YES to complete (dir=K: KAL Draw YES + PM Draw NO)
  //   Using opposite-player KAL (2-way mapping) in 3-way leaves draw UNCOVERED.
  //   Using same-outcome KAL guarantees $1 payout regardless of result.
  type LegMatch = { entry: WatchEntry; pmLeg: PmLeg; pmOppLeg: PmLeg | null; kalLeg: KalshiLeg; kalSide3Way?: "yes" | "no" };
  const tokenMap = new Map<string, LegMatch>();
  for (const entry of watchlist) {
    if (entry.is3Way) {
      // YES tokens -> hedge with KAL NO on SAME outcome (Dir G/H/I)
      tokenMap.set(entry.pm1.tokenId, { entry, pmLeg: entry.pm1, pmOppLeg: null, kalLeg: entry.kal1, kalSide3Way: "no" });
      tokenMap.set(entry.pm2.tokenId, { entry, pmLeg: entry.pm2, pmOppLeg: null, kalLeg: entry.kal2, kalSide3Way: "no" });
      if (entry.pm3 && entry.kal3) {
        tokenMap.set(entry.pm3.tokenId, { entry, pmLeg: entry.pm3, pmOppLeg: null, kalLeg: entry.kal3, kalSide3Way: "no" });
      }
      // NO tokens -> hedge with KAL YES on SAME outcome (Dir J/K/L)
      if (entry.pm1.noTokenId) {
        tokenMap.set(entry.pm1.noTokenId, { entry, pmLeg: { ...entry.pm1, tokenId: entry.pm1.noTokenId, outcome: `${entry.pm1.outcome} [NO]` }, pmOppLeg: null, kalLeg: entry.kal1, kalSide3Way: "yes" });
      }
      if (entry.pm2.noTokenId) {
        tokenMap.set(entry.pm2.noTokenId, { entry, pmLeg: { ...entry.pm2, tokenId: entry.pm2.noTokenId, outcome: `${entry.pm2.outcome} [NO]` }, pmOppLeg: null, kalLeg: entry.kal2, kalSide3Way: "yes" });
      }
      if (entry.pm3?.noTokenId && entry.kal3) {
        tokenMap.set(entry.pm3.noTokenId, { entry, pmLeg: { ...entry.pm3, tokenId: entry.pm3.noTokenId, outcome: `${entry.pm3.outcome} [NO]` }, pmOppLeg: null, kalLeg: entry.kal3, kalSide3Way: "yes" });
      }
    } else {
      // 2-way: opposite player YES
      tokenMap.set(entry.pm1.tokenId, { entry, pmLeg: entry.pm1, pmOppLeg: entry.pm2, kalLeg: entry.kal2 });
      tokenMap.set(entry.pm2.tokenId, { entry, pmLeg: entry.pm2, pmOppLeg: entry.pm1, kalLeg: entry.kal1 });
      if (entry.pm3 && entry.kal3) {
        tokenMap.set(entry.pm3.tokenId, { entry, pmLeg: entry.pm3, pmOppLeg: null, kalLeg: entry.kal3 });
      }
    }
  }

  for (const pos of positions) {
    const tokenId = pickString(pos.asset ?? pos.tokenId ?? pos.conditionId ?? "");
    const size    = Number(pos.size ?? pos.amount ?? 0);
    if (!tokenId || size < 0.5) continue;

    const m = tokenMap.get(tokenId);
    if (!m) {
      // Position exists on PM but is not in the current watchlist
      // (e.g. the match resolved, or discovery couldn't find it today)
      console.warn(
        `[STARTUP] Unrecognized PM position -- tokenId=${tokenId.slice(0, 16)}... size=${size}.` +
        ` Not in today's watchlist -- please resolve manually.`
      );
      continue;
    }

    // Conservative cost basis: if API doesn't return avg price, assume 0.50 (mid-market).
    // Using tickSize (0.01) would make maxKalPrice ≈ 0.99, effectively a market-buy -- dangerous.
    // 0.50 keeps the GTC bid at ~0.50, which is safe and breakeven-ish for most head-to-head markets.
    // IMPORTANT: PM positions API avgPrice can be MARKET PRICE, not fill price.
    // Prefer actual fill price from pending_fills when available.
    const pfMatch = loadPendingFills().find(pf =>
      pf.exchange === "pm" && pf.pmSlug === m.entry.pmSlug &&
      namesMatch(pf.pmOutcome, m.pmLeg.outcome) && pf.price > 0
    );
    const rawAvgPrice = pfMatch ? pfMatch.price : Number(pos.avgPrice ?? pos.averagePrice ?? pos.price ?? 0);
    const avgPrice = (rawAvgPrice > 0 && rawAvgPrice < 1) ? rawAvgPrice : 0.50;
    const totalPmShares = Math.round(size);

    // Count how many shares are already covered by the opposite PM leg (complete-pm path)
    const oppPmSize = m.pmOppLeg ? Math.round(positions.reduce((sum, p) => {
      const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
      const sz = Number(p.size ?? p.amount ?? 0);
      return tid === m.pmOppLeg!.tokenId ? sum + sz : sum;
    }, 0)) : 0;

    // Count how many shares are already covered by the Kalshi leg (complete-kal path)
    const kalAlreadyFilledRaw = await getKalshiPosition(m.kalLeg.ticker);
    if (kalAlreadyFilledRaw < 0) {
      console.warn(`[STARTUP] Kalshi API error for ${m.kalLeg.ticker} -- skipping PM position to avoid duplicate arbs.`);
      continue;
    }
    const kalAlreadyFilled = kalAlreadyFilledRaw;

    // Count shares already accounted for in resolved/active arb trades
    // Use BOTH slug+outcome and tokenId lookups -- whichever finds more (handles string mismatches)
    const tradeKey = `${m.entry.pmSlug}|${m.pmLeg.outcome}`;
    const bySlug = resolvedSharesByPm.get(tradeKey) ?? 0;
    const byToken = resolvedSharesByTokenId.get(m.pmLeg.tokenId) ?? 0;
    const alreadyTracked = Math.max(bySlug, byToken);

    // Net unhedged = total PM shares minus whatever is already covered on either side
    // alreadyTracked may overlap with oppPmSize/kalAlreadyFilled (same shares in trade records AND exchange),
    // so use the larger of (live coverage) vs (tracked trades) to avoid double-counting
    const liveCoverage = oppPmSize + kalAlreadyFilled;
    const covered = Math.min(totalPmShares, Math.max(liveCoverage, alreadyTracked));
    const sharesHeld = totalPmShares - covered;

    if (sharesHeld <= 0) {
      const parts: string[] = [];
      if (kalAlreadyFilled > 0) parts.push(`KAL ${kalAlreadyFilled}`);
      if (oppPmSize > 0) parts.push(`PM-opp ${oppPmSize}`);
      if (alreadyTracked > 0) parts.push(`trades ${alreadyTracked}`);
      console.log(
        `[STARTUP] PM ${totalPmShares}x${m.pmLeg.outcome} -- fully covered` +
        ` (${parts.join(" + ")}). Arb complete, skipping.\n`
      );
      continue;
    }

    if (covered > 0) {
      console.log(
        `[STARTUP] PM ${totalPmShares}x${m.pmLeg.outcome} -- ${covered} already covered` +
        ` (KAL ${kalAlreadyFilled} + PM-opp ${oppPmSize}). Net unhedged: ${sharesHeld}.`
      );
    }

    console.warn(
      `\n[STARTUP] Found unhedged PM position: ${sharesHeld}x${m.pmLeg.outcome}` +
      ` @${fmtPct(avgPrice)} (${m.entry.pmSlug}). Will hedge automatically.\n`
    );

    // Determine kalSide: 3-way uses kalSide3Way from tokenMap, 2-way defaults to "yes"
    const detectedKalSide: "yes" | "no" = m.kalSide3Way ?? "yes";

    // Log an arb trade entry so resolveArbTrade can find it when the hedge completes.
    const pmCostForTrade = Math.round(sharesHeld * avgPrice * 100) / 100;
    // Pick the closest matching dir for audit trail
    const detectedDir: ArbTradeRecord["dir"] = m.kalSide3Way === "no" ? "G" : m.kalSide3Way === "yes" ? "J" : "A";
    const tidDetect = `arb-detect-${Date.now()}`;
    logArbTrade({
      id: tidDetect,
      ts: new Date().toISOString(),
      match: `${m.entry.kal1.surname} vs ${m.entry.kal2.surname}`,
      dir: detectedDir,
      status: "hedging",
      shares: sharesHeld,
      kalTicker: m.kalLeg.ticker,
      kalFillPrice: 0,
      kalCost: 0,
      kalFees: 0,
      pmOutcome: m.pmLeg.outcome,
      pmSlug: m.entry.pmSlug,
      pmTokenId: m.pmLeg.tokenId,
      pmFillPrice: avgPrice,
      pmCost: pmCostForTrade,
      totalCost: pmCostForTrade,
      projectedEdge: 0,
      projectedProfit: 0,
      initialExchange: "pm",
    });

    results.push({
      position: {
        tradeId: tidDetect,
        heldExchange: "pm",
        pmLeg: m.pmLeg,
        pmOppLeg: m.pmOppLeg,
        pmCostBasis: avgPrice,
        kalLeg: m.kalLeg,
        kalCostBasis: 0,
        kalSide: detectedKalSide,
        sharesHeld,
        initialShares: sharesHeld,
        initialCost: sharesHeld * avgPrice,
        hedgeFillCost: 0,
        hedgeFillCostKal: 0,
        hedgeFillCostPm: 0,
        kalFees: 0,
        initialKalFees: 0,
      },
      activeOrders: new Map(),
      kalNextRetryAt: 0,
      pmOnlyCycles: 0,
    });
  }

  return results;
}

// --- Startup Kalshi position scan ---------------------------------------------
// Mirror of detectUnhedgedPmPositions -- scans the Kalshi portfolio for open YES
// positions and cross-references against the watchlist.  If a match is found and
// neither the PM leg nor the Kalshi NO leg is already held, enters hedge mode.

async function detectUnhedgedKalPositions(watchlist: WatchEntry[], kalPosMap?: Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>, hedgeStateTickers?: Set<string>): Promise<HedgeState[]> {
  // Build ticker -> watchlist leg lookup.
  // 2-way markets: Holding kal1 YES -> needs pm2 to complete (dir=A logic)
  //                Holding kal2 YES -> needs pm1 to complete (dir=B logic)
  // 3-way soccer:  Holding kal1 YES -> needs PM Home NO to complete (dir=J logic)
  //                Holding kal2 YES -> needs PM Away NO to complete (dir=L logic)
  //                Holding kal3 YES -> needs PM Draw NO to complete (dir=K logic)
  //   Using opposite-player YES (2-way mapping) in 3-way leaves draw UNCOVERED.
  //   Using same-outcome NO token guarantees $1 payout regardless of result.
  type KalLegMatch = { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg };
  const kalTickerMap = new Map<string, KalLegMatch>();
  for (const entry of watchlist) {
    if (entry.is3Way) {
      // 3-way: hedge with PM NO token on SAME outcome (KAL YES + PM NO = $1 always)
      if (entry.pm1.noTokenId) {
        kalTickerMap.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: { ...entry.pm1, tokenId: entry.pm1.noTokenId, outcome: `${entry.pm1.outcome} [NO]` } });
      }
      if (entry.pm2.noTokenId) {
        kalTickerMap.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: { ...entry.pm2, tokenId: entry.pm2.noTokenId, outcome: `${entry.pm2.outcome} [NO]` } });
      }
      if (entry.kal3 && entry.pm3?.noTokenId) {
        kalTickerMap.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: { ...entry.pm3, tokenId: entry.pm3.noTokenId, outcome: `${entry.pm3.outcome} [NO]` } });
      }
    } else {
      // 2-way: opposite player YES (KAL P1 YES + PM P2 YES = $1 always)
      kalTickerMap.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm2 });
      kalTickerMap.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm1 });
      if (entry.kal3 && entry.pm3) {
        kalTickerMap.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
      }
    }
  }

  // Use pre-fetched position map if provided, otherwise fetch fresh
  const posMap = kalPosMap ?? await getKalshiPositionMap();
  // Convert map to array format for existing loop
  const kalYesPositions: Array<{ ticker: string; yesCount: number; avgPriceCents: number }> = [];
  for (const [ticker, p] of posMap) {
    if (p.yesCount > 0) kalYesPositions.push({ ticker, yesCount: p.yesCount, avgPriceCents: p.avgPriceCents });
  }
  if (!kalYesPositions.length) {
    console.log(`[STARTUP] KAL scan: No YES positions found on Kalshi.`);
    return [];
  }
  console.log(`[STARTUP] KAL scan: ${kalYesPositions.length} YES position(s): ${kalYesPositions.map(p => `${p.yesCount}x${p.ticker}`).join(", ")}`);

  // Use cached PM positions (already fetched by detectUnhedgedPmPositions on same startup)
  let pmPositions: PmPosition[] = [];
  try {
    pmPositions = await fetchPmPositionsCached(5000);
  } catch (err) {
    console.error(`[STARTUP] Failed to fetch PM positions for Kalshi scan: ${(err as Error).message}`);
  }

  const results: HedgeState[] = [];

  // Load resolved trades to avoid re-processing Kalshi positions already accounted for.
  const existingTrades = loadArbTrades();
  const resolvedSharesByKal = new Map<string, number>(); // key: kalTicker -> total resolved shares
  for (const t of existingTrades) {
    if (t.status === "resolved" || t.status === "filled") {
      resolvedSharesByKal.set(t.kalTicker, (resolvedSharesByKal.get(t.kalTicker) ?? 0) + (t.shares ?? 0));
    } else if (t.status === "hedging") {
      // Only count "hedging" trades as tracked if they're actually in hedge_state.json.
      // If hedge state was lost (crash/restart), these positions need to be re-detected.
      if (hedgeStateTickers?.has(t.kalTicker)) {
        resolvedSharesByKal.set(t.kalTicker, (resolvedSharesByKal.get(t.kalTicker) ?? 0) + (t.shares ?? 0));
      } else {
        console.warn(`[STARTUP] Orphaned hedge trade: ${t.kalTicker} (${t.shares} shares) -- status=hedging but NOT in hedge_state.json. Will re-detect.`);
      }
    }
  }

  for (const { ticker, yesCount, avgPriceCents } of kalYesPositions) {
    const m = kalTickerMap.get(ticker);
    if (!m) {
      // Fetch market status so we can tell the user if the event is finished
      const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
      let status = "unknown";
      let title = "";
      let result = "";
      try {
        const res = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
        const mkt = res.market ?? res as unknown as KalshiMarket;
        status = String(mkt.status ?? "unknown");
        title = String(mkt.title ?? "");
        result = String(mkt.result ?? mkt.settlement_value ?? "");
      } catch { /* ignore fetch errors */ }
      const extra = result ? ` result=${result}` : "";
      console.warn(
        `\n[STARTUP] [!] Orphaned Kalshi position: ${yesCount}x${ticker} YES` +
        `  status=${status}${extra}` +
        (title ? `\n         ${title}` : "") +
        `\n         Not in today's watchlist -- cannot auto-hedge.` +
        (status === "finalized" || status === "settled"
          ? `\n         Market is settled. Kalshi should pay out automatically.`
          : status === "closed"
          ? `\n         Event finished but not yet settled -- payout pending.`
          : `\n         Market still open -- resolve manually or add to watchlist.\n`)
      );
      continue;
    }

    const totalKalShares = yesCount;

    // Count how many shares are already covered by the Kalshi NO leg (YES + NO = $1)
    // Use the pre-fetched position map -- no extra API call per ticker.
    const kalNoFilled = posMap.get(ticker)?.noCount ?? 0;

    // Count how many shares are already covered by the PM leg (complete-pm path)
    const pmHeld = Math.round(pmPositions.reduce((sum, p) => {
      const tid = pickString(p.asset ?? p.tokenId ?? p.conditionId ?? "");
      const sz = Number(p.size ?? p.amount ?? 0);
      return tid === m.pmLeg.tokenId ? sum + sz : sum;
    }, 0));

    // Count shares already accounted for in resolved/active arb trades
    const alreadyTracked = resolvedSharesByKal.get(ticker) ?? 0;

    console.log(`[STARTUP] KAL ${totalKalShares}x${ticker}: kalNO=${kalNoFilled} pmHeld=${pmHeld} tracked=${alreadyTracked} inHedgeState=${hedgeStateTickers?.has(ticker) ?? "n/a"}`);

    // Net unhedged = total Kalshi YES minus whatever is already covered on either side
    // alreadyTracked may overlap with kalNoFilled/pmHeld, so use max to avoid double-counting
    const liveCoverage = kalNoFilled + pmHeld;
    const covered = Math.min(totalKalShares, Math.max(liveCoverage, alreadyTracked));
    const sharesHeld = totalKalShares - covered;

    if (sharesHeld <= 0) {
      const parts: string[] = [];
      if (kalNoFilled > 0) parts.push(`KAL NO ${kalNoFilled}`);
      if (pmHeld > 0) parts.push(`PM ${pmHeld}`);
      if (alreadyTracked > 0) parts.push(`trades ${alreadyTracked}`);
      console.log(
        `[STARTUP] Kalshi ${totalKalShares}x${ticker} YES -- fully covered` +
        ` (${parts.join(" + ")}). Arb complete, skipping.\n`
      );
      continue;
    }

    if (covered > 0) {
      console.log(
        `[STARTUP] Kalshi ${totalKalShares}x${ticker} YES -- ${covered} already covered` +
        ` (KAL NO ${kalNoFilled} + PM ${pmHeld}). Net unhedged: ${sharesHeld}.`
      );
    }

    // Use actual fill price from Kalshi API: total_traded / position (gross cost).
    // Fall back to current market ask if the API didn't return cost data.
    const avgFillPrice = avgPriceCents > 0 && avgPriceCents < 100
      ? avgPriceCents / 100
      : (m.kalLeg.yesAsk > 0 && m.kalLeg.yesAsk < 1) ? m.kalLeg.yesAsk : 0.50;

    // Fetch actual Kalshi fills for this ticker to get real fee data
    let actualKalFees = 0;
    try {
      const allFills = await fetchAllKalshiFills();
      const tickerFills = allFills.filter(f => f.ticker === ticker && f.action === "buy" && f.side === "yes");
      actualKalFees = tickerFills.reduce((s, f) => s + f.feeCost, 0);
    } catch (e) {
      console.warn(`[STARTUP] Failed to fetch Kalshi fills for fee data: ${(e as Error).message}`);
    }
    const kalFeePerShare = actualKalFees / Math.max(sharesHeld, 1);

    console.warn(
      `\n[STARTUP] Found unhedged Kalshi position: ${sharesHeld}x${ticker} YES` +
      ` @~${fmtPct(avgFillPrice)} fee=$${actualKalFees.toFixed(2)} (${fmtPct(kalFeePerShare)}/sh) (${m.entry.pmSlug}). Will hedge automatically.\n`
    );

    // Log an arb trade entry so resolveArbTrade can find it when the hedge completes.
    // Without this, the resolved hedge has no audit trail in arb_trades.json.
    const kalCostForTrade = Math.round(sharesHeld * avgFillPrice * 100) / 100;
    const tidKalDetect = `arb-detect-${Date.now()}`;
    logArbTrade({
      id: tidKalDetect,
      ts: new Date().toISOString(),
      match: `${m.entry.kal1.surname} vs ${m.entry.kal2.surname}`,
      dir: "A", // startup detection assumes dir A (KAL YES + PM opposite)
      status: "hedging",
      shares: sharesHeld,
      kalTicker: ticker,
      kalFillPrice: avgFillPrice,
      kalCost: kalCostForTrade,
      kalFees: actualKalFees,
      pmOutcome: m.pmLeg.outcome,
      pmSlug: m.entry.pmSlug,
      pmTokenId: m.pmLeg.tokenId,
      pmFillPrice: 0,
      pmCost: 0,
      totalCost: kalCostForTrade + actualKalFees,
      projectedEdge: 0,
      projectedProfit: 0,
      initialExchange: "kal",
    });

    results.push({
      position: {
        tradeId: tidKalDetect,
        heldExchange: "kal",
        pmLeg: m.pmLeg,
        pmOppLeg: null,
        pmCostBasis: 0,
        kalLeg: m.kalLeg,
        kalCostBasis: avgFillPrice + kalFeePerShare,  // actual fill price + actual fee per share
        kalSide: "yes",   // startup detection assumes YES side (legacy dir A/B)
        sharesHeld,
        initialShares: sharesHeld,
        initialCost: sharesHeld * avgFillPrice + actualKalFees,
        hedgeFillCost: 0,
        hedgeFillCostKal: 0,
        hedgeFillCostPm: 0,
        kalFees: actualKalFees,
        initialKalFees: actualKalFees,
      },
      activeOrders: new Map(),
      kalNextRetryAt: 0,
      pmOnlyCycles: 0,
    });
  }

  return results;
}

// --- Monitor loop -------------------------------------------------------------

async function monitorLoop(watchlist: WatchEntry[]): Promise<void> {
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

  // cooldownMap: matchCode -> timestamp of last trade ATTEMPT (success or fail)
  const cooldownMap = new Map<string, number>();
  // kalTickerCooldown: kalTicker -> timestamp -- prevents firing the same Kalshi market
  // from different watchlist entries (e.g. GAME vs MAP entries sharing a ticker)
  const kalTickerCooldown = new Map<string, number>();
  // pmSlugCooldown: pmSlug -> timestamp -- prevents buying same PM market from GAME+MAP entries
  const pmSlugCooldown = new Map<string, number>();
  // abortCooldown: matchCode -> { count, cooldownUntil } -- after 3 consecutive aborts, skip for 5 min
  const ABORT_COOLDOWN_THRESHOLD = 3;
  const ABORT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  const abortCountMap = new Map<string, { count: number; cooldownUntil: number }>();
  // sessionSkipSet: matches already traded -- don't trade again this session.
  // Prevents re-arbing the same match in the opposite direction (which nets out to a fee loss).
  // Seeded at startup from arb_trades.json: includes recent trades (last 3 days) AND any
  // non-resolved trades (a trade placed days ago on a future game should still block).
  const sessionSkipSet = new Set<string>();
  {
    const recentCutoff = Date.now() - 3 * 86_400_000; // 3 days ago
    const pastTrades = loadArbTrades();
    for (const t of pastTrades) {
      if (!t.kalTicker || !t.ts) continue;
      const tradeTime = new Date(t.ts).getTime();
      const isRecent = tradeTime >= recentCutoff;
      const isActive = t.status === "hedging" || t.status === "filled";
      // Seed from recent trades OR any still-active trades (placed earlier for future games)
      if (isRecent || isActive) {
        const mc = matchCodePrefix(t.kalTicker);
        if (mc) sessionSkipSet.add(mc);
      }
    }
    if (sessionSkipSet.size > 0) {
      console.log(`[STARTUP] Seeded sessionSkipSet with ${sessionSkipSet.size} match(es) from recent/active trades: ${Array.from(sessionSkipSet).join(", ")}`);
    }
  }
  // Coin-flip warning: PM pricing ~50/50 -- only warn once per match
  const coinFlipWarned = new Set<string>();
  // inflight: markets currently executing an arb -- prevents concurrent execution on same market
  const inflight = new Set<string>();
  // Circuit breaker: consecutive arb execution errors
  let consecutiveErrors = 0;

  // Helper: cancel ALL resting orders on both exchanges (used when clearing hedge state)
  async function cancelAllHedgeOrders(orders: Map<string, HedgeOrder>): Promise<void> {
    for (const [oid, ho] of orders) {
      try {
        if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
        else await cancelKalshiOrder(oid, DRY_RUN);
        console.log(`[HEDGE RESUME] Cancelled ${ho.exchange.toUpperCase()} ${ho.role} order ${oid.slice(0, 16)}...`);
      } catch (e) {
        console.error(`[HEDGE RESUME] Could not cancel ${ho.exchange.toUpperCase()} order ${oid.slice(0, 16)}...: ${(e as Error).message}`);
      }
    }
  }

  // Active hedge states -- load from file first; if none, scan both wallets.
  // Supports MULTIPLE simultaneous hedges (e.g. Tirante on PM + Elegance on Kalshi).
  // Fetch all Kalshi positions in ONE API call -- reused by resume loop + detectUnhedgedKal.
  const kalPosMap = await getKalshiPositionMap();

  let hedgeStates: HedgeState[] = loadHedgeStates();
  _allHedgeStates = hedgeStates; // keep module-level ref in sync
  if (hedgeStates.length > 0) {
    // Re-check actual coverage on each position and clean up resolved ones
    const surviving: HedgeState[] = [];
    for (const hs of hedgeStates) {
      const pos = hs.position;
      if (!DRY_RUN) {
        // -- Verify the HELD position actually exists on the exchange ----------
        // Prevents ghost positions: state file says we hold shares but wallet/API disagrees.
        if (pos.heldExchange === "pm") {
          try {
            const pmPos = await fetchPmPositionsCached(0);
            const heldQty = sumPmHeld(pmPos, pos.pmLeg.tokenId);
            if (heldQty <= 0) {
              console.warn(
                `\n[HEDGE RESUME] [!] GHOST POSITION: PM ${pos.pmLeg.outcome} not found in wallet!` +
                ` Persisted sharesHeld=${pos.sharesHeld} but wallet has 0. Clearing.\n`
              );
              if (hs.activeOrders.size > 0) await cancelAllHedgeOrders(hs.activeOrders);
              continue; // don't add to surviving
            }
            if (heldQty < pos.sharesHeld) {
              console.warn(`[HEDGE RESUME] PM wallet has ${heldQty} but state says ${pos.sharesHeld}. Using wallet qty.`);
              pos.sharesHeld = heldQty;
            }
          } catch (e) {
            console.error(`[HEDGE RESUME] PM held-position verify failed: ${(e as Error).message} -- proceeding with persisted qty.`);
          }
        } else {
          try {
            const kalQty = kalPosMap.get(pos.kalLeg.ticker)?.yesCount ?? 0;
            if (kalQty <= 0) {
              console.warn(
                `\n[HEDGE RESUME] [!] GHOST POSITION: Kalshi ${pos.kalLeg.ticker} YES not found!` +
                ` Persisted sharesHeld=${pos.sharesHeld} but API has 0. Clearing.\n`
              );
              if (hs.activeOrders.size > 0) await cancelAllHedgeOrders(hs.activeOrders);
              continue;
            }
            if (kalQty < pos.sharesHeld) {
              console.warn(`[HEDGE RESUME] Kalshi has ${kalQty} but state says ${pos.sharesHeld}. Using API qty.`);
              pos.sharesHeld = kalQty;
            }
          } catch (e) {
            console.error(`[HEDGE RESUME] Kalshi held-position verify failed: ${(e as Error).message} -- proceeding with persisted qty.`);
          }
        }

        // -- Check coverage on opposite legs (using pre-fetched maps) ---------
        let covered = 0;
        if (pos.heldExchange === "pm") {
          covered += kalPosMap.get(pos.kalLeg.ticker)?.yesCount ?? 0;
          if (pos.pmOppLeg) {
            try {
              const pmPositions = await fetchPmPositionsCached(5000);
              covered += sumPmHeld(pmPositions, pos.pmOppLeg.tokenId);
            } catch (e) {
              console.error(`[HEDGE RESUME] Failed to check PM positions: ${(e as Error).message}`);
            }
          }
        } else {
          try {
            const pmPositions = await fetchPmPositionsCached(5000);
            covered += sumPmHeld(pmPositions, pos.pmLeg.tokenId);
          } catch (e) {
            console.error(`[HEDGE RESUME] Failed to check PM positions: ${(e as Error).message}`);
          }
          covered += kalPosMap.get(pos.kalLeg.ticker)?.noCount ?? 0;
        }
        covered = Math.min(pos.sharesHeld, covered);

        // Always cancel stale orders from previous session -- they may have expired,
        // been cancelled, or partially filled on the exchange. The hedge cycle will
        // place fresh orders with up-to-date prices.
        if (hs.activeOrders.size > 0) {
          await cancelAllHedgeOrders(hs.activeOrders);
          hs.activeOrders.clear();
        }

        if (covered >= pos.sharesHeld) {
          console.warn(
            `\n[HEDGE RESUME] ${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}` +
            ` fully covered (${covered}/${pos.sharesHeld}). Clearing.\n`
          );
          continue; // don't add to surviving
        } else if (covered > 0) {
          const old = pos.sharesHeld;
          pos.sharesHeld -= covered;
          console.warn(`[HEDGE RESUME] ${old - covered}/${old} remaining for ${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}.`);
        }
      }
      console.warn(
        `[HEDGE RESUME] ${pos.sharesHeld} ${pos.heldExchange.toUpperCase()} shares of ` +
        `${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}. Resuming.\n`
      );
      surviving.push(hs);
    }
    hedgeStates = surviving;
  }

  // -- Restore orphaned "hedging" trades from arb_trades.json -----------------
  // If hedge_state.json was lost on restart but arb_trades still has "hedging" records,
  // reconstruct correct HedgeState from the trade record (preserving dir -> kalSide).
  // This prevents detectUnhedgedPmPositions from re-detecting with hardcoded kalSide="yes"
  // which is WRONG for Dir C/D trades (kalSide should be "no").
  {
    const hsTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
    const allTrades = loadArbTrades();
    const orphanedHedging = allTrades.filter(t => t.status === "hedging" && !hsTickers.has(t.kalTicker));
    if (orphanedHedging.length > 0) {
      // Build kalTicker -> watchlist lookup
      const kalTickerToWatch = new Map<string, { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg }>();
      for (const entry of watchlist) {
        kalTickerToWatch.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm1 });
        kalTickerToWatch.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm2 });
        if (entry.kal3 && entry.pm3) {
          kalTickerToWatch.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
        }
      }
      for (const t of orphanedHedging) {
        const wm = kalTickerToWatch.get(t.kalTicker);
        if (!wm) {
          console.warn(`[STARTUP] Orphaned hedging trade ${t.id} (${t.kalTicker}) not in watchlist -- cannot restore.`);
          continue;
        }
        // Derive kalSide from dir: C/D/G/H/I use KAL NO, everything else uses KAL YES
        const kalNoSideDirs = new Set(["C", "D", "G", "H", "I"]);
        const kalSide: "yes" | "no" = kalNoSideDirs.has(t.dir) ? "no" : "yes";
        const heldExchange = t.initialExchange ?? (t.pmCost > 0 && t.kalCost === 0 ? "pm" : "kal");
        // Find the correct PM leg from the trade record (match by pmOutcome or pmTokenId)
        const entry = wm.entry;
        let pmLeg: PmLeg = wm.pmLeg;
        let pmOppLeg: PmLeg | null = null;
        const is3WayDir = "GHIJKL".includes(t.dir);
        if (!is3WayDir) {
          // 2-way: Dir A: kal1->pm2.  Dir B: kal2->pm1.  Dir C: kal1->pm1.  Dir D: kal2->pm2.
          if (t.dir === "A" || t.dir === "D") { pmLeg = entry.pm2; pmOppLeg = entry.pm1; }
          else if (t.dir === "B" || t.dir === "C") { pmLeg = entry.pm1; pmOppLeg = entry.pm2; }
        } else {
          // 3-way soccer: no pmOppLeg (can't complete with a single opposite token)
          pmOppLeg = null;
        }
        // Override with trade's tokenId if available (more reliable -- handles NO tokens too)
        if (t.pmTokenId) {
          for (const leg of [entry.pm1, entry.pm2, entry.pm3].filter(Boolean) as PmLeg[]) {
            if (leg.tokenId === t.pmTokenId || leg.noTokenId === t.pmTokenId) {
              // If tokenId matches a noTokenId, use the NO version
              if (leg.noTokenId === t.pmTokenId) {
                pmLeg = { ...leg, tokenId: leg.noTokenId, outcome: `${leg.outcome} [NO]` };
              } else {
                pmLeg = leg;
              }
              break;
            }
          }
        }
        const costBasis = heldExchange === "pm"
          ? (t.pmFillPrice > 0 ? t.pmFillPrice : t.pmCost / Math.max(t.shares, 1))
          : (t.kalFillPrice > 0 ? t.kalFillPrice : t.kalCost / Math.max(t.shares, 1));
        const kalFeePerShare = (t.kalFees ?? 0) / Math.max(t.shares, 1);
        const restoredState: HedgeState = {
          position: {
            tradeId: t.id,
            heldExchange,
            pmLeg,
            pmOppLeg: heldExchange === "pm" ? pmOppLeg : null,
            pmCostBasis: heldExchange === "pm" ? costBasis : 0,
            kalLeg: wm.kalLeg,
            kalCostBasis: heldExchange === "kal" ? costBasis + kalFeePerShare : 0,
            kalSide,
            sharesHeld: t.shares,
            initialShares: t.shares,
            initialCost: heldExchange === "pm" ? t.pmCost : t.kalCost,
            hedgeFillCost: 0,
            hedgeFillCostKal: 0,
            hedgeFillCostPm: 0,
            kalFees: t.kalFees ?? 0,
            initialKalFees: heldExchange === "kal" ? (t.kalFees ?? 0) : 0,
          },
          activeOrders: new Map(),
          kalNextRetryAt: 0,
          pmOnlyCycles: 0,
        };
        hedgeStates.push(restoredState);
        hsTickers.add(t.kalTicker);
        console.warn(
          `\n[STARTUP] Restored orphaned hedging trade: ${t.match} dir=${t.dir} kalSide=${kalSide}` +
          ` held=${heldExchange} shares=${t.shares} ticker=${t.kalTicker}\n`
        );
      }
    }
  }

  // Always scan both wallets -- even if we loaded persisted states, there may be OTHER positions.
  // Pass current hedgeState tickers so detection knows which "hedging" arb trades are actually active.
  console.log("[STARTUP] Scanning both wallets for unhedged positions...");
  const hsTickerSet = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
  const pmFound = await detectUnhedgedPmPositions(watchlist, hsTickerSet);
  const kalFound = await detectUnhedgedKalPositions(watchlist, kalPosMap, hsTickerSet);

  // -- Cross-match dedup for 3-way markets -----------------------------------
  // When both detection functions find positions from the SAME 3-way match
  // (e.g., KAL BRC YES + PM MID YES from an old 2-way hedge), hedging just ONE
  // side is sufficient. The hedged pair guarantees $1 in all outcomes; the
  // unhedged position becomes a free bonus (pays $1 in 1-of-3 outcomes).
  // Creating two independent hedges costs double for only marginal benefit.
  const pmBySlug = new Map<string, HedgeState>();
  for (const hs of pmFound) {
    const slug = watchlist.find(w =>
      w.pm1.tokenId === hs.position.pmLeg.tokenId ||
      w.pm2.tokenId === hs.position.pmLeg.tokenId ||
      w.pm3?.tokenId === hs.position.pmLeg.tokenId ||
      w.pm1.noTokenId === hs.position.pmLeg.tokenId ||
      w.pm2.noTokenId === hs.position.pmLeg.tokenId ||
      w.pm3?.noTokenId === hs.position.pmLeg.tokenId
    )?.pmSlug;
    if (slug) pmBySlug.set(slug, hs);
  }
  const deduplicatedKalFound: HedgeState[] = [];
  for (const hs of kalFound) {
    const entry = watchlist.find(w =>
      w.kal1.ticker === hs.position.kalLeg.ticker ||
      w.kal2.ticker === hs.position.kalLeg.ticker ||
      w.kal3?.ticker === hs.position.kalLeg.ticker
    );
    if (entry?.is3Way && pmBySlug.has(entry.pmSlug)) {
      const pmHs = pmBySlug.get(entry.pmSlug)!;
      console.log(
        `[STARTUP] 3-way cross-match dedup: KAL ${hs.position.sharesHeld}x${hs.position.kalLeg.ticker} YES` +
        ` and PM ${pmHs.position.sharesHeld}x${pmHs.position.pmLeg.outcome} are from the same match.` +
        ` Keeping PM-side hedge only -- KAL position becomes bonus coverage.`
      );
      continue; // skip this KAL hedge state
    }
    deduplicatedKalFound.push(hs);
  }
  const freshFound = [...pmFound, ...deduplicatedKalFound];

  // Deduplicate: don't add positions that are already being hedged (same kalLeg ticker).
  // Also update kalCostBasis from fresh API data -- the persisted value may have used
  // an old formula (net-of-fees) that understates the true purchase price.
  const existingTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
  for (const hs of freshFound) {
    if (!existingTickers.has(hs.position.kalLeg.ticker)) {
      hedgeStates.push(hs);
      existingTickers.add(hs.position.kalLeg.ticker);
    } else {
      // Refresh kalCostBasis for KAL-held positions from fresh API data
      const existing = hedgeStates.find(h => h.position.kalLeg.ticker === hs.position.kalLeg.ticker);
      if (existing && existing.position.heldExchange === "kal" && hs.position.kalCostBasis > 0) {
        const oldCb = existing.position.kalCostBasis;
        if (Math.abs(oldCb - hs.position.kalCostBasis) > 0.001) {
          existing.position.kalCostBasis = hs.position.kalCostBasis;
          console.warn(
            `[HEDGE RESUME] Updated kalCostBasis for ${hs.position.kalLeg.ticker}: ` +
            `${fmtPct(oldCb)} -> ${fmtPct(hs.position.kalCostBasis)} (fresh from API)`
          );
        }
      }
    }
  }

  // -- Cancel ALL resting Kalshi orders at startup -----------------------------
  // Prevents over-hedging: if the bot crashed after placing a GTC order but before
  // saving hedge_state.json, the order is still live on Kalshi but invisible to us.
  // On restart, the hedge cycle would place ANOTHER order -> double-fill -> over-hedge.
  // Safe to cancel everything: the bot only places hedge orders, never manual orders.
  try {
    const restingOrders = await fetchOpenKalshiOrders();
    if (restingOrders.length > 0) {
      console.warn(`[STARTUP] Found ${restingOrders.length} resting Kalshi order(s) from previous session. Cancelling all to prevent over-hedging.`);
      for (const ro of restingOrders) {
        try {
          await cancelKalshiOrder(ro.orderId, DRY_RUN);
          console.log(`[STARTUP]   Cancelled ${ro.side.toUpperCase()} ${ro.ticker} ${ro.remainingCount}x@${ro.priceCents}c (${ro.orderId.slice(0, 16)}...)`);
        } catch (e) {
          console.error(`[STARTUP]   Failed to cancel order ${ro.orderId.slice(0, 16)}...: ${(e as Error).message}`);
        }
      }
    } else {
      console.log("[STARTUP] No resting Kalshi orders found. Clean slate.");
    }
  } catch (e) {
    console.error(`[STARTUP] Failed to fetch open Kalshi orders: ${(e as Error).message}. Proceeding with caution.`);
  }

  if (hedgeStates.length > 0) {
    saveHedgeStates(hedgeStates);
    console.log(`[STARTUP] Hedging ${hedgeStates.length} position(s) simultaneously.\n`);
  } else {
    saveHedgeStates([]);
    console.log("[STARTUP] No unhedged positions found on either exchange. Starting clean.\n");
  }
  let cycle = 0;

  // -- P&L summary ------------------------------------------------------------
  const arbTrades = loadArbTrades();
  if (arbTrades.length > 0) {
    const filled = arbTrades.filter(t => t.status === "filled");
    const hedging = arbTrades.filter(t => t.status === "hedging");
    const resolved = arbTrades.filter(t => t.status === "resolved");
    const totalCost = arbTrades.reduce((s, t) => s + t.totalCost, 0);
    const totalPnl = filled.reduce((s, t) => s + (t.realizedPnl ?? t.projectedProfit), 0);
    console.log(`\n[P&L] ${arbTrades.length} arbs: ${filled.length} filled, ${resolved.length} resolved, ${hedging.length} hedging`);
    console.log(`[P&L] Total invested: $${totalCost.toFixed(2)}  Est. P&L (filled): $${totalPnl.toFixed(2)}\n`);
  }

  console.log(
    `\n[MONITOR] Starting  matches=${watchlist.length}  DRY_RUN=${DRY_RUN}` +
    `  USD/trade=${TRADE_USD}  MAX_CONTRACTS=${MAX_CONTRACTS}  MIN_EDGE=${fmtPct(MIN_EDGE)}` +
    `  fees: KAL=${(KALSHI_FEE_RATE * 100).toFixed(1)}% PM=${(PM_FEE_RATE * 100).toFixed(1)}%` +
    `  hedge=${HEDGE_TARGET}  strict=${STRICT_HEDGE}` +
    `  poll=${POLL_INTERVAL_MS}ms  cooldown=${TRADE_COOLDOWN_MS / 1000}s\n`
  );

  // -- Pre-warm PM ClobClient (avoids ~200-500ms cold start on first trade) --
  try {
    const warmStart = performance.now();
    await createPmClient();
    console.log(`[STARTUP] PM ClobClient pre-warmed (${(performance.now() - warmStart).toFixed(0)}ms)`);
  } catch (e) {
    console.warn(`[STARTUP] PM client warmup failed: ${(e as Error).message}`);
  }

  // -- Seed cancelled-event keys from trade history ----------------------------
  // If any past trade resolved via scalar settlement, block that event date
  // to prevent trading sibling/rescheduled markets for the same match.
  {
    const pastTrades = loadArbTrades();
    const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
    const checkedTickers = new Set<string>();
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
    for (const t of pastTrades) {
      if (!t.kalTicker) continue;
      if (checkedTickers.has(t.kalTicker)) continue;
      // Only check recent trades to avoid excessive API calls at startup
      const tradeTime = new Date(t.ts).getTime();
      if (tradeTime < recentCutoff) continue;
      // Check resolved + filled trades -- both could be on scalar-settled markets
      if (t.status === "resolved" || t.status === "filled") {
        checkedTickers.add(t.kalTicker);
        try {
          const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${t.kalTicker}`);
          const mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
          if (isScalarSettlement(mkt)) {
            _cancelledTickers.add(t.kalTicker);
            _cancelledEventKeys.add(extractEventDateKey(t.kalTicker));
            console.log(`[STARTUP] Flagged cancelled event: ${t.kalTicker} -> key="${extractEventDateKey(t.kalTicker)}"`);
          }
        } catch {
          // Market may be delisted -- that's also a cancellation signal
        }
      }
    }
    if (_cancelledEventKeys.size > 0) {
      console.log(`[STARTUP] ${_cancelledEventKeys.size} cancelled event key(s): ${[..._cancelledEventKeys].join(", ")}`);
    }
  }

  while (true) {
    const cycleStart = Date.now();
    cycle++;

    // -- MID-SESSION RECOVERY: pick up auto-recovered trades from reconciliation --
    // reconcilePositions may create "hedging" trades mid-session. Without this,
    // they'd sit in arb_trades.json doing nothing until the next restart.
    if (_reconcileRecoveredTrades) {
      _reconcileRecoveredTrades = false;
      const hsTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
      const freshTrades = loadArbTrades();
      const newHedging = freshTrades.filter(t => t.status === "hedging" && !hsTickers.has(t.kalTicker));
      if (newHedging.length > 0) {
        // Build kalTicker -> watchlist lookup
        const kalTickerToWatch = new Map<string, { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg }>();
        for (const entry of watchlist) {
          kalTickerToWatch.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm1 });
          kalTickerToWatch.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm2 });
          if (entry.kal3 && entry.pm3) {
            kalTickerToWatch.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
          }
        }
        for (const t of newHedging) {
          const wm = kalTickerToWatch.get(t.kalTicker);
          if (!wm) {
            console.warn(`[RECONCILE->HEDGE] Recovered trade ${t.id} (${t.kalTicker}) not in watchlist -- cannot start hedge.`);
            continue;
          }
          const kalNoSideDirs = new Set(["C", "D", "G", "H", "I"]);
          const kalSide: "yes" | "no" = kalNoSideDirs.has(t.dir) ? "no" : "yes";
          const heldExchange = t.initialExchange ?? (t.pmCost > 0 && t.kalCost === 0 ? "pm" : "kal");
          const entry = wm.entry;
          let pmLeg: PmLeg = wm.pmLeg;
          let pmOppLeg: PmLeg | null = null;
          const is3WayDir = "GHIJKL".includes(t.dir);
          if (!is3WayDir) {
            if (t.dir === "A" || t.dir === "D") { pmLeg = entry.pm2; pmOppLeg = entry.pm1; }
            else if (t.dir === "B" || t.dir === "C") { pmLeg = entry.pm1; pmOppLeg = entry.pm2; }
          }
          if (t.pmTokenId) {
            for (const leg of [entry.pm1, entry.pm2, entry.pm3].filter(Boolean) as PmLeg[]) {
              if (leg.tokenId === t.pmTokenId || leg.noTokenId === t.pmTokenId) {
                if (leg.noTokenId === t.pmTokenId) {
                  pmLeg = { ...leg, tokenId: leg.noTokenId, outcome: `${leg.outcome} [NO]` };
                } else {
                  pmLeg = leg;
                }
                break;
              }
            }
          }
          const costBasis = heldExchange === "pm"
            ? (t.pmFillPrice > 0 ? t.pmFillPrice : t.pmCost / Math.max(t.shares, 1))
            : (t.kalFillPrice > 0 ? t.kalFillPrice : t.kalCost / Math.max(t.shares, 1));
          const kalFeePerShare = (t.kalFees ?? 0) / Math.max(t.shares, 1);
          const newHs: HedgeState = {
            position: {
              tradeId: t.id,
              heldExchange,
              pmLeg,
              pmOppLeg: heldExchange === "pm" ? pmOppLeg : null,
              pmCostBasis: heldExchange === "pm" ? costBasis : 0,
              kalLeg: wm.kalLeg,
              kalCostBasis: heldExchange === "kal" ? costBasis + kalFeePerShare : 0,
              kalSide,
              sharesHeld: t.shares,
              initialShares: t.shares,
              initialCost: heldExchange === "pm" ? t.pmCost : t.kalCost,
              hedgeFillCost: 0,
              hedgeFillCostKal: 0,
              hedgeFillCostPm: 0,
              kalFees: t.kalFees ?? 0,
              initialKalFees: heldExchange === "kal" ? (t.kalFees ?? 0) : 0,
            },
            activeOrders: new Map(),
            kalNextRetryAt: 0,
            pmOnlyCycles: 0,
          };
          hedgeStates.push(newHs);
          hsTickers.add(t.kalTicker);
          console.log(
            `\n[RECONCILE->HEDGE] Picked up recovered trade: ${t.match} dir=${t.dir} kalSide=${kalSide}` +
            ` held=${heldExchange} shares=${t.shares} ticker=${t.kalTicker}\n`
          );
        }
        _allHedgeStates = hedgeStates;
        saveHedgeStates(hedgeStates);
      }
    }

    // -- HEDGE CHECK: process unhedged positions, then CONTINUE to arb scanning --
    // Hedge orders are GTC -- they rest on the book. We only need to:
    //  1) Place orders that aren't placed yet (first cycle after detection)
    //  2) Check fills periodically (~every 10s, not every 400ms cycle)
    // Normal arb scanning ALWAYS runs regardless of hedge state.
    if (hedgeStates.length > 0) {
      const allOrdersPlaced = hedgeStates.every(hs => hs.activeOrders.size > 0);
      const hedgeCheckInterval = allOrdersPlaced ? 25 : 1; // 25 cycles ≈ 10s once orders are placed

      if (cycle % hedgeCheckInterval === 0) {
        for (const hs of hedgeStates) {
          await runHedgeCycle(hs, clobBase);
        }

        // Remove resolved positions
        const beforeLen = hedgeStates.length;
        hedgeStates = hedgeStates.filter(hs => {
          if (hs.position.sharesHeld <= 0) {
            const p = hs.position;
            const name = p.heldExchange === "pm" ? p.pmLeg.outcome : p.kalLeg.ticker;

            if (p.hedgeFillCost > 0) {
              // Genuine hedge-complete: both legs filled -> guaranteed $1/share payout.
              const isPmInitial = p.heldExchange === "pm";
              // initialCost already includes initial Kalshi fees for KAL-held positions.
              // For KAL-held, add hedge fees separately (kalFees - initialKalFees).
              const hedgeKalFees = Math.max(0, p.kalFees - p.initialKalFees);
              // Keep per-exchange costs SEPARATE: pmCost = only initial PM cost,
              // kalCost = only initial KAL cost. hedgeCost is tracked independently.
              // totalCost = kalCost + pmCost (the two initial legs, no double-counting).
              const kalCostR = isPmInitial
                ? Math.round((p.hedgeFillCostKal + p.kalFees) * 100) / 100
                : Math.round((p.initialCost + p.hedgeFillCostKal + hedgeKalFees) * 100) / 100;
              const pmCostR = isPmInitial
                ? Math.round(p.initialCost * 100) / 100
                : Math.round(p.hedgeFillCostPm * 100) / 100;
              const totalCost = Math.round((kalCostR + pmCostR) * 100) / 100;
              const payout = p.initialShares;
              const realizedPnl = Math.round((payout - totalCost) * 100) / 100;
              console.log(
                `\n[HEDGE] ${name} resolved! initialCost=$${p.initialCost.toFixed(2)}` +
                ` hedgeCost=$${p.hedgeFillCost.toFixed(2)} kalFees=$${p.kalFees.toFixed(2)}` +
                ` total=$${totalCost.toFixed(2)} payout=$${payout.toFixed(2)} P&L=$${realizedPnl.toFixed(2)}`
              );
              const pmFillPriceR = isPmInitial
                ? p.pmCostBasis
                : (p.hedgeFillCostPm > 0 ? Math.round((p.hedgeFillCostPm / p.initialShares) * 100) / 100 : 0);
              resolveArbTrade(p.kalLeg.ticker, {
                status: "resolved",
                resolvedTs: new Date().toISOString(),
                resolutionMethod: "hedge-complete",
                totalCost,
                hedgeCost: p.hedgeFillCost,
                kalFees: p.kalFees,
                realizedPnl,
                initialExchange: p.heldExchange,
                kalFillPrice: kalCostR > 0
                  ? Math.round(((kalCostR - p.kalFees) / p.initialShares) * 100) / 100
                  : 0,
                kalCost: kalCostR,
                pmFillPrice: pmFillPriceR,
                pmCost: pmCostR,
              }, p.tradeId);
              // Fire-and-forget: audit Kalshi fills for untracked buys (race condition detection)
              postResolutionFillAudit(p.kalLeg.ticker, p.tradeId).catch(() => {});
            } else {
              // Position resolved without hedge (market settled while unhedged).
              // The settlement path in runHedgeCycle already called resolveArbTrade
              // with correct P&L. Just log removal -- don't double-resolve.
              console.log(`\n[HEDGE] ${name} cleared (settled without hedge).`);
            }
            const resolvedTokenId = p.pmLeg.tokenId;
            const resolvedEntry = watchlist.find(
              e => e.pm1.tokenId === resolvedTokenId || e.pm2.tokenId === resolvedTokenId
            );
            if (resolvedEntry) {
              sessionSkipSet.add(resolvedEntry.matchCode);
            }
            return false;
          }
          return true;
        });

        if (hedgeStates.length < beforeLen) {
          _allHedgeStates = hedgeStates;
          saveHedgeStates(hedgeStates);
        }
      }
      // Fall through to normal arb scanning -- don't block!
    }

    // -- CANCELLATION MONITOR: detect scalar settlements & emergency-sell PM --
    // Runs every 60s. Checks Kalshi market status for all open positions.
    // If a market settled as "scalar" (cancelled/voided), immediately sells PM tokens.
    try {
      await runCancellationMonitor(watchlist, hedgeStates, clobBase);
    } catch (err) {
      console.warn(`[CANC-MON] Monitor error: ${(err as Error).message}`);
    }

    // -- 1. Refresh Kalshi prices: WS primary, REST every 30 cycles (~12s) --
    // WS gives real-time best ask; REST is only needed for markets without WS data
    // or as a periodic fallback to catch any WS drift.
    let wsKalHits = 0;
    for (const e of watchlist) {
      const ws1Yes = getWsKalBestAsk(e.kal1.ticker, "yes");
      const ws1No  = getWsKalBestAsk(e.kal1.ticker, "no");
      const ws2Yes = getWsKalBestAsk(e.kal2.ticker, "yes");
      const ws2No  = getWsKalBestAsk(e.kal2.ticker, "no");
      if (ws1Yes !== null) { e.kal1.yesAsk = ws1Yes; wsKalHits++; }
      if (ws1No  !== null) { e.kal1.noAsk  = ws1No;  wsKalHits++; }
      if (ws2Yes !== null) { e.kal2.yesAsk = ws2Yes; wsKalHits++; }
      if (ws2No  !== null) { e.kal2.noAsk  = ws2No;  wsKalHits++; }
    }
    // Only call REST if WS is missing data for >50% of prices, or every 30 cycles
    const kalWsCoverage = wsKalHits / (watchlist.length * 4);
    if (kalWsCoverage < 0.5 || cycle % 30 === 0) {
      await refreshKalshiPrices(watchlist);
      // Re-overlay WS on top of REST (WS is more current)
      for (const e of watchlist) {
        const ws1Yes = getWsKalBestAsk(e.kal1.ticker, "yes");
        const ws1No  = getWsKalBestAsk(e.kal1.ticker, "no");
        const ws2Yes = getWsKalBestAsk(e.kal2.ticker, "yes");
        const ws2No  = getWsKalBestAsk(e.kal2.ticker, "no");
        if (ws1Yes !== null) e.kal1.yesAsk = ws1Yes;
        if (ws1No  !== null) e.kal1.noAsk  = ws1No;
        if (ws2Yes !== null) e.kal2.yesAsk = ws2Yes;
        if (ws2No  !== null) e.kal2.noAsk  = ws2No;
      }
    }

    // -- 2. Fetch PM prices + compute edges --------------------------------
    let bestEdge = -Infinity;
    let bestEntry: WatchEntry | null = null;
    let bestDir: ArbDir = "A";
    let bestKalAsk = 0;
    let bestPmAsk = 0;

    const statusLines: string[] = [];

    // Build a set of matchCodes with active hedge positions -- never arb these
    const hedgingMatchCodes = new Set<string>();
    for (const hs of hedgeStates) {
      const t = hs.position.kalLeg.ticker;
      for (const e of watchlist) {
        if (e.kal1.ticker === t || e.kal2.ticker === t) { hedgingMatchCodes.add(e.matchCode); break; }
      }
    }

    // -- Pre-fetch ALL PM prices: WS first, REST fallback ----------------------
    const activePairs = watchlist.filter(
      e => !sessionSkipSet.has(e.matchCode) && !hedgingMatchCodes.has(e.matchCode) &&
        !(abortCountMap.has(e.matchCode) && Date.now() < (abortCountMap.get(e.matchCode)!.cooldownUntil))
    );
    const pmPriceMap = new Map<string, number>();
    const restNeeded: { tid: string }[] = [];
    for (const e of activePairs) {
      const tids = [e.pm1.tokenId, e.pm2.tokenId];
      if (e.pm3) tids.push(e.pm3.tokenId);
      // Include NO tokens for soccer J/K/L dirs
      if (e.pm1.noTokenId) tids.push(e.pm1.noTokenId);
      if (e.pm2.noTokenId) tids.push(e.pm2.noTokenId);
      if (e.pm3?.noTokenId) tids.push(e.pm3.noTokenId);
      for (const tid of tids) {
        const wsPrice = getWsPmBestAsk(tid);
        if (wsPrice !== null) {
          pmPriceMap.set(tid, wsPrice);
        } else {
          restNeeded.push({ tid });
        }
      }
    }
    // REST fallback for tokens without WS data
    if (restNeeded.length > 0) {
      const PM_BATCH_SIZE = 20;
      for (let i = 0; i < restNeeded.length; i += PM_BATCH_SIZE) {
        const batch = restNeeded.slice(i, i + PM_BATCH_SIZE);
        const results = await Promise.all(
          batch.map(({ tid }) => fetchPmAskDirect(tid, clobBase).then(p => ({ tid, p })))
        );
        for (const { tid, p } of results) {
          if (p !== null) pmPriceMap.set(tid, p);
        }
      }
    }

    for (const entry of watchlist) {
      if (sessionSkipSet.has(entry.matchCode)) {
        statusLines.push(`  ${entry.kal1.surname} vs ${entry.kal2.surname}  [session-skip]`);
        continue;
      }

      if (hedgingMatchCodes.has(entry.matchCode)) {
        statusLines.push(`  ${entry.kal1.surname} vs ${entry.kal2.surname}  [hedging]`);
        continue;
      }

      // Abort cooldown: skip match if it aborted 10+ times consecutively
      const abortInfo = abortCountMap.get(entry.matchCode);
      if (abortInfo && Date.now() < abortInfo.cooldownUntil) {
        const secsLeft = Math.ceil((abortInfo.cooldownUntil - Date.now()) / 1000);
        statusLines.push(`  ${entry.kal1.surname} vs ${entry.kal2.surname}  [abort-cooldown ${secsLeft}s]`);
        continue;
      }

      const lastAttempt = cooldownMap.get(entry.matchCode) ?? 0;
      // Also check per-ticker and per-slug cooldown -- prevents firing same Kalshi market
      // or same PM market from different watchlist entries (e.g. GAME vs MAP entries)
      const kalTicker1Cd = kalTickerCooldown.get(entry.kal1.ticker) ?? 0;
      const kalTicker2Cd = kalTickerCooldown.get(entry.kal2.ticker) ?? 0;
      const kalTicker3Cd = entry.kal3 ? (kalTickerCooldown.get(entry.kal3.ticker) ?? 0) : 0;
      const pmSlugCd = pmSlugCooldown.get(entry.pmSlug) ?? 0;
      const onCooldown = Date.now() - lastAttempt < TRADE_COOLDOWN_MS ||
        Date.now() - kalTicker1Cd < TRADE_COOLDOWN_MS ||
        Date.now() - kalTicker2Cd < TRADE_COOLDOWN_MS ||
        (entry.kal3 && Date.now() - kalTicker3Cd < TRADE_COOLDOWN_MS) ||
        Date.now() - pmSlugCd < TRADE_COOLDOWN_MS;

      const pm1Ask = pmPriceMap.get(entry.pm1.tokenId) ?? null;
      const pm2Ask = pmPriceMap.get(entry.pm2.tokenId) ?? null;

      if (pm1Ask === null || pm2Ask === null) continue;

      // -- Coin-flip detection: PM asks ~50/50 -> suspicious pricing, skip arb --
      // If both asks are 48-52c the market is priced as a coin-flip.
      // Fetch bids via WS first, REST fallback if WS unavailable.
      {
        const isCoinFlipAsk = (ask: number) => ask >= 0.48 && ask <= 0.52;
        if (isCoinFlipAsk(pm1Ask) && isCoinFlipAsk(pm2Ask)) {
          let bid1 = getWsPmBestBid(entry.pm1.tokenId);
          let bid2 = getWsPmBestBid(entry.pm2.tokenId);
          // REST fallback for bids when WS has no data
          if (bid1 === null) bid1 = await fetchPmBidDirect(entry.pm1.tokenId, clobBase);
          if (bid2 === null) bid2 = await fetchPmBidDirect(entry.pm2.tokenId, clobBase);
          if (!coinFlipWarned.has(entry.matchCode)) {
            coinFlipWarned.add(entry.matchCode);
            console.warn(
              `[COIN-FLIP] ${entry.kal1.surname} vs ${entry.kal2.surname} -- ` +
              `PM pricing ~50/50 (asks: ${fmtPct(pm1Ask)}/${fmtPct(pm2Ask)}, ` +
              `bids: ${bid1 !== null ? fmtPct(bid1) : "?"}/${bid2 !== null ? fmtPct(bid2) : "?"}) ` +
              `KAL: ${fmtPct(entry.kal1.yesAsk)}/${fmtPct(entry.kal2.yesAsk)} -- ` +
              `check manually! Skipping arb.`
            );
          }
          continue;
        }
      }

      // Realistic edge helper: if WS orderbook available, compute avg fill for min shares.
      // Returns actual edge (may be negative), or null if WS data is unavailable.
      // IMPORTANT: null = "no WS data, trust listing price". A numeric return = "WS has real depth data".
      const realisticEdge = (ticker: string, side: "yes" | "no", pmAskVal: number, minShares: number): number | null => {
        const book = getWsKalBook(ticker);
        if (!book) return null;  // no WS data -> can't verify, let listing price stand
        const askLevels = side === "yes" ? deriveYesAsks(book.no) : deriveNoAsks(book.yes);
        if (askLevels.length === 0) return -1;  // WS confirms zero depth -> kill the edge
        const limitCents = Math.max(1, Math.min(99, Math.floor((1 - pmAskVal - MIN_EDGE) * 100)));
        const sweep = sweepKalshiDepth(askLevels, minShares, limitCents);
        if (!sweep || sweep.totalQty < minShares) return -1;  // insufficient depth at profitable prices
        const avgPrice = sweep.avgPrice / 100;
        return 1 - avgPrice - pmAskVal - estimateFees(avgPrice, pmAskVal);
      };
      const pmMin1 = Math.max(entry.pm1.minSize ?? 5, pm1Ask > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pm1Ask) : 5);
      const pmMin2 = Math.max(entry.pm2.minSize ?? 5, pm2Ask > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pm2Ask) : 5);

      let edges: { dir: ArbDir; edge: number; kalAsk: number; pmAsk: number }[];

      if (entry.is3Way && entry.kal3 && entry.pm3) {
        // -- Soccer 3-way: 12 directions --------------------------------------
        // Notation: KH/KD/KA = Kalshi Home/Draw/Away yesAsk
        //           PH/PD/PA = PM Home/Draw/Away ask
        //           KH_no/KD_no/KA_no = Kalshi Home/Draw/Away noAsk
        const pm3Ask = pmPriceMap.get(entry.pm3.tokenId) ?? null;
        if (pm3Ask === null) continue;
        const KH = entry.kal1.yesAsk, KA = entry.kal2.yesAsk, KD = entry.kal3.yesAsk;
        const KH_no = entry.kal1.noAsk, KA_no = entry.kal2.noAsk, KD_no = entry.kal3.noAsk;
        const PH = pm1Ask, PA = pm2Ask, PD = pm3Ask;
        const pmMin3 = Math.max(entry.pm3.minSize ?? 5, PD > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / PD) : 5);

        // 3-leg YES combos (A-F): buy YES on all 3 outcomes across platforms
        // These require 3 orders to execute -- not yet supported by executeArb
        const feeA3 = estimateFees(KH, 0) + estimateFees(KD, 0); // KAL fees only (PM has 0% on soccer currently)
        const feeB3 = estimateFees(KH, 0) + estimateFees(KA, 0);
        const feeC3 = estimateFees(KD, 0) + estimateFees(KA, 0);
        let eA = 1 - KH - KD - PA - feeA3;  // A: KAL Home + KAL Draw + PM Away
        let eB = 1 - KH - PD - KA - feeB3;  // B: KAL Home + PM Draw + KAL Away
        let eC = 1 - PH - KD - KA - feeC3;  // C: PM Home + KAL Draw + KAL Away
        let eD = 1 - KH - PD - PA;           // D: KAL Home + PM Draw + PM Away
        let eE = 1 - PH - KD - PA;           // E: PM Home + KAL Draw + PM Away
        let eF = 1 - PH - PD - KA;           // F: PM Home + PM Draw + KAL Away
        // Apply KAL fee for single-KAL-leg dirs
        eD -= estimateFees(KH, 0); eE -= estimateFees(KD, 0); eF -= estimateFees(KA, 0);

        // 2-leg NO combos (G-L): buy NO on one outcome + YES on same outcome on other platform
        // These are executable with existing executeArb (2 legs, same as tennis C/D)
        let eG = 1 - KH_no - PH - estimateFees(KH_no, PH);  // G: KAL Home NO + PM Home YES
        let eH = 1 - KD_no - PD - estimateFees(KD_no, PD);  // H: KAL Draw NO + PM Draw YES
        let eI = 1 - KA_no - PA - estimateFees(KA_no, PA);  // I: KAL Away NO + PM Away YES
        // J/K/L: KAL YES + PM NO on same outcome -- use real PM NO token ask prices
        const PH_no = entry.pm1.noTokenId ? (pmPriceMap.get(entry.pm1.noTokenId) ?? null) : null;
        const PA_no = entry.pm2.noTokenId ? (pmPriceMap.get(entry.pm2.noTokenId) ?? null) : null;
        const PD_no = entry.pm3.noTokenId ? (pmPriceMap.get(entry.pm3.noTokenId) ?? null) : null;
        let eJ = PH_no !== null ? 1 - KH - PH_no - estimateFees(KH, 0) : -Infinity;  // J: KAL Home YES + PM Home NO
        let eK = PD_no !== null ? 1 - KD - PD_no - estimateFees(KD, 0) : -Infinity;  // K: KAL Draw YES + PM Draw NO
        let eL = PA_no !== null ? 1 - KA - PA_no - estimateFees(KA, 0) : -Infinity;  // L: KAL Away YES + PM Away NO

        // Realistic edge for G/H/I (2-leg NO: Kalshi NO side)
        if (eG > 0) { const re = realisticEdge(entry.kal1.ticker, "no", PH, pmMin1); if (re !== null) eG = re; }
        if (eH > 0) { const re = realisticEdge(entry.kal3.ticker, "no", PD, pmMin3); if (re !== null) eH = re; }
        if (eI > 0) { const re = realisticEdge(entry.kal2.ticker, "no", PA, pmMin2); if (re !== null) eI = re; }
        // Realistic edge for J/K/L (2-leg NO: PM NO side)
        if (eJ > 0 && PH_no !== null) { const re = realisticEdge(entry.kal1.ticker, "yes", PH_no, pmMin1); if (re !== null) eJ = re; }
        if (eK > 0 && PD_no !== null) { const re = realisticEdge(entry.kal3.ticker, "yes", PD_no, pmMin3); if (re !== null) eK = re; }
        if (eL > 0 && PA_no !== null) { const re = realisticEdge(entry.kal2.ticker, "yes", PA_no, pmMin2); if (re !== null) eL = re; }

        edges = [
          { dir: "A", edge: eA, kalAsk: KH, pmAsk: PA },   // 3-leg
          { dir: "B", edge: eB, kalAsk: KH, pmAsk: PD },
          { dir: "C", edge: eC, kalAsk: KD, pmAsk: PH },
          { dir: "D", edge: eD, kalAsk: KH, pmAsk: PA },
          { dir: "E", edge: eE, kalAsk: KD, pmAsk: PA },
          { dir: "F", edge: eF, kalAsk: KA, pmAsk: PH },
          { dir: "G", edge: eG, kalAsk: KH_no, pmAsk: PH },           // 2-leg KAL NO
          { dir: "H", edge: eH, kalAsk: KD_no, pmAsk: PD },
          { dir: "I", edge: eI, kalAsk: KA_no, pmAsk: PA },
          { dir: "J", edge: eJ, kalAsk: KH, pmAsk: PH_no ?? 0 },      // 2-leg PM NO
          { dir: "K", edge: eK, kalAsk: KD, pmAsk: PD_no ?? 0 },
          { dir: "L", edge: eL, kalAsk: KA, pmAsk: PA_no ?? 0 },
        ];

        const bestLocalEdge = edges.reduce((a, b) => b.edge > a.edge ? b : a);
        const bestLocal = bestLocalEdge.edge;
        const coolStr = onCooldown ? " [cooldown]" : "";

        // Show best of each group in status line
        const best3Leg = Math.max(eA, eB, eC, eD, eE, eF);
        statusLines.push(
          `  ${entry.kal1.surname} vs ${entry.kal2.surname} [3WAY]` +
          `  3leg:${fmtPct(best3Leg)}  G:${fmtPct(eG)} H:${fmtPct(eH)} I:${fmtPct(eI)}` +
          `  J:${fmtPct(eJ)} K:${fmtPct(eK)} L:${fmtPct(eL)}` +
          (bestLocal > 0 ? " *** ARB ***" : "") + coolStr
        );

        // All 12 dirs executable: A-F (3-leg YES) + G-I (KAL NO) + J-L (PM NO)
        const executableEdges = edges;
        const bestExec = executableEdges.reduce((a, b) => b.edge > a.edge ? b : a);
        if (!onCooldown && bestExec.edge > bestEdge) {
          bestEdge = bestExec.edge;
          bestEntry = entry;
          bestDir = bestExec.dir;
          bestKalAsk = bestExec.kalAsk;
          bestPmAsk = bestExec.pmAsk;
        }
      } else if (entry.isBinary) {
        // -- Binary (non-moneyline): single-ticker, only dirs A and C are valid arbs --
        // Dir A: buy KAL YES + PM outcome2 (opposing) -> guaranteed $1
        // Dir C: buy KAL NO + PM outcome1 (matching) -> guaranteed $1
        // Dirs B/D are INVALID: they bet same outcome on both sides (directional, not arb)
        const rawEdgeA = 1 - entry.kal1.yesAsk - pm2Ask;
        const rawEdgeC = 1 - entry.kal1.noAsk - pm1Ask;
        let edgeA = rawEdgeA - estimateFees(entry.kal1.yesAsk, pm2Ask);
        let edgeC = rawEdgeC - estimateFees(entry.kal1.noAsk, pm1Ask);

        if (edgeA > 0) { const re = realisticEdge(entry.kal1.ticker, "yes", pm2Ask, pmMin2); if (re !== null) edgeA = re; }
        if (edgeC > 0) { const re = realisticEdge(entry.kal1.ticker, "no", pm1Ask, pmMin1); if (re !== null) edgeC = re; }

        edges = [
          { dir: "A", edge: edgeA, kalAsk: entry.kal1.yesAsk, pmAsk: pm2Ask },
          { dir: "C", edge: edgeC, kalAsk: entry.kal1.noAsk,  pmAsk: pm1Ask },
        ];
        const bestLocalEdge = edges.reduce((a, b) => b.edge > a.edge ? b : a);
        const bestLocal = bestLocalEdge.edge;
        const coolStr = onCooldown ? " [cooldown]" : "";

        statusLines.push(
          `  [BIN] ${entry.kal1.surname} vs ${entry.kal2.surname} (${entry.pmSlug.split("-").slice(-3).join("-")})` +
          `  A:${fmtPct(edgeA)}  C:${fmtPct(edgeC)}` +
          (bestLocal > 0 ? " *** ARB ***" : "") + coolStr
        );

        if (!onCooldown && bestLocal > bestEdge) {
          bestEdge = bestLocal;
          bestEntry = entry;
          bestDir = bestLocalEdge.dir;
          bestKalAsk = bestLocalEdge.kalAsk;
          bestPmAsk = bestLocalEdge.pmAsk;
        }

      } else {
        // -- Standard 2-way: tennis/NBA/esports (4 directions A-D) ----------
        const rawEdgeA = 1 - entry.kal1.yesAsk - pm2Ask;
        const rawEdgeB = 1 - entry.kal2.yesAsk - pm1Ask;
        const rawEdgeC = 1 - entry.kal1.noAsk - pm1Ask;
        const rawEdgeD = 1 - entry.kal2.noAsk - pm2Ask;
        let edgeA = rawEdgeA - estimateFees(entry.kal1.yesAsk, pm2Ask);
        let edgeB = rawEdgeB - estimateFees(entry.kal2.yesAsk, pm1Ask);
        let edgeC = rawEdgeC - estimateFees(entry.kal1.noAsk, pm1Ask);
        let edgeD = rawEdgeD - estimateFees(entry.kal2.noAsk, pm2Ask);

        if (edgeA > 0) { const re = realisticEdge(entry.kal1.ticker, "yes", pm2Ask, pmMin2); if (re !== null) edgeA = re; }
        if (edgeB > 0) { const re = realisticEdge(entry.kal2.ticker, "yes", pm1Ask, pmMin1); if (re !== null) edgeB = re; }
        if (edgeC > 0) { const re = realisticEdge(entry.kal1.ticker, "no", pm1Ask, pmMin1); if (re !== null) edgeC = re; }
        if (edgeD > 0) { const re = realisticEdge(entry.kal2.ticker, "no", pm2Ask, pmMin2); if (re !== null) edgeD = re; }

        edges = [
          { dir: "A", edge: edgeA, kalAsk: entry.kal1.yesAsk, pmAsk: pm2Ask },
          { dir: "B", edge: edgeB, kalAsk: entry.kal2.yesAsk, pmAsk: pm1Ask },
          { dir: "C", edge: edgeC, kalAsk: entry.kal1.noAsk,  pmAsk: pm1Ask },
          { dir: "D", edge: edgeD, kalAsk: entry.kal2.noAsk,  pmAsk: pm2Ask },
        ];
        const bestLocalEdge = edges.reduce((a, b) => b.edge > a.edge ? b : a);
        const bestLocal = bestLocalEdge.edge;
        const coolStr = onCooldown ? " [cooldown]" : "";

        statusLines.push(
          `  ${entry.kal1.surname} vs ${entry.kal2.surname}` +
          `  A:${fmtPct(edgeA)}  B:${fmtPct(edgeB)}  C:${fmtPct(edgeC)}  D:${fmtPct(edgeD)}` +
          (bestLocal > 0 ? " *** ARB ***" : "") + coolStr
        );

        if (!onCooldown && bestLocal > bestEdge) {
          bestEdge = bestLocal;
          bestEntry = entry;
          bestDir = bestLocalEdge.dir;
          bestKalAsk = bestLocalEdge.kalAsk;
          bestPmAsk = bestLocalEdge.pmAsk;
        }
      }
    }

    // -- 2b. Speculative orderbook pre-cache for top candidate --------------
    // Skip if WS already has live data for this ticker
    if (bestEntry && bestEdge > MIN_EDGE * 0.5) {
      const targetTicker = (bestDir === "A" || bestDir === "C") ? bestEntry.kal1.ticker : bestEntry.kal2.ticker;
      if (!getWsKalBook(targetTicker)) {
        const cached = kalBookCache.get(targetTicker);
        if (!cached || Date.now() - cached.ts > BOOK_CACHE_TTL) {
          fetchKalshiOrderbook(targetTicker)
            .then(book => kalBookCache.set(targetTicker, { book, ts: Date.now() }))
            .catch(() => {}); // non-critical, fire-and-forget
        }
      }
    }

    // -- 3. Status line -----------------------------------------------------
    process.stdout.write(
      `\r${ts()} cycle=${cycle}  best=${fmtPct(bestEdge)}` +
      (bestEntry ? `  [${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}]` : "") +
      "   "
    );

    if (cycle % 10 === 0) {
      // Only show matches with positive edge or special status (hedging, cooldown, etc.)
      const interestingLines = statusLines.filter(l =>
        l.includes("*** ARB ***") || l.includes("[hedging]") ||
        l.includes("[cooldown]") || l.includes("[abort-cooldown") ||
        l.includes("[session-skip]")
      );
      if (interestingLines.length > 0) {
        console.log(`\n[CYCLE ${cycle}] ${ts()}  (${statusLines.length} matches, ${interestingLines.length} notable)`);
        interestingLines.forEach((l) => console.log(l));
      }
      // WS diagnostics every 50 cycles
      if (cycle % 50 === 0) {
        const pmWsTokens = wsPmBooks.size;
        let pmWsFresh = 0, pmWsStale = 0, pmWsWithAsks = 0;
        for (const [, b] of wsPmBooks) {
          if (Date.now() - b.ts < 30_000) { pmWsFresh++; if (b.asks.size > 0) pmWsWithAsks++; }
          else pmWsStale++;
        }
        const kalWsTickers = wsKalBooks.size;
        let kalWsFresh = 0;
        for (const [, b] of wsKalBooks) { if (Date.now() - b.ts < 600_000) kalWsFresh++; }
        console.log(`[WS DIAG] KAL: ${kalWsFresh}/${kalWsTickers} fresh | PM: ${pmWsFresh}/${pmWsTokens} fresh, ${pmWsWithAsks} with asks, ${pmWsStale} stale | PM connected=${_pmWsReady} subs=${_pmWsSubs.size}`);
      }
    }

    // -- 4. Execute if edge >= threshold -------------------------------------
    if (bestEntry && bestEdge >= MIN_EDGE) {
      console.log(); // newline from \r
      console.log(
        `[ARB FOUND] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}` +
        `  dir=${bestDir}  edge=${fmtPct(bestEdge, 2)}` +
        `  kalTicker=${(bestDir === "A" || bestDir === "C") ? bestEntry.kal1.ticker : bestEntry.kal2.ticker}` +
        `  pmSlug=${bestEntry.pmSlug}` +
        `  kalAsk=${fmtPct(bestKalAsk)}  pmAsk=${fmtPct(bestPmAsk)}`
      );

      // Helper: log a skipped-arb metric so it shows on the dashboard's missed-opps
      const logSkippedArb = (reason: string) => {
        const m: ExecMetric = {
          id: `exec-${Date.now()}`, ts: new Date().toISOString(),
          match: `${bestEntry!.kal1.surname} vs ${bestEntry!.kal2.surname}`,
          dir: bestDir, edge: bestEdge, shares: Math.floor(TRADE_USD / (bestKalAsk + bestPmAsk)),
          firstLeg: "pm", outcome: "abort-safety", failReason: reason,
          firstLegFilled: 0, secondLegFilled: 0,
          expectedKalPrice: bestKalAsk, expectedPmPrice: bestPmAsk,
          totalMs: 0, firstLegOrderMs: 0, firstLegConfirmMs: 0,
          secondLegOrderMs: 0, secondLegConfirmMs: 0, bookFetchMs: 0,
        };
        appendMetric(m);
      };

      // -- Circuit breaker checks ------------------------------------------
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn(`[CIRCUIT BREAKER] ${consecutiveErrors} consecutive errors -- pausing new arbs until next cycle without error.`);
        logSkippedArb("circuit-breaker-errors");
      } else if (hedgeStates.length >= MAX_HEDGE_POSITIONS) {
        console.warn(`[CIRCUIT BREAKER] ${hedgeStates.length} open hedge positions (max ${MAX_HEDGE_POSITIONS}) -- resolve existing before opening new.`);
        logSkippedArb("max-hedge-positions");
      } else if (isPmServiceDown()) {
        const waitSec = Math.ceil((pmServiceDownUntil - Date.now()) / 1000);
        console.warn(`[ARB SKIP] PM service down -- retrying in ~${waitSec}s`);
        logSkippedArb("pm-service-down");
      } else if (inflight.has(bestEntry.matchCode)) {
        console.warn(`[ARB SKIP] ${bestEntry.matchCode} already in-flight.`);
        logSkippedArb("already-inflight");
      } else if (isLateGame(bestEntry.matchCode)) {
        const ls = getMatchState(bestEntry.matchCode);
        console.warn(`[ARB SKIP] ${bestEntry.matchCode} -- late game (${ls?.detail ?? "?"}, ${ls?.completionPct?.toFixed(0) ?? "?"}% complete, ${ls?.homeScore ?? "?"}-${ls?.awayScore ?? "?"})`);
        logSkippedArb("late-game");
      } else if (isMatchCancelled(bestEntry.matchCode)) {
        const ls = getMatchState(bestEntry.matchCode);
        console.warn(`[ARB SKIP] ${bestEntry.matchCode} -- ${ls?.status?.toUpperCase() ?? "CANCELLED"} (${ls?.detail ?? "?"}). Scalar settlement risk.`);
        logSkippedArb("match-cancelled");
      } else if (process.env.LICENSE_SERVER && !isLicenseValid()) {
        console.warn(`[ARB SKIP] License invalid -- skipping new arbs until revalidated`);
        logSkippedArb("license-invalid");
      } else {

      // Mark cooldown BEFORE executing -- prevents re-entry during execution
      cooldownMap.set(bestEntry.matchCode, Date.now());
      kalTickerCooldown.set(bestEntry.kal1.ticker, Date.now());
      kalTickerCooldown.set(bestEntry.kal2.ticker, Date.now());
      if (bestEntry.kal3) kalTickerCooldown.set(bestEntry.kal3.ticker, Date.now());
      pmSlugCooldown.set(bestEntry.pmSlug, Date.now());
      inflight.add(bestEntry.matchCode);

      // -- Start continuous book tracker (20s, 500ms intervals) ------------
      {
        const trackKalTicker = (bestDir === "A" || bestDir === "C") ? bestEntry.kal1.ticker
          : (bestDir === "H" || bestDir === "K") ? bestEntry.kal3!.ticker
          : bestEntry.kal2.ticker;
        const trackPmLeg = (bestDir === "A" || bestDir === "D") ? bestEntry.pm2
          : (bestDir === "H") ? bestEntry.pm3!
          : (bestDir === "K") ? bestEntry.pm3!
          : bestEntry.pm1;
        const trackTs = Date.now();
        startBookTracker(trackKalTicker, trackPmLeg.tokenId, {
          match: `${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}`,
          dir: bestDir,
          pmOutcome: trackPmLeg.outcome,
          kalAsk: bestKalAsk,
          pmAsk: bestPmAsk,
          edge: bestEdge,
          tradeTs: trackTs,
        });
      }

      try {
        // Dispatch to 3-leg executor for soccer dirs A-F, 2-leg for everything else
        const is3LegDir = bestEntry.is3Way && ["A", "B", "C", "D", "E", "F"].includes(bestDir);
        const { sessionSkip, unhedged, abortReason } = is3LegDir
          ? await executeArb3Leg(bestEntry, bestDir, bestEdge)
          : await executeArb(bestEntry, bestDir, bestKalAsk, bestPmAsk, bestEdge);
        consecutiveErrors = 0; // reset on successful execution

        // Track consecutive aborts per match for cooldown
        // Soft aborts (depth/edge insufficient) don't count -- the opportunity is real,
        // just waiting for liquidity. Only hard aborts (order failures) trigger cooldown.
        if (!sessionSkip && !unhedged) {
          if (abortReason === "soft") {
            // Soft abort -- light cooldown (60s after 3 consecutive) to prevent spam
            const sc = abortCountMap.get(bestEntry.matchCode) ?? { count: 0, cooldownUntil: 0 };
            sc.count++;
            if (sc.count >= 3) {
              sc.cooldownUntil = Date.now() + 60_000;
              console.log(`[SOFT COOLDOWN] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname} -- ${sc.count} soft aborts, pausing 60s`);
              sc.count = 0;
            }
            abortCountMap.set(bestEntry.matchCode, sc);
          } else {
            // Hard abort (order failed, IOC no fill, etc.) -- increment counter
            const ac = abortCountMap.get(bestEntry.matchCode) ?? { count: 0, cooldownUntil: 0 };
            ac.count++;
            if (ac.count >= ABORT_COOLDOWN_THRESHOLD) {
              ac.cooldownUntil = Date.now() + ABORT_COOLDOWN_MS;
              console.log(`[ABORT COOLDOWN] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname} -- ${ac.count} consecutive hard aborts, cooling down ${ABORT_COOLDOWN_MS / 1000}s`);
              ac.count = 0; // reset so it can trigger again after cooldown
            }
            abortCountMap.set(bestEntry.matchCode, ac);
          }
        } else {
          // Success (filled or hedge) -- reset abort counter
          abortCountMap.delete(bestEntry.matchCode);
        }

        if (sessionSkip) {
          sessionSkipSet.add(bestEntry.matchCode);
          console.log(
            `[SESSION SKIP] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}` +
            ` -- removed from watchlist for this session.`
          );
        }
        if (unhedged) {
          const newHs: HedgeState = { position: unhedged, activeOrders: new Map(), kalNextRetryAt: 0, pmOnlyCycles: 0 };
          hedgeStates.push(newHs);
          _allHedgeStates = hedgeStates;
          saveHedgeStates(hedgeStates);
          console.log(
            `[HEDGE MODE] Entering hedge for ${unhedged.sharesHeld} unhedged ${unhedged.heldExchange.toUpperCase()} shares.` +
            ` Now hedging ${hedgeStates.length} position(s).`
          );
        }
      } catch (err) {
        consecutiveErrors++;
        console.error(`[EXECUTE] Error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${(err as Error).message}`);
      } finally {
        inflight.delete(bestEntry.matchCode);
        // Safety: ensure _activePendingFillId is cleared even if executeArb throws.
        // If logArbTrade already cleared it, this is a no-op.
        if (_activePendingFillId) {
          console.warn(`[PENDING] Clearing orphaned pending fill ${_activePendingFillId} after execution exit.`);
          _activePendingFillId = null;
        }
      }
      } // end circuit breaker / inflight / pm-down checks
    }

    // -- 5. Wait -- yield event loop, then immediately scan again -------------
    // With WS feeds, poll cycles are pure Map reads (no API calls).
    // POLL_INTERVAL_MS=0 -> max speed; >0 -> throttle to save CPU on slower machines.
    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
    if (wait > 0) await sleep(wait);
    else await sleep(0); // yield to event loop even at max speed (process WS messages)
  }
}

// --- Hardcoded watchlist (for manual market overrides) ------------------------
// Set HARDCODED_MARKETS=true in env to skip auto-discovery and use these entries.

function buildHardcodedWatchlist(): WatchEntry[] {
  return [
    // -- ATP Dubai (Feb 26) ------------------------------------------------------
    {
      matchCode: "KXATPMATCH-26FEB26MEDBRO",
      pmSlug: "atp-medvede-brooksb-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26MEDBRO-MED", surname: "Medvedev", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26MEDBRO-BRO", surname: "Brooksby", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Daniil Medvedev", tokenId: "113206786303297881608970499012659120457525717582590216312541942529377809611966", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Jenson Brooksby", tokenId: "101976526833981232003632259338174330180735889970494312719492559490304236617519", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    // -- ATP Chile Open / Santiago (Feb 26) -------------------------------------
    {
      matchCode: "KXATPMATCH-26FEB26TABTIR",
      pmSlug: "atp-tabilo-tirante-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26TABTIR-TAB", surname: "Tabilo",  yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26TABTIR-TIR", surname: "Tirante", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Tabilo",  tokenId: "82818940471320467528514137652191339972553013214088546695527975556632596923193", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Tirante", tokenId: "98932166230278072956703958463978520264014876362813674159983891547938572291381", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB26GARBAE",
      pmSlug: "atp-garin-baez-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26GARBAE-GAR", surname: "Garin", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26GARBAE-BAE", surname: "Baez",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Garin", tokenId: "87428557817459622126102483113314349615321881660279693258259393966823791567083", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Baez",  tokenId: "94840674556228017616238578270953605850206684098651364351071360314799299619963", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB26VALNAV",
      pmSlug: "atp-vallejo-nava-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26VALNAV-VAL", surname: "Vallejo", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26VALNAV-NAV", surname: "Nava",    yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Vallejo", tokenId: "61551056532064752059084036941305269272842570343246679144920545317921480517521", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Nava",    tokenId: "28494910870856779759459720911747991186149206227651575913131743043404396897428", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    // -- ATP Chile Open / Santiago (Feb 25) -------------------------------------
    {
      matchCode: "KXATPMATCH-26FEB25NAVDAR",
      pmSlug: "atp-navone-darderi-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25NAVDAR-NAV", surname: "Navone",  yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25NAVDAR-DAR", surname: "Darderi", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Navone",  tokenId: "97806468779831506400288444206342037762847206817292250507255754725943808224964",  tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Darderi", tokenId: "111563593835318529396659864108225431741509763078104041651920403186940204978836", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25PRIGAU",
      pmSlug: "atp-prizmic-gaubas-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25PRIGAU-PRI", surname: "Prizmic", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25PRIGAU-GAU", surname: "Gaubas",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Prizmic", tokenId: "76530282059250612204463640032266790512445126876916631348635403368539115982722", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Gaubas",  tokenId: "96521385161593719946137010044968935260064081562017387310780021038817524963599", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    // -- ATP Acapulco / Mexican Open (Feb 25) ------------------------------------
    {
      matchCode: "KXATPMATCH-26FEB25VACMON",
      pmSlug: "atp-vachero-monfils-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25VACMON-VAC", surname: "Vacherot", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25VACMON-MON", surname: "Monfils",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Vacherot", tokenId: "90083060630827471117356730814282760133869677583763889673168308321484551999774", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Monfils",  tokenId: "86223060355109810452681408370268513201714459389590666057459583092096870940545", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25YIBSHI",
      pmSlug: "atp-wu-shimabu-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25YIBSHI-YIB", surname: "Wu",          yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25YIBSHI-SHI", surname: "Shimabukuro", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Wu",          tokenId: "96288158559263840660615675328832504070855086893216990813138464886329489948815", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Shimabukuro", tokenId: "27032557020981255739444304291623642884249506868555118351577307494268390226250", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25BELDAV",
      pmSlug: "atp-bellucc-fokina-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25BELDAV-BEL", surname: "Bellucci", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25BELDAV-DAV", surname: "Fokina",   yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Bellucci", tokenId: "12459933346613519023934266987678690842755915855056146291471792667928931967481",  tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Fokina",   tokenId: "110499694312748878099806383141663262195441842032459215903347350158785438449026", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25TIAKOV",
      pmSlug: "atp-tiafoe-kovacev-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25TIAKOV-TIA", surname: "Tiafoe",    yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25TIAKOV-KOV", surname: "Kovacevic", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Tiafoe",    tokenId: "36833949577575507820604813690728045932156690543180418106361277204699097125630", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Kovacevic", tokenId: "73605248070267937520547771129104423883895582884291557222394291537324524696428", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25ZVEKEC",
      pmSlug: "atp-zverev-kecmano-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25ZVEKEC-ZVE", surname: "Zverev",      yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25ZVEKEC-KEC", surname: "Kecmanovic",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Zverev",      tokenId: "29496190083913591097391689128901050944673515064487623921477580917702820283572", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Kecmanovic",  tokenId: "32118261299848027918527121992933669989077108199009144263671100442012461285952", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25SVRCOB",
      pmSlug: "atp-svrcina-cobolli-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25SVRCOB-SVR", surname: "Svrcina", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25SVRCOB-COB", surname: "Cobolli", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Svrcina", tokenId: "1206430047564242078206114643518552980143153855523975824086199830532553821860",  tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Cobolli", tokenId: "94279882850706942433632169558076712526334448556834849592070794870165592892163", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25ATMJOD",
      pmSlug: "atp-atmane-jodar-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25ATMJOD-ATM", surname: "Atmane", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25ATMJOD-JOD", surname: "Jodar",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Atmane", tokenId: "96478640965233294631038510926965290147012068384370820202475820444312161749071", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Jodar",  tokenId: "68153395529339811196433588424367739358750443558486789122752895070458394497022", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25NAKKYP",
      pmSlug: "atp-nakashi-kypson-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25NAKKYP-NAK", surname: "Nakashima", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25NAKKYP-KYP", surname: "Kypson",    yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Nakashima", tokenId: "20961844571729282455683292831901518658014872911109135390035187625925449884425", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Kypson",    tokenId: "28613583995527822989836564951821307884519023381859430125974123117617863586322", tickSize: 0.01, minSize: 5, negRisk: false },
    },
  ];
}

// --- Main ---------------------------------------------------------------------

async function main() {
  // License validation (skipped if not configured)
  if (process.env.LICENSE_SERVER && process.env.LICENSE_TOKEN) {
    await validateLicense(); // throws if invalid -> bot won't start
    startPeriodicRevalidation();
    startPeriodicPush();
    console.log("[TRADER] License validated, dashboard push active");
  }

  if (DRY_RUN) {
    console.log(`[TRADER] DRY RUN mode -- no real orders will be placed`);
  } else {
    console.log(`[TRADER] *** LIVE MODE *** -- orders WILL be placed on real markets!`);
    console.log(`[TRADER] Budget: $${TRADE_USD}/trade | Max: ${MAX_CONTRACTS} contracts | MinEdge: ${fmtPct(MIN_EDGE)} | DepthMult: ${MIN_DEPTH_MULT}x`);
    console.log(`[TRADER] KAL_MAKER_MODE: ${KAL_MAKER_MODE ? "ON (GTC bid at ask-1c, wait " + KAL_MAKER_WAIT_MS + "ms)" : "OFF (IOC taker)"}`);
    if (!process.env.POLY_WALLET_PRIVATE_KEY?.trim()) {
      throw new Error("Set POLY_WALLET_PRIVATE_KEY for live trading (or set DRY_RUN=true).");
    }
    if (!process.env.KALSHI_API_KEY_ID?.trim()) {
      throw new Error("Set KALSHI_API_KEY_ID for live trading (or set DRY_RUN=true).");
    }
    // 5-second countdown to allow cancelling
    console.log("[TRADER] Starting in 5 seconds... (Ctrl+C to abort)");
    await sleep(5000);
  }

  let watchlist: WatchEntry[];
  if (process.env.HARDCODED_MARKETS === "true") {
    watchlist = buildHardcodedWatchlist();
    console.log(`\n[DISCOVER] Using hardcoded watchlist: ${watchlist.length} pair(s)\n`);
  } else {
    const cache = FORCE_DISCOVER ? null : loadDiscoveryCache();
    if (cache) {
      watchlist = cache.watchlist;
      console.log(`\n[DISCOVER] Loaded ${watchlist.length} pairs from cache (${cache.noMatchPairs.length} known no-match skipped)\n`);
    } else {
      console.log("\n[DISCOVER] Building watchlist from Kalshi + Polymarket...");
      const result = await discoverWatchlist();
      watchlist = result.watchlist;
      saveDiscoveryCache(watchlist, result.noMatchPairs);
      console.log(`[DISCOVER] Watchlist: ${watchlist.length} matched cross-platform pairs\n`);
    }
  }

  // -- Merge static pairs from CSV --
  try {
    const staticPairs = await loadStaticPairs();
    if (staticPairs.length > 0) {
      const existingCodes = new Set(watchlist.map(w => w.matchCode));
      let added = 0;
      for (const sp of staticPairs) {
        if (!existingCodes.has(sp.matchCode)) {
          watchlist.push(sp);
          existingCodes.add(sp.matchCode);
          added++;
        }
      }
      console.log(`[STATIC] Added ${added} pairs from ${STATIC_PAIRS_PATH} (${staticPairs.length - added} already discovered)`);
    }
  } catch (err) {
    console.warn(`[STATIC] Failed to load static pairs: ${(err as Error).message}`);
  }

  if (!watchlist.length) {
    console.log("[TRADER] No matches found.");
    return;
  }

  // Log wallet balances on startup
  try {
    const [kalBal, pmBal] = await Promise.all([
      getKalshiBalance().catch(() => -1),
      getUsdcBalance().catch(() => -1),
    ]);
    const kalStr = kalBal >= 0 ? `$${kalBal.toFixed(2)}` : "unavailable";
    const pmStr = pmBal >= 0 ? `$${pmBal.toFixed(2)}` : "unavailable";
    const totalStr = kalBal >= 0 && pmBal >= 0 ? `$${(kalBal + pmBal).toFixed(2)}` : "partial";
    console.log(`[STARTUP] Wallet balances -- Kalshi: ${kalStr} | PM USDC: ${pmStr} | Total: ${totalStr}`);
    // Persist balance to file for historical tracking
    try {
      const balLogPath = path.join(DATA_DIR, "balance_log.json");
      const balLog: { ts: string; kalshi: number; pm: number; total: number }[] =
        fs.existsSync(balLogPath) ? JSON.parse(fs.readFileSync(balLogPath, "utf8")) : [];
      balLog.push({
        ts: new Date().toISOString(),
        kalshi: kalBal >= 0 ? Math.round(kalBal * 100) / 100 : -1,
        pm: pmBal >= 0 ? Math.round(pmBal * 100) / 100 : -1,
        total: kalBal >= 0 && pmBal >= 0 ? Math.round((kalBal + pmBal) * 100) / 100 : -1,
      });
      atomicWriteFileSync(balLogPath, JSON.stringify(balLog, null, 2));
    } catch { /* non-critical */ }
  } catch (err) {
    console.warn(`[STARTUP] Balance check failed: ${(err as Error).message}`);
  }

  // Reconcile P&L log against actual exchange data before trading starts
  console.log("[STARTUP] Running position reconciliation...");
  await reconcilePositions("startup").catch(err =>
    console.error(`[RECONCILE] Startup reconciliation failed: ${(err as Error).message}`)
  );

  // Schedule hourly reconciliation
  setInterval(() => {
    reconcilePositions("hourly").catch(err =>
      console.error(`[RECONCILE] Hourly reconciliation error: ${(err as Error).message}`)
    );
  }, 60 * 60 * 1000);

  // Start on-chain WebSocket subscriptions (non-blocking, fails gracefully)
  try {
    await subscribeToFills((tokenId, shares, txHash, block) => {
      console.log(`[CHAIN] Fill detected: ${shares} shares, token=...${tokenId.slice(-12)} block=${block} tx=${txHash.slice(0, 18)}...`);
      // Ghost fill detection: check if this fill matches an incomplete pending fill.
      // If so, a previous attempt's order just settled on-chain -- find the hedging trade and link it.
      handleGhostFill(tokenId, shares, txHash).catch(err =>
        console.warn(`[GHOST] Detection error: ${(err as Error).message}`)
      );
    });
    await subscribeToSettlements((conditionId, payoutNumerators, block) => {
      console.log(`[CHAIN] Settlement detected: condition=${conditionId.slice(0, 18)}... payouts=[${payoutNumerators.join(",")}] block=${block}`);
    });
  } catch (err) {
    console.warn(`[CHAIN] WebSocket subscriptions failed (non-blocking): ${(err as Error).message}`);
  }

  // Start exchange WebSocket feeds for live orderbook data
  // Eliminates ~500-1000ms REST latency per scan cycle
  console.log("[WS] Starting Kalshi + Polymarket WebSocket feeds...");
  connectKalshiWs();
  connectPmWs();
  subscribeWatchlist(watchlist);

  // Live scores disabled -- not trading soccer currently.
  // To re-enable: uncomment startLiveScores() and import from liveScores.js
  // startLiveScores(trackedMatches);

  await monitorLoop(watchlist);
}

/**
 * Full sync: reconcile trade log + clean hedge state + scan wallets.
 * Does everything the bot startup does, without starting the trading loop.
 * Usage: npx tsx src/_reconcile.ts
 */
async function runFullSync(): Promise<void> {
  // 1) Reconcile arb_trades.json against exchange data
  console.log("[SYNC] Running position reconciliation...");
  await reconcilePositions("manual");

  // 2) Build watchlist (needed for wallet scan matching)
  let watchlist: WatchEntry[];
  if (process.env.HARDCODED_MARKETS === "true") {
    watchlist = buildHardcodedWatchlist();
    console.log(`\n[SYNC] Using hardcoded watchlist: ${watchlist.length} pair(s)`);
  } else {
    const cache = loadDiscoveryCache();
    if (cache) {
      watchlist = cache.watchlist;
      console.log(`\n[SYNC] Loaded ${watchlist.length} pairs from discovery cache`);
    } else {
      console.log("\n[SYNC] Building watchlist from Kalshi + Polymarket...");
      const result = await discoverWatchlist();
      watchlist = result.watchlist;
      saveDiscoveryCache(watchlist, result.noMatchPairs);
      console.log(`[SYNC] Watchlist: ${watchlist.length} matched pairs`);
    }
  }

  // -- Merge static pairs from CSV --
  try {
    const staticPairs = await loadStaticPairs();
    if (staticPairs.length > 0) {
      const existingCodes = new Set(watchlist.map(w => w.matchCode));
      let added = 0;
      for (const sp of staticPairs) {
        if (!existingCodes.has(sp.matchCode)) {
          watchlist.push(sp);
          existingCodes.add(sp.matchCode);
          added++;
        }
      }
      console.log(`[STATIC] Added ${added} pairs from ${STATIC_PAIRS_PATH}`);
    }
  } catch (err) {
    console.warn(`[STATIC] Failed to load static pairs: ${(err as Error).message}`);
  }

  if (!watchlist.length) {
    console.log("[SYNC] No watchlist pairs found. Skipping wallet scan.");
    return;
  }

  // 3) Fetch Kalshi positions
  const kalPosMap = await getKalshiPositionMap();

  // 4) Clean hedge state: remove ghost/fully-covered positions
  let hedgeStates = loadHedgeStates();
  if (hedgeStates.length > 0) {
    const surviving: HedgeState[] = [];
    for (const hs of hedgeStates) {
      const pos = hs.position;

      // Verify held position exists on exchange
      if (pos.heldExchange === "pm") {
        try {
          const pmPos = await fetchPmPositionsCached(0);
          const heldQty = sumPmHeld(pmPos, pos.pmLeg.tokenId);
          if (heldQty <= 0) {
            console.warn(`[SYNC] Ghost PM position: ${pos.pmLeg.outcome} -- wallet has 0. Removing.`);
            continue;
          }
          if (heldQty < pos.sharesHeld) {
            console.warn(`[SYNC] PM wallet has ${heldQty} but state says ${pos.sharesHeld}. Using wallet qty.`);
            pos.sharesHeld = heldQty;
          }
        } catch (e) {
          console.error(`[SYNC] PM verify failed: ${(e as Error).message} -- keeping.`);
        }
      } else {
        const kalQty = kalPosMap.get(pos.kalLeg.ticker)?.yesCount ?? 0;
        if (kalQty <= 0) {
          console.warn(`[SYNC] Ghost Kalshi position: ${pos.kalLeg.ticker} YES -- API has 0. Removing.`);
          continue;
        }
        if (kalQty < pos.sharesHeld) {
          console.warn(`[SYNC] Kalshi has ${kalQty} but state says ${pos.sharesHeld}. Using API qty.`);
          pos.sharesHeld = kalQty;
        }
      }

      // Check coverage on opposite leg
      let covered = 0;
      if (pos.heldExchange === "pm") {
        covered += kalPosMap.get(pos.kalLeg.ticker)?.yesCount ?? 0;
        if (pos.pmOppLeg) {
          try {
            const pmPositions = await fetchPmPositionsCached(5000);
            covered += sumPmHeld(pmPositions, pos.pmOppLeg.tokenId);
          } catch {}
        }
      } else {
        try {
          const pmPositions = await fetchPmPositionsCached(5000);
          covered += sumPmHeld(pmPositions, pos.pmLeg.tokenId);
        } catch {}
        covered += kalPosMap.get(pos.kalLeg.ticker)?.noCount ?? 0;
      }
      covered = Math.min(pos.sharesHeld, covered);

      if (covered >= pos.sharesHeld) {
        console.warn(`[SYNC] ${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker} fully covered (${covered}/${pos.sharesHeld}). Removing.`);
        continue;
      } else if (covered > 0) {
        pos.sharesHeld -= covered;
        console.warn(`[SYNC] ${pos.sharesHeld} remaining for ${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}.`);
      }

      surviving.push(hs);
    }
    hedgeStates = surviving;
  }

  // 5a) Restore orphaned "hedging" trades (same logic as main startup -- see comment there)
  {
    const hsTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
    const allTrades = loadArbTrades();
    const orphanedHedging = allTrades.filter(t => t.status === "hedging" && !hsTickers.has(t.kalTicker));
    if (orphanedHedging.length > 0) {
      const kalTickerToWatch = new Map<string, { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg }>();
      for (const entry of watchlist) {
        kalTickerToWatch.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm1 });
        kalTickerToWatch.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm2 });
        if (entry.kal3 && entry.pm3) {
          kalTickerToWatch.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
        }
      }
      for (const t of orphanedHedging) {
        const wm = kalTickerToWatch.get(t.kalTicker);
        if (!wm) continue;
        const kalNoSideDirs = new Set(["C", "D", "G", "H", "I"]);
        const kalSide: "yes" | "no" = kalNoSideDirs.has(t.dir) ? "no" : "yes";
        const heldExchange = t.initialExchange ?? (t.pmCost > 0 && t.kalCost === 0 ? "pm" : "kal");
        const entry = wm.entry;
        let pmLeg: PmLeg = wm.pmLeg;
        let pmOppLeg: PmLeg | null = null;
        const is3WayDir = "GHIJKL".includes(t.dir);
        if (!is3WayDir) {
          if (t.dir === "A" || t.dir === "D") { pmLeg = entry.pm2; pmOppLeg = entry.pm1; }
          else if (t.dir === "B" || t.dir === "C") { pmLeg = entry.pm1; pmOppLeg = entry.pm2; }
        } else {
          pmOppLeg = null;
        }
        if (t.pmTokenId) {
          for (const leg of [entry.pm1, entry.pm2, entry.pm3].filter(Boolean) as PmLeg[]) {
            if (leg.tokenId === t.pmTokenId || leg.noTokenId === t.pmTokenId) {
              if (leg.noTokenId === t.pmTokenId) {
                pmLeg = { ...leg, tokenId: leg.noTokenId, outcome: `${leg.outcome} [NO]` };
              } else {
                pmLeg = leg;
              }
              break;
            }
          }
        }
        const costBasis = heldExchange === "pm"
          ? (t.pmFillPrice > 0 ? t.pmFillPrice : t.pmCost / Math.max(t.shares, 1))
          : (t.kalFillPrice > 0 ? t.kalFillPrice : t.kalCost / Math.max(t.shares, 1));
        const kalFeePerShare2 = (t.kalFees ?? 0) / Math.max(t.shares, 1);
        hedgeStates.push({
          position: {
            tradeId: t.id,
            heldExchange,
            pmLeg,
            pmOppLeg: heldExchange === "pm" ? pmOppLeg : null,
            pmCostBasis: heldExchange === "pm" ? costBasis : 0,
            kalLeg: wm.kalLeg,
            kalCostBasis: heldExchange === "kal" ? costBasis + kalFeePerShare2 : 0,
            kalSide,
            sharesHeld: t.shares,
            initialShares: t.shares,
            initialCost: heldExchange === "pm" ? t.pmCost : t.kalCost,
            hedgeFillCost: 0,
            hedgeFillCostKal: 0,
            hedgeFillCostPm: 0,
            kalFees: t.kalFees ?? 0,
            initialKalFees: heldExchange === "kal" ? (t.kalFees ?? 0) : 0,
          },
          activeOrders: new Map(),
          kalNextRetryAt: 0,
        });
        hsTickers.add(t.kalTicker);
        console.warn(`[SYNC] Restored orphaned hedging trade: ${t.match} dir=${t.dir} kalSide=${kalSide} held=${heldExchange} shares=${t.shares}`);
      }
    }
  }

  // 5b) Scan wallets for unhedged positions
  // Pass current hedgeState tickers so detection knows which "hedging" arb trades are actually active.
  console.log("[SYNC] Scanning both wallets for unhedged positions...");
  const hsTickerSet = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
  const pmFound = await detectUnhedgedPmPositions(watchlist, hsTickerSet);
  const kalFound = await detectUnhedgedKalPositions(watchlist, kalPosMap, hsTickerSet);

  // -- Cross-match dedup for 3-way markets (same logic as main startup) ------
  const pmBySlugSync = new Map<string, HedgeState>();
  for (const hs of pmFound) {
    const slug = watchlist.find(w =>
      w.pm1.tokenId === hs.position.pmLeg.tokenId ||
      w.pm2.tokenId === hs.position.pmLeg.tokenId ||
      w.pm3?.tokenId === hs.position.pmLeg.tokenId ||
      w.pm1.noTokenId === hs.position.pmLeg.tokenId ||
      w.pm2.noTokenId === hs.position.pmLeg.tokenId ||
      w.pm3?.noTokenId === hs.position.pmLeg.tokenId
    )?.pmSlug;
    if (slug) pmBySlugSync.set(slug, hs);
  }
  const deduplicatedKalFoundSync: HedgeState[] = [];
  for (const hs of kalFound) {
    const entry = watchlist.find(w =>
      w.kal1.ticker === hs.position.kalLeg.ticker ||
      w.kal2.ticker === hs.position.kalLeg.ticker ||
      w.kal3?.ticker === hs.position.kalLeg.ticker
    );
    if (entry?.is3Way && pmBySlugSync.has(entry.pmSlug)) {
      console.log(
        `[SYNC] 3-way cross-match dedup: KAL ${hs.position.sharesHeld}x${hs.position.kalLeg.ticker} YES` +
        ` already covered by PM-side hedge from same match. Skipping.`
      );
      continue;
    }
    deduplicatedKalFoundSync.push(hs);
  }
  const freshFound = [...pmFound, ...deduplicatedKalFoundSync];

  const existingTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
  for (const hs of freshFound) {
    if (!existingTickers.has(hs.position.kalLeg.ticker)) {
      hedgeStates.push(hs);
      existingTickers.add(hs.position.kalLeg.ticker);
    }
  }

  // 6) Save updated hedge state
  saveHedgeStates(hedgeStates);
  if (hedgeStates.length > 0) {
    console.log(`[SYNC] ${hedgeStates.length} active position(s) saved to hedge_state.json`);
  } else {
    console.log("[SYNC] No active positions. hedge_state.json cleared.");
  }

  // 7) P&L summary
  const arbTrades = loadArbTrades();
  if (arbTrades.length > 0) {
    const filled = arbTrades.filter(t => t.status === "filled");
    const hedging = arbTrades.filter(t => t.status === "hedging");
    const resolved = arbTrades.filter(t => t.status === "resolved");
    const totalPnl = resolved.reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
    console.log(`\n[P&L] ${arbTrades.length} arbs: ${filled.length} filled, ${resolved.length} resolved, ${hedging.length} hedging`);
    console.log(`[P&L] Total realized P&L: $${totalPnl.toFixed(2)}`);
  }
}

/**
 * Hedge-only mode: sync + place hedge orders until all positions are filled.
 * No new arbs are opened -- only existing unhedged positions get hedged.
 * Exits when all hedges are complete (or Ctrl+C).
 */
async function runHedgeOnly(): Promise<void> {
  // Full sync first (reconcile + wallet scan)
  await runFullSync();

  let hedgeStates = loadHedgeStates();
  _allHedgeStates = hedgeStates;

  if (hedgeStates.length === 0) {
    console.log("\n[HEDGE-ONLY] No positions to hedge. Done.");
    return;
  }

  console.log(`\n[HEDGE-ONLY] ${hedgeStates.length} position(s) to hedge. Starting hedge loop...`);
  if (DRY_RUN) {
    console.log("[HEDGE-ONLY] DRY RUN mode -- no real orders will be placed.");
  }

  // Pre-warm PM client
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  try {
    await createPmClient();
    console.log("[HEDGE-ONLY] PM ClobClient ready.");
  } catch (e) {
    console.warn(`[HEDGE-ONLY] PM client warmup failed: ${(e as Error).message}`);
  }

  let cycle = 0;
  while (hedgeStates.length > 0) {
    cycle++;
    const allOrdersPlaced = hedgeStates.every(hs => hs.activeOrders.size > 0);
    // Check fills every ~10s once orders are placed, every cycle otherwise
    const checkInterval = allOrdersPlaced ? 25 : 1;

    if (cycle % checkInterval === 0) {
      for (const hs of hedgeStates) {
        await runHedgeCycle(hs, clobBase);
      }

      // Remove resolved positions
      const beforeLen = hedgeStates.length;
      hedgeStates = hedgeStates.filter(hs => {
        if (hs.position.sharesHeld <= 0) {
          const p = hs.position;
          const name = p.heldExchange === "pm" ? p.pmLeg.outcome : p.kalLeg.ticker;

          if (p.hedgeFillCost > 0) {
            const isPmInitial = p.heldExchange === "pm";
            // initialCost already includes initial Kalshi fees for KAL-held positions.
            // For KAL-held, add hedge fees separately (kalFees - initialKalFees).
            const hedgeKalFees = Math.max(0, p.kalFees - p.initialKalFees);
            const kalTotal = isPmInitial
              ? p.hedgeFillCostKal + p.kalFees
              : p.initialCost + p.hedgeFillCostKal + hedgeKalFees;
            const pmTotal = isPmInitial
              ? p.initialCost + p.hedgeFillCostPm
              : p.hedgeFillCostPm;
            const kalCostR = Math.round(kalTotal * 100) / 100;
            const pmCostR = Math.round(pmTotal * 100) / 100;
            const totalCost = Math.round((kalCostR + pmCostR) * 100) / 100;
            const payout = p.initialShares;
            const realizedPnl = Math.round((payout - totalCost) * 100) / 100;
            console.log(
              `\n[HEDGE-ONLY] ${name} resolved! cost=$${totalCost.toFixed(2)}` +
              ` kalFees=$${p.kalFees.toFixed(2)} payout=$${payout.toFixed(2)} P&L=$${realizedPnl.toFixed(2)}`
            );
            resolveArbTrade(p.kalLeg.ticker, {
              status: "resolved",
              resolvedTs: new Date().toISOString(),
              resolutionMethod: "hedge-complete",
              totalCost,
              hedgeCost: p.hedgeFillCost,
              kalFees: p.kalFees,
              realizedPnl,
              initialExchange: p.heldExchange,
              kalFillPrice: kalTotal > 0
                ? Math.round(((kalTotal - p.kalFees) / p.initialShares) * 100) / 100
                : 0,
              kalCost: kalCostR,
              pmFillPrice: pmTotal > 0
                ? Math.round((pmTotal / p.initialShares) * 100) / 100
                : isPmInitial ? p.pmCostBasis : 0,
              pmCost: pmCostR,
            }, p.tradeId);
              postResolutionFillAudit(p.kalLeg.ticker, p.tradeId).catch(() => {});
          } else {
            console.log(`\n[HEDGE-ONLY] ${name} cleared (settled without hedge).`);
          }
          return false;
        }
        return true;
      });

      if (hedgeStates.length < beforeLen) {
        _allHedgeStates = hedgeStates;
        saveHedgeStates(hedgeStates);
        if (hedgeStates.length === 0) break;
      }
    }

    await sleep(400);
  }

  console.log("\n[HEDGE-ONLY] All positions hedged. Done.");
}

export { reconcilePositions, runFullSync, runHedgeOnly, loadMetrics };

// Auto-run main() when this file is the entry point
const _entry = (process.argv[1] ?? "").replace(/\\/g, "/");
const _isBundled = typeof (globalThis as any).__webpack_require__ === "undefined" && !_entry.includes("dashboard");
if (_isBundled || _entry.includes("tradeTennis")) {
  console.log("[BOOT] Starting bot...");
  main().catch((err) => {
    console.error("[TENNIS TRADER] Fatal:", (err as Error).message ?? err);
    process.exit(1);
  });
}
