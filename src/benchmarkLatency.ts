/**
 * Benchmark API latency for each endpoint used during arb execution.
 * Measures raw round-trip time without rate limiter queues.
 *
 * Run: npx tsx src/benchmarkLatency.ts
 */
import crypto from "crypto";
import fs from "fs";
import { performance } from "perf_hooks";
import { Wallet } from "ethers";
import { fetchJson, fetchJsonWithRetry } from "./http.js";
import dotenv from "dotenv";
dotenv.config();

type AnyRecord = Record<string, unknown>;

// --- Kalshi auth (inline, same as kalshiTrade.ts) ----------------------------

function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) {
    return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
  return fs.readFileSync(p, "utf8");
}

const BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

function signRequest(method: string, urlPath: string, timestamp: string, privateKeyPem: string) {
  const data = `${timestamp}${method.toUpperCase()}${urlPath}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer.sign(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    "base64"
  );
}

async function kalshiSignedGet(apiPath: string): Promise<AnyRecord> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error("Missing KALSHI_API_KEY_ID.");
  const privateKey = loadPrivateKey();
  const fullUrl = new URL(`${BASE}${apiPath}`);
  const timestamp = Date.now().toString();
  const sig = signRequest("GET", fullUrl.pathname, timestamp, privateKey);
  return fetchJson(fullUrl.toString(), {
    method: "GET",
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
    },
  }) as Promise<AnyRecord>;
}

// --- Helpers -----------------------------------------------------------------

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function parseDateFromTicker(ticker: string): string {
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  return `20${m[1]}-${MONTHS[m[2].toUpperCase()] ?? "01"}-${m[3].padStart(2, "0")}`;
}

function extractEntityName(title: string): string {
  const m = title.match(/^Will\s+(.+?)\s+win\b/i);
  return m ? m[1].trim() : "";
}

function pmSlugToken(fullName: string): string {
  const last = fullName.trim().split(/\s+/).pop() ?? fullName;
  return last.toLowerCase().slice(0, 7);
}

// --- Benchmark framework -----------------------------------------------------

type BenchResult = {
  label: string;
  samples: number[];
  min: number;
  avg: number;
  max: number;
  p95: number;
};

async function benchmark(
  label: string,
  fn: () => Promise<unknown> | void,
  iterations = 5
): Promise<BenchResult> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p95idx = Math.min(Math.floor(samples.length * 0.95), samples.length - 1);
  return {
    label,
    samples,
    min: samples[0],
    avg: samples.reduce((s, v) => s + v, 0) / samples.length,
    max: samples[samples.length - 1],
    p95: samples[p95idx],
  };
}

function printTable(results: BenchResult[]) {
  const hdr = `${"Endpoint".padEnd(50)} ${"Min".padStart(8)} ${"Avg".padStart(8)} ${"Max".padStart(8)} ${"P95".padStart(8)} ${"N".padStart(4)}`;
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const r of results) {
    console.log(
      `${r.label.padEnd(50)} ${fmt(r.min)} ${fmt(r.avg)} ${fmt(r.max)} ${fmt(r.p95)} ${String(r.samples.length).padStart(4)}`
    );
  }
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`.padStart(8);
}

// --- Main --------------------------------------------------------------------

