/**
 * Fix inflated backfill trades where CLOB fill sizes were wrong (maker bug).
 *
 * Problem: When trader_side=MAKER, the CLOB `size` field is the TAKER's total,
 * not our fill. The backfillPm.ts used getOurFillSize() but some fills may have
 * been processed before that fix or the maker_orders weren't populated.
 *
 * Fix: Cap shares at a realistic maximum based on actual bot trading patterns
 * (5-50 shares per trade, median 13). Any backfill trade >50 shares is almost
 * certainly inflated. We cap at the max normal trade size and recalculate P&L.
 *
 * Alternatively: scan on-chain TransferSingle events for exact fill verification.
 */
import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import { scanTransferHistory } from "./polyChain.js";

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
  [k: string]: unknown;
}

async function main() {
  const tradesPath = "data/arb_trades.json";
  const trades: ArbTrade[] = JSON.parse(fs.readFileSync(tradesPath, "utf8"));

  const inflated = trades.filter(
    (t) =>
      (t.resolutionMethod || "").startsWith("pm-backfill") && t.shares > 50
  );

  if (inflated.length === 0) {
    console.log("No inflated backfill trades found.");
    return;
  }

  console.log(`Found ${inflated.length} inflated backfill trades (>50 shares)\n`);

  // Try on-chain verification first
  console.log("Attempting on-chain verification via TransferSingle events...\n");

  // Polygon block for ~Feb 20, 2026 (approximate, will scan a wide range)
  // Current block is roughly 73M+, Feb 20 would be ~71M
  // We'll scan from block 71000000 to latest
  const START_BLOCK = 71_000_000;

  for (const t of inflated) {
    if (!t.pmTokenId) continue;

    console.log(`\n${"=".repeat(70)}`);
    console.log(`${t.pmSlug} -- ${t.shares} shares @ $${t.pmFillPrice} = $${t.pmCost}`);

    let onChainShares = -1;
    try {
      const transfers = await scanTransferHistory(t.pmTokenId, START_BLOCK);
      if (transfers.length > 0) {
        // Sum incoming transfers (to our wallet)
        const incoming = transfers.filter((tr) => tr.direction === "in");
        const outgoing = transfers.filter((tr) => tr.direction === "out");
        const totalIn = incoming.reduce((sum, tr) => sum + tr.shares, 0);
        const totalOut = outgoing.reduce((sum, tr) => sum + tr.shares, 0);
        onChainShares = Math.round(totalIn);
        console.log(
          `  On-chain: ${incoming.length} incoming (${totalIn} shares), ${outgoing.length} outgoing (${totalOut} shares)`
        );
        console.log(`  Net received: ${onChainShares} shares`);
      } else {
        console.log(`  No on-chain transfers found (may be outside scan range)`);
      }
    } catch (err) {
      console.log(`  On-chain scan failed: ${(err as Error).message}`);
    }

    const oldShares = t.shares;
    const oldCost = t.pmCost;
    const oldPnl = t.realizedPnl;

    if (onChainShares > 0 && onChainShares < oldShares) {
      // Use on-chain verified shares
      t.shares = onChainShares;
      t.pmCost = Math.round(onChainShares * t.pmFillPrice * 100) / 100;
      t.totalCost = t.pmCost;
      t._verifiedOnChain = true;
    } else if (onChainShares <= 0) {
      // Fallback: cap at 17 shares (median of normal trades)
      const cappedShares = 17;
      t.shares = cappedShares;
      t.pmCost = Math.round(cappedShares * t.pmFillPrice * 100) / 100;
      t.totalCost = t.pmCost;
      t._estimatedCap = true;
    }

    // Recalculate P&L based on resolution method
    if (t.resolutionMethod === "pm-backfill-won") {
      t.realizedPnl = Math.round((t.shares - t.pmCost) * 100) / 100;
    } else if (t.resolutionMethod === "pm-backfill-lost") {
      t.realizedPnl = -t.pmCost;
    } else if (t.resolutionMethod === "pm-backfill-cancelled") {
      const refund = Math.round(t.shares * 0.5 * 100) / 100;
      t.realizedPnl = Math.round((refund - t.pmCost) * 100) / 100;
    }

    const method = (t as any)._verifiedOnChain
      ? "ON-CHAIN"
      : (t as any)._estimatedCap
      ? "CAPPED"
      : "UNCHANGED";
    console.log(
      `  ${method}: ${oldShares} -> ${t.shares} shares | cost $${oldCost.toFixed(2)} -> $${t.pmCost.toFixed(2)} | pnl $${oldPnl.toFixed(2)} -> $${t.realizedPnl.toFixed(2)}`
    );
  }

  // Summary
  const allBf = trades.filter((t) =>
    (t.resolutionMethod || "").startsWith("pm-backfill")
  );
  const totalPnl = allBf.reduce((s, t) => s + t.realizedPnl, 0);
  const totalCost = allBf.reduce((s, t) => s + t.pmCost, 0);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Updated backfill totals:`);
  console.log(`  Total cost: $${totalCost.toFixed(2)}`);
  console.log(`  Total P&L: $${totalPnl.toFixed(2)}`);

  fs.writeFileSync(tradesPath, JSON.stringify(trades, null, 2));
  console.log(`\nSaved to ${tradesPath}`);
}

main().catch((e) => console.error("ERROR:", e));
