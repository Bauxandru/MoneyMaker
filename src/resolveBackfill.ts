/**
 * Resolve backfilled PM trades — update status and P&L.
 * Uses Gamma events API (has explicit `winner` field) instead of markets API.
 * For markets without events data, falls back to outcomePrices from markets API.
 */
import fs from "fs";

interface ArbTrade {
  id: string;
  match: string;
  pmTokenId?: string;
  pmSlug?: string;
  shares: number;
  pmCost: number;
  pmFillPrice: number;
  totalCost: number;
  realizedPnl: number;
  status: string;
  resolutionMethod?: string;
  resolvedTs?: string;
  [k: string]: unknown;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveViaEvents(slug: string): Promise<{ resolved: boolean; winner: string | null }> {
  try {
    const resp = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`);
    const events = (await resp.json()) as any[];
    if (!events || events.length === 0) return { resolved: false, winner: null };
    const ev = events[0];
    if (ev.ended && ev.outcome) {
      return { resolved: true, winner: ev.outcome };
    }
    // Check nested markets
    if (ev.markets && ev.markets.length > 0) {
      const mkt = ev.markets[0];
      if (mkt.resolved && mkt.winner) {
        return { resolved: true, winner: mkt.winner };
      }
    }
    return { resolved: false, winner: null };
  } catch {
    return { resolved: false, winner: null };
  }
}

async function resolveViaMarkets(slug: string): Promise<{ resolved: boolean; winner: string | null; outcomes: string[] }> {
  try {
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
    const markets = (await resp.json()) as any[];
    if (!markets || markets.length === 0) return { resolved: false, winner: null, outcomes: [] };
    const mkt = markets[0];
    const outcomes: string[] = mkt.outcomes ? JSON.parse(mkt.outcomes) : [];
    const outcomePrices: string[] = mkt.outcomePrices ? JSON.parse(mkt.outcomePrices) : [];

    if (mkt.closed && outcomes.length > 0 && outcomePrices.length > 0) {
      // Winner has price "1", loser has price "0"
      // Cancelled/tied has "0.5" for both
      const winIdx = outcomePrices.indexOf("1");
      if (winIdx >= 0 && outcomes[winIdx]) {
        return { resolved: true, winner: outcomes[winIdx], outcomes };
      }
      // Check for cancellation (50/50)
      if (outcomePrices.every(p => p === "0.5")) {
        return { resolved: true, winner: "CANCELLED", outcomes };
      }
    }
    return { resolved: false, winner: null, outcomes };
  } catch {
    return { resolved: false, winner: null, outcomes: [] };
  }
}

async function main() {
  const tradesPath = "data/arb_trades.json";
  const trades: ArbTrade[] = JSON.parse(fs.readFileSync(tradesPath, "utf8"));

  const backfillTrades = trades.filter(
    (t) => t.resolutionMethod?.startsWith("pm-backfill") && t.status === "unresolved"
  );
  console.log(`Unresolved backfill trades: ${backfillTrades.length}`);

  if (backfillTrades.length === 0) {
    console.log("Nothing to resolve.");
    return;
  }

  // Group by slug to avoid duplicate API calls
  const bySlug = new Map<string, ArbTrade[]>();
  for (const t of backfillTrades) {
    const slug = t.pmSlug || "";
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug)!.push(t);
  }
  console.log(`Unique slugs to resolve: ${bySlug.size}\n`);

  let resolved = 0;
  let won = 0;
  let lost = 0;
  let cancelled = 0;
  let stillOpen = 0;
  let totalPnl = 0;

  for (const [slug, slugTrades] of bySlug) {
    if (!slug) {
      console.log(`  SKIP: No slug for ${slugTrades.length} trades`);
      stillOpen += slugTrades.length;
      continue;
    }

    // Try events endpoint first (best data)
    let result = await resolveViaEvents(slug);
    await delay(80);

    // Fallback to markets endpoint with outcomePrices
    let outcomes: string[] = [];
    if (!result.resolved) {
      const mktResult = await resolveViaMarkets(slug);
      await delay(80);
      if (mktResult.resolved) {
        result = { resolved: true, winner: mktResult.winner };
        outcomes = mktResult.outcomes;
      }
    }

    if (!result.resolved) {
      console.log(`  ? OPEN  ${slug}`);
      stillOpen += slugTrades.length;
      continue;
    }

    const winner = result.winner!;

    for (const t of slugTrades) {
      // Determine our outcome from the match name
      // The match field typically has format "Team A vs Team B" or just the question
      // We need to check if our outcome matches the winner
      // Our outcome is embedded in the slug or match name

      let ourOutcome = "?";
      // Try to determine from the token position in the slug
      // For esports: slug like "cs2-3dmax-sfe-2026-03-02" → outcomes are team names
      // For tennis: slug like "atp-player1-player2-2026-02-25"

      // We bought this token — need to figure out which outcome it represents
      // Since we don't have the token→outcome mapping stored, fetch it
      let didWin: boolean | null = null;

      if (winner === "CANCELLED") {
        // Cancelled: each share worth $0.50
        const refund = Math.round(t.shares * 0.5 * 100) / 100;
        t.realizedPnl = Math.round((refund - t.pmCost) * 100) / 100;
        t.status = "resolved";
        t.resolutionMethod = "pm-backfill-cancelled";
        t.resolvedTs = String(Math.floor(Date.now() / 1000));
        totalPnl += t.realizedPnl;
        cancelled++;
        console.log(`  ○ CANC  ${t.shares} shares, refund $${refund.toFixed(2)}, pnl $${t.realizedPnl.toFixed(2)} | ${slug}`);
        continue;
      }

      // Need to look up which outcome our token represents
      // Fetch the market to get token→outcome mapping
      try {
        const resp = await fetch(
          `https://gamma-api.polymarket.com/markets?clob_token_ids=${t.pmTokenId}`
        );
        const markets = (await resp.json()) as any[];
        if (markets && markets.length > 0) {
          const mkt = markets[0];
          const mktOutcomes: string[] = mkt.outcomes ? JSON.parse(mkt.outcomes) : [];
          const tokens: string[] = mkt.clobTokenIds ? JSON.parse(mkt.clobTokenIds) : [];
          const tokenIdx = tokens.indexOf(t.pmTokenId!);
          if (tokenIdx >= 0 && mktOutcomes[tokenIdx]) {
            ourOutcome = mktOutcomes[tokenIdx];
          }
        }
        await delay(80);
      } catch {}

