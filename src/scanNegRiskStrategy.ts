import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fetchJson } from "./http.js";
import { fetchKalshiSnapshot } from "./kalshi.js";
import { fetchLimitlessSnapshot } from "./limitless.js";
import { fetchPolymarketSnapshot } from "./polymarket.js";
import { fetchProbableSnapshot } from "./probable.js";
import { Exchange, MarketPairConfig, MarketSnapshot } from "./types.js";

dotenv.config();

type AnyRecord = Record<string, unknown>;

type PriceLevel = {
  price: number;
  size: number;
  exchange?: Exchange;
  id?: string;
};

type PairLeg = {
  exchange: Exchange;
  id: string;
  endDate?: string;
};

type MatchLink = PairLeg & { title?: string };

type PolymarketMarket = {
  marketSlug: string;
  eventSlug: string;
  question: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  enableOrderBook: boolean;
};

type StrategyRow = {
  ts: string;
  tier: "high" | "review";
  eventSlug: string;
  options: number;
  pmBuyNoMarket: string;
  pmNoAsk: number | null;
  payoutPerShare: number;
  unitCost: number | null;
  unitProfit: number | null;
  unitEdge: number | null;
  depth: number | null;
  capital: number | null;
  profit: number | null;
  roi: number | null;
  daysToSettle: number | null;
  roiAnnual: number | null;
  buyNoLegs: string;
  convertYesMarkets: string;
};

function num(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean) {
  if (!raw) return fallback;
  return raw.trim().toLowerCase() !== "false";
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function csvEscape(value: string) {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/\"/g, "\"\"")}"`;
  }
  return value;
}

