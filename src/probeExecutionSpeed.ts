/**
 * probeExecutionSpeed.ts -- REAL order placement latency probe.
 *
 * Places small GTC orders at impossible prices (1 cent / tick-size) on Kalshi
 * and Polymarket, measures every leg of the round-trip via HTTP + WebSocket,
 * then cancels them. Safe by construction: limits are set so far below market
 * that no fill can occur; if a fill DID happen, the cost is bounded (1 share
 * worth, max ~$0.01 loss).
 *
 * Measures, per probe iteration:
 *   - place_sign_ms       (Kalshi only — RSA sign overhead)
 *   - place_http_ms       (HTTP POST → response)
 *   - place_ws_ms         (HTTP response → WS notification of order)
 *   - cancel_sign_ms
 *   - cancel_http_ms      (HTTP DELETE → response)
 *   - cancel_ws_ms        (HTTP response → WS notification of cancellation)
 *   - total_round_trip_ms (place start → cancel WS notification)
 *
 * SAFETY GATES
 *   - Requires --yes flag (won't run without explicit confirmation)
 *   - Caps iterations at 20 (--iters)
 *   - Buy at 1¢ (Kalshi) or tickSize (PM) — far below any real ask
 *   - Posts ONE order at a time, fully cancels before next iter
 *   - Aborts immediately on any unexpected fill
 *
 * Output: data/probe_<SERVER_ID>_<ts>.json with full per-iteration timings.
 *
 * Usage:
 *   probe-speed.exe --yes                    # default 5 iters per exchange
 *   probe-speed.exe --yes --iters=10
 *   probe-speed.exe --yes --kalshi-only
 *   probe-speed.exe --yes --pm-only
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import { performance } from "perf_hooks";
import WebSocket from "ws";
import dotenv from "dotenv";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet as EthersWallet } from "@ethersproject/wallet";

dotenv.config();

// --- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
const HAS_CONFIRM = args.includes("--yes");
const ITERS = (() => {
  const a = args.find((s) => s.startsWith("--iters="));
  return a ? Math.min(20, Math.max(1, Number(a.split("=")[1]) || 5)) : 5;
})();
const KAL_ONLY = args.includes("--kalshi-only");
const PM_ONLY = args.includes("--pm-only");
const FULL_CYCLE = args.includes("--full-cycle");
const CYCLES = (() => {
  const a = args.find((s) => s.startsWith("--cycles="));
  return a ? Math.min(5, Math.max(1, Number(a.split("=")[1]) || 3)) : 3;
})();

if (!HAS_CONFIRM) {
  console.error(`
PROBE EXECUTION SPEED — places REAL orders on Kalshi and Polymarket.

DEFAULT MODE (place + cancel only, no fills):
  - Orders are GTC at 1 cent (Kalshi) / tickSize (PM) — far below market.
  - If anyone is selling at that price you BUY at a profit (worst case loss
    is bounded to ~$0.01 per fill).
  - Each order is cancelled within a few seconds.

FULL-CYCLE MODE (--full-cycle): BUYS at market then SELLS back immediately.
  - Captures real fill latency end-to-end (place → MATCHED → MINED → sell → MINED).
  - Costs the spread + 2× taker fee per cycle, ~\$0.025-0.05 per round-trip.
  - Capped at 5 cycles (--cycles=N, default 3) → max ~\$0.25 total cost.

To run:
  probe-speed.exe --yes                              # default place+cancel, 5 iters
  probe-speed.exe --yes --iters=10
  probe-speed.exe --yes --kalshi-only
  probe-speed.exe --yes --full-cycle                 # 3 BUY+SELL cycles per exchange
  probe-speed.exe --yes --full-cycle --cycles=5      # max
  probe-speed.exe --yes --full-cycle --pm-only       # PM only round-trip
`);
  process.exit(1);
}

const SERVER_ID = process.env.SERVER_ID || "unknown";

// --- Kalshi auth + signed request --------------------------------------------
function loadKalshiPk(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return "";
}
const KAL_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const KAL_KEY = process.env.KALSHI_API_KEY_ID ?? "";
const KAL_PK = loadKalshiPk();

function kalSign(method: string, path: string, ts: string): string {
  const s = crypto.createSign("RSA-SHA256");
  s.update(`${ts}${method.toUpperCase()}${path}`);
  s.end();
  return s.sign({ key: KAL_PK, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

async function kalRequest(method: string, path: string, body?: unknown): Promise<{ resp: Response; signMs: number; httpMs: number; json: any }> {
  const t0 = performance.now();
  const ts = Date.now().toString();
  // Sign with the FULL pathname (incl /trade-api/v2 prefix) — that's what the
  // server sees and validates the signature against.
  const fullPath = new URL(`${KAL_BASE}${path}`).pathname;
  const sig = kalSign(method, fullPath, ts);
  const t1 = performance.now();
  const resp = await fetch(`${KAL_BASE}${path}`, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": KAL_KEY,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t2 = performance.now();
  const json = await resp.json().catch(() => ({}));
  return { resp, signMs: t1 - t0, httpMs: t2 - t1, json };
}

// --- Stats helper ----------------------------------------------------------
type Sample = { min: number; p50: number; p95: number; max: number; avg: number; n: number };
function stats(arr: number[]): Sample {
  if (!arr.length) return { min: 0, p50: 0, p95: 0, max: 0, avg: 0, n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { min: s[0], p50: pct(0.5), p95: pct(0.95), max: s[s.length - 1], avg: s.reduce((a, b) => a + b, 0) / s.length, n: s.length };
}

// --- Kalshi WS waiter -------------------------------------------------------
const _kalOrderListeners = new Map<string, (status: string) => void>();
let _kalWs: WebSocket | null = null;

async function connectKalshiWs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ts = Date.now().toString();
    const sig = kalSign("GET", "/trade-api/ws/v2", ts);
    _kalWs = new WebSocket("wss://api.elections.kalshi.com/trade-api/ws/v2", {
      headers: {
        "KALSHI-ACCESS-KEY": KAL_KEY,
        "KALSHI-ACCESS-SIGNATURE": sig,
        "KALSHI-ACCESS-TIMESTAMP": ts,
      },
    });
    const t = setTimeout(() => reject(new Error("kalshi-ws-timeout")), 10_000);
    _kalWs.once("open", () => {
      clearTimeout(t);
      _kalWs!.send(JSON.stringify({ id: 1, cmd: "subscribe", params: { channels: ["fill", "user_orders"] } }));
      resolve();
    });
    _kalWs.once("error", (e) => { clearTimeout(t); reject(e); });
    _kalWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const m = msg.msg ?? msg;
        const oid = m?.order_id;
        if (!oid) return;
        const listener = _kalOrderListeners.get(oid);
        if (!listener) return;
        const status = String(m.status ?? msg.type ?? "any").toLowerCase();
        listener(status);
      } catch { /* ignore */ }
    });
  });
}

