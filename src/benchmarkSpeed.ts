/**
 * benchmarkSpeed.ts -- Comprehensive latency audit for Kalshi + Polymarket + Polygon.
 *
 * Measures every hop the arb bot uses: DNS, TCP connect, HTTP REST, WS connect,
 * WS ping RTT, signed auth overhead. Runs from wherever invoked so you can
 * compare home vs Toronto VPS.
 *
 * Tags results with SERVER_ID (from .env) and hostname, writes JSON to
 * data/latency_<SERVER_ID>_<timestamp>.json for cross-server comparison.
 *
 * Usage:
 *   npx tsx src/benchmarkSpeed.ts                       # full suite
 *   npx tsx src/benchmarkSpeed.ts --iters=20            # more iterations
 *   npx tsx src/benchmarkSpeed.ts --compare file1 file2 # diff two runs
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import net from "net";
import { performance } from "perf_hooks";
import { URL } from "url";
import WebSocket from "ws";
import dotenv from "dotenv";
import { Wallet } from "ethers";

dotenv.config();

// --- CLI --------------------------------------------------------------------
const args = process.argv.slice(2);
if (args[0] === "--compare" && args.length >= 3) {
  compareReports(args[1], args[2]);
  process.exit(0);
}
const ITERS = (() => {
  const a = args.find((s) => s.startsWith("--iters="));
  return a ? Math.max(3, Number(a.split("=")[1]) || 10) : 10;
})();

// --- Types ------------------------------------------------------------------
type Sample = { min: number; p50: number; p95: number; max: number; avg: number; n: number };
type Report = {
  serverId: string;
  hostname: string;
  startedAt: string;
  completedAt: string;
  iterations: number;
  results: Record<string, Sample>;
  notes: string[];
};

// --- Stats helpers ----------------------------------------------------------
function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
function stats(samples: number[]): Sample {
  const s = [...samples].sort((a, b) => a - b);
  return {
    min: s[0],
    p50: pct(s, 0.5),
    p95: pct(s, 0.95),
    max: s[s.length - 1],
    avg: s.reduce((a, b) => a + b, 0) / s.length,
    n: s.length,
  };
}
async function bench(label: string, fn: () => Promise<void>, iters: number, acc: Record<string, Sample>): Promise<void> {
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    try { await fn(); } catch { /* error = slow-path sample; still record */ }
    samples.push(performance.now() - t0);
  }
  acc[label] = stats(samples);
  const s = acc[label];
  console.log(
    `  ${label.padEnd(44)} ${fmt(s.min)} ${fmt(s.p50)} ${fmt(s.p95)} ${fmt(s.max)}`
  );
}
function fmt(n: number): string {
  return `${n.toFixed(0)}ms`.padStart(8);
}

// --- TCP connect latency (raw kernel round-trip) ----------------------------
async function tcpConnect(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sock = new net.Socket();
    const t = setTimeout(() => { sock.destroy(); reject(new Error("tcp-timeout")); }, 10_000);
    sock.once("connect", () => { clearTimeout(t); sock.end(); resolve(); });
    sock.once("error", (e) => { clearTimeout(t); reject(e); });
    sock.connect(port, host);
  });
}

// --- WS connect + ping RTT --------------------------------------------------
async function wsConnectPing(url: string, opts?: { headers?: Record<string, string>; authMsg?: string }): Promise<{ connectMs: number; pingMs: number }> {
  const tStart = performance.now();
  const ws = new WebSocket(url, opts?.headers ? { headers: opts.headers } : undefined);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => { ws.close(); reject(new Error("ws-connect-timeout")); }, 10_000);
    ws.once("open", () => { clearTimeout(t); resolve(); });
    ws.once("error", (e) => { clearTimeout(t); reject(e); });
  });
  const connectMs = performance.now() - tStart;

  if (opts?.authMsg) ws.send(opts.authMsg);

  // Ping RTT: send PING, await first non-PONG text or use native ping
  const tPing = performance.now();
  let pingMs = 0;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { resolve(); }, 3000);
    const onMsg = () => { pingMs = performance.now() - tPing; clearTimeout(t); ws.off("message", onMsg); resolve(); };
    ws.on("message", onMsg);
    ws.send("PING"); // Kalshi/PM text protocol accepts this
  });

  ws.close();
  return { connectMs, pingMs };
}