      if (ourOutcome === "?") {
        // Can't determine our outcome — skip
        console.log(`  ? UNKN  Can't determine outcome for token ${t.pmTokenId?.slice(0, 20)}... | ${slug}`);
        stillOpen++;
        continue;
      }

      // Compare our outcome to winner (case-insensitive, partial match)
      didWin = ourOutcome.toLowerCase() === winner.toLowerCase() ||
               winner.toLowerCase().includes(ourOutcome.toLowerCase()) ||
               ourOutcome.toLowerCase().includes(winner.toLowerCase());

      if (didWin) {
        // Won: shares pay out $1 each
        t.realizedPnl = Math.round((t.shares - t.pmCost) * 100) / 100;
        t.status = "resolved";
        t.resolutionMethod = "pm-backfill-won";
        t.resolvedTs = String(Math.floor(Date.now() / 1000));
        totalPnl += t.realizedPnl;
        won++;
        const pnlStr = t.realizedPnl >= 0 ? `+$${t.realizedPnl.toFixed(2)}` : `-$${Math.abs(t.realizedPnl).toFixed(2)}`;
        console.log(`  ✓ WON   ${String(t.shares).padStart(4)} shares @ $${t.pmFillPrice.toFixed(2)} → ${pnlStr.padStart(8)} | ${ourOutcome} beat ${winner !== ourOutcome ? winner : '?'} | ${slug}`);
      } else {
        // Lost: shares worth $0
        t.realizedPnl = -t.pmCost;
        t.status = "resolved";
        t.resolutionMethod = "pm-backfill-lost";
        t.resolvedTs = String(Math.floor(Date.now() / 1000));
        totalPnl += t.realizedPnl;
        lost++;
        console.log(`  ✗ LOST  ${String(t.shares).padStart(4)} shares @ $${t.pmFillPrice.toFixed(2)} → -$${t.pmCost.toFixed(2).padStart(7)} | ${ourOutcome} lost to ${winner} | ${slug}`);
      }
    }

    resolved += slugTrades.length;
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`Resolved: ${won + lost + cancelled} (${won} won, ${lost} lost, ${cancelled} cancelled)`);
  console.log(`Still open: ${stillOpen}`);
  console.log(`Total P&L from resolved backfills: $${totalPnl.toFixed(2)}`);

  // Save
  const resolvedCount = trades.filter(t => t.resolutionMethod?.startsWith("pm-backfill") && t.status === "resolved").length;
  if (resolvedCount > 0) {
    fs.writeFileSync(tradesPath, JSON.stringify(trades, null, 2));
    console.log(`\nUpdated ${tradesPath} (${resolvedCount} trades resolved)`);
  } else {
    console.log("\nNo changes to save.");
  }
}

main().catch((e) => console.error("ERROR:", e));
