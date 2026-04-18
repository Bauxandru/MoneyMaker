/**
 * ttSettleClose.ts -- Post-settlement PM position closing.
 *
 * When the Kalshi leg of an arb settles, Kalshi shares are redeemed instantly
 * and disappear from the wallet. The Polymarket leg stays in the wallet until
 * the operator (a) market-sells the remaining shares, or (b) redeems winning
 * shares on-chain once PM resolves.
 *
 * This module provides the two primitives:
 *   - sellPmAtMarket   — CLOB FAK SELL at the best bid (hedge-exit style).
 *   - redeemPmWinner   — on-chain ConditionalTokens.redeemPositions call.
 *
 * Both default to dry-run. The dashboard exposes manual-trigger endpoints,
 * and a periodic auto-cycle can be switched on via env flags (all OFF by
 * default so nothing happens unattended unless explicitly enabled).
 *
 * Safety:
 *   - sellPmAtMarket uses FAK (Fill-And-Kill) — fills what the book can match
 *     and cancels the rest. Never parks a resting ask.
 *   - redeemPmWinner only supports non-negRisk markets in this first pass.
 *     NegRisk markets require the NegRiskAdapter contract path; the dashboard
 *     button falls back to a deep link to the PM portfolio page instead.
 *   - All on-chain calls go through ethers v6 Wallet signing from
 *     POLY_WALLET_PRIVATE_KEY, same signer used everywhere else.
 */

import { Contract, JsonRpcProvider, Wallet as WalletV6 } from "ethers";
import { placePmFAKSell, createPmClient } from "./ttPmOrders.js";
import { fetchPmBestBid } from "./ttHedge.js";

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
];

export interface SellResult {
  ok: boolean;
  tokenId: string;
  requestedShares: number;
  price: number;
  dryRun: boolean;
  orderResponse?: unknown;
  error?: string;
}

export interface RedeemResult {
  ok: boolean;
  conditionId: string;
  outcomeIndex: number;
  dryRun: boolean;
  txHash?: string;
  error?: string;
}

/**
 * Market-sell a PM position via FAK at the best bid.
 * Returns { ok: true } even if 0 shares filled — caller checks orderResponse.
 * tickSize defaults to 0.01 (cents) unless caller supplies the market's actual tick.
 */
export async function sellPmAtMarket(args: {
  tokenId: string;
  shares: number;
  negRisk: boolean;
  tickSize?: number;
  dryRun: boolean;
}): Promise<SellResult> {
  const { tokenId, shares, negRisk, dryRun } = args;
  const tickSize = args.tickSize ?? 0.01;
  if (shares <= 0) {
    return { ok: false, tokenId, requestedShares: shares, price: 0, dryRun, error: "shares must be > 0" };
  }
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const bid = await fetchPmBestBid(tokenId, clobBase);
  if (bid === null || bid <= 0) {
    return {
      ok: false, tokenId, requestedShares: shares, price: 0, dryRun,
      error: "no PM bid available — cannot market-sell",
    };
  }
  const sellPrice = Math.round(bid / tickSize) * tickSize;
  try {
    const resp = await placePmFAKSell(tokenId, sellPrice, shares, tickSize, negRisk, dryRun);
    return { ok: true, tokenId, requestedShares: shares, price: sellPrice, dryRun, orderResponse: resp };
  } catch (e) {
    return {
      ok: false, tokenId, requestedShares: shares, price: sellPrice, dryRun,
      error: (e as Error).message,
    };
  }
}

/**
 * Redeem a winning PM position on-chain. Non-negRisk markets only in this first pass.
 * outcomeIndex: 0 = first outcome (YES-equivalent), 1 = second outcome (NO-equivalent).
 * indexSet encoding: bit N set = outcome N → [1] for idx 0, [2] for idx 1.
 */
export async function redeemPmWinner(args: {
  conditionId: string;
  outcomeIndex: number;
  negRisk: boolean;
  dryRun: boolean;
}): Promise<RedeemResult> {
  const { conditionId, outcomeIndex, negRisk, dryRun } = args;
  if (negRisk) {
    return {
      ok: false, conditionId, outcomeIndex, dryRun,
      error: "negRisk markets require the NegRiskAdapter path — not yet implemented. Redeem manually on polymarket.com/portfolio",
    };
  }
  if (!conditionId || !conditionId.startsWith("0x") || conditionId.length !== 66) {
    return { ok: false, conditionId, outcomeIndex, dryRun, error: "invalid conditionId" };
  }
  if (outcomeIndex !== 0 && outcomeIndex !== 1) {
    return { ok: false, conditionId, outcomeIndex, dryRun, error: "outcomeIndex must be 0 or 1" };
  }
  const indexSet = outcomeIndex === 0 ? 1 : 2;
  if (dryRun) {
    return {
      ok: true, conditionId, outcomeIndex, dryRun: true,
      txHash: "dry-run",
    };
  }
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!pk) return { ok: false, conditionId, outcomeIndex, dryRun, error: "POLY_WALLET_PRIVATE_KEY not set" };
  const rpcUrl = process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const provider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  const wallet = new WalletV6(pk, provider);
  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
  try {
    const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const tx = await ctf.redeemPositions(USDC_E, parentCollectionId, conditionId, [indexSet]);
    const receipt = await tx.wait();
    return {
      ok: true, conditionId, outcomeIndex, dryRun: false,
      txHash: receipt?.hash ?? tx.hash,
    };
  } catch (e) {
    return {
      ok: false, conditionId, outcomeIndex, dryRun, error: (e as Error).message,
    };
  }
}

