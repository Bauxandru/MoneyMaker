/**
 * Rate limit test: fire requests at 10ms intervals to both APIs.
 * Run: npx tsx src/_rateTest.ts
 */
import crypto from "crypto";
import fs from "fs";
import { performance } from "perf_hooks";
import { fetchJson } from "./http.js";
import dotenv from "dotenv";
dotenv.config();

type AnyRecord = Record<string, unknown>;

// ── Kalshi auth ──
function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
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

async function kalshiGet(apiPath: string): Promise<AnyRecord> {
  const keyId = process.env.KALSHI_API_KEY_ID!;
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
      "Content-Type": "application/json",
    },
  }) as Promise<AnyRecord>;
}

// ── PM fetch (no auth needed for public book) ──
async function pmGet(tokenId: string): Promise<AnyRecord> {
  return fetchJson(`https://clob.polymarket.com/book?token_id=${tokenId}`) as Promise<AnyRecord>;
}

const INTERVAL_MS = 10;
const NUM_REQUESTS = 50;

async function testKalshi() {
  console.log(`\n=== KALSHI: ${NUM_REQUESTS} requests @ ${INTERVAL_MS}ms interval ===\n`);
  const ticker = "KXATPMATCH"; // series ticker for market list
  let ok = 0, fail = 0, rateLimited = 0;
  const latencies: number[] = [];

  for (let i = 0; i < NUM_REQUESTS; i++) {
    const t0 = performance.now();
    try {
      await kalshiGet(`/markets?series_ticker=${ticker}&status=open&limit=5`);
      const ms = performance.now() - t0;
      latencies.push(ms);
      ok++;
      process.stdout.write(`  #${i + 1} OK ${ms.toFixed(0)}ms\n`);
    } catch (e: any) {
      const ms = performance.now() - t0;
      const msg = e.message || "";
      if (msg.includes("429") || msg.includes("rate") || msg.includes("Too Many")) {
        rateLimited++;
        console.log(`  #${i + 1} RATE LIMITED (${ms.toFixed(0)}ms): ${msg.slice(0, 100)}`);
      } else {
        fail++;
        console.log(`  #${i + 1} ERROR (${ms.toFixed(0)}ms): ${msg.slice(0, 100)}`);
      }
    }
    if (i < NUM_REQUESTS - 1) await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const min = latencies.length ? Math.min(...latencies) : 0;
  const max = latencies.length ? Math.max(...latencies) : 0;
  console.log(`\nKalshi results: ${ok} OK, ${rateLimited} rate-limited, ${fail} errors`);
  console.log(`Latency: avg=${avg.toFixed(0)}ms  min=${min.toFixed(0)}ms  max=${max.toFixed(0)}ms`);
  return rateLimited;
}

async function testPm() {
  console.log(`\n=== POLYMARKET: ${NUM_REQUESTS} requests @ ${INTERVAL_MS}ms interval ===\n`);
  // Use a known token ID from an active market
  let tokenId = "";
  try {
    const resp = await fetch("https://gamma-api.polymarket.com/markets?tag_slug=tennis&active=true&limit=1");
    const markets = (await resp.json()) as AnyRecord[];
    if (markets.length > 0) {
      const ids = String(markets[0].clobTokenIds ?? "").replace(/[\[\]"]/g, "").split(",").map(s => s.trim()).filter(Boolean);
      if (ids.length > 0) tokenId = ids[0];
    }
  } catch {}

  if (!tokenId) {
    // Fallback: use a hardcoded active token
    console.log("  Could not find active PM token, using fallback search...");
    try {
      const resp = await fetch("https://gamma-api.polymarket.com/markets?active=true&limit=1");
      const markets = (await resp.json()) as AnyRecord[];
      if (markets.length > 0) {
        const ids = String(markets[0].clobTokenIds ?? "").replace(/[\[\]"]/g, "").split(",").map(s => s.trim()).filter(Boolean);
        if (ids.length > 0) tokenId = ids[0];
      }
    } catch {}
  }

  if (!tokenId) {
    console.log("  No PM token found, skipping PM test.");
    return 0;
  }
  console.log(`  Using token: ${tokenId.slice(0, 20)}...\n`);

  let ok = 0, fail = 0, rateLimited = 0;
  const latencies: number[] = [];

  for (let i = 0; i < NUM_REQUESTS; i++) {
    const t0 = performance.now();
    try {
      await pmGet(tokenId);
      const ms = performance.now() - t0;
      latencies.push(ms);
      ok++;
      process.stdout.write(`  #${i + 1} OK ${ms.toFixed(0)}ms\n`);
    } catch (e: any) {
      const ms = performance.now() - t0;
      const msg = e.message || "";
      if (msg.includes("429") || msg.includes("rate") || msg.includes("Too Many")) {
        rateLimited++;
        console.log(`  #${i + 1} RATE LIMITED (${ms.toFixed(0)}ms): ${msg.slice(0, 100)}`);
      } else {
        fail++;
        console.log(`  #${i + 1} ERROR (${ms.toFixed(0)}ms): ${msg.slice(0, 100)}`);
      }
    }
    if (i < NUM_REQUESTS - 1) await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const min = latencies.length ? Math.min(...latencies) : 0;
  const max = latencies.length ? Math.max(...latencies) : 0;
  console.log(`\nPM results: ${ok} OK, ${rateLimited} rate-limited, ${fail} errors`);
  console.log(`Latency: avg=${avg.toFixed(0)}ms  min=${min.toFixed(0)}ms  max=${max.toFixed(0)}ms`);
  return rateLimited;
}

async function main() {
  console.log(`Rate Limit Test: ${NUM_REQUESTS} requests per API @ ${INTERVAL_MS}ms intervals\n`);

  const kalRL = await testKalshi();
  const pmRL = await testPm();

  console.log("\n" + "=".repeat(50));
  console.log("SUMMARY");
  console.log("=".repeat(50));
  if (kalRL === 0 && pmRL === 0) {
    console.log(`✓ No rate limiting at ${INTERVAL_MS}ms intervals. Safe to use.`);
  } else {
    console.log(`✗ Rate limited: Kalshi=${kalRL}, PM=${pmRL}. Need longer intervals.`);
  }
}

main().catch(e => console.error("Fatal:", e));
