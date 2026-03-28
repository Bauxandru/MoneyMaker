import "dotenv/config";
import crypto from "crypto";
import fs from "fs";

// ─── Auth (copied from kalshiTrade.ts to keep this standalone) ───────────────

let _cachedPrivateKey: string | null = null;
function loadPrivateKey(): string {
  if (_cachedPrivateKey) return _cachedPrivateKey;
  if (process.env.KALSHI_PRIVATE_KEY) {
    _cachedPrivateKey = process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  } else {
    const p = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
    _cachedPrivateKey = fs.readFileSync(p, "utf8");
  }
  return _cachedPrivateKey;
}

function baseUrl() {
  return process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
}

function signRequest(method: string, path: string, timestamp: string, privateKeyPem: string) {
  const data = `${timestamp}${method.toUpperCase()}${path}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer.sign(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    "base64"
  );
}

async function kalshiSignedFetchRaw(method: "GET" | "DELETE", path: string): Promise<string> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error("Missing KALSHI_API_KEY_ID.");
  const privateKey = loadPrivateKey();
  const fullUrl = new URL(`${baseUrl()}${path}`);
  const timestamp = Date.now().toString();
  const signature = signRequest(method, fullUrl.pathname, timestamp, privateKey);
  const res = await fetch(fullUrl.toString(), {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  return text;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Fetching open KXATPMATCH markets (limit=5) ===\n");

  const marketsRaw = await kalshiSignedFetchRaw(
    "GET",
    "/markets?series_ticker=KXATPMATCH&status=open&limit=5"
  );
  const marketsJson = JSON.parse(marketsRaw);
  const markets: Record<string, unknown>[] = marketsJson.markets ?? [];

  if (markets.length === 0) {
    console.log("No open KXATPMATCH markets found. Trying KXCS2GAME...\n");
    const fallback = await kalshiSignedFetchRaw(
      "GET",
      "/markets?series_ticker=KXCS2GAME&status=open&limit=5"
    );
    const fbJson = JSON.parse(fallback);
    markets.push(...(fbJson.markets ?? []));
  }

  if (markets.length === 0) {
    console.log("No open markets found in either series. Exiting.");
    return;
  }

  console.log(`Found ${markets.length} markets.\n`);

  // For each market, do three fetches
  for (const m of markets.slice(0, 3)) {
    const ticker = String(m.ticker ?? "");
    console.log("━".repeat(80));
    console.log(`MARKET: ${ticker}`);
    console.log(`  title:    ${m.title}`);
    console.log(`  yes_ask:  ${m.yes_ask}   yes_bid:  ${m.yes_bid}`);
    console.log(`  no_ask:   ${m.no_ask}    no_bid:   ${m.no_bid}`);
    console.log(`  volume:   ${m.volume}    open_interest: ${m.open_interest}`);

    // Also log any "dollars" fields if they exist
    for (const k of Object.keys(m as object)) {
      if (k.includes("dollar") || k.includes("ask") || k.includes("bid") || k.includes("depth") || k.includes("size") || k.includes("liquidity")) {
        if (!["yes_ask", "yes_bid", "no_ask", "no_bid"].includes(k)) {
          console.log(`  ${k}: ${(m as Record<string, unknown>)[k]}`);
        }
      }
    }

    // ─── 1. Single market endpoint ───
    console.log(`\n  --- /markets/${ticker} (single market) ---`);
    try {
      const singleRaw = await kalshiSignedFetchRaw("GET", `/markets/${ticker}`);
      console.log(`  RAW (first 2000 chars):\n${singleRaw.slice(0, 2000)}\n`);
    } catch (e) {
      console.log(`  ERROR: ${e}`);
    }

    await sleep(200);

    // ─── 2. Orderbook (no depth param) ───
    console.log(`  --- /markets/${ticker}/orderbook (default) ---`);
    try {
      const bookRaw = await kalshiSignedFetchRaw("GET", `/markets/${ticker}/orderbook`);
      console.log(`  RAW:\n${bookRaw.slice(0, 3000)}\n`);
    } catch (e) {
      console.log(`  ERROR: ${e}`);
    }

    await sleep(200);

    // ─── 3. Orderbook with ?depth=10 ───
    console.log(`  --- /markets/${ticker}/orderbook?depth=10 ---`);
    try {
      const bookDepthRaw = await kalshiSignedFetchRaw("GET", `/markets/${ticker}/orderbook?depth=10`);
      console.log(`  RAW:\n${bookDepthRaw.slice(0, 3000)}\n`);
    } catch (e) {
      console.log(`  ERROR: ${e}`);
    }

    await sleep(200);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
