/**
 * ttConfig.ts -- Environment config, constants, rate-limited fetchers, and pure helpers.
 * No mutable state. Everything here is read-only after initialization.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { OrderType } from "@polymarket/clob-client";
import { numEnv, boolEnv, strEnv } from "../utils.js";
import { fetchJsonWithRetry, createRateLimitedFetcher } from "../http.js";
import { loadCsvConfig } from "../csvConfig.js";
import type { GammaEvent, GammaMarket, KalshiMarket } from "./ttTypes.js";

// --- Config loading -----------------------------------------------------------
// Load from settings.csv if present, otherwise fall back to .env
if (!loadCsvConfig("./settings.csv")) {
  dotenv.config();
}

// Disable system proxy
for (const k of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy"])
  delete process.env[k];
process.env.NODE_USE_ENV_PROXY = "false";

// --- Atomic file write (write-to-temp + rename) ------------------------------
// Prevents data corruption if the process crashes mid-write.
export function atomicWriteFileSync(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data, "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Clean up orphaned tmp file on rename failure
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// --- Trading constants --------------------------------------------------------

// DRY_RUN defaults to TRUE for safety -- must set DRY_RUN=false explicitly
export const DRY_RUN = boolEnv("DRY_RUN", true);
export const SERVER_ID = strEnv("SERVER_ID", "");
// PARALLEL_MODE: fire KAL IOC + PM FAK simultaneously — saves ~400-600ms on
// both-filled arbs. Default ON as of 2026-04-17. To revert to KAL-first
// sequential execution (safe fallback when KAL is unstable), set
// PARALLEL_MODE=false in settings.txt. See CLAUDE.md Safety Invariant #1.
export const PARALLEL_MODE = boolEnv("PARALLEL_MODE", true);
export const TRADE_USD = numEnv("TRADE_USD", 10);
export const MAX_CONTRACTS = Math.max(1, Math.floor(numEnv("MAX_CONTRACTS", 999)));
export const MIN_EDGE = numEnv("MIN_EDGE", 0.02);

// MAX_MARKET_EXPOSURE_USD: Hard cap on total $ committed to a single Kalshi market
// (summed across kalCost + pmCost on every bot-originated trade with that kalTicker,
// regardless of status). Default = 2 × TRADE_USD. Added 2026-04-17 after an
// Arsenal EPL totals market accumulated ~77 PM Over + 16 KAL YES across many
// Dir-A/C fires, creating ~$57 of downside risk. The cap short-circuits executeArb
// before any order is sent. Set MAX_MARKET_EXPOSURE_USD=0 to disable.
export const MAX_MARKET_EXPOSURE_USD = numEnv("MAX_MARKET_EXPOSURE_USD", TRADE_USD * 2);

// POLL_INTERVAL_MS: With WS feeds active, the poll cycle does zero API calls
// (pure Map reads), so this is just a sleep to yield the event loop. 0 = max speed.
export const POLL_INTERVAL_MS = Math.max(0,
  numEnv("POLL_INTERVAL_MS", numEnv("TRADE_LOOP_MIN_INTERVAL_MS", 0)));

export const TRADE_COOLDOWN_MS = numEnv("TRADE_COOLDOWN_MS", numEnv("TRADE_LOOP_COOLDOWN_MS", 60000));

// HEDGE_TARGET: "payout" = hedge fills accepted at breakeven (1 - costBasis)
export const HEDGE_TARGET = strEnv("HEDGE_TARGET", "payout") === "payout" ? "payout" : "profit";
// HEDGE_MIN_MARGIN_PER_SHARE: hard floor the hedge-complete GTC bid below the
// fee-adjusted breakeven, in $/share. Protects against drift that can push
// hedge-complete slightly negative:
//   - fractional PM fills (e.g. 7 ordered, 6.9 filled -> 0.1 naked KAL share)
//   - per-market PM fee rate variance vs the gamma-reported rate
//   - PM fee reserved at taker rate but actual fill was maker or vice-versa
// Default 0.005 ($0.005/share = $0.035 per 7-share arb) — absorbs the drift
// we've seen in prod (~$0.02) with headroom. Set to 0 to disable and accept
// razor-thin fills. Applied in both KAL-held and PM-held hedge breakeven math.
export const HEDGE_MIN_MARGIN_PER_SHARE = numEnv("HEDGE_MIN_MARGIN_PER_SHARE", 0.005);
export const STRICT_HEDGE = boolEnv("STRICT_HEDGE", false);
export const PM_ONLY_MAX_CYCLES = numEnv("PM_ONLY_MAX_CYCLES", 15);
export const FORCE_DISCOVER = boolEnv("FORCE_DISCOVER", false);

// Circuit breaker: stop opening new arbs when thresholds are hit.
export const MAX_CONSECUTIVE_ERRORS = numEnv("MAX_CONSECUTIVE_ERRORS", 5);
export const MAX_HEDGE_POSITIONS = numEnv("MAX_HEDGE_POSITIONS", 8);

// WS orderbook staleness thresholds (ms)
// WS staleness: if a book entry is older than this, treat as stale and fall back
// to REST. Previously 10 min for KAL — too lenient, a disconnected WS meant hedge
// decisions ran on 10-min-old books. 2 min keeps WS primary while making REST
// failover prompt. PM stays at 5 min because its illiquid books genuinely don't
// update for minutes (per original comment).
export const KAL_WS_STALE_MS = numEnv("KAL_WS_STALE_MS", 120_000);   // 2 min (was 10 min)
export const PM_WS_STALE_MS  = numEnv("PM_WS_STALE_MS",   300_000);   // 5 min (illiquid books may not update for minutes)

// --- PM WS connection pool ---------------------------------------------------
// Polymarket's WS server has a per-connection delivery ceiling around 200-300
// subscribed tokens. Past that, subscribed tokens are silently not delivered
// (their book events never reach us). Empirically verified by
// tmp_pm_ws_cap_probe.ts on 2026-04-20: at 600 subs only 212 tokens responded.
//
// Fix: split the PM WS into a pool of connections, each holding <= MAX tokens.
// 6 connections × 150 tokens per conn = full coverage for ~900-token watchlists
// with headroom below the observed ~212 cap.
export const PM_WS_POOL_SIZE        = Math.max(1, numEnv("PM_WS_POOL_SIZE", 6));
export const PM_WS_TOKENS_PER_CONN  = Math.max(10, numEnv("PM_WS_TOKENS_PER_CONN", 150));

// Discovery cache TTL (ms). 0 = date-based (stale at midnight UTC).
export const DISCOVERY_CACHE_TTL_MS = numEnv("DISCOVERY_CACHE_TTL_MS", 21_600_000); // 6 hours

// Liquidity depth check multiplier. 0 = disable.
export const MIN_DEPTH_MULT = numEnv("MIN_DEPTH_MULT", 2);

// LIVE_ONLY: Only trade matches that have already started (reduces scalar settlement risk).
// true = skip pre-match trades, false = trade any active market.
export const LIVE_ONLY = boolEnv("LIVE_ONLY", false);

// PM minimum marketable order value ($1 enforced by CLOB).
export const PM_MARKETABLE_MIN_VALUE = 1.0;

// Fee rates
export const KALSHI_FEE_RATE = numEnv("KALSHI_FEE_RATE", 0.07);       // 7% taker
export const KALSHI_MAKER_FEE_RATE = numEnv("KALSHI_MAKER_FEE_RATE", 0.0175); // 1.75% maker (25% of taker)
export const PM_FEE_RATE = numEnv("PM_FEE_RATE", 0.03);              // 3% taker on sports (makers pay 0%)

// Maker mode
export const KAL_MAKER_MODE = boolEnv("KAL_MAKER_MODE", false);
export const KAL_MAKER_WAIT_MS = numEnv("KAL_MAKER_WAIT_MS", 5000);
export const KAL_MAKER_POLL_MS = 500;

// PM taker order type is HARDCODED to FAK (Fill-And-Kill) across the bot.
// FAK is strictly better than FOK for our workload: it fills whatever the book
// can offer and cancels the remainder, instead of rejecting the whole order
// when the book is 1 share short (a common fractional-PM book situation).
// Over-fills from FAK are documented/accepted behavior (see memory note
// `feedback_pm_fak_overfills` and Safety Invariant #4).
// The `PM_ORDER_TYPE` constant is kept exported for backwards-compat (tests
// mock it) but no runtime code path reads it — see ttPmOrders.ts.
export const PM_ORDER_TYPE: OrderType = OrderType.FAK;

// --- Rate-limited fetch helpers -----------------------------------------------

// Default REST retry profile. Kalshi typical p99 < 1.5s, PM CLOB p99 < 2s, so a
// 5s timeout is still 3× their 99th percentile while cutting worst-case blocking
// from 36s (12s × 3 retries) to 15s on a truly dead endpoint. First retry at 200ms
// (was 600ms) matches typical transient-error recovery window.
export const retryOpts = { timeoutMs: 5000, maxRetries: 3, baseDelayMs: 200, maxDelayMs: 8000, jitterMs: 200 };
// Hot-path retry profile: used by price/book fetches that run inside an outer
// Promise.race timeout. We don't want the inner retry chain to keep the rate-
// limiter queue busy long after the outer has given up on the result.
export const hotRetryOpts = { timeoutMs: 2000, maxRetries: 1, baseDelayMs: 200, maxDelayMs: 400, jitterMs: 50 };
export const kalFetch = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 25), retryOpts);
// Hot-path Kalshi fetcher: shares interval default but aggressive retry cap.
export const kalFetchHot = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 25), hotRetryOpts);
// Dedicated hedge queue — independent from main queue so hedge orders never wait behind price refreshes
export const kalFetchHedge = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 25), { ...retryOpts, maxRetries: 1, timeoutMs: 8000 });
// Two separate PM queues -- gamma (discovery, 30/s) and CLOB (orderbook, 150/s)
export const polyFetch = createRateLimitedFetcher(numEnv("POLY_GAMMA_INTERVAL_MS", 35), retryOpts);
export const polyClobFetch = createRateLimitedFetcher(numEnv("POLY_CLOB_INTERVAL_MS", 7), retryOpts);
// Hot-path CLOB fetcher — same queue rate, aggressive retry cap for main-loop price reads.
export const polyClobFetchHot = createRateLimitedFetcher(numEnv("POLY_CLOB_INTERVAL_MS", 7), hotRetryOpts);

// --- Pure helpers -------------------------------------------------------------

export function fmtPct(v: number, d = 1): string { return (v * 100).toFixed(d) + "%"; }
export function ts(): string { return new Date().toISOString().replace("T", " ").slice(0, 23); }

/** Estimate total per-share fee cost for one arb direction.
 *  Optional pmFeeRate overrides the default PM_FEE_RATE — used when the
 *  specific PM market exposes its own feeSchedule.rate (e.g. some categories
 *  charge 0, others charge more). When unknown, defaults to PM_FEE_RATE. */
