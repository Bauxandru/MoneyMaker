import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { fetchAllKalshiFills, type KalFill } from "./src/kalshiTrade.js";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { resolvePolyApiCreds } from "./src/polyAuth.js";

interface ClobTrade {
  asset_id: string;
  size: string;
  price: string;
  fee_rate_bps: string;
  side: string;
  status: string;
  match_time: string;
}

interface ArbTrade {
  id: string;
  ts: string;
  match: string;
  dir: string;
  shares: number;
  kalTicker: string;
  kalFillPrice: number;
  kalCost: number;
  pmOutcome: string;
  pmSlug: string;
  pmTokenId?: string;
  pmFillPrice: number;
  pmCost: number;
  totalCost: number;
  resolvedTs?: string;
  resolutionMethod?: string;
  initialExchange?: string;
  [key: string]: any;
}

async function main() {
  const trades: ArbTrade[] = JSON.parse(readFileSync("data/arb_trades.json", "utf8"));

  // Only look at hedge-complete and both-legs trades (both sides filled)
  const completed = trades.filter(t =>
    t.resolutionMethod === "hedge-complete" || t.resolutionMethod === "both-legs"
  );
  console.log(`Total trades: ${trades.length}, both-legs completed: ${completed.length}\n`);

  // Fetch Kalshi fills
  console.log("Fetching Kalshi fills...");
  const kalFills = await fetchAllKalshiFills();
  console.log(`  Got ${kalFills.length} Kalshi fills`);

  // Fetch PM CLOB trades
  console.log("Fetching PM CLOB trades...");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  const clobTrades = (await client.getTrades()) as unknown as ClobTrade[];
  console.log(`  Got ${clobTrades.length} PM CLOB trades\n`);

  // Index Kalshi fills by ticker
  const kalByTicker = new Map<string, KalFill[]>();
  for (const f of kalFills) {
    if (f.action !== "buy") continue;
    const list = kalByTicker.get(f.ticker) ?? [];
    list.push(f);
    kalByTicker.set(f.ticker, list);
  }

  // Index PM trades by asset_id
  const pmByToken = new Map<string, ClobTrade[]>();
  for (const ct of clobTrades) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    const list = pmByToken.get(ct.asset_id) ?? [];
    list.push(ct);
    pmByToken.set(ct.asset_id, list);
  }

  // For each completed trade, find matching fills and compute timing
  const results: any[] = [];
  const usedKal = new Map<string, Set<number>>();
  const usedPm = new Map<string, Set<number>>();

  for (const t of completed) {
    const arbTs = new Date(t.ts).getTime(); // ms when arb was initiated

    // Match Kalshi fill
    const kalFillsForTicker = kalByTicker.get(t.kalTicker) ?? [];
    let bestKalFill: KalFill | null = null;
    let bestKalIdx = -1;
    let bestKalDist = Infinity;
    const usedKalSet = usedKal.get(t.kalTicker) ?? new Set();

    for (let i = 0; i < kalFillsForTicker.length; i++) {
      if (usedKalSet.has(i)) continue;
      const fillMs = new Date(kalFillsForTicker[i].ts).getTime();
      const dist = Math.abs(fillMs - arbTs);
      if (dist < bestKalDist) {
        bestKalDist = dist;
        bestKalIdx = i;
        bestKalFill = kalFillsForTicker[i];
      }
    }
    if (bestKalIdx >= 0 && bestKalDist < 120_000) {
      usedKalSet.add(bestKalIdx);
      usedKal.set(t.kalTicker, usedKalSet);
    } else {
      bestKalFill = null;
    }

    // Match PM fill
    let bestPmFill: ClobTrade | null = null;
    let bestPmIdx = -1;
    let bestPmDist = Infinity;

    if (t.pmTokenId) {
      const pmFillsForToken = pmByToken.get(t.pmTokenId) ?? [];
      const usedPmSet = usedPm.get(t.pmTokenId) ?? new Set();

      for (let i = 0; i < pmFillsForToken.length; i++) {
        if (usedPmSet.has(i)) continue;
        const fillSec = Number(pmFillsForToken[i].match_time);
        const fillMs = fillSec * 1000;
        const dist = Math.abs(fillMs - arbTs);
        if (dist < bestPmDist) {
          bestPmDist = dist;
          bestPmIdx = i;
          bestPmFill = pmFillsForToken[i];
        }
      }
      if (bestPmIdx >= 0 && bestPmDist < 120_000) {
        usedPmSet.add(bestPmIdx);
        usedPm.set(t.pmTokenId, usedPmSet);
      } else {
        bestPmFill = null;
      }
    }

    const kalFillMs = bestKalFill ? new Date(bestKalFill.ts).getTime() : null;
    const pmFillMs = bestPmFill ? Number(bestPmFill.match_time) * 1000 : null;

    let firstExchange: string | null = null;
    let timeBetweenLegsMs: number | null = null;
    let kalLatencyMs: number | null = null;
    let pmLatencyMs: number | null = null;

    if (kalFillMs && pmFillMs) {
      firstExchange = kalFillMs < pmFillMs ? "kal" : "pm";
      timeBetweenLegsMs = Math.abs(kalFillMs - pmFillMs);
    }

    // Latency = fill time - arb initiation time
    if (kalFillMs) kalLatencyMs = kalFillMs - arbTs;
    if (pmFillMs) pmLatencyMs = pmFillMs - arbTs;

    results.push({
      id: t.id,
      match: t.match,
      ts: t.ts,
      shares: t.shares,
      initialExchange: t.initialExchange,
      kalFillTs: bestKalFill?.ts ?? null,
      pmFillTs: bestPmFill ? new Date(Number(bestPmFill.match_time) * 1000).toISOString() : null,
      kalLatencyMs,
      pmLatencyMs,
      firstExchange,
      timeBetweenLegsMs,
      kalMatched: !!bestKalFill,
      pmMatched: !!bestPmFill,
    });
  }

  // Print results
  const bothMatched = results.filter(r => r.kalMatched && r.pmMatched);
  const kalOnly = results.filter(r => r.kalMatched && !r.pmMatched);
  const pmOnly = results.filter(r => !r.kalMatched && r.pmMatched);
  const neither = results.filter(r => !r.kalMatched && !r.pmMatched);

  console.log(`=== FILL MATCHING ===`);
  console.log(`Both matched: ${bothMatched.length}`);
  console.log(`Kal only: ${kalOnly.length}`);
  console.log(`PM only: ${pmOnly.length}`);
  console.log(`Neither: ${neither.length}\n`);

  // Timing analysis for both-matched trades
  if (bothMatched.length > 0) {
    console.log(`=== EXECUTION TIMING (${bothMatched.length} trades with both fills matched) ===\n`);

    const kalFirstCount = bothMatched.filter(r => r.firstExchange === "kal").length;
    const pmFirstCount = bothMatched.filter(r => r.firstExchange === "pm").length;
    console.log(`First leg: KAL first=${kalFirstCount}, PM first=${pmFirstCount}\n`);

    // Sort by date
    bothMatched.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    for (const r of bothMatched) {
      const kalLat = r.kalLatencyMs !== null ? `${(r.kalLatencyMs/1000).toFixed(1)}s` : "?";
      const pmLat = r.pmLatencyMs !== null ? `${(r.pmLatencyMs/1000).toFixed(1)}s` : "?";
      const gap = r.timeBetweenLegsMs !== null ? `${(r.timeBetweenLegsMs/1000).toFixed(1)}s` : "?";
      const first = r.firstExchange ?? "?";

      console.log(`${r.match.padEnd(35)} | ${first.toUpperCase()} first | KAL ${kalLat.padStart(7)} | PM ${pmLat.padStart(7)} | Gap: ${gap.padStart(7)} | ${r.shares} shares`);
    }

    // Stats
    const gaps = bothMatched.filter(r => r.timeBetweenLegsMs !== null).map(r => r.timeBetweenLegsMs);
    const kalLats = bothMatched.filter(r => r.kalLatencyMs !== null).map(r => r.kalLatencyMs);
    const pmLats = bothMatched.filter(r => r.pmLatencyMs !== null).map(r => r.pmLatencyMs);

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const median = (arr: number[]) => { const s = [...arr].sort((a,b) => a - b); return s[Math.floor(s.length/2)]; };
    const p90 = (arr: number[]) => { const s = [...arr].sort((a,b) => a - b); return s[Math.floor(s.length * 0.9)]; };

    console.log(`\n=== STATS ===`);
    if (gaps.length > 0) {
      console.log(`Gap between legs:  avg=${(avg(gaps)/1000).toFixed(1)}s  median=${(median(gaps)/1000).toFixed(1)}s  p90=${(p90(gaps)/1000).toFixed(1)}s  min=${(Math.min(...gaps)/1000).toFixed(1)}s  max=${(Math.max(...gaps)/1000).toFixed(1)}s`);
    }
    if (kalLats.length > 0) {
      console.log(`KAL fill latency:  avg=${(avg(kalLats)/1000).toFixed(1)}s  median=${(median(kalLats)/1000).toFixed(1)}s  p90=${(p90(kalLats)/1000).toFixed(1)}s  min=${(Math.min(...kalLats)/1000).toFixed(1)}s  max=${(Math.max(...kalLats)/1000).toFixed(1)}s`);
    }
    if (pmLats.length > 0) {
      console.log(`PM fill latency:   avg=${(avg(pmLats)/1000).toFixed(1)}s  median=${(median(pmLats)/1000).toFixed(1)}s  p90=${(p90(pmLats)/1000).toFixed(1)}s  min=${(Math.min(...pmLats)/1000).toFixed(1)}s  max=${(Math.max(...pmLats)/1000).toFixed(1)}s`);
    }
  }

  // Show unmatched trades for debugging
  if (neither.length > 0 && neither.length <= 20) {
    console.log(`\n=== UNMATCHED TRADES (neither fill found) ===`);
    for (const r of neither.slice(0, 10)) {
      console.log(`  ${r.id} | ${r.match} | ts=${r.ts} | pmTokenId=${!!r.pmMatched}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
