/**
 * Quick P&L checker — queries Kalshi fills + PM positions to estimate profit.
 * Run: npx tsx src/checkPnL.ts
 */
import crypto from "crypto";
import fs from "fs";
import { Wallet } from "ethers";
import { fetchJson } from "./http.js";
import dotenv from "dotenv";
dotenv.config();

// ─── Kalshi auth (exact copy from kalshiTrade.ts) ─────────────────────────────

function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) {
    return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
  return fs.readFileSync(p, "utf8");
}

const BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

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

async function kalshiGet(path: string): Promise<Record<string, unknown>> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error("Missing KALSHI_API_KEY_ID.");
  const privateKey = loadPrivateKey();
  const fullUrl = new URL(`${BASE}${path}`);
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
  }) as Promise<Record<string, unknown>>;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== P&L Check ===\n");

  // 1) Kalshi balance
  console.log("── Kalshi Account ──");
  try {
    const bal = await kalshiGet("/portfolio/balance");
    console.log(`  Raw: ${JSON.stringify(bal).slice(0, 300)}`);
    const cents = Number(bal.balance ?? 0);
    console.log(`  Balance: $${(cents / 100).toFixed(2)}`);
  } catch (e) {
    console.error(`  Balance error: ${(e as Error).message}`);
  }

  // 2) Kalshi fills
  console.log("\n── Kalshi Fills ──");
  try {
    const fills = await kalshiGet("/portfolio/fills?limit=200");
    const items = (Array.isArray(fills.fills) ? fills.fills :
                   Array.isArray(fills.data) ? fills.data : []) as Record<string, unknown>[];
    console.log(`  Total fills: ${items.length}`);

    let totalSpent = 0;   // cents paid for buys
    let totalRevenue = 0; // cents received from sells

    for (const f of items) {
      const ticker = String(f.ticker ?? "");
      const action = String(f.action ?? "");
      const side = String(f.side ?? "");
      const count = Number(f.count ?? 0);
      const yesPrice = Number(f.yes_price ?? 0);
      const noPrice = Number(f.no_price ?? 0);
      const price = yesPrice || noPrice;
      const cost = count * price;
      const ts = String(f.created_time ?? "").slice(0, 19);
      const isBuy = action === "buy";

      if (isBuy) totalSpent += cost;
      else totalRevenue += cost;

      console.log(`  ${ts}  ${action.toUpperCase().padEnd(4)} ${count}×${side}@${price}¢  $${(cost/100).toFixed(2).padStart(5)}  ${ticker}`);
    }

    console.log(`\n  Kalshi totals: spent=$${(totalSpent / 100).toFixed(2)}  revenue=$${(totalRevenue / 100).toFixed(2)}`);
  } catch (e) {
    console.error(`  Fills error: ${(e as Error).message}`);
  }

  // 3) Kalshi open positions
  console.log("\n── Kalshi Open Positions ──");
  try {
    const pos = await kalshiGet("/portfolio/positions?count_filter=position&limit=200");
    const items = Array.isArray(pos.market_positions)
      ? (pos.market_positions as Record<string, unknown>[])
      : [];
    for (const p of items) {
      const position = Number(p.position ?? 0);
      if (position === 0) continue;
      const ticker = String(p.ticker ?? "");
      const side = position > 0 ? "YES" : "NO";
      const qty = Math.abs(position);
      const totalTraded = Number(p.total_traded ?? 0);
      console.log(`  ${qty}×${side}  ${ticker}  totalTraded=$${(totalTraded/100).toFixed(2)}`);
    }
    if (items.filter(p => Number(p.position ?? 0) !== 0).length === 0) {
      console.log("  (no open positions)");
    }
  } catch (e) {
    console.error(`  Positions error: ${(e as Error).message}`);
  }

  // 4) Kalshi settlements
  console.log("\n── Kalshi Settlements ──");
  try {
    const sett = await kalshiGet("/portfolio/settlements?limit=200");
    const items = (Array.isArray(sett.settlements) ? sett.settlements :
                   Array.isArray(sett.data) ? sett.data : []) as Record<string, unknown>[];
    console.log(`  Total settlements: ${items.length}`);
    let totalSettlementRevenue = 0;
    for (const s of items) {
      const ticker = String(s.ticker ?? s.market_ticker ?? "");
      const revenue = Number(s.revenue ?? 0);
      const count = Number(s.count ?? s.yes_count ?? 0);
      const noCount = Number(s.no_count ?? 0);
      const ts = String(s.settled_time ?? s.created_time ?? "").slice(0, 19);
      totalSettlementRevenue += revenue;
      console.log(`  ${ts}  ${ticker}  ${count > 0 ? count + "×YES" : ""}${noCount > 0 ? noCount + "×NO" : ""}  revenue=$${(revenue / 100).toFixed(2)}`);
    }
    if (items.length === 0) {
      console.log("  (none — markets haven't settled yet)");
      console.log("  Raw: " + JSON.stringify(sett).slice(0, 300));
    } else {
      console.log(`\n  Total settlement revenue: $${(totalSettlementRevenue / 100).toFixed(2)}`);
    }
  } catch (e) {
    console.error(`  Settlements error: ${(e as Error).message}`);
  }

  // 5) Polymarket positions
  console.log("\n── Polymarket Positions ──");
  try {
    const w = new Wallet(process.env.POLY_WALLET_PRIVATE_KEY ?? "");
    const funder = process.env.POLY_FUNDER || w.address;
    const db = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
    const res = await fetch(`${db}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.1`);
    const raw = await res.json();
    const positions: Record<string, unknown>[] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : Array.isArray((raw as Record<string, unknown>)?.positions)
        ? ((raw as Record<string, unknown>).positions as Record<string, unknown>[])
        : [];

    // Separate bot arb trades (size=5 or 10, sports/esports) from manual trades
    console.log(`  Total positions: ${positions.length}\n`);

    let botPaid = 0, botVal = 0;
    let manualPaid = 0, manualVal = 0;

    for (const p of positions) {
      const size = Number(p.size ?? p.amount ?? 0);
      if (size < 0.5) continue;
      const title = String(p.title ?? "").slice(0, 55);
      const outcome = String(p.outcome ?? "");
      const avgPrice = Number(p.avgPrice ?? 0);
      const curPrice = Number(p.curPrice ?? 0);
      const cashPaid = size * avgPrice;
      const curVal = size * curPrice;
      const unrealizedPnl = curVal - cashPaid;
      const cashPnl = Number(p.cashPnl ?? 0);
      const realizedPnl = Number(p.realizedPnl ?? 0);
      const status = curPrice >= 0.99 ? " WON" : curPrice <= 0.01 ? " LOST" : "";

      // Bot trades are typically size=5 (or 10 for doubled positions)
      const isBot = size <= 15 && (
        title.toLowerCase().includes("vs") ||
        title.toLowerCase().includes("winner") ||
        title.toLowerCase().includes("match") ||
        title.toLowerCase().includes("map")
      );

      if (isBot) {
        botPaid += cashPaid;
        botVal += curVal;
      } else {
        manualPaid += cashPaid;
        manualVal += curVal;
      }

      const tag = isBot ? "[BOT]" : "[MAN]";
      console.log(`  ${tag} ${Math.round(size).toString().padStart(5)}× ${outcome.padEnd(20).slice(0, 20)}  avg=${(avgPrice * 100).toFixed(0).padStart(3)}¢  cur=${(curPrice * 100).toFixed(0).padStart(3)}¢  paid=$${cashPaid.toFixed(2).padStart(7)}  val=$${curVal.toFixed(2).padStart(7)}  pnl=$${unrealizedPnl.toFixed(2).padStart(7)}${status}  cashPnl=$${cashPnl.toFixed(2)}  ${title}`);
    }

    console.log(`\n  ── Bot Arb Trades (PM side only) ──`);
    console.log(`  Total paid:     $${botPaid.toFixed(2)}`);
    console.log(`  Current value:  $${botVal.toFixed(2)}`);
    console.log(`  PM-side P&L:    $${(botVal - botPaid).toFixed(2)}`);
    console.log(`  (Note: full arb P&L = PM-side + Kalshi-side. Need Kalshi fills above.)`);

    console.log(`\n  ── Manual Trades ──`);
    console.log(`  Total paid:     $${manualPaid.toFixed(2)}`);
    console.log(`  Current value:  $${manualVal.toFixed(2)}`);
    console.log(`  PM-side P&L:    $${(manualVal - manualPaid).toFixed(2)}`);
  } catch (e) {
    console.error(`  PM error: ${(e as Error).message}`);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
