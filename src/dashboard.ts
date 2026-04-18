import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { readFileSync, existsSync } from "fs";
import crypto from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getChainStatus } from "./polyChain.js";
import { type ArbTradeRecord, type ExecMetric, type ClobTrade } from "./types.js";
import { kalSideForDir, totalCostForTrade } from "./utils.js";
import {
  loadEventsFromDisk, getAllTradeIds, getTradeEvents, getAllEvents,
  computeTradeFromEvents, shadowCompare,
  type ExchangeEvent, type ComputedTradeRecord,
} from "./ARB/ttEventLog.js";
import WebSocket from "ws";
import { fetchAllKalshiFills, fetchAllKalshiSettlements, fetchKalshiMarket, fetchOpenKalshiOrders, getKalshiPositionMap, type KalFill } from "./kalshiTrade.js";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./polyAuth.js";


const __filename = typeof import.meta?.url === "string" ? fileURLToPath(import.meta.url) : __filename ?? process.argv[1] ?? "";
const __dirname = __filename ? dirname(__filename) : process.cwd();
// ROOT defaults to the directory above the running script (programu/), but can
// be overridden with DASHBOARD_DATA_ROOT to point at a different folder layout.
// Useful for running multiple dashboards (one per server's data snapshot) on
// different ports against different data directories — the override expects
// the same layout: <root>/data/arb_trades.json, <root>/hedge_state.json, etc.
const ROOT = process.env.DASHBOARD_DATA_ROOT || join(__dirname, "..");
if (process.env.DASHBOARD_DATA_ROOT) {
  console.log(`[BOOT] Using DASHBOARD_DATA_ROOT=${ROOT}`);
}

const PORT = parseInt(process.env.DASHBOARD_PORT || "3456", 10);

// Minimum trade date to display. Set DASHBOARD_MIN_DATE in .env to filter old trades.
// Defaults to "" (show all trades -- no assumptions about start date).
const TRADE_MIN_DATE = process.env.DASHBOARD_MIN_DATE || "2026-04-01";

// Audit cutoff: only flag discrepancies for trades/fills from today.
// Everything before today is considered reconciled and accepted.
const AUDIT_CUTOFF_DATE = process.env.AUDIT_CUTOFF_DATE || new Date().toISOString().slice(0, 10);

// -- Multi-user data store (for remote bots pushing via /api/ingest) ----------
import { readFileSync as _readFs, writeFileSync as _writeFs, appendFileSync } from "fs";

interface RemoteUserData {
  name: string;
  ip: string;
  trades: ArbTradeRecord[];
  metrics: ExecMetric[];
  lastSeen: string;
}

const remoteUsers = new Map<string, RemoteUserData>(); // keyed by token

// License server URL for validating ingest tokens
const LICENSE_SERVER_URL = process.env.LICENSE_SERVER || "";

// Cache validated tokens for 5 minutes
const tokenCache = new Map<string, { valid: boolean; name: string; ts: number }>();
const TOKEN_CACHE_TTL = 5 * 60 * 1000;

async function validateIngestToken(token: string): Promise<{ valid: boolean; name: string }> {
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.ts < TOKEN_CACHE_TTL) {
    return { valid: cached.valid, name: cached.name };
  }

  // Simple shared-secret mode: if DASHBOARD_INGEST_SECRET is set, accept any
  // token that matches it. No license server needed.
  const ingestSecret = process.env.DASHBOARD_INGEST_SECRET || "";
  if (ingestSecret && token === ingestSecret) {
    const result = { valid: true, name: "remote-bot" };
    tokenCache.set(token, { ...result, ts: Date.now() });
    return result;
  }

  if (!LICENSE_SERVER_URL) {
    return { valid: false, name: "" };
  }

  try {
    const res = await fetch(`${LICENSE_SERVER_URL.replace(/\/+$/, "")}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json() as any;
    const result = { valid: !!body.valid, name: body.user_name || "" };
    tokenCache.set(token, { ...result, ts: Date.now() });
    return result;
  } catch {
    return { valid: false, name: "" };
  }
}

function extractIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";
  return raw.replace(/^::ffff:/, "");
}

// -- IP Access Logging -------------------------------------------------------
function logAccess(ip: string, route: string): void {
  const entry = `${new Date().toISOString()},${ip},${route}\n`;
  try {
    appendFileSync(join(ROOT, "data", "access_log.csv"), entry);
  } catch { /* ignore write errors */ }
}

// Convert ISO UTC timestamp to local YYYY-MM-DD string (for day grouping)
function toLocalDateStr(isoTs: string): string {
  const d = new Date(isoTs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* ---------- data helpers ---------- */

// ArbTrade = shared ArbTradeRecord + transient dashboard-only fields
interface ArbTrade extends ArbTradeRecord {
  _warnings?: string[];
  _maxShares?: number;     // max profitable shares from depth opp
  _maxPnl?: number;        // projected P&L at full depth
  _maxCost?: number;       // total investable USD at full depth
}

interface DepthOpp {
  ts: string;
  match: string;
  dir: string;
  outcome: "executed" | "aborted";
  maxProfitableShares: number;
  maxInvestableUsd: number;
  projectedPnlUsd: number;
}

interface HedgeEntry {
  position: {
    heldExchange: string;
    pmLeg: { outcome: string; tokenId: string };
    pmOppLeg: { outcome: string; tokenId: string } | null;
    pmCostBasis: number;
    kalLeg: { ticker: string; surname: string; yesAsk: number; noAsk: number };
    kalCostBasis: number;
    kalSide: string;
    sharesHeld: number;
    initialShares: number;
    initialCost: number;
    hedgeFillCost: number;
  };
  activeOrders: Array<[string, {
    role: string;
    exchange: string;
    orderId: string;
    price: number;
    shares: number;
    filledSoFar: number;
    placedAt: number;
  }]>;
}

/** Unified backfill detection: catches both legacy `backfill-*` IDs and the
 *  newer `arb-backfill-*` IDs / `serverId` tags used by ttReconcile auto-backfill
 *  and the standalone backfill scripts. Previous code only matched `startsWith("backfill")`,
 *  which leaks every `arb-backfill-pm-*` / `arb-backfill-kal-*` record into bot P&L stats. */
function isBackfillTrade(t: ArbTrade): boolean {
  if (!t) return false;
  const id = t.id || "";
  if (id.startsWith("backfill") || id.startsWith("arb-backfill")) return true;
  const sid = (t as unknown as { serverId?: string }).serverId;
  if (sid === "backfill" || sid === "auto-backfill") return true;
  return false;
}

function validateTrade(t: ArbTrade): string[] {
  const w: string[] = [];
  // 1. Cost sum mismatch
  //    For pm-hedged trades (kalCost=0, initialExchange=pm): pmCost already includes
  //    the hedge cost (initial PM + PM opposite token combined). hedgeCost is display-only.
  //    For kal-hedged trades (pmCost=0, initialExchange=kal): kalCost already includes hedge.
  //    Only add hedgeCost when it's NOT already baked into the primary cost field.
  const isPmHedged = t.kalCost === 0 && t.initialExchange === "pm" && (t.hedgeCost ?? 0) > 0;
  const isKalHedged = t.pmCost === 0 && t.initialExchange === "kal" && (t.hedgeCost ?? 0) > 0;
  // Historical inconsistency: totalCost has been computed with 4 different
  // fee-inclusion patterns across the codebase's evolution:
  //   1. no fees                           (older trades)
  //   2. + kalFees only                    (mid-era)
  //   3. + pmFees only                     (brief phase)
  //   4. + kalFees + pmFees                (current, post-2026-04-17 fix)
  // Accept any of the 4 patterns within tolerance. Only warn if totalCost
  // doesn't match ANY plausible formula — then it's a real bug.
  const k = t.kalCost ?? 0;
  const kf = t.kalFees ?? 0;
  const p = t.pmCost ?? 0;
  const pf = t.pmFees ?? 0;
  const tc = t.totalCost ?? 0;
  const feeTolerance = 0.05;
  const candidateSums = [k + p, k + kf + p, k + p + pf, k + kf + p + pf];
  const bestDelta = Math.min(...candidateSums.map(c => Math.abs(c - tc)));
  if (!isPmHedged && !isKalHedged && bestDelta > feeTolerance) {
    w.push("cost-sum-mismatch: kalCost+pmCost+fees != totalCost (off by $" +
      bestDelta.toFixed(2) + ")");
  }
  // 2. Hedge-complete P&L check
  if (t.resolutionMethod === "hedge-complete" && t.realizedPnl != null) {
    const expected = t.shares - t.totalCost;
    if (Math.abs(t.realizedPnl - expected) > 0.05) {
      w.push("pnl-mismatch: realizedPnl=$" + t.realizedPnl.toFixed(2) +
        " but shares-totalCost=$" + expected.toFixed(2));
    }
  }
  // 3. Missing cost on resolved non-backfill
  //    Exception: PM-initial hedge-complete trades can legitimately have kalCost=0
  //    when the hedge went entirely to PM opposite token (no KAL trade needed).
  //    Similarly, KAL-initial trades can have pmCost=0 if hedge went to KAL NO.
  if (t.status === "resolved" && !isBackfillTrade(t)) {
    const isPmOppHedge = t.resolutionMethod === "hedge-complete" && t.initialExchange === "pm" && t.kalCost === 0;
    const isKalOppHedge = t.resolutionMethod === "hedge-complete" && t.initialExchange === "kal" && t.pmCost === 0;
    if (t.kalCost === 0 && t.kalFillPrice === 0 && t.resolutionMethod !== "settlement" && t.resolutionMethod !== "market-settled" && !isPmOppHedge) {
      w.push("missing-kal-cost");
    }
    if (t.pmCost === 0 && t.pmFillPrice === 0 && t.resolutionMethod !== "settlement" && !isKalOppHedge) {
      w.push("missing-pm-cost");
    }
  }
  // 4. Fill price vs cost divergence (>10%)
  //    kalCost includes fees, so small divergence from shares*kalFillPrice is normal.
  //    Threshold at 10% catches real bugs while tolerating typical Kalshi fees (~3-5%).
  if (t.shares > 0 && t.kalFillPrice > 0 && t.kalCost > 0) {
    const expected = t.shares * t.kalFillPrice;
    if (Math.abs(expected - t.kalCost) / t.kalCost > 0.10) {
      w.push("kal-price-cost-divergence: " + t.shares + "*" + t.kalFillPrice.toFixed(3) +
        "=$" + expected.toFixed(2) + " vs kalCost=$" + t.kalCost.toFixed(2));
    }
  }
  // Skip pm-price check for pm-hedged trades: pmFillPrice is the initial leg price,
  // but pmCost includes initial + hedge combined — divergence is expected.
  if (t.shares > 0 && t.pmFillPrice > 0 && t.pmCost > 0 && !isPmHedged) {
    const expected = t.shares * t.pmFillPrice;
    if (Math.abs(expected - t.pmCost) / t.pmCost > 0.10) {
      w.push("pm-price-cost-divergence: " + t.shares + "*" + t.pmFillPrice.toFixed(3) +
        "=$" + expected.toFixed(2) + " vs pmCost=$" + t.pmCost.toFixed(2));
    }
  }
  // 5. Unreasonable P&L (with tolerance for floating point)
  if (t.realizedPnl != null) {
    if (t.realizedPnl > t.shares + 0.0001) w.push("pnl-out-of-range: pnl > shares");
    if (t.totalCost > 0 && t.realizedPnl < -(t.totalCost + 0.0001)) w.push("pnl-out-of-range: pnl < -totalCost");
  }
  return w;
}

function loadDepthOpps(): DepthOpp[] {
  const p = join(ROOT, "data", "depth_opportunities.json");
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return []; }
}

function loadTrades(): ArbTrade[] {
  const p = join(ROOT, "data", "arb_trades.json");
  if (!existsSync(p)) return [];
  try {
    const all: ArbTrade[] = JSON.parse(readFileSync(p, "utf8"));
    const trades = all.filter(t => t.ts >= TRADE_MIN_DATE);

    // Build lookup of executed depth opps grouped by "match|dir"
    // Then match to trades by closest timestamp within 2 minutes
    const depthOpps = loadDepthOpps().filter(d => d.outcome === "executed");
    const depthByKey = new Map<string, DepthOpp[]>();
    for (const d of depthOpps) {
      const key = d.match + "|" + d.dir;
      if (!depthByKey.has(key)) depthByKey.set(key, []);
      depthByKey.get(key)!.push(d);
    }

    for (const t of trades) {
      // Override P&L for scalar settlements using stored settlement values.
      // This prevents the bot's reconcile from reverting scalar P&L to the binary formula.
      // Only count KAL payout if we actually hold KAL contracts (kalCost > 0).
      // PM-only positions (KAL GTC failed, detect trades) get kalPayout = 0.
      if (t.scalarSettlement && t.kalSettlementValue != null && t.pmSettlementValue != null) {
        const hasKalPosition = (t.kalCost ?? 0) > 0;
        const kalPayout = hasKalPosition ? t.shares * t.kalSettlementValue : 0;
        const pmPayout = t.shares * t.pmSettlementValue;
        const scalarPnl = Math.round((kalPayout + pmPayout - t.totalCost) * 100) / 100;
        if (Math.abs((t.realizedPnl ?? 0) - scalarPnl) > 0.05) {
          t.realizedPnl = scalarPnl;
        }
      }
      // Attach depth opportunity data (max potential) -- find closest opp within 2 min
      // Skip scalar-settled trades -- match was cancelled, depth is irrelevant
      if (!t.scalarSettlement) {
        const key = t.match + "|" + t.dir;
        const candidates = depthByKey.get(key);
        if (candidates) {
          const tradeMs = new Date(t.ts).getTime();
          let best: DepthOpp | null = null;
          let bestDelta = Infinity;
          for (const c of candidates) {
            const delta = Math.abs(new Date(c.ts).getTime() - tradeMs);
            if (delta < bestDelta && delta < 120_000) { bestDelta = delta; best = c; }
          }
          if (best && best.maxProfitableShares > t.shares) {
            t._maxShares = Math.round(best.maxProfitableShares);
            t._maxPnl = best.projectedPnlUsd;
            t._maxCost = best.maxInvestableUsd;
          }
        }
      }
      const w = validateTrade(t);
      if (w.length > 0) t._warnings = w;
    }
    return trades;
  } catch { return []; }
}

function loadHedges(): HedgeEntry[] {
  const p = join(ROOT, "hedge_state.json");
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(raw) ? raw : [raw];
  } catch { return []; }
}

function loadMetrics(): ExecMetric[] {
  const p = join(ROOT, "data", "execution_metrics.json");
  if (!existsSync(p)) return [];
  try {
    const all: ExecMetric[] = JSON.parse(readFileSync(p, "utf8"));
    return all.filter(m => m.ts >= TRADE_MIN_DATE);
  } catch { return []; }
}

function computeExecStats(metrics: ExecMetric[]) {
  // Separate live vs dry-run metrics -- stats computed from live only
  const live = metrics.filter(m => !m.dryRun);
  const dryRunCount = metrics.length - live.length;

  const total = live.length;
  const bothFilled = live.filter(m => m.outcome === "both-filled").length;
  const hedgeEntry = live.filter(m => m.outcome === "hedge-entry").length;
  const aborts = total - bothFilled - hedgeEntry;

  const fillRate = total > 0 ? bothFilled / total : 0;

  const successes = live.filter(m => m.outcome === "both-filled");
  const avgTotalMs = successes.length > 0 ? successes.reduce((s, m) => s + m.totalMs, 0) / successes.length : 0;
  const avgFirstLegMs = successes.length > 0 ? successes.reduce((s, m) => s + m.firstLegOrderMs + m.firstLegConfirmMs, 0) / successes.length : 0;
  const avgSecondLegMs = successes.length > 0 ? successes.reduce((s, m) => s + m.secondLegOrderMs + m.secondLegConfirmMs, 0) / successes.length : 0;
  const avgPreflightMs = successes.length > 0 ? successes.reduce((s, m) => s + (m.preflightMs ?? 0), 0) / successes.length : 0;
  const avgDepthMs = successes.length > 0 ? successes.reduce((s, m) => s + (m.depthCheckMs ?? 0), 0) / successes.length : 0;
  const avgVerifyMs = successes.length > 0 ? successes.reduce((s, m) => s + (m.postVerifyMs ?? 0), 0) / successes.length : 0;

  const reasons: Record<string, number> = {};
  for (const m of live) {
    if (m.failReason) reasons[m.failReason] = (reasons[m.failReason] ?? 0) + 1;
  }
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // Last 10 shows all metrics (live + dry-run) so you can see both
  const last10 = metrics.slice(-10).reverse();

  const attempts = bothFilled + hedgeEntry;
  return { total, bothFilled, hedgeEntry, aborts, attempts, fillRate, avgTotalMs, avgFirstLegMs, avgSecondLegMs, avgPreflightMs, avgDepthMs, avgVerifyMs, topReasons, last10, dryRunCount };
}

function computeStats(trades: ArbTrade[]) {
  let totalRealizedPnl = 0;
  let botRealizedPnl = 0;
  let backfillRealizedPnl = 0;
  let winCount = 0;
  let lossCount = 0;
  let capitalDeployed = 0;
  let activeTrades = 0;
  let resolvedTrades = 0;
  let hedgeCompleteTrades = 0;
  let bothLegsTrades = 0;
  let scalarCount = 0;
  let scalarPnlImpact = 0;
  let totalMaxPnl = 0;
  let missedPnl = 0;
  let totalKalFees = 0;
  let makerFills = 0;
  let takerFills = 0;
  let makerFees = 0;
  let takerFees = 0;

  for (const t of trades) {
    const isBackfill = isBackfillTrade(t);
    if (t._maxPnl != null) {
      totalMaxPnl += t._maxPnl;
      missedPnl += t._maxPnl - (t.realizedPnl ?? 0);
    }
    if (t.scalarSettlement) {
      scalarCount++;
      // Impact = what binary P&L would have been minus actual scalar P&L
      const binaryPnl = t.shares - t.totalCost;
      scalarPnlImpact += (t.realizedPnl ?? 0) - binaryPnl;
    }
    if (t.realizedPnl != null) {
      totalRealizedPnl += t.realizedPnl;
      if (isBackfill) backfillRealizedPnl += t.realizedPnl;
      else botRealizedPnl += t.realizedPnl;
    }
    // Count W/L only for resolved trades (so even = resolved - wins - losses >= 0)
    if (t.status === "resolved" && t.realizedPnl != null) {
      if (t.realizedPnl > 0) winCount++;
      else if (t.realizedPnl < 0) lossCount++;
    }
    if (t.status === "hedging" || t.status === "filled") {
      capitalDeployed += t.totalCost;
      activeTrades++;
    }
    if (t.status === "resolved") resolvedTrades++;
    if (t.resolutionMethod === "hedge-complete") hedgeCompleteTrades++;
    if (t.resolutionMethod === "both-legs") bothLegsTrades++;
    if (t.kalFees != null && t.kalFees > 0) {
      totalKalFees += t.kalFees;
      if (t.kalMakerFill) { makerFills++; makerFees += t.kalFees; }
      else { takerFills++; takerFees += t.kalFees; }
    }
  }

  const resolvedWithPnl = trades.filter(t => t.realizedPnl != null).length;
  return {
    totalTrades: trades.length,
    activeTrades,
    resolvedTrades,
    totalRealizedPnl,
    botRealizedPnl,
    backfillRealizedPnl,
    capitalDeployed,
    winCount,
    lossCount,
    avgPnlPerTrade: resolvedWithPnl > 0 ? totalRealizedPnl / resolvedWithPnl : 0,
    hedgeCompleteTrades,
    bothLegsTrades,
    scalarCount,
    scalarPnlImpact,
    totalMaxPnl,
    missedPnl,
    totalKalFees,
    makerFills,
    takerFills,
    makerFees,
    takerFees,
  };
}

/* ---------- Live orderbook websocket manager ---------- */

// Kalshi auth helpers (same as kalshiTrade.ts)
let _kalPrivateKey: string | null = null;
function kalshiPrivateKey(): string {
  if (_kalPrivateKey) return _kalPrivateKey;
  if (process.env.KALSHI_PRIVATE_KEY) {
    _kalPrivateKey = process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  } else {
    const p = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (p && existsSync(p)) _kalPrivateKey = readFileSync(p, "utf8");
  }
  return _kalPrivateKey ?? "";
}

function kalshiSign(method: string, path: string, timestamp: string): string {
  const pk = kalshiPrivateKey();
  if (!pk) return "";
  const data = `${timestamp}${method.toUpperCase()}${path}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer.sign({ key: pk, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

// Live orderbook state per subscription
type BookLevel = [number, number]; // [priceCents, size]
interface LiveBook {
  yes: Map<number, number>; // priceCents -> size
  no: Map<number, number>;
  lastUpdate: number;
}

// Active subscriptions
const kalshiBooks = new Map<string, LiveBook>(); // ticker -> book
const pmBooks = new Map<string, { bids: Map<number, number>; asks: Map<number, number>; lastUpdate: number }>(); // tokenId -> book

let kalshiWs: WebSocket | null = null;
let kalshiWsReady = false;
let kalshiSubId = 0;
const kalshiSubscribedTickers = new Set<string>();
let kalshiPingTimer: ReturnType<typeof setInterval> | null = null;

let pmWs: WebSocket | null = null;
let pmWsReady = false;
const pmSubscribedTokens = new Set<string>();
let pmPingTimer: ReturnType<typeof setInterval> | null = null;

function bookToLevels(m: Map<number, number>): BookLevel[] {
  const levels: BookLevel[] = [];
  for (const [price, size] of m) {
    if (size > 0) levels.push([price, size]);
  }
  return levels.sort((a, b) => a[0] - b[0]);
}

// --- Kalshi WebSocket ---------------------------------------------------------

function connectKalshiWs() {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId || !kalshiPrivateKey()) {
    console.log("[OB-WS] Kalshi API keys not configured, skipping WS");
    return;
  }

  const wsUrl = "wss://api.elections.kalshi.com/trade-api/ws/v2";
  const ts = Date.now().toString();
  const sig = kalshiSign("GET", "/trade-api/ws/v2", ts);

  kalshiWs = new WebSocket(wsUrl, {
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": ts,
    },
  });

  kalshiWs.on("open", () => {
    console.log("[OB-WS] Kalshi connected");
    kalshiWsReady = true;
    // Re-subscribe to any active tickers
    for (const ticker of kalshiSubscribedTickers) {
      kalshiSubscribe(ticker);
    }
    // Keepalive ping every 30s
    if (kalshiPingTimer) clearInterval(kalshiPingTimer);
    kalshiPingTimer = setInterval(() => { kalshiWs?.ping(); }, 30000);
  });

  kalshiWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "orderbook_snapshot") {
        const ticker = msg.msg?.market_ticker;
        if (!ticker) return;
        const book: LiveBook = { yes: new Map(), no: new Map(), lastUpdate: Date.now() };
        for (const [p, s] of (msg.msg.yes_dollars_fp || msg.msg.yes || [])) {
          const cents = Math.round(Number(p) * (String(p).includes(".") && Number(p) < 1.5 ? 100 : 1));
          book.yes.set(cents, Number(s));
        }
        for (const [p, s] of (msg.msg.no_dollars_fp || msg.msg.no || [])) {
          const cents = Math.round(Number(p) * (String(p).includes(".") && Number(p) < 1.5 ? 100 : 1));
          book.no.set(cents, Number(s));
        }
        kalshiBooks.set(ticker, book);
      } else if (msg.type === "orderbook_delta") {
        const ticker = msg.msg?.market_ticker;
        if (!ticker) return;
        let book = kalshiBooks.get(ticker);
        if (!book) { book = { yes: new Map(), no: new Map(), lastUpdate: Date.now() }; kalshiBooks.set(ticker, book); }
        const side = msg.msg.side === "no" ? book.no : book.yes;
        const priceDollars = Number(msg.msg.price_dollars || msg.msg.price || 0);
        const cents = Math.round(priceDollars * 100);
        const delta = Number(msg.msg.delta_fp || msg.msg.delta || 0);
        const current = side.get(cents) || 0;
        const newSize = current + delta;
        if (newSize <= 0) side.delete(cents);
        else side.set(cents, newSize);
        book.lastUpdate = Date.now();
      }
    } catch { /* ignore parse errors */ }
  });

  kalshiWs.on("close", () => {
    console.log("[OB-WS] Kalshi disconnected, reconnecting in 3s...");
    kalshiWsReady = false;
    if (kalshiPingTimer) clearInterval(kalshiPingTimer);
    setTimeout(connectKalshiWs, 3000);
  });

  kalshiWs.on("error", (err) => {
    console.error("[OB-WS] Kalshi error:", err.message);
  });
}

function kalshiSubscribe(ticker: string) {
  kalshiSubscribedTickers.add(ticker);
  if (!kalshiWsReady || !kalshiWs) return;
  kalshiSubId++;
  kalshiWs.send(JSON.stringify({
    id: kalshiSubId,
    cmd: "subscribe",
    params: { channels: ["orderbook_delta"], market_ticker: ticker },
  }));
}

function kalshiUnsubscribe(ticker: string) {
  kalshiSubscribedTickers.delete(ticker);
  kalshiBooks.delete(ticker);
  // Unsubscribe is handled by reconnection cycle
}

// --- Polymarket WebSocket -----------------------------------------------------

function connectPmWs() {
  pmWs = new WebSocket("wss://ws-subscriptions-clob.polymarket.com/ws/market");

  pmWs.on("open", () => {
    console.log("[OB-WS] Polymarket connected");
    pmWsReady = true;
    // Batch re-subscribe all active tokens in one message
    if (pmSubscribedTokens.size > 0) {
      pmWs!.send(JSON.stringify({ assets_ids: [...pmSubscribedTokens], type: "market" }));
    }
    // Keepalive ping every 10s (PM requires it)
    if (pmPingTimer) clearInterval(pmPingTimer);
    pmPingTimer = setInterval(() => {
      if (pmWs?.readyState === WebSocket.OPEN) pmWs.send("PING");
    }, 10000);
  });

  pmWs.on("message", (raw) => {
    try {
      const str = raw.toString();
      if (str === "PONG") return;
      const msgs = JSON.parse(str);
      // PM sends arrays of events
      const events = Array.isArray(msgs) ? msgs : [msgs];
      for (const evt of events) {
        if (evt.event_type === "book") {
          const tokenId = evt.asset_id;
          if (!tokenId) continue;
          let book = pmBooks.get(tokenId);
          if (!book) { book = { bids: new Map(), asks: new Map(), lastUpdate: Date.now() }; pmBooks.set(tokenId, book); }
          book.bids.clear();
          book.asks.clear();
          if (Array.isArray(evt.bids)) {
            for (const l of evt.bids) {
              const price = Math.round(Number(l.price) * 100);
              const size = Number(l.size);
              if (price > 0 && size > 0) book.bids.set(price, size);
            }
          }
          if (Array.isArray(evt.asks)) {
            for (const l of evt.asks) {
              const price = Math.round(Number(l.price) * 100);
              const size = Number(l.size);
              if (price > 0 && size > 0) book.asks.set(price, size);
            }
          }
          book.lastUpdate = Date.now();
        } else if (evt.event_type === "price_change") {
          // price_changes[] has per-entry asset_id
          for (const ch of (evt.price_changes || [])) {
            const aid = ch.asset_id || evt.asset_id;
            if (!aid) continue;
            let book = pmBooks.get(aid);
            if (!book) { book = { bids: new Map(), asks: new Map(), lastUpdate: Date.now() }; pmBooks.set(aid, book); }
            const side = ch.side === "BUY" ? book.bids : book.asks;
            const price = Math.round(Number(ch.price) * 100);
            const size = Number(ch.size);
            if (size <= 0) side.delete(price);
            else side.set(price, size);
            book.lastUpdate = Date.now();
          }
        }
      }
    } catch { /* ignore */ }
  });

  pmWs.on("close", () => {
    pmWsReady = false;
    pmWs = null;
    if (pmPingTimer) clearInterval(pmPingTimer);
    if (pmSubscribedTokens.size > 0) {
      console.log("[OB-WS] Polymarket disconnected, reconnecting in 3s...");
      setTimeout(connectPmWs, 3000);
    } else {
      console.log("[OB-WS] Polymarket disconnected, no active subs -- idle");
    }
  });

  pmWs.on("error", (err) => {
    console.error("[OB-WS] Polymarket error:", err.message);
  });
}