export function estimateFees(kalAsk: number, pmAsk: number, pmFeeRate?: number): number {
  const kalFee = KALSHI_FEE_RATE * kalAsk * (1 - kalAsk);
  const rate = typeof pmFeeRate === "number" ? pmFeeRate : PM_FEE_RATE;
  const pmFee = rate * pmAsk * (1 - pmAsk);
  return kalFee + pmFee;
}

/** Resolve the PM taker fee rate for a specific leg — uses per-market rate
 *  when available (populated at discovery from gamma's feeSchedule.rate),
 *  falls back to the PM_FEE_RATE default when the market metadata is missing. */
export function pmFeeRateFor(leg: { feeRate?: number } | undefined | null): number {
  const r = leg?.feeRate;
  return (typeof r === "number" && Number.isFinite(r)) ? r : PM_FEE_RATE;
}

/** Compute the actual PM taker fee paid for a fill, per Polymarket's formula:
 *    fee = shares × feeRate × price × (1 - price)
 *  Takes the per-leg feeRate as authoritative; falls back to PM_FEE_RATE. */
export function pmFeePaid(shares: number, price: number, leg: { feeRate?: number } | undefined | null): number {
  const rate = pmFeeRateFor(leg);
  return shares * rate * price * (1 - price);
}

// --- Gamma/Kalshi API response parsers ----------------------------------------

export function parseGammaEvents(raw: unknown): GammaEvent[] {
  if (Array.isArray(raw)) return raw as GammaEvent[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events as GammaEvent[];
    if (Array.isArray(obj.markets)) return [{ markets: obj.markets as GammaMarket[] }];
  }
  return [];
}

export function parseGammaMarkets(raw: unknown): GammaMarket[] {
  if (Array.isArray(raw)) return raw as GammaMarket[];
  return [];
}

export function parseKalshiMarkets(res: { markets?: KalshiMarket[] }): KalshiMarket[] {
  return Array.isArray(res.markets) ? res.markets : [];
}
