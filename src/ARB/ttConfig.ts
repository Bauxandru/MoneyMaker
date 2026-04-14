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
// PARALLEL_MODE: fire KAL IOC + PM FAK simultaneously (saves ~400ms but riskier)
// Default OFF. Set PARALLEL_MODE=true to enable.
export const PARALLEL_MODE = boolEnv("PARALLEL_MODE", false);
export const TRADE_USD = numEnv("TRADE_USD", 10);
export const MAX_CONTRACTS = Math.max(1, Math.floor(numEnv("MAX_CONTRACTS", 999)));
export const MIN_EDGE = numEnv("MIN_EDGE", 0.02);

// POLL_INTERVAL_MS: With WS feeds active, the poll cycle does zero API calls
// (pure Map reads), so this is just a sleep to yield the event loop. 0 = max speed.
export const POLL_INTERVAL_MS = Math.max(0,
  numEnv("POLL_INTERVAL_MS", numEnv("TRADE_LOOP_MIN_INTERVAL_MS", 0)));

export const TRADE_COOLDOWN_MS = numEnv("TRADE_COOLDOWN_MS", numEnv("TRADE_LOOP_COOLDOWN_MS", 60000));

// HEDGE_TARGET: "payout" = hedge fills accepted at breakeven (1 - costBasis)
export const HEDGE_TARGET = strEnv("HEDGE_TARGET", "payout") === "payout" ? "payout" : "profit";
export const STRICT_HEDGE = boolEnv("STRICT_HEDGE", false);
export const PM_ONLY_MAX_CYCLES = numEnv("PM_ONLY_MAX_CYCLES", 15);
export const FORCE_DISCOVER = boolEnv("FORCE_DISCOVER", false);

// Circuit breaker: stop opening new arbs when thresholds are hit.
export const MAX_CONSECUTIVE_ERRORS = numEnv("MAX_CONSECUTIVE_ERRORS", 5);
export const MAX_HEDGE_POSITIONS = numEnv("MAX_HEDGE_POSITIONS", 8);

// WS orderbook staleness thresholds (ms)
export const KAL_WS_STALE_MS = numEnv("KAL_WS_STALE_MS", 600_000);   // 10 min
export const PM_WS_STALE_MS  = numEnv("PM_WS_STALE_MS",   300_000);   // 5 min (illiquid books may not update for minutes)

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

// PM order type
const PM_ORDER_TYPE_RAW = (process.env.POLY_ORDER_TYPE ?? "FOK").toUpperCase();
export const PM_ORDER_TYPE: OrderType =
  PM_ORDER_TYPE_RAW in OrderType
    ? (OrderType as Record<string, OrderType>)[PM_ORDER_TYPE_RAW]
    : OrderType.FOK;

// --- Rate-limited fetch helpers -----------------------------------------------

export const retryOpts = { timeoutMs: 12000, maxRetries: 3, baseDelayMs: 600, maxDelayMs: 8000, jitterMs: 200 };
export const kalFetch = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 50), retryOpts);
// Dedicated hedge queue — independent from main queue so hedge orders never wait behind price refreshes
export const kalFetchHedge = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 50), { ...retryOpts, maxRetries: 1, timeoutMs: 8000 });
// Two separate PM queues -- gamma (discovery, 30/s) and CLOB (orderbook, 150/s)
export const polyFetch = createRateLimitedFetcher(numEnv("POLY_GAMMA_INTERVAL_MS", 35), retryOpts);
export const polyClobFetch = createRateLimitedFetcher(numEnv("POLY_CLOB_INTERVAL_MS", 7), retryOpts);

// --- Pure helpers -------------------------------------------------------------

export function fmtPct(v: number, d = 1): string { return (v * 100).toFixed(d) + "%"; }
export function ts(): string { return new Date().toISOString().replace("T", " ").slice(0, 23); }

/** Estimate total per-share fee cost for one arb direction. */
export function estimateFees(kalAsk: number, pmAsk: number): number {
  const kalFee = KALSHI_FEE_RATE * kalAsk * (1 - kalAsk);
  const pmFee = PM_FEE_RATE * pmAsk * (1 - pmAsk);
  return kalFee + pmFee;
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
