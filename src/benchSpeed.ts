/**
 * benchSpeed.ts — server-location speed benchmark for KAL + PM + Polygon.
 *
 * Runs a series of latency probes against every endpoint the bot uses, PLUS
 * live GTC order placement + cancellation on both exchanges, so you can
 * compare VPS locations and pick the fastest.
 *
 * Safety: all live orders are placed at 1¢ (buys) / 99¢ (sells) so they
 * CANNOT fill, then cancelled within seconds. No exposure, no P&L.
 *
 * Output: JSON + human table with p50/p95/max/mean per test, plus a single
 * summary line so you can grep across multiple runs.
 */
import "dotenv/config";
import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { WebSocket } from "ws";
import { performance } from "perf_hooks";
import { Wallet } from "@ethersproject/wallet";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 10);
const KAL_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const KAL_WS = process.env.KALSHI_WS_URL ?? "wss://api.elections.kalshi.com/trade-api/ws/v2";
const PM_CLOB = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
const PM_GAMMA = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const PM_DATA_API = "https://data-api.polymarket.com";
const PM_WS_MARKET = process.env.POLY_WS_URL ?? "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const POLY_RPC = process.env.POLY_RPC_URL ?? "";
const SKIP_LIVE = process.env.BENCH_SKIP_LIVE === "true";

const LOCATION = process.env.BENCH_LOCATION ?? os.hostname();

// --- Timing helpers ----------------------------------------------------------
function pct(arr: number[], p: number): number {
  const s = [...arr].filter(x => x > 0).sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.floor(s.length * p)];
}
function stats(name: string, arr: number[]): Record<string, number> {
  const v = arr.filter(x => x > 0);
  if (!v.length) return { name: 0 as any, n: 0 } as any;
  v.sort((a, b) => a - b);
  return {
    n: v.length,
    p50: pct(arr, 0.5),
    p95: pct(arr, 0.95),
    max: v[v.length - 1],
    min: v[0],
    mean: Math.round(v.reduce((s, x) => s + x, 0) / v.length),
  };
}
function printRow(label: string, s: Record<string, number>) {
  if (!s.n) { console.log("  " + label.padEnd(30) + " n=0 (failed)"); return; }
  console.log(
    "  " + label.padEnd(30),
    "n=" + String(s.n).padStart(2),
    "min=" + String(s.min).padStart(4) + "ms",
    "p50=" + String(s.p50).padStart(4) + "ms",
    "p95=" + String(s.p95).padStart(4) + "ms",
    "max=" + String(s.max).padStart(5) + "ms",
    "mean=" + String(s.mean).padStart(4) + "ms"
  );
}

// --- Fine-grained HTTP(S) timings using raw request ------------------------
async function timedRequest(urlStr: string, options: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<{ dnsMs: number; connectMs: number; tlsMs: number; ttfbMs: number; totalMs: number; statusCode?: number; bytes?: number }> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;
    const start = performance.now();
    let dnsEnd = 0, connectEnd = 0, tlsEnd = 0, firstByte = 0;
    let bytes = 0;
    const req = lib.request({
      method: options.method ?? "GET",
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: options.headers,
      timeout: options.timeoutMs ?? 10000,
    }, (res) => {
      res.on("data", (chunk) => {
        if (!firstByte) firstByte = performance.now();
        bytes += chunk.length;
      });
      res.on("end", () => {
        resolve({
          dnsMs: Math.round(dnsEnd - start),
          connectMs: Math.round(connectEnd - (dnsEnd || start)),
          tlsMs: Math.round((tlsEnd - connectEnd) || 0),
          ttfbMs: Math.round((firstByte || performance.now()) - start),
          totalMs: Math.round(performance.now() - start),
          statusCode: res.statusCode,
          bytes,
        });
      });
    });
    req.on("socket", (socket) => {
      socket.on("lookup", () => { dnsEnd = performance.now(); });
      socket.on("connect", () => { connectEnd = performance.now(); });
      socket.on("secureConnect", () => { tlsEnd = performance.now(); });
    });
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.on("error", () => {
      resolve({ dnsMs: 0, connectMs: 0, tlsMs: 0, ttfbMs: 0, totalMs: Math.round(performance.now() - start), statusCode: 0 });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function benchHttp(url: string, label: string, samples: number = SAMPLES): Promise<Record<string, Record<string, number>>> {
  const totals: number[] = [];
  const dnss: number[] = [];
  const connects: number[] = [];
  const ttfbs: number[] = [];
  for (let i = 0; i < samples; i++) {
    const r = await timedRequest(url);
    if (r.statusCode && r.statusCode >= 200 && r.statusCode < 500) {
      totals.push(r.totalMs); dnss.push(r.dnsMs); connects.push(r.connectMs); ttfbs.push(r.ttfbMs);
    }
  }
  printRow(label + " total", stats(label, totals));
  return { total: stats(label, totals), dns: stats(label, dnss), connect: stats(label, connects), ttfb: stats(label, ttfbs) };
}

async function benchWs(url: string, label: string, samples: number = 5): Promise<Record<string, number>> {
  const conns: number[] = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const closed = await new Promise<number>((resolve) => {
      try {
        const ws = new WebSocket(url, { handshakeTimeout: 10000 });
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(-1); }, 10000);
        ws.on("open", () => {
          const t = Math.round(performance.now() - t0);
          clearTimeout(timer);
          ws.close();
          resolve(t);
        });
        ws.on("error", () => { clearTimeout(timer); resolve(-1); });
      } catch { resolve(-1); }
    });
    if (closed > 0) conns.push(closed);
    await new Promise(r => setTimeout(r, 200));
  }
  const s = stats(label, conns);
  printRow(label, s);
  return s;
}