/**
 * Config-flag helpers. Each flag defaults to false; they are read at call time
 * so settings.txt reloads are effective without a bot restart.
 */
export function isAutoSellLosersEnabled(): boolean {
  return String(process.env.AUTO_SELL_PM_LOSERS ?? "false").toLowerCase() === "true";
}
export function isAutoClaimWinnersEnabled(): boolean {
  return String(process.env.AUTO_CLAIM_PM_WINNERS ?? "false").toLowerCase() === "true";
}
export function isAutoExitKalSettledEnabled(): boolean {
  return String(process.env.AUTO_EXIT_PM_KAL_SETTLED ?? "false").toLowerCase() === "true";
}

// Re-export createPmClient so the dashboard can warm the client before acting.
export { createPmClient };

/**
 * Periodic auto-close cycle. Called from runARB.ts every 5 min.
 * Each action (sell-loser / claim-winner / exit-kal-settled) is independently
 * gated by an env flag so an operator can enable them one at a time. With all
 * flags false (default) this function only emits a brief "disabled" log and
 * exits — no wallet/API calls are made.
 */
export async function runSettlementCloseCycle(): Promise<void> {
  const anyEnabled =
    isAutoSellLosersEnabled() ||
    isAutoClaimWinnersEnabled() ||
    isAutoExitKalSettledEnabled();
  if (!anyEnabled) {
    // Quiet when idle — skip entirely to avoid spamming logs.
    return;
  }

  const funder = process.env.POLY_FUNDER;
  if (!funder) {
    console.log("[SETTLE-CLOSE] POLY_FUNDER not set — skipping cycle");
    return;
  }
  const db = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
  const dryRun = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

  let pmPositions: Array<Record<string, unknown>>;
  try {
    const r = await fetch(`${db}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0`);
    const raw = await r.json();
    pmPositions = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
  } catch (e) {
    console.error(`[SETTLE-CLOSE] fetchPmPositions failed: ${(e as Error).message}`);
    return;
  }

  let winnersRedeemed = 0, losersSold = 0, kalExited = 0, actionsAttempted = 0;

  for (const p of pmPositions) {
    const shares = Number(p.size ?? 0);
    if (shares <= 0) continue;

    const redeemable = Boolean(p.redeemable);
    const curPrice = Number(p.curPrice ?? 0);
    const negRisk = Boolean(p.negativeRisk);
    const tokenId = String(p.asset ?? "");
    const conditionId = String(p.conditionId ?? "");
    const outcomeIndex = Number(p.outcomeIndex ?? 0);
    const title = String(p.title ?? "").slice(0, 40);

    if (redeemable && curPrice >= 0.5 && isAutoClaimWinnersEnabled()) {
      // Winner → redeem on-chain
      if (negRisk) {
        console.log(`[SETTLE-CLOSE] Skip ${title} — negRisk redeem not supported`);
        continue;
      }
      actionsAttempted += 1;
      const r = await redeemPmWinner({ conditionId, outcomeIndex, negRisk, dryRun });
      if (r.ok) {
        winnersRedeemed += 1;
        console.log(`[SETTLE-CLOSE] ${dryRun ? "[DRY]" : "[LIVE]"} REDEEM winner ${title} shares=${shares} txHash=${r.txHash ?? "?"}`);
      } else {
        console.warn(`[SETTLE-CLOSE] REDEEM failed for ${title}: ${r.error}`);
      }
      continue;
    }

    if (redeemable && curPrice < 0.5 && isAutoSellLosersEnabled()) {
      // Loser — shares are near-worthless but dust-sell for anything the book offers
      actionsAttempted += 1;
      const r = await sellPmAtMarket({ tokenId, shares, negRisk, dryRun });
      if (r.ok) {
        losersSold += 1;
        console.log(`[SETTLE-CLOSE] ${dryRun ? "[DRY]" : "[LIVE]"} SELL loser ${title} shares=${shares} @ $${r.price}`);
      } else {
        console.warn(`[SETTLE-CLOSE] SELL loser failed for ${title}: ${r.error}`);
      }
      continue;
    }

    // "kal-settled-pm-pending" path: we'd need the full classifier here to know
    // if the paired KAL market settled. To keep this cycle cheap we defer this
    // logic to the dashboard endpoint (which already computes it) and only act
    // here if AUTO_EXIT_PM_KAL_SETTLED is on + a paired trade record flags it.
    // For now this branch is a no-op stub; enable via the dashboard instead.
    if (!redeemable && isAutoExitKalSettledEnabled()) {
      // Intentional: the current auto-exit path requires querying Kalshi for
      // every paired ticker. Skipping here — trigger via the dashboard manually
      // or run auto-sell-losers alone which covers the redeemable subset.
    }
  }

  if (actionsAttempted > 0) {
    console.log(`[SETTLE-CLOSE] cycle complete: winners=${winnersRedeemed}, losers=${losersSold}, kalExited=${kalExited} (dryRun=${dryRun})`);
  }
}
