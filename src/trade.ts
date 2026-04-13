import dotenv from "dotenv";
import { fetchKalshiSnapshot } from "./kalshi.js";
import { fetchPolymarketSnapshot } from "./polymarket.js";
import { buildKalshiOrder, buildKalshiOrderFromCount, placeKalshiOrder } from "./kalshiTrade.js";
import {
  placePolymarketOrder,
  getPolymarketFeeRateBps,
  getPolymarketTradeInfo
} from "./polymarketTrade.js";
import { getKalshiImpliedAskLiquidity, getPolymarketAskLiquidity } from "./liquidity.js";
import { OrderType } from "@polymarket/clob-client";
import { MarketPairConfig, AutoPairConfig } from "./types.js";
import { buildAutoPairs } from "./autoPairs.js";
import { normalizeBase64Secret, readPolyApiCredsFromEnv } from "./polyAuth.js";
import fs from "fs";
import path from "path";

dotenv.config();

type ConfigFile = {
  pairs: MarketPairConfig[];
  autoPairs?: AutoPairConfig[];
};

let autoPickCursor = 0;

function readConfig(): ConfigFile {
  const rawPath = (process.env.MARKETS_CONFIG_PATH ?? "").trim();
  const configPath = rawPath
    ? path.resolve(rawPath)
    : path.resolve("config", "markets.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as ConfigFile;
}

function num(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function parseOrderType(raw: string | undefined) {
  const v = (raw ?? "FOK").toUpperCase();
  if (v in OrderType) return (OrderType as Record<string, OrderType>)[v];
  return OrderType.FOK;
}

function parseBool(raw: string | undefined, fallback: boolean) {
  if (!raw) return fallback;
  return raw.trim().toLowerCase() !== "false";
}

function disableSystemProxyIfRequested() {
  const disable = parseBool(process.env.DISABLE_SYSTEM_PROXY, true);
  if (!disable) return;
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "GIT_HTTP_PROXY",
    "GIT_HTTPS_PROXY",
    "git_http_proxy",
    "git_https_proxy"
  ];
  for (const k of keys) delete process.env[k];
  process.env.NODE_USE_ENV_PROXY = "false";
}

function parseBaseExchange(raw: string | undefined) {
  const v = (raw ?? "AUTO").trim().toUpperCase();
  if (v === "AUTO") return "AUTO";
  if (v === "PM" || v === "POLYMARKET") return "PM";
  if (v === "KAL" || v === "KALSHI") return "KAL";
  return "AUTO";
}

function parseRoundMode(raw: string | undefined) {
  const v = (raw ?? "round").trim().toLowerCase();
  if (v === "floor" || v === "ceil" || v === "round") return v;
  return "round";
}

function parseKalshiFeeType(raw: string | undefined) {
  const v = (raw ?? "taker").trim().toLowerCase();
  return v === "maker" ? "maker" : "taker";
}

function parseHedgeTarget(raw: string | undefined) {
  const v = (raw ?? "profit").trim().toLowerCase();
  return v === "payout" ? "payout" : "profit";
}

function roundContracts(value: number, mode: "floor" | "ceil" | "round") {
  if (!Number.isFinite(value)) return 0;
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  return Math.round(value);
}

function clampPositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}

function calcPolymarketFeePerShare(price: number, feeRateBps: number, exponent: number) {
  if (!feeRateBps) return 0;
  const rate = feeRateBps / 10000;
  const curve = Math.pow(price * (1 - price), exponent);
  return price * rate * curve;
}

function calcKalshiFeeTotal(
  price: number,
  contracts: number,
  feeType: "maker" | "taker"
) {
  if (contracts <= 0) return 0;
  const factor = feeType === "maker" ? 0.0175 : 0.07;
  const raw = factor * contracts * price * (1 - price);
  return Math.ceil(raw * 100) / 100;
}

function winProfitPerShare(price: number, feePerShare: number) {
  return 1 - price - feePerShare;
}

function netProfit(
  pm: { side: "YES" | "NO"; shares: number; price: number; feePerShare: number },
  kal: { side: "YES" | "NO"; shares: number; price: number; feePerShare: number },
  outcome: "YES" | "NO"
) {
  const pmPayout = pm.side === outcome ? pm.shares : 0;
  const kalPayout = kal.side === outcome ? kal.shares : 0;
  const cost =
    pm.shares * pm.price +
    kal.shares * kal.price +
    pm.shares * pm.feePerShare +
    kal.shares * kal.feePerShare;
  return pmPayout + kalPayout - cost;
}

type BudgetSizingParams = {
  base: "PM" | "KAL";
  budget: number;
  pmPrice: number;
  kalPrice: number;
  pmFeePerShare: number;
  kalFeePerShareEstimate: number;
  kalFeeType: "maker" | "taker";
  kalRoundMode: "floor" | "ceil" | "round";
  pmWin: number;
  kalWin: number;
  pmMinSize: number;
  pmLiquidity: number;
  kalLiquidity: number;
};

