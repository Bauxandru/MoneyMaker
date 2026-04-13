/**
 * Backfill arb_trades.json with historical trades from Kalshi fills + PM positions.
 * Run once: npx tsx src/backfillPnL.ts
 *
 * Pulls all Kalshi fills (paginated), fetches market titles, fetches PM positions,
 * matches them by player name / match, and writes ArbTradeRecord entries.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Wallet } from "ethers";
import { fetchJson } from "./http.js";
import dotenv from "dotenv";
dotenv.config();

// --- ArbTradeRecord (same as tradeTennis.ts) ---------------------------------

type ArbTradeRecord = {
  id: string;
  ts: string;
  match: string;
  dir: "A" | "B";
  status: "filled" | "hedging" | "resolved";
  shares: number;
  kalTicker: string;
  kalFillPrice: number;
  kalCost: number;
  pmOutcome: string;
  pmSlug: string;
  pmFillPrice: number;
  pmCost: number;
  totalCost: number;
  projectedEdge: number;
  projectedProfit: number;
  resolvedTs?: string;
  resolutionMethod?: "both-legs" | "hedge-complete" | "hedge-exit" | "settlement";
  hedgeCost?: number;
  realizedPnl?: number;
};

const ARB_LOG_PATH = path.join("data", "arb_trades.json");

// --- Kalshi auth (exact copy from checkPnL.ts) ------------------------------

function loadPrivateKey(): string {
  if (process.env.KALSHI_PRIVATE_KEY) {
    return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  const p = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
  return fs.readFileSync(p, "utf8");
}

const BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

function signRequest(method: string, urlPath: string, timestamp: string, privateKeyPem: string) {
  const data = `${timestamp}${method.toUpperCase()}${urlPath}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  return signer.sign(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    "base64"
  );
}

async function kalshiGet(apiPath: string): Promise<Record<string, unknown>> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error("Missing KALSHI_API_KEY_ID.");
  const privateKey = loadPrivateKey();
  const fullUrl = new URL(`${BASE}${apiPath}`);
  const timestamp = Date.now().toString();
  const sig = signRequest("GET", fullUrl.pathname, timestamp, privateKey);
  return fetchJson(fullUrl.toString(), {
    method: "GET",
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": sig,
      "KALSHI-ACCESS-TIMESTAMP": timestamp,
      "Content-Type": "application/json",
    },
  }) as Promise<Record<string, unknown>>;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// --- Helpers (from tradeTennis.ts) -------------------------------------------

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function parseDateFromTicker(ticker: string): string {
  const m = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  return `20${m[1]}-${MONTHS[m[2].toUpperCase()] ?? "01"}-${m[3].padStart(2, "0")}`;
}

function extractEntityName(title: string): string {
  const m = title.match(/^Will\s+(.+?)\s+win\b/i);
  return m ? m[1].trim() : "";
}

function pmSlugToken(fullName: string): string {
  const last = fullName.trim().split(/\s+/).pop() ?? fullName;
  return last.toLowerCase().slice(0, 7);
}

const SERIES_TO_PM_PREFIX: Record<string, string> = {
  KXATPMATCH: "atp",
  KXWTAMATCH: "wta",
  KXCS2GAME: "cs2", KXCS2MAP: "cs2",
  KXLOLGAME: "lol", KXLOLMAP: "lol",
  KXDOTA2GAME: "dota2", KXDOTA2MAP: "dota2",
  KXVALGAME: "valorant", KXVALMAP: "valorant",
  KXRLGAME: "rocket-league", KXRLMAP: "rocket-league",
  KXCSGAME: "cs2", KXCSMAP: "cs2",
};

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const aw = na.split(" "), bw = nb.split(" ");
  const [shorter, longer] = aw.length <= bw.length ? [aw, bw] : [bw, aw];
  if (shorter.length === 1 && shorter[0].length >= 4 && shorter.every(w => longer.includes(w))) return true;
  if (shorter.length > 1 && shorter.every(w => longer.includes(w))) return true;
  return false;
}

/** Extract the series ticker from a full ticker, e.g. "KXATPMATCH-26FEB25VACMON-VAC" -> "KXATPMATCH" */
function extractSeries(ticker: string): string {
  return ticker.split("-")[0] ?? "";
}

/** Extract match code (ticker minus player suffix), e.g. "KXATPMATCH-26FEB25VACMON-VAC" -> "KXATPMATCH-26FEB25VACMON" */
function matchCode(ticker: string): string {
  const parts = ticker.split("-");
  return parts.slice(0, -1).join("-");
}