function pmSubscribe(tokenId: string) {
  pmSubscribedTokens.add(tokenId);
  // Lazily connect PM WS on first subscription
  if (!pmWs) { connectPmWs(); return; }
  if (!pmWsReady) return;
  pmWs.send(JSON.stringify({
    assets_ids: [tokenId],
    type: "market",
  }));
}

function pmUnsubscribe(tokenId: string) {
  pmSubscribedTokens.delete(tokenId);
  pmBooks.delete(tokenId);
}

// Start WS connections (PM connects lazily on first subscription)
connectKalshiWs();

/* ---------- Position Audit ---------- */

interface AuditDiscrepancy {
  type: "kal-share-mismatch" | "pm-share-mismatch" | "kal-cost-mismatch" | "pm-cost-mismatch"
    | "untracked-kal-fills" | "untracked-pm-fills" | "orphaned-kal-position" | "orphaned-pm-position";
  severity: "error" | "warning" | "info";
  ticker?: string;
  tokenId?: string;
  match?: string;
  tradeId?: string;
  detail: string;
  exchangeValue?: number;
  dashboardValue?: number;
}

interface AuditResult {
  ts: string;
  durationMs: number;
  kalFillCount: number;
  pmFillCount: number;
  tradeCount: number;
  cutoffDate: string;
  discrepancies: AuditDiscrepancy[];
  summary: { errors: number; warnings: number; info: number };
}

let _auditCache: AuditResult | null = null;
let _auditRunning = false;
const AUDIT_CACHE_MS = 5 * 60 * 1000; // 5 min cache

// ClobTrade imported from types.ts

async function runAudit(): Promise<AuditResult> {
  const t0 = Date.now();
  // Merge local + all remote-bot ingested trades (deduped by id). Without this,
  // the audit compares exchange fills against ONLY the local dashboard's journal
  // — and when the real bot runs on a VPS that pushes via /api/ingest, every
  // legitimate trade shows up as "untracked-kal-fills" / "untracked-pm-fills"
  // because the local arb_trades.json doesn't have them yet. Mirrors the merge
  // in /api/trades.
  const local = loadTrades();
  const seen = new Set(local.map(t => t.id));
  const merged: ArbTrade[] = [...local];
  for (const data of remoteUsers.values()) {
    for (const rt of (data.trades || [])) {
      if (!seen.has(rt.id)) { merged.push(rt as ArbTrade); seen.add(rt.id); }
    }
  }
  const allTrades = merged;
  // Only audit trades on or after the cutoff date
  const trades = allTrades.filter(t => t.ts >= AUDIT_CUTOFF_DATE);
  const discrepancies: AuditDiscrepancy[] = [];

  // -- 1. Fetch Kalshi fills (filtered to cutoff date) ----------------------
  let kalFills: KalFill[] = [];
  try {
    const allKalFills = await fetchAllKalshiFills();
    kalFills = allKalFills.filter(f => !f.ts || f.ts >= AUDIT_CUTOFF_DATE);
  } catch (e) {
    discrepancies.push({ type: "untracked-kal-fills", severity: "error", detail: `Failed to fetch Kalshi fills: ${(e as Error).message}` });
  }

  // Group Kalshi fills by ticker
  const kalByTicker = new Map<string, { yesBought: number; noBought: number; yesSold: number; noSold: number; totalCost: number; totalFees: number; fills: KalFill[] }>();
  for (const f of kalFills) {
    if (!kalByTicker.has(f.ticker)) kalByTicker.set(f.ticker, { yesBought: 0, noBought: 0, yesSold: 0, noSold: 0, totalCost: 0, totalFees: 0, fills: [] });
    const g = kalByTicker.get(f.ticker)!;
    g.fills.push(f);
    const price = f.side === "yes" ? f.yesPrice : f.noPrice;
    if (f.action === "buy" && f.side === "yes") { g.yesBought += f.count; g.totalCost += f.count * price / 100; }
    else if (f.action === "buy" && f.side === "no") { g.noBought += f.count; g.totalCost += f.count * price / 100; }
    else if (f.action === "sell" && f.side === "yes") { g.yesSold += f.count; }
    else if (f.action === "sell" && f.side === "no") { g.noSold += f.count; }
    g.totalFees += f.feeCost;
  }

  // -- 2. Fetch PM CLOB trades -----------------------------------------------
  let pmFills: ClobTrade[] = [];
  try {
    const pk = process.env.POLY_WALLET_PRIVATE_KEY;
    if (pk) {
      const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
      const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
      const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
      const funder = process.env.POLY_FUNDER;
      const wallet = new Wallet(pk);
      const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
      const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
      const allPmFills = (await client.getTrades()) as unknown as ClobTrade[];
      // Filter PM fills to cutoff date
      const cutoffEpoch = new Date(AUDIT_CUTOFF_DATE).getTime() / 1000;
      pmFills = allPmFills.filter(ct => {
        if (!ct.match_time) return true; // keep if no timestamp
        const mt = Number(ct.match_time);
        // match_time could be unix seconds or ISO string
        if (mt > 1000000000) return mt >= cutoffEpoch; // unix seconds
        return ct.match_time >= AUDIT_CUTOFF_DATE; // ISO string
      });
    }
  } catch (e) {
    discrepancies.push({ type: "untracked-pm-fills", severity: "error", detail: `Failed to fetch PM trades: ${(e as Error).message}` });
  }

  // Group PM fills by asset_id (only BUY + CONFIRMED)
  // IMPORTANT: The CLOB API can return one trade entry per maker match. The size field
  // may be the FULL order size (not per-maker partial). When maker_orders is present,
  // always use matched_amount to avoid double-counting across multiple entries.
  // For MAKER trades: sum only our maker fills. For TAKER trades: sum all maker fills.
  const ourAddresses = new Set<string>();
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  if (pk) {
    const w = new Wallet(pk);
    ourAddresses.add(w.address.toLowerCase());
  }
  const funder = process.env.POLY_FUNDER;
  if (funder) ourAddresses.add(funder.toLowerCase());

  // Dedup CLOB trades: the API can return duplicate entries (e.g., one per maker match
  // for a single taker order, each with the full order size). Dedup by trade ID if available.
  const seenTradeIds = new Set<string>();
  const dedupedPmFills: typeof pmFills = [];
  for (const ct of pmFills) {
    const tid = (ct as Record<string, unknown>).id as string | undefined;
    if (tid) {
      if (seenTradeIds.has(tid)) continue;
      seenTradeIds.add(tid);
    }
    dedupedPmFills.push(ct);
  }
  if (pmFills.length !== dedupedPmFills.length) {
    console.log(`[AUDIT] Deduped PM fills: ${pmFills.length} -> ${dedupedPmFills.length} (removed ${pmFills.length - dedupedPmFills.length} duplicates)`);
  }

  const pmByToken = new Map<string, { totalBought: number; totalCost: number }>();
  for (const ct of dedupedPmFills) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    // When side=BUY and trader_side=MAKER, the TAKER was buying FROM us -- we SOLD.
    // Skip these; they are not our purchases.
    if (ct.trader_side === "MAKER") continue;
    if (!pmByToken.has(ct.asset_id)) pmByToken.set(ct.asset_id, { totalBought: 0, totalCost: 0 });
    const g = pmByToken.get(ct.asset_id)!;

    const feeBps = Number(ct.fee_rate_bps ?? 0);
    {
      // We're the taker -- size is our actual fill
      const size = Number(ct.size);
      const price = Number(ct.price);
      const baseCost = size * price;
      const fee = baseCost * (feeBps / 10000);
      g.totalBought += size;
      g.totalCost += baseCost + fee;
    }
  }

  // -- 3. Fetch current exchange positions -----------------------------------
  let kalPositions = new Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>();
  try {
    kalPositions = await getKalshiPositionMap();
  } catch { /* non-critical */ }

  // -- 4. Build trade-indexed lookups ----------------------------------------
  // Group arb trades by kalTicker and pmTokenId
  const tradesByKalTicker = new Map<string, ArbTrade[]>();
  const tradesByPmToken = new Map<string, ArbTrade[]>();
  for (const t of trades) {
    if (t.kalTicker) {
      const list = tradesByKalTicker.get(t.kalTicker) ?? [];
      list.push(t);
      tradesByKalTicker.set(t.kalTicker, list);
    }
    if (t.pmTokenId) {
      const list = tradesByPmToken.get(t.pmTokenId) ?? [];
      list.push(t);
      tradesByPmToken.set(t.pmTokenId, list);
    }
  }

  // -- 5. Compare Kalshi fills vs arb trades ---------------------------------
  for (const [ticker, kal] of kalByTicker) {
    const arbTrades = tradesByKalTicker.get(ticker);
    if (!arbTrades || arbTrades.length === 0) {
      // Fills on a ticker with no arb trade record -- only flag if recent (after bot start)
      const totalBought = kal.yesBought + kal.noBought;
      const hasRecentFill = kal.fills.some(f => f.ts && f.ts >= TRADE_MIN_DATE);
      if (totalBought > 0 && hasRecentFill) {
        discrepancies.push({
          type: "untracked-kal-fills", severity: "warning", ticker,
          detail: `Kalshi has ${kal.yesBought} YES + ${kal.noBought} NO bought (cost $${kal.totalCost.toFixed(2)}) with no matching arb trade`,
          exchangeValue: totalBought, dashboardValue: 0,
        });
      }
      continue;
    }

    // Sum expected Kalshi shares from all arb trades on this ticker.
    // If kalYesFills/kalNoFills are set (from exchange reconcile), use those as the
    // "known" fill counts -- they already include over-hedge shares.
    // Otherwise infer from dir/shares/resolutionMethod.
    let dashYesBought = 0;
    let dashNoBought = 0;
    let dashKalCost = 0;
    let hasReconcileData = false;

    for (const t of arbTrades) {
      if (t.kalYesFills != null && t.kalNoFills != null) {
        // Exchange reconcile has already stored actual fill breakdown
        // For multi-trade tickers, kalYesFills/kalNoFills are the TOTAL for the ticker
        dashYesBought = t.kalYesFills;
        dashNoBought = t.kalNoFills;
        hasReconcileData = true;
      }
      dashKalCost += t.kalCost;
      // Add over-hedge cost if tracked
      if (t.overHedgeCost) dashKalCost += t.overHedgeCost;
    }

    if (!hasReconcileData) {
      // Fallback: infer from trade dir/shares
      dashYesBought = 0;
      dashNoBought = 0;
      for (const t of arbTrades) {
        const initialSide = kalSideForDir(t.dir);
        if (initialSide === "yes") dashYesBought += t.shares;
        else dashNoBought += t.shares;
        if (t.resolutionMethod === "hedge-complete" && t.hedgeCost && t.hedgeCost > 0 && t.pmCost === 0) {
          if (initialSide === "yes") dashNoBought += t.shares;
          else dashYesBought += t.shares;
        }
        // Account for known over-hedge
        if (t.overHedgeShares && t.overHedgeSide) {
          if (t.overHedgeSide === "yes") dashYesBought += t.overHedgeShares;
          else dashNoBought += t.overHedgeShares;
        }
      }
    }

    // Pre-compute over-hedge status for severity decisions
    const hasOverHedge = arbTrades.some(t => (t.overHedgeShares ?? 0) > 0);

    // Compare YES bought
    // If reconcile data exists, it was set FROM exchange fills -- any mismatch means
    // new trades happened since repair or it's a known over-hedge. Downgrade to warning.
    if (kal.yesBought !== dashYesBought) {
      const diff = kal.yesBought - dashYesBought;
      const sev = (diff > 0 && !hasReconcileData && !hasOverHedge) ? "error" : "warning";
      discrepancies.push({
        type: "kal-share-mismatch", severity: sev, ticker,
        match: arbTrades[0].match, tradeId: arbTrades[0].id,
        detail: `Kalshi YES bought: ${kal.yesBought} (exchange) vs ${dashYesBought} (dashboard). Diff: ${diff > 0 ? "+" : ""}${diff}${hasReconcileData ? " (reconcile data present)" : " untracked"}`,
        exchangeValue: kal.yesBought, dashboardValue: dashYesBought,
      });
    }

    // Compare NO bought
    if (kal.noBought !== dashNoBought) {
      const diff = kal.noBought - dashNoBought;
      const sev = (diff > 0 && !hasReconcileData && !hasOverHedge) ? "error" : "warning";
      discrepancies.push({
        type: "kal-share-mismatch", severity: sev, ticker,
        match: arbTrades[0].match, tradeId: arbTrades[0].id,
        detail: `Kalshi NO bought: ${kal.noBought} (exchange) vs ${dashNoBought} (dashboard). Diff: ${diff > 0 ? "+" : ""}${diff}${hasReconcileData ? " (reconcile data present)" : " untracked"}`,
        exchangeValue: kal.noBought, dashboardValue: dashNoBought,
      });
    }

    // Cost comparison: only flag when share counts match but cost diverges significantly.
    // When reconcile data is present and share counts match, cost differences are expected
    // (kalCost stores initial side only; hedge fills tracked separately via hedgeCost/pmCost).
    // Skip cost check if share counts already matched (no new info) or if over-hedge exists.
    const sharesMatch = kal.yesBought === dashYesBought && kal.noBought === dashNoBought;
    if (!sharesMatch && !hasOverHedge) {
      const kalTotalWithFees = Math.round((kal.totalCost + kal.totalFees) * 100) / 100;
      if (Math.abs(kalTotalWithFees - dashKalCost) > 0.50) {
        discrepancies.push({
          type: "kal-cost-mismatch", severity: "warning", ticker,
          match: arbTrades[0].match, tradeId: arbTrades[0].id,
          detail: `Kalshi cost: $${kalTotalWithFees.toFixed(2)} (exchange) vs $${dashKalCost.toFixed(2)} (dashboard). Diff: $${Math.abs(kalTotalWithFees - dashKalCost).toFixed(2)}`,
          exchangeValue: kalTotalWithFees, dashboardValue: dashKalCost,
        });
      }
    }
  }

  // -- 6. Compare PM fills vs arb trades -------------------------------------
  for (const [tokenId, pm] of pmByToken) {
    const arbTrades = tradesByPmToken.get(tokenId);
    if (!arbTrades || arbTrades.length === 0) {
      // Skip untracked PM fills -- PM data-api doesn't provide dates for easy filtering,
      // and many tokens are from testing/manual trades. Only flag large positions.
      if (pm.totalBought >= 10 && pm.totalCost >= 5) {
        discrepancies.push({
          type: "untracked-pm-fills", severity: "warning", tokenId: tokenId.slice(0, 20) + "...",
          detail: `PM has ${pm.totalBought.toFixed(0)} shares bought (cost $${pm.totalCost.toFixed(2)}) with no matching arb trade`,
          exchangeValue: pm.totalBought, dashboardValue: 0,
        });
      }
      continue;
    }

    // Sum expected PM shares from all arb trades with this token
    let dashPmShares = 0;
    let dashPmCost = 0;
    for (const t of arbTrades) {
      if (t.pmCost > 0 || t.pmFillPrice > 0) {
        dashPmShares += t.shares;
        dashPmCost += t.pmCost;
      }
    }

    // PM fills are fractional (e.g., 14.68 shares for a 13-share trade) due to CLOB partial fills.
    // Use 20% tolerance or 2 shares (whichever is larger) to avoid false positives.
    const pmShareThreshold = Math.max(2, dashPmShares * 0.20);
    const pmShareDiff = pm.totalBought - dashPmShares;
    if (Math.abs(pmShareDiff) > pmShareThreshold) {
      // PM CLOB getTrades() returns ALL lifetime fills for this token -- it mixes arb trades,
      // manual trades, testing, and crash/restart over-hedges. Per-trade attribution is unreliable.
      // Always warn (never error) since Kalshi fills are the authoritative source of truth.
      discrepancies.push({
        type: "pm-share-mismatch", severity: "warning",
        tokenId: tokenId.slice(0, 20) + "...",
        match: arbTrades[0].match, tradeId: arbTrades[0].id,
        detail: `PM bought: ${pm.totalBought.toFixed(1)} (exchange) vs ${dashPmShares} (dashboard). Diff: ${pmShareDiff > 0 ? "+" : ""}${pmShareDiff.toFixed(1)}`,
        exchangeValue: pm.totalBought, dashboardValue: dashPmShares,
      });
    }

    // PM cost: only flag large mismatches (>$1 or >15% of cost)
    if (dashPmCost > 0) {
      const pmCostDiff = Math.abs(pm.totalCost - dashPmCost);
      const pmCostPct = pmCostDiff / dashPmCost;
      if (pmCostDiff > 1.0 && pmCostPct > 0.15) {
        discrepancies.push({
          type: "pm-cost-mismatch", severity: "warning",
          tokenId: tokenId.slice(0, 20) + "...",
          match: arbTrades[0].match, tradeId: arbTrades[0].id,
          detail: `PM cost: $${pm.totalCost.toFixed(2)} (exchange) vs $${dashPmCost.toFixed(2)} (dashboard). Diff: $${pmCostDiff.toFixed(2)}`,
          exchangeValue: pm.totalCost, dashboardValue: dashPmCost,
        });
      }
    }
  }

  // -- 7. Check for orphaned exchange positions (no matching open arb trade) -
  const activeTickers = new Set<string>();
  const activeTokens = new Set<string>();
  for (const t of trades) {
    if (t.status !== "resolved") {
      if (t.kalTicker) activeTickers.add(t.kalTicker);
      if (t.pmTokenId) activeTokens.add(t.pmTokenId);
    }
  }
  // Also check hedge_state.json for active hedges
  const hedges = loadHedges();
  for (const h of hedges) {
    const p = (h as unknown as Record<string, unknown>).position as Record<string, unknown> | undefined;
    if (p) {
      const kalLeg = p.kalLeg as Record<string, unknown> | undefined;
      const pmLeg = p.pmLeg as Record<string, unknown> | undefined;
      if (kalLeg?.ticker) activeTickers.add(String(kalLeg.ticker));
      if (pmLeg?.tokenId) activeTokens.add(String(pmLeg.tokenId));
    }
  }

  // Collect tickers with known over-hedges or any resolved trade (already documented -- downgrade to warning)
  // Use allTrades (not date-filtered trades) so resolved pre-cutoff trades are recognized
  const overHedgeTickers = new Set<string>();
  const allKnownTickers = new Set<string>();
  for (const t of allTrades) {
    if (t.kalTicker) allKnownTickers.add(t.kalTicker);
    if (t.overHedgeShares && t.overHedgeShares > 0 && t.kalTicker) {
      overHedgeTickers.add(t.kalTicker);
    }
  }

  for (const [ticker, pos] of kalPositions) {
    const totalPos = pos.yesCount + pos.noCount;
    if (totalPos > 0 && !activeTickers.has(ticker)) {
      const isKnownOverHedge = overHedgeTickers.has(ticker);
      const isKnownTicker = allKnownTickers.has(ticker);
      // Skip resolved trade residuals -- Kalshi holds shares until match settles/pays out
      if (isKnownTicker || isKnownOverHedge) continue;
      // Only warn about truly unknown positions (manual trades, non-arb, etc.)
      discrepancies.push({
        type: "orphaned-kal-position", severity: "warning", ticker,
        match: tradesByKalTicker.get(ticker)?.[0]?.match,
        detail: `Kalshi position: ${pos.yesCount} YES + ${pos.noCount} NO on ${ticker} -- non-arb or manual position`,
        exchangeValue: totalPos, dashboardValue: 0,
      });
    }
  }

  const durationMs = Date.now() - t0;
  const summary = {
    errors: discrepancies.filter(d => d.severity === "error").length,
    warnings: discrepancies.filter(d => d.severity === "warning").length,
    info: discrepancies.filter(d => d.severity === "info").length,
  };

  return {
    ts: new Date().toISOString(),
    durationMs,
    kalFillCount: kalFills.length,
    pmFillCount: pmFills.length,
    tradeCount: trades.length,
    cutoffDate: AUDIT_CUTOFF_DATE,
    discrepancies,
    summary,
  };
}

/* ---------- express app ---------- */

const app = express();
app.use(express.json({ limit: "10mb" }));

// IP logging middleware
app.use((req, _res, next) => {
  const ip = extractIp(req);
  logAccess(ip, req.path);
  next();
});

// -- Multi-user ingest endpoint (bots push here) ----------------------------

