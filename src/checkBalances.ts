/**
 * checkBalances.ts — Get current Kalshi + PM balances and reverse-calculate starting balances.
 * Usage: npx tsx src/checkBalances.ts
 */
import crypto from "crypto";
import fs from "fs";
import { Contract, JsonRpcProvider } from "ethers";
import { fetchJson } from "./http.js";
import { kalSideForDir } from "./utils.js";
import dotenv from "dotenv";
dotenv.config();

// ─── Kalshi auth ──────────────────────────────────────────────────────────────

function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
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

// Paginated Kalshi fetch
async function kalshiFetchAll(basePath: string, key: string): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let cursor = "";
  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = cursor ? `${basePath}${sep}cursor=${cursor}` : basePath;
    const res = await kalshiGet(path);
    const items = (Array.isArray(res[key]) ? res[key] : []) as Record<string, unknown>[];
    all.push(...items);
    cursor = String(res.cursor ?? "");
    if (!cursor || items.length === 0) break;
  }
  return all;
}

// ─── PM USDC balance (on-chain) ───────────────────────────────────────────────

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // Polygon USDC
const USDC_ABI = ["function balanceOf(address account) view returns (uint256)"];

async function getUsdcBalance(): Promise<number> {
  const rpcUrl = process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const wallet = process.env.POLY_FUNDER ?? "";
  const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);
  const rawBalance: bigint = await usdc.balanceOf(wallet);
  return Number(rawBalance) / 1e6;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== WALLET BALANCES ===\n");

  // ── Current Kalshi balance ──
  let kalshiBalanceCents = 0;
  console.log("── Kalshi ──");
  try {
    const bal = await kalshiGet("/portfolio/balance");
    kalshiBalanceCents = Number(bal.balance ?? 0);
    console.log(`  Current balance: $${(kalshiBalanceCents / 100).toFixed(2)}`);
  } catch (e) {
    console.error(`  Balance error: ${(e as Error).message}`);
  }

  // ── Current PM USDC balance ──
  let pmUsdcBalance = 0;
  console.log("\n── Polymarket (Polygon USDC) ──");
  try {
    pmUsdcBalance = await getUsdcBalance();
    console.log(`  Current USDC balance: $${pmUsdcBalance.toFixed(2)}`);
    console.log(`  Wallet: ${process.env.POLY_FUNDER}`);
  } catch (e) {
    console.error(`  USDC balance error: ${(e as Error).message}`);
  }

  // ── Kalshi fills: total spent + total revenue ──
  console.log("\n── Kalshi Trade Activity ──");
  let kalTotalSpent = 0;  // cents spent on buys
  let kalTotalRevenue = 0; // cents from settlements
  try {
    const fills = await kalshiFetchAll("/portfolio/fills?limit=200", "fills");
    console.log(`  Total fills: ${fills.length}`);
    for (const f of fills) {
      const action = String(f.action ?? "");
      const side = String(f.side ?? "");
      const count = Number(f.count ?? 0);
      const yesPrice = Number(f.yes_price ?? 0);
      const noPrice = Number(f.no_price ?? 0);
      const price = side === "yes" ? yesPrice : noPrice;
      if (action === "buy") kalTotalSpent += count * price;
      else if (action === "sell") kalTotalRevenue += count * price;
    }
    console.log(`  Total spent (buys): $${(kalTotalSpent / 100).toFixed(2)}`);
    console.log(`  Total revenue (sells): $${(kalTotalRevenue / 100).toFixed(2)}`);

    const settlements = await kalshiFetchAll("/portfolio/settlements?limit=200", "settlements");
    console.log(`  Total settlements: ${settlements.length}`);
    let settlementRevenue = 0;
    for (const s of settlements) {
      settlementRevenue += Number(s.revenue ?? 0);
    }
    console.log(`  Settlement revenue: $${(settlementRevenue / 100).toFixed(2)}`);

    // Starting balance = current + spent - sells - settlement_revenue
    const kalStarting = kalshiBalanceCents + kalTotalSpent - kalTotalRevenue - settlementRevenue;
    console.log(`\n  >> Estimated starting Kalshi balance: $${(kalStarting / 100).toFixed(2)}`);
  } catch (e) {
    console.error(`  Fills error: ${(e as Error).message}`);
  }

  // ── PM trade activity from arb_trades.json ──
  console.log("\n── PM Trade Activity (from arb_trades.json) ──");
  try {
    interface ArbTrade {
      pmCost: number;
      pmFillPrice: number;
      shares: number;
      realizedPnl?: number;
      status: string;
      dir: string;
      kalCost: number;
    }
    const trades: ArbTrade[] = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
    let totalPmSpent = 0;
    let totalPmReturned = 0; // from resolved trades where PM won
    let pmTradeCount = 0;

    for (const t of trades) {
      if (t.pmCost > 0) {
        totalPmSpent += t.pmCost;
        pmTradeCount++;
      }
      // If PM won (resolved, payout came back), estimate PM return
      // PM payout = shares * $1 when PM side wins
      if (t.status === "resolved" && t.pmCost > 0 && t.realizedPnl != null) {
        // If combined P&L is positive enough that PM must have paid out
        const kalSide = kalSideForDir(t.dir);
        // Can't perfectly determine from here, but approximate
      }
    }

    console.log(`  PM trades with cost: ${pmTradeCount}`);
    console.log(`  Total PM spent: $${totalPmSpent.toFixed(2)}`);

    // PM starting = current USDC + total spent - total returned
    // Since we can't perfectly track PM payouts, show what we know
    console.log(`\n  >> PM starting balance ≈ current ($${pmUsdcBalance.toFixed(2)}) + spent ($${totalPmSpent.toFixed(2)}) = $${(pmUsdcBalance + totalPmSpent).toFixed(2)} (upper bound, before payouts)`);
  } catch (e) {
    console.error(`  Trades error: ${(e as Error).message}`);
  }

  // ── Summary ──
  console.log("\n" + "=".repeat(50));
  console.log("CURRENT BALANCES");
  console.log("=".repeat(50));
  console.log(`  Kalshi:  $${(kalshiBalanceCents / 100).toFixed(2)}`);
  console.log(`  PM USDC: $${pmUsdcBalance.toFixed(2)}`);
  console.log(`  TOTAL:   $${(kalshiBalanceCents / 100 + pmUsdcBalance).toFixed(2)}`);
}

main().catch(e => console.error("Fatal:", e));
