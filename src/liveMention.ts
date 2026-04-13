/**
 * liveMention.ts -- Live Powell speech keyword trading bot.
 *
 * Two modes of operation:
 *   1. AUTO: Deepgram real-time transcription from microphone -> keyword detection -> trade
 *   2. MANUAL: Web dashboard with keyword buttons -> click to trigger trade
 *
 * Usage:
 *   npx tsx src/liveMention.ts              # dry-run (default)
 *   LIVE=1 npx tsx src/liveMention.ts       # real orders
 *   DEEPGRAM_API_KEY=xxx npx tsx src/liveMention.ts  # enable auto transcription
 *
 * Dashboard: http://localhost:3456
 */

import * as dotenv from "dotenv";
dotenv.config();

// @ts-ignore -- express default export works at runtime with tsx
import express from "express";
import { fetchJsonWithRetry, fetchJson } from "./http.js";
import { placeKalshiOrder, buildKalshiOrder } from "./kalshiTrade.js";
import { placePolymarketOrder } from "./polymarketTrade.js";
import { OrderType } from "@polymarket/clob-client";

// --- Config ------------------------------------------------------------------

const DRY_RUN = process.env.LIVE !== "1";
const PORT = Number(process.env.MENTION_PORT ?? 3457);
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY ?? "";
const KAL_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA_BASE = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";

// How much USD to spend per keyword trigger (split between KAL and PM)
const TRADE_SIZE_USD = Number(process.env.MENTION_TRADE_SIZE ?? 20);
// Max YES price we're willing to pay (don't buy if already >X)
const MAX_YES_PRICE = Number(process.env.MENTION_MAX_PRICE ?? 0.95);

const retryOpts = { timeoutMs: 8000, maxRetries: 2, baseDelayMs: 300, maxDelayMs: 4000, jitterMs: 100 };

// --- Types -------------------------------------------------------------------

interface KeywordMarket {
  keyword: string;           // display keyword (e.g. "Pandemic")
  triggers: string[];        // words that trigger this (e.g. ["pandemic"])
  kalTicker: string;         // KXFEDMENTION-26MAR-PAND
  kalYesAsk: number;         // current price (cents)
  pmSlug: string;            // PM market slug
  pmTokenId: string;         // PM YES token ID
  pmAsk: number | null;      // current PM YES price
  requiredClicks: number;    // how many clicks needed before trade fires (1 = instant, 3 = need 3 clicks)
  clicks: number;            // current click count
  triggered: boolean;        // already triggered this session?
  triggerTime?: string;      // ISO timestamp of trigger
  kalResult?: unknown;       // order result
  pmResult?: unknown;        // order result
  error?: string;            // error if trade failed
}

// --- Keyword -> Market mapping ------------------------------------------------
// All keywords from both Kalshi and PM, sorted alphabetically.
// requiredClicks: 1 = single mention, N = must click N times before trade fires (for "N+ times" markets)

type KwEntry = { keyword: string; triggers: string[]; kalTicker: string; pmSlug: string; requiredClicks?: number };