// --- Types for intermediate data ---------------------------------------------

type KalFill = {
  ticker: string;
  action: string;  // "buy" | "sell"
  side: string;    // "yes" | "no"
  count: number;
  yesPrice: number;  // cents
  noPrice: number;   // cents
  ts: string;        // ISO timestamp
};

type KalSettlement = {
  ticker: string;
  revenue: number;  // cents
  yesCount: number;
  noCount: number;
  settledTime: string;
};

type KalMarketInfo = {
  ticker: string;
  title: string;
  playerName: string;  // extracted via "Will X win..."
  status: string;
};

type PmPosition = {
  title: string;
  outcome: string;
  slug: string;
  size: number;
  avgPrice: number;
  curPrice: number;
  cashPnl: number;
  realizedPnl: number;
};

// --- Fetch helpers -----------------------------------------------------------

async function fetchAllKalshiFills(): Promise<KalFill[]> {
  const all: KalFill[] = [];
  let cursor = "";
  let page = 0;
  while (true) {
    page++;
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    console.log(`  Fetching fills page ${page}...`);
    const res = await kalshiGet(`/portfolio/fills?${params}`);
    const items = (Array.isArray(res.fills) ? res.fills :
                   Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
    for (const f of items) {
      all.push({
        ticker: String(f.ticker ?? ""),
        action: String(f.action ?? ""),
        side: String(f.side ?? ""),
        count: Number(f.count ?? 0),
        yesPrice: Number(f.yes_price ?? 0),
        noPrice: Number(f.no_price ?? 0),
        ts: String(f.created_time ?? ""),
      });
    }
    if (items.length < 200) break;
    const nextCursor = String(res.cursor ?? res.next_cursor ?? "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(150);
  }
  return all;
}

async function fetchAllKalshiSettlements(): Promise<KalSettlement[]> {
  const all: KalSettlement[] = [];
  let cursor = "";
  let page = 0;
  while (true) {
    page++;
    const params = new URLSearchParams({ limit: "200" });
    if (cursor) params.set("cursor", cursor);
    console.log(`  Fetching settlements page ${page}...`);
    const res = await kalshiGet(`/portfolio/settlements?${params}`);
    const items = (Array.isArray(res.settlements) ? res.settlements :
                   Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
    for (const s of items) {
      all.push({
        ticker: String(s.ticker ?? s.market_ticker ?? ""),
        revenue: Number(s.revenue ?? 0),
        yesCount: Number(s.count ?? s.yes_count ?? 0),
        noCount: Number(s.no_count ?? 0),
        settledTime: String(s.settled_time ?? s.created_time ?? ""),
      });
    }
    if (items.length < 200) break;
    const nextCursor = String(res.cursor ?? res.next_cursor ?? "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(150);
  }
  return all;
}

async function fetchKalshiMarket(ticker: string): Promise<KalMarketInfo | null> {
  try {
    const res = await kalshiGet(`/markets/${ticker}`);
    const market = (res.market as Record<string, unknown>) ?? res;
    const title = String(market.title ?? "");
    return {
      ticker,
      title,
      playerName: extractEntityName(title),
      status: String(market.status ?? ""),
    };
  } catch (e) {
    console.error(`  Failed to fetch market ${ticker}: ${(e as Error).message}`);
    return null;
  }
}

async function fetchPmPositions(): Promise<PmPosition[]> {
  const w = new Wallet(process.env.POLY_WALLET_PRIVATE_KEY ?? "");
  const funder = process.env.POLY_FUNDER || w.address;
  const db = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
  const res = await fetch(`${db}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.1`);
  const raw = await res.json();
  const positions: Record<string, unknown>[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : Array.isArray((raw as Record<string, unknown>)?.positions)
      ? ((raw as Record<string, unknown>).positions as Record<string, unknown>[])
      : [];

  return positions.map(p => ({
    title: String(p.title ?? ""),
    outcome: String(p.outcome ?? ""),
    slug: String(p.slug ?? p.market_slug ?? ""),
    size: Number(p.size ?? p.amount ?? 0),
    avgPrice: Number(p.avgPrice ?? 0),
    curPrice: Number(p.curPrice ?? 0),
    cashPnl: Number(p.cashPnl ?? 0),
    realizedPnl: Number(p.realizedPnl ?? 0),
  }));
}

// --- Main backfill logic -----------------------------------------------------

async function main() {
  console.log("=== Arb Trade Backfill ===\n");

  // Check if file already has data
  if (fs.existsSync(ARB_LOG_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(ARB_LOG_PATH, "utf8"));
      if (Array.isArray(existing) && existing.length > 0) {
        console.log(`WARNING: ${ARB_LOG_PATH} already has ${existing.length} entries.`);
        console.log("Backfill will APPEND to existing data. Press Ctrl+C within 5s to abort.\n");
        await sleep(5000);
      }
    } catch { /* empty or invalid, will overwrite */ }
  }

  // 1) Fetch all Kalshi fills
  console.log("-- Step 1: Kalshi Fills --");
  const allFills = await fetchAllKalshiFills();
  console.log(`  Total fills: ${allFills.length}`);

  // Filter to BUY fills only on known sports/esports series
  const knownSeries = new Set(Object.keys(SERIES_TO_PM_PREFIX));
  const buyFills = allFills.filter(f => {
    if (f.action !== "buy") return false;
    const series = extractSeries(f.ticker);
    return knownSeries.has(series);
  });
  console.log(`  Bot BUY fills (known series): ${buyFills.length}\n`);

  if (buyFills.length === 0) {
    console.log("No bot arb fills found. Nothing to backfill.");
    return;
  }

  // Group fills by ticker -> aggregate shares and cost
  type TickerGroup = {
    ticker: string;
    totalShares: number;
    totalCostCents: number;
    fills: KalFill[];
    firstTs: string;
  };
  const tickerGroups = new Map<string, TickerGroup>();
  for (const f of buyFills) {
    let g = tickerGroups.get(f.ticker);
    if (!g) {
      g = { ticker: f.ticker, totalShares: 0, totalCostCents: 0, fills: [], firstTs: f.ts };
      tickerGroups.set(f.ticker, g);
    }
    const price = f.yesPrice || f.noPrice;
    g.totalShares += f.count;
    g.totalCostCents += f.count * price;
    g.fills.push(f);
    if (f.ts < g.firstTs) g.firstTs = f.ts;
  }
  console.log(`  Unique tickers with BUY fills: ${tickerGroups.size}`);

  // 2) Fetch all Kalshi settlements
  console.log("\n-- Step 2: Kalshi Settlements --");
  const allSettlements = await fetchAllKalshiSettlements();
  console.log(`  Total settlements: ${allSettlements.length}`);
  const settlementMap = new Map<string, KalSettlement>();
  for (const s of allSettlements) {
    settlementMap.set(s.ticker, s);
  }

  // 3) Fetch market details for each unique ticker (for titles / player names)
  console.log("\n-- Step 3: Kalshi Market Details --");
  const marketInfoMap = new Map<string, KalMarketInfo>();
  const tickers = [...tickerGroups.keys()];
  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    console.log(`  [${i + 1}/${tickers.length}] Fetching ${t}...`);
    const info = await fetchKalshiMarket(t);
    if (info) marketInfoMap.set(t, info);
    await sleep(150);
  }
  console.log(`  Got details for ${marketInfoMap.size}/${tickers.length} markets`);

  // 4) Group tickers by match code (pair the two player markets together)
  const matchGroups = new Map<string, string[]>();
  for (const t of tickers) {
    const mc = matchCode(t);
    const arr = matchGroups.get(mc) ?? [];
    arr.push(t);
    matchGroups.set(mc, arr);
  }
  console.log(`\n  Match groups: ${matchGroups.size}`);

  // 5) Fetch PM positions
  console.log("\n-- Step 4: Polymarket Positions --");
  let pmPositions: PmPosition[] = [];
  try {
    pmPositions = await fetchPmPositions();
    console.log(`  Total PM positions: ${pmPositions.length}`);
  } catch (e) {
    console.error(`  PM fetch error: ${(e as Error).message}`);
    console.log("  Continuing with Kalshi-only data...");
  }

  // Index PM positions by slug + outcome for faster lookup
  const pmBySlugOutcome = new Map<string, PmPosition>();
  const pmByOutcome = new Map<string, PmPosition[]>();
  for (const p of pmPositions) {
    const key = `${p.slug}::${normalizeName(p.outcome)}`;
    pmBySlugOutcome.set(key, p);
    const arr = pmByOutcome.get(normalizeName(p.outcome)) ?? [];
    arr.push(p);
    pmByOutcome.set(normalizeName(p.outcome), arr);
  }

  // 6) Build ArbTradeRecord entries
  console.log("\n-- Step 5: Building Arb Records --\n");
  const records: ArbTradeRecord[] = [];
  let matched = 0, unmatched = 0;

  for (const [mc, mcTickers] of matchGroups) {
    // Get market info and player names for this match
    const marketInfos = mcTickers.map(t => marketInfoMap.get(t)).filter(Boolean) as KalMarketInfo[];

    // Extract player names from titles
    const playerNames = new Map<string, string>();  // ticker -> player name
    for (const info of marketInfos) {
      if (info.playerName) playerNames.set(info.ticker, info.playerName);
    }

    // Build match label from player names
    const names = [...playerNames.values()];
    const matchLabel = names.length >= 2 ? `${names[0]} vs ${names[1]}` : names[0] ?? mc;

    // For each ticker we have BUY fills on
    for (const ticker of mcTickers) {
      const group = tickerGroups.get(ticker)!;
      const info = marketInfoMap.get(ticker);
      const settlement = settlementMap.get(ticker);

      // The player we bought YES on (Kalshi side)
      const kalPlayerName = playerNames.get(ticker) ?? "";

      // The OTHER player(s) in this match -- that's who we need on the PM side
      const otherNames = [...playerNames.entries()]
        .filter(([t]) => t !== ticker)
        .map(([, n]) => n);

      // Try to find matching PM position for the OTHER player
      let pmMatch: PmPosition | null = null;

      // Try by slug first
      const series = extractSeries(ticker);
      const prefix = SERIES_TO_PM_PREFIX[series] ?? "";
      const date = parseDateFromTicker(ticker);
      if (prefix && date && names.length >= 2) {
        const tokens = names.map(n => pmSlugToken(n)).sort();
        const slugGuess = `${prefix}-${tokens.join("-")}-${date}`;
        for (const otherName of otherNames) {
          const key = `${slugGuess}::${normalizeName(otherName)}`;
          const found = pmBySlugOutcome.get(key);
          if (found) { pmMatch = found; break; }
        }
      }

      // Fallback: match by name across all PM positions
      if (!pmMatch) {
        for (const otherName of otherNames) {
          const candidates = pmByOutcome.get(normalizeName(otherName));
          if (candidates && candidates.length > 0) {
            // Pick the one closest in size to our Kalshi shares
            pmMatch = candidates.reduce((best, c) =>
              Math.abs(c.size - group.totalShares) < Math.abs(best.size - group.totalShares) ? c : best
            );
            break;
          }
          // Try fuzzy name match
          for (const [, positions] of pmByOutcome) {
            for (const p of positions) {
              if (namesMatch(otherName, p.outcome)) {
                pmMatch = p;
                break;
              }
            }
            if (pmMatch) break;
          }
          if (pmMatch) break;
        }
      }

      // Compute costs
      const kalCost = group.totalCostCents / 100;       // dollars
      const kalAvgPrice = kalCost / group.totalShares;   // dollar per share
      const pmCost = pmMatch ? pmMatch.size * pmMatch.avgPrice : 0;
      const pmAvgPrice = pmMatch ? pmMatch.avgPrice : 0;
      const pmShares = pmMatch ? pmMatch.size : 0;
      const totalCost = kalCost + pmCost;

      // Use Kalshi shares as canonical share count (PM may differ slightly)
      const shares = group.totalShares;

      // Edge and profit
      const edge = 1 - kalAvgPrice - pmAvgPrice;
      const projectedProfit = shares * edge;

      // Determine status
      let status: ArbTradeRecord["status"] = "filled";
      let resolvedTs: string | undefined;
      let resolutionMethod: ArbTradeRecord["resolutionMethod"];
      let realizedPnl: number | undefined;

      if (settlement) {
        status = "resolved";
        resolvedTs = settlement.settledTime;
        resolutionMethod = "settlement";
        // Revenue from settlement (cents -> dollars)
        const revenueDollars = settlement.revenue / 100;
        // For settled arbs: P&L = settlement revenue - Kalshi cost
        // The PM side payout is separate (either won or lost on PM)
        // Full arb P&L = $1 payout per share - totalCost (if arb won on the combined side)
        realizedPnl = revenueDollars - kalCost;
        // If we also have PM data, add the PM P&L
        if (pmMatch) {
          const pmPnl = pmMatch.cashPnl || pmMatch.realizedPnl || 0;
          if (pmPnl !== 0) {
            realizedPnl += pmPnl;
          } else if (pmMatch.curPrice >= 0.99) {
            // PM side won -> got $1 per share
            realizedPnl = (shares * 1) - totalCost;
          } else if (pmMatch.curPrice <= 0.01) {
            // PM side lost -> got $0
            realizedPnl = revenueDollars - kalCost - pmCost;
          }
        }
      } else if (info?.status === "finalized" || info?.status === "settled") {
        status = "resolved";
        resolutionMethod = "settlement";
      } else {
        // Check if PM position is resolved
        if (pmMatch && (pmMatch.curPrice >= 0.99 || pmMatch.curPrice <= 0.01)) {
          // Arb is essentially resolved -- one side won
          realizedPnl = shares * 1 - totalCost;
        } else {
          // Still open -- use projected
          realizedPnl = projectedProfit;
        }
      }

      // Determine direction (A = bought P1 on KAL, B = bought P2 on KAL)
      // P1 is the first name in the match label
      const dir: "A" | "B" = names.length >= 2 && kalPlayerName === names[0] ? "A" : "B";

      const record: ArbTradeRecord = {
        id: `backfill-${Date.now()}-${records.length}`,
        ts: group.firstTs,
        match: matchLabel,
        dir,
        status,
        shares,
        kalTicker: ticker,
        kalFillPrice: kalAvgPrice,
        kalCost,
        pmOutcome: pmMatch?.outcome ?? (otherNames[0] ?? ""),
        pmSlug: pmMatch?.slug ?? "",
        pmFillPrice: pmAvgPrice,
        pmCost,
        totalCost,
        projectedEdge: edge,
        projectedProfit,
        ...(resolvedTs ? { resolvedTs } : {}),
        ...(resolutionMethod ? { resolutionMethod } : {}),
        ...(realizedPnl !== undefined ? { realizedPnl } : {}),
      };

      records.push(record);

      const pmTag = pmMatch ? `PM: ${pmMatch.outcome} ${pmShares}x@${(pmAvgPrice * 100).toFixed(0)}c` : "PM: (no match)";
      const statusTag = status === "resolved" ? "RESOLVED" : "OPEN";
      const pnlTag = realizedPnl !== undefined ? `pnl=$${realizedPnl.toFixed(2)}` : "";
      console.log(`  ${statusTag.padEnd(8)} ${matchLabel.padEnd(45).slice(0, 45)}  KAL: ${shares}x@${(kalAvgPrice * 100).toFixed(0)}c=$${kalCost.toFixed(2)}  ${pmTag}  ${pnlTag}`);

      if (pmMatch) matched++; else unmatched++;
    }
  }

  // Sort by timestamp
  records.sort((a, b) => a.ts.localeCompare(b.ts));

  // 7) Write to file
  console.log(`\n-- Step 6: Writing ${ARB_LOG_PATH} --`);
  const dir = path.dirname(ARB_LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Append to existing if present
  let existing: ArbTradeRecord[] = [];
  if (fs.existsSync(ARB_LOG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ARB_LOG_PATH, "utf8"));
      if (Array.isArray(raw)) existing = raw;
    } catch { /* start fresh */ }
  }

  const combined = [...existing, ...records];
  fs.writeFileSync(ARB_LOG_PATH, JSON.stringify(combined, null, 2), "utf8");

  // Summary
  const totalCost = records.reduce((s, r) => s + r.totalCost, 0);
  const totalPnl = records.reduce((s, r) => s + (r.realizedPnl ?? r.projectedProfit), 0);
  const resolvedCount = records.filter(r => r.status === "resolved").length;

  console.log(`\n=== Backfill Summary ===`);
  console.log(`  Records created:  ${records.length}`);
  console.log(`  PM-matched:       ${matched}`);
  console.log(`  Kalshi-only:      ${unmatched}`);
  console.log(`  Resolved:         ${resolvedCount}`);
  console.log(`  Still open:       ${records.length - resolvedCount}`);
  console.log(`  Total invested:   $${totalCost.toFixed(2)}`);
  console.log(`  Est. total P&L:   $${totalPnl.toFixed(2)}`);
  if (existing.length > 0) {
    console.log(`  (Appended to ${existing.length} existing entries, total now: ${combined.length})`);
  }
  console.log(`\n  Written to: ${ARB_LOG_PATH}`);
  console.log(`=== Done ===`);
}

main().catch(console.error);
