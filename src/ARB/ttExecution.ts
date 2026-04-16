// ─── ttExecution.ts ──────────────────────────────────────────────────────────
// Extracted from tradeTennis.ts: core execution logic for arbitrage trading.
// Contains: executeArb, executeArb3Leg, monitorLoop, buildHardcodedWatchlist,
//           map3LegDir, and the Leg3 type.
//
// IMPORTANT: This is a live trading bot. Every line is exact from the original
// tradeTennis.ts, with only import paths adjusted for the ARB module layout.
// ─────────────────────────────────────────────────────────────────────────────

import {
  DRY_RUN, SERVER_ID, PARALLEL_MODE, TRADE_USD, MAX_CONTRACTS, MIN_EDGE,
  POLL_INTERVAL_MS, TRADE_COOLDOWN_MS,
  HEDGE_TARGET, STRICT_HEDGE, PM_ONLY_MAX_CYCLES,
  FORCE_DISCOVER, MAX_CONSECUTIVE_ERRORS, MAX_HEDGE_POSITIONS,
  KAL_WS_STALE_MS, PM_WS_STALE_MS,
  DISCOVERY_CACHE_TTL_MS, MIN_DEPTH_MULT,
  PM_MARKETABLE_MIN_VALUE, KALSHI_FEE_RATE, PM_FEE_RATE,
  pmFeeRateFor, pmFeePaid,
  KAL_MAKER_MODE, KAL_MAKER_WAIT_MS, KAL_MAKER_POLL_MS,
  PM_ORDER_TYPE,
  atomicWriteFileSync, fmtPct, ts, estimateFees,
  retryOpts, kalFetch, polyFetch, polyClobFetch,
  parseGammaEvents, parseGammaMarkets, parseKalshiMarkets,
} from "./ttConfig.js";

import {
  loadArbTrades, saveArbTrades, logArbTrade, resolveArbTrade,
  loadPendingFills, completePendingFill, getIncompletePendingFills,
  addPendingFill, savePendingFills,
  loadMetrics, appendMetric,
  loadHedgeStates, saveHedgeState, saveHedgeStates,
  loadDepthOpportunities, appendDepthOpportunity, sweepFullProfitableDepth,
  loadBookSnapshots, saveBookTrack,
  _activePendingFillId, setActivePendingFillId,
  _allHedgeStates, setAllHedgeStates,
  _reconcileRecoveredTrades, setReconcileRecoveredTrades,
  kalBookCache, BOOK_CACHE_TTL,
} from "./ttPersistence.js";

import {
  connectKalshiWs, connectPmWs, subscribeWatchlist,
  wsKalBooks, wsPmBooks,
  getWsKalBook, getWsPmAsks, getWsPmBids,
  getWsKalBestAsk, getWsPmBestAsk, getWsPmBestBid,
  recordPrice, getMomentum,
  isPmServiceDown, markPmDown, markPmUp, isPm425,
  getPmServiceDownUntil, getPmWsReady, getPmWsSubs,
  isKalMarketSettled, getKalSettlement,
  waitForKalFillData,
} from "./ttWebSocket.js";

import {
  createPmClient, placePmOrder, placePmGTCAsk, placePmGTCBid,
  placePmFOK, placePmFOKSell,
  cancelPmOrder, cancelAllPmOrdersForToken,
  getPmOrderFills, preSignPmOrder, postPreSignedPmOrder,
  waitForPmOrderFill,
  buildKalshiIOCOrder, sweepKalshiDepth,
  deriveYesAsks, deriveNoAsks,
  fetchPmAsk, fetchPmAskDirect, fetchPmBidDirect, fetchPmAskDepth,
  pmSafePrice, fetchKalshiSingleMarket, refreshKalshiPrices,
  sweepPmDepth,
} from "./ttPmOrders.js";

import {
  discoverWatchlist, saveDiscoveryCache, loadDiscoveryCache, loadStaticPairs,
} from "./ttDiscovery.js";

import {
  reconcilePositions, handleGhostFill, startBookTracker,
  postResolutionFillAudit,
  fetchPmPositionsCached, sumPmHeld,
  extractPmMeta, extractKalMeta, getPmFunder,
} from "./ttReconcile.js";

import {
  runHedgeCycle, releaseHedgeCycleLock,
  detectUnhedgedPmPositions, detectUnhedgedKalPositions,
  recheckAndCancelAll, collectOpenPositions, runCancellationMonitor,
  extractEventDateKey, isScalarSettlement, fetchPmBestBid,
  _hedgeLogCounter,
} from "./ttHedge.js";

import {
  matchCodePrefix, namesMatch, extractEntityName,
  NBA_SERIES, MLB_SERIES, CBB_SERIES,
  nbaNameToAbbr, mlbNameToAbbr, cbbNamesMatch,
} from "./ttNameMatch.js";

import type {
  WatchEntry, ArbDir, KalshiLeg, PmLeg,
  HedgeState, HedgeOrder, UnhedgedPosition,
  ArbTradeRecord, ExecMetric, KalshiMarket,
  PmPosition, OpenPosition, PendingFill,
  DepthLevel, DepthOpportunity, ClobBookEntry,
} from "./ttTypes.js";

import {
  placeKalshiOrder, getKalshiOrder, cancelKalshiOrder,
  buildKalshiGTCOrder, getKalshiPosition, getKalshiPositionMap,
  fetchKalshiOrderbook, fetchAllKalshiFills, getKalshiBalance,
  fetchOpenKalshiOrders, fetchKalshiMarket,
} from "../kalshiTrade.js";

import {
  getOnChainBalance, getOnChainBalanceWithFallback, getUsdcBalance,
  subscribeToFills, subscribeToSettlements, isFillSubscriptionActive,
} from "../polyChain.js";

import {
  sleep, r2, pickString, parseJsonArray,
  normCents, normDollarsOrCents,
  bestAskFromSide, bestBidFromSide,
  kalSideForDir, totalCostForTrade,
  numEnv, boolEnv, strEnv,
} from "../utils.js";

import { fetchJsonWithRetry } from "../http.js";

import {
  isLateGame, isMatchFinished, isMatchCancelled, getMatchState,
} from "../liveScores.js";

import {
  validateLicense, startPeriodicRevalidation, isLicenseValid,
} from "../licenseClient.js";

import { pushTradeData, startPeriodicPush } from "../dashboardPush.js";

import { maybeShadowCompare } from "./ttEventLog.js";

// ─── executeArb ──────────────────────────────────────────────────────────────