type BudgetSizingResult = {
  pmShares: number;
  kalShares: number;
  totalCost: number;
  targetWinProfit: number;
};

function sizeBudgetHedge(params: BudgetSizingParams): BudgetSizingResult | null {
  const {
    base,
    budget,
    pmPrice,
    kalPrice,
    pmFeePerShare,
    kalFeePerShareEstimate,
    kalFeeType,
    kalRoundMode,
    pmWin,
    kalWin,
    pmMinSize,
    pmLiquidity,
    kalLiquidity
  } = params;

  const pmCost = pmPrice + pmFeePerShare;
  const kalCost = kalPrice + kalFeePerShareEstimate;

  const pmLiq = Number.isFinite(pmLiquidity) ? pmLiquidity : Number.POSITIVE_INFINITY;
  const kalLiq = Number.isFinite(kalLiquidity) ? kalLiquidity : Number.POSITIVE_INFINITY;

  let kalShares: number;
  if (base === "PM") {
    const pmSharesCont = budget / (pmCost + (pmWin / kalWin) * kalCost);
    const kalCont = pmSharesCont * (pmWin / kalWin);
    kalShares = roundContracts(kalCont, kalRoundMode);
  } else {
    const kalCont = budget / (kalCost + (kalWin / pmWin) * pmCost);
    kalShares = roundContracts(kalCont, kalRoundMode);
  }

  if (!Number.isFinite(kalShares) || kalShares < 1) return null;
  kalShares = Math.min(kalShares, Math.floor(kalLiq));
  if (kalShares < 1) return null;

  let pmShares = (kalShares * kalWin) / pmWin;
  if (pmShares > pmLiq) {
    kalShares = Math.floor((pmLiq * pmWin) / kalWin);
    if (kalShares < 1) return null;
    pmShares = (kalShares * kalWin) / pmWin;
  }
  if (pmShares < pmMinSize) return null;

  let kalFeeTotal = calcKalshiFeeTotal(kalPrice, kalShares, kalFeeType);
  let totalCost =
    pmShares * pmPrice + kalShares * kalPrice + pmShares * pmFeePerShare + kalFeeTotal;

  while (kalShares > 0 && totalCost > budget + 1e-6) {
    kalShares -= 1;
    pmShares = (kalShares * kalWin) / pmWin;
    if (kalShares < 1 || pmShares < pmMinSize) return null;
    kalFeeTotal = calcKalshiFeeTotal(kalPrice, kalShares, kalFeeType);
    totalCost =
      pmShares * pmPrice + kalShares * kalPrice + pmShares * pmFeePerShare + kalFeeTotal;
  }
  if (kalShares < 1) return null;

  return {
    pmShares,
    kalShares,
    totalCost,
    targetWinProfit: kalShares * kalWin
  };
}

type PayoutSizingParams = {
  budget: number;
  pmPrice: number;
  kalPrice: number;
  pmFeePerShare: number;
  kalFeePerShareEstimate: number;
  kalFeeType: "maker" | "taker";
  kalRoundMode: "floor" | "ceil" | "round";
  pmMinSize: number;
  pmLiquidity: number;
  kalLiquidity: number;
};

function sizeBudgetPayout(params: PayoutSizingParams): BudgetSizingResult | null {
  const {
    budget,
    pmPrice,
    kalPrice,
    pmFeePerShare,
    kalFeePerShareEstimate,
    kalFeeType,
    kalRoundMode,
    pmMinSize,
    pmLiquidity,
    kalLiquidity
  } = params;

  const perShare = pmPrice + pmFeePerShare + kalPrice + kalFeePerShareEstimate;
  if (!Number.isFinite(perShare) || perShare <= 0) return null;

  const pmLiq = Number.isFinite(pmLiquidity) ? pmLiquidity : Number.POSITIVE_INFINITY;
  const kalLiq = Number.isFinite(kalLiquidity) ? kalLiquidity : Number.POSITIVE_INFINITY;
  const maxByLiq = Math.floor(Math.min(pmLiq, kalLiq));
  if (maxByLiq < 1) return null;

  let shares = Math.floor(budget / perShare);
  shares = Math.min(shares, maxByLiq);
  shares = roundContracts(shares, kalRoundMode);
  if (!Number.isFinite(shares) || shares < 1) return null;

  let kalFeeTotal = calcKalshiFeeTotal(kalPrice, shares, kalFeeType);
  let totalCost =
    shares * pmPrice +
    shares * kalPrice +
    shares * pmFeePerShare +
    kalFeeTotal;

  while (shares > 0 && totalCost > budget + 1e-6) {
    shares -= 1;
    if (shares < 1) return null;
    kalFeeTotal = calcKalshiFeeTotal(kalPrice, shares, kalFeeType);
    totalCost =
      shares * pmPrice +
      shares * kalPrice +
      shares * pmFeePerShare +
      kalFeeTotal;
  }

  let bumped = true;
  let safety = 0;
  while (bumped && safety < 20) {
    safety += 1;
    if (shares + 1 > maxByLiq) break;
    const nextFee = calcKalshiFeeTotal(kalPrice, shares + 1, kalFeeType);
    const nextCost =
      (shares + 1) * pmPrice +
      (shares + 1) * kalPrice +
      (shares + 1) * pmFeePerShare +
      nextFee;
    if (nextCost <= budget + 1e-6) {
      shares += 1;
      kalFeeTotal = nextFee;
      totalCost = nextCost;
    } else {
      bumped = false;
    }
  }

  if (shares < pmMinSize) return null;

  return {
    pmShares: shares,
    kalShares: shares,
    totalCost,
    targetWinProfit: shares
  };
}