async function main() {
  console.log("=== API Latency Benchmark ===\n");

  // -- Discovery: find a real open Kalshi match for testing --
  console.log("Finding a live market for testing...\n");

  let kalTicker = "";
  let kalTitle = "";
  let pmTokenId = "";

  // Try each series until we find an open match
  const series = ["KXATPMATCH", "KXWTAMATCH", "KXCS2GAME", "KXLOLGAME", "KXVALGAME"];
  const prefixes: Record<string, string> = {
    KXATPMATCH: "atp", KXWTAMATCH: "wta", KXCS2GAME: "cs2", KXLOLGAME: "lol", KXVALGAME: "valorant",
  };

  for (const s of series) {
    try {
      const url = `${BASE}/markets?series_ticker=${s}&status=open&limit=2`;
      const res = await fetchJsonWithRetry<AnyRecord>(url);
      const markets = Array.isArray(res.markets) ? (res.markets as AnyRecord[]) : [];
      if (markets.length >= 2) {
        kalTicker = String(markets[0].ticker ?? "");
        kalTitle = String(markets[0].title ?? "");
        console.log(`  Found Kalshi: ${kalTicker}  "${kalTitle}"`);

        // Build PM slug
        const name1 = extractEntityName(String(markets[0].title ?? ""));
        const name2 = extractEntityName(String(markets[1].title ?? ""));
        const date = parseDateFromTicker(kalTicker);
        const prefix = prefixes[s] ?? "atp";
        const tokens = [pmSlugToken(name1), pmSlugToken(name2)].sort();
        const slug = `${prefix}-${tokens.join("-")}-${date}`;
        console.log(`  PM slug guess: ${slug}`);

        // Try to fetch PM market
        try {
          const pmRes = await fetchJsonWithRetry<AnyRecord[]>(
            `https://gamma-api.polymarket.com/markets?slug=${slug}`
          );
          const pmMarket = Array.isArray(pmRes) ? pmRes[0] : null;
          if (pmMarket) {
            const clobIds = pmMarket.clobTokenIds as string[] | undefined;
            if (clobIds && clobIds.length > 0) {
              pmTokenId = clobIds[0];
              console.log(`  Found PM token: ${pmTokenId.slice(0, 30)}...`);
            }
          }
        } catch {
          console.log("  PM slug lookup failed -- will skip PM book benchmark.");
        }
        break;
      }
    } catch (e) {
      console.log(`  ${s}: ${(e as Error).message}`);
    }
  }

  if (!kalTicker) {
    console.error("\nNo open Kalshi markets found. Cannot benchmark.");
    return;
  }

  const results: BenchResult[] = [];
  const iters = 5;

  // -- 1) Kalshi batch market scan --
  console.log(`\nBenchmarking (${iters} iterations each)...\n`);

  const seriesUsed = kalTicker.split("-")[0];
  results.push(await benchmark(
    `KAL GET /markets?series_ticker=${seriesUsed}`,
    () => fetchJsonWithRetry(`${BASE}/markets?series_ticker=${seriesUsed}&status=open&limit=200`),
    iters
  ));

  // -- 2) Kalshi individual market --
  results.push(await benchmark(
    `KAL GET /markets/${kalTicker.slice(0, 25)}...`,
    () => fetchJsonWithRetry(`${BASE}/markets/${kalTicker}`),
    iters
  ));

  // -- 3) Kalshi orderbook (authenticated) --
  results.push(await benchmark(
    `KAL GET /markets/{ticker}/orderbook (auth)`,
    () => kalshiSignedGet(`/markets/${kalTicker}/orderbook`),
    iters
  ));

  // -- 4) PM CLOB book --
  if (pmTokenId) {
    results.push(await benchmark(
      `PM GET /book?token_id=...`,
      () => fetchJsonWithRetry(`https://clob.polymarket.com/book?token_id=${pmTokenId}`),
      iters
    ));
  } else {
    console.log("  Skipping PM book (no token ID found)\n");
  }

  // -- 5) PM positions (data API) --
  try {
    const w = new Wallet(process.env.POLY_WALLET_PRIVATE_KEY ?? "");
    const funder = process.env.POLY_FUNDER || w.address;
    const db = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
    results.push(await benchmark(
      `PM GET /positions?user=...`,
      async () => {
        const res = await fetch(`${db}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.1`);
        await res.json();
      },
      iters
    ));
  } catch {
    console.log("  Skipping PM positions (no wallet key)\n");
  }

  // -- 6) RSA-SHA256 signature (CPU only) --
  const pk = loadPrivateKey();
  results.push(await benchmark(
    `RSA-SHA256 signRequest (CPU only)`,
    () => { signRequest("GET", "/trade-api/v2/markets/test", Date.now().toString(), pk); },
    100
  ));

  // -- Results --
  console.log("\n=== Results ===\n");
  printTable(results);

  // -- Critical path estimates --
  const kalBook = results.find(r => r.label.includes("orderbook"))?.avg ?? 0;
  const kalOrder = results.find(r => r.label.includes("orderbook"))?.avg ?? 0; // proxy: same server
  const kalVerify = results.find(r => r.label.includes("orderbook"))?.avg ?? 0; // proxy
  const pmBook = results.find(r => r.label.includes("/book"))?.avg ?? 0;
  const pmPositions = results.find(r => r.label.includes("/positions"))?.avg ?? 0;
  const signCpu = results.find(r => r.label.includes("CPU"))?.avg ?? 0;

  console.log("\n=== Critical Path Estimates ===\n");
  console.log("  PM-first:  PM_FOK + KAL_book + KAL_IOC + KAL_verify + PM_verify");
  console.log(`  Estimate:  ~${pmBook.toFixed(0)} + ${kalBook.toFixed(0)} + ${kalOrder.toFixed(0)} + ${kalVerify.toFixed(0)} + ${pmPositions.toFixed(0)} = ~${(pmBook + kalBook + kalOrder + kalVerify + pmPositions).toFixed(0)}ms`);
  console.log(`  (PM FOK uses ClobClient, actual latency higher than raw book fetch)`);
  console.log(`  (Each KAL auth call adds ~${signCpu.toFixed(1)}ms CPU for signing)`);

  console.log("\n  KAL-first: KAL_book + KAL_IOC + KAL_verify + PM_FOK + PM_verify");
  console.log(`  Estimate:  ~${kalBook.toFixed(0)} + ${kalOrder.toFixed(0)} + ${kalVerify.toFixed(0)} + ${pmBook.toFixed(0)} + ${pmPositions.toFixed(0)} = ~${(kalBook + kalOrder + kalVerify + pmBook + pmPositions).toFixed(0)}ms`);

  console.log("\n  Note: PM FOK/ClobClient signing adds overhead not captured here.");
  console.log("  Use [TIMING] logs from live trading for ground truth.\n");

  console.log("=== Done ===");
}

main().catch(console.error);
