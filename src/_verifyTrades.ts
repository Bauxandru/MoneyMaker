/**
 * _verifyTrades.ts -- Verify today's arb trades against actual Kalshi fills + PM data.
 * Run: npx tsx src/_verifyTrades.ts
 */
import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

// --- Kalshi auth ---------------------------------------------------------------
function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
  return fs.readFileSync(p, "utf8");
}

const BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

function signRequest(method: string, path: string, timestamp: string, pem: string) {
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${timestamp}${method.toUpperCase()}${path}`);
  signer.end();
  return signer.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

async function kalshiGet(path: string): Promise<any> {
  const keyId = process.env.KALSHI_API_KEY_ID!;
  const pk = loadPrivateKey();
  const url = new URL(`${BASE}${path}`);
  const ts = Date.now().toString();
  const sig = signRequest("GET", url.pathname, ts, pk);
  const res = await fetch(url.toString(), {
    headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts, "Content-Type": "application/json" },
  });
  return res.json();
}

// --- PM data -------------------------------------------------------------------
const GAMMA_DB = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";

async function getPmPositions(funder: string): Promise<any[]> {
  try {
    const res = await fetch(`${GAMMA_DB}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.1`);
    const text = await res.text();
    try { const data = JSON.parse(text); return Array.isArray(data) ? data : []; }
    catch { console.warn("  [PM] Could not parse positions response"); return []; }
  } catch (e) { console.warn(`  [PM] Fetch error: ${(e as Error).message}`); return []; }
}

// --- Main ----------------------------------------------------------------------
async function main() {
  // Load trades
  const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
  const todayTrades = trades.filter((t: any) => t.ts?.startsWith("2026-03-28"));

  console.log(`\n=== TODAY'S TRADES: ${todayTrades.length} ===\n`);

  // 1. Get ALL Kalshi fills
  console.log("Fetching Kalshi fills...");
  let allFills: any[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const path = `/portfolio/fills?limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    const resp = await kalshiGet(path);
    const items = resp.fills ?? resp.data ?? [];
    allFills = allFills.concat(items);
    cursor = resp.cursor;
    if (!cursor || items.length < 200) break;
  }
  console.log(`  Total Kalshi fills: ${allFills.length}`);

  // Filter today's fills
  const todayFills = allFills.filter((f: any) => {
    const ts = f.created_time || f.ts || "";
    return ts.startsWith("2026-03-28");
  });
  console.log(`  Today's fills: ${todayFills.length}`);

  // Group fills by ticker
  const fillsByTicker = new Map<string, any[]>();
  for (const f of todayFills) {
    const ticker = f.ticker || f.market_ticker || "";
    if (!fillsByTicker.has(ticker)) fillsByTicker.set(ticker, []);
    fillsByTicker.get(ticker)!.push(f);
  }

  // 2. Get Kalshi settlements
  console.log("Fetching Kalshi settlements...");
  const settResp = await kalshiGet("/portfolio/settlements?limit=200");
  const settlements = settResp.settlements ?? settResp.data ?? [];
  const todaySettlements = (settlements as any[]).filter((s: any) => {
    const ts = s.settled_time || s.ts || "";
    return ts.startsWith("2026-03-28");
  });
  console.log(`  Today's settlements: ${todaySettlements.length}`);

  const settlementsByTicker = new Map<string, any>();
  for (const s of todaySettlements) {
    const ticker = s.ticker || s.market_ticker || "";
    settlementsByTicker.set(ticker, s);
  }

  // 3. Get PM positions
  console.log("Fetching PM positions...");
  const { Wallet } = await import("ethers");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY ?? "";
  let funder = process.env.POLY_FUNDER ?? "";
  if (!funder && pk) {
    try { funder = new Wallet(pk).address; } catch { funder = ""; }
  }
  const pmPositions = await getPmPositions(funder);
  console.log(`  PM positions: ${pmPositions.length}`);

  const pmByToken = new Map<string, any>();
  for (const p of pmPositions) {
    const tid = p.asset ?? p.tokenId ?? p.token_id ?? "";
    pmByToken.set(tid, p);
  }

  // 4. Get Kalshi current positions
  console.log("Fetching Kalshi positions...");
  const posResp = await kalshiGet("/portfolio/positions?count_filter=position&limit=200");
  const kalPositions = posResp.market_positions ?? posResp.data ?? [];
  console.log(`  Kalshi positions: ${(kalPositions as any[]).length}`);

  const kalPosByTicker = new Map<string, any>();
  for (const p of kalPositions as any[]) {
    kalPosByTicker.set(p.ticker || p.market_ticker || "", p);
  }

  // 5. Verify each trade
  console.log("\n" + "=".repeat(120));
  console.log("TRADE VERIFICATION");
  console.log("=".repeat(120));

  for (const t of todayTrades) {
    console.log(`\n--- ${t.match} | dir=${t.dir} | ${t.shares} shares | ${t.status} ---`);
    console.log(`  Trade ID: ${t.id}`);
    console.log(`  Time: ${t.ts}`);
    console.log(`  KAL ticker: ${t.kalTicker}`);
    console.log(`  PM slug: ${t.pmSlug} | outcome: ${t.pmOutcome}`);
    console.log(`  Record: kalCost=$${t.kalCost} kalFees=$${t.kalFees ?? 0} pmCost=$${t.pmCost} totalCost=$${t.totalCost} P&L=$${t.realizedPnl ?? "?"}`);

    // Kalshi fills for this ticker
    const kalFills = fillsByTicker.get(t.kalTicker) || [];
    if (kalFills.length > 0) {
      let totalKalSpent = 0, totalKalShares = 0, totalKalFees = 0;
      for (const f of kalFills) {
        const count = Number(f.count_fp ?? f.count ?? 0);
        const side = f.side || "";
        const action = f.action || "";
        const fee = Number(f.fee_cost ?? 0);
        const yesPrice = Number(f.yes_price_dollars ?? f.yes_price ?? 0);
        const noPrice = Number(f.no_price_dollars ?? f.no_price ?? 0);
        const effectivePrice = side === "no" ? noPrice : yesPrice;
        const cost = count * effectivePrice;
        totalKalShares += count;
        totalKalSpent += cost;
        totalKalFees += fee;
        console.log(`  [KAL FILL] ${action} ${side} x${count} @${(effectivePrice * 100).toFixed(1)}c fee=$${fee.toFixed(4)} | ${f.created_time || ""}`);
      }
      console.log(`  [KAL TOTAL] ${totalKalShares} shares, spent=$${totalKalSpent.toFixed(2)}, fees=$${totalKalFees.toFixed(2)}`);
      if (Math.abs(totalKalSpent - t.kalCost) > 0.05) {
        console.log(`  [!] KAL COST MISMATCH: recorded=$${t.kalCost} vs actual=$${totalKalSpent.toFixed(2)}`);
      }
      if (Math.abs(totalKalFees - (t.kalFees ?? 0)) > 0.01) {
        console.log(`  [!] KAL FEE MISMATCH: recorded=$${t.kalFees ?? 0} vs actual=$${totalKalFees.toFixed(2)}`);
      }
    } else {
      console.log(`  [KAL] No fills found for ${t.kalTicker}`);
    }

    // Kalshi settlement
    const sett = settlementsByTicker.get(t.kalTicker);
    if (sett) {
      const result = sett.market_result || "?";
      const yesCount = Number(sett.yes_count_fp ?? 0);
      const noCount = Number(sett.no_count_fp ?? 0);
      const yesCostDollars = Number(sett.yes_total_cost_dollars ?? 0);
      const noCostDollars = Number(sett.no_total_cost_dollars ?? 0);
      const revenue = Number(sett.revenue ?? 0);
      const feeCost = Number(sett.fee_cost ?? 0);
      console.log(`  [KAL SETTLE] result=${result} yesPos=${yesCount} noPos=${noCount} yesCost=$${yesCostDollars.toFixed(2)} noCost=$${noCostDollars.toFixed(2)} revenue=$${revenue.toFixed(2)} fees=$${feeCost.toFixed(2)} | ${sett.settled_time || ""}`);
      // Actual P&L from Kalshi side
      const kalPayout = result === "yes" ? yesCount : (result === "no" ? noCount : 0);
      const kalTotalSpent = yesCostDollars + noCostDollars;
      const kalNetPnl = kalPayout - kalTotalSpent - feeCost;
      console.log(`  [KAL P&L] payout=$${kalPayout.toFixed(2)} - spent=$${kalTotalSpent.toFixed(2)} - fees=$${feeCost.toFixed(2)} = NET $${kalNetPnl.toFixed(2)}`);
    }

    // Kalshi current position
    const kalPos = kalPosByTicker.get(t.kalTicker);
    if (kalPos) {
      console.log(`  [KAL POS] yes=${kalPos.position ?? kalPos.yes_position ?? 0} no=${kalPos.no_position ?? 0}`);
    }

    // PM position for this token
    const pmPos = pmByToken.get(t.pmTokenId);
    if (pmPos) {
      const size = Number(pmPos.size ?? pmPos.shares ?? 0);
      const avgPrice = Number(pmPos.avgPrice ?? pmPos.avg_price ?? 0);
      console.log(`  [PM POS] size=${size} avgPrice=${avgPrice} outcome=${pmPos.outcome || ""}`);
    } else {
      console.log(`  [PM POS] No current position for token ${t.pmTokenId?.slice(0, 20)}...`);
    }

    // Verify P&L logic
    // NOTE: kalCost already includes Kalshi fees, so totalCost = kalCost + pmCost has fees baked in.
    // Do NOT subtract kalFees again -- that would double-count them.
    if (t.status === "resolved" && t.resolutionMethod === "both-legs") {
      const expectedPnl = t.shares - t.totalCost;
      console.log(`  [P&L CHECK] shares=$${t.shares} - totalCost=$${t.totalCost} (kalCost=$${t.kalCost} incl fees=$${t.kalFees ?? 0} + pmCost=$${t.pmCost}) = $${expectedPnl.toFixed(2)} (recorded: $${t.realizedPnl})`);
      if (Math.abs(expectedPnl - (t.realizedPnl ?? 0)) > 0.02) {
        console.log(`  [!] P&L MISMATCH: computed=$${expectedPnl.toFixed(2)} vs recorded=$${t.realizedPnl}`);
      }
    } else if (t.resolutionMethod === "hedge-complete") {
      const expectedPnl = t.shares - t.totalCost;
      console.log(`  [P&L CHECK] hedge-complete: shares=$${t.shares} - totalCost=$${t.totalCost} = $${expectedPnl.toFixed(2)} (recorded: $${t.realizedPnl})`);
      if (Math.abs(expectedPnl - (t.realizedPnl ?? 0)) > 0.02) {
        console.log(`  [!] P&L MISMATCH: computed=$${expectedPnl.toFixed(2)} vs recorded=$${t.realizedPnl}`);
      }
    }
  }

  console.log("\n" + "=".repeat(120));
  console.log("SUMMARY");
  console.log("=".repeat(120));

  // Today's Kalshi fills not matched to any trade
  const tradeTickers = new Set(todayTrades.map((t: any) => t.kalTicker));
  const unmatchedTickers = [...fillsByTicker.keys()].filter(t => !tradeTickers.has(t));
  if (unmatchedTickers.length > 0) {
    console.log("\n[UNMATCHED KALSHI FILLS] Fills with no corresponding trade record:");
    for (const ticker of unmatchedTickers) {
      const fills = fillsByTicker.get(ticker)!;
      const totalShares = fills.reduce((s: number, f: any) => s + Number(f.count ?? f.quantity ?? 0), 0);
      console.log(`  ${ticker}: ${fills.length} fill(s), ${totalShares} shares`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