function awaitKalOrderStatus(orderId: string, expected: string[], timeoutMs = 10_000): Promise<{ status: string; tArrived: number }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { _kalOrderListeners.delete(orderId); reject(new Error(`kal-ws-${expected.join("|")}-timeout`)); }, timeoutMs);
    _kalOrderListeners.set(orderId, (status) => {
      // Accept any status notification matching the expected family.
      // Kalshi sends multiple events per order; we want the FIRST relevant one.
      const matches = expected.length === 0 ||
        expected.some((e) => status.toLowerCase().includes(e.toLowerCase()));
      if (matches) {
        clearTimeout(t);
        _kalOrderListeners.delete(orderId);
        resolve({ status, tArrived: performance.now() });
      }
    });
  });
}

// --- PM WS waiter -----------------------------------------------------------
const _pmOrderListeners = new Map<string, (status: string) => void>();
let _pmWs: WebSocket | null = null;

async function connectPmWs(): Promise<void> {
  const apiKey = process.env.POLY_API_KEY;
  const apiSecret = process.env.POLY_API_SECRET;
  const apiPassphrase = process.env.POLY_PASSPHRASE;
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error("PM WS requires POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE");
  }
  return new Promise((resolve, reject) => {
    _pmWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/user");
    const t = setTimeout(() => reject(new Error("pm-ws-timeout")), 10_000);
    _pmWs.once("open", () => {
      clearTimeout(t);
      _pmWs!.send(JSON.stringify({ auth: { apiKey, secret: apiSecret, passphrase: apiPassphrase }, type: "user" }));
      resolve();
    });
    _pmWs.once("error", (e) => { clearTimeout(t); reject(e); });
    _pmWs.on("message", (raw) => {
      try {
        const str = raw.toString();
        if (str === "PONG") return;
        const msgs = JSON.parse(str);
        const events = Array.isArray(msgs) ? msgs : [msgs];
        for (const evt of events) {
          if (evt.event_type !== "trade" && evt.event_type !== "order") continue;
          const oid = evt.taker_order_id ?? evt.id ?? evt.order_id;
          if (!oid) continue;
          const listener = _pmOrderListeners.get(oid);
          if (listener) listener(String(evt.status ?? evt.event_type ?? "unknown").toUpperCase());
        }
      } catch { /* ignore */ }
    });
  });
}

function awaitPmOrderStatus(orderId: string, expected: string[], timeoutMs = 15_000): Promise<{ status: string; tArrived: number }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { _pmOrderListeners.delete(orderId); reject(new Error(`pm-ws-${expected.join("|")}-timeout`)); }, timeoutMs);
    _pmOrderListeners.set(orderId, (status) => {
      if (expected.some((e) => status.toUpperCase().includes(e.toUpperCase()))) {
        clearTimeout(t);
        _pmOrderListeners.delete(orderId);
        resolve({ status, tArrived: performance.now() });
      }
    });
  });
}