function formatNum(value: number | null) {
  return value === null ? "" : value.toFixed(4);
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseDate(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function daysBetween(a: number, b: number) {
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

function latestDate(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function annualizedRoi(roi: number | null, days: number | null): number | null {
  if (roi === null || days === null || days <= 0) return null;
  return roi * (365 / days);
}

function parseCsv(filePath: string, onRow: (row: string[], idx: number) => void) {
  const data = fs.readFileSync(filePath, "utf8");
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let rowIndex = -1;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const finishRow = () => {
    if (row.length === 1 && row[0] === "" && rowIndex >= 0) {
      row = [];
      return;
    }
    rowIndex += 1;
    onRow(row, rowIndex);
    row = [];
  };

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === "\"") {
      const next = data[i + 1];
      if (inQuotes && next === "\"") {
        field += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      pushField();
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      pushField();
      finishRow();
      if (ch === "\r" && data[i + 1] === "\n") i += 1;
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    pushField();
    finishRow();
  }
}

function mergePriceLevels(levels: PriceLevel[]): PriceLevel[] {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged: PriceLevel[] = [];
  for (const level of sorted) {
    if (!merged.length || merged[merged.length - 1].price !== level.price) {
      merged.push({ ...level });
      continue;
    }
    merged[merged.length - 1].size += level.size;
  }
  return merged;
}

function computeMultiLegDepth(
  legLevels: PriceLevel[][],
  maxAvgCostPerShare: number,
  allowZeroDepth: boolean
) {
  const legs = legLevels.map(mergePriceLevels);
  if (legs.some((l) => l.length === 0)) {
    return allowZeroDepth ? { depth: 0, cost: 0 } : { depth: null, cost: null };
  }

  const idx = legs.map(() => 0);
  const remaining = legs.map((l) => l[0].size);
  let depth = 0;
  let cost = 0;

  while (true) {
    const prices: number[] = [];
    for (let i = 0; i < legs.length; i += 1) {
      const current = legs[i][idx[i]];
      if (!current) return { depth, cost };
      prices.push(current.price);
    }

    const unitCost = prices.reduce((sum, p) => sum + p, 0);
    const step = Math.min(...remaining);
    if (step <= 0) return { depth, cost };

    if (unitCost <= maxAvgCostPerShare) {
      depth += step;
      cost += step * unitCost;
      for (let i = 0; i < remaining.length; i += 1) {
        remaining[i] -= step;
        if (remaining[i] <= 0) {
          idx[i] += 1;
          const next = legs[i][idx[i]];
          if (!next) return { depth, cost };
          remaining[i] = next.size;
        }
      }
      continue;
    }

    if (depth === 0) return { depth: allowZeroDepth ? 0 : null, cost: allowZeroDepth ? 0 : null };
    const numerator = maxAvgCostPerShare * depth - cost;
    const denominator = unitCost - maxAvgCostPerShare;
    const maxStep = denominator > 0 ? numerator / denominator : step;
    if (maxStep > 0) {
      const take = Math.min(step, maxStep);
      depth += take;
      cost += take * unitCost;
    }
    return { depth, cost };
  }
}

function profitFromDepth(
  depth: number | null,
  cost: number | null,
  payoutPerShare: number
): number | null {
  if (depth === null || cost === null) return null;
  return payoutPerShare * depth - cost;
}

function roiFromProfit(profit: number | null, cost: number | null): number | null {
  if (profit === null || cost === null || cost <= 0) return null;
  return profit / cost;
}

function parsePolymarketLevels(side: unknown): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const price = toNumber(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      const price = toNumber(obj.price ?? obj[0]);
      const size = toNumber(obj.size ?? obj[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size });
      }
    }
  }
  return out;
}

function sortLevels(levels: PriceLevel[]) {
  return levels.sort((a, b) => a.price - b.price);
}

async function fetchPolymarketBook(tokenId: string): Promise<Record<string, unknown>> {
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  return fetchJson<Record<string, unknown>>(
    `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
  );
}

async function ensurePolymarketAsks(
  asks: PriceLevel[],
  tokenId?: string
): Promise<PriceLevel[]> {
  if (asks.length || !tokenId) return asks;
  const book = await fetchPolymarketBook(tokenId);
  return sortLevels(parsePolymarketLevels(book.asks));
}

function parseLimitlessLevels(side: unknown, scale: number): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const price = toNumber(entry[0]);
      const sizeRaw = toNumber(entry[1]);
      if (price !== null && sizeRaw !== null && sizeRaw > 0) {
        out.push({ price, size: sizeRaw / scale });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      const price = toNumber(obj.price ?? obj[0]);
      const sizeRaw = toNumber(obj.size ?? obj.quantity ?? obj[1]);
      if (price !== null && sizeRaw !== null && sizeRaw > 0) {
        out.push({ price, size: sizeRaw / scale });
      }
    }
  }
  return out;
}

function normalizeKalshiPriceCents(value: unknown): number | null {
  const raw = toNumber(value);
  if (raw === null) return null;
  if (typeof value === "string") {
    if (value.includes(".")) return raw * 100;
    return raw;
  }
  if (Number.isInteger(raw)) return raw;
  if (raw > 0 && raw < 1) return raw * 100;
  return raw;
}

function parseKalshiLevels(side: unknown): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const price = normalizeKalshiPriceCents(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price: price / 100, size });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      const price = normalizeKalshiPriceCents(obj.price ?? obj[0]);
      const size = toNumber(obj.quantity ?? obj.size ?? obj[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price: price / 100, size });
      }
    }
  }
  return out;
}

function impliedAsksFromBids(bids: PriceLevel[]): PriceLevel[] {
  return bids.map((b) => ({ price: 1 - b.price, size: b.size }));
}

function extractLimitlessBooks(snapshot: MarketSnapshot) {
  let noAsks: PriceLevel[] = [];
  let hasBook = false;
  try {
    const raw = JSON.parse(snapshot.rawJson) as AnyRecord;
    const orderbook = raw.orderbook as AnyRecord | undefined;
    const market = raw.market as AnyRecord | undefined;
    const decimalsRaw = (market?.collateralToken as AnyRecord | undefined)?.decimals;
    const decimals = toNumber(decimalsRaw) ?? 6;
    const scale = decimals > 0 ? Math.pow(10, decimals) : 1;

    if (orderbook) {
      hasBook = true;
      const yesBids = parseLimitlessLevels(orderbook.bids ?? orderbook.yesBids ?? orderbook.yes_bids, scale);
      const noAsksRaw = parseLimitlessLevels(orderbook.noAsks ?? orderbook.no_asks, scale);
      noAsks = sortLevels(noAsksRaw);
      if (!noAsks.length && yesBids.length) {
        noAsks = sortLevels(impliedAsksFromBids(yesBids));
      }
    }
  } catch {
    // ignore parse issues
  }
  return { noAsks, hasBook };
}

function extractProbableBooks(snapshot: MarketSnapshot) {
  let noAsks: PriceLevel[] = [];
  let hasBook = false;
  try {
    const raw = JSON.parse(snapshot.rawJson) as AnyRecord;
    const noBook = raw.noBook as AnyRecord | undefined;
    if (noBook) {
      hasBook = true;
      noAsks = sortLevels(parsePolymarketLevels(noBook.asks));
    }
  } catch {
    // ignore parse issues
  }
  return { noAsks, hasBook };
}

async function getKalshiOrderbook(
  ticker: string,
  snapshot: MarketSnapshot
): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(snapshot.rawJson) as AnyRecord;
    const orderbook = raw.orderbook as AnyRecord | undefined;
    if (orderbook) return orderbook;
  } catch {
    // ignore parse issues
  }
  const base = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const bookRes = await fetchJson<Record<string, unknown>>(
    `${base}/markets/${ticker}/orderbook`
  );
  return (bookRes.orderbook as Record<string, unknown>) ?? bookRes;
}

function kalshiNoAsksFromOrderbook(orderbook: Record<string, unknown>): PriceLevel[] {
  // Kalshi orderbook lists bids per side in cents; NO asks correspond to YES bids.
  const yesBids = parseKalshiLevels(orderbook.yes);
  return sortLevels(impliedAsksFromBids(yesBids));
}

function makePolymarketPair(marketSlug: string): MarketPairConfig {
  return {
    id: `pm_${marketSlug}`,
    polymarket: { marketSlug },
    kalshi: { ticker: "", side: "YES" }
  };
}

function makeKalshiPair(ticker: string): MarketPairConfig {
  return {
    id: `kal_${ticker}`,
    polymarket: {},
    kalshi: { ticker, side: "YES" }
  };
}

function makeProbablePair(marketSlug: string): MarketPairConfig {
  return {
    id: `prob_${marketSlug}`,
    polymarket: {},
    kalshi: { ticker: "", side: "YES" },
    probable: { marketSlug }
  };
}

async function fetchSnapshotForLeg(
  leg: PairLeg,
  nowIso: string
): Promise<MarketSnapshot> {
  if (leg.exchange === "polymarket") {
    return fetchPolymarketSnapshot(makePolymarketPair(leg.id), nowIso);
  }
  if (leg.exchange === "kalshi") {
    return fetchKalshiSnapshot(makeKalshiPair(leg.id), nowIso);
  }
  if (leg.exchange === "probable") {
    return fetchProbableSnapshot(makeProbablePair(leg.id), nowIso);
  }
  return fetchLimitlessSnapshot(leg.id, nowIso);
}

async function getNoAsks(
  leg: PairLeg,
  snapshot: MarketSnapshot
): Promise<{ asks: PriceLevel[]; hasBook: boolean; negRisk?: boolean; pmYesTokenId?: string; pmNoTokenId?: string }> {
  if (leg.exchange === "polymarket") {
    let negRisk = false;
    let yesTokenId: string | undefined;
    let noTokenId: string | undefined;
    let asks: PriceLevel[] = [];
    try {
      const raw = JSON.parse(snapshot.rawJson) as AnyRecord;
      const market = raw.market as AnyRecord | undefined;
      negRisk = Boolean(market?.negRisk);
      const tokenIds = Array.isArray(market?.clobTokenIds)
        ? (market?.clobTokenIds as unknown[]).map((v) => String(v))
        : [];
      const outcomes = Array.isArray(market?.outcomes)
        ? (market?.outcomes as unknown[]).map((v) => String(v).toLowerCase())
        : [];
      const yesIdx = outcomes.indexOf("yes");
      const noIdx = outcomes.indexOf("no");
      yesTokenId = yesIdx >= 0 ? tokenIds[yesIdx] : undefined;
      noTokenId = noIdx >= 0 ? tokenIds[noIdx] : undefined;
      const book = raw.book as AnyRecord | undefined;
      const noBook = book?.no as AnyRecord | undefined;
      asks = sortLevels(parsePolymarketLevels(noBook?.asks));
    } catch {
      // ignore parse issues
    }
    asks = await ensurePolymarketAsks(asks, noTokenId);
    return { asks, hasBook: true, negRisk, pmYesTokenId: yesTokenId, pmNoTokenId: noTokenId };
  }

  if (leg.exchange === "kalshi") {
    const orderbook = await getKalshiOrderbook(leg.id, snapshot);
    const asks = kalshiNoAsksFromOrderbook(orderbook);
    return { asks, hasBook: true };
  }

  if (leg.exchange === "probable") {
    const { noAsks, hasBook } = extractProbableBooks(snapshot);
    return { asks: noAsks, hasBook };
  }

  const { noAsks, hasBook } = extractLimitlessBooks(snapshot);
  return { asks: noAsks, hasBook };
}

function loadPolymarketIndex(dataDir: string) {
  const filePath = path.join(dataDir, "polymarket_markets.json");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing Polymarket markets cache: ${filePath}`);
  }
  const markets = JSON.parse(fs.readFileSync(filePath, "utf8")) as PolymarketMarket[];
  const bySlug = new Map<string, PolymarketMarket>();
  const byEvent = new Map<string, PolymarketMarket[]>();

  for (const m of markets) {
    if (!m?.marketSlug || !m?.eventSlug) continue;
    const entry: PolymarketMarket = {
      marketSlug: String(m.marketSlug),
      eventSlug: String(m.eventSlug),
      question: String((m as AnyRecord).question ?? (m as AnyRecord).title ?? m.marketSlug),
      endDate: (m as AnyRecord).endDate ? String((m as AnyRecord).endDate) : undefined,
      active: Boolean((m as AnyRecord).active),
      closed: Boolean((m as AnyRecord).closed),
      enableOrderBook: Boolean((m as AnyRecord).enableOrderBook)
    };
    bySlug.set(entry.marketSlug, entry);
    const list = byEvent.get(entry.eventSlug) ?? [];
    list.push(entry);
    byEvent.set(entry.eventSlug, list);
  }

  return { bySlug, byEvent };
}