export async function executeArb(
  entry: WatchEntry,
  dir: ArbDir,   // Tennis/NBA: A-D | Soccer 2-leg NO: G-I | Soccer 3-leg: A-F (future)
  kalAsk: number,
  pmAsk: number,
  edge: number
): Promise<{ sessionSkip: boolean; unhedged: UnhedgedPosition | null; abortReason?: string }> {
  const execStart = performance.now();
  let tPmOrder = 0, tPmPoll = 0, tKalBook = 0, tKalOrder = 0, tKalVerify = 0, tPmVerify = 0;
  let tPreflight = 0, tDepthCheck = 0;
  let kalFeesTotal = 0; // actual Kalshi fees in dollars (from order response)
  let kalFillCostCents = 0; // actual Kalshi fill cost in cents (from order response)
  let kalFilled = 0; // actual Kalshi filled count
  let kalFilledViaMaker = false;
  const printTimings = () => {
    const total = performance.now() - execStart;
    const parts = [
      tPreflight > 0 ? `preflight=${tPreflight.toFixed(0)}ms` : null,
      tDepthCheck > 0 ? `depth=${tDepthCheck.toFixed(0)}ms` : null,
      tPmOrder > 0 ? `pm_order=${tPmOrder.toFixed(0)}ms` : null,
      tPmPoll > 0 ? `pm_poll=${tPmPoll.toFixed(0)}ms` : null,
      tKalBook > 0 ? `kal_book=${tKalBook.toFixed(0)}ms` : null,
      tKalOrder > 0 ? `kal_order=${tKalOrder.toFixed(0)}ms` : null,
      tKalVerify > 0 ? `kal_verify=${tKalVerify.toFixed(0)}ms` : null,
      tPmVerify > 0 ? `pm_verify=${tPmVerify.toFixed(0)}ms` : null,
    ].filter(Boolean).join("  ");
    console.log(`  [TIMING] Total=${total.toFixed(0)}ms  ${parts}`);
  };
  // ── Execution metric (recorded at every return) ──────────────────────────
  const metric: ExecMetric = {
    id: `exec-${Date.now()}`,
    ts: new Date().toISOString(),
    match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
    dir, edge, shares: 0,
    firstLeg: "pm",
    outcome: "abort-safety",
    firstLegFilled: 0, secondLegFilled: 0,
    expectedKalPrice: kalAsk, expectedPmPrice: pmAsk,
    totalMs: 0,
    firstLegOrderMs: 0, firstLegConfirmMs: 0,
    secondLegOrderMs: 0, secondLegConfirmMs: 0,
    bookFetchMs: 0,
    dryRun: DRY_RUN,
  };
  const saveExecMetric = (outcome: ExecMetric["outcome"], failReason?: string) => {
    metric.outcome = outcome;
    if (failReason) metric.failReason = failReason;
    metric.totalMs = Math.round(performance.now() - execStart);
    const pmIsFirst = metric.firstLeg === "pm";
    metric.firstLegOrderMs = Math.round(pmIsFirst ? tPmOrder : tKalOrder);
    metric.firstLegConfirmMs = Math.round(pmIsFirst ? tPmPoll : tKalVerify);
    metric.secondLegOrderMs = Math.round(pmIsFirst ? tKalOrder : tPmOrder);
    metric.secondLegConfirmMs = Math.round(pmIsFirst ? tKalVerify : tPmPoll);
    metric.bookFetchMs = Math.round(tKalBook);
    metric.preflightMs = Math.round(tPreflight);
    metric.depthCheckMs = Math.round(tDepthCheck);
    metric.postVerifyMs = Math.round(tPmVerify);
    if (SERVER_ID) metric.serverId = SERVER_ID;
    appendMetric(metric);
    // Clear pending fill on abort — no exposure was taken.
    // EXCEPTION: "pm-delayed-zero" means the PM order timed out but may still settle on-chain later.
    // Keep the pending fill incomplete so the WSS ghost fill detector can catch it.
    if (outcome.startsWith("abort") && _activePendingFillId) {
      if (failReason === "pm-delayed-zero") {
        console.log(`[PENDING] Keeping pending fill ${_activePendingFillId} open — order may still settle on-chain (ghost fill watch active).`);
      } else {
        completePendingFill(_activePendingFillId);
      }
      setActivePendingFillId(null);
    }
  };

  // Direction mapping:
  //   2-way (tennis/NBA):
  //     A: buy KAL P1 YES + buy PM P2     B: buy KAL P2 YES + buy PM P1
  //     C: buy KAL P1 NO  + buy PM P1     D: buy KAL P2 NO  + buy PM P2
  //   3-way soccer (KAL NO side):
  //     G: buy KAL Home NO  + buy PM Home YES    (kal1 NO + pm1)
  //     H: buy KAL Draw NO  + buy PM Draw YES    (kal3 NO + pm3)
  //     I: buy KAL Away NO  + buy PM Away YES    (kal2 NO + pm2)
  //   3-way soccer (PM NO side):
  //     J: buy KAL Home YES + buy PM Home NO     (kal1 YES + pm1 NO token)
  //     K: buy KAL Draw YES + buy PM Draw NO     (kal3 YES + pm3 NO token)
  //     L: buy KAL Away YES + buy PM Away NO     (kal2 YES + pm2 NO token)
  let kalSide: "yes" | "no";
  let kalLeg: KalshiLeg;
  let pmLeg: PmLeg;
  if (dir === "G") {
    kalSide = "no"; kalLeg = entry.kal1; pmLeg = entry.pm1;
  } else if (dir === "H") {
    kalSide = "no"; kalLeg = entry.kal3!; pmLeg = entry.pm3!;
  } else if (dir === "I") {
    kalSide = "no"; kalLeg = entry.kal2; pmLeg = entry.pm2;
  } else if (dir === "J") {
    // KAL Home YES + PM Home NO — swap pmLeg tokenId to the NO token
    kalSide = "yes"; kalLeg = entry.kal1;
    pmLeg = { ...entry.pm1, tokenId: entry.pm1.noTokenId!, outcome: `${entry.pm1.outcome} [NO]` };
  } else if (dir === "K") {
    kalSide = "yes"; kalLeg = entry.kal3!;
    pmLeg = { ...entry.pm3!, tokenId: entry.pm3!.noTokenId!, outcome: `${entry.pm3!.outcome} [NO]` };
  } else if (dir === "L") {
    kalSide = "yes"; kalLeg = entry.kal2;
    pmLeg = { ...entry.pm2, tokenId: entry.pm2.noTokenId!, outcome: `${entry.pm2.outcome} [NO]` };
  } else {
    // ── SAFETY: binary markets only allow dirs A and C ──────────────────────
    // Dirs B/D on binary are same-outcome bets (not arbs) — never execute them.
    if (entry.isBinary && (dir === "B" || dir === "D")) {
      console.error(`\n[SAFETY ABORT] Binary market cannot execute dir ${dir} (only A/C are valid arbs)\n`);
      saveExecMetric("abort-safety", "binary-invalid-dir");
      return { sessionSkip: true, unhedged: null };
    }
    kalSide = kalSideForDir(dir);
    kalLeg  = (dir === "A" || dir === "C") ? entry.kal1 : entry.kal2;
    pmLeg   = (dir === "A" || dir === "D") ? entry.pm2  : entry.pm1;
  }

  // ── SAFETY: abort if token mapping looks wrong ───────────────────────────────
  // Dirs A/B: KAL and PM should be DIFFERENT players (opposite outcomes)
  // Dirs C/D: KAL and PM should be the SAME player (KAL NO + PM YES)
  // Soccer G-L: KAL and PM are same outcome on same market — skip name check entirely
  // Binary (isBinary): KAL and PM outcomes don't use player names (Over/Under, Yes/No) — skip
  const isSoccer2Leg = dir === "G" || dir === "H" || dir === "I" || dir === "J" || dir === "K" || dir === "L";
  const skipNameCheck = isSoccer2Leg || !!entry.isBinary;
  const execSeriesPrefix = (entry.kal1.ticker.split("-")[0] ?? "").toUpperCase();
  // For NBA/MLB: namesMatch("Washington","Wizards") fails — use abbreviation fallback
  const nbaNameMatch = NBA_SERIES.has(execSeriesPrefix) &&
    nbaNameToAbbr(kalLeg.surname) !== "" &&
    nbaNameToAbbr(kalLeg.surname) === nbaNameToAbbr(pmLeg.outcome);
  const mlbNameMatch = MLB_SERIES.has(execSeriesPrefix) &&
    mlbNameToAbbr(kalLeg.surname) !== "" &&
    mlbNameToAbbr(kalLeg.surname) === mlbNameToAbbr(pmLeg.outcome);
  const cbbNameMatch = CBB_SERIES.has(execSeriesPrefix) && cbbNamesMatch(kalLeg.surname, pmLeg.outcome);
  const sameName = skipNameCheck ? true : (namesMatch(kalLeg.surname, pmLeg.outcome) || nbaNameMatch || mlbNameMatch || cbbNameMatch);
  // For A/B: expect different names. For C/D: expect same names.
  // For soccer G-L and binary: sameName is forced true — expectSame must also be true to pass.
  const expectSame = skipNameCheck ? true : (kalSide === "no");
  if (sameName !== expectSame) {
    console.error(
      `\n[SAFETY ABORT] Token mapping error! KAL=${kalLeg.surname}(${kalSide}) PM=${pmLeg.outcome}` +
      ` (dir=${dir}). Expected ${expectSame ? "same" : "different"} player names.` +
      `\n  kal1=${entry.kal1.surname} kal2=${entry.kal2.surname}` +
      `\n  pm1=${entry.pm1.outcome} (${entry.pm1.tokenId.slice(0,12)}...)` +
      `\n  pm2=${entry.pm2.outcome} (${entry.pm2.tokenId.slice(0,12)}...)\n`
    );
    saveExecMetric("abort-safety", "token-mapping");
    return { sessionSkip: true, unhedged: null };
  }

  // ── SAFETY: abort if edge is unrealistically large (> 45%) ─────────────────
  // Esports/tennis markets can have 20-35% legitimate cross-platform disagreements
  // due to thin liquidity and different user bases. Only block truly absurd edges.
  if (edge > 0.45) {
    console.error(
      `\n[SAFETY ABORT] Edge ${fmtPct(edge, 2)} exceeds 45% — likely token price mapping error.` +
      ` KAL=${kalLeg.surname}@${fmtPct(kalAsk)} PM=${pmLeg.outcome}@${fmtPct(pmAsk)}\n`
    );
    saveExecMetric("abort-safety", "edge-too-large");
    return { sessionSkip: true, unhedged: null };
  }

  // ── SAFETY: abort if Kalshi market is cancelled/scalar-settled ──────────────
  // Before spending money, verify the Kalshi market is actually open and tradeable.
  // A market that settled as "scalar" (cancelled/voided) breaks the $1 arb guarantee.
  // Also block sibling markets (same date + series) — Kalshi re-lists cancelled matches
  // with new tickers (e.g. FNMKOI → FNKOIA) which will likely cancel again.
  if (_cancelledTickers.has(kalLeg.ticker)) {
    console.warn(`[SAFETY ABORT] ${kalLeg.ticker} already flagged as cancelled/scalar. Skipping.`);
    saveExecMetric("abort-safety", "market-cancelled");
    return { sessionSkip: true, unhedged: null };
  }
  const eventDateKey = extractEventDateKey(kalLeg.ticker);
  if (_cancelledEventKeys.has(eventDateKey)) {
    console.warn(
      `[SAFETY ABORT] ${kalLeg.ticker} shares event date key "${eventDateKey}" with a cancelled market. ` +
      `Sibling market likely to also cancel. Skipping.`
    );
    saveExecMetric("abort-safety", "sibling-cancelled");
    return { sessionSkip: true, unhedged: null };
  }
  if (!DRY_RUN) {
    // Skip REST preflight if WS confirms market is active (saves ~300ms).
    // WS orderbook data within staleness window = market is active.
    // WS settlement cache = market is closed/settled.
    const wsBook = getWsKalBook(kalLeg.ticker);
    const wsSettled = isKalMarketSettled(kalLeg.ticker);

    if (wsSettled) {
      // WS says market settled — abort immediately, no REST call needed
      const settlement = getKalSettlement(kalLeg.ticker);
      console.error(
        `\n[SAFETY ABORT] Kalshi market ${kalLeg.ticker} settled (WS: result=${settlement?.result || "?"}).` +
        ` Cannot trade a settled market.\n`
      );
      if (settlement?.result?.toLowerCase() === "scalar") {
        _cancelledTickers.add(kalLeg.ticker);
        _cancelledEventKeys.add(extractEventDateKey(kalLeg.ticker));
      }
      saveExecMetric("abort-safety", "market-settled-ws");
      return { sessionSkip: true, unhedged: null };
    }

    if (wsBook) {
      // WS has fresh orderbook data — market is active, skip REST preflight
      tPreflight = 0;
    } else {
      // WS data is stale or missing — fall back to REST preflight check
      const _tPre0 = performance.now();
      try {
        const preflightMkt = await fetchKalshiMarket(kalLeg.ticker);
        tPreflight = performance.now() - _tPre0;
        const preflightStatus = pickString(preflightMkt.status ?? preflightMkt.state ?? "").toLowerCase();
        const preflightResult = pickString(preflightMkt.result ?? "").toLowerCase();
        if (preflightStatus !== "active" && preflightStatus !== "open") {
          console.error(
            `\n[SAFETY ABORT] Kalshi market ${kalLeg.ticker} is ${preflightStatus} (result=${preflightResult || "none"}).` +
            ` Cannot trade a non-active market.\n`
          );
          if (preflightResult === "scalar") {
            _cancelledTickers.add(kalLeg.ticker);
            _cancelledEventKeys.add(extractEventDateKey(kalLeg.ticker));
          }
          saveExecMetric("abort-safety", `market-${preflightStatus}`);
          return { sessionSkip: true, unhedged: null };
        }
      } catch {
        tPreflight = performance.now() - _tPre0;
        // If we can't verify, proceed cautiously — the order will fail anyway if market is closed
      }
    }
  }

  // Sizing: budget-limited, capped by MAX_CONTRACTS, floored by PM minSize AND PM $1 order value
  const costPerShare = kalAsk + pmAsk;
  const sharesByBudget = Math.max(1, Math.floor(TRADE_USD / costPerShare));
  let shares = Math.min(sharesByBudget, MAX_CONTRACTS);

  // Effective PM minimum: per-market minSize (typically 5 shares) + PM $1 FOK floor
  const pmMinByFOK = pmAsk > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pmAsk) : pmLeg.minSize;
  const effectivePmMin = Math.max(pmLeg.minSize, pmMinByFOK);

  if (shares < effectivePmMin) {
    const minCost = effectivePmMin * costPerShare;
    if (effectivePmMin > MAX_CONTRACTS || minCost > TRADE_USD * 1.1) {
      console.warn(
        `  [SKIP] PM effective min=${effectivePmMin} (minSize=${pmLeg.minSize})` +
        ` cost=$${minCost.toFixed(2)} exceeds budget $${TRADE_USD}. PM ask too low.`
      );
      metric.shares = shares;
      saveExecMetric("abort-pre-first", "pm-min-exceeds-budget");
      return { sessionSkip: false, unhedged: null, abortReason: "soft" };
    }
    shares = effectivePmMin;
  }

  let totalCost = shares * costPerShare;
  let projectedProfit = shares * edge;
  // ── Momentum-based leg ordering ────────────────────────────────────────────
  // Determine which side's ask is rising (getting more expensive / escaping from us).
  // Buy the "hotter" side first — if its ask is spiking, grab it before it's worse.
  // The other side is stable or getting cheaper and will likely still be there.
  // PM-first is safer (failed fill = zero exposure) but subject to 3s sports delay.
  // KAL-first is faster (instant fill) but commits capital before PM confirms.
  const kalMomentumKey = `kal:${kalLeg.ticker}:${kalSide}`;
  const pmMomentumKey = `pm:${pmLeg.tokenId}`;
  const kalMom = getMomentum(kalMomentumKey);
  const pmMom = getMomentum(pmMomentumKey);
  // Positive momentum = price rising = getting more expensive for us
  // Buy the side that is rising faster first. Default to PM-first when equal
  // (PM has thinner books and 3s sports delay means failed fill costs nothing).
  const pmFirst = false; // KAL-first always — PM FAK at breakeven after KAL fill
  metric.shares = shares;
  metric.firstLeg = pmFirst ? "pm" : "kal";

  const tag = DRY_RUN ? "[DRY]" : "[LIVE]";
  const momTag = `kalMom=${kalMom >= 0 ? "+" : ""}${(kalMom * 100).toFixed(1)}¢ pmMom=${pmMom >= 0 ? "+" : ""}${(pmMom * 100).toFixed(1)}¢`;
  console.log(
    `\n${ts()} ${tag} ARB EXECUTE  dir=${dir}  edge=${fmtPct(edge, 2)}` +
    `  shares=${shares}  cost~=$${totalCost.toFixed(2)}  profit~=$${projectedProfit.toFixed(2)}` +
    `  order=${pmFirst ? "PM→KAL" : "KAL→PM"}  ${momTag}`
  );
  console.log(`  KAL: ${kalLeg.ticker} ${kalSide.toUpperCase()} @${fmtPct(kalAsk)}`);
  console.log(`  PM:  ${entry.pmSlug} outcome=${pmLeg.outcome} @${fmtPct(pmAsk)}`);

  // KAL IOC limit: account for KAL taker fee + PM taker fee + MIN_EDGE
  // fee(price) = KALSHI_FEE_RATE * price * (1 - price) + feeRate * pmAsk * (1 - pmAsk)
  // feeRate is per-market (from gamma's feeSchedule.rate), defaults to PM_FEE_RATE.
  // Iterate: find highest kalPrice where kalPrice + fees + pmAsk + MIN_EDGE <= 1
  const pmFeeRateLeg = pmFeeRateFor(pmLeg);
  const pmFeeForLimit = pmFeeRateLeg * pmAsk * (1 - pmAsk);
  let kalLimitCents = Math.max(1, Math.min(99, Math.floor((1 - pmAsk - MIN_EDGE - pmFeeForLimit) * 100)));
  while (kalLimitCents > 0) {
    const p = kalLimitCents / 100;
    const kalFee = KALSHI_FEE_RATE * p * (1 - p);
    if (p + kalFee + pmAsk + pmFeeForLimit + MIN_EDGE <= 1) break;
    kalLimitCents--;
  }
  kalLimitCents = Math.max(1, kalLimitCents);
  const kalLimitPrice = kalLimitCents / 100;

  // ── PRE-FLIGHT DEPTH CHECK + FULL DEPTH OPPORTUNITY LOG ─────────────────────
  // Verify BOTH exchanges have sufficient liquidity before placing any orders.
  // Also log the FULL profitable depth available (beyond our budget) to assess
  // whether more capital would capture larger opportunities.
  if (MIN_DEPTH_MULT > 0 && !DRY_RUN) {
    const _tDepth0 = performance.now();
    const requiredDepth = shares * MIN_DEPTH_MULT;
    const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

    // Check both sides: WS first, REST fallback
    let kalBook = getWsKalBook(kalLeg.ticker);
    let pmAskLevels = getWsPmAsks(pmLeg.tokenId) ?? [];
    const wsHadKal = !!kalBook, wsHadPm = pmAskLevels.length > 0;
    if (!kalBook || pmAskLevels.length === 0) {
      const [restKal, restPm] = await Promise.all([
        !kalBook ? fetchKalshiOrderbook(kalLeg.ticker).catch(() => null) : null,
        pmAskLevels.length === 0 ? fetchPmAskDepth(pmLeg.tokenId, clobBase) : [],
      ]);
      if (!kalBook && restKal) kalBook = restKal;
      if (pmAskLevels.length === 0 && restPm && restPm.length > 0) pmAskLevels = restPm;
    }
    tDepthCheck = performance.now() - _tDepth0;
    if (wsHadKal || wsHadPm) console.log(`  [DEPTH] WS data: KAL=${wsHadKal ? "yes" : "no"} PM=${wsHadPm ? "yes" : "no"}`);

    // Compute max profitable prices for full depth sweep
    // KAL max: kalLimitCents (already = floor((1 - pmAsk - MIN_EDGE) × 100))
    // PM max: 1 - kalAsk - MIN_EDGE (what PM price still leaves MIN_EDGE profit)
    const pmBreakevenPrice = 1 - kalAsk - MIN_EDGE;

    // Sweep FULL profitable depth (no qty cap)
    let kalFull = { levels: [] as DepthLevel[], totalQty: 0, totalCost: 0, avgPrice: 0 };
    let pmFull = { levels: [] as DepthLevel[], totalQty: 0, totalCost: 0, avgPrice: 0 };
    let kalAskLevelsForCheck: [number, number][] = [];

    if (kalBook) {
      kalAskLevelsForCheck = kalSide === "yes"
        ? deriveYesAsks(kalBook.no)
        : deriveNoAsks(kalBook.yes);

      // If the orderbook-derived levels are empty but the market listing reports
      // an ask with known size (yes_ask_size_fp), inject a synthetic level.
      // This fixes the common case where a YES sell order exists but shows no NO bids.
      if (kalAskLevelsForCheck.length === 0) {
        const listingAskPrice = kalSide === "yes" ? kalLeg.yesAsk : kalLeg.noAsk;
        const listingAskSize = (kalSide === "yes" ? kalLeg.yesAskSize : kalLeg.noAskSize) ?? 0;
        console.log(`  [DEPTH FIX] Orderbook derived empty. kalSide=${kalSide} listingPrice=${(listingAskPrice*100).toFixed(0)}c listingSize=${listingAskSize} bookYes=${kalBook.yes.length}lvls bookNo=${kalBook.no.length}lvls`);
        if (listingAskSize > 0 && listingAskPrice > 0 && listingAskPrice < 1) {
          const priceCents = Math.round(listingAskPrice * 100);
          kalAskLevelsForCheck = [[priceCents, listingAskSize]];
          console.log(`  [DEPTH FIX] Orderbook empty but market lists ${kalSide} ask: ${listingAskSize} contracts @ ${priceCents}c — using listing data`);
        }
      }

      kalFull = sweepFullProfitableDepth(kalAskLevelsForCheck, kalLimitCents, true);
    }
    if (pmAskLevels.length > 0) {
      pmFull = sweepFullProfitableDepth(pmAskLevels, pmBreakevenPrice, false);
    }

    // Log helper — called on both abort and proceed
    const matchName = `${entry.kal1.surname} vs ${entry.kal2.surname}`;
    const logDepthOpp = (outcome: "executed" | "aborted", failReason?: string) => {
      const maxShares = Math.min(kalFull.totalQty, pmFull.totalQty);
      const avgCostPerShare = (kalFull.avgPrice || kalAsk) + (pmFull.avgPrice || pmAsk);
      const maxUsd = maxShares * avgCostPerShare;
      // Compute projected P&L by walking levels pair-wise (not averages).
      // Each level-pair: pnl = min(kalQty, pmQty) * (1 - kalPrice - pmPrice - fees(kalPrice, pmPrice))
      // Only count positive-edge pairs.
      let projPnl = 0;
      if (kalFull.levels.length > 0 && pmFull.levels.length > 0) {
        let ki = 0, pi = 0;
        let kalRem = kalFull.levels[0]?.size ?? 0;
        let pmRem = pmFull.levels[0]?.size ?? 0;
        while (ki < kalFull.levels.length && pi < pmFull.levels.length) {
          const kp = kalFull.levels[ki].price;
          const pp = pmFull.levels[pi].price;
          const pairEdge = 1 - kp - pp - estimateFees(kp, pp);
          const qty = Math.min(kalRem, pmRem);
          if (pairEdge > 0) projPnl += qty * pairEdge;
          kalRem -= qty;
          pmRem -= qty;
          if (kalRem <= 0) { ki++; if (ki >= kalFull.levels.length) break; kalRem = kalFull.levels[ki].size; }
          if (pmRem <= 0) { pi++; if (pi >= pmFull.levels.length) break; pmRem = pmFull.levels[pi].size; }
        }
      } else if (maxShares > 0) {
        // Fallback: single-level estimate
        const avgEdge = 1 - (kalFull.avgPrice || kalAsk) - (pmFull.avgPrice || pmAsk) - estimateFees(kalFull.avgPrice || kalAsk, pmFull.avgPrice || pmAsk);
        projPnl = maxShares * Math.max(0, avgEdge);
      }
      const opp: DepthOpportunity = {
        id: `depth-${Date.now()}`,
        ts: new Date().toISOString(),
        match: matchName, dir, edge, kalAsk, pmAsk,
        outcome, failReason,
        kalLevels: kalFull.levels,
        kalTotalContracts: kalFull.totalQty,
        kalTotalCostUsd: Math.round(kalFull.totalCost * 100) / 100,
        kalAvgPrice: Math.round(kalFull.avgPrice * 10000) / 10000,
        pmLevels: pmFull.levels,
        pmTotalShares: pmFull.totalQty,
        pmTotalCostUsd: Math.round(pmFull.totalCost * 100) / 100,
        pmAvgPrice: Math.round(pmFull.avgPrice * 10000) / 10000,
        maxProfitableShares: maxShares,
        maxInvestableUsd: Math.round(maxUsd * 100) / 100,
        projectedPnlUsd: Math.round(projPnl * 100) / 100,
        budgetShares: shares,
      };
      appendDepthOpportunity(opp);
      if (maxShares > shares) {
        console.log(`  [DEPTH OPP] Full profitable depth: ${maxShares} shares (we trade ${shares}) | investable=$${maxUsd.toFixed(2)} | projected P&L=$${projPnl.toFixed(2)}`);
      }
    };

    // Kalshi depth — sweep available liquidity
    let kalAvail = 0;
    {
      if (kalAskLevelsForCheck.length > 0) {
        // Sweep ALL profitable depth (no cap) to know total available
        kalAvail = kalFull.totalQty;
      }
      // If orderbook sweep found nothing, try market listing as fallback.
      if (kalAvail === 0) {
        const listingAskQty = (kalSide === "yes" ? kalLeg.yesAskSize : kalLeg.noAskSize) ?? 0;
        const listingPriceCents = Math.round((kalSide === "yes" ? kalLeg.yesAsk : kalLeg.noAsk) * 100);
        if (listingAskQty > 0 && listingPriceCents <= kalLimitCents) {
          kalAvail = listingAskQty;
          kalAskLevelsForCheck = [[listingPriceCents, listingAskQty]];
          kalFull = sweepFullProfitableDepth(kalAskLevelsForCheck, kalLimitCents, true);
          console.log(`  [DEPTH FIX] Orderbook empty but market lists ${kalSide} ask: ${listingAskQty} contracts @ ${listingPriceCents}c`);
        }
      }
    }

    // PM depth — sweep available liquidity
    let pmAvail = 0;
    if (pmAskLevels.length > 0) {
      pmAvail = pmFull.totalQty;
    }

    // Dynamic share sizing: reduce shares to match available depth instead of aborting
    const maxByDepth = MIN_DEPTH_MULT > 0
      ? Math.floor(Math.min(kalAvail, pmAvail) / MIN_DEPTH_MULT)
      : Infinity;
    const originalShares = shares;

    if (maxByDepth < shares) {
      if (maxByDepth < effectivePmMin) {
        // Not enough depth even for minimum PM order — abort
        const limitingSide = kalAvail < pmAvail ? "kal" : "pm";
        const limitingAvail = Math.min(kalAvail, pmAvail);
        console.log(`  [DEPTH CHECK] Insufficient depth: ${limitingSide}=${limitingAvail} → max ${maxByDepth} shares (need ≥${effectivePmMin} for PM min). Skipping.`);
        logDepthOpp("aborted", `${limitingSide}-depth-insufficient`);
        saveExecMetric("abort-pre-first", `${limitingSide}-depth-insufficient`);
        return { sessionSkip: false, unhedged: null, abortReason: "soft" };
      }
      // Reduce shares to match depth
      shares = maxByDepth;
      metric.shares = shares;
      totalCost = shares * costPerShare;
      projectedProfit = shares * edge;
      console.log(`  [DEPTH] Adjusted shares: ${originalShares} → ${shares} (KAL depth=${kalAvail}, PM depth=${pmAvail}, mult=${MIN_DEPTH_MULT}×)`);
      console.log(`  [DEPTH] New cost=$${totalCost.toFixed(2)}  profit=$${projectedProfit.toFixed(2)}`);
    } else {
      console.log(`  [DEPTH CHECK] OK: KAL=${kalAvail} PM=${pmAvail} (need ${requiredDepth} for ${shares} shares × ${MIN_DEPTH_MULT})`);
    }

    if (pmAskLevels.length === 0) {
      console.log(`  [DEPTH CHECK] PM book unavailable — skipping depth check for PM side.`);
    }

    // Both sides passed — log as executed opportunity
    logDepthOpp("executed");
  }

  // Helper: build a UnhedgedPosition when one leg is held and the other is missing.
  // pmOppLeg: when holding a PM token, the opposite PM outcome can also complete the arb
  //   Dir A: pmLeg=pm2 (held), pmOppLeg=pm1 (can buy pm1 to own both → guaranteed $1)
  //   Dir B: pmLeg=pm1 (held), pmOppLeg=pm2
  const makeUnhedged = (held: "pm" | "kal", sharesHeld: number): UnhedgedPosition => {
    // Use actual Kalshi fill cost if available
    const kalRawCostHedge = held === "kal"
      ? (kalFillCostCents > 0 ? kalFillCostCents / 100 : sharesHeld * kalAsk)
      : 0;
    const kalCostHedge = held === "kal"
      ? Math.round((kalRawCostHedge + kalFeesTotal) * 100) / 100
      : 0;
    const actualKalPrice = held === "kal" && kalFillCostCents > 0 && kalFilled > 0
      ? Math.round((kalFillCostCents / 100 / kalFilled) * 10000) / 10000
      : kalAsk;
    const tradeId = `arb-${Date.now()}`;
    logArbTrade({
      id: tradeId,
      ts: new Date().toISOString(),
      match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
      dir,
      status: "hedging",
      shares: sharesHeld,
      kalTicker: kalLeg.ticker,
      kalFillPrice: held === "kal" ? actualKalPrice : 0,
      kalCost: kalCostHedge,
      kalFees: held === "kal" ? kalFeesTotal : 0,
      pmOutcome: pmLeg.outcome,
      pmSlug: entry.pmSlug,
      pmTokenId: pmLeg.tokenId,
      pmFillPrice: held === "pm" ? pmAsk : 0,
      pmCost: held === "pm" ? Math.round(sharesHeld * pmAsk * 100) / 100 : 0,
      pmFees: held === "pm" ? pmFeePaid(sharesHeld, pmAsk, pmLeg) : 0,
      totalCost: held === "pm" ? Math.round(sharesHeld * pmAsk * 100) / 100 : kalCostHedge,
      projectedEdge: edge,
      projectedProfit: sharesHeld * edge,
      initialExchange: held,
      ...(held === "kal" && kalFilledViaMaker ? { kalMakerFill: true } : {}),
    });
    const initCost = held === "pm" ? sharesHeld * pmAsk : kalCostHedge;
    return {
      tradeId,
      heldExchange: held,
      pmLeg,
      pmOppLeg: held === "pm"
        ? (dir === "G" || dir === "H" || dir === "I" || dir === "J" || dir === "K" || dir === "L")
          ? null  // 3-way soccer: no single opposite PM token completes the arb
          : ((dir === "A" || dir === "D") ? entry.pm1 : entry.pm2)
        : null,
      pmCostBasis: held === "pm" ? pmAsk : 0,
      kalLeg,
      kalCostBasis: held === "kal" && sharesHeld > 0
        ? Math.round((actualKalPrice + kalFeesTotal / sharesHeld) * 10000) / 10000
        : 0,
      kalSide,
      sharesHeld,
      initialShares: sharesHeld,
      initialCost: initCost,
      hedgeFillCost: 0,
      hedgeFillCostKal: 0,
      hedgeFillCostPm: 0,
      kalFees: held === "kal" ? kalFeesTotal : 0,
      initialKalFees: held === "kal" ? kalFeesTotal : 0,
    };
  };

  let pmOrderIdForVerify = ""; // set inside PM-first or KAL-first, used in post-fill verification
  let pmOrderPrice = pmAsk; // actual PM order price (may be capped at breakeven in KAL-first path)

  // Write pending fill intent BEFORE any order — crash recovery breadcrumb
  if (!DRY_RUN) {
    const pfId = `pf-${Date.now()}`;
    setActivePendingFillId(pfId);
    addPendingFill({
      id: pfId,
      ts: new Date().toISOString(),
      exchange: pmFirst ? "pm" : "kal",
      tokenIdOrTicker: pmFirst ? pmLeg.tokenId : kalLeg.ticker,
      side: pmFirst ? "BUY" : kalSide,
      shares,
      price: pmFirst ? pmAsk : kalAsk,
      match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
      dir,
      pmSlug: entry.pmSlug,
      pmTokenId: pmLeg.tokenId,
      pmOutcome: pmLeg.outcome,
      kalTicker: kalLeg.ticker,
    });
  }

  // Snapshot on-chain PM balance BEFORE placing any orders.
  // Used to detect incremental fills (not total balance) — prevents false positives
  // when a prior arb on the same token left shares on-chain.
  let pmPreBalance = 0;
  if (!DRY_RUN) {
    try { const b = await getOnChainBalance(pmLeg.tokenId); if (b >= 0) pmPreBalance = b; }
    catch { /* default 0 */ }
    if (pmPreBalance > 0) console.log(`  [PRE-BAL] Existing PM on-chain balance: ${pmPreBalance} shares`);
  }

  // ── Start execution-time book tracker (20s from NOW, captures depth during actual trade) ──
  startBookTracker(kalLeg.ticker, pmLeg.tokenId, {
    match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
    dir, pmOutcome: pmLeg.outcome,
    kalAsk, pmAsk, edge,
    tradeTs: Date.now(),
  }, "execution");

  if (pmFirst) {
    // ── PM first (PM is the favourite / more expensive) ─────────────────────

    let pmResult: unknown;
    let pmFailed = false;
    console.log(`  [PM LEG] Placing: token=${pmLeg.tokenId.slice(0,16)}... price=${pmAsk} qty=${shares} tick=${pmLeg.tickSize} negRisk=${pmLeg.negRisk}`);
    const _tPm0 = performance.now();
    try {
      pmResult = await placePmOrder(pmLeg.tokenId, pmAsk, shares, pmLeg.tickSize || 0.01, pmLeg.negRisk, DRY_RUN);
    } catch (pmErr) { pmResult = pmErr; pmFailed = true; }
    tPmOrder = performance.now() - _tPm0;
    console.log(`  [PM LEG] Response (${tPmOrder.toFixed(0)}ms): ${JSON.stringify(pmResult).slice(0, 300)}`);

    if (pmFailed) {
      console.error(`  [PM LEG] FAILED (pre-Kal): ${(pmResult as Error).message}`);
      console.log("  [ABORT] Kalshi never fired. No exposure taken.");
      saveExecMetric("abort-pre-first", "pm-order-failed");
      return { sessionSkip: false, unhedged: null };
    }

    const pmMeta = extractPmMeta(pmResult);
    if (isPm425(pmResult)) {
      markPmDown();
      console.log(`  [PM LEG] Service not ready (425). Aborting — no exposure.`);
      saveExecMetric("abort-pre-first", "pm-425");
      return { sessionSkip: false, unhedged: null };
    }
    if (typeof pmMeta.status === "number") {
      console.log(`  [PM LEG] Rejected (HTTP ${pmMeta.status}). Aborting — no exposure.`);
      saveExecMetric("abort-pre-first", "pm-rejected");
      return { sessionSkip: false, unhedged: null };
    }
    markPmUp();
    if (!DRY_RUN && pmMeta.status !== "matched") {
      if (pmMeta.status === "delayed" && pmMeta.orderId) {
        // Order is on-chain but not yet confirmed — poll until it resolves
        console.log(`  [PM LEG] On-chain pending (status=delayed), polling for confirmation...`);
        const _tPoll0 = performance.now();
        const finalStatus = await waitForPmOrderFill(String(pmMeta.orderId), undefined, pmLeg.tokenId, pmPreBalance);
        tPmPoll = performance.now() - _tPoll0;
        if (finalStatus === "matched") {
          console.log(`  [PM LEG] Confirmed filled after delay (${tPmPoll.toFixed(0)}ms).`);
        } else if (finalStatus === "cancelled") {
          console.log(`  [PM LEG] Cancelled on-chain. Aborting — no exposure.`);
          printTimings();
          saveExecMetric("abort-pre-first", "pm-cancelled");
          return { sessionSkip: false, unhedged: null };
        } else {
          // timeout: order status unknown — check on-chain balance, fallback to data-api
          console.warn(`  [PM LEG] Confirmation timeout — verifying on-chain...`);
          try {
            let actualHeld = await getOnChainBalance(pmLeg.tokenId);
            if (actualHeld < 0) {
              // RPC failed → fallback to data-api
              console.warn(`  [PM LEG] On-chain check failed, falling back to data-api...`);
              const verifyPos = await fetchPmPositionsCached(0);
              actualHeld = sumPmHeld(verifyPos, pmLeg.tokenId);
            }
            const newShares = actualHeld - pmPreBalance;
            if (newShares >= shares) {
              console.log(`  [PM LEG] Verified ${newShares} new shares on-chain (total=${actualHeld}, pre=${pmPreBalance}). Proceeding.`);
            } else if (newShares > 0) {
              console.warn(`  [PM LEG] On-chain has ${newShares} new shares (total=${actualHeld}, pre=${pmPreBalance}). Entering hedge with actual qty.`);
              printTimings();
              metric.firstLegFilled = newShares;
              saveExecMetric("hedge-entry", "pm-delayed-partial");
              return { sessionSkip: true, unhedged: makeUnhedged("pm", newShares) };
            } else {
              // On-chain shows 0 new shares, but the PM order WAS submitted on-chain
              // (just not confirmed in time). It may still settle later as a ghost fill.
              // MUST skip this match to prevent double-execution on the same market.
              console.warn(`  [PM LEG] On-chain has 0 new shares (total=${actualHeld}, pre=${pmPreBalance}) — order likely failed but may ghost-fill. Skipping match.`);
              printTimings();
              saveExecMetric("abort-pre-first", "pm-delayed-zero");
              return { sessionSkip: true, unhedged: null };
            }
          } catch (verifyErr) {
            console.warn(`  [PM LEG] Wallet check failed: ${(verifyErr as Error).message} — assuming filled for safety.`);
            printTimings();
            metric.firstLegFilled = shares;
            saveExecMetric("hedge-entry", "pm-wallet-check-failed");
            return { sessionSkip: true, unhedged: makeUnhedged("pm", shares) };
          }
        }
      } else {
        // Unexpected status (e.g. "live" if PM_ORDER_TYPE=GTC partially filled).
        // Cancel the PM order to prevent orphaned positions, then abort cleanly.
        console.warn(`  [PM LEG] Unexpected status=${pmMeta.status ?? "n/a"} — cancelling PM order and aborting.`);
        if (pmMeta.orderId) {
          try { await cancelPmOrder(String(pmMeta.orderId), DRY_RUN); }
          catch (e) { console.error(`  [PM LEG] Cancel failed: ${(e as Error).message}`); }
        }
        printTimings();
        saveExecMetric("abort-pre-first", "pm-unexpected-status");
        return { sessionSkip: false, unhedged: null };
      }
    }

    const pmFilled = shares; // FOK: fully filled or rejected above
    pmOrderIdForVerify = pmMeta.orderId ? String(pmMeta.orderId) : "";
    console.log(`  [PM LEG] OK orderId=${pmMeta.orderId ?? "n/a"} filled=${pmFilled}`);

    // Complete pending fill NOW — PM is confirmed on-chain, this is not a ghost.
    // Prevents the async chain watcher from creating a duplicate ghost trade
    // during the KAL GTC polling window (which can take 20+ seconds).
    if (_activePendingFillId) {
      completePendingFill(_activePendingFillId);
      console.log(`[PENDING] Completed pending fill ${_activePendingFillId} (PM confirmed)`);
      setActivePendingFillId(null);
    }

    // ── Helper: immediate PM hedge when KAL leg fails ─────────────────────────
    // PM tennis has 0% fees, so hedging on PM is strictly better than KAL.
    // Tries FOK buy of the opposite PM outcome token at breakeven. Returns
    // number of shares successfully hedged (0 if PM unavailable or no fill).
    const pmOppLeg = (dir === "G" || dir === "H" || dir === "I" || dir === "J" || dir === "K" || dir === "L")
      ? null  // 3-way soccer: no single opposite PM token completes the arb
      : ((dir === "A" || dir === "D") ? entry.pm1 : entry.pm2);
    const immediatePmHedge = async (unhedgedShares: number): Promise<number> => {
      if (!pmOppLeg || isPmServiceDown() || unhedgedShares < 5) return 0;
      const maxOppPrice = 1 - pmAsk; // breakeven: initial PM cost + opp token = $1
      const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
      try {
        const oppAsk = await fetchPmAsk(pmOppLeg.tokenId, clobBase);
        if (oppAsk === null || oppAsk > maxOppPrice || unhedgedShares * oppAsk < PM_MARKETABLE_MIN_VALUE) return 0;
        console.log(`  [IMMEDIATE PM HEDGE] Buying ${unhedgedShares}×${pmOppLeg.outcome} @${fmtPct(oppAsk)} (breakeven=${fmtPct(maxOppPrice)})`);
        const res = await placePmFOK(pmOppLeg.tokenId, oppAsk, unhedgedShares, pmOppLeg.tickSize, pmOppLeg.negRisk, DRY_RUN);
        const meta = extractPmMeta(res);
        if (meta.status === "matched") {
          console.log(`  [IMMEDIATE PM HEDGE] Filled ${unhedgedShares}×${pmOppLeg.outcome} @${fmtPct(oppAsk)} — hedge complete on PM.`);
          return unhedgedShares;
        }
        if (meta.status === "delayed" && meta.orderId) {
          const finalStatus = await waitForPmOrderFill(String(meta.orderId), undefined, pmOppLeg.tokenId);
          if (finalStatus === "matched") {
            console.log(`  [IMMEDIATE PM HEDGE] Filled (delayed) ${unhedgedShares}×${pmOppLeg.outcome} @${fmtPct(oppAsk)} — hedge complete.`);
            return unhedgedShares;
          }
        }
      } catch (e) {
        console.error(`  [IMMEDIATE PM HEDGE] Failed: ${(e as Error).message}`);
      }
      return 0;
    };

    // ── Kalshi GTC (second leg — PM already filled) ──────────────────────────
    // Place a GTC limit order at the ask price. If resting liquidity exists, it
    // fills instantly (same as IOC). If the book is empty, the order rests and
    // we poll for up to 6 seconds. On timeout we cancel and enter hedge mode
    // with a breakeven GTC.
    const kalGTCOrder = buildKalshiGTCOrder(kalLeg.ticker, "buy", kalSide, kalLimitCents, pmFilled);
    console.log(`  [KAL LEG] Placing GTC: ticker=${kalLeg.ticker} side=${kalSide} limit=${kalLimitCents}¢ qty=${pmFilled}`);
    let kalResult: unknown;
    let kalFailed = false;
    const _tKalOrd0 = performance.now();
    try {
      kalResult = await placeKalshiOrder(kalGTCOrder, DRY_RUN);
    } catch (kalErr) { kalResult = kalErr; kalFailed = true; }
    tKalOrder = performance.now() - _tKalOrd0;
    console.log(`  [KAL LEG] Response (${tKalOrder.toFixed(0)}ms): ${JSON.stringify(kalResult).slice(0, 300)}`);

    if (kalFailed) {
      console.error(`  [KAL LEG] GTC FAILED: ${(kalResult as Error).message}`);
      // Try immediate PM hedge (0% fees) before entering slow hedge loop
      const hedged = await immediatePmHedge(pmFilled);
      if (hedged >= pmFilled) {
        // Fully hedged on PM — record as complete trade if we have actual hedge price
        const oppAskNow = await fetchPmAsk(pmOppLeg!.tokenId, process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com").catch(() => null);
        if (oppAskNow !== null) {
          const hedgeCostPm = hedged * oppAskNow;
          const totalCostFull = pmFilled * pmAsk + hedgeCostPm;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: pmFilled, kalTicker: kalLeg.ticker, kalFillPrice: 0, kalCost: 0,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmFilled * pmAsk, pmFees: pmFeePaid(pmFilled, pmAsk, pmLeg), totalCost: totalCostFull,
            projectedEdge: edge, projectedProfit: pmFilled * edge,
            status: "resolved", resolutionMethod: "hedge-complete",
            hedgeCost: hedgeCostPm, realizedPnl: Math.round((pmFilled - totalCostFull) * 100) / 100,
            initialExchange: "pm",
          });
          console.log(`  [IMMEDIATE PM HEDGE] Trade fully resolved on PM. P&L=$${(pmFilled - totalCostFull).toFixed(2)}`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          saveExecMetric("hedge-entry", "kal-gtc-failed-pm-hedged");
          return { sessionSkip: true, unhedged: null };
        }
        // oppAsk fetch failed — can't record actual cost. Fall through to hedge loop for proper tracking.
        console.warn(`  [IMMEDIATE PM HEDGE] Hedged ${hedged} shares but oppAsk fetch failed. Entering hedge loop for cost tracking.`);
      }
      console.warn(`  [HEDGE MODE] Holding PM ${pmFilled}×${pmLeg.outcome} @${fmtPct(pmAsk)} — entering hedge loop.`);
      printTimings();
      metric.firstLegFilled = pmFilled;
      saveExecMetric("hedge-entry", "kal-gtc-failed");
      return { sessionSkip: true, unhedged: makeUnhedged("pm", pmFilled - hedged) };
    }

    const kalMeta = extractKalMeta(kalResult);
    kalFilled = DRY_RUN ? shares : kalMeta.filled;
    kalFeesTotal = kalMeta.fees;
    kalFillCostCents = kalMeta.fillCostCents; // actual fill cost from Kalshi (cents, excl fees)
    const kalOrderId = kalMeta.orderId ? String(kalMeta.orderId) : "";

    // Poll for up to 6 seconds if not immediately filled
    if (!DRY_RUN && kalFilled < pmFilled && kalOrderId) {
      const GTC_POLL_MS = 20000;
      let pollInterval = 100;
      const pollStart = Date.now();
      console.log(`  [KAL LEG] GTC not fully filled (${kalFilled}/${pmFilled}). Polling for ${GTC_POLL_MS / 1000}s...`);
      while (Date.now() - pollStart < GTC_POLL_MS && kalFilled < pmFilled) {
        await sleep(pollInterval);
        pollInterval = Math.min(500, Math.ceil(pollInterval * 1.5));
        try {
          const verify = await getKalshiOrder(kalOrderId);
          const verifiedFilled = Number(verify.fill_count_fp ?? verify.fill_count ?? verify.filled_count ?? 0);
          const verifiedStatus = String(verify.status ?? "");
          if (verifiedFilled > kalFilled) {
            kalFilled = verifiedFilled;
            console.log(`  [KAL LEG] GTC poll: filled=${kalFilled}/${pmFilled} status=${verifiedStatus}`);
          }
          // Update fees and fill cost from latest order state
          const vTaker = Number(verify.taker_fees ?? 0);
          const vMaker = Number(verify.maker_fees ?? 0);
          if (vTaker + vMaker > 0) kalFeesTotal = (vTaker + vMaker) / 100;
          const vTakerCost = Number(verify.taker_fill_cost ?? 0);
          const vMakerCost = Number(verify.maker_fill_cost ?? 0);
          if (vTakerCost + vMakerCost > 0) kalFillCostCents = vTakerCost + vMakerCost;
          if (verifiedStatus === "executed" || verifiedStatus === "canceled") break;
        } catch { /* continue polling */ }
      }
      tKalVerify = Date.now() - pollStart;
    }

    if (!DRY_RUN && kalFilled >= pmFilled) {
      console.log(`  [KAL LEG] GTC fully filled: ${kalFilled} contracts`);
    } else if (!DRY_RUN && kalFilled > 0 && kalFilled < pmFilled) {
      // Partial fill — cancel remaining GTC, then re-check actual fill count.
      // The GTC may have filled MORE shares between the last poll and now (race condition).
      console.warn(`  [KAL LEG] GTC partial: ${kalFilled}/${pmFilled}. Cancelling remainder.`);
      try { await cancelKalshiOrder(kalOrderId, DRY_RUN); } catch { /* best effort */ }

      // ── Post-cancel reconciliation: re-check actual fills ──────────────────
      // Race condition: GTC can fill between last poll and cancel request.
      // Wait briefly, then get the definitive fill count from Kalshi.
      await sleep(500);
      try {
        const postCancelOrder = await getKalshiOrder(kalOrderId);
        const postCancelFilled = Number(
          postCancelOrder.fill_count ?? postCancelOrder.filled_count ??
          (postCancelOrder.fill_count_fp != null ? Math.round(Number(postCancelOrder.fill_count_fp)) : 0)
        );
        if (postCancelFilled > kalFilled) {
          console.log(`  [KAL LEG] Post-cancel check: actual fills=${postCancelFilled} (was ${kalFilled}). GTC filled more before cancel.`);
          // Update fees and fill cost from final order state
          const pcTaker = Number(postCancelOrder.taker_fees ?? postCancelOrder.taker_fees_dollars ?? 0);
          const pcMaker = Number(postCancelOrder.maker_fees ?? postCancelOrder.maker_fees_dollars ?? 0);
          const pcTakerCost = Number(postCancelOrder.taker_fill_cost ?? postCancelOrder.taker_fill_cost_dollars ?? 0);
          const pcMakerCost = Number(postCancelOrder.maker_fill_cost ?? postCancelOrder.maker_fill_cost_dollars ?? 0);
          // Detect dollar-format (has decimal string like "1.3000") vs cent-format
          const isDollarFmt = String(postCancelOrder.taker_fees_dollars ?? "").includes(".");
          const feeDiv = isDollarFmt ? 1 : 100;
          if (pcTaker + pcMaker > 0) kalFeesTotal = (pcTaker + pcMaker) / feeDiv;
          if (pcTakerCost + pcMakerCost > 0) kalFillCostCents = isDollarFmt
            ? (pcTakerCost + pcMakerCost) * 100
            : pcTakerCost + pcMakerCost;
          kalFilled = postCancelFilled;
        }
      } catch (e) {
        console.warn(`  [KAL LEG] Post-cancel order check failed: ${(e as Error).message} — using polled fill count.`);
      }

      if (kalFilled >= pmFilled) {
        // GTC fully filled after all — treat as complete
        console.log(`  [KAL LEG] GTC fully filled after post-cancel check: ${kalFilled} contracts`);
        // Fall through to normal "both legs filled" handling below
      } else {
        const unhedgedCount = pmFilled - kalFilled;
        const hedged = await immediatePmHedge(unhedgedCount);
        const remaining = unhedgedCount - hedged;

        // ── Compute actual KAL cost for the partial fill ──────────────────────
        const kalRawCostPartial = kalFillCostCents > 0 ? kalFillCostCents / 100 : kalFilled * kalAsk;
        const kalCostPartial = Math.round(kalRawCostPartial * 100) / 100;
        const actualKalPricePartial = kalFillCostCents > 0 && kalFilled > 0
          ? Math.round((kalFillCostCents / 100 / kalFilled) * 10000) / 10000
          : kalAsk;

        if (remaining <= 0) {
          // All unhedged shares covered by PM opposite — log complete resolved trade
          const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
          const oppAskNow = pmOppLeg ? await fetchPmAsk(pmOppLeg.tokenId, clobBase).catch(() => null) : null;
          const hedgeCostPm = Math.round(unhedgedCount * (oppAskNow ?? (1 - pmAsk)) * 100) / 100;
          const pmCostFull = Math.round(pmFilled * pmAsk * 100) / 100;
          const totalCostResolved = Math.round((kalCostPartial + kalFeesTotal + pmCostFull + hedgeCostPm) * 100) / 100;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: pmFilled,
            kalTicker: kalLeg.ticker, kalFillPrice: actualKalPricePartial,
            kalCost: kalCostPartial, kalFees: kalFeesTotal,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmCostFull, pmFees: pmFeePaid(pmFilled, pmAsk, pmLeg),
            totalCost: totalCostResolved,
            projectedEdge: edge, projectedProfit: pmFilled * edge,
            status: "resolved", resolutionMethod: "hedge-complete",
            hedgeCost: hedgeCostPm,
            realizedPnl: Math.round((pmFilled - totalCostResolved) * 100) / 100,
            initialExchange: "pm",
          });
          console.log(`  [IMMEDIATE PM HEDGE] All ${unhedgedCount} unhedged shares filled on PM. Trade logged with KAL partial=${kalFilled} cost=$${kalCostPartial.toFixed(2)}`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          metric.secondLegFilled = kalFilled;
          saveExecMetric("hedge-entry", "kal-gtc-partial-pm-hedged");
          return { sessionSkip: true, unhedged: null };
        } else {
          // Some shares still need hedge loop.
          // Log a "filled" trade for the kalFilled matched shares (PM+KAL) so costs aren't lost.
          if (kalFilled > 0) {
            const pmCostMatched = Math.round(kalFilled * pmAsk * 100) / 100;
            logArbTrade({
              id: `arb-${Date.now()}-partial`, ts: new Date().toISOString(),
              match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
              dir, shares: kalFilled,
              kalTicker: kalLeg.ticker, kalFillPrice: actualKalPricePartial,
              kalCost: kalCostPartial, kalFees: kalFeesTotal,
              pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
              pmFillPrice: pmAsk, pmCost: pmCostMatched, pmFees: pmFeePaid(kalFilled, pmAsk, pmLeg),
              totalCost: Math.round((kalCostPartial + kalFeesTotal + pmCostMatched) * 100) / 100,
              projectedEdge: edge, projectedProfit: kalFilled * edge,
              status: "filled",
              realizedPnl: Math.round((kalFilled - kalCostPartial - kalFeesTotal - pmCostMatched) * 100) / 100,
              initialExchange: "pm",
            });
            console.log(`  [PARTIAL FILL] Logged ${kalFilled} matched shares (KAL+PM). ${remaining} still unhedged.`);
          }
          console.warn(`  [HEDGE MODE] ${remaining} PM shares still unhedged — entering hedge loop.`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          metric.secondLegFilled = kalFilled;
          saveExecMetric("hedge-entry", "kal-gtc-partial");
          return { sessionSkip: true, unhedged: makeUnhedged("pm", remaining) };
        }
      }
    } else if (!DRY_RUN && kalFilled === 0) {
      // Not filled after 5s — cancel the arb-price GTC, try immediate PM hedge
      console.warn(`  [KAL LEG] GTC unfilled after ${tKalVerify}ms. Cancelling arb-price order.`);
      try { await cancelKalshiOrder(kalOrderId, DRY_RUN); } catch { /* best effort */ }

      // ── Post-cancel reconciliation: check if KAL filled before cancel arrived ──
      // Race condition: order can fill between last poll and cancel request.
      // Wait 500ms to let Kalshi settle the cancel/fill race, then re-check.
      await sleep(500);
      try {
        const postCancelOrder = await getKalshiOrder(kalOrderId);
        const postCancelFilled = Number(postCancelOrder.fill_count ?? postCancelOrder.filled_count ?? postCancelOrder.fill_count_fp ?? 0);
        if (postCancelFilled > 0) {
          const matchedShares = Math.min(postCancelFilled, pmFilled);
          const unhedgedPm = pmFilled - matchedShares;
          console.log(`  [KAL LEG] Post-cancel check: ${postCancelFilled} contracts FILLED before cancel!${unhedgedPm > 0 ? ` ${unhedgedPm} PM shares unhedged.` : " Arb complete."}`);
          const pcTaker = Number(postCancelOrder.taker_fees ?? 0);
          const pcMaker = Number(postCancelOrder.maker_fees ?? 0);
          const pcFees = (pcTaker + pcMaker) / 100;
          const pcFillCost = (Number(postCancelOrder.taker_fill_cost ?? 0) + Number(postCancelOrder.maker_fill_cost ?? 0)) / 100;
          const pcAvgPrice = pcFillCost > 0 && postCancelFilled > 0
            ? Math.round((pcFillCost / postCancelFilled) * 100) / 100
            : kalAsk;
          const kalCostActual = Math.round(pcFillCost * 100) / 100;
          // PM cost must match the MATCHED shares, not total PM fills
          const pmCostMatched = Math.round(matchedShares * pmAsk * 100) / 100;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: matchedShares,
            kalTicker: kalLeg.ticker, kalFillPrice: pcAvgPrice,
            kalCost: kalCostActual, kalFees: pcFees,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmCostMatched, pmFees: pmFeePaid(matchedShares, pmAsk, pmLeg),
            totalCost: Math.round((kalCostActual + pcFees + pmCostMatched) * 100) / 100,
            projectedEdge: edge, projectedProfit: matchedShares * edge,
            status: unhedgedPm > 0 ? "filled" : "resolved",
            resolutionMethod: unhedgedPm > 0 ? undefined : "both-legs",
            resolvedTs: unhedgedPm > 0 ? undefined : new Date().toISOString(),
            initialExchange: "pm",
            realizedPnl: Math.round((matchedShares - kalCostActual - pcFees - pmCostMatched) * 100) / 100,
          });
          printTimings();
          metric.firstLegFilled = pmFilled;
          metric.secondLegFilled = postCancelFilled;
          if (unhedgedPm > 0) {
            // Remaining PM shares need hedging
            console.warn(`  [PARTIAL] KAL filled ${postCancelFilled}/${pmFilled}. ${unhedgedPm} PM shares entering hedge.`);
            saveExecMetric("hedge-entry", "kal-gtc-post-cancel-partial");
            return { sessionSkip: true, unhedged: makeUnhedged("pm", unhedgedPm) };
          }
          saveExecMetric("filled", "kal-gtc-post-cancel-fill");
          return { sessionSkip: true, unhedged: null };
        }
      } catch (e) {
        console.warn(`  [KAL LEG] Post-cancel order check failed: ${(e as Error).message} — proceeding with hedge.`);
      }

      const hedged = await immediatePmHedge(pmFilled);
      if (hedged >= pmFilled) {
        // ── CRITICAL: Final KAL re-check after PM hedge ──────────────────────
        // The KAL GTC may have filled DURING the PM hedge (cancel/fill race).
        // If KAL filled, we're double-hedged. Sell the PM hedge back to recover.
        let kalLateFilledCount = 0;
        try {
          await sleep(300); // let Kalshi settle
          const finalKalOrder = await getKalshiOrder(kalOrderId);
          kalLateFilledCount = Number(finalKalOrder.fill_count ?? finalKalOrder.filled_count ?? finalKalOrder.fill_count_fp ?? 0);
          if (kalLateFilledCount > 0) {
            console.warn(`  [RACE DETECTED] KAL GTC filled ${kalLateFilledCount} contracts AFTER PM hedge! Selling PM hedge back.`);
            // Sell the PM opposite token (hedge) to undo the unnecessary hedge
            const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
            try {
              const oppBid = await fetchPmBestBid(pmOppLeg!.tokenId, clobBase);
              if (oppBid !== null && oppBid > 0) {
                console.log(`  [RACE RECOVERY] Selling ${hedged}×${pmOppLeg!.outcome} @ ${fmtPct(oppBid)} to undo PM hedge.`);
                await placePmGTCAsk(pmOppLeg!.tokenId, oppBid, hedged, pmOppLeg!.tickSize, pmOppLeg!.negRisk, DRY_RUN);
                console.log(`  [RACE RECOVERY] PM hedge sell order placed. KAL arb is the real second leg.`);
              } else {
                console.warn(`  [RACE RECOVERY] No PM bid available — PM hedge stuck. KAL still filled though.`);
              }
            } catch (sellErr) {
              console.error(`  [RACE RECOVERY] PM sell failed: ${(sellErr as Error).message}`);
            }
            // Log the trade as completed via KAL (not hedge-complete)
            const lateKalFees = Number(finalKalOrder.taker_fees ?? 0) / 100 + Number(finalKalOrder.maker_fees ?? 0) / 100;
            const lateKalFillCost = (Number(finalKalOrder.taker_fill_cost ?? 0) + Number(finalKalOrder.maker_fill_cost ?? 0)) / 100;
            const lateKalAvg = lateKalFillCost > 0 && kalLateFilledCount > 0
              ? Math.round((lateKalFillCost / kalLateFilledCount) * 100) / 100 : kalAsk;
            const kalCostLate = Math.round(lateKalFillCost * 100) / 100;
            const pmCostLate = Math.round(pmFilled * pmAsk * 100) / 100;
            logArbTrade({
              id: `arb-${Date.now()}`, ts: new Date().toISOString(),
              match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
              dir, shares: Math.min(kalLateFilledCount, pmFilled),
              kalTicker: kalLeg.ticker, kalFillPrice: lateKalAvg,
              kalCost: kalCostLate, kalFees: lateKalFees,
              pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
              pmFillPrice: pmAsk, pmCost: pmCostLate, pmFees: pmFeePaid(pmFilled, pmAsk, pmLeg),
              totalCost: Math.round((kalCostLate + lateKalFees + pmCostLate) * 100) / 100,
              projectedEdge: edge, projectedProfit: pmFilled * edge,
              status: "filled", initialExchange: "pm",
              realizedPnl: Math.round((Math.min(kalLateFilledCount, pmFilled) - kalCostLate - lateKalFees - pmCostLate) * 100) / 100,
            });
            console.log(`  [RACE RECOVERY] Trade logged as KAL-filled (not hedged). P&L=$${(Math.min(kalLateFilledCount, pmFilled) - kalCostLate - lateKalFees - pmCostLate).toFixed(2)}`);
            printTimings();
            metric.firstLegFilled = pmFilled;
            metric.secondLegFilled = kalLateFilledCount;
            saveExecMetric("filled", "kal-gtc-late-fill-race-recovery");
            return { sessionSkip: true, unhedged: null };
          }
        } catch (e) {
          console.warn(`  [RACE CHECK] Final KAL order check failed: ${(e as Error).message} — proceeding with hedge-complete.`);
        }

        const oppAskNow = await fetchPmAsk(pmOppLeg!.tokenId, process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com").catch(() => null);
        if (oppAskNow !== null) {
          const hedgeCostPm = hedged * oppAskNow;
          const totalCostFull = pmFilled * pmAsk + hedgeCostPm;
          logArbTrade({
            id: `arb-${Date.now()}`, ts: new Date().toISOString(),
            match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
            dir, shares: pmFilled, kalTicker: kalLeg.ticker, kalFillPrice: 0, kalCost: 0,
            pmOutcome: pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: pmLeg.tokenId,
            pmFillPrice: pmAsk, pmCost: pmFilled * pmAsk, pmFees: pmFeePaid(pmFilled, pmAsk, pmLeg), totalCost: totalCostFull,
            projectedEdge: edge, projectedProfit: pmFilled * edge,
            status: "resolved", resolutionMethod: "hedge-complete",
            hedgeCost: hedgeCostPm, realizedPnl: Math.round((pmFilled - totalCostFull) * 100) / 100,
            initialExchange: "pm",
          });
          console.log(`  [IMMEDIATE PM HEDGE] Trade fully resolved on PM. P&L=$${(pmFilled - totalCostFull).toFixed(2)}`);
          printTimings();
          metric.firstLegFilled = pmFilled;
          saveExecMetric("hedge-entry", "kal-gtc-timeout-pm-hedged");
          return { sessionSkip: true, unhedged: null };
        }
        // oppAsk fetch failed — fall through to hedge loop for proper cost tracking
        console.warn(`  [IMMEDIATE PM HEDGE] Hedged ${hedged} shares but oppAsk fetch failed. Entering hedge loop for cost tracking.`);
      }
      const remaining = pmFilled - hedged;
      console.warn(`  [HEDGE MODE] ${remaining} PM shares unhedged — entering hedge loop.`);
      printTimings();
      metric.firstLegFilled = pmFilled;
      saveExecMetric("hedge-entry", "kal-gtc-timeout");
      return { sessionSkip: true, unhedged: makeUnhedged("pm", remaining) };
    }

  } else {
    // ── Kalshi IOC first (Kalshi is the favourite / more expensive) ──────────

    // Fetch live orderbook depth: WS first → cache → REST fallback
    let kalBook: { yes: [number, number][]; no: [number, number][] } | null = getWsKalBook(kalLeg.ticker);
    if (kalBook) {
      console.log(`  [KAL LEG] Using WS orderbook (live)`);
    } else {
      const cachedBookKal = kalBookCache.get(kalLeg.ticker);
      kalBook = cachedBookKal && Date.now() - cachedBookKal.ts < BOOK_CACHE_TTL ? cachedBookKal.book : null;
      if (kalBook) {
        console.log(`  [KAL LEG] Using cached orderbook (${Date.now() - cachedBookKal!.ts}ms old)`);
      } else {
        const _tBook0 = performance.now();
        try { kalBook = await fetchKalshiOrderbook(kalLeg.ticker); } catch { /* proceed without */ }
        tKalBook = performance.now() - _tBook0;
      }
    }

    let kalSweepResult: { totalQty: number; worstPrice: number; avgPrice: number } | null = null;
    if (kalBook && !DRY_RUN) {
      // Derive ask levels for the side we're buying
      const askLevels = kalSide === "yes"
        ? deriveYesAsks(kalBook.no)
        : deriveNoAsks(kalBook.yes);
      if (askLevels.length === 0) {
        console.log(`  [KAL LEG] Orderbook empty. Raw: yesBids=${kalBook.yes.length} levels, noBids=${kalBook.no.length} levels.`);
        if (kalBook.yes.length > 0) console.log(`  [KAL LEG]   YES bids (top 3): ${kalBook.yes.slice(0, 3).map(l => `${l[0]}¢×${l[1]}`).join(", ")}`);
        if (kalBook.no.length > 0) console.log(`  [KAL LEG]   NO bids (top 3): ${kalBook.no.slice(0, 3).map(l => `${l[0]}¢×${l[1]}`).join(", ")}`);
        // DEPTH FIX: orderbook endpoint sometimes returns empty while market listing shows offers.
        // Fall back to listing data (same fix as depth-check phase).
        const listingPrice = kalSide === "yes" ? kalLeg.yesAsk : kalLeg.noAsk;
        const listingSize = (kalSide === "yes" ? kalLeg.yesAskSize : kalLeg.noAskSize) ?? 0;
        const listingCents = Math.round(listingPrice * 100);
        if (listingSize >= shares && listingCents <= kalLimitCents) {
          console.log(`  [KAL LEG] [DEPTH FIX] Using listing data: ${listingSize} contracts @ ${listingCents}¢`);
          askLevels.push([listingCents, listingSize]);
        } else {
          console.log(`  [KAL LEG] Insufficient depth: 0/${shares} contracts (listing: ${listingSize}@${listingCents}¢ limit=${kalLimitCents}¢). Skipping.`);
          saveExecMetric("abort-pre-first", "kal-depth-empty");
          return { sessionSkip: false, unhedged: null, abortReason: "soft" };
        }
      }
      console.log(`  [KAL LEG] Derived ${kalSide.toUpperCase()} asks (top 5): ${askLevels.slice(0, 5).map(l => `${l[0]}¢×${l[1]}`).join(", ")}  limit=${kalLimitCents}¢`);
      const sweep = sweepKalshiDepth(askLevels, shares, kalLimitCents);
      kalSweepResult = sweep;
      if (!sweep || sweep.totalQty === 0) {
        const allAvail = askLevels.reduce((s, l) => s + l[1], 0);
        console.log(`  [KAL LEG] No depth at ≤${kalLimitCents}¢. Total book: ${allAvail} contracts up to ${askLevels[askLevels.length - 1][0]}¢. Skipping.`);
        saveExecMetric("abort-pre-first", "kal-no-depth-at-limit");
        return { sessionSkip: false, unhedged: null, abortReason: "soft" };
      }
      if (sweep.totalQty < shares) {
        console.log(`  [KAL LEG] Partial depth: ${sweep.totalQty}/${shares} at ≤${kalLimitCents}¢. Will attempt partial fill.`);
      }
      // Verify edge remains profitable at average fill price
      const avgEdge = 1 - (sweep.avgPrice / 100) - pmAsk - estimateFees(sweep.avgPrice / 100, pmAsk);
      if (avgEdge < MIN_EDGE) {
        console.log(`  [KAL LEG] Edge at avg fill ${fmtPct(sweep.avgPrice / 100)} drops to ${fmtPct(avgEdge)}. Skipping.`);
        saveExecMetric("abort-pre-first", "kal-edge-too-low");
        return { sessionSkip: false, unhedged: null, abortReason: "soft" };
      }
      console.log(`  [KAL LEG] Depth OK: ${sweep.totalQty} contracts across ${askLevels.filter(l => l[0] <= kalLimitCents).length} levels. Worst=${sweep.worstPrice}¢ Avg=${sweep.avgPrice.toFixed(1)}¢`);
    }

    // ── Kalshi first leg + PM pre-sign (parallel) ──────────────────────────
    // Two modes:
    //   KAL_MAKER_MODE=false (default): IOC at ask → taker fee (7%)
    //   KAL_MAKER_MODE=true:  GTC bid at ask-1¢ → maker fee (1.75%), fallback to IOC after timeout
    // Hoisted here so PARALLEL_MODE can set pmFilled/pmFinalOrderId before sequential PM block
    let pmFilled = false;
    let pmFinalOrderId = "";
    let kalIOCCount = (kalSweepResult && kalSweepResult.totalQty < shares) ? kalSweepResult.totalQty : shares;

    // Enforce Kalshi minimum = PM minimum so partial fills can never undersize PM orders
    if (kalIOCCount < effectivePmMin) {
      console.warn(`  [SKIP] Kalshi depth (${kalIOCCount}) < PM minimum (${effectivePmMin}). Skipping to avoid oversized PM leg.`);
      saveExecMetric("abort-pre-first", "kal-depth-below-pm-min");
      return { sessionSkip: false, unhedged: null, abortReason: "soft" };
    }

    // Pre-sign PM order at expected price+shares while Kalshi order is in flight
    let pmPreSigned: unknown = null;
    let pmPreSignShares = shares;
    const _tKalOrd0 = performance.now();
    let kalResult: unknown;
    let kalFailed = false;

    // Kalshi ask in cents for this side (best ask from depth check)
    const kalAskCents = kalSweepResult ? kalSweepResult.worstPrice : kalLimitCents;
    const kalMakerBidCents = Math.max(1, kalAskCents - 1);

    if (KAL_MAKER_MODE && !DRY_RUN && kalMakerBidCents < kalLimitCents) {
      // ── MAKER MODE: GTC bid at ask-1¢, poll for fill, fallback to IOC ──
      console.log(`  [KAL LEG] MAKER MODE: GTC bid at ${kalMakerBidCents}¢ (ask=${kalAskCents}¢) ticker=${kalLeg.ticker} side=${kalSide} qty=${kalIOCCount}`);

      // Place GTC + pre-sign PM in parallel
      const makerOrder = buildKalshiGTCOrder(kalLeg.ticker, "buy", kalSide, kalMakerBidCents, kalIOCCount);
      const [kalRes, pmSigned] = await Promise.allSettled([
        placeKalshiOrder(makerOrder, false),
        preSignPmOrder(pmLeg.tokenId, pmAsk, shares, pmLeg.tickSize, pmLeg.negRisk),
      ]);
      if (pmSigned.status === "fulfilled") {
        pmPreSigned = pmSigned.value;
        console.log(`  [PM PRE-SIGN] Order pre-signed at ${fmtPct(pmAsk)} × ${shares} shares`);
      } else {
        console.warn(`  [PM PRE-SIGN] Failed: ${(pmSigned.reason as Error).message} — will use normal flow`);
      }

      if (kalRes.status === "rejected") {
        console.error(`  [KAL LEG] MAKER GTC FAILED: ${(kalRes.reason as Error).message}. Falling back to IOC.`);
        // Fall through to IOC below
      } else {
        kalResult = kalRes.value;
        let makerMeta = extractKalMeta(kalResult);
        const makerOrderId = makerMeta.orderId ? String(makerMeta.orderId) : "";

        // Check if GTC filled immediately (crossed resting ask)
        if (makerMeta.filled >= kalIOCCount) {
          console.log(`  [KAL LEG] MAKER: Instant fill! ${makerMeta.filled}/${kalIOCCount} @ ${kalMakerBidCents}¢ (fees=$${makerMeta.fees.toFixed(2)})`);
          kalFilledViaMaker = true;
        } else {
          // Poll for fill
          console.log(`  [KAL LEG] MAKER: ${makerMeta.filled}/${kalIOCCount} instant. Polling up to ${KAL_MAKER_WAIT_MS}ms...`);
          const pollDeadline = Date.now() + KAL_MAKER_WAIT_MS;
          while (Date.now() < pollDeadline && makerMeta.filled < kalIOCCount) {
            await sleep(KAL_MAKER_POLL_MS);
            try {
              const orderStatus = await getKalshiOrder(makerOrderId);
              makerMeta = extractKalMeta(orderStatus);
              kalResult = orderStatus;
            } catch { /* poll error, continue */ }
          }

          if (makerMeta.filled > 0) {
            console.log(`  [KAL LEG] MAKER: Got ${makerMeta.filled}/${kalIOCCount} fills after ${(Date.now() - (pollDeadline - KAL_MAKER_WAIT_MS)).toFixed(0)}ms`);
            kalFilledViaMaker = true;
            // Cancel remaining if partial
            if (makerMeta.filled < kalIOCCount && makerOrderId) {
              try {
                await cancelKalshiOrder(makerOrderId, false);
                console.log(`  [KAL LEG] MAKER: Cancelled remaining ${kalIOCCount - makerMeta.filled} resting contracts`);
              } catch { /* already filled or cancelled */ }
            }
          } else {
            // No fills — cancel GTC and fall back to IOC
            console.log(`  [KAL LEG] MAKER: 0 fills after ${KAL_MAKER_WAIT_MS}ms. Cancelling GTC, falling back to IOC.`);
            if (makerOrderId) {
              try { await cancelKalshiOrder(makerOrderId, false); } catch { /* ok */ }
            }
            kalResult = undefined; // reset — will be set by IOC below
          }
        }

        if (kalFilledViaMaker) {
          // Maker fill succeeded — use the results
          kalFailed = false;
        }
      }
    }

    // ── IOC path (default, or maker-mode fallback) ────────────────────────
    if (!kalFilledViaMaker) {
      const kalIOCOrder = buildKalshiIOCOrder(kalLeg.ticker, kalLimitCents / 100, kalIOCCount, kalSide);
      console.log(`  [KAL LEG] Placing IOC: ticker=${kalLeg.ticker} side=${kalSide} limit=${kalLimitCents}¢ qty=${kalIOCCount}`);

      if (!DRY_RUN) {
        // ── PARALLEL_MODE: fire KAL IOC + PM FAK simultaneously ─────────────
        // Safe because Kalshi IOC guarantees fill at limit price or better.
        // Breakeven is calculated from KAL LIMIT (worst-case cost).
        if (PARALLEL_MODE) {
          // Calculate PM price from KAL LIMIT (worst case: fills at limit)
          const kalLimitPerShare = kalLimitCents / 100;
          const kalFeeReserve = KALSHI_FEE_RATE * kalLimitPerShare * (1 - kalLimitPerShare);
          const worstKalCostPerShare = kalLimitPerShare + kalFeeReserve;
          const parallelRawBudget = 1 - worstKalCostPerShare;
          const parallelPmFee = pmFeeRateFor(pmLeg) * parallelRawBudget * (1 - parallelRawBudget);
          const parallelPmBudget = parallelRawBudget - parallelPmFee;
          const parallelPmPrice = Math.floor(parallelPmBudget / (pmLeg.tickSize || 0.01)) * (pmLeg.tickSize || 0.01);

          if (parallelPmPrice > 0 && parallelPmPrice >= pmAsk) {
            console.log(`  [PARALLEL] Firing KAL IOC + PM FAK in parallel. PM limit=${fmtPct(parallelPmPrice)} (KAL worst-case=${fmtPct(worstKalCostPerShare)})`);
            const _tParallel = performance.now();
            const [kalRes, pmRes] = await Promise.allSettled([
              placeKalshiOrder(kalIOCOrder, false),
              placePmFOK(pmLeg.tokenId, parallelPmPrice, shares, pmLeg.tickSize, pmLeg.negRisk, false),
            ]);
            const parallelMs = performance.now() - _tParallel;
            console.log(`  [PARALLEL] Both legs returned in ${parallelMs.toFixed(0)}ms`);

            if (kalRes.status === "fulfilled") { kalResult = kalRes.value; } else { kalResult = kalRes.reason; kalFailed = true; }

            // Check PM result: did it fill?
            if (pmRes.status === "fulfilled") {
              const earlyFokMeta = extractPmMeta(pmRes.value);
              if (earlyFokMeta.status === "matched" || earlyFokMeta.status === "delayed") {
                pmFilled = true;
                pmFinalOrderId = earlyFokMeta.orderId ? String(earlyFokMeta.orderId) : "";
                // Store for later status check
                (globalThis as Record<string, unknown>)._parallelPmResult = pmRes.value;
                console.log(`  [PARALLEL] PM FAK status=${earlyFokMeta.status}`);
              } else {
                console.log(`  [PARALLEL] PM FAK did not match (status=${earlyFokMeta.status}) — will retry sequentially after KAL fill check`);
              }
            } else {
              console.warn(`  [PARALLEL] PM FAK failed: ${(pmRes.reason as Error).message}`);
            }
          } else {
            // Breakeven too low — fall back to sequential (safer)
            console.log(`  [PARALLEL] PM breakeven ${fmtPct(parallelPmPrice)} < ask ${fmtPct(pmAsk)} — falling back to sequential`);
            try { kalResult = await placeKalshiOrder(kalIOCOrder, false); }
            catch (kalErr) { kalResult = kalErr; kalFailed = true; }
          }
        } else if (!pmPreSigned) {
          // Pre-sign PM in parallel with IOC (if not already done in maker path)
          const [kalRes, pmSigned] = await Promise.allSettled([
            placeKalshiOrder(kalIOCOrder, false),
            preSignPmOrder(pmLeg.tokenId, pmAsk, shares, pmLeg.tickSize, pmLeg.negRisk),
          ]);
          if (kalRes.status === "fulfilled") { kalResult = kalRes.value; }
          else { kalResult = kalRes.reason; kalFailed = true; }
          if (pmSigned.status === "fulfilled") {
            pmPreSigned = pmSigned.value;
            console.log(`  [PM PRE-SIGN] Order pre-signed at ${fmtPct(pmAsk)} × ${shares} shares`);
          } else {
            console.warn(`  [PM PRE-SIGN] Failed: ${(pmSigned.reason as Error).message} — will use normal flow`);
          }
        } else {
          // PM already pre-signed during maker attempt — just place IOC
          try {
            kalResult = await placeKalshiOrder(kalIOCOrder, false);
          } catch (kalErr) { kalResult = kalErr; kalFailed = true; }
        }
      } else {
        try {
          kalResult = await placeKalshiOrder(kalIOCOrder, true);
        } catch (kalErr) { kalResult = kalErr; kalFailed = true; }
      }
    }

    tKalOrder = performance.now() - _tKalOrd0;
    console.log(`  [KAL LEG] Response (${tKalOrder.toFixed(0)}ms)${kalFilledViaMaker ? " [MAKER]" : " [TAKER]"}: ${JSON.stringify(kalResult).slice(0, 300)}`);

    if (kalFailed) {
      console.error(`  [KAL LEG] Order FAILED (pre-PM): ${(kalResult as Error).message}`);
      // In PARALLEL_MODE, PM may have ALREADY fired and filled before KAL failed.
      // If so, we have naked PM exposure that must enter hedge mode — not be abandoned.
      if (pmFilled) {
        console.error(`  [PARALLEL] KAL failed but PM ALREADY filled — entering hedge mode with PM-held position to close exposure`);
        printTimings();
        metric.firstLegFilled = shares;
        saveExecMetric("hedge-entry", "parallel-kal-failed-pm-held");
        return { sessionSkip: true, unhedged: makeUnhedged("pm", shares) };
      }
      console.log("  [ABORT] PM never fired. No exposure taken.");
      printTimings();
      saveExecMetric("abort-pre-first", "kal-order-failed");
      return { sessionSkip: false, unhedged: null };
    }

    const kalMeta = extractKalMeta(kalResult);
    kalFilled = DRY_RUN ? shares : kalMeta.filled;
    kalFeesTotal = kalMeta.fees;
    kalFillCostCents = kalMeta.fillCostCents;
    const kalOrderId = kalMeta.orderId ? String(kalMeta.orderId) : "";

    if (!DRY_RUN && kalFilled === 0) {
      // Same PARALLEL_MODE concern: PM may have filled while KAL got 0 fills.
      if (pmFilled) {
        console.error(`  [PARALLEL] KAL 0-fills but PM ALREADY filled — entering hedge mode with PM-held position`);
        printTimings();
        metric.firstLegFilled = shares;
        saveExecMetric("hedge-entry", "parallel-kal-zero-fills-pm-held");
        return { sessionSkip: true, unhedged: makeUnhedged("pm", shares) };
      }
      console.log(`  [KAL LEG] 0 fills — book was empty or pulled. No exposure.`);
      printTimings();
      saveExecMetric("abort-pre-first", "kal-ioc-no-fill");
      return { sessionSkip: false, unhedged: null };
    }

    if (!DRY_RUN && kalFilled < kalIOCCount) {
      console.log(`  [KAL LEG] Partial: ${kalFilled}/${kalIOCCount}. Proceeding with filled qty.`);
    }

    if (kalFilledViaMaker) {
      console.log(`  [KAL LEG] ★ MAKER FILL: ${kalFilled} contracts, fees=$${kalFeesTotal.toFixed(2)} (taker would be ~$${(KALSHI_FEE_RATE * kalFilled * (kalMakerBidCents/100) * (1 - kalMakerBidCents/100)).toFixed(2)})`);
      metric.kalMakerFill = true;
    }

    console.log(`  [KAL LEG] OK orderId=${kalOrderId || "n/a"} filled=${kalFilled}`);

    // Effective PM minimum: per-market minSize (typically 5 shares) + PM $1 FOK floor
    const pmMinByFOKkf = pmAsk > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pmAsk) : pmLeg.minSize;
    const effectivePmMinKF = Math.max(pmLeg.minSize, pmMinByFOKkf);
    // If Kalshi partial-filled below PM minimum, go straight to hedge — don't oversize PM
    if (!DRY_RUN && kalFilled < effectivePmMinKF) {
      console.warn(`  [KAL LEG] Partial fill ${kalFilled} < PM minimum ${effectivePmMinKF}. Hedging instead of oversizing PM.`);
      printTimings();
      metric.firstLegFilled = kalFilled;
      saveExecMetric("hedge-entry", "kal-partial-below-pm-min");
      return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
    }
    const pmShares = DRY_RUN ? shares : kalFilled;

    // Cap PM price at breakeven based on ACTUAL KAL fill cost (not scan-time estimate).
    // Without this, slippage or fees on KAL side can push total cost > $1/share → guaranteed loss.
    let pmPriceWasCapped = false;
    // SOURCE OF TRUTH for KAL fill cost: /portfolio/orders/{id} REST endpoint.
    //
    // PREVIOUS BUG (VAN/LAK 2026-04-15): using individual `kal-fill` WS events
    // as the cost source was unreliable for split fills. When Kalshi walked
    // the book across price levels, it emitted multiple kal-fill events per
    // order but `waitForKalFillData` only captured the FIRST one — undercounting
    // total cost by whatever the other fills added up to. That undercount made
    // the bot compute a too-loose breakeven, place a PM hedge at a too-high
    // price, and lock in a loss that only showed up after postResolutionFillAudit
    // ran later and corrected kalCost from the authoritative REST source.
    //
    // Fix: fetch the ORDER-level aggregate (taker_fill_cost_dollars + maker_fill_cost_dollars)
    // directly before computing breakeven. This is the same REST call the
    // post-cancel reconciliation already uses, just run earlier in the pipeline.
    // Kalshi's /portfolio/orders/{id} is consistent with /portfolio/fills.
    if (!DRY_RUN && kalFilled > 0 && kalOrderId) {
      try {
        const restOrder = await getKalshiOrder(kalOrderId);
        const takerCost = Number(restOrder.taker_fill_cost_dollars ?? 0);
        const makerCost = Number(restOrder.maker_fill_cost_dollars ?? 0);
        const takerFees = Number(restOrder.taker_fees_dollars ?? 0);
        const makerFees = Number(restOrder.maker_fees_dollars ?? 0);
        const totalFillDollars = takerCost + makerCost;
        const totalFeesDollars = takerFees + makerFees;
        if (totalFillDollars > 0) {
          kalFillCostCents = Math.round(totalFillDollars * 100);
          kalFeesTotal = totalFeesDollars;
          console.log(`  [KAL LEG] REST fills: cost=$${totalFillDollars.toFixed(2)} fees=$${totalFeesDollars.toFixed(2)} (authoritative, used for PM breakeven)`);
        } else {
          console.warn(`  [KAL LEG] REST returned zero fill cost — falling back to HTTP response value ${kalFillCostCents}c`);
        }
      } catch (e) {
        console.warn(`  [KAL LEG] REST fill-cost fetch failed: ${(e as Error).message} — falling back to HTTP response value ${kalFillCostCents}c`);
      }
    }
    // Fallback: if REST and HTTP both failed to provide fill cost, estimate from limit price.
    if (!DRY_RUN && kalFillCostCents === 0 && kalFilled > 0) {
      kalFillCostCents = kalFilled * kalLimitCents;
      console.warn(`  [KAL LEG] No fill cost from REST or HTTP — using limit price estimate: ${kalFillCostCents}c`);
    }
    if (!DRY_RUN && kalFillCostCents > 0 && kalFilled > 0) {
      const actualKalPerShare = (kalFillCostCents / 100 + kalFeesTotal) / kalFilled;
      const rawBudget = 1 - actualKalPerShare;
      const pmFeeAtBudget = pmFeeRateFor(pmLeg) * rawBudget * (1 - rawBudget);
      const pmBudget = rawBudget - pmFeeAtBudget;
      const pmTick = pmLeg.tickSize || 0.01;
      pmOrderPrice = Math.floor(pmBudget / pmTick) * pmTick;
      pmPriceWasCapped = true;
      console.log(
        `  [PM LEG] Breakeven PM price: rawBudget=${fmtPct(rawBudget)} pmFee=${fmtPct(pmFeeAtBudget)} → order=${fmtPct(pmOrderPrice)}` +
        ` (KAL actual=${fmtPct(actualKalPerShare)}/share incl fees)`
      );
      if (pmOrderPrice <= 0) {
        console.warn(`  [PM LEG] Breakeven price ≤0 — KAL cost too high. Entering hedge mode.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-breakeven-negative");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
    } else {
      pmOrderPrice = pmAsk;
    }

    // ── PM FOK execution: single aggressive FOK at the ask ──────────────────
    // Sends a Fill-or-Kill at pmOrderPrice. Subject to PM's ~3-second sports
    // delay but simpler and avoids the stale-GTC problem where liquidity
    // disappears during the 5-second poll window.
    const _tPm0 = performance.now();

    if (DRY_RUN) {
      const dryResult = await placePmOrder(pmLeg.tokenId, pmOrderPrice, pmShares, pmLeg.tickSize, pmLeg.negRisk, true);
      tPmOrder = performance.now() - _tPm0;
      pmFilled = true;
      pmOrderIdForVerify = "";
      console.log(`  [PM LEG] [DRY] ${JSON.stringify(dryResult).slice(0, 200)}`);
    } else if (pmFilled && PARALLEL_MODE) {
      // Parallel mode already fired and confirmed PM — skip sending another order
      console.log(`  [PM LEG] Already filled via parallel execution — skipping duplicate send.`);
    } else {
      console.log(`  [PM LEG] FOK at ${fmtPct(pmOrderPrice)} qty=${pmShares}`);
      let fokResult: unknown;
      let fokFailed = false;
      try {
        fokResult = await placePmFOK(pmLeg.tokenId, pmOrderPrice, pmShares, pmLeg.tickSize, pmLeg.negRisk, false);
      } catch (e) { fokResult = e; fokFailed = true; }

      if (fokFailed) {
        console.error(`  [PM LEG] FOK failed: ${(fokResult as Error).message} — entering hedge.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-fok-failed");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }

      const fokMeta = extractPmMeta(fokResult);
      if (isPm425(fokResult)) {
        markPmDown();
        console.error(`  [PM LEG] Service not ready (425). Entering hedge.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-425");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
      if (typeof fokMeta.status === "number") {
        console.error(`  [PM LEG] Rejected (HTTP ${fokMeta.status}). Entering hedge.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-rejected");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
      markPmUp();

      if (fokMeta.status === "matched") {
        console.log(`  [PM LEG] FOK filled at ${fmtPct(pmOrderPrice)}`);
        pmFilled = true;
        pmFinalOrderId = fokMeta.orderId ? String(fokMeta.orderId) : "";
      } else if (fokMeta.status === "delayed" && fokMeta.orderId) {
        // FOK matched but on-chain confirmation pending — poll for it
        console.log(`  [PM LEG] FOK delayed (on-chain pending), polling for confirmation...`);
        const _tPoll0 = performance.now();
        const finalStatus = await waitForPmOrderFill(String(fokMeta.orderId), undefined, pmLeg.tokenId, pmPreBalance);
        tPmPoll = performance.now() - _tPoll0;
        if (finalStatus === "matched") {
          console.log(`  [PM LEG] Confirmed filled after delay (${tPmPoll.toFixed(0)}ms).`);
          pmFilled = true;
          pmFinalOrderId = String(fokMeta.orderId);
        } else if (finalStatus === "cancelled") {
          console.log(`  [PM LEG] Order FAILED/cancelled (${tPmPoll.toFixed(0)}ms). Transaction dead — entering hedge.`);
          // No on-chain check needed — FAILED means executor confirmed no settlement
        } else {
          // Timeout: status unknown — check on-chain as last resort
          try {
            const bal = await getOnChainBalance(pmLeg.tokenId);
            const newShares = bal - pmPreBalance;
            if (newShares >= pmShares) {
              console.log(`  [PM LEG] On-chain confirms ${newShares} new shares. Proceeding.`);
              pmFilled = true;
              pmFinalOrderId = String(fokMeta.orderId);
            } else if (newShares > 0) {
              console.warn(`  [PM LEG] Partial on-chain ${newShares}/${pmShares}. Hedging remainder.`);
              metric.firstLegFilled = kalFilled;
              metric.secondLegFilled = newShares;
              saveExecMetric("hedge-entry", "pm-fok-partial");
              return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled - newShares) };
            }
          } catch { /* fall through to hedge */ }
        }
      }

      if (!pmFilled) {
        // FOK not filled — check on-chain one last time
        try {
          const bal = await getOnChainBalance(pmLeg.tokenId);
          if (bal >= pmPreBalance + pmShares) {
            console.log(`  [PM LEG] Final on-chain check: ${bal - pmPreBalance} new shares found. Proceeding.`);
            pmFilled = true;
            pmFinalOrderId = fokMeta.orderId ? String(fokMeta.orderId) : "";
          }
        } catch { /* fall through */ }
      }

      if (!pmFilled) {
        // Before entering hedge mode, check if PM wallet already holds enough shares
        // from a prior ghost fill (e.g., a previous attempt that appeared to fail but actually filled on-chain).
        try {
          const totalPmBal = await getOnChainBalance(pmLeg.tokenId);
          if (totalPmBal >= pmShares) {
            // Count PM shares already claimed by other active/resolved trades for this token
            const existingTrades = loadArbTrades();
            // Count PM shares claimed by trades that actually filled on PM:
            // - pmCost > 0: PM leg confirmed filled
            // - status === "hedging" AND initialExchange === "pm": PM was the initial leg (we hold PM shares)
            const claimedPmShares = existingTrades
              .filter(t => t.pmTokenId === pmLeg.tokenId && (t.pmCost > 0 || (t.status === "hedging" && t.initialExchange === "pm")))
              .reduce((s, t) => s + t.shares, 0);
            const unclaimedPm = totalPmBal - claimedPmShares;
            if (unclaimedPm >= pmShares) {
              console.log(
                `  [PM LEG] Ghost fill detected: PM wallet has ${totalPmBal} shares (${unclaimedPm} unclaimed) for ${pmLeg.outcome}.` +
                ` Arb already covered — proceeding as filled.`
              );
              pmFilled = true;
              pmFinalOrderId = fokMeta.orderId ? String(fokMeta.orderId) : "";
            }
          }
        } catch (e) { console.warn(`  [PM LEG] Ghost fill check failed: ${(e as Error).message}`); }
      }

      if (!pmFilled) {
        // Cancel any orphan orders as safety net
        try {
          const n = await cancelAllPmOrdersForToken(pmLeg.tokenId);
          if (n > 0) console.log(`  [PM LEG] Safety-net: cancelled ${n} orphan orders.`);
        } catch (e) { console.warn(`  [PM LEG] Safety-net cancel failed: ${(e as Error).message}`); }
        console.warn(`  [PM LEG] FOK not filled. Hedging all ${kalFilled} Kalshi contracts.`);
        printTimings();
        metric.firstLegFilled = kalFilled;
        saveExecMetric("hedge-entry", "pm-fok-not-filled");
        return { sessionSkip: true, unhedged: makeUnhedged("kal", kalFilled) };
      }
      tPmOrder = performance.now() - _tPm0;
    }

    pmOrderIdForVerify = pmFinalOrderId;
    console.log(`  [PM LEG] OK orderId=${pmFinalOrderId || "n/a"} filled=${pmShares}`);

    // Partial KAL fill: kalFilled < pmShares → hedge the gap
    const unhedgedPmGap = pmShares - kalFilled;
    if (!DRY_RUN && unhedgedPmGap > 0) {
      console.warn(`  [PARTIAL] KAL filled ${kalFilled}, PM bought ${pmShares}. ${unhedgedPmGap} PM shares unhedged — entering hedge.`);
      printTimings();
      const partialKalCost = Math.round((kalFilled * kalAsk + kalFeesTotal) * 100) / 100;
      const partialPmCost = Math.round(pmShares * pmAsk * 100) / 100;
      logArbTrade({
        id: `arb-${Date.now()}`,
        ts: new Date().toISOString(),
        match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
        dir,
        status: "hedging",
        shares: pmShares,
        kalTicker: kalLeg.ticker,
        kalFillPrice: kalAsk,
        kalCost: partialKalCost,
        kalFees: kalFeesTotal,
        pmOutcome: pmLeg.outcome,
        pmSlug: entry.pmSlug,
        pmTokenId: pmLeg.tokenId,
        pmFillPrice: pmAsk,
        pmCost: partialPmCost,
        pmFees: pmFeePaid(pmFilled ? pmShares : kalFilled, pmAsk, pmLeg),
        totalCost: Math.round((partialKalCost + partialPmCost) * 100) / 100,
        projectedEdge: edge,
        projectedProfit,
        initialExchange: "pm",
      });
      metric.firstLegFilled = kalFilled;
      metric.secondLegFilled = pmShares;
      saveExecMetric("hedge-entry", "kal-partial-pm-gap");
      return { sessionSkip: true, unhedged: makeUnhedged("pm", unhedgedPmGap) };
    }
  }

  // ── Post-trade verification: triple-check PM fill before declaring success ───
  // Check 1: on-chain balanceOf (authoritative)
  // Check 2: CLOB API order status (orderId query)
  // Check 3: data-api positions (portfolio)
  // Only enter hedge if ALL checks fail to find the shares.
  if (!DRY_RUN) {
    const _tPmV0 = performance.now();
    let pmVerified = false;

    // Check 1: On-chain balance (authoritative) — compare against pre-balance
    try {
      const onChainBal = await getOnChainBalanceWithFallback(pmLeg.tokenId);
      const newShares = onChainBal - pmPreBalance;
      if (newShares > 0) {
        console.log(`  [POST-FILL] ✓ On-chain verified: ${newShares} new shares (total=${onChainBal}, pre=${pmPreBalance}) PM ${pmLeg.outcome}`);
        pmVerified = true;
      } else if (onChainBal >= 0) {
        console.warn(`  [POST-FILL] On-chain: 0 new shares (total=${onChainBal}, pre=${pmPreBalance}) for ${pmLeg.outcome}. Trying other checks...`);
      } else {
        console.warn(`  [POST-FILL] On-chain check failed (RPC). Trying other checks...`);
      }
    } catch (e) {
      console.warn(`  [POST-FILL] On-chain error: ${(e as Error).message}. Trying other checks...`);
    }

    // Check 2: CLOB API order status (if we have an orderId)
    if (!pmVerified && pmOrderIdForVerify) {
      try {
        const orderCheck = await getPmOrderFills(pmOrderIdForVerify);
        if (orderCheck.status === "matched" || orderCheck.filledShares > 0) {
          console.log(`  [POST-FILL] ✓ CLOB API verified: status=${orderCheck.status} filled=${orderCheck.filledShares}`);
          pmVerified = true;
        } else {
          console.warn(`  [POST-FILL] CLOB API: status=${orderCheck.status} filled=${orderCheck.filledShares}`);
        }
      } catch (e) {
        console.warn(`  [POST-FILL] CLOB API error: ${(e as Error).message}`);
      }
    }

    // Check 3: Data-api positions (portfolio)
    if (!pmVerified) {
      try {
        const verifyPos = await fetchPmPositionsCached(0);
        const actualPm = sumPmHeld(verifyPos, pmLeg.tokenId);
        if (actualPm > 0) {
          console.log(`  [POST-FILL] ✓ Data-api verified: ${actualPm}× PM ${pmLeg.outcome}`);
          pmVerified = true;
        } else {
          console.warn(`  [POST-FILL] Data-api: 0 shares for ${pmLeg.outcome}`);
        }
      } catch (e) {
        console.warn(`  [POST-FILL] Data-api error: ${(e as Error).message}`);
      }
    }

    tPmVerify = performance.now() - _tPmV0;

    if (!pmVerified) {
      console.warn(`  [POST-FILL] ⚠ ALL 3 checks failed to confirm PM fill. Entering hedge for ${shares} Kalshi contracts.`);
      printTimings();
      metric.firstLegFilled = shares;
      saveExecMetric("hedge-entry", "post-verify-all-failed");
      return { sessionSkip: true, unhedged: makeUnhedged("kal", shares) };
    }
  }

  printTimings();
  console.log(`  [DONE] ${entry.kal1.surname} vs ${entry.kal2.surname}  dir=${dir}  edge=${fmtPct(edge, 2)}`);
  // Use actual Kalshi fill cost if available, otherwise fall back to snapshot
  const kalRawCost = kalFillCostCents > 0
    ? kalFillCostCents / 100
    : shares * kalAsk;
  const kalCostRaw = Math.round(kalRawCost * 100) / 100;
  const actualKalFillPrice = kalFillCostCents > 0 && kalFilled > 0
    ? Math.round((kalFillCostCents / 100 / kalFilled) * 10000) / 10000
    : kalAsk;
  // Use the ACTUAL order price (which may have been capped at breakeven), not the scan-time ask.
  const actualPmFillPrice = pmOrderPrice;
  const pmCostBothLegs = Math.round(shares * actualPmFillPrice * 100) / 100;
  const pmTakerFee = Math.round(pmFeeRateFor(pmLeg) * actualPmFillPrice * (1 - actualPmFillPrice) * shares * 100) / 100;
  const totalCostBothLegs = Math.round((kalCostRaw + kalFeesTotal + pmCostBothLegs + pmTakerFee) * 100) / 100;
  if (kalFillCostCents > 0) {
    console.log(`  [COST] KAL actual fill: ${kalFilled}×${(actualKalFillPrice * 100).toFixed(1)}¢ = $${kalRawCost.toFixed(2)} + $${kalFeesTotal.toFixed(2)} fee (snapshot was ${(kalAsk * 100).toFixed(0)}¢)`);
  }
  if (actualPmFillPrice !== pmAsk) {
    console.log(`  [COST] PM price capped: scan=${fmtPct(pmAsk)} → order=${fmtPct(actualPmFillPrice)}`);
  }
  logArbTrade({
    id: `arb-${Date.now()}`,
    ts: new Date().toISOString(),
    match: `${entry.kal1.surname} vs ${entry.kal2.surname}`,
    dir,
    status: "resolved",
    resolutionMethod: "both-legs",
    resolvedTs: new Date().toISOString(),
    shares,
    kalTicker: kalLeg.ticker,
    kalFillPrice: actualKalFillPrice,
    kalCost: kalCostRaw,
    kalFees: kalFeesTotal,
    pmOutcome: pmLeg.outcome,
    pmSlug: entry.pmSlug,
    pmTokenId: pmLeg.tokenId,
    pmFillPrice: actualPmFillPrice,
    pmCost: pmCostBothLegs,
    pmFees: pmTakerFee,
    totalCost: totalCostBothLegs,
    projectedEdge: edge,
    projectedProfit,
    realizedPnl: Math.round((shares - totalCostBothLegs) * 100) / 100,
    initialExchange: pmFirst ? "pm" : "kal",
    ...(kalFilledViaMaker ? { kalMakerFill: true } : {}),
  });
  // Both legs filled — skip this match for the rest of the session to prevent
  // re-arbing in the opposite direction (which would create contradictory positions).
  metric.firstLegFilled = shares;
  metric.secondLegFilled = shares;
  saveExecMetric("both-filled");
  return { sessionSkip: true, unhedged: null };
}