// --- Kalshi live order test ------------------------------------------------
async function benchKalOrders(): Promise<Record<string, Record<string, number>>> {
  const kalTickerForTest = process.env.BENCH_KAL_TICKER;
  if (!kalTickerForTest) {
    console.log("  (BENCH_KAL_TICKER not set — skipping KAL live order test)");
    return { place: {} as any, cancel: {} as any };
  }
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKey = process.env.KALSHI_PRIVATE_KEY || (process.env.KALSHI_PRIVATE_KEY_PATH ? fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH!, "utf8") : "");
  if (!apiKeyId || !privateKey) {
    console.log("  (missing KALSHI_API_KEY_ID or KALSHI_PRIVATE_KEY — skipping)");
    return { place: {} as any, cancel: {} as any };
  }

  function signKalshi(ts: string, method: string, path: string): string {
    const data = `${ts}${method}${path}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(data); signer.end();
    return signer.sign({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
  }
  async function kalReq(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; ms: number }> {
    const ts = String(Date.now());
    const sig = signKalshi(ts, method, "/trade-api/v2" + path);
    const headers: Record<string, string> = {
      "KALSHI-ACCESS-KEY": apiKeyId!,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "Accept": "application/json",
      "User-Agent": "arb-bench/1.0",
    };
    if (body) headers["Content-Type"] = "application/json";
    const t0 = performance.now();
    const r = await new Promise<{ status: number; body: any }>((resolve) => {
      const url = new URL(KAL_BASE + path);
      const req = https.request({
        method, hostname: url.hostname, port: 443, path: url.pathname + url.search, headers,
      }, (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      });
      req.on("error", () => resolve({ status: 0, body: null }));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
    return { ...r, ms: Math.round(performance.now() - t0) };
  }

  const places: number[] = [];
  const cancels: number[] = [];
  // Place GTC BUY YES @ 1¢ (far below any realistic ask; will never fill).
  // Cancel immediately. Repeat SAMPLES times.
  for (let i = 0; i < SAMPLES; i++) {
    const placeBody = {
      ticker: kalTickerForTest,
      action: "buy", side: "yes",
      type: "limit", time_in_force: "gtc",
      count: 1, yes_price: 1, // 1¢ = won't match
      client_order_id: "bench-" + Date.now() + "-" + i,
    };
    const place = await kalReq("POST", "/portfolio/orders", placeBody);
    places.push(place.ms);
    const orderId = place.body?.order?.order_id;
    if (orderId && place.status === 200 || place.status === 201) {
      const cancel = await kalReq("DELETE", "/portfolio/orders/" + orderId);
      cancels.push(cancel.ms);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const ps = stats("KAL place GTC", places);
  const cs = stats("KAL cancel GTC", cancels);
  printRow("KAL place GTC (roundtrip)", ps);
  printRow("KAL cancel GTC (roundtrip)", cs);
  return { place: ps, cancel: cs } as any;
}

// --- Polymarket live order test --------------------------------------------
async function benchPmOrders(): Promise<Record<string, Record<string, number>>> {
  const tokenId = process.env.BENCH_PM_TOKEN_ID;
  if (!tokenId) {
    console.log("  (BENCH_PM_TOKEN_ID not set — skipping PM live order test)");
    return { place: {} as any, cancel: {} as any };
  }
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) { console.log("  (missing POLY_WALLET_PRIVATE_KEY — skipping)"); return { place: {} as any, cancel: {} as any }; }

  const wallet = new Wallet(pk);
  const funder = process.env.POLY_FUNDER || wallet.address;
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const creds = await resolvePolyApiCreds({ host: PM_CLOB, chainId, sigType, wallet });
  const client = new ClobClient(PM_CLOB, chainId, wallet, creds, sigType, funder);

  const places: number[] = [];
  const cancels: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const t0 = performance.now();
      const order = await (client as any).createOrder(
        { tokenID: tokenId, price: 0.01, side: Side.BUY, size: 5 },
        { tickSize: "0.01", negRisk: false }
      );
      const r = await (client as any).postOrder(order, OrderType.GTC);
      const placeMs = Math.round(performance.now() - t0);
      places.push(placeMs);
      const orderId = r?.orderID ?? r?.orderId ?? "";
      if (orderId) {
        const t1 = performance.now();
        await (client as any).cancelOrder({ orderID: orderId });
        cancels.push(Math.round(performance.now() - t1));
      }
    } catch (e: any) {
      console.warn("  [PM] iter " + i + " error: " + e.message?.slice(0, 80));
    }
    await new Promise(r => setTimeout(r, 500));
  }
  const ps = stats("PM place GTC", places);
  const cs = stats("PM cancel GTC", cancels);
  printRow("PM place GTC (roundtrip)", ps);
  printRow("PM cancel GTC (roundtrip)", cs);
  return { place: ps, cancel: cs } as any;
}

// --- Polygon RPC test ------------------------------------------------------
async function benchRpc(): Promise<Record<string, number>> {
  if (!POLY_RPC) { console.log("  (POLY_RPC_URL not set — skipping RPC test)"); return {} as any; }
  const times: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const r = await new Promise<boolean>((resolve) => {
      const url = new URL(POLY_RPC);
      const lib = url.protocol === "https:" ? https : http;
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
      const req = lib.request({
        method: "POST", hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() },
      }, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(res.statusCode === 200));
      });
      req.on("error", () => resolve(false));
      req.write(body); req.end();
    });
    if (r) times.push(Math.round(performance.now() - t0));
    await new Promise(r => setTimeout(r, 200));
  }
  const s = stats("Polygon RPC eth_blockNumber", times);
  printRow("Polygon RPC eth_blockNumber", s);
  return s as any;
}

// --- Main ------------------------------------------------------------------
async function main() {
  const start = Date.now();
  const report: Record<string, any> = {
    location: LOCATION,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model,
    ts: new Date().toISOString(),
    samples: SAMPLES,
  };
  console.log("=== ARB SPEED BENCHMARK ===");
  console.log("Location tag:", LOCATION);
  console.log("Hostname    :", os.hostname(), "  CPU:", os.cpus()[0]?.model);
  console.log("Samples per test:", SAMPLES);
  console.log();

  console.log("--- HTTP endpoints (DNS+connect+TLS+response) ---");
  report.kalshi_markets = await benchHttp(KAL_BASE + "/markets?limit=1", "Kalshi /markets");
  report.pm_clob = await benchHttp(PM_CLOB + "/ok", "PM CLOB /ok");
  report.pm_gamma = await benchHttp(PM_GAMMA + "/events?limit=1", "PM gamma /events");
  report.pm_data_api = await benchHttp(PM_DATA_API + "/positions?user=0x0000000000000000000000000000000000000000", "PM data-api /positions");

  console.log();
  console.log("--- WebSocket connect times ---");
  report.kalshi_ws = await benchWs(KAL_WS, "Kalshi WS connect");
  report.pm_ws = await benchWs(PM_WS_MARKET, "PM WS connect");

  console.log();
  console.log("--- Polygon RPC ---");
  report.polygon_rpc = await benchRpc();

  if (!SKIP_LIVE) {
    console.log();
    console.log("--- Kalshi live order (1¢ BUY YES, never fills) ---");
    report.kal_orders = await benchKalOrders();
    console.log();
    console.log("--- Polymarket live order (1¢ BUY, never fills) ---");
    report.pm_orders = await benchPmOrders();
  } else {
    console.log("\n(SKIP_LIVE=true — skipping live order tests)");
  }

  console.log();
  console.log("=== SUMMARY for " + LOCATION + " ===");
  const h = report.kalshi_markets?.total ?? {};
  const p = report.pm_clob?.total ?? {};
  const kw = report.kalshi_ws ?? {};
  const pw = report.pm_ws ?? {};
  const rpc = report.polygon_rpc ?? {};
  console.log("  KAL API total p50=" + (h.p50 || "-") + "ms  PM CLOB total p50=" + (p.p50 || "-") + "ms");
  console.log("  KAL WS p50=" + (kw.p50 || "-") + "ms  PM WS p50=" + (pw.p50 || "-") + "ms");
  console.log("  Polygon RPC p50=" + (rpc.p50 || "-") + "ms");
  if (report.kal_orders?.place?.p50) console.log("  KAL order place p50=" + report.kal_orders.place.p50 + "ms");
  if (report.pm_orders?.place?.p50) console.log("  PM order place p50=" + report.pm_orders.place.p50 + "ms");
  console.log("  Total bench time: " + Math.round((Date.now() - start)/1000) + "s");

  const outFile = "bench-" + LOCATION.replace(/[^a-zA-Z0-9-]/g, "_") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log();
  console.log("Full report written to: " + outFile);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