app.post("/api/ingest", async (req, res) => {
  const { token, serverId, trades, metrics, timestamp } = req.body || {};
  const ip = extractIp(req);

  if (!token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  const auth = await validateIngestToken(token);
  if (!auth.valid) {
    console.warn(`[DASHBOARD] Rejected ingest from ${ip} -- invalid token`);
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  // Key the remoteUsers map by serverId when the remote bot provides one.
  // This lets multiple bots share the same ingest secret without overwriting
  // each other's entries. Falls back to token when no serverId is supplied
  // (legacy single-bot mode), and to the token itself as a last resort.
  const keyedBy = (typeof serverId === "string" && serverId) ? serverId : token;
  const displayName = (typeof serverId === "string" && serverId) ? serverId : auth.name;

  remoteUsers.set(keyedBy, {
    name: displayName,
    ip,
    trades: trades || [],
    metrics: metrics || [],
    lastSeen: timestamp || new Date().toISOString(),
  });

  console.log(`[DASHBOARD] Ingested data from "${displayName}" (${ip}): ${(trades || []).length} trades`);
  res.json({ ok: true });
});

// -- Remote users list -------------------------------------------------------

app.get("/api/remote-users", (_req, res) => {
  const users: any[] = [];
  for (const [_token, data] of remoteUsers) {
    users.push({
      name: data.name,
      ip: data.ip,
      tradeCount: data.trades.length,
      lastSeen: data.lastSeen,
    });
  }
  res.json(users);
});

// -- Remote user trades/stats ------------------------------------------------

app.get("/api/remote-trades", (req, res) => {
  const userName = req.query.user as string;
  if (!userName) { res.json([]); return; }
  for (const data of remoteUsers.values()) {
    if (data.name === userName) { res.json(data.trades); return; }
  }
  res.json([]);
});

app.get("/api/trades", (_req, res) => {
  const local = loadTrades();
  // Merge remote bot trades into the response so dashboard shows all servers
  for (const data of remoteUsers.values()) {
    for (const rt of (data.trades || [])) {
      // Deduplicate by trade ID
      if (!local.some(lt => lt.id === rt.id)) {
        local.push(rt as ArbTrade);
      }
    }
  }
  // Sort by timestamp descending (newest first)
  local.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  res.json(local);
});

// Local-only trades (no merge with remote bots). Used by the "Me (Local)" tab
// to show ONLY what this dashboard's own bot logged — complementing the "Total"
// tab (which merges everything) and per-server tabs.
app.get("/api/local-trades", (_req, res) => {
  const local = loadTrades();
  local.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  res.json(local);
});

app.get("/api/positions", (_req, res) => {
  res.json(loadHedges());
});

app.get("/api/stats", (req, res) => {
  // Merge local + all remote-bot ingested trades (deduped by id). Mirrors the
  // merge in /api/trades and runAudit so Total tab's stats match what the
  // user sees in the trade list — otherwise "OPEN POSITIONS"/"TOTAL P&L"/etc.
  // only reflect local-journal contents while the actual bot is running on VPS.
  const local = loadTrades();
  const seen = new Set(local.map(t => t.id));
  let trades: ArbTrade[] = [...local];
  for (const data of remoteUsers.values()) {
    for (const rt of (data.trades || [])) {
      if (!seen.has(rt.id)) { trades.push(rt as ArbTrade); seen.add(rt.id); }
    }
  }
  const day = req.query.day as string | undefined;
  if (day) trades = trades.filter(t => t.ts && toLocalDateStr(t.ts) === day);
  res.json(computeStats(trades));
});

app.get("/api/health", (_req, res) => {
  const trades = loadTrades();
  const warnings: { id: string; match: string; warnings: string[] }[] = [];
  for (const t of trades) {
    if (t._warnings && t._warnings.length > 0) {
      warnings.push({ id: t.id, match: t.match, warnings: t._warnings });
    }
  }
  res.json({ totalTrades: trades.length, warningCount: warnings.length, warnings });
});

app.get("/api/metrics", (_req, res) => {
  res.json(loadMetrics());
});

app.get("/api/exec-stats", (_req, res) => {
  res.json(computeExecStats(loadMetrics()));
});

app.get("/api/missed-opps", (_req, res) => {
  const metrics = loadMetrics().filter(m => !m.dryRun);
  // Missed = had positive edge but didn't result in a fill
  const missed = metrics
    .filter(m => m.outcome !== "both-filled" && m.edge > 0)
    .map(m => ({
      ts: m.ts,
      match: m.match,
      dir: m.dir,
      edge: m.edge,
      shares: m.shares,
      kalPrice: m.expectedKalPrice,
      pmPrice: m.expectedPmPrice,
      reason: m.failReason || m.outcome,
      projectedProfit: Math.round(m.shares * m.edge * 100) / 100,
    }))
    .reverse()
    .slice(0, 50);
  res.json(missed);
});

app.get("/api/reconcile-log", (_req, res) => {
  const p = join(ROOT, "data", "reconcile_audit.json");
  if (!existsSync(p)) { res.json([]); return; }
  try { res.json(JSON.parse(readFileSync(p, "utf8"))); } catch { res.json([]); }
});

app.get("/api/chain-status", (_req, res) => {
  try {
    res.json(getChainStatus());
  } catch {
    res.json({ error: "Chain module not initialized" });
  }
});

// --- Position Audit endpoint ------------------------------------------------
// Fetches real exchange fills (Kalshi + PM CLOB) and compares against arb_trades.json.
// Slow (~10-30s due to API calls), results cached for 5 minutes.
// Use ?force=1 to bypass cache.
app.get("/api/audit", async (req, res) => {
  const force = req.query.force === "1";
  if (_auditCache && !force && Date.now() - new Date(_auditCache.ts).getTime() < AUDIT_CACHE_MS) {
    res.json(_auditCache);
    return;
  }
  if (_auditRunning) {
    res.json({ status: "running", message: "Audit already in progress, please wait..." });
    return;
  }
  _auditRunning = true;
  try {
    const result = await runAudit();
    _auditCache = result;
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    _auditRunning = false;
  }
});

// --- Event-based audit endpoint (Phase 4) ------------------------------------
// Fast (~0ms, no API calls). Compares event-computed records vs arb_trades.json.
// Existing /api/audit is kept as manual fallback for ground-truth exchange verification.

app.get("/api/event-audit", (_req, res) => {
  try {
    // Reload events from disk to get latest
    loadEventsFromDisk();
    const trades = loadTrades();
    const discs = shadowCompare(trades, AUDIT_CUTOFF_DATE);

    // Compute event-based records for all trades that have events
    const tradeIds = getAllTradeIds();
    const computedRecords: ComputedTradeRecord[] = [];
    let withEvents = 0;
    let withoutEvents = 0;
    for (const t of trades) {
      if (tradeIds.includes(t.id)) {
        const computed = computeTradeFromEvents(t.id);
        if (computed) { computedRecords.push(computed); withEvents++; }
      } else {
        withoutEvents++;
      }
    }

    res.json({
      ts: new Date().toISOString(),
      totalTrades: trades.length,
      tradesWithEvents: withEvents,
      tradesWithoutEvents: withoutEvents,
      totalEvents: getAllEvents().length,
      discrepancies: discs,
      discrepancySummary: {
        errors: discs.filter(d => d.severity === "error").length,
        warnings: discs.filter(d => d.severity === "warning").length,
        info: discs.filter(d => d.severity === "info").length,
      },
      computedRecords,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// --- Event log endpoints (Phase 5) -------------------------------------------

/** All events for a specific trade. */
app.get("/api/events/:tradeId", (req, res) => {
  const events = getTradeEvents(req.params.tradeId);
  const computed = computeTradeFromEvents(req.params.tradeId);
  res.json({ tradeId: req.params.tradeId, eventCount: events.length, events, computed });
});

/** Summary of all events in the log. */
app.get("/api/events", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 200, 5000);
  const offset = parseInt(req.query.offset as string) || 0;
  const typeFilter = req.query.type as string | undefined;
  const exchangeFilter = req.query.exchange as string | undefined;

  let events = getAllEvents();
  if (typeFilter) events = events.filter(e => e.type === typeFilter);
  if (exchangeFilter) events = events.filter(e => e.exchange === exchangeFilter);

  const total = events.length;
  const page = events.slice(offset, offset + limit);

  // Summary stats
  const tradeIds = getAllTradeIds();
  const byType: Record<string, number> = {};
  for (const e of getAllEvents()) byType[e.type] = (byType[e.type] || 0) + 1;

  res.json({
    total,
    offset,
    limit,
    returned: page.length,
    uniqueTrades: tradeIds.length,
    byType,
    events: page,
  });
});

// --- Orderbook viewer endpoints ---------------------------------------------

app.get("/api/watchlist", (_req, res) => {
  const p = join(ROOT, "discovery_cache.json");
  if (!existsSync(p)) { res.json([]); return; }
  try {
    const cache = JSON.parse(readFileSync(p, "utf8"));
    // Return simplified match list for the dropdown
    const matches = (cache.watchlist || []).map((e: Record<string, unknown>) => ({
      matchCode: e.matchCode,
      pmSlug: e.pmSlug,
      date: e.date,
      kal1: e.kal1,
      kal2: e.kal2,
      pm1: e.pm1,
      pm2: e.pm2,
    }));
    res.json(matches);
  } catch { res.json([]); }
});

// -- Wallet-derived arbs view -------------------------------------------------
// Pairs live KAL positions + live PM positions via the discovery watchlist
// and returns the arb book as seen from on-chain / exchange truth. Independent
// of arb_trades.json — runs anywhere, works without the bot running.
//
// Data-flow (per CLAUDE.md DATA-FIRST Safety Invariant #9):
//   - All financial fields (shares, avg price, cost) come from live exchange
//     queries: Kalshi `/portfolio/positions`, Polymarket data-api `/positions`.
//   - No estimates, no heuristics, no arb_trades.json dependency.
//   - Discovery cache is used ONLY for pairing (kalTicker ↔ pmTokenId), not
//     for any monetary values.
app.get("/api/wallet-arbs", async (_req, res) => {
  try {
    // 1. Load discovery cache → build pairing maps
    const cachePath = join(ROOT, "discovery_cache.json");
    let watchlist: any[] = [];
    if (existsSync(cachePath)) {
      try { watchlist = JSON.parse(readFileSync(cachePath, "utf8"))?.watchlist ?? []; }
      catch { watchlist = []; }
    }
    // kalTicker → both PM legs (we accept whichever side is actually held in the wallet).
    const pairByKalTicker = new Map<string, { pmLeg: any; pmOppLeg: any; pmSlug: string; matchName: string; historical?: boolean }>();
    // pmTokenId → the paired KAL ticker/match, used to annotate unpaired PM rows when the
    // KAL leg is flat (so we can still show "this PM position belongs to Alcaraz vs Sinner").
    const pairByPmTokenId = new Map<string, { kalTicker: string; matchName: string; pmSlug: string }>();
    for (const w of watchlist) {
      if (!w.kal1 || !w.kal2 || !w.pm1 || !w.pm2) continue;
      const matchName = `${w.kal1.surname ?? ""} vs ${w.kal2.surname ?? ""}`;
      pairByKalTicker.set(w.kal1.ticker, { pmLeg: w.pm2, pmOppLeg: w.pm1, pmSlug: w.pmSlug, matchName });
      // Only set kal2 if the tickers differ. For Kalshi total markets (O/U 1.5 etc.)
      // both kal1 and kal2 point to the SAME ticker (teams are labels; the ticker
      // represents "total goes over line"). Setting both would overwrite the kal1
      // mapping with one where pmLeg = pm1 (same-direction of kal YES) instead of
      // pm2 (opposite) — breaking the "hedged" classification downstream.
      if (w.kal2.ticker !== w.kal1.ticker) {
        pairByKalTicker.set(w.kal2.ticker, { pmLeg: w.pm1, pmOppLeg: w.pm2, pmSlug: w.pmSlug, matchName });
      }
      pairByPmTokenId.set(w.pm1.tokenId, { kalTicker: w.kal1.ticker, matchName, pmSlug: w.pmSlug });
      pairByPmTokenId.set(w.pm2.tokenId, { kalTicker: w.kal2.ticker, matchName, pmSlug: w.pmSlug });
    }
    // Fallback + timestamp source: 7-day pair-history. Merged into the pair maps for
    // expired watchlist entries, AND used to attach firstSeenAt to each row so the UI
    // can sort chronologically and show position age.
    const pairHistoryMod = await import("./ARB/ttPairHistory.js");
    const pairHistory = pairHistoryMod.loadPairHistory();
    const pairHistoryByPm = pairHistoryMod.indexPairHistoryByPmTokenId(pairHistory);
    for (const [key, h] of pairHistory) {
      // keys are kalTicker for normal entries, "pm:<tokenId>" for PM-only stubs
      if (h.kalTicker && !pairByKalTicker.has(h.kalTicker)) {
        pairByKalTicker.set(h.kalTicker, {
          pmLeg: { tokenId: h.pmTokenId, outcome: h.pmOutcome },
          pmOppLeg: { tokenId: h.pairedPmTokenId || "", outcome: "" },
          pmSlug: h.pmSlug,
          matchName: h.matchName,
          historical: true,
        });
      }
      if (h.pmTokenId && !pairByPmTokenId.has(h.pmTokenId)) {
        pairByPmTokenId.set(h.pmTokenId, { kalTicker: h.kalTicker, matchName: h.matchName, pmSlug: h.pmSlug });
      }
      void key; // unused, key iteration is just for the loop
    }
    function getFirstSeenAt(kalTicker?: string, pmTokenId?: string): number | undefined {
      if (kalTicker) { const e = pairHistory.get(kalTicker); if (e) return e.firstSeenAt; }
      if (pmTokenId) { const e = pairHistoryByPm.get(pmTokenId); if (e) return e.firstSeenAt; }
      return undefined;
    }

    // Ignore list — positions the user has marked "don't monitor". Filter them out
    // of the active buckets and surface separately at the bottom of the UI.
    const ignoreMod = await import("./ARB/ttIgnoreList.js");
    const ignored = ignoreMod.loadIgnoreList();
    function isIgnored(kalTicker?: string, pmTokenId?: string): boolean {
      if (kalTicker && ignored.kalTickers.has(kalTicker)) return true;
      if (pmTokenId && ignored.pmTokenIds.has(pmTokenId)) return true;
      return false;
    }

    // 2. Fetch live KAL + PM positions + open PM orders (for hedge-in-flight detection)
    const [kalMap, pmPositionsRaw, pmOpenOrdersRaw] = await Promise.all([
      getKalshiPositionMap().catch(() => new Map()),
      (async () => {
        const funder = process.env.POLY_FUNDER;
        if (!funder) return [];
        try {
          const r = await fetch(`https://data-api.polymarket.com/positions?user=${funder}&sizeThreshold=0`);
          const j = await r.json();
          return Array.isArray(j) ? j : [];
        } catch { return []; }
      })(),
      (async () => {
        try {
          const { createPmClient } = await import("./ARB/ttPmOrders.js");
          const { client } = await createPmClient();
          const all = await (client as unknown as { getOpenOrders(p?: unknown): Promise<unknown[]> }).getOpenOrders({});
          return Array.isArray(all) ? all : [];
        } catch { return []; }
      })(),
    ]);
    // Index open PM orders by tokenId for fast hedge-info lookup per row.
    // openOrdersByToken[tokenId] = { side: "BUY"|"SELL", price, remaining, filled, total$ }
    const openOrdersByToken = new Map<string, { side: string; price: number; remaining: number; filled: number; total: number }>();
    for (const o of pmOpenOrdersRaw as Array<Record<string, unknown>>) {
      const tid = String((o as any).asset_id ?? "");
      if (!tid) continue;
      const price = Number((o as any).price ?? 0);
      const origSize = Number((o as any).original_size ?? 0);
      const sizeMatched = Number((o as any).size_matched ?? 0);
      const remaining = Math.max(0, origSize - sizeMatched);
      const existing = openOrdersByToken.get(tid);
      if (existing) {
        // Aggregate multiple orders on same token
        existing.remaining += remaining;
        existing.filled += sizeMatched;
        existing.total += origSize * price;
      } else {
        openOrdersByToken.set(tid, {
          side: String((o as any).side ?? "").toUpperCase(),
          price,
          remaining,
          filled: sizeMatched,
          total: origSize * price,
        });
      }
    }
    // Helper: given a ticker/tokenId for a naked position, find the PM tokenId that
    // would hedge it and return any matching open order. For unpaired KAL (YES), the
    // hedge is the opposite PM (pairedPmTokenId). For unpaired KAL NO, it's the
    // same-named PM (pmTokenId). For naked PM, it's the oppositeAsset token.
    function hedgeInfoForKal(ticker: string, side: "yes" | "no"): any {
      const entry = pairHistory.get(ticker);
      if (!entry) return null;
      const hedgeToken = side === "yes" ? entry.pairedPmTokenId : entry.pmTokenId;
      if (!hedgeToken) return null;
      const order = openOrdersByToken.get(hedgeToken);
      return order ? { hedgeToken, ...order } : null;
    }
    function hedgeInfoForPm(tokenId: string, oppositeAsset: string): any {
      if (!oppositeAsset) return null;
      const order = openOrdersByToken.get(oppositeAsset);
      return order ? { hedgeToken: oppositeAsset, ...order } : null;
    }

    // Build PM positions index by asset_id (tokenId)
    const pmByTokenId = new Map<string, any>();
    for (const p of pmPositionsRaw) {
      if (p?.asset && Number(p.size) > 0) pmByTokenId.set(String(p.asset), p);
    }

    // 3. Build paired rows — each PM token can be claimed by at most one KAL ticker.
    //    Two-pass: hedged pairings (opposite outcomes) get priority over same-direction ones.
    //
    //    Example: user holds KAL SAR + KAL AUR + PM SAR.
    //      - KAL AUR + PM SAR = HEDGED (opposite outcomes) → real arb, gets the PM claim
    //      - KAL SAR alone → naked unhedged, appears in unpairedKal
    //    Previous single-pass logic created TWO paired rows sharing the same 7.25 PM SAR shares.
    const paired: any[] = [];
    const usedKal = new Set<string>();
    const usedPm = new Set<string>();
    const IMBALANCE_TOLERANCE_USD = 2;

    function buildPairedRow(kalTicker: string, pos: any, pair: any, pmHeld: any, pairingKind: "hedged-structural" | "same-direction"): any {
      const pmTokenId = String(pmHeld.asset);
      const pmOutcome = String(pmHeld.outcome ?? "");
      const pmShares = Number(pmHeld.size ?? 0);
      const pmAvgPrice = Number(pmHeld.avgPrice ?? 0);
      const pmCost = Number(pmHeld.initialValue ?? pmShares * pmAvgPrice);

      const kalYes = pos.yesCount ?? 0;
      const kalNo = pos.noCount ?? 0;
      const kalSide: "yes" | "no" = kalYes >= kalNo ? "yes" : "no";
      const kalHeldShares = kalSide === "yes" ? kalYes : kalNo;
      const kalCost = ((pos as any).marketExposureCents ?? 0) / 100;
      const kalAvgPrice = kalHeldShares > 0 ? kalCost / kalHeldShares : 0;

      const kalTotalCost = kalCost + pmCost;
      const isStructurallyHedged = pairingKind === "hedged-structural";
      const netIfKalWins = isStructurallyHedged
        ? kalHeldShares - kalTotalCost
        : kalHeldShares + pmShares - kalTotalCost;
      const netIfPmWins = isStructurallyHedged
        ? pmShares - kalTotalCost
        : -kalTotalCost;

      const pairingType: "hedged" | "imbalanced" | "same-direction" =
        !isStructurallyHedged
          ? "same-direction"
          : Math.abs(netIfKalWins - netIfPmWins) <= IMBALANCE_TOLERANCE_USD
            ? "hedged"
            : "imbalanced";

      const pmCurrentValue = Number(pmHeld.currentValue ?? 0);
      const currentPnl = pmCurrentValue - pmCost;

      return {
        match: pair.matchName || pmHeld.title || "?",
        historicalPair: Boolean(pair.historical),
        pairingType,
        kalTicker,
        kalSide,
        kalShares: kalHeldShares,
        kalAvgPrice: Math.round(kalAvgPrice * 10000) / 10000,
        kalCost: Math.round(kalCost * 100) / 100,
        pmTokenId,
        pmOutcome,
        pmSlug: pair.pmSlug,
        pmShares: Math.round(pmShares * 100) / 100,
        pmAvgPrice: Math.round(pmAvgPrice * 10000) / 10000,
        pmCost: Math.round(pmCost * 100) / 100,
        pmCurrentValue: Math.round(pmCurrentValue * 100) / 100,
        totalCost: Math.round(kalTotalCost * 100) / 100,
        netIfKalWins: Math.round(netIfKalWins * 100) / 100,
        netIfPmWins: Math.round(netIfPmWins * 100) / 100,
        currentPnl: Math.round(currentPnl * 100) / 100,
        firstSeenAt: getFirstSeenAt(kalTicker, pmTokenId),
      };
    }

    // For each paired row we need to flip pair.pmLeg ↔ pair.pmOppLeg when the KAL position
    // is on the NO side. The watchlist encodes pmLeg as the OPPOSITE outcome from KAL YES —
    // but if we hold KAL NO, we're effectively betting the OTHER team. The "hedge" PM token
    // is then the ORIGINAL same-named PM outcome (pmOppLeg), and "same-direction" becomes
    // the opposite-named PM outcome (pmLeg). Without this flip, a KAL NO position with a
    // PM-on-the-same-team gets labeled SAME-SIDE when it's actually a real hedge.
    function resolveLegs(pair: { pmLeg: any; pmOppLeg: any }, kalSide: "yes" | "no") {
      return kalSide === "yes"
        ? { hedgeLeg: pair.pmLeg, sameDirLeg: pair.pmOppLeg }
        : { hedgeLeg: pair.pmOppLeg, sameDirLeg: pair.pmLeg };
    }
    function kalSideFor(pos: any): "yes" | "no" {
      return (pos.yesCount ?? 0) >= (pos.noCount ?? 0) ? "yes" : "no";
    }

    // Pass 1: HEDGED pairings (KAL + opposite-outcome PM). Real arbs get the PM claim.
    for (const [kalTicker, pos] of kalMap.entries()) {
      if ((pos.yesCount ?? 0) + (pos.noCount ?? 0) === 0) continue;
      const pair = pairByKalTicker.get(kalTicker);
      if (!pair) continue;
      const { hedgeLeg } = resolveLegs(pair, kalSideFor(pos));
      const pmLegHeld = pmByTokenId.get(hedgeLeg.tokenId);
      if (!pmLegHeld) continue;
      const pmTokenId = String(pmLegHeld.asset);
      if (usedPm.has(pmTokenId)) continue;
      paired.push(buildPairedRow(kalTicker, pos, pair, pmLegHeld, "hedged-structural"));
      usedKal.add(kalTicker);
      usedPm.add(pmTokenId);
    }
    // Pass 2: SAME-DIRECTION pairings (KAL + same-outcome PM). Only for kalTickers whose hedged
    // leg wasn't held and whose same-direction PM leg isn't already claimed by another row.
    for (const [kalTicker, pos] of kalMap.entries()) {
      if (usedKal.has(kalTicker)) continue;
      if ((pos.yesCount ?? 0) + (pos.noCount ?? 0) === 0) continue;
      const pair = pairByKalTicker.get(kalTicker);
      if (!pair) continue;
      const { sameDirLeg } = resolveLegs(pair, kalSideFor(pos));
      const pmOppLegHeld = pmByTokenId.get(sameDirLeg.tokenId);
      if (!pmOppLegHeld) continue;
      const pmTokenId = String(pmOppLegHeld.asset);
      if (usedPm.has(pmTokenId)) continue;
      paired.push(buildPairedRow(kalTicker, pos, pair, pmOppLegHeld, "same-direction"));
      usedKal.add(kalTicker);
      usedPm.add(pmTokenId);
    }

    // 4. Unpaired rows — held on one exchange only or no watchlist pair
    const unpairedKal: any[] = [];
    for (const [ticker, pos] of kalMap.entries()) {
      if (usedKal.has(ticker)) continue;
      const shares = (pos.yesCount ?? 0) + (pos.noCount ?? 0);
      if (shares === 0) continue;
      const yes = pos.yesCount ?? 0;
      const no = pos.noCount ?? 0;
      const side: "yes" | "no" = yes >= no ? "yes" : "no";
      const held = side === "yes" ? yes : no;
      const cost = ((pos as any).marketExposureCents ?? 0) / 100;
      const avg = held > 0 ? cost / held : 0;
      unpairedKal.push({
        exchange: "kalshi",
        ticker,
        side,
        shares: held,
        avgPrice: Math.round(avg * 10000) / 10000,
        cost: Math.round(cost * 100) / 100,
        firstSeenAt: getFirstSeenAt(ticker, undefined),
        hedgeInfo: hedgeInfoForKal(ticker, side),
      });
    }
    // 4a. Pre-fetch Kalshi market status for every paired KAL ticker we need to classify.
    // Parallel — one round-trip per unique ticker, bounded by the unpaired-PM count.
    const kalTickersToCheck = new Set<string>();
    for (const [tokenId, p] of pmByTokenId.entries()) {
      if (usedPm.has(tokenId)) continue;
      if (Number(p.size ?? 0) === 0) continue;
      const pairMeta = pairByPmTokenId.get(tokenId);
      if (pairMeta?.kalTicker) kalTickersToCheck.add(pairMeta.kalTicker);
    }
    const kalMarketStatus = new Map<string, { status: string; result: string }>();
    await Promise.all(Array.from(kalTickersToCheck).map(async (ticker) => {
      try {
        const mkt = await fetchKalshiMarket(ticker) as Record<string, unknown>;
        kalMarketStatus.set(ticker, {
          status: String(mkt.status ?? ""),
          result: String(mkt.result ?? ""),
        });
      } catch { /* network error — leave unset, classify as naked */ }
    }));

    // 4b. Build unpaired-PM rows with settlement classification.
    // pmStatus values:
    //   naked                   — PM shares, KAL market still active → genuinely unhedged
    //   settled-winner          — PM market resolved, our shares pay ~$1 → claim on-chain
    //   settled-loser           — PM market resolved, our shares pay ~$0 → worthless (sell dust or ignore)
    //   kal-settled-pm-pending  — KAL market settled, PM still open → can market-sell PM now to exit
    //   no-pair                 — no watchlist pair for this token (orphan/manual)
    const unpairedPm: any[] = [];
    for (const [tokenId, p] of pmByTokenId.entries()) {
      if (usedPm.has(tokenId)) continue;
      const shares = Number(p.size ?? 0);
      if (shares === 0) continue;
      const pairMeta = pairByPmTokenId.get(tokenId);
      const kalMkt = pairMeta?.kalTicker ? kalMarketStatus.get(pairMeta.kalTicker) : undefined;
      // Kalshi is tradable ONLY in "active" state. Everything else means the market isn't
      // accepting new orders — closed (game over), determined (result known), finalized
      // (payouts), settled, inactive, unopened. In all these, KAL can't be traded and the
      // right move for a lingering PM side is to close it into the book.
      const KAL_TRADABLE = new Set(["active"]);
      const kalStatusNorm = kalMkt ? String(kalMkt.status).toLowerCase() : "";
      const kalSettled = Boolean(kalMkt) && !KAL_TRADABLE.has(kalStatusNorm);
      const kalCanceled = kalMkt ? (kalMkt.status === "canceled" || kalMkt.status === "cancelled" || kalMkt.status === "void") : false;
      const pmRedeemable = Boolean((p as any).redeemable);
      const curPrice = Number((p as any).curPrice ?? 0);

      // PM-only hedge detection:
      //   - Both outcomes of this PM market held = $1 combined payout IF sizes match.
      //   - The opposite tokenId must NOT already be claimed by a paired arb row (usedPm),
      //     otherwise the "locked profit" coverage is already counted there.
      //   - Sizes within $2 tolerance → balanced (pm-only-hedged).
      //     Size delta > $2 → directionally imbalanced (pm-only-imbalanced) — NOT locked profit.
      const oppositeAsset = String((p as any).oppositeAsset ?? "");
      const oppositePos = oppositeAsset ? pmByTokenId.get(oppositeAsset) : undefined;
      const oppositeAvailable = Boolean(oppositePos && !usedPm.has(oppositeAsset));
      const oppositeShares = oppositeAvailable ? Number(oppositePos?.size ?? 0) : 0;
      const PM_ONLY_SIZE_TOLERANCE = 2;
      let pmOnlyBucket: "balanced" | "imbalanced" | "none" = "none";
      if (oppositeAvailable && oppositeShares > 0.5) {
        pmOnlyBucket = Math.abs(shares - oppositeShares) <= PM_ONLY_SIZE_TOLERANCE ? "balanced" : "imbalanced";
      }

      // Effectively-resolved detection: PM `redeemable` flag has latency between market
      // resolution and the flag flipping. If curPrice is extreme (< 0.02 or > 0.98), the
      // market has functionally resolved — winner shares ~= $1, loser shares ~= $0.
      // Classify as settled-winner/loser based on curPrice; the row will surface a
      // "pending redemption" note so the user knows to wait for the redeem flag.
      const curPriceLooksResolved = curPrice > 0.98 || curPrice < 0.02;
      const effectivelyResolved = pmRedeemable || curPriceLooksResolved;
      const pendingRedemption = curPriceLooksResolved && !pmRedeemable;

      let pmStatus: "naked" | "pm-only-hedged" | "pm-only-imbalanced" | "settled-winner" | "settled-loser" | "kal-settled-pm-pending" | "no-pair" | "void";
      if (!pairMeta) pmStatus = "no-pair";
      else if (kalCanceled) pmStatus = "void";
      else if (effectivelyResolved) pmStatus = curPrice >= 0.5 ? "settled-winner" : "settled-loser";
      else if (pmOnlyBucket === "balanced") pmStatus = "pm-only-hedged";
      else if (pmOnlyBucket === "imbalanced") pmStatus = "pm-only-imbalanced";
      else if (kalSettled) pmStatus = "kal-settled-pm-pending";
      else pmStatus = "naked";

      unpairedPm.push({
        exchange: "polymarket",
        tokenId,
        conditionId: String((p as any).conditionId ?? ""),
        outcome: String(p.outcome ?? ""),
        outcomeIndex: Number((p as any).outcomeIndex ?? 0),
        title: String(p.title ?? ""),
        pairedKalTicker: pairMeta?.kalTicker ?? "",
        pairedMatchName: pairMeta?.matchName ?? "",
        kalStatus: kalMkt?.status ?? "",
        kalResult: kalMkt?.result ?? "",
        pmStatus,
        pmRedeemable,
        pendingRedemption,
        negRisk: Boolean((p as any).negativeRisk),
        shares: Math.round(shares * 100) / 100,
        oppositeShares: Math.round(oppositeShares * 100) / 100,
        avgPrice: Math.round(Number(p.avgPrice ?? 0) * 10000) / 10000,
        curPrice: Math.round(curPrice * 10000) / 10000,
        cost: Math.round(Number(p.initialValue ?? 0) * 100) / 100,
        currentValue: Math.round(Number(p.currentValue ?? 0) * 100) / 100,
        firstSeenAt: getFirstSeenAt(pairMeta?.kalTicker, tokenId),
        hedgeInfo: hedgeInfoForPm(tokenId, oppositeAsset),
      });
    }

    // Upsert current wallet sightings into pair_history so future dashboard renders
    // have a firstSeenAt for every position. Also timestamps brand-new positions the
    // first time the dashboard sees them.
    try {
      const kalTickersSeen: string[] = [];
      for (const [ticker, pos] of kalMap.entries()) {
        if (((pos.yesCount ?? 0) + (pos.noCount ?? 0)) > 0) kalTickersSeen.push(ticker);
      }
      const pmTokenIdsSeen: string[] = [];
      const pmTokenMetaForUpsert = new Map<string, { matchName?: string; outcome?: string; pmSlug?: string }>();
      for (const p of pmPositionsRaw) {
        const tid = String(p?.asset ?? "");
        if (!tid || Number(p.size) <= 0) continue;
        pmTokenIdsSeen.push(tid);
        const pairMeta = pairByPmTokenId.get(tid);
        pmTokenMetaForUpsert.set(tid, {
          matchName: pairMeta?.matchName,
          outcome: String(p.outcome ?? ""),
          pmSlug: pairMeta?.pmSlug ?? String(p.slug ?? ""),
        });
      }
      pairHistoryMod.upsertWalletSightings({
        kalTickers: kalTickersSeen,
        pmTokenIds: pmTokenIdsSeen,
        pmTokenMeta: pmTokenMetaForUpsert,
      });
    } catch (e) {
      console.warn(`[wallet-arbs] upsertWalletSightings failed (non-fatal): ${(e as Error).message}`);
    }

    const totalKalCost = paired.reduce((s, r) => s + r.kalCost, 0) + unpairedKal.reduce((s, r) => s + r.cost, 0);
    const totalPmCost = paired.reduce((s, r) => s + r.pmCost, 0) + unpairedPm.reduce((s, r) => s + r.cost, 0);

    // Split unpairedPm by status so the UI can render separate buckets.
    const pmByStatus: Record<string, any[]> = {
      naked: [],
      "pm-only-hedged": [],
      "pm-only-imbalanced": [],
      "settled-winner": [],
      "settled-loser": [],
      "kal-settled-pm-pending": [],
      "no-pair": [],
      void: [],
    };
    for (const r of unpairedPm) (pmByStatus[r.pmStatus] ?? pmByStatus.naked).push(r);

    // Pull out ignored positions from every bucket and put them in a dedicated list.
    // This keeps the active tables clean while still letting the operator audit what
    // they've chosen to stop monitoring (and un-ignore with one click).
    const ignoredRows: any[] = [];
    const pairedActive = paired.filter(r => {
      if (isIgnored(r.kalTicker, r.pmTokenId)) { ignoredRows.push({ ...r, _src: "paired" }); return false; }
      return true;
    });
    const unpairedKalActive = unpairedKal.filter(r => {
      if (isIgnored(r.ticker, undefined)) { ignoredRows.push({ ...r, _src: "unpairedKal" }); return false; }
      return true;
    });
    for (const key of Object.keys(pmByStatus)) {
      const keep = [];
      for (const r of pmByStatus[key]) {
        if (isIgnored(undefined, r.tokenId)) ignoredRows.push({ ...r, _src: "unpairedPm:" + key });
        else keep.push(r);
      }
      pmByStatus[key] = keep;
    }
    paired.length = 0; paired.push(...pairedActive);
    unpairedKal.length = 0; unpairedKal.push(...unpairedKalActive);

    // Chronological sort: oldest first within each bucket, so the Wallet Arbs tab reads
    // like a timeline — newer positions appear at the bottom.
    const byAge = (a: any, b: any) => (a.firstSeenAt ?? 0) - (b.firstSeenAt ?? 0);
    paired.sort(byAge);
    unpairedKal.sort(byAge);
    unpairedPm.sort(byAge);
    for (const k of Object.keys(pmByStatus)) pmByStatus[k].sort(byAge);

    res.json({
      ts: new Date().toISOString(),
      watchlistEntries: watchlist.length,
      totals: {
        pairedArbs: paired.length,
        unpairedKal: unpairedKal.length,
        unpairedPm: unpairedPm.length,
        unpairedPmByStatus: {
          naked: pmByStatus.naked.length,
          pmOnlyHedged: pmByStatus["pm-only-hedged"].length,
          pmOnlyImbalanced: pmByStatus["pm-only-imbalanced"].length,
          winners: pmByStatus["settled-winner"].length,
          losers: pmByStatus["settled-loser"].length,
          kalSettledPmPending: pmByStatus["kal-settled-pm-pending"].length,
          noPair: pmByStatus["no-pair"].length,
          void: pmByStatus.void.length,
        },
        totalKalCost: Math.round(totalKalCost * 100) / 100,
        totalPmCost: Math.round(totalPmCost * 100) / 100,
        totalCapitalAtRisk: Math.round((totalKalCost + totalPmCost) * 100) / 100,
      },
      paired,
      unpairedKal,
      unpairedPm,
      ignored: ignoredRows,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// -- Manual-trigger PM close actions ------------------------------------------
// POST /api/pm-sell  { tokenId, shares, negRisk }     → FAK SELL at best bid
// POST /api/pm-redeem { conditionId, outcomeIndex, negRisk } → on-chain redeem
// Both respect DRY_RUN=true by default (returns what-would-happen without sending).

// ── Ignore list: POST /api/ignore + POST /api/unignore ─────────────────────
// Lets the user mark positions as "don't monitor" so they stop cluttering the
// active buckets. Ignored positions render in a separate grey section at the
// bottom of Wallet Arbs with an Unignore button.
app.post("/api/ignore", async (req, res) => {
  try {
    const { addToIgnoreList } = await import("./ARB/ttIgnoreList.js");
    const { kalTicker, pmTokenId, reason } = req.body ?? {};
    if (!kalTicker && !pmTokenId) return res.status(400).json({ error: "kalTicker or pmTokenId required" });
    const entry = addToIgnoreList({ kalTicker, pmTokenId, reason });
    res.json({ ok: true, entry });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});
app.post("/api/unignore", async (req, res) => {
  try {
    const { removeFromIgnoreList } = await import("./ARB/ttIgnoreList.js");
    const { kalTicker, pmTokenId } = req.body ?? {};
    if (!kalTicker && !pmTokenId) return res.status(400).json({ error: "kalTicker or pmTokenId required" });
    const removed = removeFromIgnoreList({ kalTicker, pmTokenId });
    res.json({ ok: removed });
  } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

// Live open orders from both exchanges. Used by the Wallet Arbs tab to show
// resting GTC bids from the hedge cycle alongside the paired-arbs view.
app.get("/api/open-orders", async (_req, res) => {
  try {
    const [kalRaw, pmRaw] = await Promise.all([
      fetchOpenKalshiOrders().catch(() => []),
      (async () => {
        try {
          const { createPmClient } = await import("./ARB/ttPmOrders.js");
          const { client } = await createPmClient();
          const all = await (client as unknown as { getOpenOrders(p?: unknown): Promise<unknown[]> }).getOpenOrders({});
          return Array.isArray(all) ? all : [];
        } catch { return []; }
      })(),
    ]);
    // Build kalTicker → match-name and pmTokenId → (matchName, outcome) lookups.
    // Walk the watchlist FIRST — it indexes both pm1 and pm2 per entry, which matters for
    // total markets where kal1.ticker === kal2.ticker (pair_history would lose one of the
    // outcomes to overwrite). Then fall back to pair_history for older entries.
    const matchNameByKalTicker = new Map<string, string>();
    const pmTokenMeta = new Map<string, { matchName: string; outcome: string }>();
    try {
      const cachePath = join(ROOT, "discovery_cache.json");
      if (existsSync(cachePath)) {
        const wl = JSON.parse(readFileSync(cachePath, "utf8")).watchlist ?? [];
        for (const w of wl) {
          const name = `${w.kal1?.surname ?? ""} vs ${w.kal2?.surname ?? ""}`;
          if (w.kal1?.ticker) matchNameByKalTicker.set(w.kal1.ticker, name);
          if (w.kal2?.ticker) matchNameByKalTicker.set(w.kal2.ticker, name);
          if (w.pm1?.tokenId) pmTokenMeta.set(w.pm1.tokenId, { matchName: name, outcome: String(w.pm1.outcome ?? "") });
          if (w.pm2?.tokenId) pmTokenMeta.set(w.pm2.tokenId, { matchName: name, outcome: String(w.pm2.outcome ?? "") });
        }
      }
    } catch { /* ignore */ }
    try {
      const { loadPairHistory } = await import("./ARB/ttPairHistory.js");
      const hist = loadPairHistory();
      for (const [kt, h] of hist) {
        if (!matchNameByKalTicker.has(kt)) matchNameByKalTicker.set(kt, h.matchName);
        if (h.pmTokenId && !pmTokenMeta.has(h.pmTokenId)) {
          pmTokenMeta.set(h.pmTokenId, { matchName: h.matchName, outcome: h.pmOutcome });
        }
      }
    } catch { /* ignore */ }

    const kal = (kalRaw as Array<{ orderId: string; ticker: string; side: string; action: string; priceCents: number; remainingCount: number; status: string }>).map(o => ({
      exchange: "kalshi",
      orderId: o.orderId,
      ticker: o.ticker,
      matchName: matchNameByKalTicker.get(o.ticker) ?? "",
      side: String(o.side ?? "").toUpperCase(),
      action: String(o.action ?? "").toUpperCase(),
      priceDollars: Math.round(((o.priceCents ?? 0) / 100) * 10000) / 10000,
      remaining: o.remainingCount ?? 0,
      status: o.status ?? "",
    }));
    const pm = (pmRaw as Array<Record<string, unknown>>).map(o => {
      const assetId = String((o as any).asset_id ?? "");
      const meta = pmTokenMeta.get(assetId);
      const price = Number((o as any).price ?? 0);
      // PM response shape: original_size + size_matched (no explicit remaining/size field).
      const origSize = Number((o as any).original_size ?? 0);
      const sizeMatched = Number((o as any).size_matched ?? 0);
      const remaining = Math.max(0, origSize - sizeMatched);
      return {
        exchange: "polymarket",
        orderId: String((o as any).id ?? (o as any).orderID ?? ""),
        tokenId: assetId,
        matchName: meta?.matchName ?? "",
        outcome: meta?.outcome ?? String((o as any).outcome ?? ""),
        side: String((o as any).side ?? "").toUpperCase(),
        priceDollars: Math.round(price * 10000) / 10000,
        remaining: Math.round(remaining * 100) / 100,
        originalSize: Math.round(origSize * 100) / 100,
        filled: Math.round(sizeMatched * 100) / 100,
        totalDollars: Math.round(origSize * price * 100) / 100,
        status: String((o as any).status ?? ""),
      };
    });
    res.json({
      ts: new Date().toISOString(),
      totals: { kalshi: kal.length, polymarket: pm.length },
      kal,
      pm,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/pm-sell", async (req, res) => {
  try {
    const { sellPmAtMarket } = await import("./ARB/ttSettleClose.js");
    const { tokenId, shares, negRisk } = req.body ?? {};
    if (!tokenId || typeof tokenId !== "string") return res.status(400).json({ error: "tokenId required" });
    if (!Number.isFinite(Number(shares)) || Number(shares) <= 0) return res.status(400).json({ error: "shares > 0 required" });
    const dryRun = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
    const result = await sellPmAtMarket({
      tokenId: String(tokenId),
      shares: Number(shares),
      negRisk: Boolean(negRisk),
      dryRun,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/pm-redeem", async (req, res) => {
  try {
    const { redeemPmWinner } = await import("./ARB/ttSettleClose.js");
    const { conditionId, outcomeIndex, negRisk } = req.body ?? {};
    if (!conditionId || typeof conditionId !== "string") return res.status(400).json({ error: "conditionId required" });
    const dryRun = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
    const result = await redeemPmWinner({
      conditionId: String(conditionId),
      outcomeIndex: Number(outcomeIndex ?? 0),
      negRisk: Boolean(negRisk),
      dryRun,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// -- Exchange-Verified P&L ----------------------------------------------------
// Queries both exchanges directly for the ground truth, ignoring arb_trades.json

interface VerifiedPnlResult {
  ts: string;
  durationMs: number;
  kalshi: {
    totalSpent: number;       // total $ spent buying contracts (incl fees)
    totalRevenue: number;     // total $ received from settlements + sells
    totalFees: number;
    netPnl: number;
    fillCount: number;
    settlementCount: number;
    openPositionValue: number; // estimated value of unsettled positions
  };
  polymarket: {
    totalSpent: number;
    totalRevenue: number;
    totalFees: number;
    netPnl: number;
    fillCount: number;
    currentBalance: number;   // USDC on chain
  };
  combined: {
    totalSpent: number;
    totalRevenue: number;
    totalFees: number;
    netPnl: number;
    openPositions: Array<{ exchange: string; ticker: string; side: string; count: number; avgPrice: number }>;
  };
  details: {
    kalshiFills: Array<{ ticker: string; action: string; side: string; count: number; price: number; fee: number; ts: string }>;
    kalshiSettlements: Array<{ ticker: string; result: string; revenue: number; cost: number; fee: number; ts: string }>;
    pmFills: Array<{ tokenId: string; side: string; size: number; price: number; fee: number; ts: string }>;
  };
  rawSamples?: {
    kalFills: any[];
    kalSettlements: any[];
    pmFills: any[];
  };
}

let verifiedPnlCache: VerifiedPnlResult | null = null;
let verifiedPnlCacheTs = 0;
const VERIFIED_PNL_CACHE_TTL = 60_000; // 1 min cache

app.get("/api/verified-pnl", async (req, res) => {
  const force = req.query.force === "1";

  if (!force && verifiedPnlCache && Date.now() - verifiedPnlCacheTs < VERIFIED_PNL_CACHE_TTL) {
    res.json(verifiedPnlCache);
    return;
  }

  const t0 = Date.now();

  // -- 0. Load bot tickers from arb_trades.json to filter exchange data -----
  const botTrades = loadTrades();
  const botKalTickers = new Set<string>();
  const botPmTokenIds = new Set<string>();
  for (const bt of botTrades) {
    if (bt.kalTicker) botKalTickers.add(bt.kalTicker);
    if (bt.pmTokenId) botPmTokenIds.add(bt.pmTokenId);
  }
  console.log(`[VERIFIED-PNL] Filtering to ${botKalTickers.size} Kalshi tickers, ${botPmTokenIds.size} PM tokens from ${botTrades.length} arb trades`);

  // -- 1. Fetch ALL Kalshi data, then filter to bot tickers -----------------
  let kalFills: KalFill[] = [];
  let kalSettlements: any[] = [];
  let kalPositions = new Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>();

  try {
    let [allFills, allSettlements, allPositions] = await Promise.all([
      fetchAllKalshiFills(),
      fetchAllKalshiSettlements(),
      getKalshiPositionMap(),
    ]);
    // Filter to only bot-traded tickers
    kalFills = allFills.filter(f => botKalTickers.has(f.ticker));
    kalSettlements = allSettlements.filter((s: any) => botKalTickers.has(s.ticker));
    // Filter positions to bot tickers
    for (const [ticker, pos] of allPositions) {
      if (botKalTickers.has(ticker)) kalPositions.set(ticker, pos);
    }
    console.log(`[VERIFIED-PNL] Kalshi: ${kalFills.length}/${allFills.length} fills, ${kalSettlements.length}/${allSettlements.length} settlements matched bot tickers`);
  } catch (e) {
    console.error(`[VERIFIED-PNL] Kalshi fetch error: ${(e as Error).message}`);
  }

  // Kalshi: total spent on buys, revenue from sells
  let kalTotalSpent = 0;
  let kalSellRevenue = 0;
  let kalTotalFees = 0;
  const kalFillDetails: VerifiedPnlResult["details"]["kalshiFills"] = [];

  for (const f of kalFills) {
    const price = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100;
    const cost = f.count * price;
    kalTotalFees += f.feeCost;

    if (f.action === "buy") {
      kalTotalSpent += cost + f.feeCost;
    } else if (f.action === "sell") {
      kalSellRevenue += cost - f.feeCost;
    }

    kalFillDetails.push({
      ticker: f.ticker,
      action: f.action,
      side: f.side,
      count: f.count,
      price: Math.round(price * 100) / 100,
      fee: Math.round(f.feeCost * 100) / 100,
      ts: f.ts,
    });
  }

  // Kalshi: revenue from settlements
  // Auto-detect units: if first settlement's revenue / yesCount > 2 it's likely cents; <= 2 it's dollars
  // (A single winning contract pays $1 = 100 cents; revenue per contract should be <= $1 = 100 cents)
  let settlementsInCents = true;
  if (kalSettlements.length > 0) {
    const sample = kalSettlements[0];
    const totalContracts = (sample.yesCount || 0) + (sample.noCount || 0);
    if (totalContracts > 0) {
      const revenuePerContract = sample.revenue / totalContracts;
      // If revenue/contract <= 1.5, it's likely already in dollars (max $1/contract)
      // If revenue/contract > 1.5, it's likely in cents (max 100 cents/contract)
      settlementsInCents = revenuePerContract > 1.5;
    }
  }
  const settDivisor = settlementsInCents ? 100 : 1;
  if (kalSettlements.length > 0) {
    const s0 = kalSettlements[0];
    console.log(`[VERIFIED-PNL] Settlement sample[0]: ticker=${s0.ticker} revenue=${s0.revenue} yesCost=${s0.yesCost} noCost=${s0.noCost} feeCost=${s0.feeCost} yesCount=${s0.yesCount} noCount=${s0.noCount} -> unit=${settlementsInCents ? "CENTS" : "DOLLARS"} divisor=${settDivisor}`);
  }

  let kalSettlementRevenue = 0;
  const kalSettlementDetails: VerifiedPnlResult["details"]["kalshiSettlements"] = [];

  for (const s of kalSettlements) {
    const revenue = s.revenue / settDivisor;
    const cost = (s.yesCost + s.noCost) / settDivisor;
    kalSettlementRevenue += revenue;

    kalSettlementDetails.push({
      ticker: s.ticker,
      result: s.marketResult,
      revenue: Math.round(revenue * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      fee: Math.round(s.feeCost * 100) / 100,
      ts: s.settledTime,
    });
  }

  // Kalshi: open positions estimated value (at avg price)
  let kalOpenPositionValue = 0;
  const openPositions: VerifiedPnlResult["combined"]["openPositions"] = [];
  for (const [ticker, pos] of kalPositions) {
    if (pos.yesCount > 0) {
      const val = pos.yesCount * (pos.avgPriceCents / 100);
      kalOpenPositionValue += val;
      openPositions.push({ exchange: "kalshi", ticker, side: "yes", count: pos.yesCount, avgPrice: pos.avgPriceCents / 100 });
    }
    if (pos.noCount > 0) {
      const val = pos.noCount * (pos.avgPriceCents / 100);
      kalOpenPositionValue += val;
      openPositions.push({ exchange: "kalshi", ticker, side: "no", count: pos.noCount, avgPrice: pos.avgPriceCents / 100 });
    }
  }

  const kalNetPnl = (kalSettlementRevenue + kalSellRevenue) - kalTotalSpent;

  // -- 2. Fetch ALL Polymarket data -----------------------------------------
  let pmFills: ClobTrade[] = [];
  let pmUsdcBalance = 0;

  try {
    const pkEnv = process.env.POLY_WALLET_PRIVATE_KEY;
    if (pkEnv) {
      const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
      const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
      const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
      const funder = process.env.POLY_FUNDER;
      const wallet = new Wallet(pkEnv);
      const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
      const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
      const allPmFills = (await client.getTrades()) as unknown as ClobTrade[];

      // Dedup by trade ID, then filter to bot tokens only
      const seenIds = new Set<string>();
      let totalPmCount = 0;
      for (const ct of allPmFills) {
        totalPmCount++;
        const tid = (ct as Record<string, unknown>).id as string | undefined;
        if (tid && seenIds.has(tid)) continue;
        if (tid) seenIds.add(tid);
        // Only include fills for tokens the bot traded
        if (botPmTokenIds.size > 0 && !botPmTokenIds.has(ct.asset_id)) continue;
        pmFills.push(ct);
      }
      console.log(`[VERIFIED-PNL] PM: ${pmFills.length}/${totalPmCount} fills matched bot tokens`);
    }
  } catch (e) {
    console.error(`[VERIFIED-PNL] PM fetch error: ${(e as Error).message}`);
  }

  try {
    const { getUsdcBalance } = await import("./polyChain.js");
    pmUsdcBalance = await getUsdcBalance();
  } catch { /* non-critical */ }

  // PM: calculate spent and revenue
  let pmTotalSpent = 0;
  let pmTotalRevenue = 0;
  let pmTotalFees = 0;
  const pmFillDetails: VerifiedPnlResult["details"]["pmFills"] = [];

  let pmDebugCount = 0;
  for (const ct of pmFills) {
    if (ct.status !== "CONFIRMED") continue;
    const size = Number(ct.size);
    const price = Number(ct.price);
    const feeBps = Number(ct.fee_rate_bps ?? 0);
    const baseCost = size * price;
    const fee = baseCost * (feeBps / 10000);

    if (pmDebugCount < 5) {
      console.log(`[VERIFIED-PNL] PM fill sample: size="${ct.size}" -> ${size}, price="${ct.price}" -> ${price}, baseCost=${baseCost.toFixed(4)}, side=${ct.side}, trader_side=${ct.trader_side}`);
      pmDebugCount++;
    }

    // Determine if we bought or sold
    // side=BUY + trader_side=TAKER -> we bought
    // side=BUY + trader_side=MAKER -> someone bought FROM us (we sold)
    // side=SELL + trader_side=TAKER -> we sold
    // side=SELL + trader_side=MAKER -> someone sold TO us (we bought)
    const weBought = (ct.side === "BUY" && ct.trader_side !== "MAKER") ||
                     (ct.side === "SELL" && ct.trader_side === "MAKER");

    if (weBought) {
      pmTotalSpent += baseCost + fee;
    } else {
      pmTotalRevenue += baseCost - fee;
    }
    pmTotalFees += fee;

    pmFillDetails.push({
      tokenId: ct.asset_id,
      side: weBought ? "BUY" : "SELL",
      size,
      price: Math.round(price * 10000) / 10000,
      fee: Math.round(fee * 100) / 100,
      ts: ct.match_time,
    });
  }

  // PM positions that settled (redeemed) show up as USDC balance increase
  // We can't easily separate settlement revenue from deposits, so PM net P&L
  // is calculated as: (current USDC + value of current positions + revenue from sells) - total spent
  const pmNetPnl = pmTotalRevenue - pmTotalSpent;

  // -- 3. Combine ----------------------------------------------------------

  const result: VerifiedPnlResult = {
    ts: new Date().toISOString(),
    durationMs: Date.now() - t0,
    kalshi: {
      totalSpent: Math.round(kalTotalSpent * 100) / 100,
      totalRevenue: Math.round((kalSettlementRevenue + kalSellRevenue) * 100) / 100,
      totalFees: Math.round(kalTotalFees * 100) / 100,
      netPnl: Math.round(kalNetPnl * 100) / 100,
      fillCount: kalFills.length,
      settlementCount: kalSettlements.length,
      openPositionValue: Math.round(kalOpenPositionValue * 100) / 100,
    },
    polymarket: {
      totalSpent: Math.round(pmTotalSpent * 100) / 100,
      totalRevenue: Math.round(pmTotalRevenue * 100) / 100,
      totalFees: Math.round(pmTotalFees * 100) / 100,
      netPnl: Math.round(pmNetPnl * 100) / 100,
      fillCount: pmFills.length,
      currentBalance: Math.round(pmUsdcBalance * 100) / 100,
    },
    combined: {
      totalSpent: Math.round((kalTotalSpent + pmTotalSpent) * 100) / 100,
      totalRevenue: Math.round((kalSettlementRevenue + kalSellRevenue + pmTotalRevenue) * 100) / 100,
      totalFees: Math.round((kalTotalFees + pmTotalFees) * 100) / 100,
      netPnl: Math.round((kalNetPnl + pmNetPnl) * 100) / 100,
      openPositions,
    },
    details: {
      kalshiFills: kalFillDetails,
      kalshiSettlements: kalSettlementDetails,
      pmFills: pmFillDetails,
    },
    rawSamples: {
      kalFills: kalFills.slice(0, 3).map(f => ({
        ticker: f.ticker, action: f.action, side: f.side, count: f.count,
        yesPrice_cents: f.yesPrice, noPrice_cents: f.noPrice, feeCost_raw: f.feeCost,
      })),
      kalSettlements: kalSettlements.slice(0, 3).map(s => ({
        ticker: s.ticker, revenue_raw: s.revenue, yesCost_raw: s.yesCost, noCost_raw: s.noCost,
        feeCost_raw: s.feeCost, yesCount: s.yesCount, noCount: s.noCount, result: s.marketResult,
        detectedUnit: settlementsInCents ? "cents" : "dollars", divisor: settDivisor,
      })),
      pmFills: pmFills.slice(0, 3).map(ct => ({
        asset_id: ct.asset_id, side: ct.side, size_raw: ct.size, price_raw: ct.price,
        fee_rate_bps: ct.fee_rate_bps, status: ct.status, trader_side: ct.trader_side,
      })),
    },
  };

  verifiedPnlCache = result;
  verifiedPnlCacheTs = Date.now();

  console.log(`[VERIFIED-PNL] Kalshi: spent=$${result.kalshi.totalSpent} rev=$${result.kalshi.totalRevenue} pnl=$${result.kalshi.netPnl} | PM: spent=$${result.polymarket.totalSpent} rev=$${result.polymarket.totalRevenue} pnl=$${result.polymarket.netPnl} | Combined: $${result.combined.netPnl} (${Date.now() - t0}ms)`);
  res.json(result);
});

// -- Per-ticker P&L map: fills (buys+sells) + settlements + open positions ----
// Captures manual sells, partial exits, and everything the exchange knows about
// Returns { [kalTicker]: { buyCost, buyCount, sellRevenue, sellCount, settlementRevenue,
//           fees, openYes, openNo, openValue, net, status } }
let settlementMapCache: Record<string, any> | null = null;
let settlementMapCacheTs = 0;

app.get("/api/settlement-map", async (_req, res) => {
  // Cache for 2 minutes
  if (settlementMapCache && Date.now() - settlementMapCacheTs < 120_000) {
    res.json(settlementMapCache);
    return;
  }

  try {
    const [fills, settlements, positions] = await Promise.all([
      fetchAllKalshiFills(),
      fetchAllKalshiSettlements(),
      getKalshiPositionMap(),
    ]);

    // Filter to bot tickers only
    const botTrades = loadTrades();
    const botTickers = new Set<string>();
    for (const bt of botTrades) {
      if (bt.kalTicker) botTickers.add(bt.kalTicker);
    }

    const map: Record<string, any> = {};

    const ensure = (ticker: string) => {
      if (!map[ticker]) {
        map[ticker] = {
          buyCost: 0, buyCount: 0, buyFees: 0,
          buyYesCount: 0, buyNoCount: 0, buyYesCost: 0, buyNoCost: 0,
          sellRevenue: 0, sellCount: 0, sellFees: 0,
          settlementRevenue: 0, settlementResult: "",
          pairRedemption: 0,
          fees: 0,
          openYes: 0, openNo: 0, openValue: 0,
          net: 0, status: "open", // open | sold | settled
        };
      }
    };

    // 1. Process all fills (buys AND sells, including manual sells)
    for (const f of fills) {
      if (!botTickers.has(f.ticker)) continue;
      ensure(f.ticker);
      const entry = map[f.ticker];
      const price = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100; // cents->dollars
      const cost = f.count * price;

      if (f.action === "buy") {
        entry.buyCost += cost;
        entry.buyCount += f.count;
        entry.buyFees += f.feeCost;
        if (f.side === "yes") { entry.buyYesCount += f.count; entry.buyYesCost += cost; }
        else { entry.buyNoCount += f.count; entry.buyNoCost += cost; }
      } else if (f.action === "sell") {
        entry.sellRevenue += cost;
        entry.sellCount += f.count;
        entry.sellFees += f.feeCost;
      }
      entry.fees += f.feeCost;
    }

    // 2. Process settlements
    // Auto-detect units
    let settDivisor = 100;
    if (settlements.length > 0) {
      const s0 = settlements[0];
      const tc = (s0.yesCount || 0) + (s0.noCount || 0);
      if (tc > 0 && s0.revenue / tc <= 1.5) settDivisor = 1; // already dollars
    }

    for (const s of settlements) {
      if (!botTickers.has(s.ticker)) continue;
      ensure(s.ticker);
      const entry = map[s.ticker];
      entry.settlementRevenue = s.revenue / settDivisor;
      entry.settlementResult = s.marketResult;
      entry.status = "settled";
    }

    // 3. Process open positions
    for (const [ticker, pos] of positions) {
      if (!botTickers.has(ticker)) continue;
      ensure(ticker);
      const entry = map[ticker];
      entry.openYes = pos.yesCount;
      entry.openNo = pos.noCount;
      // Estimate open position value at avg price
      entry.openValue = (pos.yesCount + pos.noCount) * (pos.avgPriceCents / 100);
      if (entry.status !== "settled" && (entry.sellCount > 0)) {
        entry.status = "sold";
      }
    }

    // 4. Compute net P&L per ticker
    for (const ticker of Object.keys(map)) {
      const e = map[ticker];
      // When bot buys BOTH yes and no on same ticker, Kalshi auto-redeems
      // opposing pairs at $1.00 each. This payout doesn't appear in fills or settlements.
      const pairs = Math.min(e.buyYesCount, e.buyNoCount);
      e.pairRedemption = pairs * 1.00;
      // Net = money in - money out
      // Money in: settlement payout + sell revenue + pair redemption
      // Money out: buy cost + all fees
      e.net = Math.round(((e.settlementRevenue + e.sellRevenue + e.pairRedemption) - (e.buyCost + e.fees)) * 100) / 100;
      // Round everything
      e.buyCost = Math.round(e.buyCost * 100) / 100;
      e.sellRevenue = Math.round(e.sellRevenue * 100) / 100;
      e.settlementRevenue = Math.round(e.settlementRevenue * 100) / 100;
      e.fees = Math.round(e.fees * 100) / 100;
      e.openValue = Math.round(e.openValue * 100) / 100;
    }

    console.log(`[TICKER-PNL] Built P&L for ${Object.keys(map).length} bot tickers (${fills.length} fills, ${settlements.length} settlements)`);
    settlementMapCache = map;
    settlementMapCacheTs = Date.now();
    res.json(map);
  } catch (e) {
    console.error(`[TICKER-PNL] Error: ${(e as Error).message}`);
    res.json({});
  }
});

// Subscribe to live orderbook for a match (called when user selects a match)
app.get("/api/ob-subscribe", (req, res) => {
  const tickers = (req.query.tickers as string || "").split(",").filter(Boolean);
  const tokenIds = (req.query.tokenIds as string || "").split(",").filter(Boolean);

  // Unsubscribe old tickers/tokens not in new set
  for (const t of kalshiSubscribedTickers) {
    if (!tickers.includes(t)) kalshiUnsubscribe(t);
  }
  for (const t of pmSubscribedTokens) {
    if (!tokenIds.includes(t)) pmUnsubscribe(t);
  }

  // Subscribe new
  for (const t of tickers) kalshiSubscribe(t);
  for (const t of tokenIds) pmSubscribe(t);

  res.json({
    kalshiConnected: kalshiWsReady,
    pmConnected: pmWsReady,
    kalshiSubs: tickers.length,
    pmSubs: tokenIds.length,
  });
});

// Get live orderbook state (instant -- reads from in-memory maps, no network call)
app.get("/api/orderbook", async (_req, res) => {
  const result: Record<string, unknown> = {
    ts: new Date().toISOString(),
    kalshiConnected: kalshiWsReady,
    pmConnected: pmWsReady,
  };

  // Kalshi books -- WS first, REST fallback when WS is disconnected
  const kalBooksOut: Record<string, { yes: BookLevel[]; no: BookLevel[]; age: number }> = {};
  const kalBase = "https://api.elections.kalshi.com/trade-api/v2";
  for (const ticker of kalshiSubscribedTickers) {
    const wsBook = kalshiBooks.get(ticker);
    if (wsBook && kalshiWsReady) {
      kalBooksOut[ticker] = {
        yes: bookToLevels(wsBook.yes),
        no: bookToLevels(wsBook.no),
        age: Date.now() - wsBook.lastUpdate,
      };
    } else {
      // REST fallback: public endpoint, no auth needed
      try {
        const r = await fetch(`${kalBase}/markets/${ticker}/orderbook`);
        if (r.ok) {
          const data = await r.json() as Record<string, unknown>;
          const ob = (data as { orderbook_fp?: { yes_dollars?: string[][]; no_dollars?: string[][] } }).orderbook_fp;
          const yesLevels: BookLevel[] = (ob?.yes_dollars || []).map(([p, s]: string[]) => [Math.round(Number(p) * 100), Number(s)] as BookLevel);
          const noLevels: BookLevel[] = (ob?.no_dollars || []).map(([p, s]: string[]) => [Math.round(Number(p) * 100), Number(s)] as BookLevel);
          kalBooksOut[ticker] = { yes: yesLevels, no: noLevels, age: 0 };
        }
      } catch { /* ignore REST failure */ }
    }
  }
  result.kalshi = kalBooksOut;

  // PM books
  const pmBooksOut: Record<string, { bids: BookLevel[]; asks: BookLevel[]; age: number }> = {};
  for (const [tokenId, book] of pmBooks) {
    pmBooksOut[tokenId] = {
      bids: bookToLevels(book.bids),
      asks: bookToLevels(book.asks),
      age: Date.now() - book.lastUpdate,
    };
  }
  result.pm = pmBooksOut;

  res.json(result);
});

/* ---------- HTML dashboard ---------- */

app.get("/", (_req, res) => {
  res.type("html").send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Arb Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    background: #0d1117; color: #c9d1d9; font-size: 13px;
    padding: 16px;
  }
  h1 { color: #58a6ff; font-size: 18px; margin-bottom: 4px; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; border-bottom: 1px solid #21262d; padding-bottom: 10px; }
  .refresh-info { color: #8b949e; font-size: 11px; }

  /* Summary cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .card {
    background: #161b22; border: 1px solid #21262d; border-radius: 8px;
    padding: 12px 16px;
  }
  .card-label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-value { font-size: 22px; font-weight: bold; margin-top: 4px; }
  .card-sub { color: #8b949e; font-size: 11px; margin-top: 2px; }
  .green { color: #3fb950; }
  .red { color: #f85149; }
  .yellow { color: #d29922; }
  .blue { color: #58a6ff; }
  .gray { color: #8b949e; }

  /* Section headers */
  .section-title {
    font-size: 14px; font-weight: bold; color: #58a6ff;
    margin: 16px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid #21262d;
  }

  /* Tables */
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  th {
    text-align: left; padding: 6px 8px; font-size: 11px;
    color: #8b949e; border-bottom: 2px solid #21262d;
    text-transform: uppercase; letter-spacing: 0.5px;
    position: sticky; top: 0; background: #0d1117;
  }
  td { padding: 5px 8px; border-bottom: 1px solid #161b22; white-space: nowrap; }
  tr:hover td { background: #161b22; }

  /* Status badges */
  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 10px;
    font-size: 10px; font-weight: bold; text-transform: uppercase;
  }
  .badge-resolved { background: #1b3a2d; color: #3fb950; }
  .badge-hedging { background: #3b2e00; color: #d29922; }
  .badge-filled { background: #0c2d6b; color: #58a6ff; }
  .badge-loss { background: #3d1418; color: #f85149; }
  .badge-scalar { background: #3b2e00; color: #f0883e; margin-left: 4px; }

  /* Progress bar */
  .progress-bar {
    width: 60px; height: 10px; background: #21262d; border-radius: 5px;
    display: inline-block; vertical-align: middle; overflow: hidden;
  }
  .progress-fill { height: 100%; background: #3fb950; border-radius: 5px; }

  /* Copy button */
  .copy-btn { cursor:pointer; opacity:0.3; font-size:11px; margin-left:4px; }
  .copy-btn:hover { opacity:0.8; }

  /* Direction badge */
  .dir { font-weight: bold; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  .dir-A { background: #1f3a5f; color: #58a6ff; }
  .dir-B { background: #3b2e00; color: #d29922; }
  .dir-C { background: #1b3a2d; color: #3fb950; }
  .dir-D { background: #3d1e56; color: #bc8cff; }

  /* Filter tabs */
  .filters { margin-bottom: 8px; }
  .filter-btn {
    background: #21262d; color: #8b949e; border: 1px solid #30363d;
    padding: 3px 10px; border-radius: 12px; cursor: pointer;
    font-size: 11px; font-family: inherit; margin-right: 4px;
  }
  .filter-btn.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }

  /* Expandable row */
  .detail-row td { background: #161b22; padding: 8px 16px; font-size: 12px; border-bottom: 1px solid #21262d; }
  .detail-row { display: none; }
  .detail-row.open { display: table-row; }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; }
  .detail-grid span { color: #8b949e; }

  .clickable { cursor: pointer; }

  /* day filter */
  .day-btn { padding: 4px 12px; border-radius: 12px; border: 1px solid #30363d; background: #161b22; color: #8b949e; cursor: pointer; font-size: 12px; }
  .day-btn:hover { border-color: #58a6ff; color: #c9d1d9; }
  .day-btn.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  .day-btn .day-pnl { margin-left: 4px; font-size: 10px; }

  /* sortable headers */
  .sortable { cursor: pointer; user-select: none; }
  .sortable:hover { color: #58a6ff; }
  .sortable.active { color: #58a6ff; }
  .sort-arrow { font-size: 9px; margin-left: 2px; opacity: 0.3; }
  .sortable.active .sort-arrow { opacity: 1; }

  /* warning indicator */
  .warn-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #d29922; margin-right: 4px; vertical-align: middle; }
  .warn-list { margin-top: 8px; padding: 6px 10px; background: #2d2200; border: 1px solid #d29922; border-radius: 4px; font-size: 11px; color: #d29922; }
  .warn-list div { margin: 2px 0; }

  /* empty state */
  .empty { text-align: center; color: #8b949e; padding: 24px; font-style: italic; }

  /* Tabs */
  .tab-bar { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid #21262d; }
  .tab-btn {
    padding: 8px 20px; font-size: 13px; font-weight: bold; font-family: inherit;
    background: transparent; color: #8b949e; border: none; cursor: pointer;
    border-bottom: 2px solid transparent; margin-bottom: -2px; transition: color 0.15s;
  }
  .tab-btn:hover { color: #c9d1d9; }
  .tab-btn.active { color: #58a6ff; border-bottom-color: #58a6ff; }
  .tab-btn .tab-badge {
    display: inline-block; background: #f85149; color: #fff; font-size: 9px;
    padding: 1px 5px; border-radius: 8px; margin-left: 6px; font-weight: bold;
    vertical-align: middle;
  }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }

  /* Orderbook viewer */
  #panel-orderbook table td { padding: 2px 6px; font-size: 12px; border-bottom: 1px solid #161b22; }
  #panel-orderbook table th { padding: 3px 6px; font-size: 10px; }

  /* Audit panel */
  .audit-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .audit-btn {
    background: #1f6feb; color: #fff; border: none; padding: 6px 16px;
    border-radius: 6px; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: bold;
  }
  .audit-btn:hover { background: #388bfd; }
  .audit-btn:disabled { background: #21262d; color: #8b949e; cursor: not-allowed; }
  .audit-status { color: #8b949e; font-size: 12px; }
  .audit-summary { display: flex; gap: 12px; margin-bottom: 16px; }
  .audit-stat {
    background: #161b22; border: 1px solid #21262d; border-radius: 6px;
    padding: 8px 14px; font-size: 12px;
  }
  .audit-stat .num { font-size: 18px; font-weight: bold; display: block; }
  .audit-discrepancy {
    background: #161b22; border: 1px solid #21262d; border-radius: 6px;
    padding: 10px 14px; margin-bottom: 8px; font-size: 12px;
  }
  .audit-discrepancy.error { border-color: #f85149; }
  .audit-discrepancy.warning { border-color: #d29922; }
  .audit-discrepancy .aud-type {
    font-weight: bold; text-transform: uppercase; font-size: 10px;
    letter-spacing: 0.5px; margin-bottom: 4px;
  }
  .audit-discrepancy.error .aud-type { color: #f85149; }
  .audit-discrepancy.warning .aud-type { color: #d29922; }
  .audit-discrepancy .aud-match { color: #58a6ff; }
  .audit-discrepancy .aud-detail { color: #c9d1d9; margin-top: 2px; }
  .audit-clean { text-align: center; padding: 40px; color: #3fb950; font-size: 16px; font-weight: bold; }
</style>
</head>
<body>

<div class="header">
  <h1>Arb Trading Dashboard</h1>
  <div class="refresh-info">Auto-refresh: <span id="countdown">1</span>s &bull; <span id="lastUpdate">--</span> &bull; <span id="reconcileInfo" style="color:#8b949e">Reconcile: --</span></div>
</div>

<!-- User tabs (multi-user) -->
<div id="userTabBar" style="display:block;margin:0 20px 8px;padding:0;border-bottom:2px solid #21262d;">
  <button class="user-tab active" data-user="total" style="background:none;border:none;color:#58a6ff;padding:8px 18px;font-size:14px;font-family:inherit;cursor:pointer;border-bottom:2px solid #58a6ff;margin-bottom:-2px;">Total (<span data-count="total">--</span>)</button>
  <button class="user-tab" data-user="local" style="background:none;border:none;color:#8b949e;padding:8px 18px;font-size:14px;font-family:inherit;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;">Me (Local) (<span data-count="local">--</span>)</button>
</div>

<div class="cards" id="cards"></div>
<div id="chainStatus" style="margin:0 20px 10px;padding:8px 14px;background:#1a1a2e;border-radius:8px;font-size:12px;color:#888;display:none"></div>

<div class="tab-bar">
  <button class="tab-btn" data-tab="trades">Trades</button>
  <button class="tab-btn active" data-tab="walletarbs">Wallet Arbs</button>
  <button class="tab-btn" data-tab="execution">Execution</button>
  <button class="tab-btn" data-tab="missed">Missed Opps <span class="tab-badge" id="missedBadge" style="display:none">0</span></button>
  <button class="tab-btn" data-tab="orderbook">Orderbooks</button>
  <button class="tab-btn" data-tab="audit">Audit <span class="tab-badge" id="auditBadge" style="display:none">0</span></button>
  <button class="tab-btn" data-tab="verified">Verified P&L</button>
</div>

<!-- TAB: Trades -->
<div class="tab-panel" id="panel-trades">
  <div class="section-title">Active Positions</div>
  <table id="positionsTable">
    <thead>
      <tr>
        <th>Match</th>
        <th>Dir</th>
        <th>Held</th>
        <th>KAL Side</th>
        <th>Shares</th>
        <th>Init Cost</th>
        <th>Hedge Cost</th>
        <th>Progress</th>
        <th>Orders</th>
      </tr>
    </thead>
    <tbody id="positionsBody"></tbody>
  </table>
  <div class="section-title">Trade History</div>
  <div id="dayFilter" style="margin:0 20px 10px;display:flex;gap:6px;flex-wrap:wrap"></div>
  <div id="tradeTotals" style="margin:0 20px 10px;display:flex;gap:24px;font-size:13px"></div>
  <table id="tradesTable">
    <thead>
      <tr>
        <th class="sortable" data-sort="ts">Time <span class="sort-arrow">&#x25BC;</span></th>
        <th class="sortable" data-sort="resolvedTs">Resolved</th>
        <th class="sortable" data-sort="match">Match</th>
        <th class="sortable" data-sort="dir">Dir</th>
        <th>Kalshi Leg</th>
        <th>PM Leg</th>
        <th class="sortable" data-sort="shares">Shares</th>
        <th class="sortable" data-sort="cost">Cost</th>
        <th class="sortable" data-sort="fees">Fees</th>
        <th class="sortable" data-sort="status">Status</th>
        <th class="sortable" data-sort="method">Method</th>
        <th class="sortable" data-sort="pnl">P&amp;L</th>
        <th class="sortable" data-sort="actualPnl">Actual P&amp;L</th>
        <th class="sortable" data-sort="maxpnl">Max Potential</th>
        <th class="sortable" data-sort="server">Server</th>
      </tr>
    </thead>
    <tbody id="tradesBody"></tbody>
  </table>
</div>

<!-- TAB: Wallet Arbs -->
<div class="tab-panel active" id="panel-walletarbs">
  <div class="section-title">
    Wallet Arbs
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">
      live on-chain + exchange state, paired via the discovery watchlist.
      Does NOT depend on arb_trades.json.
    </span>
    <button class="audit-btn" id="walletArbsRefreshBtn" onclick="loadWalletArbs()" style="margin-left:12px">Refresh</button>
  </div>
  <div id="walletArbsTotals" style="margin:0 20px 10px;font-size:13px;color:#c9d1d9"></div>
  <!-- Live open/resting orders from both exchanges — hedge-cycle GTC bids typically appear here -->
  <div class="section-title" style="font-size:13px">Open orders <span id="walletArbsOpenOrdersCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span></div>
  <table id="walletArbsOpenOrdersTable">
    <thead>
      <tr>
        <th>Exch</th>
        <th>Match / Outcome</th>
        <th>Ticker / TokenId</th>
        <th>Side</th>
        <th>Price</th>
        <th>Filled / Size</th>
        <th>Total $</th>
        <th>Order ID</th>
      </tr>
    </thead>
    <tbody id="walletArbsOpenOrdersBody"><tr><td colspan="8" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px">Paired arbs</div>
  <table id="walletArbsPairedTable">
    <thead>
      <tr>
        <th title="How long this position has been in the wallet (first time pair_history saw it)">Age</th>
        <th>Match</th>
        <th>Type</th>
        <th>KAL Ticker</th>
        <th>KAL Side</th>
        <th>KAL Shares</th>
        <th>KAL Avg</th>
        <th>KAL Cost</th>
        <th>PM Outcome</th>
        <th>PM Shares</th>
        <th>PM Avg</th>
        <th>PM Cost</th>
        <th>Total Cost</th>
        <th title="Current mark-to-market P&amp;L (PM data-api currentValue − cost)">Current P&amp;L</th>
        <th>Net if KAL-side wins</th>
        <th>Net if OPPOSITE wins</th>
      </tr>
    </thead>
    <tbody id="walletArbsPairedBody"><tr><td colspan="16" class="empty">Click Refresh to load</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px">Unpaired Kalshi positions</div>
  <table id="walletArbsKalTable">
    <thead><tr><th>Age</th><th>Ticker</th><th>Side</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Hedge</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsKalBody"><tr><td colspan="8" class="empty">--</td></tr></tbody>
  </table>
  <!-- PM positions split by settlement status. Each bucket renders into its own table. -->
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#f85149">
    Genuinely NAKED Polymarket positions <span id="walletArbsNakedCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">KAL market still active — take action</span>
  </div>
  <table id="walletArbsPmNakedTable">
    <thead><tr><th>Age</th><th>Match</th><th>Title / Outcome</th><th>Paired KAL</th><th>KAL Status</th><th>Shares</th><th>Avg</th><th>Cur Px</th><th>Cost</th><th>Cur Value</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsPmNakedBody"><tr><td colspan="11" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#58a6ff">
    PM-only hedges — BALANCED (both sides, matched sizes) <span id="walletArbsPmOnlyCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">sizes match within $2 — real $1-combined-payout arb, locked profit</span>
  </div>
  <table id="walletArbsPmOnlyTable">
    <thead><tr><th>Age</th><th>Match</th><th>Title / Outcome</th><th>Paired KAL</th><th>Shares</th><th>Opposite</th><th>Avg</th><th>Cur Px</th><th>Cost</th><th>Cur Value</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsPmOnlyBody"><tr><td colspan="11" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#ff7b00">
    PM-only hedges — IMBALANCED (both sides, mismatched sizes) <span id="walletArbsPmOnlyImbalCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">opposite held but sizes differ &gt; $2 — directional bet with partial PM floor</span>
  </div>
  <table id="walletArbsPmOnlyImbalTable">
    <thead><tr><th>Age</th><th>Match</th><th>Title / Outcome</th><th>Paired KAL</th><th>Shares</th><th>Opposite</th><th>Avg</th><th>Cur Px</th><th>Cost</th><th>Cur Value</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsPmOnlyImbalBody"><tr><td colspan="11" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#d29922">
    KAL settled/closed, PM still open <span id="walletArbsKalPendingCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">KAL no longer tradable — market-sell PM to exit</span>
  </div>
  <table id="walletArbsPmKalPendingTable">
    <thead><tr><th>Age</th><th>Match</th><th>Title / Outcome</th><th>Paired KAL</th><th>KAL Result</th><th>Shares</th><th>Avg</th><th>Cur Px</th><th>Cost</th><th>Cur Value</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsPmKalPendingBody"><tr><td colspan="11" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#3fb950">
    Settled WINNERS (redeemable) <span id="walletArbsWinnersCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">PM resolved, claim on-chain</span>
  </div>
  <table id="walletArbsPmWinnersTable">
    <thead><tr><th>Age</th><th>Match</th><th>Title / Outcome</th><th>Paired KAL</th><th>Shares</th><th>Avg</th><th>Cur Px</th><th>Est Payout</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsPmWinnersBody"><tr><td colspan="9" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#8b949e">
    Settled LOSERS (redeemable, ~worthless) <span id="walletArbsLosersCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
  </div>
  <table id="walletArbsPmLosersTable">
    <thead><tr><th>Age</th><th>Match</th><th>Title / Outcome</th><th>Shares</th><th>Avg</th><th>Cur Px</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsPmLosersBody"><tr><td colspan="7" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#8b949e">
    No known pair / void <span id="walletArbsOtherCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
  </div>
  <table id="walletArbsPmOtherTable">
    <thead><tr><th>Age</th><th>Title / Outcome</th><th>TokenId</th><th>Status</th><th>Shares</th><th>Avg</th><th>Cost</th></tr></thead>
    <tbody id="walletArbsPmOtherBody"><tr><td colspan="7" class="empty">--</td></tr></tbody>
  </table>
  <div class="section-title" style="font-size:13px;margin-top:24px;color:#6e7681">
    Ignored positions <span id="walletArbsIgnoredCount" style="font-size:11px;color:#8b949e;font-weight:normal"></span>
    <span style="font-size:11px;color:#8b949e;font-weight:normal;margin-left:8px">manually marked "don't monitor" — still in wallet, just hidden from active buckets</span>
  </div>
  <table id="walletArbsIgnoredTable">
    <thead><tr><th>Age</th><th>Source bucket</th><th>Match / Ticker</th><th>Side / Outcome</th><th>Shares</th><th>Avg</th><th>Cost</th><th>Actions</th></tr></thead>
    <tbody id="walletArbsIgnoredBody"><tr><td colspan="8" class="empty">--</td></tr></tbody>
  </table>
</div>

<!-- TAB: Execution -->
<div class="tab-panel" id="panel-execution">
  <div class="section-title">Execution Stats</div>
  <div class="cards" id="execCards"></div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
    <div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Top Failure Reasons</div>
      <table id="reasonsTable" style="margin-bottom:0">
        <thead><tr><th>Reason</th><th>Count</th></tr></thead>
        <tbody id="reasonsBody"></tbody>
      </table>
    </div>
    <div>
      <div style="font-size:12px;color:#8b949e;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Last 10 Executions</div>
      <table id="recentTable" style="margin-bottom:0">
        <thead><tr><th>Time</th><th>Match</th><th>Outcome</th><th>Reason</th><th>Preflight</th><th>Depth</th><th>1st Leg</th><th>2nd Leg</th><th>Verify</th><th>Total</th></tr></thead>
        <tbody id="recentBody"></tbody>
      </table>
    </div>
  </div>
</div>

<!-- TAB: Missed Opportunities -->
<div class="tab-panel" id="panel-missed">
  <div class="section-title">Missed Opportunities <span style="font-size:11px;color:#8b949e;font-weight:normal">(arbs seen but not executed)</span></div>
  <table id="missedTable">
    <thead>
      <tr>
        <th>Time</th>
        <th>Match</th>
        <th>Dir</th>
        <th>Edge</th>
        <th>KAL</th>
        <th>PM</th>
        <th>Shares</th>
        <th>Proj. Profit</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody id="missedBody"></tbody>
  </table>
</div>

<!-- TAB: Orderbooks -->
<div class="tab-panel" id="panel-orderbook">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
    <select id="obMatchSelect" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:6px 10px;font-family:inherit;font-size:12px;min-width:280px">
      <option value="">-- Select a match --</option>
    </select>
    <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#8b949e">
      <input type="checkbox" id="obAutoRefresh" checked> Auto-refresh
    </label>
    <select id="obRefreshRate" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 6px;font-size:11px">
      <option value="100">100ms</option>
      <option value="200" selected>200ms</option>
      <option value="500">500ms</option>
      <option value="1000">1s</option>
      <option value="2000">2s</option>
    </select>
    <span id="obLastUpdate" style="font-size:11px;color:#8b949e"></span>
    <span id="obLatency" style="font-size:11px;color:#484f58"></span>
  </div>

  <div id="obContent" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <!-- Left: Kalshi -->
    <div>
      <div class="section-title" style="margin-top:0">Kalshi Orderbook <span id="obKalTicker" style="font-size:11px;color:#8b949e;font-weight:normal"></span></div>
      <div id="obKalSummary" style="font-size:12px;color:#8b949e;margin-bottom:6px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div style="font-size:11px;color:#3fb950;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Bids (YES)</div>
          <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obKalYesBids"></tbody></table>
        </div>
        <div>
          <div style="font-size:11px;color:#f85149;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Asks (YES)</div>
          <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obKalYesAsks"></tbody></table>
        </div>
      </div>
      <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div>
          <div style="font-size:11px;color:#3fb950;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Bids (NO)</div>
          <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obKalNoBids"></tbody></table>
        </div>
        <div>
          <div style="font-size:11px;color:#f85149;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Asks (NO)</div>
          <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obKalNoAsks"></tbody></table>
        </div>
      </div>
    </div>

    <!-- Right: Polymarket -->
    <div>
      <div class="section-title" style="margin-top:0">Polymarket Orderbook <span id="obPmSlug" style="font-size:11px;color:#8b949e;font-weight:normal"></span></div>
      <div id="obPmSummary" style="font-size:12px;color:#8b949e;margin-bottom:6px"></div>
      <div id="obPmOutcome1" style="margin-bottom:10px">
        <div style="font-size:12px;color:#58a6ff;margin-bottom:4px" id="obPm1Label">Outcome 1</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="font-size:11px;color:#3fb950;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Bids</div>
            <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obPm1Bids"></tbody></table>
          </div>
          <div>
            <div style="font-size:11px;color:#f85149;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Asks</div>
            <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obPm1Asks"></tbody></table>
          </div>
        </div>
      </div>
      <div id="obPmOutcome2">
        <div style="font-size:12px;color:#d29922;margin-bottom:4px" id="obPm2Label">Outcome 2</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div>
            <div style="font-size:11px;color:#3fb950;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Bids</div>
            <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obPm2Bids"></tbody></table>
          </div>
          <div>
            <div style="font-size:11px;color:#f85149;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;text-align:center">Asks</div>
            <table style="margin-bottom:0"><thead><tr><th>Price</th><th>Size</th><th>Total</th></tr></thead><tbody id="obPm2Asks"></tbody></table>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="obEmpty" style="color:#8b949e;text-align:center;padding:40px;font-size:14px">Select a match above to view orderbooks</div>
</div>

<!-- TAB: Audit -->
<div class="tab-panel" id="panel-audit">
  <div class="audit-header">
    <button class="audit-btn" id="auditRunBtn" onclick="runAudit()">Run Position Audit</button>
    <span class="audit-status" id="auditStatus">Cross-references exchange fills against dashboard data</span>
  </div>
  <div id="auditSummary"></div>
  <div id="auditResults">
    <div style="text-align:center;padding:40px;color:#8b949e;font-size:14px">
      Click "Run Position Audit" to compare exchange fills with dashboard records.
      <br><span style="font-size:11px">Takes ~10-30s (fetches from Kalshi + PM APIs)</span>
    </div>
  </div>
</div>

<!-- TAB: Verified P&L -->
<div class="tab-panel" id="panel-verified">
  <div class="audit-header">
    <button class="audit-btn" id="verifiedRunBtn" onclick="runVerifiedPnl()">Fetch Exchange-Verified P&L</button>
    <span class="audit-status" id="verifiedStatus">Queries Kalshi + Polymarket APIs for ground-truth P&L</span>
  </div>
  <div id="verifiedSummary"></div>
  <div id="verifiedDetails">
    <div style="text-align:center;padding:40px;color:#8b949e;font-size:14px">
      Click "Fetch Exchange-Verified P&L" to query both exchanges directly.
      <br><span style="font-size:11px">This ignores arb_trades.json -- shows actual money in/out.</span>
    </div>
  </div>
</div>


<script>
var sortCol = "ts";
var sortAsc = false;
var filterDay = null; // null = "All", or "2026-03-01" etc
var allTrades = [];
let expandedRows = new Set();
var settlementMap = {}; // { kalTicker: { revenue, cost, fee, net, result, yesCount, noCount } }
var _tickerTradeCount = {}; // { kalTicker: number of trades sharing this ticker }

// Fetch settlement map for Actual P&L column
async function fetchSettlementMap() {
  try {
    var res = await fetch("/api/settlement-map");
    settlementMap = await res.json();
    console.log("[SETTLEMENT-MAP] Loaded " + Object.keys(settlementMap).length + " settlements");
  } catch (e) { console.warn("Settlement map fetch failed:", e); }
}

// Per-trade "Actual P&L" used by actualPnlCell(), totals loop, and detail panel.
//
// Design: the trade record's own realizedPnl is the single source of truth.
// It is stamped at execution time from real exchange fills (WS fee_cost,
// CLOB getTrades) and maintained by reconciliation paths that are all now
// guarded so they cannot cross-attribute sibling-trade fills. An earlier
// version of this function recomputed actualNet from a ticker-wide
// settlementMap, which mis-attributed aggregate KAL fills across shared
// tickers (especially across home + VPS servers) and produced phantom
// losses. That computation is removed -- we display what the execution
// pipeline actually recorded.
//
// Metadata fields (kalWon, pmPayout, isScalar, isShared) remain computed
// from settlementMap because they are display-only labels and their errors
// do not feed back into dollar numbers.
function computeActualPnl(t) {
  if (t.status !== "resolved" || t.realizedPnl == null) {
    return { usable: false, resolved: t.status === "resolved" };
  }

  var s = settlementMap[t.kalTicker];
  var isSharedTicker = _tickerTradeCount[t.kalTicker] > 1;
  var kalSide = ("CDGHI".indexOf(t.dir) >= 0) ? "no" : "yes";
  var hasPmLeg = ((t.pmCost || 0) > 0 || (t.pmFillPrice || 0) > 0);

  // Display-only metadata. Safe defaults when settlementMap has no entry.
  var isScalar = !!t.scalarSettlement || (s && s.settlementResult === "scalar");
  var kalWon = false;
  var pmPayout = 0;
  var statusLabel = "from trade record";
  var badge = '';

  if (s && s.status === "settled") {
    if (isScalar) {
      kalWon = false;
      statusLabel = "settled (voided)";
      badge = ' <span style="color:#d29922;font-size:9px">VOID</span>';
    } else if (s.settlementResult) {
      kalWon = s.settlementResult === kalSide;
      statusLabel = kalWon ? "settled (KAL won)" : "settled (PM won)";
    } else if (s.pairRedemption > 0) {
      kalWon = true;
      statusLabel = "settled (pair redemption)";
    } else {
      kalWon = s.settlementRevenue > 0.50;
      statusLabel = kalWon ? "settled (KAL won)" : "settled (PM won)";
    }
    pmPayout = (!kalWon && !isScalar && hasPmLeg) ? t.shares : 0;
    if (isScalar && hasPmLeg) pmPayout = t.shares * 0.50;
  } else if (s && s.status === "sold") {
    statusLabel = "sold";
    badge = ' <span style="color:#d29922;font-size:9px">SOLD</span>';
  } else if (!s) {
    // No exchange audit entry yet -- still show the trade's stored P&L.
    statusLabel = "from trade record";
  } else {
    statusLabel = "pending";
    badge = ' <span style="color:#8b949e;font-size:9px">PENDING</span>';
  }

  if (t.pnlVerified) {
    badge = ' <span style="color:#3fb950;font-size:9px" title="pnlVerified ' + t.pnlVerified + '">✓</span>' + badge;
    statusLabel = "verified from exchange";
  }

  return {
    actualNet: t.realizedPnl,
    statusLabel: statusLabel,
    cls: t.realizedPnl >= 0 ? "green" : "red",
    badge: badge,
    kalWon: kalWon,
    pmPayout: pmPayout,
    isShared: isSharedTicker,
    isScalar: isScalar,
    usable: true,
  };
}

function actualPnlCell(t) {
  var r = computeActualPnl(t);
  if (!r.usable) {
    if (r.resolved) return '<span class="gray" title="No exchange data for ' + esc(t.kalTicker) + '">?</span>';
    return '<span class="gray">--</span>';
  }

  var s = settlementMap[t.kalTicker];
  var pmCost = t.pmCost || 0;
  var parts = [];
  if (s) {
    if (s.buyCost > 0) parts.push("bought: $" + s.buyCost.toFixed(2) + " (" + s.buyCount + ")");
    if (s.sellRevenue > 0) parts.push("sold: $" + s.sellRevenue.toFixed(2) + " (" + s.sellCount + ")");
    if (s.settlementRevenue > 0) parts.push("settlement: $" + s.settlementRevenue.toFixed(2));
    if (s.pairRedemption > 0) parts.push("pair redemption: $" + s.pairRedemption.toFixed(2));
  }
  if (pmCost > 0) parts.push("PM cost: $" + pmCost.toFixed(2));
  if (s) parts.push("fees: $" + s.fees.toFixed(2));
  parts.push("status: " + r.statusLabel);
  if (r.isShared) parts.push("(shared ticker: " + _tickerTradeCount[t.kalTicker] + " trades)");
  var title = parts.join(" | ");
  return '<span class="' + r.cls + '" title="' + esc(title) + '">' + pnlStr(r.actualNet) + '</span>' + r.badge;
}

// Tab switching. On click, lazily fire the loader for tabs whose data isn't
// included in the auto-refresh loop (wallet-arbs is a heavy endpoint — only
// fetched on demand + on first view since it's now the default tab).
var _walletArbsLoaded = false;
function ensureWalletArbsLoaded() {
  if (_walletArbsLoaded) return;
  _walletArbsLoaded = true;
  try { loadWalletArbs(); } catch (e) { /* swallow — user can click Refresh */ }
}
document.querySelectorAll(".tab-btn").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.remove("active"); });
    btn.classList.add("active");
    var panel = document.getElementById("panel-" + btn.dataset.tab);
    if (panel) panel.classList.add("active");
    if (btn.dataset.tab === "walletarbs") ensureWalletArbsLoaded();
  });
});
// Wallet Arbs is the default tab — kick its loader as soon as the script runs.
// Deferred slightly so the initial /api/stats call fires first (it populates the
// header cards, which are visible regardless of active tab).
setTimeout(ensureWalletArbsLoaded, 300);

function $(id) { return document.getElementById(id); }

// HTML-escape to prevent XSS from trade data injected into innerHTML
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function pnlClass(val) { return val > 0.001 ? "green" : val < -0.001 ? "red" : "gray"; }
// Relative-time helper for the "First Seen" column: shows "12m", "3h", "2d" etc.
// Returns "--" if ts is missing. Purely cosmetic — tooltip shows the full ISO string.
function ageLabel(ts) {
  if (!ts) return '<span style="color:#6e7681">--</span>';
  var secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  var s;
  if (secs < 60) s = secs + 's';
  else if (secs < 3600) s = Math.floor(secs / 60) + 'm';
  else if (secs < 86400) s = Math.floor(secs / 3600) + 'h';
  else s = Math.floor(secs / 86400) + 'd';
  return '<span title="' + new Date(ts).toISOString() + '" style="color:#8b949e;font-size:11px">' + s + ' ago</span>';
}
function kalFee(t) {
  return t.kalFees != null ? t.kalFees : Math.max(0, t.kalCost - t.shares * t.kalFillPrice);
}
function pmFee(t) {
  // Prefer the authoritative value captured at fill time (feeSchedule.rate × shares × p × (1-p)).
  // Fall back to inferring from pmCost when the trade predates the pmFees field.
  if (t.pmFees != null) return t.pmFees;
  var basePmCost = t.pmCost - (t.hedgeCost || 0);
  return Math.max(0, basePmCost - t.shares * t.pmFillPrice);
}
function tradeFees(t) {
  return kalFee(t) + pmFee(t);
}
function pnlStr(val) { return val > 0 ? "+$" + val.toFixed(2) : val < 0 ? "-$" + Math.abs(val).toFixed(2) : "$0.00"; }
function fmtDate(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " +
         d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function shortTicker(ticker) {
  if (!ticker || typeof ticker !== "string") return "--";
  const parts = ticker.split("-");
  return parts.length >= 3 ? parts[parts.length - 1] : ticker.slice(-10);
}

function sortKey(t, col) {
  switch (col) {
    case "ts": return t.ts || "";
    case "resolvedTs": return t.resolvedTs || "";
    case "match": return (t.match || "").toLowerCase();
    case "dir": return t.dir || "";
    case "shares": return t.shares || 0;
    case "cost": return t.totalCost || 0;
    case "fees": return tradeFees(t);
    case "status": return t.status || "";
    case "method": return t.resolutionMethod || "";
    case "pnl": return t.realizedPnl != null ? t.realizedPnl : -999999;
    case "actualPnl": var sm = settlementMap[t.kalTicker]; if (!sm) return -999999; var hcA = ((t.pmCost === 0 || t.kalCost === 0) && (t.hedgeCost || 0) > 0) ? (t.hedgeCost || 0) : 0; if (sm.settlementResult === "scalar" && (t.pmCost > 0 || t.pmFillPrice > 0)) return Math.round((sm.net + t.shares * 0.50 - (t.pmCost || 0) - hcA) * 100) / 100; if (_tickerTradeCount[t.kalTicker] > 1) return t.realizedPnl || 0; if (sm.status === "settled") { var kw; if (sm.settlementResult !== "scalar" && sm.pairRedemption > 0 && sm.settlementResult) { var os = (sm.buyNoCost || 0) >= (sm.buyYesCost || 0) ? "no" : "yes"; kw = sm.settlementResult === os; } else { kw = sm.settlementResult !== "scalar" && sm.settlementRevenue > 0.50; } return Math.round((sm.net + (kw ? 0 : t.shares) - (t.pmCost || 0) - hcA) * 100) / 100; } return sm.status === "sold" ? Math.round(sm.net * 100) / 100 : (t.realizedPnl || 0);
    case "maxpnl": return t._maxPnl != null ? t._maxPnl : -999999;
    case "server": return t.serverId || "";
    default: return "";
  }
}

function updateSortHeaders() {
  document.querySelectorAll(".sortable").forEach(function(th) {
    var col = th.dataset.sort;
    th.classList.toggle("active", col === sortCol);
    var arrow = th.querySelector(".sort-arrow");
    if (col === sortCol) {
      if (!arrow) { arrow = document.createElement("span"); arrow.className = "sort-arrow"; th.appendChild(arrow); }
      arrow.innerHTML = sortAsc ? "&#x25B2;" : "&#x25BC;";
    } else {
      if (arrow) arrow.innerHTML = "";
    }
  });
}

function renderCards(stats) {
  var warnCount = allTrades.filter(function(t) { return t._warnings && t._warnings.length > 0; }).length;
  var qCls = warnCount === 0 ? "green" : "yellow";
  $("cards").innerHTML = [
    { label: "Total P&L", value: pnlStr(stats.totalRealizedPnl), cls: pnlClass(stats.totalRealizedPnl),
      sub: "Bot: " + pnlStr(stats.botRealizedPnl) + " | Backfill: " + pnlStr(stats.backfillRealizedPnl) },
    { label: "Win / Loss / Even", value: stats.winCount + " / " + stats.lossCount + " / " + (stats.resolvedTrades - stats.winCount - stats.lossCount), cls: "blue",
      sub: "Avg: " + pnlStr(stats.avgPnlPerTrade) + " per trade" },
    { label: "Arb Success Rate", value: (stats.resolvedTrades > 0 ? ((stats.bothLegsTrades / stats.resolvedTrades) * 100).toFixed(0) : 0) + "%",
      cls: stats.resolvedTrades > 0 && (stats.bothLegsTrades / stats.resolvedTrades) >= 0.5 ? "green" : "yellow",
      sub: stats.bothLegsTrades + " / " + stats.resolvedTrades + " both-legs" },
    { label: "Hedge Rate", value: (stats.resolvedTrades > 0 ? ((stats.hedgeCompleteTrades / stats.resolvedTrades) * 100).toFixed(0) : 0) + "%",
      cls: stats.resolvedTrades > 0 && (stats.hedgeCompleteTrades / stats.resolvedTrades) <= 0.3 ? "green" : stats.resolvedTrades > 0 && (stats.hedgeCompleteTrades / stats.resolvedTrades) <= 0.6 ? "yellow" : "red",
      sub: stats.hedgeCompleteTrades + " / " + stats.resolvedTrades + " hedge-complete" },
    { label: "Open Positions", value: stats.activeTrades, cls: "yellow",
      sub: "Capital: $" + stats.capitalDeployed.toFixed(2) },
    { label: "Data Quality", value: warnCount === 0 ? "Clean" : warnCount + " warnings", cls: qCls,
      sub: warnCount === 0 ? "All trades pass validation" : "Click trades for details" },
    { label: "Exchange Audit", value: auditData ? (auditData.summary.errors > 0 ? auditData.summary.errors + " issues" : "Clean") : "Not run",
      cls: auditData ? (auditData.summary.errors > 0 ? "red" : "green") : "gray",
      sub: auditData ? auditData.summary.warnings + " warnings | " + new Date(auditData.ts).toLocaleTimeString() : '<a href="#" onclick="document.querySelector(\\x27[data-tab=audit]\\x27).click();runAudit();return false" style="color:#58a6ff">Run audit</a>' },
    stats.scalarCount > 0 ? { label: "Scalar Settlements", value: stats.scalarCount + " trades", cls: "yellow",
      sub: "P&L impact: " + pnlStr(stats.scalarPnlImpact) + " vs binary" } : null,
    stats.totalMaxPnl > 0 ? { label: "Missed Potential", value: pnlStr(stats.missedPnl), cls: "yellow",
      sub: "Max possible: " + pnlStr(stats.totalMaxPnl) + " vs actual " + pnlStr(stats.botRealizedPnl) } : null,
    stats.totalKalFees > 0 ? { label: "KAL Fees", value: "$" + stats.totalKalFees.toFixed(2),
      cls: stats.makerFills > 0 ? "green" : "yellow",
      sub: stats.makerFills > 0
        ? "Maker: " + stats.makerFills + " ($" + stats.makerFees.toFixed(2) + ") | Taker: " + stats.takerFills + " ($" + stats.takerFees.toFixed(2) + ")"
        : stats.takerFills + " taker fills" } : null,
  ].filter(Boolean).map(c => '<div class="card"><div class="card-label">' + c.label + '</div>' +
    '<div class="card-value ' + c.cls + '">' + c.value + '</div>' +
    '<div class="card-sub">' + c.sub + '</div></div>').join("");
}

function renderPositions(positions) {
  const tbody = $("positionsBody");
  if (positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No active positions</td></tr>';
    return;
  }
  tbody.innerHTML = positions.map(h => {
    const p = h.position;
    const total = p.initialShares || p.sharesHeld;
    const remaining = p.sharesHeld;
    const hedged = total - remaining;
    const pct = total > 0 ? Math.round((hedged / total) * 100) : 0;
    const orderCount = h.activeOrders ? h.activeOrders.length : 0;
    const ordersStr = orderCount > 0
      ? h.activeOrders.map(function(o) { return o[1].exchange.toUpperCase() + " " + o[1].role; }).join(", ")
      : "none";

    // Label fallback: kalLeg.surname → pmLeg.outcome → kalTicker → pmTokenId prefix
    const label = (p.kalLeg && p.kalLeg.surname) || (p.pmLeg && p.pmLeg.outcome) ||
      (p.kalLeg && p.kalLeg.ticker) ||
      (p.pmLeg && p.pmLeg.tokenId ? '(pm:' + String(p.pmLeg.tokenId).slice(0, 8) + '...)' : '?');
    return '<tr>' +
      '<td>' + esc(label) + '</td>' +
      '<td><span class="dir dir-' + (p.kalSide === "no" ? "C" : "A") + '">' + (p.kalSide === "no" ? "NO" : "YES") + '</span></td>' +
      '<td>' + esc(p.heldExchange).toUpperCase() + '</td>' +
      '<td>' + esc(p.kalSide) + '</td>' +
      '<td>' + hedged + ' / ' + total + '</td>' +
      '<td>$' + (p.initialCost || 0).toFixed(2) + '</td>' +
      '<td>$' + (p.hedgeFillCost || 0).toFixed(2) + '</td>' +
      '<td><div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div> ' + pct + '%</td>' +
      '<td>' + esc(ordersStr) + '</td>' +
      '</tr>';
  }).join("");
}

function toLocalDay(isoTs) {
  var d = new Date(isoTs);
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}
function renderDayFilter(trades) {
  var days = {};
  trades.forEach(function(t) {
    var day = t.ts ? toLocalDay(t.ts) : "unknown";
    if (!days[day]) days[day] = { count: 0, pnl: 0 };
    days[day].count++;
    days[day].pnl += (t.realizedPnl || 0);
  });
  var sortedDays = Object.keys(days).sort();
  var html = '<button class="day-btn' + (filterDay === null ? ' active' : '') + '" data-day="all">All (' + trades.length + ')</button>';
  sortedDays.forEach(function(day) {
    var d = days[day];
    var label = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    var pnlColor = d.pnl > 0.001 ? "#4ade80" : d.pnl < -0.001 ? "#f85149" : "#8b949e";
    var pnlStr = (d.pnl >= 0 ? "+$" : "-$") + Math.abs(d.pnl).toFixed(2);
    html += '<button class="day-btn' + (filterDay === day ? ' active' : '') + '" data-day="' + day + '">' + label + ' (' + d.count + ') <span class="day-pnl" style="color:' + pnlColor + '">' + pnlStr + '</span></button>';
  });
  $("dayFilter").innerHTML = html;
  $("dayFilter").querySelectorAll(".day-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      filterDay = btn.dataset.day === "all" ? null : btn.dataset.day;
      renderAll();
    });
  });
}

function getFilteredTrades() {
  if (!filterDay) return allTrades;
  return allTrades.filter(function(t) { return t.ts && toLocalDay(t.ts) === filterDay; });
}

async function renderAll() {
  var dayParam = filterDay ? "?day=" + filterDay : "";
  try {
    var statsRes = await fetch("/api/stats" + dayParam);
    var stats = await statsRes.json();
    renderCards(stats);
  } catch(e) { console.error("Stats fetch error:", e); }
  renderDayFilter(allTrades);
  var filtered = getFilteredTrades();
  renderTrades(filtered);
}

function renderTrades(trades) {
  const tbody = $("tradesBody");
  var sorted = trades.slice().sort(function(a, b) {
    var ka = sortKey(a, sortCol);
    var kb = sortKey(b, sortCol);
    var cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
    return sortAsc ? cmp : -cmp;
  });

  updateSortHeaders();

  // Build ticker frequency map -- needed to avoid double-counting exchange data
  // when multiple trades share the same Kalshi ticker
  _tickerTradeCount = {};
  for (var tc = 0; tc < trades.length; tc++) {
    var tk = trades[tc].kalTicker;
    _tickerTradeCount[tk] = (_tickerTradeCount[tk] || 0) + 1;
  }

  // Compute P&L total — same source as day buttons (realizedPnl from trade record)
  var totalPnl = 0;
  for (var ti = 0; ti < trades.length; ti++) {
    totalPnl += (trades[ti].realizedPnl || 0);
  }
  totalPnl = Math.round(totalPnl * 100) / 100;
  var pnlC = totalPnl >= 0 ? "#3fb950" : "#f85149";

  // Compute Actual P&L total — reuse the same per-trade computation as the column
  var totalActualPnl = 0;
  for (var ai = 0; ai < trades.length; ai++) {
    var ar = computeActualPnl(trades[ai]);
    if (ar.usable) {
      totalActualPnl += ar.actualNet;
    } else {
      totalActualPnl += (trades[ai].realizedPnl || 0);
    }
  }
  totalActualPnl = Math.round(totalActualPnl * 100) / 100;
  var apnlC = totalActualPnl >= 0 ? "#3fb950" : "#f85149";

  $("tradeTotals").innerHTML =
    '<span style="color:#8b949e">P&L Total: <b style="color:' + pnlC + '">' + pnlStr(totalPnl) + '</b>' +
    '&nbsp;&nbsp;Actual P&L Total: <b style="color:' + apnlC + '">' + pnlStr(totalActualPnl) + '</b></span>';

  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="15" class="empty">No trades</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map(function(t, i) {
    // Backfill detection must match the server-side isBackfillTrade():
    // legacy backfill-*, arb-backfill-*, serverId=backfill/auto-backfill all count.
    const isBackfill = (t.id && (t.id.indexOf("backfill") === 0 || t.id.indexOf("arb-backfill") === 0))
      || t.serverId === "backfill" || t.serverId === "auto-backfill";
    const dirLabel = t.dir || "?";
    const kalSide = (dirLabel === "C" || dirLabel === "D" || dirLabel === "G" || dirLabel === "H" || dirLabel === "I") ? "NO" : "YES";
    // NO FILL flag is meaningful only while a trade is still "hedging".
    // Once resolved, kalCost=0 is legitimate for PM-opposite hedge-complete trades.
    const kalNoFill = t.kalCost === 0 && t.kalFillPrice === 0 && t.status === "hedging";

    var kalStr = kalNoFill
      ? esc(shortTicker(t.kalTicker)) + ' <span style="color:#f85149;font-size:10px">NO FILL</span>'
      : esc(shortTicker(t.kalTicker)) + " " + kalSide + " @" + (t.kalFillPrice > 0 ? t.kalFillPrice.toFixed(2) : "--");
    const initPmPriceTemp = t.pmFillPrice;
    var pmStr = t.pmOutcome ? esc(t.pmOutcome) + " @" + (initPmPriceTemp > 0 ? initPmPriceTemp.toFixed(2) : "--") : (isBackfill ? "KAL-only" : "--");
    const scalarBadge = t.scalarSettlement ? '<span class="badge badge-scalar">SCALAR</span>' : '';
    // Scalar-settled trades are neither a clean win nor loss — suppress OK/LOSS
    // and show SCALAR in the status cell to avoid misreading a fractional payout.
    var statusBadge = t.scalarSettlement
      ? scalarBadge
      : ((t.status === "resolved"
          ? (t.realizedPnl != null && t.realizedPnl < 0 ? '<span class="badge badge-loss">LOSS</span>' : '<span class="badge badge-resolved">OK</span>')
          : t.status === "hedging" ? '<span class="badge badge-hedging">HDG</span>'
          : '<span class="badge badge-filled">FILL</span>'));
    // For PM-hedged trades (KAL never filled, hedge done on PM), pmCost IS the initial cost
    const initPmPrice = t.pmFillPrice || 0;

    const hasWarns = t._warnings && t._warnings.length > 0;
    const warnDot = hasWarns ? '<span class="warn-dot" title="' + esc(t._warnings.length + ' warning(s)') + '"></span>' : '';
    const pnl = t.realizedPnl != null
      ? warnDot + '<span class="' + pnlClass(t.realizedPnl) + '">' + pnlStr(t.realizedPnl) + '</span>'
      : warnDot + '<span class="gray">--</span>';

    const maxPot = (t._maxPnl != null && t._maxPnl > 0)
      ? '<span class="green" title="' + t._maxShares + ' shares / $' + (t._maxCost || 0).toFixed(0) + ' invested">' + pnlStr(t._maxPnl) + '</span><span style="color:#555;font-size:10px"> (' + t._maxShares + 'sh)</span>'
      : '<span class="gray">--</span>';

    const rowId = "row-" + i;
    const isOpen = expandedRows.has(i);

    const durStr = t.resolvedTs && t.ts
      ? (function() { var ms = new Date(t.resolvedTs).getTime() - new Date(t.ts).getTime(); if (!isFinite(ms) || ms < 0) return ''; var s = Math.floor(ms/1000); if (s < 60) return s + 's'; var m = Math.floor(s/60); if (m < 60) return m + 'm'; var h = Math.floor(m/60); return h + 'h' + (m%60) + 'm'; })()
      : '';
    const resolvedCell = t.resolvedTs
      ? fmtDate(t.resolvedTs) + (durStr ? ' <span style="color:#8b949e;font-size:10px">(' + durStr + ')</span>' : '')
      : '<span class="gray">--</span>';

    const mainRow = '<tr class="clickable" onclick="toggleRow(' + i + ')">' +
      '<td>' + fmtDate(t.ts) + '</td>' +
      '<td>' + resolvedCell + '</td>' +
      '<td style="white-space:normal;max-width:260px">' + esc(t.match) + ' <span class="copy-btn" data-copy="' + esc(t.match).replace(/"/g, '&quot;') + '" onclick="event.stopPropagation();copyMatch(this)" title="Copy match name">&#9112;</span></td>' +
      '<td><span class="dir dir-' + dirLabel + '">' + dirLabel + '</span></td>' +
      '<td>' + kalStr + '</td>' +
      '<td>' + pmStr + '</td>' +
      '<td>' + t.shares + '</td>' +
      '<td>$' + t.totalCost.toFixed(2) + '</td>' +
      '<td style="color:#d29922">$' + tradeFees(t).toFixed(2) + '</td>' +
      '<td>' + statusBadge + '</td>' +
      '<td>' + esc(t.resolutionMethod === "hedge-complete" && kalNoFill ? "pm-hedged" : (t.resolutionMethod || "--")) + (settlementMap[t.kalTicker] && settlementMap[t.kalTicker].sellCount > 0 ? ' <span style="color:#d29922;font-size:9px">SOLD</span>' : '') + '</td>' +
      '<td>' + pnl + '</td>' +
      '<td>' + actualPnlCell(t) + '</td>' +
      '<td>' + maxPot + '</td>' +
      '<td style="font-size:10px;color:#8b949e">' + esc(t.serverId || "--") + '</td>' +
      '</tr>';

    const detailRow = '<tr class="detail-row' + (isOpen ? " open" : "") + '" id="' + rowId + '"><td colspan="15">' +
      '<div class="detail-grid">' +
      '<div><span>Trade ID:</span> ' + esc(t.id) + '</div>' +
      '<div><span>Resolved:</span> ' + fmtDate(t.resolvedTs) + '</div>' +
      '<div><span>KAL Ticker:</span> ' + esc(t.kalTicker) + '</div>' +
      '<div><span>PM Slug:</span> ' + esc(t.pmSlug || "n/a") + '</div>' +
      '<div><span>KAL Cost:</span> ' + (kalNoFill
        ? '<span style="color:#f85149">No fill -- KAL leg failed, hedged via PM</span>'
        : '$' + t.kalCost.toFixed(2) + ' (' + t.shares + ' @ ' + t.kalFillPrice.toFixed(3) + ')' +
          (t.kalFillPrice > 0 || t.kalFees ? ' <span style="color:#d29922">fee $' + kalFee(t).toFixed(2) + '</span>' : '') +
          (t.kalMakerFill ? ' <span style="background:#238636;color:#fff;padding:1px 5px;border-radius:3px;font-size:11px">MAKER</span>' : (t.kalFees > 0 ? ' <span style="background:#6e4000;color:#fff;padding:1px 5px;border-radius:3px;font-size:11px">TAKER</span>' : ''))) + '</div>' +
      '<div><span>PM Cost:</span> $' + t.pmCost.toFixed(2) + ' (' + t.shares + ' @ ' + initPmPrice.toFixed(3) + ')' +
        (t.pmFillPrice > 0 ? ' <span style="color:#d29922">fee $' + pmFee(t).toFixed(2) + '</span>' : '') + '</div>' +
      (t.hedgeCost != null && t.hedgeCost > 0 ? '<div><span>Hedge Cost:</span> $' + t.hedgeCost.toFixed(2) +
        (kalNoFill && t.initialExchange === "pm" ? ' (PM opposite outcome)' : '') + '</div>' : '') +
      '<div><span>Projected Edge:</span> ' + (t.projectedEdge * 100).toFixed(2) + '%</div>' +
      '<div><span>Projected Profit:</span> $' + t.projectedProfit.toFixed(2) + '</div>' +
      (t.initialExchange ? '<div><span>Initial Exchange:</span> ' + esc(t.initialExchange).toUpperCase() + '</div>' : '') +
      (t.scalarSettlement ? '<div style="grid-column:1/-1;margin-top:6px;padding:6px 8px;background:#2d1800;border:1px solid #f0883e;border-radius:4px">' +
        '<div style="color:#f0883e;font-weight:bold;margin-bottom:4px">&#9888; Scalar Settlement</div>' +
        '<div>KAL payout/share: <b>$' + (t.kalSettlementValue != null ? t.kalSettlementValue.toFixed(2) : '??') + '</b></div>' +
        '<div>PM payout/share: <b>$' + (t.pmSettlementValue != null ? t.pmSettlementValue.toFixed(2) : '??') + '</b></div>' +
        '<div>Combined payout: <b>$' + ((t.kalSettlementValue || 0) + (t.pmSettlementValue || 0)).toFixed(2) + '/share</b> vs $1.00 binary</div>' +
        (t.resolutionNote ? '<div style="color:#8b949e;margin-top:2px">' + esc(t.resolutionNote) + '</div>' : '') +
        '</div>' : '') +
      '</div>' +
      (function() {
        var sm = settlementMap[t.kalTicker];
        if (!sm) return '';
        var pmCost = t.pmCost || 0;
        var r = computeActualPnl(t);
        var pmPayout = r.usable ? r.pmPayout : 0;
        if (r.isScalar && (t.pmCost > 0 || t.pmFillPrice > 0)) pmPayout = t.shares * 0.50;
        var winnerStr = sm.status === "settled" ? (r.isScalar ? "VOIDED" : (r.kalWon ? "KAL won" : "PM won")) : sm.status;
        var isShared = r.isShared;
        var actualNet = r.usable ? r.actualNet : (t.realizedPnl || 0);
        var sharedNote = isShared ? ' <span style="color:#d29922;font-size:10px">(ticker shared by ' + _tickerTradeCount[t.kalTicker] + ' trades)</span>' : '';
        return '<div style="grid-column:1/-1;margin-top:6px;padding:6px 8px;background:#0d1b2a;border:1px solid #1f6feb;border-radius:4px">' +
          '<div style="color:#58a6ff;font-weight:bold;margin-bottom:4px">Exchange Data (' + winnerStr.toUpperCase() + ')' + sharedNote + '</div>' +
          '<div>KAL bought: <b>' + sm.buyCount + ' @ $' + sm.buyCost.toFixed(2) + '</b>' +
            (sm.pairRedemption > 0 ? ' <span style="color:#d29922;font-size:10px">(incl. ' + Math.min(sm.buyYesCount, sm.buyNoCount) + ' auto-paired)</span>' : '') +
            (sm.sellCount > 0 ? ' | KAL sold: <b style="color:#d29922">' + sm.sellCount + ' @ $' + sm.sellRevenue.toFixed(2) + '</b>' : '') +
            (sm.settlementRevenue > 0 ? ' | KAL settlement: <b>$' + sm.settlementRevenue.toFixed(2) + '</b>' : '') +
            (sm.pairRedemption > 0 ? ' | Pair redemption: <b>$' + sm.pairRedemption.toFixed(2) + '</b>' : '') +
            (pmPayout > 0 ? ' | PM payout: <b>$' + pmPayout.toFixed(2) + '</b>' : '') +
            ' | Fees: <b>$' + sm.fees.toFixed(2) + '</b></div>' +
          '<div>KAL net: <b>' + pnlStr(sm.net) + '</b>' + (isShared ? ' (all trades)' : '') +
            ' | PM cost: <b>$' + pmCost.toFixed(2) + '</b>' +
            (pmPayout > 0 ? ' | PM payout: <b>$' + pmPayout.toFixed(2) + '</b>' : '') +
            ' | Actual P&L: <b style="color:' + (actualNet >= 0 ? "#3fb950" : "#f85149") + '">' + pnlStr(actualNet) + '</b>' +
            (isShared ? ' <span style="color:#8b949e;font-size:10px">(per-trade)</span>' : '') + '</div>' +
          (sm.openYes > 0 || sm.openNo > 0 ? '<div style="color:#8b949e">Open positions: ' + sm.openYes + ' YES / ' + sm.openNo + ' NO (est. value: $' + sm.openValue.toFixed(2) + ')</div>' : '') +
          '</div>';
      })() +
      (hasWarns ? '<div class="warn-list">' + t._warnings.map(function(w) { return '<div>&#9888; ' + esc(w) + '</div>'; }).join('') + '</div>' : '') +
      '</td></tr>';

    return mainRow + detailRow;
  }).join("");
}

function copyMatch(el) {
  navigator.clipboard.writeText(el.getAttribute("data-copy"));
  el.textContent = "\u2713";
  setTimeout(function() { el.innerHTML = "&#9112;"; }, 800);
}

function toggleRow(i) {
  var el = document.getElementById("row-" + i);
  if (!el) return;
  if (expandedRows.has(i)) { expandedRows.delete(i); el.classList.remove("open"); }
  else { expandedRows.add(i); el.classList.add("open"); }
}

// Sort headers
document.querySelectorAll(".sortable").forEach(function(th) {
  th.addEventListener("click", function() {
    var col = th.dataset.sort;
    if (sortCol === col) { sortAsc = !sortAsc; }
    else { sortCol = col; sortAsc = true; }
    renderAll();
  });
});

function renderExecStats(es) {
  if (!es || (es.total === 0 && !es.dryRunCount)) {
    $("execCards").innerHTML = '<div class="card"><div class="card-label">No Data</div><div class="card-value gray">--</div><div class="card-sub">No execution metrics yet</div></div>';
    $("reasonsBody").innerHTML = '<tr><td colspan="2" class="empty">No data</td></tr>';
    $("recentBody").innerHTML = '<tr><td colspan="10" class="empty">No data</td></tr>';
    return;
  }
  var drySub = es.dryRunCount > 0 ? " | " + es.dryRunCount + " dry-run" : "";
  $("execCards").innerHTML = [
    { label: "Avg Latency", value: Math.round(es.avgTotalMs) + "ms", cls: "blue",
      sub: "pre:" + Math.round(es.avgPreflightMs || 0) + " depth:" + Math.round(es.avgDepthMs || 0) + " 1st:" + Math.round(es.avgFirstLegMs) + " 2nd:" + Math.round(es.avgSecondLegMs) + " verify:" + Math.round(es.avgVerifyMs || 0) + "ms" },
    { label: "Total Attempts (Live)", value: es.total, cls: "blue",
      sub: es.aborts + " aborts (pre-trade)" + drySub },
    { label: "Fill Rate", value: (es.fillRate * 100).toFixed(1) + "%", cls: es.fillRate >= 0.5 ? "green" : es.fillRate > 0 ? "yellow" : "gray",
      sub: es.bothFilled + " filled / " + es.total + " attempts" },
  ].map(function(c) { return '<div class="card"><div class="card-label">' + c.label + '</div>' +
    '<div class="card-value ' + c.cls + '">' + c.value + '</div>' +
    '<div class="card-sub">' + c.sub + '</div></div>'; }).join("");

  if (es.topReasons && es.topReasons.length > 0) {
    $("reasonsBody").innerHTML = es.topReasons.map(function(r) {
      return '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td></tr>';
    }).join("");
  } else {
    $("reasonsBody").innerHTML = '<tr><td colspan="2" class="empty">No failures</td></tr>';
  }

  if (es.last10 && es.last10.length > 0) {
    $("recentBody").innerHTML = es.last10.map(function(m) {
      var outcomeClass = m.outcome === "both-filled" ? "green" : m.outcome === "hedge-entry" ? "yellow" : "gray";
      var outcomeLabel = m.outcome === "both-filled" ? "FILLED" : m.outcome === "hedge-entry" ? "HEDGE" : "ABORT";
      var dryTag = m.dryRun ? ' <span style="color:#8b949e;font-size:9px">[DRY]</span>' : '';
      var msOrDash = function(v) { return v > 0 ? v + "ms" : '<span class="gray">-</span>'; };
      var leg1 = m.firstLegOrderMs + m.firstLegConfirmMs;
      var leg2 = m.secondLegOrderMs + m.secondLegConfirmMs;
      return '<tr' + (m.dryRun ? ' style="opacity:0.5"' : '') + '>' +
        '<td>' + fmtDate(m.ts) + dryTag + '</td>' +
        '<td>' + esc(m.match.length > 20 ? m.match.substring(0,20) + ".." : m.match) + '</td>' +
        '<td><span class="' + outcomeClass + '">' + outcomeLabel + '</span></td>' +
        '<td>' + esc(m.failReason || "--") + '</td>' +
        '<td>' + msOrDash(m.preflightMs || 0) + '</td>' +
        '<td>' + msOrDash(m.depthCheckMs || 0) + '</td>' +
        '<td>' + msOrDash(leg1) + '</td>' +
        '<td>' + msOrDash(leg2) + '</td>' +
        '<td>' + msOrDash(m.postVerifyMs || 0) + '</td>' +
        '<td>' + m.totalMs + 'ms</td></tr>';
    }).join("");
  } else {
    $("recentBody").innerHTML = '<tr><td colspan="10" class="empty">No data</td></tr>';
  }
}

function renderMissedOpps(opps) {
  var tbody = $("missedBody");
  var badge = $("missedBadge");
  if (!opps || opps.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No missed opportunities</td></tr>';
    if (badge) { badge.style.display = "none"; }
    return;
  }
  if (badge) { badge.textContent = opps.length; badge.style.display = "inline-block"; }
  var totalProfit = 0;
  opps.forEach(function(o) { if (o.projectedProfit > 0) totalProfit += o.projectedProfit; });
  tbody.innerHTML = opps.map(function(o) {
    var edgePct = (o.edge * 100).toFixed(2);
    var profitStr = o.projectedProfit > 0 ? pnlStr(o.projectedProfit) : "--";
    var reasonShort = o.reason.length > 25 ? o.reason.substring(0,25) + ".." : o.reason;
    return '<tr>' +
      '<td>' + fmtDate(o.ts) + '</td>' +
      '<td>' + esc(o.match.length > 22 ? o.match.substring(0,22) + ".." : o.match) + '</td>' +
      '<td><span class="dir dir-' + o.dir + '">' + o.dir + '</span></td>' +
      '<td class="green">' + edgePct + '%</td>' +
      '<td>@' + (o.kalPrice > 0 ? o.kalPrice.toFixed(2) : "--") + '</td>' +
      '<td>@' + (o.pmPrice > 0 ? o.pmPrice.toFixed(2) : "--") + '</td>' +
      '<td>' + (o.shares || "--") + '</td>' +
      '<td class="green">' + profitStr + '</td>' +
      '<td style="color:#f85149">' + esc(reasonShort) + '</td>' +
      '</tr>';
  }).join("") +
  '<tr style="border-top:2px solid #30363d;font-weight:bold">' +
    '<td colspan="7" style="text-align:right;color:#8b949e">Total Projected Profit:</td>' +
    '<td class="green">' + pnlStr(totalProfit) + '</td>' +
    '<td></td></tr>';
}

function renderChainStatus(cs) {
  var el = $("chainStatus");
  if (!cs || cs.error) { el.style.display = "none"; return; }
  var dot = function(ok) { return '<span style="color:' + (ok ? "#4ade80" : "#666") + '">&#9679;</span>'; };
  el.style.display = "block";
  el.innerHTML = "Chain: " +
    dot(cs.httpProviderConnected) + " RPC " +
    dot(cs.wssProviderConnected) + " WSS " +
    dot(cs.fillSubscriptionActive) + " Fills " +
    dot(cs.settlementSubscriptionActive) + " Settlements" +
    ' <span style="color:#555;margin-left:12px">' + (cs.walletAddress !== "not initialized" ? esc(cs.walletAddress.slice(0,8)) + "..." : "no wallet") + '</span>';
}

// Fetch & render
async function fetchAndRender() {
  try {
    const [tradesRes, positionsRes, chainRes, execRes, reconcileRes, missedRes] = await Promise.all([
      fetch("/api/trades"), fetch("/api/positions"), fetch("/api/chain-status"), fetch("/api/exec-stats"), fetch("/api/reconcile-log"), fetch("/api/missed-opps")
    ]);
    allTrades = await tradesRes.json();
    const positions = await positionsRes.json();
    const chainStatus = await chainRes.json();
    const execStats = await execRes.json();
    const reconcileLog = await reconcileRes.json();
    const missedOpps = await missedRes.json();
    renderChainStatus(chainStatus);
    renderExecStats(execStats);
    renderMissedOpps(missedOpps);
    renderPositions(positions);
    await renderAll();
    // Reconcile info
    if (reconcileLog && reconcileLog.length > 0) {
      var last = reconcileLog[reconcileLog.length - 1];
      var ago = Math.round((Date.now() - new Date(last.ts).getTime()) / 60000);
      $("reconcileInfo").innerHTML = "Reconcile: " + ago + "m ago, " + last.changeCount + " changes (" + esc(last.trigger) + ")";
    }
    $("lastUpdate").textContent = new Date().toLocaleTimeString();
  } catch (e) {
    console.error("Fetch error:", e);
  }
}

// Countdown timer
let countdown = 1;
var _settlementMapLoaded = false;
setInterval(function() {
  countdown--;
  if (countdown <= 0) { countdown = 1; fetchAndRender(); }
  $("countdown").textContent = countdown;
  // Load settlement map once in background (don't block main render)
  if (!_settlementMapLoaded) {
    _settlementMapLoaded = true;
    fetch("/api/settlement-map").then(function(r) {
      if (r.ok) return r.json();
      _settlementMapLoaded = false; // retry next cycle
      return null;
    }).then(function(data) {
      if (data) { settlementMap = data; console.log("[SETTLEMENT-MAP] Loaded"); }
    }).catch(function() { _settlementMapLoaded = false; });
  }
}, 1000);

// --- Position Audit ----------------------------------------------------------

var auditData = null;

async function runAudit() {
  var btn = $("auditRunBtn");
  var status = $("auditStatus");
  btn.disabled = true;
  btn.textContent = "Running...";
  status.textContent = "Fetching exchange data... (this takes ~10-30s)";
  $("auditResults").innerHTML = '<div style="text-align:center;padding:40px;color:#8b949e"><div style="font-size:14px">Fetching fills from Kalshi + Polymarket...</div></div>';

  try {
    var force = auditData ? "?force=1" : "";
    var res = await fetch("/api/audit" + force);
    var data = await res.json();
    if (data.status === "running") {
      status.textContent = "Audit already running, retrying in 5s...";
      setTimeout(runAudit, 5000);
      return;
    }
    auditData = data;
    renderAudit(data);
  } catch (e) {
    status.textContent = "Audit failed: " + e.message;
    $("auditResults").innerHTML = '<div style="text-align:center;padding:40px;color:#f85149">' + e.message + '</div>';
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Position Audit";
  }
}

function renderAudit(data) {
  var status = $("auditStatus");
  var ts = new Date(data.ts).toLocaleTimeString();
  status.textContent = "Last run: " + ts + " (" + (data.durationMs / 1000).toFixed(1) + "s) | " +
    data.kalFillCount + " KAL fills, " + data.pmFillCount + " PM fills, " + data.tradeCount + " trades (since " + (data.cutoffDate || "all time") + ")";

  // Update badge
  var badge = $("auditBadge");
  var errorCount = data.summary.errors;
  if (errorCount > 0) {
    badge.style.display = "inline-block";
    badge.textContent = errorCount;
  } else {
    badge.style.display = "none";
  }

  // Summary stats
  $("auditSummary").innerHTML = '<div class="audit-summary">' +
    '<div class="audit-stat"><span class="num ' + (data.summary.errors > 0 ? 'red' : 'green') + '">' + data.summary.errors + '</span> Errors</div>' +
    '<div class="audit-stat"><span class="num ' + (data.summary.warnings > 0 ? 'yellow' : 'green') + '">' + data.summary.warnings + '</span> Warnings</div>' +
    '<div class="audit-stat"><span class="num blue">' + data.kalFillCount + '</span> KAL Fills</div>' +
    '<div class="audit-stat"><span class="num blue">' + data.pmFillCount + '</span> PM Fills</div>' +
    '</div>';

  // Discrepancies
  var html = "";
  if (data.discrepancies.length === 0) {
    html = '<div class="audit-clean">All exchange fills match dashboard records</div>';
  } else {
    // Sort: errors first, then warnings
    var sorted = data.discrepancies.slice().sort(function(a, b) {
      var order = { error: 0, warning: 1, info: 2 };
      return (order[a.severity] || 3) - (order[b.severity] || 3);
    });
    for (var i = 0; i < sorted.length; i++) {
      var d = sorted[i];
      html += '<div class="audit-discrepancy ' + d.severity + '">' +
        '<div class="aud-type">' + d.type + (d.severity === "error" ? " !!!" : "") + '</div>' +
        (d.match ? '<div class="aud-match">' + d.match + (d.ticker ? ' <span style="color:#8b949e">(' + d.ticker + ')</span>' : '') + '</div>' : '') +
        (!d.match && d.ticker ? '<div class="aud-match" style="color:#8b949e">' + d.ticker + '</div>' : '') +
        '<div class="aud-detail">' + d.detail + '</div>' +
        '</div>';
    }
  }
  $("auditResults").innerHTML = html;
}

// --- Verified P&L ------------------------------------------------------------

// --- Wallet Arbs ------------------------------------------------------------
async function ignorePos(kalTicker, pmTokenId) {
  try {
    var r = await fetch("/api/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kalTicker: kalTicker, pmTokenId: pmTokenId }),
    });
    var j = await r.json();
    if (!j.ok) { alert("Ignore failed: " + (j.error || "unknown")); return; }
    loadWalletArbs();
  } catch (e) { alert("Ignore request failed: " + e.message); }
}
async function unignorePos(kalTicker, pmTokenId) {
  try {
    var r = await fetch("/api/unignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kalTicker: kalTicker, pmTokenId: pmTokenId }),
    });
    var j = await r.json();
    if (!j.ok) { alert("Unignore failed: " + (j.error || "not found")); return; }
    loadWalletArbs();
  } catch (e) { alert("Unignore request failed: " + e.message); }
}

async function pmSellExit(tokenId, shares, negRisk) {
  if (!confirm("Market-sell " + shares + " PM shares at best bid via FAK?\\n\\n" +
               "Note: if DRY_RUN=true in settings, this just simulates.")) return;
  try {
    var res = await fetch("/api/pm-sell", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenId: tokenId, shares: shares, negRisk: !!negRisk }),
    });
    var j = await res.json();
    if (j.ok) {
      alert((j.dryRun ? "[DRY RUN] " : "") + "SELL placed at $" + j.price + " for " + j.requestedShares + " shares.");
    } else {
      alert("SELL failed: " + (j.error || "unknown"));
    }
    loadWalletArbs();
  } catch (e) { alert("SELL request failed: " + e.message); }
}

async function pmRedeem(conditionId, outcomeIndex, negRisk) {
  if (negRisk) {
    var slug = prompt("negRisk markets can't be redeemed automatically yet.\\nOpen your Polymarket portfolio to redeem manually?", "yes");
    if (slug === "yes") window.open("https://polymarket.com/portfolio", "_blank");
    return;
  }
  if (!confirm("Redeem winning position on-chain?\\n\\nconditionId: " + conditionId.slice(0, 16) + "...\\noutcome: " + outcomeIndex + "\\n\\nIf DRY_RUN=true, this just simulates.")) return;
  try {
    var res = await fetch("/api/pm-redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conditionId: conditionId, outcomeIndex: outcomeIndex, negRisk: !!negRisk }),
    });
    var j = await res.json();
    if (j.ok) {
      alert((j.dryRun ? "[DRY RUN] " : "") + "REDEEM " + (j.dryRun ? "simulated" : "submitted") + ". txHash: " + j.txHash);
    } else {
      alert("REDEEM failed: " + (j.error || "unknown"));
    }
    loadWalletArbs();
  } catch (e) { alert("REDEEM request failed: " + e.message); }
}

async function loadOpenOrders() {
  try {
    var r = await fetch("/api/open-orders");
    var d = await r.json();
    var count = (d.kal?.length || 0) + (d.pm?.length || 0);
    $("walletArbsOpenOrdersCount").textContent = "(" + count + ")";
    var body = $("walletArbsOpenOrdersBody");
    if (count === 0) {
      body.innerHTML = '<tr><td colspan="8" class="empty">No open orders</td></tr>';
      return;
    }
    var rows = [];
    (d.kal || []).forEach(function(o) {
      rows.push('<tr>' +
        '<td>KAL</td>' +
        '<td>' + esc(o.matchName || "-") + (o.side ? ' <span style="color:#8b949e">(' + esc(o.side) + ')</span>' : '') + '</td>' +
        '<td style="font-size:11px">' + esc(o.ticker) + '</td>' +
        '<td>' + esc(o.action || "BUY") + '</td>' +
        '<td>$' + (o.priceDollars || 0).toFixed(2) + '</td>' +
        '<td>' + o.remaining + '</td>' +
        '<td>$' + ((o.remaining || 0) * (o.priceDollars || 0)).toFixed(2) + '</td>' +
        '<td style="font-size:10px;color:#8b949e">' + esc((o.orderId || "").slice(0, 12)) + '...</td>' +
        '</tr>');
    });
    (d.pm || []).forEach(function(o) {
      rows.push('<tr>' +
        '<td>PM</td>' +
        '<td>' + esc(o.matchName || "-") + ' / ' + esc(o.outcome || "-") + '</td>' +
        '<td style="font-size:11px">' + esc((o.tokenId || "").slice(0, 18)) + '...</td>' +
        '<td>' + esc(o.side || "BUY") + '</td>' +
        '<td>$' + (o.priceDollars || 0).toFixed(2) + '</td>' +
        '<td>' + (o.filled || 0).toFixed(2) + ' / ' + (o.originalSize || 0).toFixed(2) + '</td>' +
        '<td>$' + (o.totalDollars || 0).toFixed(2) + '</td>' +
        '<td style="font-size:10px;color:#8b949e">' + esc((o.orderId || "").slice(0, 12)) + '...</td>' +
        '</tr>');
    });
    body.innerHTML = rows.join("");
  } catch (e) {
    $("walletArbsOpenOrdersBody").innerHTML = '<tr><td colspan="8" class="empty">Failed: ' + esc(e.message) + '</td></tr>';
  }
}

async function loadWalletArbs() {
  var btn = $("walletArbsRefreshBtn");
  if (btn) btn.textContent = "Loading...";
  // Kick the open-orders fetch in parallel — separate endpoint, don't block the main view.
  loadOpenOrders();
  try {
    var res = await fetch("/api/wallet-arbs");
    var d = await res.json();
    if (d.error) {
      $("walletArbsTotals").textContent = "Error: " + d.error;
      return;
    }
    var totals = d.totals || {};
    var bs = totals.unpairedPmByStatus || {};
    $("walletArbsTotals").innerHTML =
      'Paired arbs: <b>' + totals.pairedArbs + '</b>  &bull;  ' +
      'Unpaired KAL: <b>' + totals.unpairedKal + '</b>  &bull;  ' +
      'PM: <b>' + totals.unpairedPm + '</b> ' +
      '(<span style="color:#f85149">naked ' + (bs.naked||0) + '</span>, ' +
      '<span style="color:#58a6ff">pm-only ' + (bs.pmOnlyHedged||0) + '</span>, ' +
      '<span style="color:#ff7b00">pm-only-imbal ' + (bs.pmOnlyImbalanced||0) + '</span>, ' +
      '<span style="color:#d29922">kal-settled ' + (bs.kalSettledPmPending||0) + '</span>, ' +
      '<span style="color:#3fb950">win ' + (bs.winners||0) + '</span>, ' +
      '<span style="color:#8b949e">lose ' + (bs.losers||0) + '</span>, ' +
      'other ' + ((bs.noPair||0) + (bs.void||0)) + ')  &bull;  ' +
      'KAL cost: <b>$' + (totals.totalKalCost || 0).toFixed(2) + '</b>  &bull;  ' +
      'PM cost: <b>$' + (totals.totalPmCost || 0).toFixed(2) + '</b>  &bull;  ' +
      'Total at risk: <b>$' + (totals.totalCapitalAtRisk || 0).toFixed(2) + '</b>  &bull;  ' +
      'Watchlist: ' + d.watchlistEntries + ' entries';
    // Paired table
    var tb = $("walletArbsPairedBody");
    if (!d.paired || d.paired.length === 0) {
      tb.innerHTML = '<tr><td colspan="16" class="empty">No paired arbs found</td></tr>';
    } else {
      tb.innerHTML = d.paired.map(function(r) {
        var netKalC = r.netIfKalWins >= 0 ? '#3fb950' : '#f85149';
        var netPmC = r.netIfPmWins >= 0 ? '#3fb950' : '#f85149';
        var curC = r.currentPnl >= 0 ? '#3fb950' : '#f85149';
        var typeBadge;
        if (r.pairingType === 'same-direction') {
          typeBadge = '<span style="color:#d29922;font-size:10px;padding:1px 4px;border:1px solid #d29922;border-radius:3px" title="Both legs on the SAME outcome — directional bet, never was an arb">SAME-SIDE</span>';
        } else if (r.pairingType === 'imbalanced') {
          typeBadge = '<span style="color:#ff7b00;font-size:10px;padding:1px 4px;border:1px solid #ff7b00;border-radius:3px" title="Opposite outcomes but sizes mismatched — directional exposure dressed as a hedge">IMBALANCED</span>';
        } else {
          typeBadge = '<span style="color:#3fb950;font-size:10px;padding:1px 4px;border:1px solid #3fb950;border-radius:3px" title="Opposite outcomes, sizes balanced — locked-in min-profit arb">HEDGED</span>';
        }
        return '<tr>' +
          '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
          '<td>' + esc(r.match) + '</td>' +
          '<td>' + typeBadge + '</td>' +
          '<td style="font-size:11px">' + esc(r.kalTicker) + '</td>' +
          '<td><span class="dir dir-' + (r.kalSide === "no" ? "C" : "A") + '">' + r.kalSide.toUpperCase() + '</span></td>' +
          '<td>' + r.kalShares + '</td>' +
          '<td>' + r.kalAvgPrice + '</td>' +
          '<td>$' + r.kalCost.toFixed(2) + '</td>' +
          '<td>' + esc(r.pmOutcome) + '</td>' +
          '<td>' + r.pmShares + '</td>' +
          '<td>' + r.pmAvgPrice + '</td>' +
          '<td>$' + r.pmCost.toFixed(2) + '</td>' +
          '<td>$' + r.totalCost.toFixed(2) + '</td>' +
          '<td style="color:' + curC + '">$' + (r.currentPnl || 0).toFixed(2) + '</td>' +
          '<td style="color:' + netKalC + '">$' + r.netIfKalWins.toFixed(2) + '</td>' +
          '<td style="color:' + netPmC + '">$' + r.netIfPmWins.toFixed(2) + '</td>' +
          '</tr>';
      }).join("");
    }
    // Unpaired KAL (now includes hedge-status + ignore button columns)
    var kb = $("walletArbsKalBody");
    if (!d.unpairedKal || d.unpairedKal.length === 0) {
      kb.innerHTML = '<tr><td colspan="8" class="empty">No unpaired Kalshi positions</td></tr>';
    } else {
      kb.innerHTML = d.unpairedKal.map(function(r) {
        return '<tr><td>' + ageLabel(r.firstSeenAt) + '</td>' +
          '<td style="font-size:11px">' + esc(r.ticker) + hedgeBadge(r.hedgeInfo) + '</td>' +
          '<td>' + r.side.toUpperCase() + '</td>' +
          '<td>' + r.shares + '</td>' +
          '<td>' + r.avgPrice + '</td>' +
          '<td>$' + r.cost.toFixed(2) + '</td>' +
          '<td>' + (r.hedgeInfo ? '<span style="color:#3fb950;font-size:11px">hedging</span>' : '<span style="color:#8b949e;font-size:11px">—</span>') + '</td>' +
          '<td>' + ignoreBtn(r.ticker, null) + '</td>' +
          '</tr>';
      }).join("");
    }
    // Unpaired PM — split by status into buckets
    var byStatus = { "naked": [], "pm-only-hedged": [], "pm-only-imbalanced": [], "kal-settled-pm-pending": [], "settled-winner": [], "settled-loser": [], "no-pair": [], "void": [] };
    (d.unpairedPm || []).forEach(function(r) { (byStatus[r.pmStatus] || byStatus.naked).push(r); });

    var nakedCt = byStatus.naked.length;
    var pmOnlyCt = byStatus["pm-only-hedged"].length;
    var pmOnlyImbalCt = byStatus["pm-only-imbalanced"].length;
    var kalPendCt = byStatus["kal-settled-pm-pending"].length;
    var winCt = byStatus["settled-winner"].length;
    var loseCt = byStatus["settled-loser"].length;
    var otherCt = byStatus["no-pair"].length + byStatus.void.length;
    $("walletArbsNakedCount").textContent = "(" + nakedCt + ")";
    $("walletArbsPmOnlyCount").textContent = "(" + pmOnlyCt + ")";
    $("walletArbsPmOnlyImbalCount").textContent = "(" + pmOnlyImbalCt + ")";
    $("walletArbsKalPendingCount").textContent = "(" + kalPendCt + ")";
    $("walletArbsWinnersCount").textContent = "(" + winCt + ")";
    $("walletArbsLosersCount").textContent = "(" + loseCt + ")";
    $("walletArbsOtherCount").textContent = "(" + otherCt + ")";

    function titleOutcome(r) {
      return esc((r.title || "").slice(0, 48)) + " / " + esc(r.outcome);
    }
    function sellBtn(r) {
      return '<button class="audit-btn" style="padding:2px 8px;font-size:11px" onclick="pmSellExit(\\'' + r.tokenId + '\\', ' + r.shares + ', ' + (r.negRisk ? 'true' : 'false') + ')">Sell at mkt</button>';
    }
    function redeemBtn(r) {
      return '<button class="audit-btn" style="padding:2px 8px;font-size:11px;background:#238636" onclick="pmRedeem(\\'' + r.conditionId + '\\', ' + r.outcomeIndex + ', ' + (r.negRisk ? 'true' : 'false') + ')">Redeem</button>';
    }
    function ignoreBtn(kalTicker, pmTokenId) {
      var kt = kalTicker ? '\\'' + kalTicker + '\\'' : 'null';
      var tid = pmTokenId ? '\\'' + pmTokenId + '\\'' : 'null';
      return '<button class="audit-btn" style="padding:2px 8px;font-size:11px;background:#21262d" title="Stop monitoring this position" onclick="ignorePos(' + kt + ', ' + tid + ')">✖ Ignore</button>';
    }
    function unignoreBtn(kalTicker, pmTokenId) {
      var kt = kalTicker ? '\\'' + kalTicker + '\\'' : 'null';
      var tid = pmTokenId ? '\\'' + pmTokenId + '\\'' : 'null';
      return '<button class="audit-btn" style="padding:2px 8px;font-size:11px;background:#1f6feb" onclick="unignorePos(' + kt + ', ' + tid + ')">Un-ignore</button>';
    }
    // Shared hedge-status badge: shows "🔄 7 @ $0.34" when an open order is actively hedging this row.
    function hedgeBadge(h) {
      if (!h || !h.remaining) return '';
      return ' <span style="font-size:10px;color:#58a6ff;padding:1px 4px;border:1px solid #58a6ff;border-radius:3px" ' +
             'title="Open ' + esc(h.side) + ' order hedging this position">🔄 ' + h.remaining + ' @ $' + (h.price || 0).toFixed(2) + '</span>';
    }

    // Naked (shows hedge-in-flight badge + ignore button)
    var nb = $("walletArbsPmNakedBody");
    if (nakedCt === 0) nb.innerHTML = '<tr><td colspan="11" class="empty">No naked PM positions</td></tr>';
    else nb.innerHTML = byStatus.naked.map(function(r) {
      return '<tr>' +
        '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td>' + esc(r.pairedMatchName || "?") + hedgeBadge(r.hedgeInfo) + '</td>' +
        '<td>' + titleOutcome(r) + '</td>' +
        '<td style="font-size:11px">' + esc(r.pairedKalTicker || "-") + '</td>' +
        '<td>' + esc(r.kalStatus || "-") + '</td>' +
        '<td>' + r.shares + '</td><td>' + r.avgPrice + '</td><td>' + r.curPrice + '</td>' +
        '<td>$' + r.cost.toFixed(2) + '</td><td>$' + r.currentValue.toFixed(2) + '</td>' +
        '<td>' + sellBtn(r) + ' ' + ignoreBtn(null, r.tokenId) + '</td></tr>';
    }).join("");

    function pmOnlyRow(r) {
      return '<tr>' +
        '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td>' + esc(r.pairedMatchName || "?") + '</td>' +
        '<td>' + titleOutcome(r) + '</td>' +
        '<td style="font-size:11px">' + esc(r.pairedKalTicker || "-") + '</td>' +
        '<td>' + r.shares + '</td>' +
        '<td>' + (r.oppositeShares || 0) + '</td>' +
        '<td>' + r.avgPrice + '</td><td>' + r.curPrice + '</td>' +
        '<td>$' + r.cost.toFixed(2) + '</td><td>$' + r.currentValue.toFixed(2) + '</td>' +
        '<td>' + sellBtn(r) + '</td></tr>';
    }
    // PM-only hedged BALANCED (both sides held, sizes match)
    var pob = $("walletArbsPmOnlyBody");
    if (pmOnlyCt === 0) pob.innerHTML = '<tr><td colspan="11" class="empty">--</td></tr>';
    else pob.innerHTML = byStatus["pm-only-hedged"].map(pmOnlyRow).join("");
    // PM-only IMBALANCED (both sides held, sizes mismatched → directional exposure)
    var poib = $("walletArbsPmOnlyImbalBody");
    if (pmOnlyImbalCt === 0) poib.innerHTML = '<tr><td colspan="11" class="empty">--</td></tr>';
    else poib.innerHTML = byStatus["pm-only-imbalanced"].map(pmOnlyRow).join("");

    // Kal-settled-pm-pending
    var kpb = $("walletArbsPmKalPendingBody");
    if (kalPendCt === 0) kpb.innerHTML = '<tr><td colspan="11" class="empty">--</td></tr>';
    else kpb.innerHTML = byStatus["kal-settled-pm-pending"].map(function(r) {
      return '<tr>' +
        '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td>' + esc(r.pairedMatchName || "?") + '</td>' +
        '<td>' + titleOutcome(r) + '</td>' +
        '<td style="font-size:11px">' + esc(r.pairedKalTicker || "-") + '</td>' +
        '<td>' + esc(r.kalResult || "?") + '</td>' +
        '<td>' + r.shares + '</td><td>' + r.avgPrice + '</td><td>' + r.curPrice + '</td>' +
        '<td>$' + r.cost.toFixed(2) + '</td><td>$' + r.currentValue.toFixed(2) + '</td>' +
        '<td>' + sellBtn(r) + '</td></tr>';
    }).join("");

    function pendingTag(r) {
      return r.pendingRedemption ? ' <span style="font-size:10px;color:#d29922" title="PM market looks resolved by price but redeemable flag is still false. Wait a few minutes for PM to mark as redeemable.">(pending)</span>' : '';
    }
    // Winners
    var wb = $("walletArbsPmWinnersBody");
    if (winCt === 0) wb.innerHTML = '<tr><td colspan="9" class="empty">--</td></tr>';
    else wb.innerHTML = byStatus["settled-winner"].map(function(r) {
      return '<tr>' +
        '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td>' + esc(r.pairedMatchName || "?") + pendingTag(r) + '</td>' +
        '<td>' + titleOutcome(r) + '</td>' +
        '<td style="font-size:11px">' + esc(r.pairedKalTicker || "-") + '</td>' +
        '<td>' + r.shares + '</td><td>' + r.avgPrice + '</td><td>' + r.curPrice + '</td>' +
        '<td style="color:#3fb950">$' + r.shares.toFixed(2) + '</td>' +
        '<td>' + redeemBtn(r) + '</td></tr>';
    }).join("");

    // Losers
    var lb = $("walletArbsPmLosersBody");
    if (loseCt === 0) lb.innerHTML = '<tr><td colspan="7" class="empty">--</td></tr>';
    else lb.innerHTML = byStatus["settled-loser"].map(function(r) {
      return '<tr>' +
        '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td>' + esc(r.pairedMatchName || "?") + pendingTag(r) + '</td>' +
        '<td>' + titleOutcome(r) + '</td>' +
        '<td>' + r.shares + '</td><td>' + r.avgPrice + '</td><td>' + r.curPrice + '</td>' +
        '<td>' + redeemBtn(r) + '</td></tr>';
    }).join("");

    // No-pair / void
    var ob = $("walletArbsPmOtherBody");
    var other = byStatus["no-pair"].concat(byStatus.void);
    if (other.length === 0) ob.innerHTML = '<tr><td colspan="7" class="empty">--</td></tr>';
    else ob.innerHTML = other.map(function(r) {
      return '<tr><td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td>' + titleOutcome(r) + '</td>' +
        '<td style="font-size:11px">' + esc(r.tokenId.slice(0, 20)) + '...</td>' +
        '<td>' + esc(r.pmStatus) + '</td>' +
        '<td>' + r.shares + '</td><td>' + r.avgPrice + '</td><td>$' + r.cost.toFixed(2) + '</td></tr>';
    }).join("");

    // Ignored section — manually hidden positions. Unignore button returns them to active buckets.
    var ignRows = d.ignored || [];
    $("walletArbsIgnoredCount").textContent = "(" + ignRows.length + ")";
    var ib = $("walletArbsIgnoredBody");
    if (ignRows.length === 0) ib.innerHTML = '<tr><td colspan="8" class="empty">No ignored positions</td></tr>';
    else ib.innerHTML = ignRows.map(function(r) {
      var kal = r.ticker || r.kalTicker || "";
      var pm = r.tokenId || "";
      var match = r.match || r.pairedMatchName || r.title || kal || pm.slice(0, 18) + "...";
      var outcome = r.side ? r.side.toUpperCase() : (r.outcome || "");
      var shares = r.shares != null ? r.shares : (r.kalShares || r.pmShares || 0);
      var avg = r.avgPrice != null ? r.avgPrice : (r.kalAvgPrice != null ? r.kalAvgPrice : (r.pmAvgPrice != null ? r.pmAvgPrice : 0));
      var cost = r.cost != null ? r.cost : (r.kalCost != null ? r.kalCost : (r.pmCost != null ? r.pmCost : 0));
      return '<tr style="opacity:0.6">' +
        '<td>' + ageLabel(r.firstSeenAt) + '</td>' +
        '<td style="font-size:11px;color:#8b949e">' + esc(r._src || "?") + '</td>' +
        '<td>' + esc(match) + (kal ? ' <span style="font-size:10px;color:#6e7681">' + esc(kal) + '</span>' : '') + '</td>' +
        '<td>' + esc(outcome) + '</td>' +
        '<td>' + shares + '</td>' +
        '<td>' + (avg || 0) + '</td>' +
        '<td>$' + (cost || 0).toFixed(2) + '</td>' +
        '<td>' + unignoreBtn(kal, pm) + '</td>' +
        '</tr>';
    }).join("");
  } catch (e) {
    $("walletArbsTotals").textContent = "Failed: " + e.message;
  } finally {
    if (btn) btn.textContent = "Refresh";
  }
}

async function runVerifiedPnl() {
  var btn = $("verifiedRunBtn");
  var status = $("verifiedStatus");
  btn.disabled = true;
  btn.textContent = "Fetching...";
  status.textContent = "Querying Kalshi + Polymarket APIs...";

  try {
    var res = await fetch("/api/verified-pnl?force=1");
    var data = await res.json();
    renderVerifiedPnl(data);
  } catch (e) {
    status.textContent = "Failed: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch Exchange-Verified P&L";
  }
}

function renderVerifiedPnl(d) {
  var status = $("verifiedStatus");
  status.textContent = "Last run: " + new Date(d.ts).toLocaleTimeString() + " (" + (d.durationMs / 1000).toFixed(1) + "s)";

  var pnlColor = function(v) { return v >= 0 ? "#3fb950" : "#f85149"; };
  var fmt = function(v) { return "$" + (v >= 0 ? "" : "-") + Math.abs(v).toFixed(2); };

  var html = '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin:16px 0;">';

  // Kalshi card
  html += '<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;">';
  html += '<h3 style="color:#58a6ff;margin-bottom:12px;font-size:14px;">Kalshi</h3>';
  html += '<div style="font-size:24px;font-weight:bold;color:' + pnlColor(d.kalshi.netPnl) + '">' + fmt(d.kalshi.netPnl) + '</div>';
  html += '<div style="color:#8b949e;font-size:12px;margin-top:8px;">';
  html += 'Spent: ' + fmt(d.kalshi.totalSpent) + '<br>';
  html += 'Revenue: ' + fmt(d.kalshi.totalRevenue) + '<br>';
  html += 'Fees: ' + fmt(d.kalshi.totalFees) + '<br>';
  html += 'Fills: ' + d.kalshi.fillCount + ' | Settlements: ' + d.kalshi.settlementCount + '<br>';
  html += 'Open position value: ' + fmt(d.kalshi.openPositionValue);
  html += '</div></div>';

  // PM card
  html += '<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;">';
  html += '<h3 style="color:#f0883e;margin-bottom:12px;font-size:14px;">Polymarket</h3>';
  html += '<div style="font-size:24px;font-weight:bold;color:' + pnlColor(d.polymarket.netPnl) + '">' + fmt(d.polymarket.netPnl) + '</div>';
  html += '<div style="color:#8b949e;font-size:12px;margin-top:8px;">';
  html += 'Spent: ' + fmt(d.polymarket.totalSpent) + '<br>';
  html += 'Revenue: ' + fmt(d.polymarket.totalRevenue) + '<br>';
  html += 'Fees: ' + fmt(d.polymarket.totalFees) + '<br>';
  html += 'Fills: ' + d.polymarket.fillCount + '<br>';
  html += 'USDC Balance: ' + fmt(d.polymarket.currentBalance);
  html += '</div></div>';

  // Combined card
  html += '<div style="background:#161b22;border:1px solid ' + (d.combined.netPnl >= 0 ? "#3fb950" : "#f85149") + ';border-radius:8px;padding:16px;">';
  html += '<h3 style="color:#c9d1d9;margin-bottom:12px;font-size:14px;">Combined</h3>';
  html += '<div style="font-size:28px;font-weight:bold;color:' + pnlColor(d.combined.netPnl) + '">' + fmt(d.combined.netPnl) + '</div>';
  html += '<div style="color:#8b949e;font-size:12px;margin-top:8px;">';
  html += 'Total Spent: ' + fmt(d.combined.totalSpent) + '<br>';
  html += 'Total Revenue: ' + fmt(d.combined.totalRevenue) + '<br>';
  html += 'Total Fees: ' + fmt(d.combined.totalFees);
  html += '</div></div>';
  html += '</div>';

  // Open positions
  if (d.combined.openPositions && d.combined.openPositions.length > 0) {
    html += '<h3 style="color:#8b949e;font-size:13px;margin:16px 0 8px;">Open Positions (' + d.combined.openPositions.length + ')</h3>';
    html += '<table style="width:100%"><thead><tr><th>Exchange</th><th>Ticker</th><th>Side</th><th>Count</th><th>Avg Price</th></tr></thead><tbody>';
    d.combined.openPositions.forEach(function(p) {
      html += '<tr><td>' + esc(p.exchange) + '</td><td>' + esc(p.ticker) + '</td><td>' + p.side + '</td><td>' + p.count + '</td><td>' + fmt(p.avgPrice) + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  // Settlement details
  if (d.details.kalshiSettlements && d.details.kalshiSettlements.length > 0) {
    html += '<h3 style="color:#8b949e;font-size:13px;margin:16px 0 8px;">Kalshi Settlements (' + d.details.kalshiSettlements.length + ')</h3>';
    html += '<table style="width:100%"><thead><tr><th>Ticker</th><th>Result</th><th>Revenue</th><th>Cost</th><th>Fee</th><th>Net</th><th>Time</th></tr></thead><tbody>';
    d.details.kalshiSettlements.sort(function(a,b) { return b.ts > a.ts ? 1 : -1; }).forEach(function(s) {
      var net = s.revenue - s.cost - s.fee;
      html += '<tr><td style="font-size:11px">' + esc(s.ticker) + '</td><td>' + s.result + '</td>';
      html += '<td>' + fmt(s.revenue) + '</td><td>' + fmt(s.cost) + '</td><td>' + fmt(s.fee) + '</td>';
      html += '<td style="color:' + pnlColor(net) + '">' + fmt(net) + '</td>';
      html += '<td style="color:#484f58;font-size:11px">' + (s.ts ? new Date(s.ts).toLocaleString() : "--") + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  // Raw API samples (for debugging unit issues)
  if (d.rawSamples) {
    html += '<h3 style="color:#f0883e;font-size:13px;margin:16px 0 8px;">Raw API Samples (for debugging)</h3>';
    html += '<div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px;font-family:monospace;font-size:11px;white-space:pre-wrap;color:#8b949e;max-height:300px;overflow:auto">';
    html += '<b style="color:#58a6ff">Kalshi Settlements (first 3):</b>\\n';
    html += JSON.stringify(d.rawSamples.kalSettlements, null, 2) + '\\n\\n';
    html += '<b style="color:#58a6ff">Kalshi Fills (first 3):</b>\\n';
    html += JSON.stringify(d.rawSamples.kalFills, null, 2) + '\\n\\n';
    html += '<b style="color:#f0883e">PM Fills (first 3):</b>\\n';
    html += JSON.stringify(d.rawSamples.pmFills, null, 2);
    html += '</div>';
  }

  $("verifiedSummary").innerHTML = "";
  $("verifiedDetails").innerHTML = html;
}

// --- Orderbook viewer --------------------------------------------------------

var obWatchlist = [];
var obSelectedMatch = null;
var obTimer = null;

async function loadWatchlist() {
  try {
    var res = await fetch("/api/watchlist");
    obWatchlist = await res.json();
    var sel = $("obMatchSelect");
    sel.innerHTML = '<option value="">-- Select a match (' + obWatchlist.length + ' matches) --</option>';
    obWatchlist.forEach(function(m, i) {
      var label = m.kal1.surname + " vs " + m.kal2.surname + "  [" + m.date + "]";
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = label;
      sel.appendChild(opt);
    });
  } catch(e) { console.error("Watchlist load error:", e); }
}

function renderBookLevels(tbodyId, levels, isBid) {
  var tbody = $(tbodyId);
  if (!levels || levels.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="color:#484f58;text-align:center;font-size:11px">empty</td></tr>';
    return;
  }
  // For bids: sort descending (best bid first). For asks: sort ascending (best ask first).
  var sorted = levels.slice().sort(function(a, b) { return isBid ? b[0] - a[0] : a[0] - b[0]; });
  var maxCum = 0;
  sorted.forEach(function(l) { maxCum += l[1]; });
  var cum = 0;
  tbody.innerHTML = sorted.slice(0, 15).map(function(l) {
    var price = Number(l[0]).toFixed(1);
    var size = Math.round(Number(l[1]) * 100) / 100;
    cum += size;
    cum = Math.round(cum * 100) / 100;
    var pct = maxCum > 0 ? Math.round((cum / maxCum) * 100) : 0;
    var barColor = isBid ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)";
    var textColor = isBid ? "#3fb950" : "#f85149";
    return '<tr style="background:linear-gradient(90deg,' + barColor + ' ' + pct + '%,transparent ' + pct + '%)">' +
      '<td style="color:' + textColor + '">' + price + '\\u00A2</td>' +
      '<td>' + size + '</td>' +
      '<td style="color:#484f58">' + cum + '</td></tr>';
  }).join("");
}

async function obSubscribe(m) {
  // Tell server to subscribe to WS streams for this match
  var tickers = m.kal1.ticker + "," + m.kal2.ticker;
  var tokenIds = m.pm1.tokenId + "," + m.pm2.tokenId;
  try {
    var res = await fetch("/api/ob-subscribe?tickers=" + encodeURIComponent(tickers) + "&tokenIds=" + encodeURIComponent(tokenIds));
    var status = await res.json();
    var connStr = (status.kalshiConnected ? "\\u2705 KAL" : "\\u274C KAL") + " " + (status.pmConnected ? "\\u2705 PM" : "\\u274C PM");
    $("obLatency").textContent = connStr;
  } catch(e) { console.error("Subscribe error:", e); }
}

async function fetchOrderbook() {
  if (!obSelectedMatch) return;
  var m = obSelectedMatch;
  var t0 = performance.now();

  try {
    var res = await fetch("/api/orderbook");
    var data = await res.json();
    var latency = Math.round(performance.now() - t0);

    // Update labels
    $("obKalTicker").textContent = m.kal1.ticker.replace(/KXATPMATCH-|KXCS2GAME-|KXLOLGAME-|KXVALGAME-/g, "");
    $("obPmSlug").textContent = m.pmSlug;
    $("obPm1Label").textContent = m.pm1.outcome + " (" + m.kal1.surname + ")";
    $("obPm2Label").textContent = m.pm2.outcome + " (" + m.kal2.surname + ")";

    // Connection status
    var connStr = (data.kalshiConnected ? "\\u2705 KAL" : "\\u274C KAL") + " " + (data.pmConnected ? "\\u2705 PM" : "\\u274C PM");

    // Kalshi data -- keyed by ticker
    var k1 = (data.kalshi || {})[m.kal1.ticker] || { yes: [], no: [] };
    var k2 = (data.kalshi || {})[m.kal2.ticker] || { yes: [], no: [] };
    var k1Age = k1.age != null ? k1.age : -1;

    // YES bids from yes[], YES asks derived from no[] (100 - noBid)
    var k1YesBids = (k1.yes || []).map(function(l) { return [l[0], l[1]]; });
    var k1YesAsks = (k1.no || []).map(function(l) { return [100 - l[0], l[1]]; });
    var k1NoBids = (k1.no || []).map(function(l) { return [l[0], l[1]]; });
    var k1NoAsks = (k1.yes || []).map(function(l) { return [100 - l[0], l[1]]; });

    renderBookLevels("obKalYesBids", k1YesBids, true);
    renderBookLevels("obKalYesAsks", k1YesAsks, false);
    renderBookLevels("obKalNoBids", k1NoBids, true);
    renderBookLevels("obKalNoAsks", k1NoAsks, false);

    // Summary
    var bestYesBid = k1YesBids.length > 0 ? Math.max.apply(null, k1YesBids.map(function(l) { return l[0]; })) : 0;
    var bestYesAsk = k1YesAsks.length > 0 ? Math.min.apply(null, k1YesAsks.map(function(l) { return l[0]; })) : 0;
    var k1TotalYesBidVol = k1YesBids.reduce(function(s, l) { return s + l[1]; }, 0);
    var k1TotalYesAskVol = k1YesAsks.reduce(function(s, l) { return s + l[1]; }, 0);
    var k2YesBids = (k2.yes || []);
    var k2NoLevels = (k2.no || []);
    var k2BestBid = k2YesBids.length > 0 ? Math.max.apply(null, k2YesBids.map(function(l) { return l[0]; })) : 0;
    var k2BestAsk = k2NoLevels.length > 0 ? Math.min.apply(null, k2NoLevels.map(function(l) { return 100 - l[0]; })) : 0;
    $("obKalSummary").innerHTML = m.kal1.surname + ": YES bid <span class='green'>" + bestYesBid + "\\u00A2</span> / ask <span class='red'>" + bestYesAsk + "\\u00A2</span>" +
      " | Vol: " + k1TotalYesBidVol + "b / " + k1TotalYesAskVol + "a" +
      (k1Age >= 0 ? " | <span style='color:#484f58'>" + k1Age + "ms ago</span>" : "") +
      "<br>" + m.kal2.surname + ": YES bid <span class='green'>" + k2BestBid + "\\u00A2</span> / ask <span class='red'>" + k2BestAsk + "\\u00A2</span>";

    // PM data -- keyed by tokenId. Prices already in cents from server.
    var pm1 = (data.pm || {})[m.pm1.tokenId] || { bids: [], asks: [] };
    var pm2 = (data.pm || {})[m.pm2.tokenId] || { bids: [], asks: [] };
    renderBookLevels("obPm1Bids", pm1.bids || [], true);
    renderBookLevels("obPm1Asks", pm1.asks || [], false);
    renderBookLevels("obPm2Bids", pm2.bids || [], true);
    renderBookLevels("obPm2Asks", pm2.asks || [], false);

    // PM summary
    var pm1BestBid = (pm1.bids || []).length > 0 ? Math.max.apply(null, (pm1.bids || []).map(function(l) { return l[0]; })) : 0;
    var pm1BestAsk = (pm1.asks || []).length > 0 ? Math.min.apply(null, (pm1.asks || []).map(function(l) { return l[0]; })) : 0;
    var pm2BestBid = (pm2.bids || []).length > 0 ? Math.max.apply(null, (pm2.bids || []).map(function(l) { return l[0]; })) : 0;
    var pm2BestAsk = (pm2.asks || []).length > 0 ? Math.min.apply(null, (pm2.asks || []).map(function(l) { return l[0]; })) : 0;
    var pm1AgeStr = pm1.age != null ? " | <span style='color:#484f58'>" + pm1.age + "ms ago</span>" : "";
    $("obPmSummary").innerHTML = m.pm1.outcome + ": bid <span class='green'>" + pm1BestBid + "\\u00A2</span> / ask <span class='red'>" + pm1BestAsk + "\\u00A2</span>" + pm1AgeStr +
      "<br>" + m.pm2.outcome + ": bid <span class='green'>" + pm2BestBid + "\\u00A2</span> / ask <span class='red'>" + pm2BestAsk + "\\u00A2</span>";

    $("obLastUpdate").textContent = "Updated: " + new Date().toLocaleTimeString();
    $("obLatency").textContent = connStr + " | poll " + latency + "ms";
    $("obContent").style.display = "grid";
    $("obEmpty").style.display = "none";
  } catch(e) {
    console.error("Orderbook fetch error:", e);
    $("obLastUpdate").textContent = "Error: " + e.message;
  }
}

function startObAutoRefresh() {
  if (obTimer) clearInterval(obTimer);
  if ($("obAutoRefresh").checked && obSelectedMatch) {
    var rate = parseInt($("obRefreshRate").value) || 200;
    obTimer = setInterval(fetchOrderbook, rate);
  }
}

$("obMatchSelect").addEventListener("change", function() {
  var idx = this.value;
  if (idx === "") {
    obSelectedMatch = null;
    $("obContent").style.display = "none";
    $("obEmpty").style.display = "block";
    if (obTimer) clearInterval(obTimer);
    // Unsubscribe all
    fetch("/api/ob-subscribe?tickers=&tokenIds=");
    return;
  }
  obSelectedMatch = obWatchlist[parseInt(idx)];
  obSubscribe(obSelectedMatch);
  fetchOrderbook();
  startObAutoRefresh();
});

$("obAutoRefresh").addEventListener("change", startObAutoRefresh);
$("obRefreshRate").addEventListener("change", startObAutoRefresh);

// Load watchlist when switching to orderbook tab
document.querySelector('[data-tab="orderbook"]').addEventListener("click", function() {
  if (obWatchlist.length === 0) loadWatchlist();
});

// -- Multi-user tab system ------------------------------------
// Tabs: "total" (merged: local + all VPS, deduped) | "local" (local file only) |
//       per-server tabs (each VPS ingesting via /api/ingest).
// Default active: "total".
var currentUser = "total";

function loadRemoteUsers() {
  fetch("/api/remote-users")
    .then(function(r) { return r.json(); })
    .then(function(users) {
      var bar = document.getElementById("userTabBar");
      // Always visible — "Total" + "Me (Local)" are permanent.
      bar.style.display = "block";

      // Rebuild remote server tabs (anything past "total" and "local")
      var existing = bar.querySelectorAll(".user-tab:not([data-user=total]):not([data-user=local])");
      existing.forEach(function(el) { el.remove(); });

      (users || []).forEach(function(u) {
        var btn = document.createElement("button");
        btn.className = "user-tab" + (currentUser === u.name ? " active" : "");
        btn.dataset.user = u.name;
        btn.style.cssText = "background:none;border:none;color:" + (currentUser === u.name ? "#58a6ff" : "#8b949e") + ";padding:8px 18px;font-size:14px;font-family:inherit;cursor:pointer;border-bottom:2px solid " + (currentUser === u.name ? "#58a6ff" : "transparent") + ";margin-bottom:-2px;";
        btn.textContent = u.name + " (" + u.tradeCount + ")";
        btn.title = "IP: " + u.ip + " | Last: " + new Date(u.lastSeen).toLocaleTimeString();
        btn.addEventListener("click", function() { switchUser(u.name); });
        bar.appendChild(btn);
      });

      // Refresh count badges on Total and Local buttons
      Promise.all([
        fetch("/api/trades").then(function(r){ return r.json(); }).catch(function(){ return []; }),
        fetch("/api/local-trades").then(function(r){ return r.json(); }).catch(function(){ return []; }),
      ]).then(function(results) {
        var totalCount = (results[0] || []).length;
        var localCount = (results[1] || []).length;
        var totalSpan = bar.querySelector('[data-count="total"]');
        var localSpan = bar.querySelector('[data-count="local"]');
        if (totalSpan) totalSpan.textContent = totalCount;
        if (localSpan) localSpan.textContent = localCount;
      });

      // Ensure active-state styling is consistent after rebuild
      ["total", "local"].forEach(function(key) {
        var btn = bar.querySelector('[data-user="' + key + '"]');
        if (btn) {
          var active = currentUser === key;
          btn.style.color = active ? "#58a6ff" : "#8b949e";
          btn.style.borderBottom = active ? "2px solid #58a6ff" : "2px solid transparent";
          btn.className = "user-tab" + (active ? " active" : "");
        }
      });
    })
    .catch(function() {});
}

function switchUser(userName) {
  currentUser = userName;
  document.querySelectorAll(".user-tab").forEach(function(b) {
    b.classList.remove("active");
    b.style.color = "#8b949e";
    b.style.borderBottom = "2px solid transparent";
  });
  var activeBtn = document.querySelector('.user-tab[data-user="' + userName + '"]');
  if (activeBtn) {
    activeBtn.classList.add("active");
    activeBtn.style.color = "#58a6ff";
    activeBtn.style.borderBottom = "2px solid #58a6ff";
  }
  fetchAndRender();
}

// Click handlers for the two permanent tabs
document.querySelector('[data-user="total"]').addEventListener("click", function() { switchUser("total"); });
document.querySelector('[data-user="local"]').addEventListener("click", function() { switchUser("local"); });

// Override fetchAndRender to support all three modes
var _originalFetchAndRender = fetchAndRender;
fetchAndRender = function() {
  if (currentUser === "total") {
    // Merged view: the existing /api/trades endpoint already unions local +
    // all remote bots. This is what _originalFetchAndRender hits.
    _originalFetchAndRender();
  } else if (currentUser === "local") {
    // Local-only: skip remote ingest data.
    fetch("/api/local-trades")
      .then(function(r) { return r.json(); })
      .then(function(trades) {
        allTrades = trades;
        renderTrades(trades);
        var totalPnl = trades.reduce(function(s, t) { return s + (t.realizedPnl || 0); }, 0);
        var filled = trades.filter(function(t) { return t.status === "resolved"; }).length;
        document.getElementById("cards").innerHTML =
          '<div style="padding:16px 20px;color:#c9d1d9;">Viewing <strong>Me (Local)</strong> -- ' +
          trades.length + ' trades | ' + filled + ' resolved | PnL: $' + totalPnl.toFixed(2) + '</div>';
      })
      .catch(function() {});
  } else {
    // Single remote server
    fetch("/api/remote-trades?user=" + encodeURIComponent(currentUser))
      .then(function(r) { return r.json(); })
      .then(function(trades) {
        allTrades = trades;
        renderTrades(trades);
        var totalPnl = trades.reduce(function(s, t) { return s + (t.realizedPnl || 0); }, 0);
        var filled = trades.filter(function(t) { return t.status === "resolved"; }).length;
        document.getElementById("cards").innerHTML =
          '<div style="padding:16px 20px;color:#c9d1d9;">Viewing <strong>' + esc(currentUser) + '</strong> -- ' +
          trades.length + ' trades | ' + filled + ' resolved | PnL: $' + totalPnl.toFixed(2) + '</div>';
      })
      .catch(function() {});
  }
  loadRemoteUsers();
};

// Initial load
fetchAndRender();
</script>
</body>
</html>`;

// Load event log on startup (for event-based audit endpoints)
try { loadEventsFromDisk(); } catch (e) { console.warn(`[DASHBOARD] Event log load failed: ${(e as Error).message}`); }

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Accessible on Tailscale network at this machine's Tailscale IP:${PORT}`);
});
