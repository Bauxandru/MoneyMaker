import { fetchJsonWithRetry } from "./http.js";
import { MarketPairConfig, MarketSnapshot } from "./types.js";

type AnyRecord = Record<string, unknown>;

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v));
      }
    } catch {
      // ignore
    }
    return [trimmed];
  }
  return [];
}

function parseBookSide(side: unknown): number[] {
  if (!Array.isArray(side)) return [];
  const prices: number[] = [];
  for (const entry of side) {
    let price: number | null = null;
    if (Array.isArray(entry)) {
      price = Number(entry[0]);
    } else if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      if (obj.price !== undefined) price = Number(obj.price);
      else if (obj[0] !== undefined) price = Number(obj[0]);
    } else if (typeof entry === "string" || typeof entry === "number") {
      price = Number(entry);
    }
    if (price !== null && Number.isFinite(price)) prices.push(price);
  }
  return prices;
}

function pickBestBid(prices: number[]): number | null {
  if (!prices.length) return null;
  return Math.max(...prices);
}

function pickBestAsk(prices: number[]): number | null {
  if (!prices.length) return null;
  return Math.min(...prices);
}

function clamp01(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(1, Math.max(0, value));
}

async function fetchBook(bookBase: string, tokenId: string) {
  return fetchJsonWithRetry<AnyRecord>(
    `${bookBase}/public/api/v1/book?token_id=${encodeURIComponent(tokenId)}`,
    {},
    {
      timeoutMs: envNumber("PROB_TIMEOUT_MS", 15000),
      maxRetries: envNumber("PROB_RETRIES", 4),
      baseDelayMs: envNumber("PROB_RETRY_BASE_MS", 600),
      maxDelayMs: envNumber("PROB_RETRY_MAX_MS", 8000),
      jitterMs: envNumber("PROB_RETRY_JITTER_MS", 250)
    }
  );
}

export async function fetchProbableSnapshot(
  pair: MarketPairConfig,
  nowIso: string
): Promise<MarketSnapshot> {
  const marketBase =
    process.env.PROB_MARKET_BASE ?? "https://market-api.probable.markets";
  const bookBase = process.env.PROB_ORDERBOOK_BASE ?? "https://api.probable.markets";

  const marketSlug = pair.probable?.marketSlug ?? pair.polymarket.marketSlug;
  if (!marketSlug) {
    throw new Error("Probable config requires market slug.");
  }

  const marketRes = await fetchJsonWithRetry<AnyRecord>(
    `${marketBase}/public/api/v1/markets/?market_slug=${encodeURIComponent(marketSlug)}`,
    {},
    {
      timeoutMs: envNumber("PROB_TIMEOUT_MS", 15000),
      maxRetries: envNumber("PROB_RETRIES", 4),
      baseDelayMs: envNumber("PROB_RETRY_BASE_MS", 600),
      maxDelayMs: envNumber("PROB_RETRY_MAX_MS", 8000),
      jitterMs: envNumber("PROB_RETRY_JITTER_MS", 250)
    }
  );

  const market =
    Array.isArray(marketRes.markets) && marketRes.markets.length
      ? (marketRes.markets[0] as AnyRecord)
      : Array.isArray(marketRes.results) && marketRes.results.length
        ? (marketRes.results[0] as AnyRecord)
        : (marketRes as AnyRecord);

  const outcomes = parseArray(market.outcomes ?? market.outcomeTokens);
  const tokenIds = parseArray(market.clobTokenIds ?? market.clob_token_ids);
  const marketTitle = String(market.question ?? market.title ?? marketSlug);

  const yesIndex = outcomes.findIndex((o) => o.toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((o) => o.toLowerCase() === "no");
  const yesToken = tokenIds[yesIndex];
  const noToken = tokenIds[noIndex];
  if (!yesToken || !noToken) {
    throw new Error(`Probable missing yes/no tokens for ${marketSlug}`);
  }

  const [yesBook, noBook] = await Promise.all([
    fetchBook(bookBase, yesToken),
    fetchBook(bookBase, noToken)
  ]);

  const yesBids = parseBookSide(yesBook.bids);
  const yesAsks = parseBookSide(yesBook.asks);
  const noBids = parseBookSide(noBook.bids);
  const noAsks = parseBookSide(noBook.asks);

  const yesBid = clamp01(pickBestBid(yesBids));
  const yesAsk = clamp01(pickBestAsk(yesAsks));
  const noBid = clamp01(pickBestBid(noBids));
  const noAsk = clamp01(pickBestAsk(noAsks));

  return {
    ts: nowIso,
    exchange: "probable",
    marketId: marketSlug,
    marketTitle,
    outcomeLabel: "Yes/No",
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    rawJson: JSON.stringify({ market, yesBook, noBook })
  };
}
