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
import WebSocket from "ws";
import { fetchAllKalshiFills, fetchAllKalshiSettlements, getKalshiPositionMap, type KalFill } from "./kalshiTrade.js";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./polyAuth.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const PORT = parseInt(process.env.DASHBOARD_PORT || "3456", 10);

// Minimum trade date to display. Set DASHBOARD_MIN_DATE in .env to filter old trades.
// Defaults to "" (show all trades — no assumptions about start date).
const TRADE_MIN_DATE = process.env.DASHBOARD_MIN_DATE || "";

// Audit cutoff: only flag discrepancies for trades/fills from today.
// Everything before today is considered reconciled and accepted.
const AUDIT_CUTOFF_DATE = process.env.AUDIT_CUTOFF_DATE || new Date().toISOString().slice(0, 10);

// ── Multi-user data store (for remote bots pushing via /api/ingest) ──────────
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

// ── IP Access Logging ───────────────────────────────────────────────────────
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

function validateTrade(t: ArbTrade): string[] {
  const w: string[] = [];
  // 1. Cost sum mismatch (hedgeCost is additive when EITHER leg cost is 0,
  //    OR when both legs have costs AND totalCost > kalCost + pmCost — partial-fill + PM hedge)
  // kalCost already includes kalFees (baked in at resolve time) — do NOT add kalFees separately
  const baseCost = t.kalCost + t.pmCost;
  const hc = (t.hedgeCost ?? 0) > 0 && (t.pmCost === 0 || t.kalCost === 0 || t.totalCost > baseCost + 0.05)
    ? (t.hedgeCost ?? 0) : 0;
  if (Math.abs(baseCost + hc - t.totalCost) > 0.05) {
    w.push("cost-sum-mismatch: kalCost+hedgeCost+pmCost != totalCost (off by $" +
      Math.abs(baseCost + hc - t.totalCost).toFixed(2) + ")");
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
  if (t.status === "resolved" && !t.id.startsWith("backfill")) {
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
  if (t.shares > 0 && t.pmFillPrice > 0 && t.pmCost > 0) {
    const expected = t.shares * t.pmFillPrice;
    if (Math.abs(expected - t.pmCost) / t.pmCost > 0.10) {
      w.push("pm-price-cost-divergence: " + t.shares + "*" + t.pmFillPrice.toFixed(3) +
        "=$" + expected.toFixed(2) + " vs pmCost=$" + t.pmCost.toFixed(2));
    }
  }
  // 5. Unreasonable P&L
  if (t.realizedPnl != null) {
    if (t.realizedPnl > t.shares) w.push("pnl-out-of-range: pnl > shares");
    if (t.totalCost > 0 && t.realizedPnl < -t.totalCost) w.push("pnl-out-of-range: pnl < -totalCost");
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
      if (t.scalarSettlement && t.kalSettlementValue != null && t.pmSettlementValue != null) {
        const scalarPnl = Math.round((t.shares * (t.kalSettlementValue + t.pmSettlementValue) - t.totalCost) * 100) / 100;
        if (Math.abs((t.realizedPnl ?? 0) - scalarPnl) > 0.05) {
          t.realizedPnl = scalarPnl;
        }
      }
      // Attach depth opportunity data (max potential) — find closest opp within 2 min
      // Skip scalar-settled trades — match was cancelled, depth is irrelevant
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
  // Separate live vs dry-run metrics — stats computed from live only
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
    const isBackfill = t.id.startsWith("backfill");
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
  yes: Map<number, number>; // priceCents → size
  no: Map<number, number>;
  lastUpdate: number;
}

// Active subscriptions
const kalshiBooks = new Map<string, LiveBook>(); // ticker → book
const pmBooks = new Map<string, { bids: Map<number, number>; asks: Map<number, number>; lastUpdate: number }>(); // tokenId → book

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

// ─── Kalshi WebSocket ─────────────────────────────────────────────────────────

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

// ─── Polymarket WebSocket ─────────────────────────────────────────────────────

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
      console.log("[OB-WS] Polymarket disconnected, no active subs — idle");
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
  const allTrades = loadTrades();
  // Only audit trades on or after the cutoff date
  const trades = allTrades.filter(t => t.ts >= AUDIT_CUTOFF_DATE);
  const discrepancies: AuditDiscrepancy[] = [];

  // ── 1. Fetch Kalshi fills (filtered to cutoff date) ──────────────────────
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

  // ── 2. Fetch PM CLOB trades ───────────────────────────────────────────────
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
    console.log(`[AUDIT] Deduped PM fills: ${pmFills.length} → ${dedupedPmFills.length} (removed ${pmFills.length - dedupedPmFills.length} duplicates)`);
  }

  const pmByToken = new Map<string, { totalBought: number; totalCost: number }>();
  for (const ct of dedupedPmFills) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    // When side=BUY and trader_side=MAKER, the TAKER was buying FROM us — we SOLD.
    // Skip these; they are not our purchases.
    if (ct.trader_side === "MAKER") continue;
    if (!pmByToken.has(ct.asset_id)) pmByToken.set(ct.asset_id, { totalBought: 0, totalCost: 0 });
    const g = pmByToken.get(ct.asset_id)!;

    const feeBps = Number(ct.fee_rate_bps ?? 0);
    {
      // We're the taker — size is our actual fill
      const size = Number(ct.size);
      const price = Number(ct.price);
      const baseCost = size * price;
      const fee = baseCost * (feeBps / 10000);
      g.totalBought += size;
      g.totalCost += baseCost + fee;
    }
  }

  // ── 3. Fetch current exchange positions ───────────────────────────────────
  let kalPositions = new Map<string, { yesCount: number; noCount: number; avgPriceCents: number }>();
  try {
    kalPositions = await getKalshiPositionMap();
  } catch { /* non-critical */ }

  // ── 4. Build trade-indexed lookups ────────────────────────────────────────
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

  // ── 5. Compare Kalshi fills vs arb trades ─────────────────────────────────
  for (const [ticker, kal] of kalByTicker) {
    const arbTrades = tradesByKalTicker.get(ticker);
    if (!arbTrades || arbTrades.length === 0) {
      // Fills on a ticker with no arb trade record — only flag if recent (after bot start)
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
    // "known" fill counts — they already include over-hedge shares.
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
    // If reconcile data exists, it was set FROM exchange fills — any mismatch means
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

  // ── 6. Compare PM fills vs arb trades ─────────────────────────────────────
  for (const [tokenId, pm] of pmByToken) {
    const arbTrades = tradesByPmToken.get(tokenId);
    if (!arbTrades || arbTrades.length === 0) {
      // Skip untracked PM fills — PM data-api doesn't provide dates for easy filtering,
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
      // PM CLOB getTrades() returns ALL lifetime fills for this token — it mixes arb trades,
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

  // ── 7. Check for orphaned exchange positions (no matching open arb trade) ─
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

  // Collect tickers with known over-hedges or any resolved trade (already documented — downgrade to warning)
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
      // Skip resolved trade residuals — Kalshi holds shares until match settles/pays out
      if (isKnownTicker || isKnownOverHedge) continue;
      // Only warn about truly unknown positions (manual trades, non-arb, etc.)
      discrepancies.push({
        type: "orphaned-kal-position", severity: "warning", ticker,
        match: tradesByKalTicker.get(ticker)?.[0]?.match,
        detail: `Kalshi position: ${pos.yesCount} YES + ${pos.noCount} NO on ${ticker} — non-arb or manual position`,
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

// ── Multi-user ingest endpoint (bots push here) ────────────────────────────

app.post("/api/ingest", async (req, res) => {
  const { token, trades, metrics, timestamp } = req.body || {};
  const ip = extractIp(req);

  if (!token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  const auth = await validateIngestToken(token);
  if (!auth.valid) {
    console.warn(`[DASHBOARD] Rejected ingest from ${ip} — invalid token`);
    res.status(403).json({ error: "Invalid token" });
    return;
  }

  remoteUsers.set(token, {
    name: auth.name,
    ip,
    trades: trades || [],
    metrics: metrics || [],
    lastSeen: timestamp || new Date().toISOString(),
  });

  console.log(`[DASHBOARD] Ingested data from "${auth.name}" (${ip}): ${(trades || []).length} trades`);
  res.json({ ok: true });
});

// ── Remote users list ───────────────────────────────────────────────────────

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

// ── Remote user trades/stats ────────────────────────────────────────────────

app.get("/api/remote-trades", (req, res) => {
  const userName = req.query.user as string;
  if (!userName) { res.json([]); return; }
  for (const data of remoteUsers.values()) {
    if (data.name === userName) { res.json(data.trades); return; }
  }
  res.json([]);
});

app.get("/api/trades", (_req, res) => {
  res.json(loadTrades());
});

app.get("/api/positions", (_req, res) => {
  res.json(loadHedges());
});

app.get("/api/stats", (req, res) => {
  let trades = loadTrades();
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

// ─── Position Audit endpoint ────────────────────────────────────────────────
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

// ─── Orderbook viewer endpoints ─────────────────────────────────────────────

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

// ── Exchange-Verified P&L ────────────────────────────────────────────────────
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

  // ── 0. Load bot tickers from arb_trades.json to filter exchange data ─────
  const botTrades = loadTrades();
  const botKalTickers = new Set<string>();
  const botPmTokenIds = new Set<string>();
  for (const bt of botTrades) {
    if (bt.kalTicker) botKalTickers.add(bt.kalTicker);
    if (bt.pmTokenId) botPmTokenIds.add(bt.pmTokenId);
  }
  console.log(`[VERIFIED-PNL] Filtering to ${botKalTickers.size} Kalshi tickers, ${botPmTokenIds.size} PM tokens from ${botTrades.length} arb trades`);

  // ── 1. Fetch ALL Kalshi data, then filter to bot tickers ─────────────────
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
  // Auto-detect units: if first settlement's revenue / yesCount > 2 it's likely cents; ≤ 2 it's dollars
  // (A single winning contract pays $1 = 100 cents; revenue per contract should be ≤ $1 = 100 cents)
  let settlementsInCents = true;
  if (kalSettlements.length > 0) {
    const sample = kalSettlements[0];
    const totalContracts = (sample.yesCount || 0) + (sample.noCount || 0);
    if (totalContracts > 0) {
      const revenuePerContract = sample.revenue / totalContracts;
      // If revenue/contract ≤ 1.5, it's likely already in dollars (max $1/contract)
      // If revenue/contract > 1.5, it's likely in cents (max 100 cents/contract)
      settlementsInCents = revenuePerContract > 1.5;
    }
  }
  const settDivisor = settlementsInCents ? 100 : 1;
  if (kalSettlements.length > 0) {
    const s0 = kalSettlements[0];
    console.log(`[VERIFIED-PNL] Settlement sample[0]: ticker=${s0.ticker} revenue=${s0.revenue} yesCost=${s0.yesCost} noCost=${s0.noCost} feeCost=${s0.feeCost} yesCount=${s0.yesCount} noCount=${s0.noCount} → unit=${settlementsInCents ? "CENTS" : "DOLLARS"} divisor=${settDivisor}`);
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

  // ── 2. Fetch ALL Polymarket data ─────────────────────────────────────────
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
      console.log(`[VERIFIED-PNL] PM fill sample: size="${ct.size}" → ${size}, price="${ct.price}" → ${price}, baseCost=${baseCost.toFixed(4)}, side=${ct.side}, trader_side=${ct.trader_side}`);
      pmDebugCount++;
    }

    // Determine if we bought or sold
    // side=BUY + trader_side=TAKER → we bought
    // side=BUY + trader_side=MAKER → someone bought FROM us (we sold)
    // side=SELL + trader_side=TAKER → we sold
    // side=SELL + trader_side=MAKER → someone sold TO us (we bought)
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

  // ── 3. Combine ──────────────────────────────────────────────────────────

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

// ── Per-ticker P&L map: fills (buys+sells) + settlements + open positions ────
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
      const price = (f.side === "yes" ? f.yesPrice : f.noPrice) / 100; // cents→dollars
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

// Get live orderbook state (instant — reads from in-memory maps, no network call)
app.get("/api/orderbook", async (_req, res) => {
  const result: Record<string, unknown> = {
    ts: new Date().toISOString(),
    kalshiConnected: kalshiWsReady,
    pmConnected: pmWsReady,
  };

  // Kalshi books — WS first, REST fallback when WS is disconnected
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
<div id="userTabBar" style="display:none;margin:0 20px 8px;padding:0;border-bottom:2px solid #21262d;">
  <button class="user-tab active" data-user="local" style="background:none;border:none;color:#58a6ff;padding:8px 18px;font-size:14px;font-family:inherit;cursor:pointer;border-bottom:2px solid #58a6ff;margin-bottom:-2px;">Me (Local)</button>
</div>

<div class="cards" id="cards"></div>
<div id="chainStatus" style="margin:0 20px 10px;padding:8px 14px;background:#1a1a2e;border-radius:8px;font-size:12px;color:#888;display:none"></div>

<div class="tab-bar">
  <button class="tab-btn active" data-tab="trades">Trades</button>
  <button class="tab-btn" data-tab="execution">Execution</button>
  <button class="tab-btn" data-tab="missed">Missed Opps <span class="tab-badge" id="missedBadge" style="display:none">0</span></button>
  <button class="tab-btn" data-tab="orderbook">Orderbooks</button>
  <button class="tab-btn" data-tab="audit">Audit <span class="tab-badge" id="auditBadge" style="display:none">0</span></button>
  <button class="tab-btn" data-tab="verified">Verified P&L</button>
</div>

<!-- TAB: Trades -->
<div class="tab-panel active" id="panel-trades">
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
      </tr>
    </thead>
    <tbody id="tradesBody"></tbody>
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
      <br><span style="font-size:11px">This ignores arb_trades.json — shows actual money in/out.</span>
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

function actualPnlCell(t) {
  var s = settlementMap[t.kalTicker];
  if (!s) {
    if (t.status === "resolved") return '<span class="gray" title="No exchange data for ' + esc(t.kalTicker) + '">?</span>';
    return '<span class="gray">--</span>';
  }

  // When multiple trades share the same Kalshi ticker, exchange data (sm.net) covers
  // ALL trades combined — using it per-trade would double/triple-count KAL costs.
  // Fall back to per-trade realizedPnl in that case.
  var isSharedTicker = _tickerTradeCount[t.kalTicker] > 1;

  var pmCost = t.pmCost || 0;
  var actualNet, statusLabel, cls, badge = '';
  // hedgeCost is extra PM/KAL spending not captured in pmCost/kalCost (e.g. buying PM opposite side)
  // Only add when one leg is 0, matching totalCostForTrade logic
  var hcAdj = ((t.pmCost === 0 || t.kalCost === 0) && (t.hedgeCost || 0) > 0) ? (t.hedgeCost || 0) : 0;

  if (s.status === "settled") {
    var isScalar = s.settlementResult === "scalar";
    var kalWon;
    if (!isScalar && s.pairRedemption > 0 && s.settlementResult) {
      // Pair-redeemed: both YES+NO bought, settlementRevenue=0. Determine winner from
      // settlementResult vs original KAL side (the more expensive buy = the arb opportunity)
      var originalSide = (s.buyNoCost || 0) >= (s.buyYesCost || 0) ? "no" : "yes";
      kalWon = s.settlementResult === originalSide;
    } else {
      kalWon = !isScalar && s.settlementRevenue > 0.50;
    }
    var hasPmLeg = (t.pmCost > 0 || t.pmFillPrice > 0);
    var pmPayout = (!kalWon && !isScalar && hasPmLeg) ? t.shares : 0;
    if (isScalar && hasPmLeg) {
      // Voided/scalar settlement: KAL refunds (sm.net = fees lost), PM settles at 50c/share
      var pmVoidPayout = t.shares * 0.50;
      actualNet = Math.round((s.net + pmVoidPayout - pmCost - hcAdj) * 100) / 100;
      statusLabel = "settled (voided)";
      cls = actualNet >= 0 ? "green" : "red";
      badge = ' <span style="color:#d29922;font-size:9px">VOID</span>';
    } else if (isSharedTicker && t.realizedPnl != null) {
      // Shared ticker — use per-trade P&L to avoid double-counting KAL net
      actualNet = t.realizedPnl;
      statusLabel = kalWon ? "settled (KAL won)" : "settled (PM won)";
      cls = actualNet >= 0 ? "green" : "red";
      badge = ' <span style="color:#8b949e;font-size:9px" title="KAL exchange data shared across ' + _tickerTradeCount[t.kalTicker] + ' trades — using per-trade P&L">(' + _tickerTradeCount[t.kalTicker] + 'x)</span>';
    } else {
      actualNet = Math.round((s.net + pmPayout - pmCost - hcAdj) * 100) / 100;
      statusLabel = kalWon ? "settled (KAL won)" : "settled (PM won)";
      cls = actualNet >= 0 ? "green" : "red";
    }
  } else if (s.status === "sold") {
    if (isSharedTicker && t.realizedPnl != null) {
      actualNet = t.realizedPnl;
      statusLabel = "sold (shared ticker)";
      cls = actualNet >= 0 ? "green" : "red";
      badge = ' <span style="color:#d29922;font-size:9px">SOLD</span>';
    } else {
      actualNet = Math.round((s.net) * 100) / 100;
      statusLabel = "sold (PM pending)";
      cls = actualNet >= 0 ? "green" : "red";
      badge = ' <span style="color:#d29922;font-size:9px">SOLD</span>';
    }
  } else {
    if (t.status === "resolved" && t.realizedPnl != null) {
      actualNet = t.realizedPnl;
      statusLabel = "pending";
      cls = actualNet >= 0 ? "green" : "red";
      badge = ' <span style="color:#8b949e;font-size:9px">PENDING</span>';
    } else {
      return '<span class="gray" title="Position still open">open</span>';
    }
  }

  var parts = [];
  if (s.buyCost > 0) parts.push("bought: $" + s.buyCost.toFixed(2) + " (" + s.buyCount + ")");
  if (s.sellRevenue > 0) parts.push("sold: $" + s.sellRevenue.toFixed(2) + " (" + s.sellCount + ")");
  if (s.settlementRevenue > 0) parts.push("settlement: $" + s.settlementRevenue.toFixed(2));
  if (s.pairRedemption > 0) parts.push("pair redemption: $" + s.pairRedemption.toFixed(2));
  if (pmCost > 0) parts.push("PM cost: $" + pmCost.toFixed(2));
  parts.push("fees: $" + s.fees.toFixed(2));
  parts.push("status: " + statusLabel);
  if (isSharedTicker) parts.push("(shared ticker: " + _tickerTradeCount[t.kalTicker] + " trades)");
  var title = parts.join(" | ");
  return '<span class="' + cls + '" title="' + esc(title) + '">' + pnlStr(actualNet) + '</span>' + badge;
}

// Tab switching
document.querySelectorAll(".tab-btn").forEach(function(btn) {
  btn.addEventListener("click", function() {
    document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); });
    document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.remove("active"); });
    btn.classList.add("active");
    var panel = document.getElementById("panel-" + btn.dataset.tab);
    if (panel) panel.classList.add("active");
  });
});

function $(id) { return document.getElementById(id); }

// HTML-escape to prevent XSS from trade data injected into innerHTML
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function pnlClass(val) { return val > 0.001 ? "green" : val < -0.001 ? "red" : "gray"; }
function kalFee(t) {
  return t.kalFees != null ? t.kalFees : Math.max(0, t.kalCost - t.shares * t.kalFillPrice);
}
function pmFee(t) {
  return Math.max(0, t.pmCost - t.shares * t.pmFillPrice);
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

    return '<tr>' +
      '<td>' + esc(p.kalLeg ? p.kalLeg.surname : "?") + '</td>' +
      '<td><span class="dir dir-' + (p.kalSide === "no" ? "C" : "A") + '">' + (p.kalSide === "no" ? "NO" : "YES") + '</span></td>' +
      '<td>' + esc(p.heldExchange).toUpperCase() + '</td>' +
      '<td>' + esc(p.kalSide) + '</td>' +
      '<td>' + remaining + ' / ' + total + '</td>' +
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
    if (t.realizedPnl != null) days[day].pnl += t.realizedPnl;
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

  // Build ticker frequency map — needed to avoid double-counting exchange data
  // when multiple trades share the same Kalshi ticker
  _tickerTradeCount = {};
  for (var tc = 0; tc < trades.length; tc++) {
    var tk = trades[tc].kalTicker;
    _tickerTradeCount[tk] = (_tickerTradeCount[tk] || 0) + 1;
  }

  // Compute totals for P&L and Actual P&L
  var totalPnl = 0;
  var totalActualPnl = 0;
  var actualPnlCount = 0;
  var kalNetCounted = {}; // track tickers whose KAL net has been counted once
  for (var ti = 0; ti < trades.length; ti++) {
    var tr = trades[ti];
    if (tr.realizedPnl != null) totalPnl += tr.realizedPnl;
    var sm = settlementMap[tr.kalTicker];
    if (sm) {
      if (sm.status === "settled") {
        var trHcAdj = ((tr.pmCost === 0 || tr.kalCost === 0) && (tr.hedgeCost || 0) > 0) ? (tr.hedgeCost || 0) : 0;
        if (sm.settlementResult === "scalar" && (tr.pmCost > 0 || tr.pmFillPrice > 0)) {
          // Voided/scalar: KAL refunds (sm.net), PM settles at 50c/share
          totalActualPnl += sm.net + tr.shares * 0.50 - (tr.pmCost || 0) - trHcAdj;
          actualPnlCount++;
        } else if (_tickerTradeCount[tr.kalTicker] > 1) {
          // Multiple trades share this ticker — use per-trade P&L
          if (tr.realizedPnl != null) { totalActualPnl += tr.realizedPnl; actualPnlCount++; }
        } else {
          var kalW;
          if (sm.settlementResult !== "scalar" && sm.pairRedemption > 0 && sm.settlementResult) {
            var totOs = (sm.buyNoCost || 0) >= (sm.buyYesCost || 0) ? "no" : "yes";
            kalW = sm.settlementResult === totOs;
          } else {
            kalW = sm.settlementResult !== "scalar" && sm.settlementRevenue > 0.50;
          }
          var hasPmL = (tr.pmCost > 0 || tr.pmFillPrice > 0);
          var pmPay = (!kalW && hasPmL) ? tr.shares : 0;
          totalActualPnl += sm.net + pmPay - (tr.pmCost || 0) - trHcAdj;
          actualPnlCount++;
        }
      } else if (sm.status === "sold") {
        if (_tickerTradeCount[tr.kalTicker] > 1) {
          if (tr.realizedPnl != null) { totalActualPnl += tr.realizedPnl; actualPnlCount++; }
        } else {
          totalActualPnl += sm.net;
          actualPnlCount++;
        }
      } else if (tr.status === "resolved" && tr.realizedPnl != null) {
        // Pending settlement — use bot's P&L
        totalActualPnl += tr.realizedPnl;
        actualPnlCount++;
      }
    }
  }
  totalPnl = Math.round(totalPnl * 100) / 100;
  totalActualPnl = Math.round(totalActualPnl * 100) / 100;
  var pnlC = totalPnl >= 0 ? "#3fb950" : "#f85149";
  var actC = totalActualPnl >= 0 ? "#3fb950" : "#f85149";
  $("tradeTotals").innerHTML =
    '<span style="color:#8b949e">P&L Total: <b style="color:' + pnlC + '">' + pnlStr(totalPnl) + '</b></span>' +
    '<span style="color:#8b949e">Actual P&L Total: <b style="color:' + actC + '">' + pnlStr(totalActualPnl) + '</b>' +
    (actualPnlCount < trades.length ? ' <span style="color:#484f58;font-size:11px">(' + actualPnlCount + '/' + trades.length + ' settled)</span>' : '') +
    '</span>';

  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="14" class="empty">No trades</td></tr>';
    return;
  }

  tbody.innerHTML = sorted.map(function(t, i) {
    const isBackfill = t.id.indexOf("backfill") === 0;
    const dirLabel = t.dir || "?";
    const kalSide = (dirLabel === "C" || dirLabel === "D" || dirLabel === "G" || dirLabel === "H" || dirLabel === "I") ? "NO" : "YES";
    const kalNoFill = t.kalCost === 0 && t.kalFillPrice === 0 && t.status !== "filled";

    var kalStr = kalNoFill
      ? esc(shortTicker(t.kalTicker)) + ' <span style="color:#f85149;font-size:10px">NO FILL</span>'
      : esc(shortTicker(t.kalTicker)) + " " + kalSide + " @" + (t.kalFillPrice > 0 ? t.kalFillPrice.toFixed(2) : "--");
    const initPmPriceTemp = t.pmFillPrice;
    var pmStr = t.pmOutcome ? esc(t.pmOutcome) + " @" + (initPmPriceTemp > 0 ? initPmPriceTemp.toFixed(2) : "--") : (isBackfill ? "KAL-only" : "--");
    const scalarBadge = t.scalarSettlement ? '<span class="badge badge-scalar">SCALAR</span>' : '';
    var statusBadge = (t.status === "resolved"
      ? (t.realizedPnl != null && t.realizedPnl < 0 ? '<span class="badge badge-loss">LOSS</span>' : '<span class="badge badge-resolved">OK</span>')
      : t.status === "hedging" ? '<span class="badge badge-hedging">HDG</span>'
      : '<span class="badge badge-filled">FILL</span>') + scalarBadge;
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
      ? (function() { var ms = new Date(t.resolvedTs).getTime() - new Date(t.ts).getTime(); var s = Math.floor(ms/1000); if (s < 60) return s + 's'; var m = Math.floor(s/60); if (m < 60) return m + 'm'; var h = Math.floor(m/60); return h + 'h' + (m%60) + 'm'; })()
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
      '</tr>';

    const detailRow = '<tr class="detail-row' + (isOpen ? " open" : "") + '" id="' + rowId + '"><td colspan="14">' +
      '<div class="detail-grid">' +
      '<div><span>Trade ID:</span> ' + esc(t.id) + '</div>' +
      '<div><span>Resolved:</span> ' + fmtDate(t.resolvedTs) + '</div>' +
      '<div><span>KAL Ticker:</span> ' + esc(t.kalTicker) + '</div>' +
      '<div><span>PM Slug:</span> ' + esc(t.pmSlug || "n/a") + '</div>' +
      '<div><span>KAL Cost:</span> ' + (kalNoFill
        ? '<span style="color:#f85149">No fill — KAL leg failed, hedged via PM</span>'
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
        var isScalar = sm.settlementResult === "scalar";
        var kalWon;
        if (!isScalar && sm.pairRedemption > 0 && sm.settlementResult) {
          var detailOrigSide = (sm.buyNoCost || 0) >= (sm.buyYesCost || 0) ? "no" : "yes";
          kalWon = sm.settlementResult === detailOrigSide;
        } else {
          kalWon = !isScalar && sm.settlementRevenue > 0.50;
        }
        var hasPmLeg = (t.pmCost > 0 || t.pmFillPrice > 0);
        var pmPayout = isScalar && hasPmLeg ? t.shares * 0.50
          : (sm.status === "settled" && !kalWon && hasPmLeg) ? t.shares : 0;
        var isShared = _tickerTradeCount[t.kalTicker] > 1;
        var detailHcAdj = ((t.pmCost === 0 || t.kalCost === 0) && (t.hedgeCost || 0) > 0) ? (t.hedgeCost || 0) : 0;
        var actualNet = isShared && t.realizedPnl != null
          ? t.realizedPnl
          : Math.round((sm.net + pmPayout - pmCost - detailHcAdj) * 100) / 100;
        var winnerStr = sm.status === "settled" ? (isScalar ? "VOIDED" : (kalWon ? "KAL won" : "PM won")) : sm.status;
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
    const [tradesRes, positionsRes, chainRes, execRes, reconcileRes, missedRes, settlRes] = await Promise.all([
      fetch("/api/trades"), fetch("/api/positions"), fetch("/api/chain-status"), fetch("/api/exec-stats"), fetch("/api/reconcile-log"), fetch("/api/missed-opps"), fetch("/api/settlement-map")
    ]);
    allTrades = await tradesRes.json();
    try { settlementMap = await settlRes.json(); } catch(e) { console.warn("Settlement map parse error:", e); }
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
setInterval(function() {
  countdown--;
  if (countdown <= 0) { countdown = 1; fetchAndRender(); }
  $("countdown").textContent = countdown;
}, 1000);

// ─── Position Audit ──────────────────────────────────────────────────────────

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

// ─── Verified P&L ────────────────────────────────────────────────────────────

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

// ─── Orderbook viewer ────────────────────────────────────────────────────────

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

    // Kalshi data — keyed by ticker
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

    // PM data — keyed by tokenId. Prices already in cents from server.
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

// ── Multi-user tab system ────────────────────────────────────
var currentUser = "local";

function loadRemoteUsers() {
  fetch("/api/remote-users")
    .then(function(r) { return r.json(); })
    .then(function(users) {
      var bar = document.getElementById("userTabBar");
      if (!users || users.length === 0) { bar.style.display = "none"; return; }
      bar.style.display = "block";

      // Keep the "Me (Local)" button, rebuild remote tabs
      var existing = bar.querySelectorAll(".user-tab:not([data-user=local])");
      existing.forEach(function(el) { el.remove(); });

      users.forEach(function(u) {
        var btn = document.createElement("button");
        btn.className = "user-tab" + (currentUser === u.name ? " active" : "");
        btn.dataset.user = u.name;
        btn.style.cssText = "background:none;border:none;color:" + (currentUser === u.name ? "#58a6ff" : "#8b949e") + ";padding:8px 18px;font-size:14px;font-family:inherit;cursor:pointer;border-bottom:2px solid " + (currentUser === u.name ? "#58a6ff" : "transparent") + ";margin-bottom:-2px;";
        btn.textContent = u.name + " (" + u.tradeCount + ")";
        btn.title = "IP: " + u.ip + " | Last: " + new Date(u.lastSeen).toLocaleTimeString();
        btn.addEventListener("click", function() { switchUser(u.name); });
        bar.appendChild(btn);
      });

      // Update local button styling
      var localBtn = bar.querySelector("[data-user=local]");
      if (localBtn) {
        localBtn.style.color = currentUser === "local" ? "#58a6ff" : "#8b949e";
        localBtn.style.borderBottom = currentUser === "local" ? "2px solid #58a6ff" : "2px solid transparent";
        localBtn.className = "user-tab" + (currentUser === "local" ? " active" : "");
      }
    })
    .catch(function() {});
}

function switchUser(userName) {
  currentUser = userName;
  // Refresh user tab bar styling
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

// Add click handler to local tab
document.querySelector("[data-user=local]").addEventListener("click", function() {
  switchUser("local");
});

// Override fetchAndRender to support remote user data
var _originalFetchAndRender = fetchAndRender;
fetchAndRender = function() {
  if (currentUser === "local") {
    _originalFetchAndRender();
  } else {
    // Fetch remote user trades
    fetch("/api/remote-trades?user=" + encodeURIComponent(currentUser))
      .then(function(r) { return r.json(); })
      .then(function(trades) {
        allTrades = trades;
        renderTrades(trades);
        // Show basic stats
        var totalPnl = trades.reduce(function(s, t) { return s + (t.realizedPnl || 0); }, 0);
        var filled = trades.filter(function(t) { return t.status === "resolved"; }).length;
        document.getElementById("cards").innerHTML =
          '<div style="padding:16px 20px;color:#c9d1d9;">Viewing <strong>' + esc(currentUser) + '</strong> — ' +
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Accessible on Tailscale network at this machine's Tailscale IP:${PORT}`);
});