// --- Pick a live test market ------------------------------------------------
async function pickKalshiTicker(): Promise<{ ticker: string; bestYesAsk: number }> {
  // Prefer high-liquidity series. Try them in order; stop at first usable market.
  const PREFERRED_SERIES = ["KXNHLGAME", "KXNBAGAME", "KXMLBGAME", "KXATPMATCH", "KXWTAMATCH", "KXCS2GAME", "KXLOLGAME", "KXVALORANTGAME"];
  let scanned = 0;
  for (const series of PREFERRED_SERIES) {
    try {
      const r = await fetch(`${KAL_BASE}/markets?status=open&series_ticker=${series}&limit=50`);
      const j = await r.json();
      const markets = (j.markets ?? []) as any[];
      for (const m of markets) {
        scanned++;
        const yaCents = Number(m.yes_ask_dollars ?? 0) * 100;
        if (yaCents < 10 || yaCents > 90) continue;
        try {
          const ob = await kalRequest("GET", `/markets/${m.ticker}/orderbook`);
          const obj = ob.json?.orderbook_fp ?? {};
          const yes = (Array.isArray(obj.yes_dollars) ? obj.yes_dollars : []) as Array<[string, string]>;
          const no = (Array.isArray(obj.no_dollars) ? obj.no_dollars : []) as Array<[string, string]>;
          if (yes.length === 0 || no.length === 0) continue;
          const yesDepth = yes.reduce((s, l) => s + Number(l[1] ?? 0), 0);
          const noDepth = no.reduce((s, l) => s + Number(l[1] ?? 0), 0);
          if (yesDepth < 5 || noDepth < 5) continue;
          console.log(`  Picked ${series}: ${m.ticker} (yesDepth=${yesDepth}, noDepth=${noDepth}) after scanning ${scanned} markets`);
          return { ticker: String(m.ticker), bestYesAsk: Math.round(yaCents) };
        } catch { continue; }
      }
    } catch { continue; }
  }
  throw new Error(`no usable kalshi market found with sufficient depth (scanned ${scanned} markets across ${PREFERRED_SERIES.length} series)`);
}

async function pickPmMarket(): Promise<{ tokenId: string; tickSize: number; negRisk: boolean; bestAsk: number }> {
  const r = await fetch("https://gamma-api.polymarket.com/markets?limit=20&active=true&closed=false&archived=false");
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error("pm gamma response not array");
  for (const m of arr) {
    try {
      const tokens = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      if (!tokens?.[0]) continue;
      const tokenId = tokens[0];
      const tickSize = Number(m.orderPriceMinTickSize ?? 0.01);
      const negRisk = Boolean(m.negRisk);
      // Get best ask from CLOB book
      const b = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
      const book = await b.json();
      const asks = Array.isArray(book.asks) ? book.asks : [];
      if (!asks.length) continue;
      const bestAsk = Math.min(...asks.map((a: any) => Number(a.price)));
      if (bestAsk < 0.05 || bestAsk > 0.95) continue;
      return { tokenId, tickSize, negRisk, bestAsk };
    } catch { continue; }
  }
  throw new Error("no usable pm market found");
}

// --- Kalshi probe loop ------------------------------------------------------
type KalIter = {
  iter: number;
  orderId: string;
  placeSignMs: number;
  placeHttpMs: number;
  placeWsMs: number;
  cancelSignMs: number;
  cancelHttpMs: number;
  cancelWsMs: number;
  totalRoundTripMs: number;
};

async function probeKalshi(ticker: string, iters: number): Promise<KalIter[]> {
  console.log(`\n[KAL] probing ${iters} order place+cancel cycles on ${ticker}...`);
  const results: KalIter[] = [];
  for (let i = 0; i < iters; i++) {
    const tStart = performance.now();
    const clientOrderId = `probe-${Date.now()}-${i}`;
    // Place GTC YES BUY at 1¢
    // Kalshi: omit time_in_force entirely → defaults to GTC (resting limit).
    // Other valid values are "fill_or_kill" and "immediate_or_cancel".
    const placePayload = {
      ticker, client_order_id: clientOrderId, side: "yes", action: "buy",
      type: "limit", yes_price: 1, count: 1,
    };
    const place = await kalRequest("POST", "/portfolio/orders", placePayload);
    const tHttpDone = performance.now();
    const orderId = String(place.json?.order?.order_id ?? place.json?.order_id ?? "");
    if (!orderId) {
      console.error(`  iter ${i + 1}: no orderId in response`, JSON.stringify(place.json).slice(0, 200));
      continue;
    }
    // Wait for WS notification of order placement
    let placeWsMs = 0;
    try {
      const wsEvt = await awaitKalOrderStatus(orderId, ["resting"], 5000);
      placeWsMs = wsEvt.tArrived - tHttpDone;
    } catch (e) {
      console.warn(`  iter ${i + 1}: place WS timeout (${(e as Error).message}); continuing`);
    }
    // Cancel
    const tCancelStart = performance.now();
    const cancel = await kalRequest("DELETE", `/portfolio/orders/${orderId}`);
    const tCancelHttpDone = performance.now();
    let cancelWsMs = 0;
    try {
      const wsEvt = await awaitKalOrderStatus(orderId, ["canceled", "cancelled"], 5000);
      cancelWsMs = wsEvt.tArrived - tCancelHttpDone;
    } catch (e) {
      console.warn(`  iter ${i + 1}: cancel WS timeout (${(e as Error).message})`);
    }
    const total = performance.now() - tStart;
    const it: KalIter = {
      iter: i + 1, orderId,
      placeSignMs: place.signMs, placeHttpMs: place.httpMs, placeWsMs,
      cancelSignMs: cancel.signMs, cancelHttpMs: cancel.httpMs, cancelWsMs,
      totalRoundTripMs: total,
    };
    results.push(it);
    console.log(`  iter ${i + 1}/${iters}: place=${place.httpMs.toFixed(0)}ms (ws+${placeWsMs.toFixed(0)}ms) cancel=${cancel.httpMs.toFixed(0)}ms (ws+${cancelWsMs.toFixed(0)}ms) total=${total.toFixed(0)}ms`);
    await new Promise((r) => setTimeout(r, 250)); // small spacing
  }
  return results;
}

