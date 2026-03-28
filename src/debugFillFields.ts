/**
 * debugFillFields.ts — Dump raw Kalshi fill fields to see what's available (fees, etc.)
 * Usage: npx tsx src/debugFillFields.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { fetchJsonWithRetry } from "./http.js";
import crypto from "crypto";
import fs from "fs";

function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
  return fs.readFileSync(p, "utf8");
}

function signRequest(method: string, path: string, timestamp: string, privateKeyPem: string) {
  const data = `${timestamp}${method.toUpperCase()}${path}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer.sign({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

const baseUrl = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const keyId = process.env.KALSHI_API_KEY_ID!;
const pk = loadPrivateKey();

async function kalGet(path: string) {
  const url = new URL(`${baseUrl}${path}`);
  const ts = Date.now().toString();
  const sig = signRequest("GET", url.pathname, ts, pk);
  return fetchJsonWithRetry(url.toString(), {
    method: "GET",
    headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts }
  }, { timeoutMs: 10000, maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5000, jitterMs: 100 });
}

// Get first few fills and dump ALL fields
const res = await kalGet("/portfolio/fills?limit=5") as Record<string, unknown>;
const fills = (Array.isArray(res.fills) ? res.fills : []) as Record<string, unknown>[];
console.log(`\n=== RAW FILL FIELDS (first ${fills.length} fills) ===\n`);
for (const f of fills) {
  console.log(JSON.stringify(f, null, 2));
  console.log("---");
}

// Also check a position to see total_traded vs fees
const posRes = await kalGet("/portfolio/positions?count_filter=position&limit=3") as Record<string, unknown>;
const positions = (Array.isArray(posRes.market_positions) ? posRes.market_positions : []) as Record<string, unknown>[];
console.log(`\n=== RAW POSITION FIELDS (first ${positions.length}) ===\n`);
for (const p of positions) {
  console.log(JSON.stringify(p, null, 2));
  console.log("---");
}

// Also check a settlement
const setRes = await kalGet("/portfolio/settlements?limit=3") as Record<string, unknown>;
const settlements = (Array.isArray(setRes.settlements) ? setRes.settlements : []) as Record<string, unknown>[];
console.log(`\n=== RAW SETTLEMENT FIELDS (first ${settlements.length}) ===\n`);
for (const s of settlements) {
  console.log(JSON.stringify(s, null, 2));
  console.log("---");
}
