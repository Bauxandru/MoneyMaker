/**
 * runARB.ts -- Standalone entry point for the ARB arbitrage bot.
 *
 * Uses the audited, split ARB modules instead of the monolithic tradeTennis.ts.
 * tradeTennis.ts is left untouched -- this is a parallel, independent program.
 *
 * Usage:
 *   DRY_RUN=true npx tsx src/runARB.ts
 *   DRY_RUN=false TRADE_USD=10 npx tsx src/runARB.ts
 */

import fs from "fs";
import path from "path";

// --- ARB module imports (audited & fixed versions) --------------------------
import {
  // Config
  DRY_RUN, TRADE_USD, MAX_CONTRACTS, MIN_EDGE, MIN_DEPTH_MULT,
  FORCE_DISCOVER, KAL_MAKER_MODE, KAL_MAKER_WAIT_MS,
  fmtPct, atomicWriteFileSync,

  // Persistence
  loadArbTrades, loadHedgeStates, saveHedgeStates, loadMetrics,
  setAllHedgeStates, setReconcileRecoveredTrades,
  getIncompletePendingFills, getActivePendingFillId,

  // WebSocket
  connectKalshiWs, connectPmWs, connectPmUserWs, setPmGhostFillHandler, subscribeWatchlist,

  // PM Orders
  createPmClient,

  // Discovery
  discoverWatchlist, saveDiscoveryCache, loadDiscoveryCache, loadStaticPairs,

  // Reconcile
  reconcilePositions, handleGhostFill,
  fetchPmPositionsCached, sumPmHeld,

  // Hedge
  detectUnhedgedPmPositions, detectUnhedgedKalPositions,

  // Execution (the newly extracted functions)
  monitorLoop, buildHardcodedWatchlist,

  // Event log
  appendEvent,

  // Types
  type WatchEntry, type HedgeState, type PmLeg, type KalshiLeg,
} from "./ARB/index.js";

// --- External dependencies (not in ARB) -------------------------------------
import { getKalshiPositionMap, getKalshiBalance } from "./kalshiTrade.js";
import { getUsdcBalance, subscribeToFills, subscribeToSettlements } from "./polyChain.js";
import { sleep } from "./utils.js";
import { validateLicense, startPeriodicRevalidation } from "./licenseClient.js";
import { startPeriodicPush } from "./dashboardPush.js";
import { matchCodePrefix } from "./ARB/ttNameMatch.js";
import { polyFetch } from "./ARB/ttConfig.js";

// --- Settlement filtering helpers --------------------------------------------

/**
 * Fetch conditionIds from the Gamma API for all unique PM slugs in the watchlist.
 * Returns a Map<conditionId, pmSlug> for filtering on-chain settlement events
 * and a reverse Map<conditionId, matchName> for logging.
 */
async function buildConditionIdIndex(watchlist: WatchEntry[]): Promise<{
  conditionIds: Set<string>;
  conditionToSlug: Map<string, string>;
}> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const conditionIds = new Set<string>();
  const conditionToSlug = new Map<string, string>();
  const uniqueSlugs = [...new Set(watchlist.map(w => w.pmSlug))];

  // Batch fetch: query Gamma API for each unique slug
  let fetched = 0, failed = 0;
  for (const slug of uniqueSlugs) {
    try {
      const raw = await polyFetch<Array<{ conditionId?: string; condition_id?: string }>>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
      const markets = Array.isArray(raw) ? raw : [];
      for (const m of markets) {
        const cid = m.conditionId ?? m.condition_id;
        if (cid) {
          conditionIds.add(cid.toLowerCase());
          conditionToSlug.set(cid.toLowerCase(), slug);
          fetched++;
        }
      }
    } catch {
      failed++;
    }
  }
  console.log(`[CHAIN] ConditionId index: ${conditionIds.size} IDs from ${uniqueSlugs.length} slugs (${failed} fetch failures)`);
  return { conditionIds, conditionToSlug };
}