function estimateMinBudgetForPmMin(
  pmMinSize: number,
  pmPrice: number,
  pmFeePerShare: number,
  pmWin: number,
  kalPrice: number,
  kalWin: number,
  kalFeeType: "maker" | "taker"
) {
  const kMin = Math.max(1, Math.ceil((pmMinSize * pmWin) / kalWin));
  const pmShares = (kMin * kalWin) / pmWin;
  const kalFeeTotal = calcKalshiFeeTotal(kalPrice, kMin, kalFeeType);
  return {
    minBudget:
      pmShares * pmPrice +
      kMin * kalPrice +
      pmShares * pmFeePerShare +
      kalFeeTotal,
    kalShares: kMin
  };
}

function estimateMinBudgetForPmMinPayout(
  pmMinSize: number,
  pmPrice: number,
  pmFeePerShare: number,
  kalPrice: number,
  kalFeeType: "maker" | "taker"
) {
  const shares = Math.max(1, Math.ceil(pmMinSize));
  const kalFeeTotal = calcKalshiFeeTotal(kalPrice, shares, kalFeeType);
  return {
    minBudget:
      shares * pmPrice +
      shares * kalPrice +
      shares * pmFeePerShare +
      kalFeeTotal,
    kalShares: shares
  };
}

function fmtNumber(value: number | null, digits = 4) {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function fmtShares(value: number) {
  if (!Number.isFinite(value)) return "n/a";
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(4);
}

function extractPmMeta(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  const txHashes = obj.transactionsHashes;
  const txHash = Array.isArray(txHashes) ? txHashes[0] : obj.transactionHash ?? obj.txHash;
  return {
    orderId: obj.orderID ?? obj.orderId,
    status: obj.status,
    success: obj.success,
    txHash,
    makingAmount: obj.makingAmount,
    takingAmount: obj.takingAmount
  };
}

function extractKalshiMeta(value: unknown) {
  if (!value || typeof value !== "object") return {};
  const obj = value as Record<string, unknown>;
  const order = (obj.order as Record<string, unknown> | undefined) ?? obj;
  return {
    orderId: order.order_id ?? order.orderId ?? order.id,
    status: order.status ?? order.order_status,
    filled: order.filled_count ?? order.filled_contracts ?? order.filled
  };
}

function edgeFromCost(cost: number | null): number | null {
  if (cost === null) return null;
  return 1 - cost;
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTradeOnce() {
  disableSystemProxyIfRequested();
  const dryRun = parseBool(process.env.DRY_RUN, true);
  let tradePairId = process.env.TRADE_PAIR_ID ?? "";
  let direction = (process.env.TRADE_DIRECTION ?? "PM_YES_KAL_NO") as
    | "PM_YES_KAL_NO"
    | "KAL_YES_PM_NO";
  const usd = num(process.env.TRADE_USD, 1);
  const baseSharesRaw = process.env.TRADE_SHARES;
  const baseShares = baseSharesRaw ? Number(baseSharesRaw) : Number.NaN;
  const useShareSizing = Number.isFinite(baseShares) && baseShares > 0;
  const baseExchange = parseBaseExchange(process.env.TRADE_BASE_EXCHANGE);
  const kalshiFeeType = parseKalshiFeeType(process.env.KALSHI_FEE_TYPE);
  const kalshiRoundMode = parseRoundMode(process.env.KALSHI_COUNT_ROUND);
  const hedgeTarget = parseHedgeTarget(process.env.HEDGE_TARGET);
  const polyFeeExponent = num(process.env.POLY_FEE_EXPONENT, 2);
  const parallelRequested = parseBool(process.env.TRADE_PARALLEL, true);
  const strictHedge = parseBool(process.env.STRICT_HEDGE, true);
  const parallel = parallelRequested && !strictHedge;
  const pmOrderType = parseOrderType(process.env.POLY_ORDER_TYPE);
  const autoPick = parseBool(process.env.AUTO_PICK, true);
  const minEdge = num(process.env.MIN_EDGE, 0);
  const minNetPnl = num(process.env.MIN_NET_PNL, Number.NEGATIVE_INFINITY);
  const autoPickMaxPairs = Math.max(
    0,
    Math.floor(num(process.env.AUTO_PICK_MAX_PAIRS_PER_CYCLE, 0))
  );
  const lookupPolyFeeRate = parseBool(process.env.LOOKUP_POLY_FEE_RATE, false);
  const debugSizing = parseBool(process.env.DEBUG_SIZING, false);

  if (!dryRun) {
    if (!process.env.POLY_WALLET_PRIVATE_KEY?.trim()) {
      throw new Error("Missing POLY_WALLET_PRIVATE_KEY for Polymarket trading.");
    }

    const envCreds = readPolyApiCredsFromEnv();
    if (envCreds) {
      try {
        const normalized = normalizeBase64Secret(envCreds.secret);
        if (process.env.DEBUG_POLY_SECRET === "true") {
          console.log(`[DEBUG] POLY_API_SECRET length=${normalized.length}`);
        }
      } catch (err) {
        throw new Error(`Invalid POLY_API_SECRET format: ${(err as Error).message}`);
      }
    }
  }

  const config = readConfig();
  let pairs: MarketPairConfig[] = [...config.pairs];
  if (config.autoPairs?.length) {
    for (const auto of config.autoPairs) {
      const autoPairs = await buildAutoPairs(auto);
      pairs = pairs.concat(autoPairs);
    }
  }

  let chosenPair: MarketPairConfig | undefined;
  let chosenPm: Awaited<ReturnType<typeof fetchPolymarketSnapshot>> | null = null;
  let chosenKal: Awaited<ReturnType<typeof fetchKalshiSnapshot>> | null = null;

  if (!tradePairId || autoPick) {
    let scanPairs = pairs;
    if (autoPick && autoPickMaxPairs > 0 && pairs.length > autoPickMaxPairs) {
      const start = autoPickCursor % pairs.length;
      const subset: MarketPairConfig[] = [];
      for (let i = 0; i < autoPickMaxPairs; i += 1) {
        subset.push(pairs[(start + i) % pairs.length] as MarketPairConfig);
      }
      autoPickCursor = (start + autoPickMaxPairs) % pairs.length;
      scanPairs = subset;
      console.log(
        `[AUTO_PICK] scanning subset=${scanPairs.length}/${pairs.length} start=${start}`
      );
    }

    let bestEdge = -Infinity;
    let bestDirection: "PM_YES_KAL_NO" | "KAL_YES_PM_NO" | null = null;
    const nowIso = new Date().toISOString();
    const scanResults = await Promise.allSettled(
      scanPairs
        .filter((pair) => !!pair.polymarket.marketSlug)
        .map(async (pair) => {
          const [pm, kal] = await Promise.all([
            fetchPolymarketSnapshot(pair, nowIso),
            fetchKalshiSnapshot(pair, nowIso)
          ]);
          return { pair, pm, kal };
        })
    );
    for (const result of scanResults) {
      if (result.status === "rejected") {
        console.error(`[AUTO_PICK] fetch error: ${(result.reason as Error)?.message ?? result.reason}`);
        continue;
      }
      const { pair, pm, kal } = result.value;
      const kalAligned =
        pair.kalshi.side === "YES"
          ? { yesAsk: kal.yesAsk, noAsk: kal.noAsk }
          : { yesAsk: kal.noAsk, noAsk: kal.yesAsk };

      const costA = sumNullable(pm.yesAsk, kalAligned.noAsk);
      const edgeA = edgeFromCost(costA);
      const costB = sumNullable(kalAligned.yesAsk, pm.noAsk);
      const edgeB = edgeFromCost(costB);

      if (edgeA !== null && edgeA >= minEdge && edgeA > bestEdge) {
        bestEdge = edgeA;
        bestDirection = "PM_YES_KAL_NO";
        chosenPair = pair;
        chosenPm = pm;
        chosenKal = kal;
      }
      if (edgeB !== null && edgeB >= minEdge && edgeB > bestEdge) {
        bestEdge = edgeB;
        bestDirection = "KAL_YES_PM_NO";
        chosenPair = pair;
        chosenPm = pm;
        chosenKal = kal;
      }

    }

    if (!chosenPair || !bestDirection) {
      throw new Error("No viable arbitrage opportunity found for AUTO_PICK.");
    }

    tradePairId = chosenPair.id;
    direction = bestDirection;
    console.log(`[AUTO_PICK] Selected ${tradePairId} direction=${direction}`);
  } else {
    chosenPair = pairs.find((p) => p.id === tradePairId);
  }

  const pair = chosenPair;
  if (!pair) {
    throw new Error(`Pair id not found: ${tradePairId}`);
  }
  if (!pair.polymarket.marketSlug) {
    throw new Error("Pair missing polymarket.marketSlug; trading requires a market slug.");
  }

  const pm =
    chosenPm ??
    (await fetchPolymarketSnapshot(pair, new Date().toISOString()));
  const kal =
    chosenKal ??
    (await fetchKalshiSnapshot(pair, new Date().toISOString()));

  const pmYesAsk = pm.yesAsk;
  const pmNoAsk = pm.noAsk;
  const kalAligned =
    pair.kalshi.side === "YES"
      ? { yesAsk: kal.yesAsk, noAsk: kal.noAsk }
      : { yesAsk: kal.noAsk, noAsk: kal.yesAsk };
  const kalYesAsk = kalAligned.yesAsk;
  const kalNoAsk = kalAligned.noAsk;

  const pmSide: "YES" | "NO" = direction === "PM_YES_KAL_NO" ? "YES" : "NO";
  const kalSide: "YES" | "NO" = direction === "PM_YES_KAL_NO" ? "NO" : "YES";
  const pmPrice = pmSide === "YES" ? pmYesAsk : pmNoAsk;
  const kalPrice = kalSide === "YES" ? kalYesAsk : kalNoAsk;

  if (pmPrice === null || kalPrice === null) {
    throw new Error("Missing PM/Kalshi ask price for selected direction.");
  }

  // Max Kalshi price that still preserves minEdge: floor((1 - pmPrice - minEdge) * 100) cents.
  // Using this as the FOK limit sweeps the book up to the profitability boundary
  // instead of stopping at the snapshot best ask.
  const kalLimitCents = Math.max(1, Math.min(99, Math.floor((1 - pmPrice - minEdge) * 100)));
  const kalLimitPrice = kalLimitCents / 100;

  const pmOutcomeLabel = pmSide === "YES" ? "Yes" : "No";
  const kalOrderSide = kalSide === "YES" ? "yes" : "no";

  const pmTradeInfo = await getPolymarketTradeInfo(pair.polymarket.marketSlug, pmOutcomeLabel);
  let pmFeeRateBps = num(process.env.POLY_FEE_RATE_BPS, 0);
  if (lookupPolyFeeRate) {
    try {
      pmFeeRateBps = await getPolymarketFeeRateBps(pmTradeInfo.tokenId);
    } catch (err) {
      console.warn(`[WARN] Unable to fetch Polymarket fee rate: ${(err as Error).message}`);
      pmFeeRateBps = 0;
    }
  }

  const pmFeePerShare = calcPolymarketFeePerShare(
    pmPrice,
    pmFeeRateBps,
    polyFeeExponent
  );
  const kalFeePerShareEstimate =
    (kalshiFeeType === "maker" ? 0.0175 : 0.07) * kalPrice * (1 - kalPrice);

  let pmShares: number;
  let kalShares: number;
  let targetWinProfit: number | null = null;
  let selectedBase = baseExchange;
  let pmLiquidity = Number.POSITIVE_INFINITY;
  let kalLiquidity = Number.POSITIVE_INFINITY;

  const pmWin = winProfitPerShare(pmPrice, pmFeePerShare);
  const kalWin = winProfitPerShare(kalPrice, kalFeePerShareEstimate);
  if (hedgeTarget === "profit" && (pmWin <= 0 || kalWin <= 0)) {
    throw new Error("Win profit per share is not positive; cannot size hedge.");
  }

  if (useShareSizing) {
    if (selectedBase === "AUTO") selectedBase = "PM";
    const base = clampPositive(baseShares, "TRADE_SHARES");
    if (hedgeTarget === "payout") {
      const payoutShares = roundContracts(base, kalshiRoundMode);
      if (payoutShares !== base && debugSizing) {
        console.warn(
          `[WARN] Adjusting payout shares from ${fmtShares(base)} to ${fmtShares(
            payoutShares
          )} to match Kalshi integer contracts.`
        );
      }
      pmShares = payoutShares;
      kalShares = payoutShares;
      targetWinProfit = payoutShares;
    } else if (selectedBase === "PM") {
      pmShares = base;
      targetWinProfit = base * pmWin;
      kalShares = roundContracts(targetWinProfit / kalWin, kalshiRoundMode);
    } else {
      kalShares = roundContracts(base, kalshiRoundMode);
      targetWinProfit = kalShares * kalWin;
      pmShares = targetWinProfit / pmWin;
    }
  } else {
    try {
      pmLiquidity = await getPolymarketAskLiquidity(pmTradeInfo.tokenId, pmPrice);
    } catch (err) {
      console.warn(`[WARN] Unable to fetch PM liquidity: ${(err as Error).message}`);
    }
    try {
      kalLiquidity = await getKalshiImpliedAskLiquidity(
        pair.kalshi.ticker,
        kalOrderSide,
        kalPrice
      );
    } catch (err) {
      console.warn(`[WARN] Unable to fetch Kalshi liquidity: ${(err as Error).message}`);
    }

    const pmCandidate =
      hedgeTarget === "payout"
        ? sizeBudgetPayout({
            budget: usd,
            pmPrice,
            kalPrice,
            pmFeePerShare,
            kalFeePerShareEstimate,
            kalFeeType: kalshiFeeType,
            kalRoundMode: kalshiRoundMode,
            pmMinSize: pmTradeInfo.minSize,
            pmLiquidity,
            kalLiquidity
          })
        : sizeBudgetHedge({
            base: "PM",
            budget: usd,
            pmPrice,
            kalPrice,
            pmFeePerShare,
            kalFeePerShareEstimate,
            kalFeeType: kalshiFeeType,
            kalRoundMode: kalshiRoundMode,
            pmWin,
            kalWin,
            pmMinSize: pmTradeInfo.minSize,
            pmLiquidity,
            kalLiquidity
          });

    const kalCandidate =
      hedgeTarget === "payout"
        ? sizeBudgetPayout({
            budget: usd,
            pmPrice,
            kalPrice,
            pmFeePerShare,
            kalFeePerShareEstimate,
            kalFeeType: kalshiFeeType,
            kalRoundMode: kalshiRoundMode,
            pmMinSize: pmTradeInfo.minSize,
            pmLiquidity,
            kalLiquidity
          })
        : sizeBudgetHedge({
            base: "KAL",
            budget: usd,
            pmPrice,
            kalPrice,
            pmFeePerShare,
            kalFeePerShareEstimate,
            kalFeeType: kalshiFeeType,
            kalRoundMode: kalshiRoundMode,
            pmWin,
            kalWin,
            pmMinSize: pmTradeInfo.minSize,
            pmLiquidity,
            kalLiquidity
          });

    if (selectedBase === "AUTO") {
      selectedBase = pmLiquidity <= kalLiquidity ? "PM" : "KAL";
    }

    const chosen =
      (selectedBase === "PM" ? pmCandidate : kalCandidate) ??
      (selectedBase === "PM" ? kalCandidate : pmCandidate);

    if (!chosen) {
      const estimate =
        hedgeTarget === "payout"
          ? estimateMinBudgetForPmMinPayout(
              pmTradeInfo.minSize,
              pmPrice,
              pmFeePerShare,
              kalPrice,
              kalshiFeeType
            )
          : estimateMinBudgetForPmMin(
              pmTradeInfo.minSize,
              pmPrice,
              pmFeePerShare,
              pmWin,
              kalPrice,
              kalWin,
              kalshiFeeType
            );
      throw new Error(
        `Budget too low to meet PM min size ${pmTradeInfo.minSize}. ` +
          `Estimated minimum total budget ~= $${estimate.minBudget.toFixed(2)} ` +
          `(kalShares=${estimate.kalShares}).`
      );
    }

    pmShares = chosen.pmShares;
    kalShares = chosen.kalShares;
    targetWinProfit = chosen.targetWinProfit;
  }

  if (pmShares < pmTradeInfo.minSize) {
    throw new Error(`PM size ${pmShares.toFixed(4)} < min size ${pmTradeInfo.minSize}.`);
  }
  if (kalShares < 1) {
    throw new Error("Kalshi count < 1 after sizing.");
  }

  let kalFeeTotal = calcKalshiFeeTotal(kalPrice, kalShares, kalshiFeeType);
  let kalFeePerShare = kalFeeTotal / kalShares;
  let pmFeeTotal = pmShares * pmFeePerShare;
  let totalCost = pmShares * pmPrice + kalShares * kalPrice + pmFeeTotal + kalFeeTotal;

  const pmLeg = { side: pmSide, shares: pmShares, price: pmPrice, feePerShare: pmFeePerShare };
  const kalLeg = { side: kalSide, shares: kalShares, price: kalPrice, feePerShare: kalFeePerShare };
  const profitYes = netProfit(pmLeg, kalLeg, "YES");
  const profitNo = netProfit(pmLeg, kalLeg, "NO");
  if (profitYes < minNetPnl || profitNo < minNetPnl) {
    throw new Error(
      `Net PnL below MIN_NET_PNL=${fmtNumber(minNetPnl, 4)} for selected pair. ` +
        `YES=${fmtNumber(profitYes, 4)} NO=${fmtNumber(profitNo, 4)}`
    );
  }

  const pmReq = () =>
    placePolymarketOrder(
      pair.polymarket.marketSlug!,
      pmOutcomeLabel,
      pmPrice,
      useShareSizing ? pmShares : usd,
      dryRun,
      pmOrderType,
      useShareSizing ? "shares" : "usd",
      pmTradeInfo
    );

  const kalReq = () =>
    placeKalshiOrder(
      useShareSizing
        ? buildKalshiOrderFromCount(pair.kalshi.ticker, kalOrderSide, kalLimitPrice, kalShares)
        : buildKalshiOrder(pair.kalshi.ticker, kalOrderSide, kalLimitPrice, usd),
      dryRun
    );

  const printSummary = (pmResult: unknown, kalResult: unknown) => {
    const pmMeta = extractPmMeta(pmResult);
    const kalMeta = extractKalshiMeta(kalResult);
    const lines: string[] = [];
    lines.push("[POST-TRADE SUMMARY]");
    lines.push(
      `PM ${pmSide} @${fmtNumber(pmPrice)} size=${fmtShares(pmShares)} fee~$${fmtNumber(pmFeeTotal, 4)} ` +
        `feeRateBps=${pmFeeRateBps} status=${pmMeta.status ?? "n/a"} ` +
        `orderId=${pmMeta.orderId ?? "n/a"} tx=${pmMeta.txHash ?? "n/a"}`
    );
    lines.push(
      `KAL ${kalSide} @${fmtNumber(kalPrice)} count=${fmtShares(kalShares)} fee~$${fmtNumber(kalFeeTotal, 4)} ` +
        `feeType=${kalshiFeeType} status=${kalMeta.status ?? "n/a"} ` +
        `orderId=${kalMeta.orderId ?? "n/a"}`
    );
    if (!useShareSizing) {
      lines.push(
        `Sizing: base=${selectedBase} budget=$${fmtNumber(usd, 4)} totalCost~$${fmtNumber(
          totalCost,
          4
        )} pmLiq~${fmtShares(pmLiquidity)} kalLiq~${fmtShares(kalLiquidity)}`
      );
    }
    lines.push(
      `Est. net PnL YES=$${fmtNumber(profitYes, 4)} NO=$${fmtNumber(profitNo, 4)}`
    );
    if (useShareSizing && targetWinProfit !== null) {
      lines.push(
        hedgeTarget === "payout"
          ? `Sizing: base=${baseExchange} payoutShares=${fmtShares(baseShares)} ` +
              `targetPayout=$${fmtNumber(targetWinProfit, 4)} kalRound=${kalshiRoundMode}`
          : `Sizing: base=${baseExchange} shares=${fmtShares(baseShares)} targetWin~$${fmtNumber(
              targetWinProfit,
              4
            )} kalRound=${kalshiRoundMode}`
      );
    }
    if (debugSizing) {
      lines.push(
        `DEBUG sizing: target=${hedgeTarget} pmWin=${fmtNumber(pmWin, 6)} ` +
          `kalWin=${fmtNumber(kalWin, 6)} pmFeePerShare=${fmtNumber(pmFeePerShare, 6)} ` +
          `kalFeePerShare~${fmtNumber(kalFeePerShareEstimate, 6)}`
      );
    }
    console.log(lines.join("\n"));
  };

  if (strictHedge && parallelRequested) {
    console.log("[HEDGE] STRICT_HEDGE=true forcing sequential PM-first execution.");
  }

  if (parallel) {
    const [pmRes, kalRes] = await Promise.allSettled([pmReq(), kalReq()]);
    const pmValue = pmRes.status === "fulfilled" ? pmRes.value : pmRes.reason;
    const kalValue = kalRes.status === "fulfilled" ? kalRes.value : kalRes.reason;
    printSummary(pmValue, kalValue);
    if (pmRes.status === "rejected" || kalRes.status === "rejected") {
      throw new Error("One of the two orders failed. See logs above.");
    }
  } else {
    const pmOrder = await pmReq();
    const pmCheckMeta = extractPmMeta(pmOrder);
    if (typeof pmCheckMeta.status === "number") {
      printSummary(pmOrder, null);
      throw new Error(
        `PM order rejected (status ${pmCheckMeta.status}); Kalshi order not placed to avoid unhedged position.`
      );
    }
    let kalOrder: unknown = null;
    let kalFailed = false;
    try {
      kalOrder = await kalReq();
    } catch (kalErr) {
      kalOrder = kalErr;
      kalFailed = true;
    }

    printSummary(pmOrder, kalOrder);

    if (kalFailed) {
      // PM executed but Kalshi failed -- immediately buy the opposite side on PM to neutralise the position.
      // Cost: pmPrice + recoveryPrice = exactly $1 per share -> guaranteed break-even, no extra spend.
      const recoveryLabel: "Yes" | "No" = pmSide === "YES" ? "No" : "Yes";
      const recoveryPrice = Math.min(0.99, 1 - pmPrice);
      console.log(
        `[RECOVERY] Kalshi failed after PM ${pmSide} executed. ` +
          `Placing PM ${recoveryLabel.toUpperCase()} to cover: ` +
          `${fmtShares(pmShares)} shares @ limit ${fmtNumber(recoveryPrice)}`
      );
      try {
        const recoveryInfo = await getPolymarketTradeInfo(pair.polymarket.marketSlug!, recoveryLabel);
        const recoveryOrder = await placePolymarketOrder(
          pair.polymarket.marketSlug!,
          recoveryLabel,
          recoveryPrice,
          pmShares,
          dryRun,
          pmOrderType,
          "shares",
          recoveryInfo
        );
        const rm = extractPmMeta(recoveryOrder);
        if (typeof rm.status === "number") {
          console.error(
            `[RECOVERY] PM ${recoveryLabel.toUpperCase()} rejected (status ${rm.status}). Position still unhedged!`
          );
        } else {
          console.log(
            `[RECOVERY] PM ${recoveryLabel.toUpperCase()} status=${rm.status ?? "n/a"} orderId=${rm.orderId ?? "n/a"}`
          );
        }
      } catch (recoveryErr) {
        console.error(
          `[RECOVERY] PM recovery failed: ${(recoveryErr as Error).message}. Position still unhedged!`
        );
      }
      throw new Error("Kalshi leg failed; PM recovery hedge attempted. See logs above.");
    }
  }
}

async function main() {
  const loop = parseBool(process.env.TRADE_LOOP, false);
  if (!loop) {
    await runTradeOnce();
    return;
  }

  const minIntervalMs = Math.max(300, num(process.env.TRADE_LOOP_MIN_INTERVAL_MS, 1500));
  const maxIntervalMs = Math.max(minIntervalMs, num(process.env.TRADE_LOOP_MAX_INTERVAL_MS, 25000));
  const baseIntervalMs = Math.max(minIntervalMs, num(process.env.TRADE_LOOP_BASE_INTERVAL_MS, 2500));
  const backoffFactor = Math.max(1.1, num(process.env.TRADE_LOOP_BACKOFF, 1.7));
  const cooldownMs = Math.max(0, num(process.env.TRADE_LOOP_COOLDOWN_MS, 15000));
  const maxCycles = Math.max(0, Math.floor(num(process.env.TRADE_LOOP_MAX_CYCLES, 0)));
  let intervalMs = baseIntervalMs;
  let cycle = 0;
  let lastSuccessAt = 0;

  console.log(
    `[TRADE_LOOP] enabled min=${minIntervalMs}ms base=${baseIntervalMs}ms max=${maxIntervalMs}ms backoff=${backoffFactor} cooldown=${cooldownMs} maxCycles=${maxCycles || "inf"}`
  );

  while (true) {
    if (maxCycles > 0 && cycle >= maxCycles) break;
    cycle += 1;

    if (cooldownMs > 0 && lastSuccessAt > 0) {
      const sinceMs = Date.now() - lastSuccessAt;
      if (sinceMs < cooldownMs) {
        await sleep(Math.min(intervalMs, cooldownMs - sinceMs));
        continue;
      }
    }

    const startedAt = Date.now();
    console.log(`[TRADE_LOOP] cycle=${cycle} intervalMs=${intervalMs}`);

    try {
      await runTradeOnce();
      lastSuccessAt = Date.now();
      intervalMs = Math.max(minIntervalMs, Math.floor(intervalMs * 0.9));
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      const lower = msg.toLowerCase();
      const isRateLimited =
        lower.includes("429") ||
        lower.includes("too many requests") ||
        lower.includes("rate limit");
      const isNoArb =
        lower.includes("no viable arbitrage opportunity found") ||
        lower.includes("net pnl below min_net_pnl") ||
        lower.includes("budget too low to meet pm min size");

      if (isRateLimited) {
        intervalMs = Math.min(maxIntervalMs, Math.ceil(intervalMs * backoffFactor));
        console.log(`[TRADE_LOOP] rate-limited; increasing interval to ${intervalMs}ms.`);
      } else if (isNoArb) {
        console.log(`[TRADE_LOOP] no executable arb this cycle.`);
      } else {
        intervalMs = Math.min(maxIntervalMs, Math.ceil(intervalMs * 1.2));
        console.error(`[TRADE_LOOP] cycle error: ${msg}`);
      }
    }

    const elapsedMs = Date.now() - startedAt;
    const sleepMs = Math.max(minIntervalMs, intervalMs - elapsedMs);
    await sleep(sleepMs);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