// ─── 3-Leg execution (Soccer dirs A-F) ────────────────────────────────────────
// A: KAL Home YES + KAL Draw YES + PM Away YES   (2 KAL + 1 PM)
// B: KAL Home YES + PM Draw YES  + KAL Away YES  (2 KAL + 1 PM)
// C: PM Home YES  + KAL Draw YES + KAL Away YES  (2 KAL + 1 PM)
// D: KAL Home YES + PM Draw YES  + PM Away YES   (1 KAL + 2 PM)
// E: PM Home YES  + KAL Draw YES + PM Away YES   (1 KAL + 2 PM)
// F: PM Home YES  + PM Draw YES  + KAL Away YES  (1 KAL + 2 PM)
//
// Strategy: place the minority-exchange side first (cheaper to unwind if it fails),
// then place the majority side. If 2 of 3 fill and the 3rd fails, enter hedge mode
// for the single missing leg (reuses existing hedge infrastructure).

export type Leg3 = {
  exchange: "kal" | "pm";
  kalLeg: KalshiLeg;  // the Kalshi market for this outcome (used for hedge recovery)
  pmLeg: PmLeg;       // the PM market for this outcome (used for hedge recovery)
  side: "yes";        // always YES for 3-leg
  price: number;      // expected fill price
};

export function map3LegDir(entry: WatchEntry, dir: ArbDir): Leg3[] | null {
  if (!entry.is3Way || !entry.kal3 || !entry.pm3) return null;
  // Map each dir to [leg1, leg2, leg3] where leg1 is the minority-exchange side
  switch (dir) {
    case "A": return [ // 2 KAL + 1 PM → PM first
      { exchange: "pm",  kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // PM Away
      { exchange: "kal", kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // KAL Home
      { exchange: "kal", kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // KAL Draw
    ];
    case "B": return [
      { exchange: "pm",  kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // PM Draw
      { exchange: "kal", kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // KAL Home
      { exchange: "kal", kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // KAL Away
    ];
    case "C": return [
      { exchange: "pm",  kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // PM Home
      { exchange: "kal", kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // KAL Draw
      { exchange: "kal", kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // KAL Away
    ];
    case "D": return [ // 1 KAL + 2 PM → KAL first
      { exchange: "kal", kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // KAL Home
      { exchange: "pm",  kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // PM Draw
      { exchange: "pm",  kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // PM Away
    ];
    case "E": return [
      { exchange: "kal", kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // KAL Draw
      { exchange: "pm",  kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // PM Home
      { exchange: "pm",  kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // PM Away
    ];
    case "F": return [
      { exchange: "kal", kalLeg: entry.kal2, pmLeg: entry.pm2, side: "yes", price: 0 }, // KAL Away
      { exchange: "pm",  kalLeg: entry.kal1, pmLeg: entry.pm1, side: "yes", price: 0 }, // PM Home
      { exchange: "pm",  kalLeg: entry.kal3, pmLeg: entry.pm3, side: "yes", price: 0 }, // PM Draw
    ];
    default: return null;
  }
}

export async function executeArb3Leg(
  entry: WatchEntry,
  dir: ArbDir,
  edge: number
): Promise<{ sessionSkip: boolean; unhedged: UnhedgedPosition | null; abortReason?: string }> {
  const execStart = performance.now();
  const legs = map3LegDir(entry, dir);
  if (!legs) return { sessionSkip: false, unhedged: null, abortReason: "soft" };

  // Compute per-leg prices from current WS/cached data
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  for (const leg of legs) {
    if (leg.exchange === "pm") {
      const ask = getWsPmBestAsk(leg.pmLeg.tokenId) ?? await fetchPmAsk(leg.pmLeg.tokenId, clobBase);
      leg.price = ask ?? 0;
    } else {
      leg.price = leg.kalLeg.yesAsk;
    }
  }

  const totalCostPerShare = legs.reduce((sum, l) => sum + l.price, 0);
  const realEdge = 1 - totalCostPerShare - legs.filter(l => l.exchange === "kal").reduce((f, l) => f + estimateFees(l.price, 0), 0);
  if (realEdge < MIN_EDGE) {
    console.log(`  [3LEG] Edge evaporated: ${fmtPct(realEdge)} < ${fmtPct(MIN_EDGE)}. Skipping.`);
    return { sessionSkip: false, unhedged: null, abortReason: "soft" };
  }

  // Sizing: budget-limited, capped at MAX_CONTRACTS, floored by PM min size
  const sharesByBudget = Math.max(1, Math.floor(TRADE_USD / totalCostPerShare));
  let shares = Math.min(sharesByBudget, MAX_CONTRACTS);
  const pmLegs = legs.filter(l => l.exchange === "pm");
  for (const pl of pmLegs) {
    const pmMinByFOK = pl.price > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pl.price) : pl.pmLeg.minSize;
    const effectiveMin = Math.max(pl.pmLeg.minSize, pmMinByFOK);
    if (shares < effectiveMin) shares = effectiveMin;
  }
  if (shares * totalCostPerShare > TRADE_USD * 2) {
    console.log(`  [3LEG] Cost too high: ${shares} × $${totalCostPerShare.toFixed(3)} = $${(shares * totalCostPerShare).toFixed(2)} > 2× budget. Skipping.`);
    return { sessionSkip: false, unhedged: null, abortReason: "soft" };
  }

  const totalCost = shares * totalCostPerShare;
  const projectedProfit = shares * realEdge;
  const tag = DRY_RUN ? "[DRY]" : "[LIVE]";
  const matchName = `${entry.kal1.surname} vs ${entry.kal2.surname}`;
  console.log(
    `\n${ts()} ${tag} 3-LEG EXECUTE  dir=${dir}  edge=${fmtPct(realEdge, 2)}` +
    `  shares=${shares}  cost~=$${totalCost.toFixed(2)}  profit~=$${projectedProfit.toFixed(2)}`
  );
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    console.log(`  Leg${i + 1}: ${l.exchange.toUpperCase()} ${l.exchange === "kal" ? l.kalLeg.ticker : l.pmLeg.outcome} YES @${fmtPct(l.price)}`);
  }

  // ── Start execution-time book tracker for the KAL leg ──────────────────────
  {
    const kalLeg3 = legs.find(l => l.exchange === "kal");
    const pmLeg3 = legs.find(l => l.exchange === "pm");
    if (kalLeg3 && pmLeg3) {
      startBookTracker(kalLeg3.kalLeg.ticker, pmLeg3.pmLeg.tokenId, {
        match: matchName, dir, pmOutcome: pmLeg3.pmLeg.outcome,
        kalAsk: kalLeg3.price, pmAsk: pmLeg3.price, edge: realEdge,
        tradeTs: Date.now(),
      }, "execution");
    }
  }

  // ── Execute legs sequentially ──────────────────────────────────────────────
  const filled: { leg: Leg3; fillPrice: number; fillCost: number; kalFees?: number }[] = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const legLabel = `Leg${i + 1}/${legs.length}`;

    if (leg.exchange === "pm") {
      // PM: FOK order
      console.log(`  [${legLabel}] PM FOK ${shares}×${leg.pmLeg.outcome} @${fmtPct(leg.price)}`);
      try {
        const res = await placePmFOK(leg.pmLeg.tokenId, leg.price, shares, leg.pmLeg.tickSize, leg.pmLeg.negRisk, DRY_RUN);
        const meta = extractPmMeta(res);
        if (DRY_RUN) {
          console.log(`  [${legLabel}] PM DRY OK`);
          filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
          continue;
        }
        if (meta.status === "matched") {
          console.log(`  [${legLabel}] PM filled`);
          filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
          continue;
        }
        if (meta.status === "delayed" && meta.orderId) {
          const finalStatus = await waitForPmOrderFill(String(meta.orderId), undefined, leg.pmLeg.tokenId);
          if (finalStatus === "matched") {
            console.log(`  [${legLabel}] PM filled (delayed)`);
            filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
            continue;
          }
        }
        // PM failed — handle partial state
        console.log(`  [${legLabel}] PM REJECTED: status=${meta.status}`);
      } catch (err) {
        console.error(`  [${legLabel}] PM ERROR: ${(err as Error).message}`);
      }
    } else {
      // KAL: limit order at listing price
      const kalLimitCents = Math.max(1, Math.min(99, Math.round(leg.price * 100)));
      console.log(`  [${legLabel}] KAL ${leg.kalLeg.ticker} YES @${kalLimitCents}¢ ×${shares}`);
      try {
        const kalOrder = buildKalshiGTCOrder(leg.kalLeg.ticker, "buy", "yes", kalLimitCents, shares);
        const kalRes = await placeKalshiOrder(kalOrder, DRY_RUN);
        if (DRY_RUN) {
          console.log(`  [${legLabel}] KAL DRY OK`);
          filled.push({ leg, fillPrice: leg.price, fillCost: shares * leg.price });
          continue;
        }
        const kr = kalRes as any;
        const kalFilledQty = Number(kr?.order?.count_filled ?? kr?.count_filled ?? 0);
        const kalFees = Number(kr?.order?.taker_fees ?? kr?.taker_fees ?? 0) / 100;
        const kalFillCost = Number(kr?.order?.taker_fill_cost ?? kr?.taker_fill_cost ?? 0) / 100;
        if (kalFilledQty >= shares) {
          const actualPrice = kalFillCost > 0 ? kalFillCost / kalFilledQty : leg.price;
          console.log(`  [${legLabel}] KAL filled ${kalFilledQty} @${(actualPrice * 100).toFixed(1)}¢ fees=$${kalFees.toFixed(3)}`);
          filled.push({ leg, fillPrice: actualPrice, fillCost: kalFillCost + kalFees, kalFees });
          continue;
        }
        // Partial or no fill — ALWAYS cancel the GTC order to prevent orphaned positions.
        // Without cancellation, the GTC order stays resting on Kalshi, fills later,
        // and creates untracked exposure with no arb_trades entry.
        const orderId = String(kr?.order?.order_id ?? kr?.order_id ?? "");
        if (orderId) {
          try { await cancelKalshiOrder(orderId, DRY_RUN); } catch { /* order may already be gone */ }
        }
        if (kalFilledQty > 0) {
          console.log(`  [${legLabel}] KAL PARTIAL: ${kalFilledQty}/${shares} — cancelled remaining, treating as failed`);
        }
        console.log(`  [${legLabel}] KAL FAILED/PARTIAL`);
      } catch (err) {
        console.error(`  [${legLabel}] KAL ERROR: ${(err as Error).message}`);
      }
    }

    // ── Leg failed — handle based on how many legs already filled ─────────
    if (filled.length === 0) {
      // First leg failed — clean exit, no exposure
      console.log(`  [3LEG] First leg failed. No exposure. Aborting.`);
      return { sessionSkip: false, unhedged: null, abortReason: "soft" };
    }

    if (filled.length === 1) {
      // Only 1 of 3 filled — try to sell it back immediately
      const f = filled[0];
      console.log(`  [3LEG] Only 1 leg filled (${f.leg.exchange}). Attempting immediate exit...`);
      if (f.leg.exchange === "pm") {
        // We hold a PM token — we can't easily sell back via FOK, enter hedge to exit
        // Create unhedged pointing at the PM leg as held, needing KAL to "complete"
        // But actually we just want to exit. The hedge system's "exit" path will sell it.
        const tid5453 = `arb-${Date.now()}`;
        const unhedged: UnhedgedPosition = {
          tradeId: tid5453,
          heldExchange: "pm",
          pmLeg: f.leg.pmLeg,
          pmOppLeg: null,
          pmCostBasis: f.fillPrice,
          kalLeg: f.leg.kalLeg,
          kalCostBasis: 0,
          kalSide: "yes",
          sharesHeld: shares,
          initialShares: shares,
          initialCost: f.fillCost,
          hedgeFillCost: 0,
          hedgeFillCostKal: 0,
          hedgeFillCostPm: 0,
          kalFees: 0,
          initialKalFees: 0,
        };
        logArbTrade({
          id: tid5453, ts: new Date().toISOString(),
          match: matchName, dir, status: "hedging", shares,
          kalTicker: f.leg.kalLeg.ticker, kalFillPrice: 0, kalCost: 0,
          pmOutcome: f.leg.pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: f.leg.pmLeg.tokenId,
          pmFillPrice: f.fillPrice, pmCost: f.fillCost,
          totalCost: f.fillCost, projectedEdge: edge, projectedProfit: shares * edge,
          initialExchange: "pm",
        });
        return { sessionSkip: true, unhedged };
      } else {
        // We hold KAL YES — enter hedge to acquire PM or exit
        const tid5481 = `arb-${Date.now()}`;
        const unhedged: UnhedgedPosition = {
          tradeId: tid5481,
          heldExchange: "kal",
          pmLeg: f.leg.pmLeg,
          pmOppLeg: null,
          pmCostBasis: 0,
          kalLeg: f.leg.kalLeg,
          kalCostBasis: shares > 0 ? f.fillPrice + (f.kalFees ?? 0) / shares : f.fillPrice,
          kalSide: "yes",
          sharesHeld: shares,
          initialShares: shares,
          initialCost: f.fillCost,
          hedgeFillCost: 0,
          hedgeFillCostKal: 0,
          hedgeFillCostPm: 0,
          kalFees: f.kalFees ?? 0,
          initialKalFees: f.kalFees ?? 0,
        };
        logArbTrade({
          id: tid5481, ts: new Date().toISOString(),
          match: matchName, dir, status: "hedging", shares,
          kalTicker: f.leg.kalLeg.ticker, kalFillPrice: f.fillPrice, kalCost: f.fillCost,
          kalFees: f.kalFees,
          pmOutcome: f.leg.pmLeg.outcome, pmSlug: entry.pmSlug, pmTokenId: f.leg.pmLeg.tokenId,
          pmFillPrice: 0, pmCost: 0,
          totalCost: f.fillCost, projectedEdge: edge, projectedProfit: shares * edge,
          initialExchange: "kal",
        });
        return { sessionSkip: true, unhedged };
      }
    }

    // filled.length === 2, missing leg i (the one that just failed)
    // We hold 2 of 3 outcomes — need the 3rd to complete the $1 guarantee
    const missingLeg = leg;
    console.log(`  [3LEG] 2 of 3 legs filled. Missing: ${missingLeg.exchange} ${missingLeg.exchange === "kal" ? missingLeg.kalLeg.ticker : missingLeg.pmLeg.outcome}. Entering hedge mode.`);

    // Build UnhedgedPosition for the missing leg
    // heldExchange = opposite of missing leg's exchange → hedge tries the right exchange first
    const heldEx = missingLeg.exchange === "kal" ? "pm" as const : "kal" as const;
    const totalFilledCost = filled.reduce((s, f) => s + f.fillCost, 0);
    const totalKalFees = filled.reduce((s, f) => s + (f.kalFees ?? 0), 0);

    const tid5522 = `arb-${Date.now()}`;
    const unhedged: UnhedgedPosition = {
      tradeId: tid5522,
      heldExchange: heldEx,
      pmLeg: missingLeg.pmLeg,     // the PM version of the missing outcome
      pmOppLeg: null,              // no opposite in 3-way
      pmCostBasis: heldEx === "pm" ? filled.find(f => f.leg.exchange === "pm")?.fillPrice ?? 0 : 0,
      kalLeg: missingLeg.kalLeg,   // the KAL version of the missing outcome
      kalCostBasis: heldEx === "kal"
        ? (filled.find(f => f.leg.exchange === "kal")?.fillPrice ?? 0) + totalKalFees / Math.max(shares, 1)
        : 0,
      kalSide: "yes",
      sharesHeld: shares,
      initialShares: shares,
      initialCost: totalFilledCost,
      hedgeFillCost: 0,
      hedgeFillCostKal: 0,
      hedgeFillCostPm: 0,
      kalFees: totalKalFees,
      initialKalFees: heldEx === "kal" ? totalKalFees : 0,
    };

    // Log arb trade in hedging state — use the missing leg's KAL ticker as the primary
    logArbTrade({
      id: tid5522, ts: new Date().toISOString(),
      match: matchName, dir, status: "hedging", shares,
      kalTicker: missingLeg.kalLeg.ticker,
      kalFillPrice: filled.find(f => f.leg.exchange === "kal")?.fillPrice ?? 0,
      kalCost: filled.filter(f => f.leg.exchange === "kal").reduce((s, f) => s + f.fillCost, 0),
      kalFees: totalKalFees,
      pmOutcome: missingLeg.pmLeg.outcome,
      pmSlug: entry.pmSlug,
      pmTokenId: missingLeg.pmLeg.tokenId,
      pmFillPrice: filled.find(f => f.leg.exchange === "pm")?.fillPrice ?? 0,
      pmCost: filled.filter(f => f.leg.exchange === "pm").reduce((s, f) => s + f.fillCost, 0),
      totalCost: totalFilledCost,
      projectedEdge: edge, projectedProfit: shares * edge,
      initialExchange: heldEx,
    });
    return { sessionSkip: true, unhedged };
  }

  // ── All 3 legs filled! ──────────────────────────────────────────────────────
  const totalFilledCost = filled.reduce((s, f) => s + f.fillCost, 0);
  const totalKalFees = filled.reduce((s, f) => s + (f.kalFees ?? 0), 0);
  const realizedProfit = shares - totalFilledCost;
  console.log(
    `\n${ts()} [3LEG SUCCESS] All 3 legs filled!` +
    `  shares=${shares}  cost=$${totalFilledCost.toFixed(2)}  profit=$${realizedProfit.toFixed(2)}  kalFees=$${totalKalFees.toFixed(3)}`
  );

  // Record completed arb trade — use first KAL leg's ticker as primary
  const firstKal = filled.find(f => f.leg.exchange === "kal");
  const firstPm = filled.find(f => f.leg.exchange === "pm");
  logArbTrade({
    id: `arb-${Date.now()}`,
    ts: new Date().toISOString(),
    match: matchName, dir,
    status: "resolved",
    shares,
    kalTicker: firstKal?.leg.kalLeg.ticker ?? legs[0].kalLeg.ticker,
    kalFillPrice: firstKal?.fillPrice ?? 0,
    kalCost: filled.filter(f => f.leg.exchange === "kal").reduce((s, f) => s + f.fillCost, 0),
    kalFees: totalKalFees,
    pmOutcome: firstPm?.leg.pmLeg.outcome ?? legs[0].pmLeg.outcome,
    pmSlug: entry.pmSlug,
    pmTokenId: firstPm?.leg.pmLeg.tokenId ?? legs[0].pmLeg.tokenId,
    pmFillPrice: firstPm?.fillPrice ?? 0,
    pmCost: filled.filter(f => f.leg.exchange === "pm").reduce((s, f) => s + f.fillCost, 0),
    totalCost: totalFilledCost,
    projectedEdge: edge, projectedProfit: shares * edge,
    realizedPnl: Math.round(realizedProfit * 100) / 100,
    resolvedTs: new Date().toISOString(),
    resolutionMethod: "both-legs",
    initialExchange: legs[0].exchange === "pm" ? "pm" : "kal",
  });

  console.log(`  [3LEG TIMING] Total=${(performance.now() - execStart).toFixed(0)}ms`);
  return { sessionSkip: true, unhedged: null };
}

// ─── Module-level state (shared across monitorLoop and executeArb) ───────────
// These mirror the local variables from tradeTennis.ts that are referenced
// by both executeArb (cancelled ticker checks) and monitorLoop (seeding at startup).
const _cancelledTickers = new Set<string>();
const _cancelledEventKeys = new Set<string>();
let _lastKalRestRefreshMs = 0;
const KAL_REST_REFRESH_INTERVAL_MS = 300_000; // 5 min

// ─── monitorLoop ─────────────────────────────────────────────────────────────

export async function monitorLoop(watchlist: WatchEntry[]): Promise<void> {
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

  // Track in-flight hedge cycles to prevent spam when runHedgeCycle hangs.
  const _hedgeInflight = new Set<string>();
  // tradeId → timestamp until which we should NOT re-enter runHedgeCycle.
  // Set when the watchdog fires; cleared when a cycle completes naturally.
  const _hedgeWatchdogCooldownUntil = new Map<string, number>();

  // cooldownMap: matchCode → timestamp of last trade ATTEMPT (success or fail)
  const cooldownMap = new Map<string, number>();
  // kalTickerCooldown: kalTicker → timestamp — prevents firing the same Kalshi market
  // from different watchlist entries (e.g. GAME vs MAP entries sharing a ticker)
  const kalTickerCooldown = new Map<string, number>();
  // pmSlugCooldown: pmSlug → timestamp — prevents buying same PM market from GAME+MAP entries
  const pmSlugCooldown = new Map<string, number>();
  // abortCooldown: matchCode → { count, cooldownUntil } — after 3 consecutive aborts, skip for 5 min
  const ABORT_COOLDOWN_THRESHOLD = 3;
  const ABORT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  const abortCountMap = new Map<string, { count: number; cooldownUntil: number }>();
  // sessionSkipSet: matches already traded — don't trade again this session.
  // Prevents re-arbing the same match in the opposite direction (which nets out to a fee loss).
  // Seeded at startup from arb_trades.json: includes recent trades (last 3 days) AND any
  // non-resolved trades (a trade placed days ago on a future game should still block).
  const sessionSkipSet = new Set<string>();
  {
    const recentCutoff = Date.now() - 3 * 86_400_000; // 3 days ago
    const pastTrades = loadArbTrades();
    for (const t of pastTrades) {
      if (!t.kalTicker || !t.ts) continue;
      const tradeTime = new Date(t.ts).getTime();
      const isRecent = tradeTime >= recentCutoff;
      const isActive = t.status === "hedging" || t.status === "filled";
      // Seed from recent trades OR any still-active trades (placed earlier for future games)
      if (isRecent || isActive) {
        const mc = matchCodePrefix(t.kalTicker);
        if (mc) sessionSkipSet.add(mc);
      }
    }
    if (sessionSkipSet.size > 0) {
      console.log(`[STARTUP] Seeded sessionSkipSet with ${sessionSkipSet.size} match(es) from recent/active trades: ${Array.from(sessionSkipSet).join(", ")}`);
    }
  }
  // Coin-flip warning: PM pricing ~50/50 — only warn once per match
  const coinFlipWarned = new Set<string>();
  // inflight: markets currently executing an arb — prevents concurrent execution on same market
  const inflight = new Set<string>();
  // Circuit breaker: consecutive arb execution errors
  let consecutiveErrors = 0;

  // Helper: cancel ALL resting orders on both exchanges (used when clearing hedge state)
  async function cancelAllHedgeOrders(orders: Map<string, HedgeOrder>): Promise<void> {
    for (const [oid, ho] of orders) {
      try {
        if (ho.exchange === "pm") await cancelPmOrder(oid, DRY_RUN);
        else await cancelKalshiOrder(oid, DRY_RUN);
        console.log(`[HEDGE RESUME] Cancelled ${ho.exchange.toUpperCase()} ${ho.role} order ${oid.slice(0, 16)}...`);
      } catch (e) {
        console.error(`[HEDGE RESUME] Could not cancel ${ho.exchange.toUpperCase()} order ${oid.slice(0, 16)}...: ${(e as Error).message}`);
      }
    }
  }

  // Active hedge states — load from file first; if none, scan both wallets.
  // Supports MULTIPLE simultaneous hedges (e.g. Tirante on PM + Elegance on Kalshi).
  // Fetch all Kalshi positions in ONE API call — reused by resume loop + detectUnhedgedKal.
  const kalPosMap = await getKalshiPositionMap();

  // Seed sessionSkipSet from on-chain Kalshi positions — orphan tickers
  // (prior-session shares not tracked in arb_trades.json) must also block re-arbing,
  // otherwise a ticker with leftover shares can double-fire the consolidation reconciler.
  {
    let onchainAdded = 0;
    for (const [ticker, p] of kalPosMap) {
      if ((p.yesCount || 0) <= 0 && (p.noCount || 0) <= 0) continue;
      const mc = matchCodePrefix(ticker);
      if (mc && !sessionSkipSet.has(mc)) {
        sessionSkipSet.add(mc);
        onchainAdded += 1;
      }
    }
    if (onchainAdded > 0) {
      console.log(`[STARTUP] Added ${onchainAdded} match(es) to sessionSkipSet from on-chain Kalshi positions`);
    }
  }

  let hedgeStates: HedgeState[] = loadHedgeStates();
  setAllHedgeStates(hedgeStates);
  if (hedgeStates.length > 0) {
    // Re-check actual coverage on each position and clean up resolved ones
    const surviving: HedgeState[] = [];
    for (const hs of hedgeStates) {
      const pos = hs.position;
      if (!DRY_RUN) {
        // ── Verify the HELD position actually exists on the exchange ──────────
        // Prevents ghost positions: state file says we hold shares but wallet/API disagrees.
        if (pos.heldExchange === "pm") {
          try {
            const pmPos = await fetchPmPositionsCached(0);
            const heldQty = sumPmHeld(pmPos, pos.pmLeg.tokenId);
            if (heldQty <= 0) {
              console.warn(
                `\n[HEDGE RESUME] ⚠ GHOST POSITION: PM ${pos.pmLeg.outcome} not found in wallet!` +
                ` Persisted sharesHeld=${pos.sharesHeld} but wallet has 0. Clearing.\n`
              );
              if (hs.activeOrders.size > 0) await cancelAllHedgeOrders(hs.activeOrders);
              continue; // don't add to surviving
            }
            if (heldQty < pos.sharesHeld) {
              console.warn(`[HEDGE RESUME] PM wallet has ${heldQty} but state says ${pos.sharesHeld}. Using wallet qty.`);
              pos.sharesHeld = heldQty;
            }
          } catch (e) {
            console.error(`[HEDGE RESUME] PM held-position verify failed: ${(e as Error).message} — proceeding with persisted qty.`);
          }
        } else {
          try {
            const kalQty = kalPosMap.get(pos.kalLeg.ticker)?.yesCount ?? 0;
            if (kalQty <= 0) {
              console.warn(
                `\n[HEDGE RESUME] ⚠ GHOST POSITION: Kalshi ${pos.kalLeg.ticker} YES not found!` +
                ` Persisted sharesHeld=${pos.sharesHeld} but API has 0. Clearing.\n`
              );
              if (hs.activeOrders.size > 0) await cancelAllHedgeOrders(hs.activeOrders);
              continue;
            }
            if (kalQty < pos.sharesHeld) {
              console.warn(`[HEDGE RESUME] Kalshi has ${kalQty} but state says ${pos.sharesHeld}. Using API qty.`);
              pos.sharesHeld = kalQty;
            }
          } catch (e) {
            console.error(`[HEDGE RESUME] Kalshi held-position verify failed: ${(e as Error).message} — proceeding with persisted qty.`);
          }
        }

        // ── Check coverage on opposite legs (using pre-fetched maps) ─────────
        let covered = 0;
        if (pos.heldExchange === "pm") {
          covered += kalPosMap.get(pos.kalLeg.ticker)?.yesCount ?? 0;
          if (pos.pmOppLeg) {
            try {
              const pmPositions = await fetchPmPositionsCached(5000);
              covered += sumPmHeld(pmPositions, pos.pmOppLeg.tokenId);
            } catch (e) {
              console.error(`[HEDGE RESUME] Failed to check PM positions: ${(e as Error).message}`);
            }
          }
        } else {
          try {
            const pmPositions = await fetchPmPositionsCached(5000);
            covered += sumPmHeld(pmPositions, pos.pmLeg.tokenId);
          } catch (e) {
            console.error(`[HEDGE RESUME] Failed to check PM positions: ${(e as Error).message}`);
          }
          covered += kalPosMap.get(pos.kalLeg.ticker)?.noCount ?? 0;
        }
        covered = Math.min(pos.sharesHeld, covered);

        // Verify resting orders from previous session — keep live ones to preserve
        // queue position (breakeven price doesn't change). Remove dead ones.
        if (hs.activeOrders.size > 0) {
          const deadOrders: string[] = [];
          for (const [oid, ho] of hs.activeOrders) {
            try {
              if (ho.exchange === "pm") {
                const { filledShares, status } = await Promise.race([
                  getPmOrderFills(oid),
                  new Promise<never>((_, rej) => setTimeout(() => rej(new Error("verify-timeout")), 5_000)),
                ]);
                if (status === "matched" || status === "cancelled" || status === "expired") {
                  // Order is done — credit any fills, then remove
                  if (filledShares > ho.filledSoFar) {
                    ho.filledSoFar = filledShares;
                    pos.sharesHeld = Math.max(0, pos.sharesHeld - (filledShares - ho.filledSoFar));
                    console.log(`[HEDGE RESUME] PM order ${oid.slice(0, 16)}... filled ${filledShares} shares while offline.`);
                  }
                  deadOrders.push(oid);
                  console.log(`[HEDGE RESUME] PM order ${oid.slice(0, 16)}... status=${status} — removing.`);
                } else {
                  // Order is still live (open/active) — keep it, preserve queue position
                  if (filledShares > ho.filledSoFar) {
                    ho.filledSoFar = filledShares;
                    console.log(`[HEDGE RESUME] PM order ${oid.slice(0, 16)}... partial fill: ${filledShares} shares. Keeping order.`);
                  } else {
                    console.log(`[HEDGE RESUME] PM order ${oid.slice(0, 16)}... still live (${status}). Keeping order, preserving queue position.`);
                  }
                }
              } else {
                // Kalshi orders — check via API
                try {
                  const kalOrder = await Promise.race([
                    getKalshiOrder(oid),
                    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("verify-timeout")), 5_000)),
                  ]);
                  const kalStatus = String(kalOrder.status ?? "").toLowerCase();
                  if (kalStatus === "filled" || kalStatus === "cancelled" || kalStatus === "expired") {
                    deadOrders.push(oid);
                    console.log(`[HEDGE RESUME] KAL order ${oid.slice(0, 16)}... status=${kalStatus} — removing.`);
                  } else {
                    console.log(`[HEDGE RESUME] KAL order ${oid.slice(0, 16)}... still live (${kalStatus}). Keeping order.`);
                  }
                } catch {
                  // Can't verify — assume dead, hedge cycle will re-place
                  deadOrders.push(oid);
                  console.warn(`[HEDGE RESUME] KAL order ${oid.slice(0, 16)}... verify failed — removing (hedge cycle will re-place).`);
                }
              }
            } catch {
              // PM verify timed out or failed — assume order is dead
              deadOrders.push(oid);
              console.warn(`[HEDGE RESUME] Order ${oid.slice(0, 16)}... verify failed/timeout — removing (hedge cycle will re-place).`);
            }
          }
          for (const oid of deadOrders) hs.activeOrders.delete(oid);
        }

        if (covered >= pos.sharesHeld) {
          console.warn(
            `\n[HEDGE RESUME] ${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}` +
            ` fully covered (${covered}/${pos.sharesHeld}). Clearing.\n`
          );
          continue; // don't add to surviving
        } else if (covered > 0) {
          const old = pos.sharesHeld;
          pos.sharesHeld -= covered;
          console.warn(`[HEDGE RESUME] ${old - covered}/${old} remaining for ${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}.`);
        }
      }
      console.warn(
        `[HEDGE RESUME] ${pos.sharesHeld} ${pos.heldExchange.toUpperCase()} shares of ` +
        `${pos.heldExchange === "pm" ? pos.pmLeg.outcome : pos.kalLeg.ticker}. Resuming.\n`
      );
      surviving.push(hs);
    }
    hedgeStates = surviving;
  }

  // ── Restore orphaned "hedging" trades from arb_trades.json ─────────────────
  // If hedge_state.json was lost on restart but arb_trades still has "hedging" records,
  // reconstruct correct HedgeState from the trade record (preserving dir → kalSide).
  // This prevents detectUnhedgedPmPositions from re-detecting with hardcoded kalSide="yes"
  // which is WRONG for Dir C/D trades (kalSide should be "no").
  {
    const hsTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
    const allTrades = loadArbTrades();
    const orphanedHedging = allTrades.filter(t => t.status === "hedging" && !hsTickers.has(t.kalTicker));
    if (orphanedHedging.length > 0) {
      // Build kalTicker → watchlist lookup
      const kalTickerToWatch = new Map<string, { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg }>();
      for (const entry of watchlist) {
        kalTickerToWatch.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm1 });
        kalTickerToWatch.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm2 });
        if (entry.kal3 && entry.pm3) {
          kalTickerToWatch.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
        }
      }
      for (const t of orphanedHedging) {
        const wm = kalTickerToWatch.get(t.kalTicker);
        if (!wm) {
          console.warn(`[STARTUP] Orphaned hedging trade ${t.id} (${t.kalTicker}) not in watchlist — cannot restore.`);
          continue;
        }
        // Derive kalSide from dir: C/D/G/H/I use KAL NO, everything else uses KAL YES
        const kalNoSideDirs = new Set(["C", "D", "G", "H", "I"]);
        const kalSide: "yes" | "no" = kalNoSideDirs.has(t.dir) ? "no" : "yes";
        const heldExchange = t.initialExchange ?? (t.pmCost > 0 && t.kalCost === 0 ? "pm" : "kal");
        // Find the correct PM leg from the trade record (match by pmOutcome or pmTokenId)
        const entry = wm.entry;
        let pmLeg: PmLeg = wm.pmLeg;
        let pmOppLeg: PmLeg | null = null;
        const is3WayDir = "GHIJKL".includes(t.dir);
        if (!is3WayDir) {
          // 2-way: Dir A: kal1→pm2.  Dir B: kal2→pm1.  Dir C: kal1→pm1.  Dir D: kal2→pm2.
          if (t.dir === "A" || t.dir === "D") { pmLeg = entry.pm2; pmOppLeg = entry.pm1; }
          else if (t.dir === "B" || t.dir === "C") { pmLeg = entry.pm1; pmOppLeg = entry.pm2; }
        } else {
          // 3-way soccer: no pmOppLeg (can't complete with a single opposite token)
          pmOppLeg = null;
        }
        // Override with trade's tokenId if available (more reliable — handles NO tokens too)
        if (t.pmTokenId) {
          for (const leg of [entry.pm1, entry.pm2, entry.pm3].filter(Boolean) as PmLeg[]) {
            if (leg.tokenId === t.pmTokenId || leg.noTokenId === t.pmTokenId) {
              // If tokenId matches a noTokenId, use the NO version
              if (leg.noTokenId === t.pmTokenId) {
                pmLeg = { ...leg, tokenId: leg.noTokenId, outcome: `${leg.outcome} [NO]` };
              } else {
                pmLeg = leg;
              }
              break;
            }
          }
        }
        const costBasis = heldExchange === "pm"
          ? (t.pmFillPrice > 0 ? t.pmFillPrice : t.pmCost / Math.max(t.shares, 1))
          : (t.kalFillPrice > 0 ? t.kalFillPrice : t.kalCost / Math.max(t.shares, 1));
        const kalFeePerShare = (t.kalFees ?? 0) / Math.max(t.shares, 1);
        const restoredState: HedgeState = {
          position: {
            tradeId: t.id,
            heldExchange,
            pmLeg,
            pmOppLeg: heldExchange === "pm" ? pmOppLeg : null,
            pmCostBasis: heldExchange === "pm" ? costBasis : 0,
            kalLeg: wm.kalLeg,
            kalCostBasis: heldExchange === "kal" ? costBasis + kalFeePerShare : 0,
            kalSide,
            sharesHeld: t.shares,
            initialShares: t.shares,
            initialCost: heldExchange === "pm" ? t.pmCost : t.kalCost,
            hedgeFillCost: 0,
            hedgeFillCostKal: 0,
            hedgeFillCostPm: 0,
            kalFees: t.kalFees ?? 0,
            initialKalFees: heldExchange === "kal" ? (t.kalFees ?? 0) : 0,
          },
          activeOrders: new Map(),
          kalNextRetryAt: 0,
          pmOnlyCycles: 0,
        };
        hedgeStates.push(restoredState);
        hsTickers.add(t.kalTicker);
        console.warn(
          `\n[STARTUP] Restored orphaned hedging trade: ${t.match} dir=${t.dir} kalSide=${kalSide}` +
          ` held=${heldExchange} shares=${t.shares} ticker=${t.kalTicker}\n`
        );
      }
    }
  }

  // Always scan both wallets — even if we loaded persisted states, there may be OTHER positions.
  // Pass current hedgeState tickers so detection knows which "hedging" arb trades are actually active.
  console.log("[STARTUP] Scanning both wallets for unhedged positions...");
  const hsTickerSet = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
  const pmFound = await detectUnhedgedPmPositions(watchlist, hsTickerSet);
  const kalFound = await detectUnhedgedKalPositions(watchlist, kalPosMap, hsTickerSet);

  // ── Cross-match dedup for 3-way markets ───────────────────────────────────
  // When both detection functions find positions from the SAME 3-way match
  // (e.g., KAL BRC YES + PM MID YES from an old 2-way hedge), hedging just ONE
  // side is sufficient. The hedged pair guarantees $1 in all outcomes; the
  // unhedged position becomes a free bonus (pays $1 in 1-of-3 outcomes).
  // Creating two independent hedges costs double for only marginal benefit.
  const pmBySlug = new Map<string, HedgeState>();
  for (const hs of pmFound) {
    const slug = watchlist.find(w =>
      w.pm1.tokenId === hs.position.pmLeg.tokenId ||
      w.pm2.tokenId === hs.position.pmLeg.tokenId ||
      w.pm3?.tokenId === hs.position.pmLeg.tokenId ||
      w.pm1.noTokenId === hs.position.pmLeg.tokenId ||
      w.pm2.noTokenId === hs.position.pmLeg.tokenId ||
      w.pm3?.noTokenId === hs.position.pmLeg.tokenId
    )?.pmSlug;
    if (slug) pmBySlug.set(slug, hs);
  }
  const deduplicatedKalFound: HedgeState[] = [];
  for (const hs of kalFound) {
    const entry = watchlist.find(w =>
      w.kal1.ticker === hs.position.kalLeg.ticker ||
      w.kal2.ticker === hs.position.kalLeg.ticker ||
      w.kal3?.ticker === hs.position.kalLeg.ticker
    );
    if (entry?.is3Way && pmBySlug.has(entry.pmSlug)) {
      const pmHs = pmBySlug.get(entry.pmSlug)!;
      console.log(
        `[STARTUP] 3-way cross-match dedup: KAL ${hs.position.sharesHeld}×${hs.position.kalLeg.ticker} YES` +
        ` and PM ${pmHs.position.sharesHeld}×${pmHs.position.pmLeg.outcome} are from the same match.` +
        ` Keeping PM-side hedge only — KAL position becomes bonus coverage.`
      );
      continue; // skip this KAL hedge state
    }
    deduplicatedKalFound.push(hs);
  }
  const freshFound = [...pmFound, ...deduplicatedKalFound];

  // Deduplicate: don't add positions that are already being hedged (same kalLeg ticker).
  // Also update kalCostBasis from fresh API data — the persisted value may have used
  // an old formula (net-of-fees) that understates the true purchase price.
  const existingTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
  for (const hs of freshFound) {
    if (!existingTickers.has(hs.position.kalLeg.ticker)) {
      hedgeStates.push(hs);
      existingTickers.add(hs.position.kalLeg.ticker);
    } else {
      // Refresh kalCostBasis for KAL-held positions from fresh API data
      const existing = hedgeStates.find(h => h.position.kalLeg.ticker === hs.position.kalLeg.ticker);
      if (existing && existing.position.heldExchange === "kal" && hs.position.kalCostBasis > 0) {
        const oldCb = existing.position.kalCostBasis;
        if (Math.abs(oldCb - hs.position.kalCostBasis) > 0.001) {
          existing.position.kalCostBasis = hs.position.kalCostBasis;
          console.warn(
            `[HEDGE RESUME] Updated kalCostBasis for ${hs.position.kalLeg.ticker}: ` +
            `${fmtPct(oldCb)} → ${fmtPct(hs.position.kalCostBasis)} (fresh from API)`
          );
        }
      }
    }
  }

  // ── Cancel ALL resting Kalshi orders at startup ─────────────────────────────
  // Prevents over-hedging: if the bot crashed after placing a GTC order but before
  // saving hedge_state.json, the order is still live on Kalshi but invisible to us.
  // On restart, the hedge cycle would place ANOTHER order → double-fill → over-hedge.
  // Safe to cancel everything: the bot only places hedge orders, never manual orders.
  try {
    const restingOrders = await fetchOpenKalshiOrders();
    if (restingOrders.length > 0) {
      console.warn(`[STARTUP] Found ${restingOrders.length} resting Kalshi order(s) from previous session. Cancelling all to prevent over-hedging.`);
      for (const ro of restingOrders) {
        try {
          await cancelKalshiOrder(ro.orderId, DRY_RUN);
          console.log(`[STARTUP]   Cancelled ${ro.side.toUpperCase()} ${ro.ticker} ${ro.remainingCount}×@${ro.priceCents}¢ (${ro.orderId.slice(0, 16)}...)`);
        } catch (e) {
          console.error(`[STARTUP]   Failed to cancel order ${ro.orderId.slice(0, 16)}...: ${(e as Error).message}`);
        }
      }
    } else {
      console.log("[STARTUP] No resting Kalshi orders found. Clean slate.");
    }
  } catch (e) {
    console.error(`[STARTUP] Failed to fetch open Kalshi orders: ${(e as Error).message}. Proceeding with caution.`);
  }

  if (hedgeStates.length > 0) {
    saveHedgeStates(hedgeStates);
    console.log(`[STARTUP] Hedging ${hedgeStates.length} position(s) simultaneously.\n`);
  } else {
    saveHedgeStates([]);
    console.log("[STARTUP] No unhedged positions found on either exchange. Starting clean.\n");
  }
  let cycle = 0;

  // ── P&L summary ────────────────────────────────────────────────────────────
  const arbTrades = loadArbTrades();
  if (arbTrades.length > 0) {
    const filledTrades = arbTrades.filter(t => t.status === "filled");
    const hedging = arbTrades.filter(t => t.status === "hedging");
    const resolved = arbTrades.filter(t => t.status === "resolved");
    const totalCostAll = arbTrades.reduce((s, t) => s + t.totalCost, 0);
    const totalPnl = filledTrades.reduce((s, t) => s + (t.realizedPnl ?? t.projectedProfit), 0);
    console.log(`\n[P&L] ${arbTrades.length} arbs: ${filledTrades.length} filled, ${resolved.length} resolved, ${hedging.length} hedging`);
    console.log(`[P&L] Total invested: $${totalCostAll.toFixed(2)}  Est. P&L (filled): $${totalPnl.toFixed(2)}\n`);
  }

  console.log(
    `\n[MONITOR] Starting  matches=${watchlist.length}  DRY_RUN=${DRY_RUN}` +
    `  USD/trade=${TRADE_USD}  MAX_CONTRACTS=${MAX_CONTRACTS}  MIN_EDGE=${fmtPct(MIN_EDGE)}` +
    `  fees: KAL=${(KALSHI_FEE_RATE * 100).toFixed(1)}% PM=${(PM_FEE_RATE * 100).toFixed(1)}%` +
    `  hedge=${HEDGE_TARGET}  strict=${STRICT_HEDGE}` +
    `  poll=${POLL_INTERVAL_MS}ms  cooldown=${TRADE_COOLDOWN_MS / 1000}s\n`
  );

  // ── Pre-warm PM ClobClient (avoids ~200-500ms cold start on first trade) ──
  try {
    const warmStart = performance.now();
    await createPmClient();
    console.log(`[STARTUP] PM ClobClient pre-warmed (${(performance.now() - warmStart).toFixed(0)}ms)`);
  } catch (e) {
    console.warn(`[STARTUP] PM client warmup failed: ${(e as Error).message}`);
  }

  // ── Seed cancelled-event keys from trade history ────────────────────────────
  // If any past trade resolved via scalar settlement, block that event date
  // to prevent trading sibling/rescheduled markets for the same match.
  {
    const pastTrades = loadArbTrades();
    const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
    const checkedTickers = new Set<string>();
    const recentCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
    for (const t of pastTrades) {
      if (!t.kalTicker) continue;
      if (checkedTickers.has(t.kalTicker)) continue;
      // Only check recent trades to avoid excessive API calls at startup
      const tradeTime = new Date(t.ts).getTime();
      if (tradeTime < recentCutoff) continue;
      // Check resolved + filled trades — both could be on scalar-settled markets
      if (t.status === "resolved" || t.status === "filled") {
        checkedTickers.add(t.kalTicker);
        try {
          const mktRes = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${t.kalTicker}`);
          const mkt = mktRes.market ?? mktRes as unknown as KalshiMarket;
          if (isScalarSettlement(mkt)) {
            _cancelledTickers.add(t.kalTicker);
            _cancelledEventKeys.add(extractEventDateKey(t.kalTicker));
            console.log(`[STARTUP] Flagged cancelled event: ${t.kalTicker} → key="${extractEventDateKey(t.kalTicker)}"`);
          }
        } catch {
          // Market may be delisted — that's also a cancellation signal
        }
      }
    }
    if (_cancelledEventKeys.size > 0) {
      console.log(`[STARTUP] ${_cancelledEventKeys.size} cancelled event key(s): ${[..._cancelledEventKeys].join(", ")}`);
    }
  }

  while (true) {
    const cycleStart = Date.now();
    cycle++;
    let _step = "start";

    // Watchdog: log if cycle hangs for >60s, auto-exit if stuck for >5 minutes.
    // The process wrapper (batch script / pm2) handles restart.
    const watchdog = setTimeout(() => {
      console.error(`[WATCHDOG] cycle=${cycle} STUCK at step="${_step}" for >60s!`);
    }, 60_000);
    const watchdogKill = setTimeout(() => {
      console.error(`[WATCHDOG] cycle=${cycle} STUCK at step="${_step}" for >5 MINUTES. Exiting with code 1 — supervisor (run-bot.bat / npm run trade:arb:auto / pm2) must restart.`);
      process.exit(1);
    }, 5 * 60_000);

    try {

    // ── MID-SESSION RECOVERY: pick up auto-recovered trades from reconciliation ──
    // reconcilePositions may create "hedging" trades mid-session. Without this,
    // they'd sit in arb_trades.json doing nothing until the next restart.
    if (_reconcileRecoveredTrades || cycle % 500 === 1) {
      setReconcileRecoveredTrades(false);
      const hsTickers = new Set(hedgeStates.map(hs => hs.position.kalLeg.ticker));
      const freshTrades = loadArbTrades();
      const newHedging = freshTrades.filter(t => t.status === "hedging" && !hsTickers.has(t.kalTicker));
      if (newHedging.length > 0) {
        // Build kalTicker → watchlist lookup
        const kalTickerToWatch = new Map<string, { entry: WatchEntry; kalLeg: KalshiLeg; pmLeg: PmLeg }>();
        for (const entry of watchlist) {
          kalTickerToWatch.set(entry.kal1.ticker, { entry, kalLeg: entry.kal1, pmLeg: entry.pm1 });
          kalTickerToWatch.set(entry.kal2.ticker, { entry, kalLeg: entry.kal2, pmLeg: entry.pm2 });
          if (entry.kal3 && entry.pm3) {
            kalTickerToWatch.set(entry.kal3.ticker, { entry, kalLeg: entry.kal3, pmLeg: entry.pm3 });
          }
        }
        for (const t of newHedging) {
          const wm = kalTickerToWatch.get(t.kalTicker);
          if (!wm) {
            console.warn(`[RECONCILE→HEDGE] Recovered trade ${t.id} (${t.kalTicker}) not in watchlist — cannot start hedge.`);
            continue;
          }
          const kalNoSideDirs = new Set(["C", "D", "G", "H", "I"]);
          const kalSide: "yes" | "no" = kalNoSideDirs.has(t.dir) ? "no" : "yes";
          const heldExchange = t.initialExchange ?? (t.pmCost > 0 && t.kalCost === 0 ? "pm" : "kal");
          const entry = wm.entry;
          let pmLeg: PmLeg = wm.pmLeg;
          let pmOppLeg: PmLeg | null = null;
          const is3WayDir = "GHIJKL".includes(t.dir);
          if (!is3WayDir) {
            if (t.dir === "A" || t.dir === "D") { pmLeg = entry.pm2; pmOppLeg = entry.pm1; }
            else if (t.dir === "B" || t.dir === "C") { pmLeg = entry.pm1; pmOppLeg = entry.pm2; }
          }
          if (t.pmTokenId) {
            for (const leg of [entry.pm1, entry.pm2, entry.pm3].filter(Boolean) as PmLeg[]) {
              if (leg.tokenId === t.pmTokenId || leg.noTokenId === t.pmTokenId) {
                if (leg.noTokenId === t.pmTokenId) {
                  pmLeg = { ...leg, tokenId: leg.noTokenId, outcome: `${leg.outcome} [NO]` };
                } else {
                  pmLeg = leg;
                }
                break;
              }
            }
          }
          const costBasis = heldExchange === "pm"
            ? (t.pmFillPrice > 0 ? t.pmFillPrice : t.pmCost / Math.max(t.shares, 1))
            : (t.kalFillPrice > 0 ? t.kalFillPrice : t.kalCost / Math.max(t.shares, 1));
          const kalFeePerShare = (t.kalFees ?? 0) / Math.max(t.shares, 1);
          const newHs: HedgeState = {
            position: {
              tradeId: t.id,
              heldExchange,
              pmLeg,
              pmOppLeg: heldExchange === "pm" ? pmOppLeg : null,
              pmCostBasis: heldExchange === "pm" ? costBasis : 0,
              kalLeg: wm.kalLeg,
              kalCostBasis: heldExchange === "kal" ? costBasis + kalFeePerShare : 0,
              kalSide,
              sharesHeld: t.shares,
              initialShares: t.shares,
              initialCost: heldExchange === "pm" ? t.pmCost : t.kalCost,
              hedgeFillCost: 0,
              hedgeFillCostKal: 0,
              hedgeFillCostPm: 0,
              kalFees: t.kalFees ?? 0,
              initialKalFees: heldExchange === "kal" ? (t.kalFees ?? 0) : 0,
            },
            activeOrders: new Map(),
            kalNextRetryAt: 0,
            pmOnlyCycles: 0,
          };
          hedgeStates.push(newHs);
          hsTickers.add(t.kalTicker);
          console.log(
            `\n[RECONCILE→HEDGE] Picked up recovered trade: ${t.match} dir=${t.dir} kalSide=${kalSide}` +
            ` held=${heldExchange} shares=${t.shares} ticker=${t.kalTicker}\n`
          );
        }
        setAllHedgeStates(hedgeStates);
        saveHedgeStates(hedgeStates);
      }
    }

    _step = "hedge-check";
    // ── HEDGE CHECK: process unhedged positions, then CONTINUE to arb scanning ──
    // Hedge orders are GTC — they rest on the book. We only need to:
    //  1) Place orders that aren't placed yet (first cycle after detection)
    //  2) Check fills periodically (~every 10s, not every 400ms cycle)
    // Normal arb scanning ALWAYS runs regardless of hedge state.
    if (hedgeStates.length > 0) {
      const allOrdersPlaced = hedgeStates.every(hs => hs.activeOrders.size > 0);
      const hedgeCheckInterval = allOrdersPlaced ? 25 : 1; // 25 cycles ≈ 10s once orders are placed

      if (cycle % hedgeCheckInterval === 0) {
        // Run all hedge cycles in parallel, non-blocking.
        //
        // WATCHDOG (not a GTC deadline): the inner `runHedgeCycle` places a GTC
        // order and then awaits WS notifications for its lifecycle. GTC orders
        // on both exchanges persist until filled or manually cancelled — they
        // are NEVER time-limited by this timeout. What the watchdog does is cap
        // how long a single invocation can hold its lock so a wedged cycle
        // doesn't permanently block re-entry. If it fires, the GTC orders stay
        // on the exchange; only the local awaits are abandoned.
        //
        // After a watchdog fire we apply a COOLDOWN — without it, the main loop
        // would immediately start a fresh cycle on the next tick, accumulate a
        // pile of orphan hanging promises, and eventually fire dozens of stale
        // watchdog warnings in a single instant.
        const HEDGE_CYCLE_WATCHDOG_MS = Number(process.env.HEDGE_CYCLE_WATCHDOG_MS ?? 30 * 60_000);
        const HEDGE_WATCHDOG_COOLDOWN_MS = Number(process.env.HEDGE_WATCHDOG_COOLDOWN_MS ?? 5 * 60_000);
        for (const hs of hedgeStates) {
          const ticker = hs.position.kalLeg.ticker;
          const tradeId = hs.position.tradeId;
          if (_hedgeInflight.has(tradeId)) continue; // previous cycle still running
          // Respect post-watchdog cooldown so we don't immediately re-enter
          // and stack hanging cycles on top of each other.
          const cooldownUntil = _hedgeWatchdogCooldownUntil.get(tradeId);
          if (cooldownUntil && Date.now() < cooldownUntil) continue;
          _hedgeInflight.add(tradeId);
          let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
          let watchdogFired = false;
          Promise.race([
            runHedgeCycle(hs, clobBase),
            new Promise<void>(resolve => {
              watchdogTimer = setTimeout(() => {
                watchdogFired = true;
                console.warn(
                  `[HEDGE] cycle watchdog fired for ${ticker} (${HEDGE_CYCLE_WATCHDOG_MS / 60_000}min). ` +
                  `Re-entry blocked for ${HEDGE_WATCHDOG_COOLDOWN_MS / 60_000}min cooldown. ` +
                  `GTC orders on the exchange are NOT cancelled.`
                );
                _hedgeWatchdogCooldownUntil.set(tradeId, Date.now() + HEDGE_WATCHDOG_COOLDOWN_MS);
                releaseHedgeCycleLock(tradeId);
                resolve();
              }, HEDGE_CYCLE_WATCHDOG_MS);
            }),
          ])
          .catch(err => console.error(`[HEDGE] cycle error for ${ticker}: ${(err as Error).message}`))
          .finally(() => {
            // Always clear the watchdog timer when the race is done — without
            // this, a naturally-completed cycle still has a pending timer that
            // will fire later and log a stale watchdog warning.
            if (watchdogTimer) clearTimeout(watchdogTimer);
            // Successful completion clears any prior cooldown.
            if (!watchdogFired) _hedgeWatchdogCooldownUntil.delete(tradeId);
            _hedgeInflight.delete(tradeId);
          });
        }

        // Remove resolved positions
        const beforeLen = hedgeStates.length;
        hedgeStates = hedgeStates.filter(hs => {
          if (hs.position.sharesHeld <= 0) {
            const p = hs.position;
            const name = p.heldExchange === "pm" ? p.pmLeg.outcome : p.kalLeg.ticker;

            if (p.hedgeFillCost > 0) {
              // Genuine hedge-complete: both legs filled → guaranteed $1/share payout.
              const isPmInitial = p.heldExchange === "pm";
              // initialCost already includes initial Kalshi fees for KAL-held positions.
              // For KAL-held, add hedge fees separately (kalFees - initialKalFees).
              const hedgeKalFees = Math.max(0, p.kalFees - p.initialKalFees);
              // Keep per-exchange costs SEPARATE: pmCost = only initial PM cost,
              // kalCost = only initial KAL cost. hedgeCost is tracked independently.
              // totalCost = kalCost + pmCost (the two initial legs, no double-counting).
              const kalCostR = isPmInitial
                ? Math.round((p.hedgeFillCostKal + hedgeKalFees) * 100) / 100
                : Math.round((p.initialCost + p.hedgeFillCostKal + hedgeKalFees) * 100) / 100;
              // PM-initial + PM-opposite hedge path: hedgeFillCostPm holds the opposite-token
              // purchase cost. Previously this was omitted from pmCostR, inflating the
              // reported P&L by exactly the hedge cost. Include it here so totalCost matches
              // what was actually spent. hedgeFillCostPm is 0 on the more common KAL-hedge
              // path, so this is safe for both branches.
              const pmCostR = isPmInitial
                ? Math.round((p.initialCost + p.hedgeFillCostPm) * 100) / 100
                : Math.round(p.hedgeFillCostPm * 100) / 100;
              const totalCostHedge = Math.round((kalCostR + pmCostR) * 100) / 100;
              const payout = p.initialShares;
              const realizedPnl = Math.round((payout - totalCostHedge) * 100) / 100;
              console.log(
                `\n[HEDGE] ${name} resolved! initialCost=$${p.initialCost.toFixed(2)}` +
                ` hedgeCost=$${p.hedgeFillCost.toFixed(2)} kalFees=$${p.kalFees.toFixed(2)}` +
                ` total=$${totalCostHedge.toFixed(2)} payout=$${payout.toFixed(2)} P&L=$${realizedPnl.toFixed(2)}`
              );
              const pmFillPriceR = isPmInitial
                ? p.pmCostBasis
                : (p.hedgeFillCostPm > 0 ? Math.round((p.hedgeFillCostPm / p.initialShares) * 100) / 100 : 0);
              resolveArbTrade(p.kalLeg.ticker, {
                status: "resolved",
                resolvedTs: new Date().toISOString(),
                resolutionMethod: "hedge-complete",
                totalCost: totalCostHedge,
                hedgeCost: p.hedgeFillCost,
                kalFees: p.kalFees,
                realizedPnl,
                initialExchange: p.heldExchange,
                kalFillPrice: kalCostR > 0
                  ? Math.round(((kalCostR - p.kalFees) / p.initialShares) * 100) / 100
                  : 0,
                kalCost: kalCostR,
                pmFillPrice: pmFillPriceR,
                pmCost: pmCostR,
              }, p.tradeId);
              // Fire-and-forget: audit Kalshi fills for untracked buys (race condition detection)
              postResolutionFillAudit(p.kalLeg.ticker, p.tradeId).catch(() => {});
            } else {
              // Position resolved without hedge (market settled while unhedged).
              // The settlement path in runHedgeCycle already called resolveArbTrade
              // with correct P&L. Just log removal — don't double-resolve.
              console.log(`\n[HEDGE] ${name} cleared (settled without hedge).`);
            }
            const resolvedTokenId = p.pmLeg.tokenId;
            const resolvedEntry = watchlist.find(
              e => e.pm1.tokenId === resolvedTokenId || e.pm2.tokenId === resolvedTokenId
            );
            if (resolvedEntry) {
              sessionSkipSet.add(resolvedEntry.matchCode);
            }
            // Orphan cleanup: cancel any remaining orders for this resolved position
            for (const [oid, ho] of hs.activeOrders) {
              try {
                if (ho.exchange === "pm") cancelPmOrder(oid, DRY_RUN).catch(() => {});
                else cancelKalshiOrder(oid, DRY_RUN).catch(() => {});
              } catch { /* best effort */ }
            }
            hs.activeOrders.clear();
            return false;
          }
          return true;
        });

        if (hedgeStates.length < beforeLen) {
          setAllHedgeStates(hedgeStates);
          saveHedgeStates(hedgeStates);
        }
      }
      // Fall through to normal arb scanning — don't block!
    }

    _step = "canc-monitor";
    // ── CANCELLATION MONITOR: detect scalar settlements & emergency-sell PM ──
    // Runs every 60s. Checks Kalshi market status for all open positions.
    // If a market settled as "scalar" (cancelled/voided), immediately sells PM tokens.
    try {
      await Promise.race([
        runCancellationMonitor(watchlist, hedgeStates, clobBase),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("canc-monitor-timeout-60s")), 60_000)),
      ]);
    } catch (err) {
      console.warn(`[CANC-MON] Monitor error: ${(err as Error).message}`);
    }

    // ── SHADOW COMPARE: periodic cost-basis audit ──
    if (cycle % 100 === 0) {
      try { maybeShadowCompare(loadArbTrades(), "2026-04-05"); } catch { /* best effort */ }
    }

    _step = "kal-prices";
    // ── 1. Refresh Kalshi prices: WS primary, REST every 30 cycles (~12s) ──
    // WS gives real-time best ask; REST is only needed for markets without WS data
    // or as a periodic fallback to catch any WS drift.
    let wsKalHits = 0;
    for (const e of watchlist) {
      const ws1Yes = getWsKalBestAsk(e.kal1.ticker, "yes");
      const ws1No  = getWsKalBestAsk(e.kal1.ticker, "no");
      const ws2Yes = getWsKalBestAsk(e.kal2.ticker, "yes");
      const ws2No  = getWsKalBestAsk(e.kal2.ticker, "no");
      if (ws1Yes !== null) { e.kal1.yesAsk = ws1Yes; wsKalHits++; }
      if (ws1No  !== null) { e.kal1.noAsk  = ws1No;  wsKalHits++; }
      if (ws2Yes !== null) { e.kal2.yesAsk = ws2Yes; wsKalHits++; }
      if (ws2No  !== null) { e.kal2.noAsk  = ws2No;  wsKalHits++; }
    }
    // Only call REST if WS is missing data for >50% of prices, or every 30 cycles
    const kalWsCoverage = wsKalHits / (watchlist.length * 4);
    const kalRefreshDue = Date.now() - _lastKalRestRefreshMs > KAL_REST_REFRESH_INTERVAL_MS;
    if (kalWsCoverage < 0.5 || kalRefreshDue) {
      _lastKalRestRefreshMs = Date.now();
      try {
        await Promise.race([
          refreshKalshiPrices(watchlist),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("kal-prices-timeout-30s")), 30_000)),
        ]);
      } catch (e) {
        console.warn(`[KAL-PRICES] refresh timed out: ${(e as Error).message} — using WS data only`);
      }
      // Re-overlay WS on top of REST (WS is more current)
      for (const e of watchlist) {
        const ws1Yes = getWsKalBestAsk(e.kal1.ticker, "yes");
        const ws1No  = getWsKalBestAsk(e.kal1.ticker, "no");
        const ws2Yes = getWsKalBestAsk(e.kal2.ticker, "yes");
        const ws2No  = getWsKalBestAsk(e.kal2.ticker, "no");
        if (ws1Yes !== null) e.kal1.yesAsk = ws1Yes;
        if (ws1No  !== null) e.kal1.noAsk  = ws1No;
        if (ws2Yes !== null) e.kal2.yesAsk = ws2Yes;
        if (ws2No  !== null) e.kal2.noAsk  = ws2No;
      }
    }

    _step = "pm-prices";
    // ── 2. Fetch PM prices + compute edges ────────────────────────────────
    let bestEdge = -Infinity;
    let bestEntry: WatchEntry | null = null;
    let bestDir: ArbDir = "A";
    let bestKalAsk = 0;
    let bestPmAsk = 0;

    const statusLines: string[] = [];

    // Build a set of matchCodes with active hedge positions — never arb these
    const hedgingMatchCodes = new Set<string>();
    for (const hs of hedgeStates) {
      const t = hs.position.kalLeg.ticker;
      for (const e of watchlist) {
        if (e.kal1.ticker === t || e.kal2.ticker === t) { hedgingMatchCodes.add(e.matchCode); break; }
      }
    }

    // ── Pre-fetch ALL PM prices: WS first, REST fallback ──────────────────────
    const activePairs = watchlist.filter(
      e => !sessionSkipSet.has(e.matchCode) && !hedgingMatchCodes.has(e.matchCode) &&
        !(abortCountMap.has(e.matchCode) && Date.now() < (abortCountMap.get(e.matchCode)!.cooldownUntil))
    );
    const pmPriceMap = new Map<string, number>();
    const restNeeded: { tid: string }[] = [];
    for (const e of activePairs) {
      const tids = [e.pm1.tokenId, e.pm2.tokenId];
      if (e.pm3) tids.push(e.pm3.tokenId);
      // Include NO tokens for soccer J/K/L dirs
      if (e.pm1.noTokenId) tids.push(e.pm1.noTokenId);
      if (e.pm2.noTokenId) tids.push(e.pm2.noTokenId);
      if (e.pm3?.noTokenId) tids.push(e.pm3.noTokenId);
      for (const tid of tids) {
        const wsPrice = getWsPmBestAsk(tid);
        if (wsPrice !== null) {
          pmPriceMap.set(tid, wsPrice);
        } else {
          restNeeded.push({ tid });
        }
      }
    }
    // REST fallback for tokens without WS data (with 3s timeout to prevent blocking).
    // IMPORTANT: cap at 40 tokens per cycle. When PM CLOB is slow, abandoned Promise.race
    // calls from prior cycles keep their rate-limiter slot reservations, pushing
    // nextAllowedAt minutes into the future. Capping restNeeded prevents queue runaway.
    // Also use a single batch (no loop) — one Promise.race per cycle, max 40 concurrent.
    if (restNeeded.length > 0) {
      const PM_REST_MAX = 40;
      const PM_PRICE_TIMEOUT_MS = 3_000;
      const batch = restNeeded.slice(0, PM_REST_MAX);
      try {
        const results = await Promise.race([
          Promise.all(batch.map(({ tid }) => fetchPmAskDirect(tid, clobBase).then(p => ({ tid, p })).catch(() => ({ tid, p: null as number | null })))),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("pm-prices-timeout")), PM_PRICE_TIMEOUT_MS)),
        ]);
        for (const { tid, p } of results) {
          if (p !== null) pmPriceMap.set(tid, p);
        }
      } catch {
        console.warn(`[POLL] PM price batch timed out (${PM_PRICE_TIMEOUT_MS / 1000}s) — using WS/cached data`);
      }
    }

    // Cumulative budgets for the watchlist scan — per-entry timeouts were capped
    // at 2s each, but with ~400 entries and PM CLOB congestion, sequential hits
    // could still burn 5+ min (observed pm-prices watchdog stalls). These caps
    // ensure the entire pm-prices step never exceeds a bounded time.
    const _pmPricesBudgetStart = Date.now();
    const PM_PRICES_BUDGET_MS = 8000;
    const COIN_FLIP_BUDGET_MS = 3000;
    let _coinFlipSpentMs = 0;
    let _pmPricesBudgetLogged = false;
    for (const entry of watchlist) {
      if (Date.now() - _pmPricesBudgetStart > PM_PRICES_BUDGET_MS) {
        if (!_pmPricesBudgetLogged) {
          console.warn(`[POLL] pm-prices budget exhausted (${PM_PRICES_BUDGET_MS}ms) — skipping remaining ${watchlist.length - watchlist.indexOf(entry)} entries this cycle`);
          _pmPricesBudgetLogged = true;
        }
        break;
      }
      if (sessionSkipSet.has(entry.matchCode)) {
        statusLines.push(`  ${entry.kal1.surname} vs ${entry.kal2.surname}  [session-skip]`);
        continue;
      }

      if (hedgingMatchCodes.has(entry.matchCode)) {
        statusLines.push(`  ${entry.kal1.surname} vs ${entry.kal2.surname}  [hedging]`);
        continue;
      }

      // Abort cooldown: skip match if it aborted 10+ times consecutively
      const abortInfo = abortCountMap.get(entry.matchCode);
      if (abortInfo && Date.now() < abortInfo.cooldownUntil) {
        const secsLeft = Math.ceil((abortInfo.cooldownUntil - Date.now()) / 1000);
        statusLines.push(`  ${entry.kal1.surname} vs ${entry.kal2.surname}  [abort-cooldown ${secsLeft}s]`);
        continue;
      }

      const lastAttempt = cooldownMap.get(entry.matchCode) ?? 0;
      // Also check per-ticker and per-slug cooldown — prevents firing same Kalshi market
      // or same PM market from different watchlist entries (e.g. GAME vs MAP entries)
      const kalTicker1Cd = kalTickerCooldown.get(entry.kal1.ticker) ?? 0;
      const kalTicker2Cd = kalTickerCooldown.get(entry.kal2.ticker) ?? 0;
      const kalTicker3Cd = entry.kal3 ? (kalTickerCooldown.get(entry.kal3.ticker) ?? 0) : 0;
      const pmSlugCd = pmSlugCooldown.get(entry.pmSlug) ?? 0;
      const onCooldown = Date.now() - lastAttempt < TRADE_COOLDOWN_MS ||
        Date.now() - kalTicker1Cd < TRADE_COOLDOWN_MS ||
        Date.now() - kalTicker2Cd < TRADE_COOLDOWN_MS ||
        (entry.kal3 && Date.now() - kalTicker3Cd < TRADE_COOLDOWN_MS) ||
        Date.now() - pmSlugCd < TRADE_COOLDOWN_MS;

      const pm1Ask = pmPriceMap.get(entry.pm1.tokenId) ?? null;
      const pm2Ask = pmPriceMap.get(entry.pm2.tokenId) ?? null;

      if (pm1Ask === null || pm2Ask === null) continue;

      // ── Coin-flip detection: PM asks ~50/50 → suspicious pricing, skip arb ──
      // If both asks are 48-52¢ the market is priced as a coin-flip.
      // Fetch bids via WS first, REST fallback if WS unavailable.
      {
        const isCoinFlipAsk = (ask: number) => ask >= 0.48 && ask <= 0.52;
        if (isCoinFlipAsk(pm1Ask) && isCoinFlipAsk(pm2Ask)) {
          let bid1 = getWsPmBestBid(entry.pm1.tokenId);
          let bid2 = getWsPmBestBid(entry.pm2.tokenId);
          // REST fallback for bids when WS has no data (parallel fetch).
          // 2s per-call + 3s cumulative cap: N × 2s sequential was the root cause of
          // 5+ min pm-prices watchdog stalls when many 50/50 markets + PM CLOB lag.
          if ((bid1 === null || bid2 === null) && _coinFlipSpentMs < COIN_FLIP_BUDGET_MS) {
            const _cfStart = Date.now();
            try {
              const [newBid1, newBid2] = await Promise.race([
                Promise.all([
                  bid1 === null ? fetchPmBidDirect(entry.pm1.tokenId, clobBase).catch(() => null) : Promise.resolve(bid1),
                  bid2 === null ? fetchPmBidDirect(entry.pm2.tokenId, clobBase).catch(() => null) : Promise.resolve(bid2),
                ]),
                new Promise<[null, null]>(resolve => setTimeout(() => resolve([null, null]), 2000)),
              ]);
              if (bid1 === null) bid1 = newBid1;
              if (bid2 === null) bid2 = newBid2;
            } catch { /* fall through with nulls */ }
            _coinFlipSpentMs += Date.now() - _cfStart;
          }
          if (!coinFlipWarned.has(entry.matchCode)) {
            coinFlipWarned.add(entry.matchCode);
            console.warn(
              `[COIN-FLIP] ${entry.kal1.surname} vs ${entry.kal2.surname} — ` +
              `PM pricing ~50/50 (asks: ${fmtPct(pm1Ask)}/${fmtPct(pm2Ask)}, ` +
              `bids: ${bid1 !== null ? fmtPct(bid1) : "?"}/${bid2 !== null ? fmtPct(bid2) : "?"}) ` +
              `KAL: ${fmtPct(entry.kal1.yesAsk)}/${fmtPct(entry.kal2.yesAsk)} — ` +
              `check manually! Skipping arb.`
            );
          }
          continue;
        }
      }

      // Realistic edge helper: if WS orderbook available, compute avg fill for min shares.
      // Returns actual edge (may be negative), or null if WS data is unavailable.
      // IMPORTANT: null = "no WS data, trust listing price". A numeric return = "WS has real depth data".
      const realisticEdge = (ticker: string, side: "yes" | "no", pmAskVal: number, minShares: number): number | null => {
        const book = getWsKalBook(ticker);
        if (!book) return null;  // no WS data → can't verify, let listing price stand
        const askLevels = side === "yes" ? deriveYesAsks(book.no) : deriveNoAsks(book.yes);
        if (askLevels.length === 0) return -1;  // WS confirms zero depth → kill the edge
        const limitCents = Math.max(1, Math.min(99, Math.floor((1 - pmAskVal - MIN_EDGE) * 100)));
        const sweep = sweepKalshiDepth(askLevels, minShares, limitCents);
        if (!sweep || sweep.totalQty < minShares) return -1;  // insufficient depth at profitable prices
        const avgPrice = sweep.avgPrice / 100;
        return 1 - avgPrice - pmAskVal - estimateFees(avgPrice, pmAskVal);
      };
      const pmMin1 = Math.max(entry.pm1.minSize ?? 5, pm1Ask > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pm1Ask) : 5);
      const pmMin2 = Math.max(entry.pm2.minSize ?? 5, pm2Ask > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / pm2Ask) : 5);

      let edges: { dir: ArbDir; edge: number; kalAsk: number; pmAsk: number }[];

      if (entry.is3Way && entry.kal3 && entry.pm3) {
        // ── Soccer 3-way: 12 directions ──────────────────────────────────────
        const pm3Ask = pmPriceMap.get(entry.pm3.tokenId) ?? null;
        if (pm3Ask === null) continue;
        const KH = entry.kal1.yesAsk, KA = entry.kal2.yesAsk, KD = entry.kal3.yesAsk;
        const KH_no = entry.kal1.noAsk, KA_no = entry.kal2.noAsk, KD_no = entry.kal3.noAsk;
        const PH = pm1Ask, PA = pm2Ask, PD = pm3Ask;
        const pmMin3 = Math.max(entry.pm3.minSize ?? 5, PD > 0 ? Math.ceil(PM_MARKETABLE_MIN_VALUE / PD) : 5);

        // 3-leg YES combos (A-F): buy YES on all 3 outcomes across platforms
        const feeA3 = estimateFees(KH, 0) + estimateFees(KD, 0);
        const feeB3 = estimateFees(KH, 0) + estimateFees(KA, 0);
        const feeC3 = estimateFees(KD, 0) + estimateFees(KA, 0);
        let eA = 1 - KH - KD - PA - feeA3;
        let eB = 1 - KH - PD - KA - feeB3;
        let eC = 1 - PH - KD - KA - feeC3;
        let eD = 1 - KH - PD - PA;
        let eE = 1 - PH - KD - PA;
        let eF = 1 - PH - PD - KA;
        eD -= estimateFees(KH, 0); eE -= estimateFees(KD, 0); eF -= estimateFees(KA, 0);

        // 2-leg NO combos (G-L). Per-leg PM fee rate from feeSchedule.
        const pm1Rate3 = pmFeeRateFor(entry.pm1);
        const pm2Rate3 = pmFeeRateFor(entry.pm2);
        const pm3Rate3 = pmFeeRateFor(entry.pm3);
        let eG = 1 - KH_no - PH - estimateFees(KH_no, PH, pm1Rate3);
        let eH = 1 - KD_no - PD - estimateFees(KD_no, PD, pm3Rate3);
        let eI = 1 - KA_no - PA - estimateFees(KA_no, PA, pm2Rate3);
        const PH_no = entry.pm1.noTokenId ? (pmPriceMap.get(entry.pm1.noTokenId) ?? null) : null;
        const PA_no = entry.pm2.noTokenId ? (pmPriceMap.get(entry.pm2.noTokenId) ?? null) : null;
        const PD_no = entry.pm3.noTokenId ? (pmPriceMap.get(entry.pm3.noTokenId) ?? null) : null;
        let eJ = PH_no !== null ? 1 - KH - PH_no - estimateFees(KH, 0) : -Infinity;
        let eK = PD_no !== null ? 1 - KD - PD_no - estimateFees(KD, 0) : -Infinity;
        let eL = PA_no !== null ? 1 - KA - PA_no - estimateFees(KA, 0) : -Infinity;

        if (eG > 0) { const re = realisticEdge(entry.kal1.ticker, "no", PH, pmMin1); if (re !== null) eG = re; }
        if (eH > 0) { const re = realisticEdge(entry.kal3.ticker, "no", PD, pmMin3); if (re !== null) eH = re; }
        if (eI > 0) { const re = realisticEdge(entry.kal2.ticker, "no", PA, pmMin2); if (re !== null) eI = re; }
        if (eJ > 0 && PH_no !== null) { const re = realisticEdge(entry.kal1.ticker, "yes", PH_no, pmMin1); if (re !== null) eJ = re; }
        if (eK > 0 && PD_no !== null) { const re = realisticEdge(entry.kal3.ticker, "yes", PD_no, pmMin3); if (re !== null) eK = re; }
        if (eL > 0 && PA_no !== null) { const re = realisticEdge(entry.kal2.ticker, "yes", PA_no, pmMin2); if (re !== null) eL = re; }

        edges = [
          { dir: "A", edge: eA, kalAsk: KH, pmAsk: PA },
          { dir: "B", edge: eB, kalAsk: KH, pmAsk: PD },
          { dir: "C", edge: eC, kalAsk: KD, pmAsk: PH },
          { dir: "D", edge: eD, kalAsk: KH, pmAsk: PA },
          { dir: "E", edge: eE, kalAsk: KD, pmAsk: PA },
          { dir: "F", edge: eF, kalAsk: KA, pmAsk: PH },
          { dir: "G", edge: eG, kalAsk: KH_no, pmAsk: PH },
          { dir: "H", edge: eH, kalAsk: KD_no, pmAsk: PD },
          { dir: "I", edge: eI, kalAsk: KA_no, pmAsk: PA },
          { dir: "J", edge: eJ, kalAsk: KH, pmAsk: PH_no ?? 0 },
          { dir: "K", edge: eK, kalAsk: KD, pmAsk: PD_no ?? 0 },
          { dir: "L", edge: eL, kalAsk: KA, pmAsk: PA_no ?? 0 },
        ];

        const bestLocalEdge = edges.reduce((a, b) => b.edge > a.edge ? b : a);
        const bestLocal = bestLocalEdge.edge;
        const coolStr = onCooldown ? " [cooldown]" : "";

        const best3Leg = Math.max(eA, eB, eC, eD, eE, eF);
        statusLines.push(
          `  ${entry.kal1.surname} vs ${entry.kal2.surname} [3WAY]` +
          `  3leg:${fmtPct(best3Leg)}  G:${fmtPct(eG)} H:${fmtPct(eH)} I:${fmtPct(eI)}` +
          `  J:${fmtPct(eJ)} K:${fmtPct(eK)} L:${fmtPct(eL)}` +
          (bestLocal > 0 ? " *** ARB ***" : "") + coolStr
        );

        const executableEdges = edges;
        const bestExec = executableEdges.reduce((a, b) => b.edge > a.edge ? b : a);
        if (!onCooldown && bestExec.edge > bestEdge) {
          bestEdge = bestExec.edge;
          bestEntry = entry;
          bestDir = bestExec.dir;
          bestKalAsk = bestExec.kalAsk;
          bestPmAsk = bestExec.pmAsk;
        }
      } else if (entry.isBinary) {
        const rawEdgeA = 1 - entry.kal1.yesAsk - pm2Ask;
        const rawEdgeC = 1 - entry.kal1.noAsk - pm1Ask;
        // Per-leg PM fee rate (from gamma feeSchedule.rate captured at discovery)
        const pm1Rate = pmFeeRateFor(entry.pm1);
        const pm2Rate = pmFeeRateFor(entry.pm2);
        let edgeA = rawEdgeA - estimateFees(entry.kal1.yesAsk, pm2Ask, pm2Rate);
        let edgeC = rawEdgeC - estimateFees(entry.kal1.noAsk, pm1Ask, pm1Rate);

        if (edgeA > 0) { const re = realisticEdge(entry.kal1.ticker, "yes", pm2Ask, pmMin2); if (re !== null) edgeA = re; }
        if (edgeC > 0) { const re = realisticEdge(entry.kal1.ticker, "no", pm1Ask, pmMin1); if (re !== null) edgeC = re; }

        edges = [
          { dir: "A", edge: edgeA, kalAsk: entry.kal1.yesAsk, pmAsk: pm2Ask },
          { dir: "C", edge: edgeC, kalAsk: entry.kal1.noAsk,  pmAsk: pm1Ask },
        ];
        const bestLocalEdge = edges.reduce((a, b) => b.edge > a.edge ? b : a);
        const bestLocal = bestLocalEdge.edge;
        const coolStr = onCooldown ? " [cooldown]" : "";

        statusLines.push(
          `  [BIN] ${entry.kal1.surname} vs ${entry.kal2.surname} (${entry.pmSlug.split("-").slice(-3).join("-")})` +
          `  A:${fmtPct(edgeA)}  C:${fmtPct(edgeC)}` +
          (bestLocal > 0 ? " *** ARB ***" : "") + coolStr
        );

        if (!onCooldown && bestLocal > bestEdge) {
          bestEdge = bestLocal;
          bestEntry = entry;
          bestDir = bestLocalEdge.dir;
          bestKalAsk = bestLocalEdge.kalAsk;
          bestPmAsk = bestLocalEdge.pmAsk;
        }

      } else {
        // ── Standard 2-way: tennis/NBA/esports (4 directions A-D) ──────────
        const rawEdgeA = 1 - entry.kal1.yesAsk - pm2Ask;
        const rawEdgeB = 1 - entry.kal2.yesAsk - pm1Ask;
        const rawEdgeC = 1 - entry.kal1.noAsk - pm1Ask;
        const rawEdgeD = 1 - entry.kal2.noAsk - pm2Ask;
        // Per-leg PM fee rate (from gamma feeSchedule.rate at discovery)
        const pm1Rate = pmFeeRateFor(entry.pm1);
        const pm2Rate = pmFeeRateFor(entry.pm2);
        let edgeA = rawEdgeA - estimateFees(entry.kal1.yesAsk, pm2Ask, pm2Rate);
        let edgeB = rawEdgeB - estimateFees(entry.kal2.yesAsk, pm1Ask, pm1Rate);
        let edgeC = rawEdgeC - estimateFees(entry.kal1.noAsk, pm1Ask, pm1Rate);
        let edgeD = rawEdgeD - estimateFees(entry.kal2.noAsk, pm2Ask, pm2Rate);

        if (edgeA > 0) { const re = realisticEdge(entry.kal1.ticker, "yes", pm2Ask, pmMin2); if (re !== null) edgeA = re; }
        if (edgeB > 0) { const re = realisticEdge(entry.kal2.ticker, "yes", pm1Ask, pmMin1); if (re !== null) edgeB = re; }
        if (edgeC > 0) { const re = realisticEdge(entry.kal1.ticker, "no", pm1Ask, pmMin1); if (re !== null) edgeC = re; }
        if (edgeD > 0) { const re = realisticEdge(entry.kal2.ticker, "no", pm2Ask, pmMin2); if (re !== null) edgeD = re; }

        edges = [
          { dir: "A", edge: edgeA, kalAsk: entry.kal1.yesAsk, pmAsk: pm2Ask },
          { dir: "B", edge: edgeB, kalAsk: entry.kal2.yesAsk, pmAsk: pm1Ask },
          { dir: "C", edge: edgeC, kalAsk: entry.kal1.noAsk,  pmAsk: pm1Ask },
          { dir: "D", edge: edgeD, kalAsk: entry.kal2.noAsk,  pmAsk: pm2Ask },
        ];
        const bestLocalEdge = edges.reduce((a, b) => b.edge > a.edge ? b : a);
        const bestLocal = bestLocalEdge.edge;
        const coolStr = onCooldown ? " [cooldown]" : "";

        statusLines.push(
          `  ${entry.kal1.surname} vs ${entry.kal2.surname}` +
          `  A:${fmtPct(edgeA)}  B:${fmtPct(edgeB)}  C:${fmtPct(edgeC)}  D:${fmtPct(edgeD)}` +
          (bestLocal > 0 ? " *** ARB ***" : "") + coolStr
        );

        if (!onCooldown && bestLocal > bestEdge) {
          bestEdge = bestLocal;
          bestEntry = entry;
          bestDir = bestLocalEdge.dir;
          bestKalAsk = bestLocalEdge.kalAsk;
          bestPmAsk = bestLocalEdge.pmAsk;
        }
      }
    }

    // ── 2b. Speculative orderbook pre-cache for top candidate ──────────────
    // Skip if WS already has live data for this ticker
    if (bestEntry && bestEdge > MIN_EDGE * 0.5) {
      const targetTicker = (bestDir === "A" || bestDir === "C") ? bestEntry.kal1.ticker : bestEntry.kal2.ticker;
      if (!getWsKalBook(targetTicker)) {
        const cached = kalBookCache.get(targetTicker);
        if (!cached || Date.now() - cached.ts > BOOK_CACHE_TTL) {
          fetchKalshiOrderbook(targetTicker)
            .then(book => kalBookCache.set(targetTicker, { book, ts: Date.now() }))
            .catch(() => {}); // non-critical, fire-and-forget
        }
      }
    }

    _step = "status";
    // ── 3. Status line ─────────────────────────────────────────────────────
    process.stdout.write(
      `\r${ts()} cycle=${cycle}  best=${fmtPct(bestEdge)}` +
      (bestEntry ? `  [${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}]` : "") +
      "   "
    );

    if (cycle % 1 === 0) {
      // Only show matches with positive edge or special status (hedging, cooldown, etc.)
      const interestingLines = statusLines.filter(l =>
        l.includes("*** ARB ***") || l.includes("[hedging]") ||
        l.includes("[cooldown]") || l.includes("[abort-cooldown") ||
        l.includes("[session-skip]")
      );
      // Always print cycle header so terminal shows progress
      console.log(`\n[CYCLE ${cycle}] ${ts()}  (${statusLines.length} matches, ${interestingLines.length} notable)  best=${fmtPct(bestEdge)}`);
      if (interestingLines.length > 0) {
        interestingLines.forEach((l) => console.log(l));
      }
      // WS diagnostics every 50 cycles
      if (cycle % 50 === 0) {
        const pmWsTokens = wsPmBooks.size;
        let pmWsFresh = 0, pmWsStale = 0, pmWsWithAsks = 0;
        for (const [, b] of wsPmBooks) {
          if (Date.now() - b.ts < 30_000) { pmWsFresh++; if (b.asks.size > 0) pmWsWithAsks++; }
          else pmWsStale++;
        }
        const kalWsTickers = wsKalBooks.size;
        let kalWsFresh = 0;
        for (const [, b] of wsKalBooks) { if (Date.now() - b.ts < 600_000) kalWsFresh++; }
        const _pmWsReady = getPmWsReady();
        const _pmWsSubs = getPmWsSubs();
        console.log(`[WS DIAG] KAL: ${kalWsFresh}/${kalWsTickers} fresh | PM: ${pmWsFresh}/${pmWsTokens} fresh, ${pmWsWithAsks} with asks, ${pmWsStale} stale | PM connected=${_pmWsReady} subs=${_pmWsSubs.size}`);
      }
    }

    // ── 4. Execute if edge ≥ threshold ─────────────────────────────────────
    if (bestEntry && bestEdge >= MIN_EDGE) {
      console.log(); // newline from \r
      console.log(
        `[ARB FOUND] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}` +
        `  dir=${bestDir}  edge=${fmtPct(bestEdge, 2)}` +
        `  kalTicker=${(bestDir === "A" || bestDir === "C") ? bestEntry.kal1.ticker : bestEntry.kal2.ticker}` +
        `  pmSlug=${bestEntry.pmSlug}` +
        `  kalAsk=${fmtPct(bestKalAsk)}  pmAsk=${fmtPct(bestPmAsk)}`
      );

      // Helper: log a skipped-arb metric so it shows on the dashboard's missed-opps
      const logSkippedArb = (reason: string) => {
        const m: ExecMetric = {
          id: `exec-${Date.now()}`, ts: new Date().toISOString(),
          match: `${bestEntry!.kal1.surname} vs ${bestEntry!.kal2.surname}`,
          dir: bestDir, edge: bestEdge, shares: Math.floor(TRADE_USD / (bestKalAsk + bestPmAsk)),
          firstLeg: "pm", outcome: "abort-safety", failReason: reason,
          firstLegFilled: 0, secondLegFilled: 0,
          expectedKalPrice: bestKalAsk, expectedPmPrice: bestPmAsk,
          totalMs: 0, firstLegOrderMs: 0, firstLegConfirmMs: 0,
          secondLegOrderMs: 0, secondLegConfirmMs: 0, bookFetchMs: 0,
        };
        appendMetric(m);
      };

      // ── Circuit breaker checks ──────────────────────────────────────────
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn(`[CIRCUIT BREAKER] ${consecutiveErrors} consecutive errors — pausing new arbs until next cycle without error.`);
        logSkippedArb("circuit-breaker-errors");
      } else if (hedgeStates.length >= MAX_HEDGE_POSITIONS) {
        console.warn(`[CIRCUIT BREAKER] ${hedgeStates.length} open hedge positions (max ${MAX_HEDGE_POSITIONS}) — resolve existing before opening new.`);
        logSkippedArb("max-hedge-positions");
      } else if (isPmServiceDown()) {
        const pmDownUntil = getPmServiceDownUntil();
        const waitSec = Math.ceil((pmDownUntil - Date.now()) / 1000);
        console.warn(`[ARB SKIP] PM service down — retrying in ~${waitSec}s`);
        logSkippedArb("pm-service-down");
      } else if (inflight.has(bestEntry.matchCode)) {
        console.warn(`[ARB SKIP] ${bestEntry.matchCode} already in-flight.`);
        logSkippedArb("already-inflight");
      } else if (isLateGame(bestEntry.matchCode)) {
        const ls = getMatchState(bestEntry.matchCode);
        console.warn(`[ARB SKIP] ${bestEntry.matchCode} — late game (${ls?.detail ?? "?"}, ${ls?.completionPct?.toFixed(0) ?? "?"}% complete, ${ls?.homeScore ?? "?"}-${ls?.awayScore ?? "?"})`);
        logSkippedArb("late-game");
      } else if (isMatchCancelled(bestEntry.matchCode)) {
        const ls = getMatchState(bestEntry.matchCode);
        console.warn(`[ARB SKIP] ${bestEntry.matchCode} — ${ls?.status?.toUpperCase() ?? "CANCELLED"} (${ls?.detail ?? "?"}). Scalar settlement risk.`);
        logSkippedArb("match-cancelled");
      } else if (process.env.LICENSE_SERVER && !isLicenseValid()) {
        console.warn(`[ARB SKIP] License invalid — skipping new arbs until revalidated`);
        logSkippedArb("license-invalid");
      } else {

      // Mark cooldown BEFORE executing — prevents re-entry during execution
      cooldownMap.set(bestEntry.matchCode, Date.now());
      kalTickerCooldown.set(bestEntry.kal1.ticker, Date.now());
      kalTickerCooldown.set(bestEntry.kal2.ticker, Date.now());
      if (bestEntry.kal3) kalTickerCooldown.set(bestEntry.kal3.ticker, Date.now());
      pmSlugCooldown.set(bestEntry.pmSlug, Date.now());
      inflight.add(bestEntry.matchCode);

      // ── Start continuous book tracker (20s, 500ms intervals) ────────────
      {
        const trackKalTicker = (bestDir === "A" || bestDir === "C") ? bestEntry.kal1.ticker
          : (bestDir === "H" || bestDir === "K") ? bestEntry.kal3!.ticker
          : bestEntry.kal2.ticker;
        const trackPmLeg = (bestDir === "A" || bestDir === "D") ? bestEntry.pm2
          : (bestDir === "H") ? bestEntry.pm3!
          : (bestDir === "K") ? bestEntry.pm3!
          : bestEntry.pm1;
        const trackTs = Date.now();
        startBookTracker(trackKalTicker, trackPmLeg.tokenId, {
          match: `${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}`,
          dir: bestDir,
          pmOutcome: trackPmLeg.outcome,
          kalAsk: bestKalAsk,
          pmAsk: bestPmAsk,
          edge: bestEdge,
          tradeTs: trackTs,
        });
      }

      try {
        // Dispatch to 3-leg executor for soccer dirs A-F, 2-leg for everything else
        const is3LegDir = bestEntry.is3Way && ["A", "B", "C", "D", "E", "F"].includes(bestDir);
        const { sessionSkip, unhedged, abortReason } = is3LegDir
          ? await executeArb3Leg(bestEntry, bestDir, bestEdge)
          : await Promise.race([
              executeArb(bestEntry, bestDir, bestKalAsk, bestPmAsk, bestEdge),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error("executeArb-timeout-40s")), 40_000)),
            ]);
        consecutiveErrors = 0; // reset on successful execution

        // Track consecutive aborts per match for cooldown
        // Soft aborts (depth/edge insufficient) don't count — the opportunity is real,
        // just waiting for liquidity. Only hard aborts (order failures) trigger cooldown.
        if (!sessionSkip && !unhedged) {
          if (abortReason === "soft") {
            // Soft abort (depth/edge insufficient) — short cooldown on the FIRST abort.
            // Depth shortage is usually persistent over several seconds, so repeatedly
            // re-running the full depth check (incl. REST book fallback when WS is
            // stale) just wastes rate-limiter budget. 15s gives the book time to move
            // without spamming; 3+ consecutive aborts escalates to 60s.
            const sc = abortCountMap.get(bestEntry.matchCode) ?? { count: 0, cooldownUntil: 0 };
            sc.count++;
            if (sc.count >= 3) {
              sc.cooldownUntil = Date.now() + 60_000;
              console.log(`[SOFT COOLDOWN] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname} — ${sc.count} soft aborts, pausing 60s`);
              sc.count = 0;
            } else {
              sc.cooldownUntil = Date.now() + 15_000;
            }
            abortCountMap.set(bestEntry.matchCode, sc);
          } else {
            // Hard abort (order failed, IOC no fill, etc.) — increment counter
            const ac = abortCountMap.get(bestEntry.matchCode) ?? { count: 0, cooldownUntil: 0 };
            ac.count++;
            if (ac.count >= ABORT_COOLDOWN_THRESHOLD) {
              ac.cooldownUntil = Date.now() + ABORT_COOLDOWN_MS;
              console.log(`[ABORT COOLDOWN] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname} — ${ac.count} consecutive hard aborts, cooling down ${ABORT_COOLDOWN_MS / 1000}s`);
              ac.count = 0; // reset so it can trigger again after cooldown
            }
            abortCountMap.set(bestEntry.matchCode, ac);
          }
        } else {
          // Success (filled or hedge) — reset abort counter
          abortCountMap.delete(bestEntry.matchCode);
        }

        if (sessionSkip) {
          sessionSkipSet.add(bestEntry.matchCode);
          console.log(
            `[SESSION SKIP] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname}` +
            ` — removed from watchlist for this session.`
          );
        }
        if (unhedged) {
          // Delay PM orders by 10s: the "failed" PM FAK may still be settling on-chain.
          // PM delayed orders confirm in ~7s. 10s gives margin. After that, it's dead.
          const pmDelay = unhedged.heldExchange === "kal" ? Date.now() + 10_000 : 0;
          const newHs: HedgeState = { position: unhedged, activeOrders: new Map(), kalNextRetryAt: 0, pmNextRetryAt: pmDelay, pmOnlyCycles: 0 };
          hedgeStates.push(newHs);
          setAllHedgeStates(hedgeStates);
          saveHedgeStates(hedgeStates);
          console.log(
            `[HEDGE MODE] Entering hedge for ${unhedged.sharesHeld} unhedged ${unhedged.heldExchange.toUpperCase()} shares.` +
            ` Now hedging ${hedgeStates.length} position(s).`
          );
        }
      } catch (err) {
        consecutiveErrors++;
        const msg = (err as Error).message ?? String(err);
        console.error(`[EXECUTE] Error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${msg}`);
        // If the 30s timeout fired, executeArb may still be running in background
        // and could place orders. Session-skip the match to prevent a duplicate trade.
        if (msg.includes("timeout")) {
          sessionSkipSet.add(bestEntry.matchCode);
          kalTickerCooldown.set(bestEntry.kal1.ticker, Date.now() + 300_000); // 5 min cooldown
          kalTickerCooldown.set(bestEntry.kal2.ticker, Date.now() + 300_000);
          console.warn(`[SESSION SKIP] ${bestEntry.kal1.surname} vs ${bestEntry.kal2.surname} — execution timeout, session-skipped to prevent duplicate.`);
        }
      } finally {
        inflight.delete(bestEntry.matchCode);
        // Safety: ensure _activePendingFillId is cleared even if executeArb throws.
        // If logArbTrade already cleared it, this is a no-op.
        if (_activePendingFillId) {
          console.warn(`[PENDING] Clearing orphaned pending fill ${_activePendingFillId} after execution exit.`);
          setActivePendingFillId(null);
        }
      }
      } // end circuit breaker / inflight / pm-down checks
    }

    _step = "sleep";
    // ── 5. Wait — yield event loop, then immediately scan again ─────────────
    // With WS feeds, poll cycles are pure Map reads (no API calls).
    // POLL_INTERVAL_MS=0 → max speed; >0 → throttle to save CPU on slower machines.
    const elapsed = Date.now() - cycleStart;
    if (elapsed > 30_000) {
      console.warn(`[SLOW CYCLE] cycle=${cycle} took ${(elapsed / 1000).toFixed(1)}s (step=${_step})`);
    }
    const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
    if (wait > 0) await sleep(wait);
    else await sleep(0); // yield to event loop even at max speed (process WS messages)

    } catch (cycleErr) {
      console.error(`[CYCLE ERROR] cycle=${cycle} step=${_step}: ${(cycleErr as Error).message}`);
      await sleep(2000); // prevent tight error loop
    } finally {
      clearTimeout(watchdog);
      clearTimeout(watchdogKill);
    }
  }
}

// ─── Hardcoded watchlist (for manual market overrides) ────────────────────────
// Set HARDCODED_MARKETS=true in env to skip auto-discovery and use these entries.

export function buildHardcodedWatchlist(): WatchEntry[] {
  return [
    // ── ATP Dubai (Feb 26) ──────────────────────────────────────────────────────
    {
      matchCode: "KXATPMATCH-26FEB26MEDBRO",
      pmSlug: "atp-medvede-brooksb-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26MEDBRO-MED", surname: "Medvedev", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26MEDBRO-BRO", surname: "Brooksby", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Daniil Medvedev", tokenId: "113206786303297881608970499012659120457525717582590216312541942529377809611966", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Jenson Brooksby", tokenId: "101976526833981232003632259338174330180735889970494312719492559490304236617519", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    // ── ATP Chile Open / Santiago (Feb 26) ─────────────────────────────────────
    {
      matchCode: "KXATPMATCH-26FEB26TABTIR",
      pmSlug: "atp-tabilo-tirante-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26TABTIR-TAB", surname: "Tabilo",  yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26TABTIR-TIR", surname: "Tirante", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Tabilo",  tokenId: "82818940471320467528514137652191339972553013214088546695527975556632596923193", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Tirante", tokenId: "98932166230278072956703958463978520264014876362813674159983891547938572291381", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB26GARBAE",
      pmSlug: "atp-garin-baez-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26GARBAE-GAR", surname: "Garin", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26GARBAE-BAE", surname: "Baez",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Garin", tokenId: "87428557817459622126102483113314349615321881660279693258259393966823791567083", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Baez",  tokenId: "94840674556228017616238578270953605850206684098651364351071360314799299619963", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB26VALNAV",
      pmSlug: "atp-vallejo-nava-2026-02-26",
      date: "2026-02-26",
      kal1: { ticker: "KXATPMATCH-26FEB26VALNAV-VAL", surname: "Vallejo", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB26VALNAV-NAV", surname: "Nava",    yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Vallejo", tokenId: "61551056532064752059084036941305269272842570343246679144920545317921480517521", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Nava",    tokenId: "28494910870856779759459720911747991186149206227651575913131743043404396897428", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    // ── ATP Chile Open / Santiago (Feb 25) ─────────────────────────────────────
    {
      matchCode: "KXATPMATCH-26FEB25NAVDAR",
      pmSlug: "atp-navone-darderi-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25NAVDAR-NAV", surname: "Navone",  yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25NAVDAR-DAR", surname: "Darderi", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Navone",  tokenId: "97806468779831506400288444206342037762847206817292250507255754725943808224964",  tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Darderi", tokenId: "111563593835318529396659864108225431741509763078104041651920403186940204978836", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25PRIGAU",
      pmSlug: "atp-prizmic-gaubas-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25PRIGAU-PRI", surname: "Prizmic", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25PRIGAU-GAU", surname: "Gaubas",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Prizmic", tokenId: "76530282059250612204463640032266790512445126876916631348635403368539115982722", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Gaubas",  tokenId: "96521385161593719946137010044968935260064081562017387310780021038817524963599", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    // ── ATP Acapulco / Mexican Open (Feb 25) ────────────────────────────────────
    {
      matchCode: "KXATPMATCH-26FEB25VACMON",
      pmSlug: "atp-vachero-monfils-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25VACMON-VAC", surname: "Vacherot", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25VACMON-MON", surname: "Monfils",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Vacherot", tokenId: "90083060630827471117356730814282760133869677583763889673168308321484551999774", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Monfils",  tokenId: "86223060355109810452681408370268513201714459389590666057459583092096870940545", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25YIBSHI",
      pmSlug: "atp-wu-shimabu-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25YIBSHI-YIB", surname: "Wu",          yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25YIBSHI-SHI", surname: "Shimabukuro", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Wu",          tokenId: "96288158559263840660615675328832504070855086893216990813138464886329489948815", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Shimabukuro", tokenId: "27032557020981255739444304291623642884249506868555118351577307494268390226250", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25BELDAV",
      pmSlug: "atp-bellucc-fokina-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25BELDAV-BEL", surname: "Bellucci", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25BELDAV-DAV", surname: "Fokina",   yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Bellucci", tokenId: "12459933346613519023934266987678690842755915855056146291471792667928931967481",  tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Fokina",   tokenId: "110499694312748878099806383141663262195441842032459215903347350158785438449026", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25TIAKOV",
      pmSlug: "atp-tiafoe-kovacev-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25TIAKOV-TIA", surname: "Tiafoe",    yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25TIAKOV-KOV", surname: "Kovacevic", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Tiafoe",    tokenId: "36833949577575507820604813690728045932156690543180418106361277204699097125630", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Kovacevic", tokenId: "73605248070267937520547771129104423883895582884291557222394291537324524696428", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25ZVEKEC",
      pmSlug: "atp-zverev-kecmano-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25ZVEKEC-ZVE", surname: "Zverev",      yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25ZVEKEC-KEC", surname: "Kecmanovic",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Zverev",      tokenId: "29496190083913591097391689128901050944673515064487623921477580917702820283572", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Kecmanovic",  tokenId: "32118261299848027918527121992933669989077108199009144263671100442012461285952", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25SVRCOB",
      pmSlug: "atp-svrcina-cobolli-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25SVRCOB-SVR", surname: "Svrcina", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25SVRCOB-COB", surname: "Cobolli", yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Svrcina", tokenId: "1206430047564242078206114643518552980143153855523975824086199830532553821860",  tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Cobolli", tokenId: "94279882850706942433632169558076712526334448556834849592070794870165592892163", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25ATMJOD",
      pmSlug: "atp-atmane-jodar-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25ATMJOD-ATM", surname: "Atmane", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25ATMJOD-JOD", surname: "Jodar",  yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Atmane", tokenId: "96478640965233294631038510926965290147012068384370820202475820444312161749071", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Jodar",  tokenId: "68153395529339811196433588424367739358750443558486789122752895070458394497022", tickSize: 0.01, minSize: 5, negRisk: false },
    },
    {
      matchCode: "KXATPMATCH-26FEB25NAKKYP",
      pmSlug: "atp-nakashi-kypson-2026-02-25",
      date: "2026-02-25",
      kal1: { ticker: "KXATPMATCH-26FEB25NAKKYP-NAK", surname: "Nakashima", yesAsk: 0.50, noAsk: 1 },
      kal2: { ticker: "KXATPMATCH-26FEB25NAKKYP-KYP", surname: "Kypson",    yesAsk: 0.50, noAsk: 1 },
      pm1: { outcome: "Nakashima", tokenId: "20961844571729282455683292831901518658014872911109135390035187625925449884425", tickSize: 0.01, minSize: 5, negRisk: false },
      pm2: { outcome: "Kypson",    tokenId: "28613583995527822989836564951821307884519023381859430125974123117617863586322", tickSize: 0.01, minSize: 5, negRisk: false },
    },
  ];
}