// --- Kalshi signed request --------------------------------------------------
function loadKalshiPk(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (p && fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  return "";
}
function kalshiSign(method: string, path: string, ts: string, pem: string): string {
  const s = crypto.createSign("RSA-SHA256");
  s.update(`${ts}${method.toUpperCase()}${path}`);
  s.end();
  return s.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

// --- Main benchmark suite ---------------------------------------------------
async function main() {
  const serverId = process.env.SERVER_ID || "unknown";
  const report: Report = {
    serverId,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    completedAt: "",
    iterations: ITERS,
    results: {},
    notes: [],
  };

  console.log(`\n=== Speed Audit: server=${serverId} host=${os.hostname()} iters=${ITERS} ===\n`);
  console.log(`  ${"Measurement".padEnd(44)} ${"min".padStart(8)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}`);
  console.log("  " + "─".repeat(80));

  // --- TCP connect hops (raw network latency to each host) ---
  const tcpTargets: Array<[string, string, number]> = [
    ["TCP api.elections.kalshi.com:443", "api.elections.kalshi.com", 443],
    ["TCP clob.polymarket.com:443", "clob.polymarket.com", 443],
    ["TCP gamma-api.polymarket.com:443", "gamma-api.polymarket.com", 443],
    ["TCP polygon-rpc.com:443", "polygon-rpc.com", 443],
  ];
  for (const [label, host, port] of tcpTargets) {
    await bench(label, async () => { await tcpConnect(host, port); }, ITERS, report.results);
  }

  // --- HTTP REST round-trips (includes TLS + HTTP overhead) ---
  await bench("HTTP GET kalshi /markets?limit=1",
    async () => { const r = await fetch("https://api.elections.kalshi.com/trade-api/v2/markets?limit=1"); await r.text(); },
    ITERS, report.results);

  await bench("HTTP GET gamma /markets?limit=1",
    async () => { const r = await fetch("https://gamma-api.polymarket.com/markets?limit=1"); await r.text(); },
    ITERS, report.results);

  await bench("HTTP POST polygon-rpc eth_blockNumber",
    async () => {
      const r = await fetch("https://polygon-rpc.com", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      await r.text();
    }, ITERS, report.results);

  // --- Kalshi signed auth (RSA sign + HTTP) ---
  const pk = loadKalshiPk();
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (pk && keyId) {
    await bench("CPU: RSA-SHA256 sign",
      async () => { kalshiSign("GET", "/trade-api/v2/markets", Date.now().toString(), pk); },
      Math.max(ITERS, 100), report.results);

    await bench("HTTP GET kalshi /portfolio/balance (signed)",
      async () => {
        const ts = Date.now().toString();
        const sig = kalshiSign("GET", "/trade-api/v2/portfolio/balance", ts, pk);
        const r = await fetch("https://api.elections.kalshi.com/trade-api/v2/portfolio/balance", {
          headers: {
            "KALSHI-ACCESS-KEY": keyId,
            "KALSHI-ACCESS-SIGNATURE": sig,
            "KALSHI-ACCESS-TIMESTAMP": ts,
          },
        });
        await r.text();
      }, ITERS, report.results);
  } else {
    report.notes.push("Kalshi signed auth skipped (missing KALSHI_PRIVATE_KEY/KEY_ID)");
  }

  // --- PM CLOB book fetch (needs a token). Use a random active market. ---
  try {
    const r = await fetch("https://gamma-api.polymarket.com/markets?limit=1&active=true&archived=false&closed=false");
    const arr = await r.json();
    const m = Array.isArray(arr) ? arr[0] : null;
    const tokenId = m?.clobTokenIds ? (typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds)?.[0] : null;
    if (tokenId) {
      await bench("HTTP GET clob /book?token_id=...",
        async () => { const b = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`); await b.text(); },
        ITERS, report.results);
    } else {
      report.notes.push("PM book skipped: no active token");
    }
  } catch (e) {
    report.notes.push(`PM book skipped: ${(e as Error).message}`);
  }

  // --- PM data-api positions (needs funder) ---
  if (process.env.POLY_WALLET_PRIVATE_KEY) {
    try {
      const w = new Wallet(process.env.POLY_WALLET_PRIVATE_KEY);
      const funder = process.env.POLY_FUNDER || w.address;
      await bench("HTTP GET data-api /positions?user=...",
        async () => {
          const r = await fetch(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.1`);
          await r.text();
        }, ITERS, report.results);
    } catch { /* ignore */ }
  }

  // --- Kalshi WS connect + ping ---
  console.log("\n  --- WebSocket connect + ping RTT (single-shot, not averaged) ---");
  if (pk && keyId) {
    try {
      const ts = Date.now().toString();
      const sig = kalshiSign("GET", "/trade-api/ws/v2", ts, pk);
      const url = "wss://api.elections.kalshi.com/trade-api/ws/v2";
      const { connectMs, pingMs } = await wsConnectPing(url, {
        headers: {
          "KALSHI-ACCESS-KEY": keyId,
          "KALSHI-ACCESS-SIGNATURE": sig,
          "KALSHI-ACCESS-TIMESTAMP": ts,
        },
      });
      report.results["WS Kalshi connect"] = stats([connectMs]);
      report.results["WS Kalshi ping RTT"] = stats([pingMs]);
      console.log(`  WS Kalshi connect                             ${fmt(connectMs)}`);
      console.log(`  WS Kalshi ping RTT                            ${fmt(pingMs)}`);
    } catch (e) {
      report.notes.push(`Kalshi WS failed: ${(e as Error).message}`);
      console.log(`  WS Kalshi: ${(e as Error).message}`);
    }
  }

  // --- PM public WS (orderbook) ---
  try {
    const { connectMs, pingMs } = await wsConnectPing("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    report.results["WS PM market connect"] = stats([connectMs]);
    report.results["WS PM market ping RTT"] = stats([pingMs]);
    console.log(`  WS PM market connect                          ${fmt(connectMs)}`);
    console.log(`  WS PM market ping RTT                         ${fmt(pingMs)}`);
  } catch (e) {
    report.notes.push(`PM market WS failed: ${(e as Error).message}`);
  }

  // --- PM user WS ---
  try {
    const { connectMs } = await wsConnectPing("wss://ws-subscriptions-clob.polymarket.com/ws/user");
    report.results["WS PM user connect"] = stats([connectMs]);
    console.log(`  WS PM user connect                            ${fmt(connectMs)}`);
  } catch (e) {
    report.notes.push(`PM user WS failed: ${(e as Error).message}`);
  }

  // --- Summary + save ---
  report.completedAt = new Date().toISOString();

  if (!fs.existsSync("data")) fs.mkdirSync("data", { recursive: true });
  const outPath = `data/latency_${serverId}_${report.completedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n  Report written: ${outPath}`);

  if (report.notes.length > 0) {
    console.log("\n  Notes:");
    for (const n of report.notes) console.log(`    - ${n}`);
  }

  // --- Critical-path estimate for the arb execution pipeline ---
  const r = report.results;
  const kalBook = r["HTTP GET kalshi /portfolio/balance (signed)"]?.p50 ?? 0;
  const kalOrderEst = kalBook; // same RTT profile
  const pmBook = r["HTTP GET clob /book?token_id=..."]?.p50 ?? 0;
  const polygon = r["HTTP POST polygon-rpc eth_blockNumber"]?.p50 ?? 0;
  console.log("\n=== Critical-path estimate (median) ===");
  console.log(`  KAL IOC dispatch ≈ ${kalBook.toFixed(0)}ms + sign (~${r["CPU: RSA-SHA256 sign"]?.p50?.toFixed(1) ?? "?"}ms)`);
  console.log(`  KAL verify poll  ≈ ${kalOrderEst.toFixed(0)}ms`);
  console.log(`  PM FAK dispatch  ≈ ${pmBook.toFixed(0)}ms + CLOB signing overhead`);
  console.log(`  Polygon RPC      ≈ ${polygon.toFixed(0)}ms`);
  console.log(`  Est sequential total ≈ ${(kalBook + kalOrderEst + pmBook + polygon).toFixed(0)}ms round-trip`);
  console.log(`  Est parallel total   ≈ max(${kalBook.toFixed(0)}, ${pmBook.toFixed(0)}) + verify ≈ ${(Math.max(kalBook, pmBook) + kalOrderEst).toFixed(0)}ms\n`);

  console.log("To compare with another server, run the same command on it, then:");
  console.log(`  npx tsx src/benchmarkSpeed.ts --compare <this-file> <other-file>\n`);
}

// --- Report diff ------------------------------------------------------------
function compareReports(pathA: string, pathB: string): void {
  const a: Report = JSON.parse(fs.readFileSync(pathA, "utf8"));
  const b: Report = JSON.parse(fs.readFileSync(pathB, "utf8"));

  console.log(`\n=== Compare: ${a.serverId} (${a.hostname}) vs ${b.serverId} (${b.hostname}) ===\n`);
  console.log(
    `  ${"Measurement".padEnd(44)} ${("p50 " + a.serverId).padStart(14)} ${("p50 " + b.serverId).padStart(14)} ${"Δ".padStart(10)}`
  );
  console.log("  " + "─".repeat(86));

  const allKeys = new Set([...Object.keys(a.results), ...Object.keys(b.results)]);
  for (const k of allKeys) {
    const aV = a.results[k]?.p50;
    const bV = b.results[k]?.p50;
    const aStr = aV !== undefined ? `${aV.toFixed(0)}ms`.padStart(12) : "—".padStart(12);
    const bStr = bV !== undefined ? `${bV.toFixed(0)}ms`.padStart(12) : "—".padStart(12);
    const d = (aV !== undefined && bV !== undefined) ? (bV - aV) : null;
    const dStr = d === null ? "—".padStart(10) : ((d > 0 ? "+" : "") + d.toFixed(0) + "ms").padStart(10);
    const winner = d === null ? "" : (Math.abs(d) < 5 ? "" : d > 0 ? "  ← " + a.serverId + " faster" : "  ← " + b.serverId + " faster");
    console.log(`  ${k.padEnd(44)} ${aStr}   ${bStr}   ${dStr}${winner}`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
