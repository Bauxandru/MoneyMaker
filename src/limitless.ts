import { fetchJson } from "./http.js";
import { MarketSnapshot } from "./types.js";
import { sleep, numEnv, clamp01 } from "./utils.js";

type AnyRecord = Record<string, unknown>;

type LimitlessMarket = {
  id?: number;
  slug?: string;
  title?: string;
  proxyTitle?: string | null;
  description?: string;
  expirationDate?: string;
  expirationTimestamp?: number;
  tradeType?: string;
  prices?: unknown;
  tradePrices?: unknown;
  collateralToken?: { decimals?: number };
};

type LimitlessOrderbook = {
  bids?: unknown;
  asks?: unknown;
  tokenId?: string;
};

const DEFAULT_BASE = "https://api.limitless.exchange";
let cachedBase: string | null = null;
let limitlessQueue: Promise<void> = Promise.resolve();
let lastLimitlessAt = 0;


function normalizeBaseUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function buildBaseCandidates(raw: string) {
  const base = normalizeBaseUrl(raw);
  const candidates: string[] = [];
  if (base.endsWith("/api-v1")) {
    candidates.push(base.replace(/\/api-v1$/, ""));
    candidates.push(base);
  } else {
    candidates.push(base);
    candidates.push(`${base}/api-v1`);
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

async function scheduleLimitless<T>(fn: () => Promise<T>): Promise<T> {
  const minInterval = Math.max(0, numEnv("LIMITLESS_REQUEST_INTERVAL_MS", 300));
  const run = async () => {
    const now = Date.now();
    const wait = Math.max(0, lastLimitlessAt + minInterval - now);
    if (wait > 0) await sleep(wait);
    lastLimitlessAt = Date.now();
    return fn();
  };
  const task = limitlessQueue.then(run, run);
  limitlessQueue = task.then(() => {}, () => {});
  return task;
}

function isRetryableError(err: unknown) {
  const message = (err as Error)?.message ?? String(err);
  const lower = message.toLowerCase();
  if (
    lower.includes("http 429") ||
    lower.includes("too many requests") ||
    lower.includes("http 503") ||
    lower.includes("http 502") ||
    lower.includes("http 500") ||
    lower.includes("access denied") ||
    lower.includes("cloudflare") ||
    lower.includes("error 1015")
  ) {
    return true;
  }
  return false;
}

async function fetchLimitlessJson<T>(path: string): Promise<T> {
  const baseRaw = process.env.LIMITLESS_BASE_URL ?? DEFAULT_BASE;
  const candidates = buildBaseCandidates(baseRaw);
  const ordered = cachedBase
    ? [cachedBase, ...candidates.filter((b) => b !== cachedBase)]
    : candidates;
  let lastErr: unknown;
  const urlPath = path.startsWith("/") ? path : `/${path}`;
  const maxRetries = Math.max(0, numEnv("LIMITLESS_RETRIES", 6));
  const retryBase = Math.max(50, numEnv("LIMITLESS_RETRY_BASE_MS", 800));
  const retryMax = Math.max(retryBase, numEnv("LIMITLESS_RETRY_MAX_MS", 10000));
  const jitter = Math.max(0, numEnv("LIMITLESS_RETRY_JITTER_MS", 250));

  for (const base of ordered) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const res = await scheduleLimitless(() =>
          fetchJson<T>(`${base}${urlPath}`)
        );
        cachedBase = base;
        return res;
      } catch (err) {
        lastErr = err;
        if (!isRetryableError(err) || attempt >= maxRetries) break;
        const delay = Math.min(retryMax, retryBase * Math.pow(2, attempt));
        await sleep(delay + Math.floor(Math.random() * jitter));
      }
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("Limitless fetch failed.");
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePriceList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => toNumber(v))
    .filter((v): v is number => v !== null);
}

function pickBestBid(prices: number[]): number | null {
  if (!prices.length) return null;
  return Math.max(...prices);
}

function pickBestAsk(prices: number[]): number | null {
  if (!prices.length) return null;
  return Math.min(...prices);
}



function normalizePrice(value: number | null): number | null {
  if (value === null) return null;
  const adjusted = value > 1.5 ? value / 100 : value;
  return clamp01(adjusted);
}

function parseOrderbookPrices(side: unknown): number[] {
  if (!Array.isArray(side)) return [];
  const out: number[] = [];
  for (const entry of side) {
    if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      const price = normalizePrice(toNumber(obj.price ?? obj[0]));
      if (price !== null) out.push(price);
    } else {
      const price = normalizePrice(toNumber(entry));
      if (price !== null) out.push(price);
    }
  }
  return out;
}

function extractTradePrices(market: LimitlessMarket) {
  const tradePrices = market.tradePrices as AnyRecord | undefined;
  const buy = tradePrices?.buy as AnyRecord | undefined;
  const sell = tradePrices?.sell as AnyRecord | undefined;
  const buyMarket = parsePriceList(buy?.market);
  const sellMarket = parsePriceList(sell?.market);
  const prices = parsePriceList(market.prices);

  const yesAsk = normalizePrice(buyMarket[0] ?? prices[0] ?? null);
  const noAsk = normalizePrice(buyMarket[1] ?? prices[1] ?? null);
  const yesBid = normalizePrice(sellMarket[0] ?? prices[0] ?? null);
  const noBid = normalizePrice(sellMarket[1] ?? prices[1] ?? null);

  return {
    yesAsk,
    noAsk,
    yesBid,
    noBid
  };
}

export async function fetchLimitlessSnapshot(
  marketSlug: string,
  nowIso: string
): Promise<MarketSnapshot> {
  const marketRes = await fetchLimitlessJson<AnyRecord>(`/markets/${marketSlug}`);
  const market = (marketRes.market as LimitlessMarket) ?? (marketRes as LimitlessMarket);

  let orderbook: LimitlessOrderbook | null = null;
  let yesBid: number | null = null;
  let yesAsk: number | null = null;
  let noBid: number | null = null;
  let noAsk: number | null = null;

  const tradeType = market.tradeType ?? "";
  const shouldTryBook =
    tradeType === "clob" || tradeType === "amm" || tradeType === "";

  if (shouldTryBook) {
    try {
      orderbook = await fetchLimitlessJson<LimitlessOrderbook>(
        `/markets/${marketSlug}/orderbook`
      );
      const bids = parseOrderbookPrices(orderbook.bids);
      const asks = parseOrderbookPrices(orderbook.asks);
      yesBid = clamp01(pickBestBid(bids));
      yesAsk = clamp01(pickBestAsk(asks));
      if (yesAsk !== null) noBid = clamp01(1 - yesAsk);
      if (yesBid !== null) noAsk = clamp01(1 - yesBid);
    } catch {
      orderbook = null;
    }
  }

  if (yesBid === null && yesAsk === null && noBid === null && noAsk === null) {
    const trade = extractTradePrices(market);
    yesBid = trade.yesBid;
    yesAsk = trade.yesAsk;
    noBid = trade.noBid;
    noAsk = trade.noAsk;
    if (noBid === null && yesAsk !== null) noBid = clamp01(1 - yesAsk);
    if (noAsk === null && yesBid !== null) noAsk = clamp01(1 - yesBid);
  }

  return {
    ts: nowIso,
    exchange: "limitless",
    marketId: market.slug ?? String(market.id ?? marketSlug),
    marketTitle: String(market.title ?? market.proxyTitle ?? market.slug ?? marketSlug),
    outcomeLabel: "Yes",
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    rawJson: JSON.stringify({ market, orderbook })
  };
}