const KEYWORD_MAP: KwEntry[] = [
  // A
  { keyword: "ADP", triggers: ["adp"], kalTicker: "KXFEDMENTION-26MAR-ADP", pmSlug: "" },
  { keyword: "Affordability", triggers: ["affordability"], kalTicker: "", pmSlug: "will-powell-say-affordability-during-march-press-conference-984" },
  { keyword: "AI 3+", triggers: ["artificial intelligence", " ai "], kalTicker: "KXFEDMENTION-26MAR-AI", pmSlug: "will-powell-say-ai-or-artificial-intelligence-3-times-during-march-press-conference-852-727", requiredClicks: 3 },
  { keyword: "Anchor", triggers: ["anchor", "anchored"], kalTicker: "KXFEDMENTION-26MAR-ANCH", pmSlug: "" },
  // B
  { keyword: "Balance of Risk", triggers: ["balance of risk"], kalTicker: "KXFEDMENTION-26MAR-BALAR", pmSlug: "" },
  { keyword: "Balance Sheet", triggers: ["balance sheet"], kalTicker: "KXFEDMENTION-26MAR-BALA", pmSlug: "will-powell-say-balance-sheet-during-march-press-conference" },
  { keyword: "Beige Book", triggers: ["beige book"], kalTicker: "KXFEDMENTION-26MAR-BEIG", pmSlug: "" },
  { keyword: "Bitcoin", triggers: ["bitcoin"], kalTicker: "KXFEDMENTION-26MAR-BITC", pmSlug: "will-powell-say-crypto-or-bitcoin-during-march-press-conference-431-787" },
  // C
  { keyword: "China", triggers: ["china"], kalTicker: "", pmSlug: "will-powell-say-china-during-march-press-conference" },
  { keyword: "Citrini", triggers: ["citrini"], kalTicker: "KXFEDMENTION-26MAR-CITR", pmSlug: "" },
  { keyword: "Collect", triggers: ["collect", "collected"], kalTicker: "", pmSlug: "will-powell-say-collect-or-collected-during-march-press-conference-347" },
  { keyword: "Comment", triggers: ["comment"], kalTicker: "", pmSlug: "will-powell-say-comment-during-march-press-conference-427-989" },
  { keyword: "Consumer Confidence", triggers: ["consumer confidence"], kalTicker: "KXFEDMENTION-26MAR-CONS", pmSlug: "" },
  { keyword: "Credit", triggers: ["credit"], kalTicker: "KXFEDMENTION-26MAR-CRED", pmSlug: "" },
  // D
  { keyword: "Delay", triggers: ["delay", "delayed"], kalTicker: "", pmSlug: "will-powell-say-delayed-or-delay-during-march-press-conference-918" },
  { keyword: "Dissent", triggers: ["dissent"], kalTicker: "KXFEDMENTION-26MAR-DISS", pmSlug: "" },
  { keyword: "Distortion", triggers: ["distortion"], kalTicker: "", pmSlug: "will-powell-say-distortion-during-march-press-conference" },
  { keyword: "Dollar 2+", triggers: ["dollar"], kalTicker: "", pmSlug: "will-powell-say-dollar-2-times-during-march-press-conference", requiredClicks: 2 },
  { keyword: "Dot Plot", triggers: ["dot plot"], kalTicker: "KXFEDMENTION-26MAR-DOT", pmSlug: "" },
  // E
  { keyword: "Egg", triggers: ["egg"], kalTicker: "KXFEDMENTION-26MAR-EGG", pmSlug: "" },
  { keyword: "Expectation", triggers: ["expectation"], kalTicker: "KXFEDMENTION-26MAR-EXPE", pmSlug: "" },
  // F
  { keyword: "Food/Energy 3+", triggers: ["food", "energy"], kalTicker: "", pmSlug: "will-powell-say-food-or-energy-3-times-during-march-press-conference", requiredClicks: 3 },
  // G
  { keyword: "Gas/Gasoline", triggers: ["gas", "gasoline", "natural gas"], kalTicker: "KXFEDMENTION-26MAR-GAS", pmSlug: "" },
  { keyword: "Gold", triggers: ["gold"], kalTicker: "KXFEDMENTION-26MAR-GOLD", pmSlug: "will-powell-say-gold-or-oil-during-march-press-conference-257-974" },
  { keyword: "Good Afternoon", triggers: ["good afternoon"], kalTicker: "KXFEDMENTION-26MAR-GOOD", pmSlug: "will-powell-say-good-afternoon-during-march-press-conference" },
  { keyword: "Goods Inflation", triggers: ["goods inflation"], kalTicker: "KXFEDMENTION-26MAR-GOODS", pmSlug: "" },
  // H
  { keyword: "Housing", triggers: ["housing"], kalTicker: "", pmSlug: "will-powell-say-housing-during-march-press-conference" },
  // I
  { keyword: "Iran", triggers: ["iran"], kalTicker: "", pmSlug: "will-powell-say-iran-during-march-press-conference" },
  // J-K
  { keyword: "Judy Shelton", triggers: ["judy shelton"], kalTicker: "KXFEDMENTION-26MAR-JUDY", pmSlug: "" },
  { keyword: "Kalshi", triggers: ["kalshi"], kalTicker: "KXFEDMENTION-26MAR-KALS", pmSlug: "" },
  // L
  { keyword: "Lawsuit", triggers: ["lawsuit"], kalTicker: "KXFEDMENTION-26MAR-LAWS", pmSlug: "" },
  { keyword: "Layoff", triggers: ["layoff", "layoffs"], kalTicker: "KXFEDMENTION-26MAR-LAYO", pmSlug: "" },
  // M
  { keyword: "Median", triggers: ["median"], kalTicker: "KXFEDMENTION-26MAR-MEDI", pmSlug: "" },
  // N
  { keyword: "National Debt", triggers: ["national debt"], kalTicker: "KXFEDMENTION-26MAR-NATI", pmSlug: "" },
  { keyword: "Not Our Job", triggers: ["not our job"], kalTicker: "", pmSlug: "will-powell-say-not-our-job-during-march-press-conference" },
  { keyword: "Nothing 3+", triggers: ["nothing"], kalTicker: "", pmSlug: "will-powell-say-nothing-3-times-during-march-press-conference-756-765", requiredClicks: 3 },
  // P
  { keyword: "Pandemic", triggers: ["pandemic"], kalTicker: "KXFEDMENTION-26MAR-PAND", pmSlug: "will-powell-say-pandemic-during-march-press-conference-478-338" },
  { keyword: "Pardon", triggers: ["pardon"], kalTicker: "KXFEDMENTION-26MAR-PARD", pmSlug: "will-powell-say-sorry-or-pardon-during-march-press-conference-745-799" },
  { keyword: "Politics", triggers: ["politics", "political"], kalTicker: "", pmSlug: "will-powell-say-politics-during-march-press-conference" },
  { keyword: "President", triggers: ["president"], kalTicker: "KXFEDMENTION-26MAR-PRES", pmSlug: "" },
  { keyword: "Probability", triggers: ["probability"], kalTicker: "KXFEDMENTION-26MAR-PROB", pmSlug: "" },
  { keyword: "Projection", triggers: ["projection"], kalTicker: "KXFEDMENTION-26MAR-PROJ", pmSlug: "" },
  // Q
  { keyword: "QE", triggers: ["quantitative easing", "qe"], kalTicker: "KXFEDMENTION-26MAR-QE", pmSlug: "" },
  { keyword: "QT", triggers: ["quantitative tightening", "qt"], kalTicker: "KXFEDMENTION-26MAR-QT", pmSlug: "" },
  // R
  { keyword: "Recession", triggers: ["recession"], kalTicker: "KXFEDMENTION-26MAR-RECE", pmSlug: "will-powell-say-recession-during-march-press-conference" },
  { keyword: "Refund", triggers: ["refund"], kalTicker: "", pmSlug: "will-powell-say-refund-during-march-press-conference" },
  { keyword: "Renovation", triggers: ["renovation"], kalTicker: "KXFEDMENTION-26MAR-RENO", pmSlug: "" },
  { keyword: "Restrictive", triggers: ["restrictive"], kalTicker: "KXFEDMENTION-26MAR-REST", pmSlug: "" },
  // S
  { keyword: "Shutdown", triggers: ["shutdown", "shut down"], kalTicker: "KXFEDMENTION-26MAR-SHUT", pmSlug: "will-powell-say-shutdown-or-shut-down-during-march-press-conference-837" },
  { keyword: "Signal", triggers: ["signal"], kalTicker: "", pmSlug: "will-powell-say-signal-during-march-press-conference" },
  { keyword: "Simulation", triggers: ["simulation"], kalTicker: "", pmSlug: "will-powell-say-simulation-during-march-press-conference" },
  { keyword: "Soft Landing", triggers: ["soft landing"], kalTicker: "KXFEDMENTION-26MAR-SOFT", pmSlug: "" },
  { keyword: "Softening", triggers: ["softening"], kalTicker: "KXFEDMENTION-26MAR-SOFTE", pmSlug: "" },
  { keyword: "Speculate", triggers: ["speculate", "speculation"], kalTicker: "", pmSlug: "will-powell-say-speculate-or-speculation-during-march-press-conference" },
  { keyword: "Stagflation", triggers: ["stagflation"], kalTicker: "KXFEDMENTION-26MAR-STAG", pmSlug: "" },
  { keyword: "Successor", triggers: ["successor"], kalTicker: "", pmSlug: "will-powell-say-successor-during-march-press-conference-223" },
  { keyword: "Supreme Court", triggers: ["supreme court"], kalTicker: "", pmSlug: "will-powell-say-supreme-court-during-march-press-conference-816-383" },
  // T
  { keyword: "Tariff Inflation", triggers: ["tariff inflation"], kalTicker: "KXFEDMENTION-26MAR-TARI", pmSlug: "" },
  { keyword: "Tax", triggers: ["tax"], kalTicker: "KXFEDMENTION-26MAR-TAX", pmSlug: "" },
  { keyword: "Trade War", triggers: ["trade war"], kalTicker: "KXFEDMENTION-26MAR-TRAD", pmSlug: "will-powell-say-war-during-march-press-conference" },
  { keyword: "Trump", triggers: ["trump"], kalTicker: "KXFEDMENTION-26MAR-TRUM", pmSlug: "" },
  // U
  { keyword: "Unchanged", triggers: ["unchanged"], kalTicker: "KXFEDMENTION-26MAR-UNCH", pmSlug: "" },
  { keyword: "Uncertainty", triggers: ["uncertainty"], kalTicker: "KXFEDMENTION-26MAR-UNCE", pmSlug: "" },
  // V
  { keyword: "Volatile", triggers: ["volatile", "volatility"], kalTicker: "KXFEDMENTION-26MAR-VOLA", pmSlug: "will-powell-say-volatile-during-march-press-conference" },
  // W-Y
  { keyword: "War", triggers: ["war"], kalTicker: "", pmSlug: "will-powell-say-war-during-march-press-conference" },
  { keyword: "Yield Curve", triggers: ["yield curve"], kalTicker: "KXFEDMENTION-26MAR-YIEL", pmSlug: "" },
];