function loadMatchIndex(filePath: string) {
  if (!fs.existsSync(filePath)) return null;

  let header: string[] = [];
  const pmToOther = new Map<string, MatchLink[]>();

  parseCsv(filePath, (row, idx) => {
    if (idx === 0) {
      header = row;
      return;
    }
    if (!header.length || !row.length) return;

    const get = (name: string) => {
      const i = header.indexOf(name);
      return i >= 0 ? row[i] ?? "" : "";
    };

    const aEx = get("a_exchange");
    const bEx = get("b_exchange");
    const aId = get("a_id");
    const bId = get("b_id");
    const aEnd = get("a_end_date");
    const bEnd = get("b_end_date");
    const aTitle = get("a_title");
    const bTitle = get("b_title");

    if (!aEx || !bEx || !aId || !bId) return;

    const add = (pmSlug: string, other: MatchLink) => {
      const list = pmToOther.get(pmSlug) ?? [];
      list.push(other);
      pmToOther.set(pmSlug, list);
    };

    const aLower = aEx.trim().toLowerCase();
    const bLower = bEx.trim().toLowerCase();

    if (aLower === "polymarket" && bLower !== "polymarket") {
      add(aId, { exchange: bLower as Exchange, id: bId, endDate: bEnd, title: bTitle });
    } else if (bLower === "polymarket" && aLower !== "polymarket") {
      add(bId, { exchange: aLower as Exchange, id: aId, endDate: aEnd, title: aTitle });
    }
  });

  return { pmToOther };
}

