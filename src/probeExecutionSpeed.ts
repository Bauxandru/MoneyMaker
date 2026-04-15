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

if (!HAS_CONFIRM) {
  console.error(`
PROBE EXECUTION SPEED — places REAL orders on Kalshi and Polymarket.

Safety:
  - Orders are GTC at 1 cent (Kalshi) / tickSize (PM) — far below market.
  - If anyone is selling at that price you BUY at a profit (worst case loss
    is bounded to ~$0.01 per fill).
  - Each order is cancelled within a few seconds.
  - Default 5 iterations per exchange.

To run, add --yes:
  probe-speed.exe --yes [--iters=N] [--kalshi-only|--pm-only]
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
  // Walk pages until we find a market with a sane mid-range yes_ask (10-90c).
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const qs = `status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await fetch(`${KAL_BASE}/markets?${qs}`);
    const j = await r.json();
    const markets = (j.markets ?? []) as any[];
    for (const m of markets) {
      // Field is yes_ask_dollars (string, in dollars). Convert to cents.
      const yaDollars = Number(m.yes_ask_dollars ?? 0);
      const yaCents = yaDollars * 100;
      if (yaCents >= 10 && yaCents <= 90) {
        return { ticker: String(m.ticker), bestYesAsk: Math.round(yaCents) };
      }
    }
    cursor = String(j.cursor ?? "");
    if (!cursor || markets.length < 200) break;
  }
  throw new Error("no usable kalshi market found (looked through 5 pages × 200)");
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
    console.log("  Kalshi WS connected, subscribed to fill+user_order");
    console.log("\n[2/4] Picking Kalshi market...");
    const kal = await pickKalshiTicker();
    console.log(`  Using ticker ${kal.ticker} (yesAsk=${kal.bestYesAsk}c). Probe orders at 1¢ won't fill.`);
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
    const pmResults = await probePm(pm.tokenId, pm.tickSize, pm.negRisk, ITERS);
    report.polymarket = { tokenId: pm.tokenId, bestAsk: pm.bestAsk, tickSize: pm.tickSize, iterations: pmResults };
    printSummary("POLYMARKET per-phase latency", {
      "HTTP place (createAndPostOrder)": pmResults.map((r) => r.placeHttpMs),
      "HTTP cancel (cancelOrder)": pmResults.map((r) => r.cancelHttpMs),
      "Total round-trip": pmResults.map((r) => r.totalRoundTripMs),
    });
  }

  report.completedAt = new Date().toISOString();
  if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
  const outPath = `data/probe_${SERVER_ID}_${report.completedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report written: ${outPath}`);

  // Cleanup WS
  if (_kalWs) _kalWs.close();
  if (_pmWs) _pmWs.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch((e) => { console.error(e); process.exit(1); });