// PM token IDs populated at startup
const pmTokenMap = new Map<string, string>();

// --- State -------------------------------------------------------------------

let markets: KeywordMarket[] = [];
let transcript = "";
let transcriptLines: string[] = [];
let isListening = false;
let deepgramWs: import("ws").WebSocket | null = null;

// --- Fetch live prices -------------------------------------------------------

async function fetchKalshiPrices(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  try {
    const data = await fetchJsonWithRetry<{ markets: { ticker: string; yes_ask: number }[] }>(
      `${KAL_BASE}/markets?event_ticker=KXFEDMENTION-26MAR&limit=200`, {}, retryOpts
    );
    for (const m of data.markets ?? []) {
      prices.set(m.ticker, m.yes_ask); // cents
    }
  } catch (e) {
    console.error("Failed to fetch Kalshi prices:", e);
  }
  return prices;
}

async function fetchPmTokenAndPrice(slug: string): Promise<{ tokenId: string; ask: number | null }> {
  try {
    const raw = await fetchJsonWithRetry<{ market?: Record<string, unknown> } & Record<string, unknown>>(
      `${GAMMA_BASE}/markets/slug/${slug}`, {}, retryOpts
    );
    const m = (raw.market ?? raw) as Record<string, unknown>;
    const tids: string[] = (() => {
      const v = m.clobTokenIds;
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
      return [];
    })();
    const tokenId = tids[0] ?? "";
    if (!tokenId) return { tokenId: "", ask: null };

    // Fetch best ask
    const book = await fetchJsonWithRetry<{ asks?: { price: string; size: string }[] }>(
      `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`, {}, retryOpts
    );
    let bestAsk: number | null = null;
    if (book.asks && book.asks.length > 0) {
      bestAsk = Math.min(...book.asks.map(a => Number(a.price)));
    }
    return { tokenId, ask: bestAsk };
  } catch {
    return { tokenId: "", ask: null };
  }
}