async function runTier(
  tier: "high" | "review",
  matchFile: string,
  outFile: string,
  dataDir: string,
  pmIndex: ReturnType<typeof loadPolymarketIndex>
) {
  const matchIndex = loadMatchIndex(matchFile);
  if (!matchIndex) {
    console.warn(`[NEG_RISK] Missing match file: ${matchFile}`);
    fs.writeFileSync(
      outFile,
      "ts,tier,event_slug,options,pm_buy_no_market,pm_no_ask,payout_per_share,unit_cost,unit_profit,unit_edge,depth_1pct,capital_1pct,profit_1pct,roi_1pct,days_to_settle,roi_1pct_annualized,buy_no_legs,convert_yes_markets\n",
      "utf8"
    );
    return;
  }

  const minEdge = num(process.env.MIN_EDGE, 0);
  const depthEdge = num(process.env.ARB_DEPTH_EDGE, 0.01);
  const requireFullHedge = parseBool(process.env.NEG_RISK_REQUIRE_FULL_HEDGE, true);
  const maxEvents = Math.max(0, Math.floor(num(process.env.NEG_RISK_MAX_EVENTS, 250)));

  const nowIso = new Date().toISOString();
  const runTs = Date.parse(nowIso);

  // Candidate events: those where at least one Polymarket option is matched to another venue.
  const pmSlugs = Array.from(matchIndex.pmToOther.keys());
  const byEventMatched = new Map<string, Set<string>>();
  for (const slug of pmSlugs) {
    const meta = pmIndex.bySlug.get(slug);
    if (!meta) continue;
    if (!meta.active || meta.closed || !meta.enableOrderBook) continue;
    const set = byEventMatched.get(meta.eventSlug) ?? new Set<string>();
    set.add(slug);
    byEventMatched.set(meta.eventSlug, set);
  }

  const candidateEvents: { eventSlug: string; options: PolymarketMarket[] }[] = [];
  for (const [eventSlug, matchedSet] of byEventMatched.entries()) {
    const optionsAll = (pmIndex.byEvent.get(eventSlug) ?? []).filter(
      (m) => m.active && !m.closed && m.enableOrderBook
    );
    if (optionsAll.length < 2) continue;

    // Full hedge needs coverage for N-1 options; the remaining uncovered option (if any)
    // must be the PM option we buy NO on (since conversion mints YES for all other options).
    if (requireFullHedge) {
      const missing = optionsAll.filter((m) => !matchIndex.pmToOther.has(m.marketSlug)).length;
      if (missing > 1) continue;
    }

    // Still require at least one externally-matched option, otherwise conversion is pointless here.
    if (matchedSet.size < 1) continue;
    candidateEvents.push({ eventSlug, options: optionsAll });
  }

  candidateEvents.sort((a, b) => b.options.length - a.options.length);
  const selectedEvents =
    maxEvents > 0 ? candidateEvents.slice(0, maxEvents) : candidateEvents;

  const snapshotCache = new Map<string, Promise<MarketSnapshot | null>>();
  const noAskCache = new Map<
    string,
    Promise<{ asks: PriceLevel[]; hasBook: boolean; negRisk?: boolean; pmYesTokenId?: string; pmNoTokenId?: string }>
  >();

  const legKey = (leg: PairLeg) => `${leg.exchange}:${leg.id}`;
  const getSnapshotCached = (leg: PairLeg) => {
    const key = legKey(leg);
    if (!snapshotCache.has(key)) {
      snapshotCache.set(
        key,
        fetchSnapshotForLeg(leg, nowIso).catch((err) => {
          const msg = (err as Error)?.message ?? String(err);
          console.warn(`[NEG_RISK] ${key}: fetch failed: ${msg}`);
          return null;
        })
      );
    }
    return snapshotCache.get(key)!;
  };

  const getNoAsksCached = (leg: PairLeg, snapshot: MarketSnapshot) => {
    const key = legKey(leg);
    if (!noAskCache.has(key)) {
      noAskCache.set(
        key,
        getNoAsks(leg, snapshot).catch((err) => {
          const msg = (err as Error)?.message ?? String(err);
          console.warn(`[NEG_RISK] ${key}: orderbook parse failed: ${msg}`);
          return { asks: [], hasBook: false };
        })
      );
    }
    return noAskCache.get(key)!;
  };

  const rows: StrategyRow[] = [];

  for (const event of selectedEvents) {
    const options = event.options;

    // Fetch PM NO books for each option to (a) confirm negRisk and (b) find cheapest NO.
    const pmBooks: {
      slug: string;
      endDate?: string;
      noAsks: PriceLevel[];
      negRisk: boolean;
      bestNoAsk: number | null;
    }[] = [];

    for (const opt of options) {
      const leg: PairLeg = { exchange: "polymarket", id: opt.marketSlug, endDate: opt.endDate };
      const snap = await getSnapshotCached(leg);
      if (!snap) continue;
      const noInfo = await getNoAsksCached(leg, snap);
      const bestNo = noInfo.asks.length ? noInfo.asks[0].price : null;
      pmBooks.push({
        slug: opt.marketSlug,
        endDate: opt.endDate,
        noAsks: noInfo.asks,
        negRisk: Boolean(noInfo.negRisk),
        bestNoAsk: bestNo
      });
    }

    if (pmBooks.length !== options.length || pmBooks.length < 2) continue;
    if (pmBooks.some((m) => !m.negRisk)) continue;

    const payoutPerShare = pmBooks.length - 1;
    if (payoutPerShare <= 0) continue;

    // Precompute hedge books (NO asks) for each PM option on external venues.
    const hedgesBySlug = new Map<
      string,
      { askLevels: PriceLevel[]; endDates: (string | undefined)[]; sources: string[]; bestAsk: number | null }
    >();
    for (const opt of pmBooks) {
      const links = matchIndex.pmToOther.get(opt.slug) ?? [];
      const combined: PriceLevel[] = [];
      const sources: string[] = [];
      const endDates: (string | undefined)[] = [];

      for (const link of links) {
        const leg: PairLeg = { exchange: link.exchange, id: link.id, endDate: link.endDate };
        const snap = await getSnapshotCached(leg);
        if (!snap) continue;
        const noInfo = await getNoAsksCached(leg, snap);
        if (!noInfo.hasBook || !noInfo.asks.length) continue;
        for (const lvl of noInfo.asks) {
          combined.push({ ...lvl, exchange: leg.exchange, id: leg.id });
        }
        sources.push(`${link.exchange}:${link.id}`);
        endDates.push(link.endDate);
      }

      const merged = mergePriceLevels(combined);
      const best = merged.length ? merged[0].price : null;
      hedgesBySlug.set(opt.slug, {
        askLevels: merged,
        endDates,
        sources,
        bestAsk: best
      });
    }

    const settleBase = pmBooks.reduce(
      (latest, m) => latestDate(latest, parseDate(m.endDate)),
      null as number | null
    );

    const candidates: StrategyRow[] = [];
    for (const pmBuyNo of pmBooks) {
      if (pmBuyNo.bestNoAsk === null) continue;

      const other = pmBooks.filter((m) => m.slug !== pmBuyNo.slug);
      if (other.length !== payoutPerShare) continue;

      // Require that every converted YES outcome is hedgeable via external NO.
      if (requireFullHedge) {
        const missing = other.filter((m) => (hedgesBySlug.get(m.slug)?.bestAsk ?? null) === null)
          .length;
        if (missing > 0) continue;
      }

      let settleTs: number | null = settleBase;
      let spotCost: number | null = pmBuyNo.bestNoAsk;
      const otherLegs: { pmSlug: string; askLevels: PriceLevel[]; sources: string[]; bestAsk: number | null; endDates: (string | undefined)[] }[] = [];

      for (const m of other) {
        const hedge = hedgesBySlug.get(m.slug) ?? {
          askLevels: [],
          sources: [],
          bestAsk: null,
          endDates: []
        };

        for (const end of hedge.endDates) {
          settleTs = latestDate(settleTs, parseDate(end));
        }

        otherLegs.push({
          pmSlug: m.slug,
          askLevels: hedge.askLevels,
          sources: hedge.sources,
          bestAsk: hedge.bestAsk,
          endDates: hedge.endDates
        });

        if (spotCost === null || hedge.bestAsk === null) {
          spotCost = null;
        } else {
          spotCost += hedge.bestAsk;
        }
      }

      const spotProfit = spotCost === null ? null : payoutPerShare - spotCost;
      const spotEdge =
        spotProfit === null || payoutPerShare <= 0 ? null : spotProfit / payoutPerShare;
      if (spotEdge !== null && spotEdge < minEdge) continue;

      const allowZeroDepth = false;
      const maxAvgCostPerShare = payoutPerShare * (1 - depthEdge);
      const legLevels = [pmBuyNo.noAsks, ...otherLegs.map((l) => l.askLevels)];
      const depth = computeMultiLegDepth(
        legLevels,
        maxAvgCostPerShare,
        allowZeroDepth
      );
      const profit = profitFromDepth(depth.depth, depth.cost, payoutPerShare);
      const roi = roiFromProfit(profit, depth.cost);
      const daysToSettle =
        settleTs !== null ? daysBetween(runTs, settleTs) : null;
      const roiAnnual = annualizedRoi(roi, daysToSettle);

      const buyNoLegs = [
        `polymarket:${pmBuyNo.slug}:NO`,
        ...otherLegs.map((l) => `${l.pmSlug}=>${l.sources.join("|")}:NO`)
      ].join(";");

      const convertYesMarkets = otherLegs.map((l) => l.pmSlug).join("|");

      candidates.push({
        ts: nowIso,
        tier,
        eventSlug: event.eventSlug,
        options: pmBooks.length,
        pmBuyNoMarket: pmBuyNo.slug,
        pmNoAsk: pmBuyNo.bestNoAsk,
        payoutPerShare,
        unitCost: spotCost,
        unitProfit: spotProfit,
        unitEdge: spotEdge,
        depth: depth.depth,
        capital: depth.cost,
        profit,
        roi,
        daysToSettle,
        roiAnnual,
        buyNoLegs,
        convertYesMarkets
      });
    }

    if (!candidates.length) continue;
    candidates.sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));
    rows.push(candidates[0]);
  }

  rows.sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));

  const outLines: string[] = [];
  outLines.push(
    [
      "ts",
      "tier",
      "event_slug",
      "options",
      "pm_buy_no_market",
      "pm_no_ask",
      "payout_per_share",
      "unit_cost",
      "unit_profit",
      "unit_edge",
      "depth_1pct",
      "capital_1pct",
      "profit_1pct",
      "roi_1pct",
      "days_to_settle",
      "roi_1pct_annualized",
      "buy_no_legs",
      "convert_yes_markets"
    ].join(",")
  );

  for (const row of rows) {
    outLines.push(
      [
        row.ts,
        row.tier,
        csvEscape(row.eventSlug),
        row.options.toString(),
        csvEscape(row.pmBuyNoMarket),
        formatNum(row.pmNoAsk),
        row.payoutPerShare.toString(),
        formatNum(row.unitCost),
        formatNum(row.unitProfit),
        formatNum(row.unitEdge),
        formatNum(row.depth),
        formatNum(row.capital),
        formatNum(row.profit),
        formatNum(row.roi),
        formatNum(row.daysToSettle),
        formatNum(row.roiAnnual),
        csvEscape(row.buyNoLegs),
        csvEscape(row.convertYesMarkets)
      ].join(",")
    );
  }

  fs.writeFileSync(outFile, outLines.join("\n"), "utf8");
  console.log(`[NEG_RISK] Wrote ${rows.length} rows to ${outFile}`);
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  ensureDir(dataDir);

  const pmIndex = loadPolymarketIndex(dataDir);

  const highMatchFile = path.join(dataDir, "market_matches_high.csv");
  const reviewMatchFile = path.join(dataDir, "market_matches_review.csv");

  await runTier(
    "high",
    highMatchFile,
    path.join(dataDir, "latest_neg_risk_strategy_high.csv"),
    dataDir,
    pmIndex
  );
  await runTier(
    "review",
    reviewMatchFile,
    path.join(dataDir, "latest_neg_risk_strategy_review.csv"),
    dataDir,
    pmIndex
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
