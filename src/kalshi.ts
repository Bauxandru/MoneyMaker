import { createRateLimitedFetcher } from "./http.js";
import { MarketPairConfig, MarketSnapshot } from "./types.js";
import { numEnv, clamp01 } from "./utils.js";

type AnyRecord = Record<string, unknown>;

const kalRetry = {
  timeoutMs: numEnv("KALSHI_TIMEOUT_MS", 15000),
  maxRetries: numEnv("KALSHI_RETRIES", 5),
  baseDelayMs: numEnv("KALSHI_RETRY_BASE_MS", 500),
  maxDelayMs: numEnv("KALSHI_RETRY_MAX_MS", 8000),
  jitterMs: numEnv("KALSHI_RETRY_JITTER_MS", 200)
};

const kalFetch = createRateLimitedFetcher(numEnv("KALSHI_REQUEST_INTERVAL_MS", 120), kalRetry);

function normalizeDollars(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 1.5) return num / 100;
  return num;
}

function normalizeCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num / 100;
}

function readPrice(obj: AnyRecord, dollarsKey: string, centsKey: string): number | null {
  if (obj[dollarsKey] !== undefined) return normalizeDollars(obj[dollarsKey]);
  if (obj[centsKey] !== undefined) return normalizeCents(obj[centsKey]);
  return null;
}

function parseBidSide(side: unknown): number[] {
  if (!Array.isArray(side)) return [];
  const prices: number[] = [];
  for (const entry of side) {
    let price: number | null = null;
    if (Array.isArray(entry)) {
      price = normalizeCents(entry[0]);
    } else if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      if (obj.price !== undefined) price = normalizeCents(obj.price);
      else if (obj[0] !== undefined) price = normalizeCents(obj[0]);
    } else if (typeof entry === "string" || typeof entry === "number") {
      price = normalizeCents(entry);
    }
    if (price !== null && Number.isFinite(price)) {
      prices.push(price);
    }
  }
  return prices;
}

function bestBid(prices: number[]): number | null {
  if (!prices.length) return null;
  return Math.max(...prices);
}

export async function fetchKalshiSnapshot(
  pair: MarketPairConfig,
  nowIso: string
): Promise<MarketSnapshot> {
  const base = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const ticker = pair.kalshi.ticker;
  const marketRes = await kalFetch<AnyRecord>(`${base}/markets/${ticker}`);
  const market = (marketRes.market as AnyRecord) ?? marketRes;

  let yesBid = readPrice(market, "yes_bid_dollars", "yes_bid");
  let yesAsk = readPrice(market, "yes_ask_dollars", "yes_ask");
  let noBid = readPrice(market, "no_bid_dollars", "no_bid");
  let noAsk = readPrice(market, "no_ask_dollars", "no_ask");

  let orderbook: AnyRecord | null = null;
  if (yesBid === null || noBid === null || yesAsk === null || noAsk === null) {
    const bookRes = await kalFetch<AnyRecord>(`${base}/markets/${ticker}/orderbook`);
    orderbook = (bookRes.orderbook as AnyRecord) ?? bookRes;
    const yesBids = parseBidSide(orderbook.yes);
    const noBids = parseBidSide(orderbook.no);
    yesBid = yesBid ?? bestBid(yesBids);
    noBid = noBid ?? bestBid(noBids);
    if (yesAsk === null && noBid !== null) yesAsk = clamp01(1 - noBid);
    if (noAsk === null && yesBid !== null) noAsk = clamp01(1 - yesBid);
  }

  yesBid = clamp01(yesBid);
  yesAsk = clamp01(yesAsk);
  noBid = clamp01(noBid);
  noAsk = clamp01(noAsk);

  const marketId = String(market.ticker ?? ticker);
  const marketTitle = String(market.title ?? market.subtitle ?? marketId);
  const outcomeLabel = pair.kalshi.side === "YES" ? "YES" : "NO";

  return {
    ts: nowIso,
    exchange: "kalshi",
    marketId,
    marketTitle,
    outcomeLabel,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    rawJson: JSON.stringify({ market, orderbook })
  };
}