async function initMarkets(): Promise<void> {
  console.log("Fetching market data...");
  const kalPrices = await fetchKalshiPrices();

  // Fetch PM data in parallel (batched to avoid rate limits)
  const pmResults = await Promise.all(
    KEYWORD_MAP.map(k => fetchPmTokenAndPrice(k.pmSlug))
  );

  markets = KEYWORD_MAP.map((k, i) => ({
    keyword: k.keyword,
    triggers: k.triggers,
    kalTicker: k.kalTicker,
    kalYesAsk: kalPrices.get(k.kalTicker) ?? 0,
    pmSlug: k.pmSlug,
    pmTokenId: pmResults[i].tokenId,
    pmAsk: pmResults[i].ask,
    requiredClicks: k.requiredClicks ?? 1,
    clicks: 0,
    triggered: false,
  }));

  const matched = markets.filter(m => m.pmTokenId);
  const withKal = markets.filter(m => m.kalTicker);
  console.log(`Loaded ${markets.length} keywords (${withKal.length} with Kalshi, ${matched.length} with PM tokens)`);
}

// --- Trade execution ---------------------------------------------------------

async function executeTrade(market: KeywordMarket): Promise<void> {
  if (market.triggered) {
    console.log(`[SKIP] ${market.keyword} already triggered`);
    return;
  }
  market.triggered = true;
  market.triggerTime = new Date().toISOString();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[TRIGGER] "${market.keyword}" detected! ${DRY_RUN ? "(DRY RUN)" : "LIVE!"}`);
  console.log(`${"=".repeat(60)}`);

  const halfBudget = TRADE_SIZE_USD / 2;

  // Place orders in parallel
  const promises: Promise<void>[] = [];

  // Kalshi: buy YES
  if (market.kalTicker && market.kalYesAsk > 0 && market.kalYesAsk <= MAX_YES_PRICE * 100) {
    promises.push((async () => {
      try {
        const price = market.kalYesAsk / 100; // convert cents to dollars
        const order = buildKalshiOrder(market.kalTicker, "yes", price, halfBudget);
        console.log(`  KAL: BUY YES ${market.kalTicker} @${market.kalYesAsk}c, ${order.count} contracts`);
        const result = await placeKalshiOrder(order, DRY_RUN);
        market.kalResult = result;
        console.log(`  KAL: ${DRY_RUN ? "DRY" : "OK"}`, JSON.stringify(result).slice(0, 200));
      } catch (e: any) {
        market.error = (market.error ?? "") + `KAL: ${e.message}; `;
        console.error(`  KAL ERROR:`, e.message);
      }
    })());
  }

  // PM: buy YES
  if (market.pmTokenId && market.pmAsk !== null && market.pmAsk <= MAX_YES_PRICE) {
    promises.push((async () => {
      try {
        const price = market.pmAsk!;
        console.log(`  PM: BUY YES "${market.keyword}" @${(price * 100).toFixed(1)}c, ~$${halfBudget}`);
        const result = await placePolymarketOrder(
          market.pmSlug,
          "Yes",
          price,
          halfBudget,
          DRY_RUN,
          OrderType.FOK, // Fill or kill for speed
          "usd"
        );
        market.pmResult = result;
        console.log(`  PM: ${DRY_RUN ? "DRY" : "OK"}`, JSON.stringify(result).slice(0, 200));
      } catch (e: any) {
        market.error = (market.error ?? "") + `PM: ${e.message}; `;
        console.error(`  PM ERROR:`, e.message);
      }
    })());
  }

  if (promises.length === 0) {
    console.log(`  No executable orders (prices out of range or missing tokens)`);
    market.error = "No executable orders";
  }

  await Promise.all(promises);
}

// --- Keyword detection -------------------------------------------------------

function checkTranscript(text: string): void {
  const lower = text.toLowerCase();
  for (const m of markets) {
    if (m.triggered) continue;
    for (const trigger of m.triggers) {
      if (lower.includes(trigger)) {
        executeTrade(m).catch(e => console.error(`Trade error for ${m.keyword}:`, e));
        break;
      }
    }
  }
}

// --- Deepgram real-time transcription ----------------------------------------

async function startDeepgramMic(): Promise<void> {
  if (!DEEPGRAM_KEY) {
    console.log("No DEEPGRAM_API_KEY set -- mic transcription disabled. Use dashboard buttons.");
    return;
  }

  // Dynamic imports for optional deps
  let WebSocket: typeof import("ws");
  let recorder: any;
  try {
    WebSocket = (await import("ws")).default as any;
  } catch {
    console.log("Install 'ws' package for Deepgram: npm i ws @types/ws");
    return;
  }

  try {
    recorder = await import("node-record-lpcm16");
  } catch {
    console.log("Install 'node-record-lpcm16' for mic capture: npm i node-record-lpcm16");
    console.log("Also need SoX installed: https://sourceforge.net/projects/sox/");
    return;
  }

  const wsUrl = "wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&utterance_end_ms=1000&vad_events=true";

  deepgramWs = new WebSocket(wsUrl, {
    headers: { Authorization: `Token ${DEEPGRAM_KEY}` },
  });

  deepgramWs.on("open", () => {
    console.log("[DEEPGRAM] Connected. Starting mic...");
    isListening = true;

    const mic = recorder.record({
      sampleRate: 16000,
      channels: 1,
      audioType: "raw",
      recorder: "sox",
    });

    mic.stream().on("data", (chunk: Buffer) => {
      if (deepgramWs?.readyState === 1) { // WebSocket.OPEN
        deepgramWs.send(chunk);
      }
    });

    mic.stream().on("error", (err: Error) => {
      console.error("[MIC] Error:", err.message);
    });
  });

  deepgramWs.on("message", (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "Results" && msg.channel?.alternatives?.[0]) {
        const alt = msg.channel.alternatives[0];
        const text = alt.transcript ?? "";
        const isFinal = msg.is_final;

        if (text) {
          if (isFinal) {
            transcript += text + " ";
            transcriptLines.push(`[${new Date().toLocaleTimeString()}] ${text}`);
            if (transcriptLines.length > 200) transcriptLines.shift();
            console.log(`[FINAL] ${text}`);
          } else {
            console.log(`[partial] ${text}`);
          }
          // Check keywords on both partial and final for speed
          checkTranscript(text);
        }
      }
    } catch {}
  });

  deepgramWs.on("error", (err: Error) => {
    console.error("[DEEPGRAM] Error:", err.message);
    isListening = false;
  });

  deepgramWs.on("close", () => {
    console.log("[DEEPGRAM] Disconnected");
    isListening = false;
  });
}

// --- Web dashboard -----------------------------------------------------------

function startDashboard(): void {
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(dashboardHtml());
  });

  // API: current state
  app.get("/api/state", (_req, res) => {
    res.json({
      dryRun: DRY_RUN,
      tradeSize: TRADE_SIZE_USD,
      isListening,
      markets: markets.map(m => ({
        keyword: m.keyword,
        kalTicker: m.kalTicker,
        kalYesAsk: m.kalYesAsk,
        pmSlug: m.pmSlug,
        pmAsk: m.pmAsk,
        requiredClicks: m.requiredClicks,
        clicks: m.clicks,
        triggered: m.triggered,
        triggerTime: m.triggerTime,
        error: m.error,
      })),
      transcript: transcriptLines.slice(-30),
    });
  });

  // API: manually trigger a keyword (multi-click: increments clicks, fires trade when clicks >= requiredClicks)
  app.post("/api/trigger/:keyword", async (req, res) => {
    const keyword = decodeURIComponent(req.params.keyword);
    const m = markets.find(x => x.keyword === keyword);
    if (!m) return res.status(404).json({ error: "Unknown keyword" });
    if (m.triggered) return res.status(409).json({ error: "Already triggered" });

    m.clicks++;
    if (m.clicks >= m.requiredClicks) {
      await executeTrade(m);
      res.json({ ok: true, keyword: m.keyword, clicks: m.clicks, requiredClicks: m.requiredClicks, triggered: m.triggered, error: m.error });
    } else {
      res.json({ ok: true, keyword: m.keyword, clicks: m.clicks, requiredClicks: m.requiredClicks, triggered: false });
    }
  });

  // API: reset a keyword (allow re-trigger)
  app.post("/api/reset/:keyword", (req, res) => {
    const keyword = decodeURIComponent(req.params.keyword);
    const m = markets.find(x => x.keyword === keyword);
    if (!m) return res.status(404).json({ error: "Unknown keyword" });
    m.triggered = false;
    m.clicks = 0;
    m.triggerTime = undefined;
    m.kalResult = undefined;
    m.pmResult = undefined;
    m.error = undefined;
    res.json({ ok: true });
  });

  // API: refresh prices
  app.post("/api/refresh", async (_req, res) => {
    await initMarkets();
    res.json({ ok: true, count: markets.length });
  });

  app.listen(PORT, () => {
    console.log(`\nDashboard: http://localhost:${PORT}`);
    console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "[!] LIVE TRADING [!]"}`);
    console.log(`Trade size: $${TRADE_SIZE_USD} per keyword\n`);
  });
}

// --- Dashboard HTML ----------------------------------------------------------

function dashboardHtml(): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Powell Live Mention Bot</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 10px 16px; }
  h1 { color: #58a6ff; margin-bottom: 4px; font-size: 18px; display: inline-block; margin-right: 12px; }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; flex-wrap: wrap; }
  .mode { font-size: 12px; padding: 4px 10px; border-radius: 4px; display: inline-block; }
  .mode.dry { background: #1f3a1f; color: #3fb950; }
  .mode.live { background: #3d1f1f; color: #f85149; font-weight: bold; }
  .stats { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; display: flex; align-items: center; gap: 6px; }
  .stat .label { font-size: 10px; color: #8b949e; text-transform: uppercase; }
  .stat .value { font-size: 16px; font-weight: bold; color: #58a6ff; }
  .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-bottom: 10px; }
  .kw { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; cursor: pointer; transition: all 0.12s; position: relative; min-height: 48px; overflow: hidden; }
  .kw:hover { border-color: #58a6ff; background: #1a2233; }
  .kw.both { border-left: 3px solid #58a6ff; }
  .kw.triggered { border-color: #3fb950; background: #0d1f0d; cursor: default; }
  .kw.triggered:hover { background: #0d1f0d; }
  .kw.error { border-color: #f85149; }
  .kw .name { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .kw .prices { font-size: 9px; color: #8b949e; margin-top: 1px; }
  .kw .status { font-size: 9px; margin-top: 1px; }
  .kw .status.done { color: #3fb950; }
  .kw .status.err { color: #f85149; }
  .kw .reset-btn { position: absolute; top: 3px; right: 4px; font-size: 8px; background: #21262d; border: 1px solid #30363d; color: #8b949e; padding: 1px 4px; border-radius: 3px; cursor: pointer; display: none; }
  .kw.triggered .reset-btn { display: block; }
  .progress-bar { display: flex; gap: 2px; margin-top: 3px; height: 6px; border-radius: 3px; overflow: hidden; }
  .progress-seg { flex: 1; background: #21262d; border-radius: 2px; transition: background 0.15s; }
  .progress-seg.filled { background: #f0883e; }
  .kw .click-hint { font-size: 8px; color: #8b949e; position: absolute; top: 3px; right: 4px; }
  .transcript { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px; max-height: 180px; overflow-y: auto; font-family: 'Cascadia Code', 'Fira Code', monospace; font-size: 11px; line-height: 1.5; }
  .transcript .line { color: #8b949e; }
  .actions { display: flex; gap: 6px; }
  .btn { background: #21262d; border: 1px solid #30363d; color: #c9d1d9; padding: 4px 12px; border-radius: 5px; cursor: pointer; font-size: 12px; }
  .btn:hover { background: #30363d; }
  .section-title { font-size: 11px; color: #8b949e; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; }
</style>
</head><body>
<div class="header">
  <h1>Powell Live Mention Bot</h1>
  <div id="mode" class="mode"></div>
  <div class="stats">
    <div class="stat"><div class="label">KW</div><div class="value" id="total">-</div></div>
    <div class="stat"><div class="label">Hit</div><div class="value" id="triggered">-</div></div>
    <div class="stat"><div class="label">Mic</div><div class="value" id="listening">-</div></div>
    <div class="stat"><div class="label">Size</div><div class="value" id="tradeSize">-</div></div>
  </div>
  <div class="actions">
    <button class="btn" onclick="refresh()">Refresh Prices</button>
  </div>
</div>

<div class="section-title">Keywords -- click to trigger (<span style="border-left:3px solid #58a6ff;padding-left:4px">blue</span> = both KAL+PM)</div>
<div class="grid" id="grid"></div>

<div class="section-title">Live Transcript</div>
<div class="transcript" id="transcript"></div>

<script>
let state = {};

async function fetchState() {
  try {
    const r = await fetch('/api/state');
    state = await r.json();
    render();
  } catch {}
}

function render() {
  document.getElementById('mode').className = 'mode ' + (state.dryRun ? 'dry' : 'live');
  document.getElementById('mode').textContent = state.dryRun ? 'DRY RUN' : 'LIVE TRADING';
  document.getElementById('total').textContent = state.markets?.length ?? '-';
  document.getElementById('triggered').textContent = (state.markets?.filter(m => m.triggered).length ?? 0);
  document.getElementById('listening').textContent = state.isListening ? 'Yes' : 'No (manual)';
  document.getElementById('tradeSize').textContent = '$' + (state.tradeSize ?? 0);

  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for (const m of (state.markets || [])) {
    const div = document.createElement('div');
    div.className = 'kw' + (m.kalTicker ? ' both' : '') + (m.triggered ? ' triggered' : '') + (m.error ? ' error' : '');
    const kalPrice = m.kalTicker ? 'KAL:' + m.kalYesAsk + 'c' : '';
    const pmPrice = m.pmAsk !== null ? 'PM:' + (m.pmAsk * 100).toFixed(1) + 'c' : 'PM:--';
    let progressHtml = '';
    if (m.requiredClicks > 1 && !m.triggered) {
      let segs = '';
      for (let i = 0; i < m.requiredClicks; i++) {
        segs += '<div class="progress-seg' + (i < m.clicks ? ' filled' : '') + '"></div>';
      }
      progressHtml = '<div class="progress-bar">' + segs + '</div>';
    }
    const hintHtml = (m.requiredClicks > 1 && !m.triggered) ? '<div class="click-hint">' + m.clicks + '/' + m.requiredClicks + '</div>' : '';
    div.innerHTML =
      '<div class="name">' + m.keyword + '</div>' +
      '<div class="prices">' + [kalPrice, pmPrice].filter(Boolean).join(' | ') + '</div>' +
      progressHtml + hintHtml +
      (m.triggered ? '<div class="status done">Triggered ' + (m.triggerTime ? new Date(m.triggerTime).toLocaleTimeString() : '') + '</div>' : '') +
      (m.error ? '<div class="status err">' + m.error + '</div>' : '') +
      '<button class="reset-btn" onclick="event.stopPropagation();resetKw(\\''+m.keyword+'\\')">reset</button>';
    if (!m.triggered) {
      div.onclick = () => triggerKw(m.keyword);
    }
    grid.appendChild(div);
  }

  const tDiv = document.getElementById('transcript');
  tDiv.innerHTML = (state.transcript || []).map(l => '<div class="line">' + l + '</div>').join('');
  tDiv.scrollTop = tDiv.scrollHeight;
}

async function triggerKw(keyword) {
  try {
    await fetch('/api/trigger/' + encodeURIComponent(keyword), { method: 'POST' });
    await fetchState();
  } catch(e) { alert('Error: ' + e.message); }
}

async function resetKw(keyword) {
  try {
    await fetch('/api/reset/' + encodeURIComponent(keyword), { method: 'POST' });
    await fetchState();
  } catch(e) { alert('Error: ' + e.message); }
}

async function refresh() {
  try {
    await fetch('/api/refresh', { method: 'POST' });
    await fetchState();
  } catch(e) { alert('Error: ' + e.message); }
}

fetchState();
setInterval(fetchState, 2000);
</script>
</body></html>`;
}

// --- Main --------------------------------------------------------------------

async function main() {
  console.log("Powell Live Mention Bot");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`Trade size: $${TRADE_SIZE_USD} per keyword`);
  console.log(`Max YES price: ${MAX_YES_PRICE * 100}c\n`);

  await initMarkets();
  startDashboard();

  // Start Deepgram mic if key provided
  if (DEEPGRAM_KEY) {
    await startDeepgramMic();
  } else {
    console.log("\nNo DEEPGRAM_API_KEY -- use dashboard buttons for manual triggers.");
    console.log("To enable auto transcription: set DEEPGRAM_API_KEY in .env");
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