// --- Main -------------��-----------------------------��-----------------------

async function main() {
  // License validation (skipped if not configured)
  if (process.env.LICENSE_SERVER && process.env.LICENSE_TOKEN) {
    await validateLicense();
    startPeriodicRevalidation();
    startPeriodicPush();
    console.log("[TRADER] License validated, dashboard push active");
  }

  if (DRY_RUN) {
    console.log(`[TRADER] DRY RUN mode -- no real orders will be placed`);
  } else {
    console.log(`[TRADER] *** LIVE MODE *** -- orders WILL be placed on real markets!`);
    console.log(`[TRADER] Budget: $${TRADE_USD}/trade | Max: ${MAX_CONTRACTS} contracts | MinEdge: ${fmtPct(MIN_EDGE)} | DepthMult: ${MIN_DEPTH_MULT}x`);
    console.log(`[TRADER] KAL_MAKER_MODE: ${KAL_MAKER_MODE ? "ON (GTC bid at ask-1c, wait " + KAL_MAKER_WAIT_MS + "ms)" : "OFF (IOC taker)"}`);
    if (!process.env.POLY_WALLET_PRIVATE_KEY?.trim()) {
      throw new Error("Set POLY_WALLET_PRIVATE_KEY for live trading (or set DRY_RUN=true).");
    }
    if (!process.env.KALSHI_API_KEY_ID?.trim()) {
      throw new Error("Set KALSHI_API_KEY_ID for live trading (or set DRY_RUN=true).");
    }
    console.log("[TRADER] Starting in 5 seconds... (Ctrl+C to abort)");
    await sleep(5000);
  }

  // -- Build watchlist --
  let watchlist: WatchEntry[];
  if (process.env.HARDCODED_MARKETS === "true") {
    watchlist = buildHardcodedWatchlist();
    console.log(`\n[DISCOVER] Using hardcoded watchlist: ${watchlist.length} pair(s)\n`);
  } else {
    const cache = FORCE_DISCOVER ? null : loadDiscoveryCache();
    if (cache) {
      watchlist = cache.watchlist;
      console.log(`\n[DISCOVER] Loaded ${watchlist.length} pairs from cache (${cache.noMatchPairs.length} known no-match skipped)\n`);
    } else {
      console.log("\n[DISCOVER] Building watchlist from Kalshi + Polymarket...");
      const result = await discoverWatchlist();
      watchlist = result.watchlist;
      saveDiscoveryCache(watchlist, result.noMatchPairs);
      console.log(`[DISCOVER] Watchlist: ${watchlist.length} matched cross-platform pairs\n`);
    }
  }

  // -- Merge static pairs from CSV --
  try {
    const staticPairs = await loadStaticPairs();
    if (staticPairs.length > 0) {
      const existingCodes = new Set(watchlist.map(w => w.matchCode));
      let added = 0;
      for (const sp of staticPairs) {
        if (!existingCodes.has(sp.matchCode)) {
          watchlist.push(sp);
          existingCodes.add(sp.matchCode);
          added++;
        }
      }
      console.log(`[STATIC] Added ${added} pairs from data/static_pairs.csv (${staticPairs.length - added} already discovered)`);
    }
  } catch (err) {
    console.warn(`[STATIC] Failed to load static pairs: ${(err as Error).message}`);
  }

  if (!watchlist.length) {
    console.log("[TRADER] No matches found.");
    return;
  }

  // -- Log wallet balances --
  try {
    const [kalBal, pmBal] = await Promise.all([
      getKalshiBalance().catch(() => -1),
      getUsdcBalance().catch(() => -1),
    ]);
    const kalStr = kalBal >= 0 ? `$${kalBal.toFixed(2)}` : "unavailable";
    const pmStr = pmBal >= 0 ? `$${pmBal.toFixed(2)}` : "unavailable";
    const totalStr = kalBal >= 0 && pmBal >= 0 ? `$${(kalBal + pmBal).toFixed(2)}` : "partial";
    console.log(`[STARTUP] Wallet balances -- Kalshi: ${kalStr} | PM USDC: ${pmStr} | Total: ${totalStr}`);
    try {
      const balLogPath = path.join("data", "balance_log.json");
      const balLog: { ts: string; kalshi: number; pm: number; total: number }[] =
        fs.existsSync(balLogPath) ? JSON.parse(fs.readFileSync(balLogPath, "utf8")) : [];
      balLog.push({
        ts: new Date().toISOString(),
        kalshi: kalBal >= 0 ? Math.round(kalBal * 100) / 100 : -1,
        pm: pmBal >= 0 ? Math.round(pmBal * 100) / 100 : -1,
        total: kalBal >= 0 && pmBal >= 0 ? Math.round((kalBal + pmBal) * 100) / 100 : -1,
      });
      atomicWriteFileSync(balLogPath, JSON.stringify(balLog, null, 2));
    } catch { /* non-critical */ }
  } catch (err) {
    console.warn(`[STARTUP] Balance check failed: ${(err as Error).message}`);
  }

  // -- Startup reconciliation --
  console.log("[STARTUP] Running position reconciliation (non-blocking)...");
  reconcilePositions("startup").catch(err =>
    console.error(`[RECONCILE] Startup reconciliation failed: ${(err as Error).message}`)
  );

  // Schedule hourly reconciliation
  setInterval(() => {
    reconcilePositions("hourly").catch(err =>
      console.error(`[RECONCILE] Hourly reconciliation error: ${(err as Error).message}`)
    );
  }, 60 * 60 * 1000);

  // -- Build conditionId index for settlement filtering --
  const { conditionIds: watchedConditions, conditionToSlug } = await buildConditionIdIndex(watchlist);

  // Debounce settlement-triggered reconciliation: batch rapid settlements into one reconcile call.
  // Uses a lock to prevent reconciliation from overlapping with scan cycles.
  let settlementReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileRunning = false;
  let lastReconcileEndTs = 0;
  const SETTLEMENT_RECONCILE_DELAY_MS = 30_000; // wait 30s after last settlement before reconciling
  const RECONCILE_COOLDOWN_MS = 120_000; // minimum 2 min between reconciliations

  // -- On-chain subscriptions --
  try {
    await subscribeToFills((tokenId, shares, txHash, block) => {
      console.log(`[CHAIN] Fill detected: ${shares} shares, token=...${tokenId.slice(-12)} block=${block} tx=${txHash.slice(0, 18)}...`);
      // Apply the same ghost verification as PM User WS:
      // 1. Must match an incomplete pending fill
      // 2. Must NOT be the currently executing order
      const pending = getIncompletePendingFills();
      const match = pending.find(pf => pf.exchange === "pm" && pf.pmTokenId === tokenId);
      if (!match) return; // not our fill or already completed
      const activePf = getActivePendingFillId();
      if (match.id === activePf) {
        console.log(`[CHAIN] Skipping ghost -- pending fill ${match.id} is active execution.`);
        return;
      }
      console.warn(`[CHAIN] Ghost candidate: match=${match.id} activePf=${activePf} completed=${match.completed ?? false}`);
      audit({ module: "ws", fn: "chainFillHandler", action: "chain-ghost-candidate", tradeId: match.id, shares, context: { tokenId: tokenId.slice(-16), activePfId: activePf, matchCompleted: match.completed, txHash: txHash.slice(0, 20) } });
      handleGhostFill(tokenId, shares, txHash).catch(err =>
        console.warn(`[GHOST] Detection error: ${(err as Error).message}`)
      );
    });
    await subscribeToSettlements((conditionId, payoutNumerators, block) => {
      const cidLower = conditionId.toLowerCase();
      if (!watchedConditions.has(cidLower)) return; // ignore unrelated markets

      const slug = conditionToSlug.get(cidLower) ?? "unknown";
      console.log(`[CHAIN] Settlement detected: ${slug} payouts=[${payoutNumerators.join(",")}] block=${block}`);

      // Emit PM settlement event for any trades matching this slug
      try {
        const trades = loadArbTrades();
        for (const t of trades) {
          if (t.pmSlug !== slug) continue;
          // Determine PM payout from numerators: [yesNumerator, noNumerator]
          // payoutNumerators are relative (e.g. [1,0] = yes wins, [0,1] = no wins)
          const pmResult = payoutNumerators[0] > 0 ? "yes" : "no";
          const pmPayout = t.shares; // $1/share for winning side, $0 for losing
          appendEvent({
            type: "settlement-detected", tradeId: t.id, exchange: "pm", orderId: "",
            ticker: slug, result: pmResult, settlementValue: payoutNumerators[0] > 0 ? 1 : 0,
            payout: pmPayout, source: "pm-resolution",
          } as any);
        }
      } catch (err) {
        console.warn(`[CHAIN] Failed to emit PM settlement event: ${(err as Error).message}`);
      }

      // Debounced reconciliation: reset timer on each new settlement
      if (settlementReconcileTimer) clearTimeout(settlementReconcileTimer);
      settlementReconcileTimer = setTimeout(() => {
        settlementReconcileTimer = null;
        if (reconcileRunning) {
          console.log(`[CHAIN] Settlement reconciliation skipped -- already running.`);
          return;
        }
        const sinceLastReconcile = Date.now() - lastReconcileEndTs;
        if (sinceLastReconcile < RECONCILE_COOLDOWN_MS) {
          console.log(`[CHAIN] Settlement reconciliation skipped -- cooldown (${Math.round((RECONCILE_COOLDOWN_MS - sinceLastReconcile) / 1000)}s remaining).`);
          return;
        }
        reconcileRunning = true;
        console.log(`[CHAIN] Settlement-triggered reconciliation starting (background)...`);
        reconcilePositions("settlement")
          .catch(err => console.error(`[RECONCILE] Settlement-triggered reconciliation error: ${(err as Error).message}`))
          .finally(() => { reconcileRunning = false; lastReconcileEndTs = Date.now(); });
      }, SETTLEMENT_RECONCILE_DELAY_MS);
    });
  } catch (err) {
    console.warn(`[CHAIN] WebSocket subscriptions failed (non-blocking): ${(err as Error).message}`);
  }

  // -- Start exchange WebSocket feeds --
  console.log("[WS] Starting Kalshi + Polymarket WebSocket feeds...");
  connectKalshiWs();
  connectPmWs();
  connectPmUserWs();
  // Ghost fill detection via PM User WS — more reliable than on-chain TransferSingle
  // (single event with exact shares, vs on-chain which can split across multiple transfers).
  // Verifier checks two conditions before confirming a ghost:
  //   1. tokenId matches an uncompleted pending fill
  //   2. That pending fill is NOT the currently executing order
  setPmGhostFillHandler(
    (tokenId, shares, tradeId) => {
      handleGhostFill(tokenId, shares, tradeId).catch(err =>
        console.warn(`[GHOST] WS detection error: ${(err as Error).message}`)
      );
    },
    (tokenId) => {
      const pending = getIncompletePendingFills();
      const match = pending.find(pf => pf.exchange === "pm" && pf.pmTokenId === tokenId);
      if (!match) return null; // not our trade — normal fill or unrelated
      if (match.id === getActivePendingFillId()) return null; // active execution handles this
      return { isGhost: true, pendingFillId: match.id };
    },
  );
  subscribeWatchlist(watchlist);

  // -- Enter main trading loop --
  await monitorLoop(watchlist);
}

// --- Boot -------��-----------------------------------------------------------

console.log("[BOOT] Starting ARB bot (audited modules)...");
main().catch((err) => {
  console.error("[ARB TRADER] Fatal:", (err as Error).message ?? err);
  process.exit(1);
});