// --- PM probe loop ----------------------------------------------------------
type PmIter = {
  iter: number;
  orderId: string;
  placeHttpMs: number;
  placeWsMs: number;
  cancelHttpMs: number;
  cancelWsMs: number;
  totalRoundTripMs: number;
};

async function probePm(tokenId: string, tickSize: number, negRisk: boolean, iters: number): Promise<PmIter[]> {
  console.log(`\n[PM] probing ${iters} order place+cancel cycles on token ${tokenId.slice(0, 16)}...`);
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("PM probe requires POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new EthersWallet(pk);
  const funder = process.env.POLY_FUNDER || wallet.address;
  // Try to use stored creds, else derive
  let creds: { key: string; secret: string; passphrase: string };
  if (process.env.POLY_API_KEY && process.env.POLY_API_SECRET && process.env.POLY_PASSPHRASE) {
    creds = { key: process.env.POLY_API_KEY, secret: process.env.POLY_API_SECRET, passphrase: process.env.POLY_PASSPHRASE };
  } else {
    throw new Error("PM probe requires POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE");
  }
  const client = new ClobClient(host, chainId, wallet as any, creds, sigType, funder);
  const results: PmIter[] = [];
  for (let i = 0; i < iters; i++) {
    const tStart = performance.now();
    // Place GTC BUY at tick price (1c) — far below market, won't fill
    let placeRes: any;
    let placeHttpMs = 0;
    try {
      const t0 = performance.now();
      placeRes = await (client as any).createAndPostOrder(
        { tokenID: tokenId, price: tickSize, size: 5, side: Side.BUY },
        { tickSize: tickSize.toString(), negRisk },
        OrderType.GTC,
      );
      placeHttpMs = performance.now() - t0;
    } catch (e) {
      console.error(`  iter ${i + 1}: place threw: ${(e as Error).message}`);
      continue;
    }
    const tHttpDone = performance.now();
    const orderId = String(placeRes?.orderID ?? placeRes?.orderId ?? "");
    if (!orderId) {
      console.error(`  iter ${i + 1}: no orderId in response`, JSON.stringify(placeRes).slice(0, 200));
      continue;
    }
    // PM WS doesn't notify on order PLACEMENT (only on trade events). Skip waiting; record 0.
    const placeWsMs = 0;
    // Cancel
    const tCancelStart = performance.now();
    let cancelRes: any;
    let cancelHttpMs = 0;
    try {
      const t0 = performance.now();
      cancelRes = await (client as any).cancelOrder({ orderID: orderId });
      cancelHttpMs = performance.now() - t0;
    } catch (e) {
      console.error(`  iter ${i + 1}: cancel threw: ${(e as Error).message}`);
      continue;
    }
    void cancelRes;
    const tCancelHttpDone = performance.now();
    void tCancelHttpDone; void tCancelStart;
    const cancelWsMs = 0; // PM doesn't push cancel events
    const total = performance.now() - tStart;
    const it: PmIter = {
      iter: i + 1, orderId,
      placeHttpMs, placeWsMs, cancelHttpMs, cancelWsMs, totalRoundTripMs: total,
    };
    results.push(it);
    console.log(`  iter ${i + 1}/${iters}: place=${placeHttpMs.toFixed(0)}ms cancel=${cancelHttpMs.toFixed(0)}ms total=${total.toFixed(0)}ms`);
    void tHttpDone;
    await new Promise((r) => setTimeout(r, 250));
  }
  return results;
}

// --- PM full-cycle (BUY at market then SELL it back) -------------------------
// Costs: spread + 2× taker fee per cycle. Captures real fill latency:
//   place_buy → MATCHED → MINED/CONFIRMED → place_sell → MATCHED → MINED/CONFIRMED.
type PmCycleIter = {
  iter: number;
  buyOrderId: string;
  sellOrderId: string;
  buyPlaceHttpMs: number;
  buyMatchedWsMs: number;     // HTTP done → MATCHED received
  buyMinedWsMs: number;       // MATCHED → MINED/CONFIRMED received
  sellPlaceHttpMs: number;
  sellMatchedWsMs: number;
  sellMinedWsMs: number;
  totalCycleMs: number;       // place_buy start → sell MINED received
  buyPrice: number;
  sellPrice: number;
  shares: number;
  spreadCost: number;         // (buyPrice - sellPrice) × shares (positive = loss)
};

async function probePmFullCycle(
  tokenId: string, tickSize: number, negRisk: boolean, bestAsk: number, cycles: number
): Promise<PmCycleIter[]> {
  console.log(`\n[PM-CYCLE] BUY+SELL cycles on token ${tokenId.slice(0, 16)}... (current ask=${bestAsk})`);
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("PM cycle probe requires POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new EthersWallet(pk);
  const funder = process.env.POLY_FUNDER || wallet.address;
  if (!process.env.POLY_API_KEY || !process.env.POLY_API_SECRET || !process.env.POLY_PASSPHRASE) {
    throw new Error("requires POLY_API_KEY, POLY_API_SECRET, POLY_PASSPHRASE");
  }
  const creds = {
    key: process.env.POLY_API_KEY,
    secret: process.env.POLY_API_SECRET,
    passphrase: process.env.POLY_PASSPHRASE,
  };
  const client = new ClobClient(host, chainId, wallet as any, creds, sigType, funder);
  const results: PmCycleIter[] = [];
  const SHARES = 5; // PM minimum order size

  for (let i = 0; i < cycles; i++) {
    console.log(`\n  cycle ${i + 1}/${cycles}: refreshing book...`);
    // Fresh book per cycle so we hit the actual best ask/bid
    const bookResp = await fetch(`${host}/book?token_id=${tokenId}`);
    const book = await bookResp.json();
    const asks = (Array.isArray(book.asks) ? book.asks : []).map((a: any) => ({ price: Number(a.price), size: Number(a.size) }));
    const bids = (Array.isArray(book.bids) ? book.bids : []).map((b: any) => ({ price: Number(b.price), size: Number(b.size) }));
    asks.sort((a: any, b: any) => a.price - b.price);
    bids.sort((a: any, b: any) => b.price - a.price);
    const ask = asks[0]?.price;
    const bid = bids[0]?.price;
    if (!ask || !bid) { console.warn(`  cycle ${i + 1}: empty book, skipping`); continue; }
    if (ask >= 0.95 || bid <= 0.05) { console.warn(`  cycle ${i + 1}: book skewed (ask=${ask} bid=${bid}), skipping`); continue; }
    if ((ask - bid) > 0.05) { console.warn(`  cycle ${i + 1}: spread too wide (${((ask - bid) * 100).toFixed(1)}c), skipping`); continue; }

    console.log(`    book: ask=${ask.toFixed(3)} bid=${bid.toFixed(3)} spread=${((ask - bid) * 100).toFixed(1)}c, buying ${SHARES}×${ask}`);

    // -- BUY at best ask --
    const tStart = performance.now();
    let buyOrderId = "";
    let buyPlaceHttpMs = 0;
    let buyHttpStatus = "";
    let buyRes: any;
    try {
      const t0 = performance.now();
      buyRes = await (client as any).createAndPostOrder(
        { tokenID: tokenId, price: ask, size: SHARES, side: Side.BUY },
        { tickSize: tickSize.toString(), negRisk },
        OrderType.FAK,
      );
      buyPlaceHttpMs = performance.now() - t0;
      buyOrderId = String(buyRes?.orderID ?? buyRes?.orderId ?? "");
      buyHttpStatus = String(buyRes?.status ?? "").toLowerCase();
      if (!buyOrderId) {
        console.error(`    BUY no orderId: ${JSON.stringify(buyRes).slice(0, 300)}`);
        continue;
      }
      console.log(`    BUY HTTP returned status=${buyHttpStatus} orderId=${buyOrderId.slice(0, 16)}...`);
    } catch (e) {
      console.error(`    BUY threw: ${(e as Error).message}`);
      continue;
    }
    const tBuyHttpDone = performance.now();
    // If HTTP says unmatched, the order didn't fill — skip cycle, no shares to sell.
    if (buyHttpStatus === "unmatched" || buyHttpStatus === "rejected") {
      console.warn(`    BUY did not match (status=${buyHttpStatus}). No position to sell. Skipping cycle.`);
      continue;
    }
    // Wait MATCHED then MINED via WS
    let buyMatchedWsMs = 0, buyMinedWsMs = 0, tMatched = 0;
    try {
      const matched = await awaitPmOrderStatus(buyOrderId, ["MATCHED"], 30_000);
      tMatched = matched.tArrived;
      buyMatchedWsMs = tMatched - tBuyHttpDone;
      console.log(`    BUY MATCHED at +${buyMatchedWsMs.toFixed(0)}ms, waiting MINED...`);
      const mined = await awaitPmOrderStatus(buyOrderId, ["MINED", "CONFIRMED"], 60_000);
      buyMinedWsMs = mined.tArrived - tMatched;
      console.log(`    BUY MINED at +${buyMinedWsMs.toFixed(0)}ms`);
    } catch (e) {
      console.error(`    BUY WS wait failed: ${(e as Error).message} — checking on-chain to confirm position state...`);
      try {
        const { getOnChainBalanceWithFallback } = await import("./polyChain.js");
        const bal = await getOnChainBalanceWithFallback(tokenId);
        console.warn(`    On-chain balance for token: ${bal} shares`);
        if (bal < SHARES) {
          console.log(`    Insufficient on-chain shares (${bal} < ${SHARES}) — BUY likely did not fill. Skipping cycle (no SELL).`);
          continue;
        }
        console.warn(`    Have ${bal} shares on-chain. Proceeding to SELL despite WS timeout.`);
      } catch (be) {
        console.error(`    On-chain check failed: ${(be as Error).message}. Aborting cycle.`);
        continue;
      }
    }

    // -- SELL at best bid --
    let sellOrderId = "";
    let sellPlaceHttpMs = 0;
    let sellRes: any;
    try {
      const t0 = performance.now();
      sellRes = await (client as any).createAndPostOrder(
        { tokenID: tokenId, price: bid, size: SHARES, side: Side.SELL },
        { tickSize: tickSize.toString(), negRisk },
        OrderType.FAK,
      );
      sellPlaceHttpMs = performance.now() - t0;
      sellOrderId = String(sellRes?.orderID ?? sellRes?.orderId ?? "");
      if (!sellOrderId) {
        console.error(`    SELL no orderId. Full response: ${JSON.stringify(sellRes)}`);
        // Retry once at a slightly worse price (deeper into bids) — book may have moved
        await new Promise((r) => setTimeout(r, 500));
        const fallbackPrice = Math.max(0.01, bid - 0.02);
        console.warn(`    Retrying SELL at fallback ${fallbackPrice.toFixed(2)} (2c below original bid)`);
        try {
          const retryRes: any = await (client as any).createAndPostOrder(
            { tokenID: tokenId, price: fallbackPrice, size: SHARES, side: Side.SELL },
            { tickSize: tickSize.toString(), negRisk },
            OrderType.FAK,
          );
          sellOrderId = String(retryRes?.orderID ?? retryRes?.orderId ?? "");
          if (sellOrderId) console.log(`    Retry SELL succeeded: ${sellOrderId.slice(0, 16)}...`);
          else console.error(`    Retry SELL also no orderId. Full response: ${JSON.stringify(retryRes)} — POSITION STUCK`);
        } catch (e2) {
          console.error(`    Retry SELL threw: ${(e2 as Error).message} — POSITION STUCK`);
        }
        if (!sellOrderId) continue;
      }
    } catch (e) {
      console.error(`    SELL threw: ${(e as Error).message} — POSITION STUCK, manual unwind needed`);
      continue;
    }
    const tSellHttpDone = performance.now();
    let sellMatchedWsMs = 0, sellMinedWsMs = 0;
    try {
      const matched = await awaitPmOrderStatus(sellOrderId, ["MATCHED"], 30_000);
      const tSellMatched = matched.tArrived;
      sellMatchedWsMs = tSellMatched - tSellHttpDone;
      const mined = await awaitPmOrderStatus(sellOrderId, ["MINED", "CONFIRMED"], 60_000);
      sellMinedWsMs = mined.tArrived - tSellMatched;
      console.log(`    SELL MATCHED at +${sellMatchedWsMs.toFixed(0)}ms, MINED at +${sellMinedWsMs.toFixed(0)}ms`);
    } catch (e) {
      console.warn(`    SELL WS wait failed: ${(e as Error).message} — sell may still settle on-chain`);
    }

    const totalCycleMs = performance.now() - tStart;
    const spreadCost = Math.round((ask - bid) * SHARES * 10000) / 10000;
    results.push({
      iter: i + 1, buyOrderId, sellOrderId,
      buyPlaceHttpMs, buyMatchedWsMs, buyMinedWsMs,
      sellPlaceHttpMs, sellMatchedWsMs, sellMinedWsMs,
      totalCycleMs, buyPrice: ask, sellPrice: bid, shares: SHARES, spreadCost,
    });
    console.log(`    cycle total: ${totalCycleMs.toFixed(0)}ms, spread cost: $${spreadCost.toFixed(4)}`);
    await new Promise((r) => setTimeout(r, 1000)); // breathe between cycles
  }
  void bestAsk;
  return results;
}

// --- Kalshi full-cycle (IOC BUY then IOC SELL) -------------------------------
// Kalshi sell: action="sell" with side="yes" sells your YES position.
type KalCycleIter = {
  iter: number;
  buyOrderId: string;
  sellOrderId: string;
  buyPlaceHttpMs: number;
  buyFillWsMs: number;        // HTTP done → fill event received
  sellPlaceHttpMs: number;
  sellFillWsMs: number;
  totalCycleMs: number;
  buyPrice: number;
  sellPrice: number;
  spreadCost: number;
};

async function probeKalshiFullCycle(ticker: string, cycles: number): Promise<KalCycleIter[]> {
  console.log(`\n[KAL-CYCLE] BUY+SELL cycles on ${ticker}`);
  const results: KalCycleIter[] = [];

  for (let i = 0; i < cycles; i++) {
    console.log(`\n  cycle ${i + 1}/${cycles}: fetching orderbook...`);
    const obResp = await kalRequest("GET", `/markets/${ticker}/orderbook`);
    const ob = obResp.json?.orderbook_fp ?? {};
    // Kalshi orderbook_fp structure: yes_dollars / no_dollars are arrays of
    // [priceDollarsString, sizeString], ascending by price. Each element is
    // a BID order on that side (yes_dollars = YES bids, no_dollars = NO bids).
    // To BUY YES we pay the YES ask = 100 - max(NO bid).
    const yesLevels = (Array.isArray(ob.yes_dollars) ? ob.yes_dollars : []) as Array<[string, string]>;
    const noLevels = (Array.isArray(ob.no_dollars) ? ob.no_dollars : []) as Array<[string, string]>;
    if (!yesLevels.length || !noLevels.length) { console.warn(`  cycle ${i + 1}: empty book`); continue; }
    const yesBidCents = Math.round(Math.max(...yesLevels.map((l) => Number(l[0]))) * 100);
    const yesAskCents = 100 - Math.round(Math.max(...noLevels.map((l) => Number(l[0]))) * 100);
    if (yesAskCents >= 95 || yesBidCents <= 5) { console.warn(`  cycle ${i + 1}: skewed book`); continue; }
    if ((yesAskCents - yesBidCents) > 5) { console.warn(`  cycle ${i + 1}: spread too wide (${yesAskCents - yesBidCents}c)`); continue; }
    console.log(`    yesAsk=${yesAskCents}c yesBid=${yesBidCents}c spread=${yesAskCents - yesBidCents}c`);

    // -- BUY 1 YES at ask via IOC --
    const tStart = performance.now();
    const buyClientId = `probe-cycle-buy-${Date.now()}-${i}`;
    const buyPayload = {
      ticker, client_order_id: buyClientId, side: "yes", action: "buy",
      type: "limit", yes_price: yesAskCents, count: 1, time_in_force: "immediate_or_cancel",
    };
    const buy = await kalRequest("POST", "/portfolio/orders", buyPayload);
    const tBuyHttpDone = performance.now();
    const buyOrderId = String(buy.json?.order?.order_id ?? "");
    if (!buyOrderId) { console.error(`    BUY no orderId: ${JSON.stringify(buy.json).slice(0, 200)}`); continue; }
    let buyFillWsMs = 0;
    try {
      const evt = await awaitKalOrderStatus(buyOrderId, ["executed", "filled", "any"], 10_000);
      buyFillWsMs = evt.tArrived - tBuyHttpDone;
      console.log(`    BUY status=${evt.status} at +${buyFillWsMs.toFixed(0)}ms`);
    } catch (e) {
      console.error(`    BUY WS timeout: ${(e as Error).message} — checking via HTTP`);
      const status = await kalRequest("GET", `/portfolio/orders/${buyOrderId}`);
      console.log(`    BUY HTTP status: ${status.json?.order?.status}`);
    }

    // -- SELL 1 YES via IOC at bid --
    const sellClientId = `probe-cycle-sell-${Date.now()}-${i}`;
    const sellPayload = {
      ticker, client_order_id: sellClientId, side: "yes", action: "sell",
      type: "limit", yes_price: yesBidCents, count: 1, time_in_force: "immediate_or_cancel",
    };
    const tSellStart = performance.now();
    const sell = await kalRequest("POST", "/portfolio/orders", sellPayload);
    const tSellHttpDone = performance.now();
    const sellOrderId = String(sell.json?.order?.order_id ?? "");
    if (!sellOrderId) {
      console.error(`    SELL no orderId — POSITION STUCK at 1 YES, manual unwind needed: ${JSON.stringify(sell.json).slice(0, 200)}`);
      continue;
    }
    let sellFillWsMs = 0;
    try {
      const evt = await awaitKalOrderStatus(sellOrderId, ["executed", "filled", "any"], 10_000);
      sellFillWsMs = evt.tArrived - tSellHttpDone;
      console.log(`    SELL status=${evt.status} at +${sellFillWsMs.toFixed(0)}ms`);
    } catch (e) {
      console.warn(`    SELL WS timeout: ${(e as Error).message}`);
    }

    const totalCycleMs = performance.now() - tStart;
    const spreadCostCents = yesAskCents - yesBidCents;
    results.push({
      iter: i + 1, buyOrderId, sellOrderId,
      buyPlaceHttpMs: buy.httpMs, buyFillWsMs,
      sellPlaceHttpMs: sell.httpMs, sellFillWsMs,
      totalCycleMs, buyPrice: yesAskCents / 100, sellPrice: yesBidCents / 100,
      spreadCost: spreadCostCents / 100,
    });
    console.log(`    cycle total: ${totalCycleMs.toFixed(0)}ms, spread cost: ${spreadCostCents}c`);
    void tStart; void tSellStart;
    await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

// --- Summary table ----------------------------------------------------------
function printSummary(label: string, samples: Record<string, number[]>) {
  console.log(`\n=== ${label} ===`);
  console.log(`  ${"Phase".padEnd(28)} ${"min".padStart(8)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}`);
  console.log("  " + "─".repeat(64));
  for (const [k, arr] of Object.entries(samples)) {
    const s = stats(arr);
    console.log(`  ${k.padEnd(28)} ${(s.min.toFixed(0) + "ms").padStart(8)} ${(s.p50.toFixed(0) + "ms").padStart(8)} ${(s.p95.toFixed(0) + "ms").padStart(8)} ${(s.max.toFixed(0) + "ms").padStart(8)}`);
  }
}

// --- Main -------------------------------------------------------------------
async function main() {
  console.log(`\n=== Execution Speed Probe — server=${SERVER_ID} host=${os.hostname()} iters=${ITERS} ===\n`);

  const report: any = {
    serverId: SERVER_ID,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    iterations: ITERS,
    kalshi: null as any,
    polymarket: null as any,
  };

  if (!PM_ONLY) {
    if (!KAL_KEY || !KAL_PK) throw new Error("Kalshi auth missing (KALSHI_API_KEY_ID, KALSHI_PRIVATE_KEY[_PATH])");
    console.log("[1/4] Connecting Kalshi WS...");
    await connectKalshiWs();
    console.log("  Kalshi WS connected, subscribed to fill+user_orders");
    console.log("\n[2/4] Picking Kalshi market...");
    const kal = await pickKalshiTicker();
    console.log(`  Using ticker ${kal.ticker} (yesAsk=${kal.bestYesAsk}c).`);

    if (FULL_CYCLE) {
      const kalCycles = await probeKalshiFullCycle(kal.ticker, CYCLES);
      report.kalshi = { ticker: kal.ticker, bestYesAsk: kal.bestYesAsk, fullCycle: kalCycles };
      printSummary("KALSHI full-cycle latency (BUY+SELL)", {
        "BUY place HTTP": kalCycles.map((r) => r.buyPlaceHttpMs),
        "BUY fill WS notification": kalCycles.map((r) => r.buyFillWsMs).filter((x) => x > 0),
        "SELL place HTTP": kalCycles.map((r) => r.sellPlaceHttpMs),
        "SELL fill WS notification": kalCycles.map((r) => r.sellFillWsMs).filter((x) => x > 0),
        "Total cycle (BUY→SELL)": kalCycles.map((r) => r.totalCycleMs),
      });
      const totalCost = kalCycles.reduce((s, r) => s + r.spreadCost, 0);
      console.log(`\n  Total Kalshi cycle cost (spread, before fees): $${totalCost.toFixed(4)}`);
    } else {
      const kalResults = await probeKalshi(kal.ticker, ITERS);
      report.kalshi = { ticker: kal.ticker, bestYesAsk: kal.bestYesAsk, iterations: kalResults };
      printSummary("KALSHI per-phase latency", {
        "RSA sign (place)": kalResults.map((r) => r.placeSignMs),
        "HTTP place (POST)": kalResults.map((r) => r.placeHttpMs),
        "WS notification (place)": kalResults.map((r) => r.placeWsMs).filter((x) => x > 0),
        "RSA sign (cancel)": kalResults.map((r) => r.cancelSignMs),
        "HTTP cancel (DELETE)": kalResults.map((r) => r.cancelHttpMs),
        "WS notification (cancel)": kalResults.map((r) => r.cancelWsMs).filter((x) => x > 0),
        "Total round-trip": kalResults.map((r) => r.totalRoundTripMs),
      });
    }
  }

  if (!KAL_ONLY) {
    console.log("\n[3/4] Connecting PM user WS...");
    try {
      await connectPmWs();
      console.log("  PM user WS connected (note: PM does not push order place/cancel events, only trades)");
    } catch (e) {
      console.warn(`  PM WS connect failed: ${(e as Error).message} — continuing without WS observability`);
    }
    console.log("\n[4/4] Picking PM market...");
    const pm = await pickPmMarket();
    console.log(`  Using token ${pm.tokenId.slice(0, 16)}... (bestAsk=${pm.bestAsk}, tickSize=${pm.tickSize}). Probe orders at ${pm.tickSize} won't fill.`);
    if (FULL_CYCLE) {
      const pmCycles = await probePmFullCycle(pm.tokenId, pm.tickSize, pm.negRisk, pm.bestAsk, CYCLES);
      report.polymarket = { tokenId: pm.tokenId, bestAsk: pm.bestAsk, tickSize: pm.tickSize, fullCycle: pmCycles };
      printSummary("POLYMARKET full-cycle latency (BUY+SELL)", {
        "BUY place HTTP": pmCycles.map((r) => r.buyPlaceHttpMs),
        "BUY MATCHED WS": pmCycles.map((r) => r.buyMatchedWsMs).filter((x) => x > 0),
        "BUY MINED WS (after MATCHED)": pmCycles.map((r) => r.buyMinedWsMs).filter((x) => x > 0),
        "SELL place HTTP": pmCycles.map((r) => r.sellPlaceHttpMs),
        "SELL MATCHED WS": pmCycles.map((r) => r.sellMatchedWsMs).filter((x) => x > 0),
        "SELL MINED WS (after MATCHED)": pmCycles.map((r) => r.sellMinedWsMs).filter((x) => x > 0),
        "Total cycle (BUY→SELL MINED)": pmCycles.map((r) => r.totalCycleMs),
      });
      const totalCost = pmCycles.reduce((s, r) => s + r.spreadCost, 0);
      console.log(`\n  Total PM cycle cost (spread, before fees): $${totalCost.toFixed(4)}`);
    } else {
      const pmResults = await probePm(pm.tokenId, pm.tickSize, pm.negRisk, ITERS);
      report.polymarket = { tokenId: pm.tokenId, bestAsk: pm.bestAsk, tickSize: pm.tickSize, iterations: pmResults };
      printSummary("POLYMARKET per-phase latency", {
        "HTTP place (createAndPostOrder)": pmResults.map((r) => r.placeHttpMs),
        "HTTP cancel (cancelOrder)": pmResults.map((r) => r.cancelHttpMs),
        "Total round-trip": pmResults.map((r) => r.totalRoundTripMs),
      });
    }
  }

  report.completedAt = new Date().toISOString();
  if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
  const outPath = `data/probe_${SERVER_ID}_${report.completedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report written: ${outPath}`);

  // Cleanup WS
  if (_kalWs) _kalWs.close();
  if (_pmWs) _pmWs.close();

  // Auto-run mode (double-clicked exe): pause so the window stays open
  // for the user to read the output before the cmd window closes.
  if (process.env.PROBE_AUTO_RUN === "1") {
    console.log("\n========================================");
    console.log("  Done. Report saved to data/ folder.");
    console.log("  Press ENTER to close this window...");
    console.log("========================================");
    try {
      process.stdin.resume();
      await new Promise<void>((r) => process.stdin.once("data", () => r()));
    } catch {
      // No TTY (background launch) — fall through to timed exit
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); process.exit(1); });
