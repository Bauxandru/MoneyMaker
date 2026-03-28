import { createRateLimitedFetcher } from "./http.js";
import { MarketPairConfig, MarketSnapshot } from "./types.js";
import { numEnv, clamp01 } from "./utils.js";

type AnyRecord = Record<string, unknown>;

const polyRetry = {
  timeoutMs: numEnv("POLY_TIMEOUT_MS", 15000),
  maxRetries: numEnv("POLY_RETRIES", 5),
  baseDelayMs: numEnv("POLY_RETRY_BASE_MS", 600),
  maxDelayMs: numEnv("POLY_RETRY_MAX_MS", 8000),
  jitterMs: numEnv("POLY_RETRY_JITTER_MS", 250)
};

const polyFetch = createRateLimitedFetcher(numEnv("POLY_REQUEST_INTERVAL_MS", 200), polyRetry);

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v));
      }
    } catch {
      // fall through
    }
    return [trimmed];
  }
  return [];
}

function normalizeLabel(value: string) {
  return value.trim().toLowerCase();
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
    if (price !== null && Number.isFinite(price)) {
      prices.push(price);
    }
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



async function fetchBook(clobBase: string, tokenId: string) {
  return polyFetch<AnyRecord>(
    `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
  );
}

export async function fetchPolymarketSnapshot(
  pair: MarketPairConfig,
  nowIso: string
): Promise<MarketSnapshot> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

  const pm = pair.polymarket;
  let market: AnyRecord | null = null;
  let event: AnyRecord | null = null;

  if (pm.marketSlug) {
    const res = await polyFetch<AnyRecord>(
      `${gammaBase}/markets/slug/${pm.marketSlug}`
    );
    market = (res.market as AnyRecord) ?? res;
  } else if (pm.eventSlug) {
    const res = await polyFetch<AnyRecord>(
      `${gammaBase}/events/slug/${pm.eventSlug}`
    );
    event = (res.event as AnyRecord) ?? res;
    const markets = (event?.markets as AnyRecord[]) ?? [];
    if (!markets.length) {
      throw new Error(`Polymarket event ${pm.eventSlug} returned no markets.`);
    }
    const outcomeLabel = pm.outcomeLabel ? normalizeLabel(pm.outcomeLabel) : null;
    if (outcomeLabel) {
      market =
        markets.find((m) =>
          parseArray(m.outcomes).some((o) => normalizeLabel(o) === outcomeLabel)
        ) ?? null;
    }
    if (!market && pm.outcomeIndex != null && pm.outcomeIndex >= 0) {
      market = markets[pm.outcomeIndex] ?? null;
    }
    if (!market && markets.length === 1) {
      market = markets[0];
    }
  } else {
    throw new Error("Polymarket config requires eventSlug or marketSlug.");
  }

  if (!market) {
    const available = event?.markets
      ? (event.markets as AnyRecord[])
          .flatMap((m) => parseArray(m.outcomes))
          .filter(Boolean)
      : [];
    throw new Error(
      `Polymarket market not found for outcome "${pm.outcomeLabel}". Outcomes: ${available.join(", ")}`
    );
  }

  const outcomes = parseArray(market.outcomes);
  const tokenIds = parseArray(market.clobTokenIds);
  const negRisk = Boolean(market.negRisk);
  const marketId = String(market.id ?? market.marketId ?? tokenIds[0] ?? "");
  const marketTitle = String(market.question ?? market.title ?? market.name ?? marketId);

  const normalizedOutcomes = outcomes.map(normalizeLabel);
  const yesIndex = normalizedOutcomes.indexOf("yes");
  const noIndex = normalizedOutcomes.indexOf("no");

  let outcomeIndex = pm.outcomeIndex ?? null;
  if (outcomeIndex == null && pm.outcomeLabel) {
    const target = normalizeLabel(pm.outcomeLabel);
    const idx = normalizedOutcomes.findIndex((o) => o === target);
    if (idx >= 0) outcomeIndex = idx;
  }
  if (outcomeIndex == null) {
    outcomeIndex = 0;
  }

  const outcomeLabel = outcomes[outcomeIndex] ?? pm.outcomeLabel ?? "Outcome";
  const tokenId = pm.tokenId || tokenIds[outcomeIndex];

  if (!tokenId) {
    throw new Error(`Missing Polymarket tokenId for outcome "${outcomeLabel}".`);
  }

  let yesBid: number | null = null;
  let yesAsk: number | null = null;
  let noBid: number | null = null;
  let noAsk: number | null = null;
  let book: AnyRecord | null = null;

  if (yesIndex >= 0 && noIndex >= 0 && tokenIds[yesIndex] && tokenIds[noIndex]) {
    const [yesBook, noBook] = await Promise.all([
      fetchBook(clobBase, tokenIds[yesIndex]),
      fetchBook(clobBase, tokenIds[noIndex])
    ]);
    book = { yes: yesBook, no: noBook };

    const yesBids = parseBookSide(yesBook.bids);
    const yesAsks = parseBookSide(yesBook.asks);
    const noBids = parseBookSide(noBook.bids);
    const noAsks = parseBookSide(noBook.asks);

    yesBid = clamp01(pickBestBid(yesBids));
    yesAsk = clamp01(pickBestAsk(yesAsks));
    noBid = clamp01(pickBestBid(noBids));
    noAsk = clamp01(pickBestAsk(noAsks));
  } else {
    book = await fetchBook(clobBase, tokenId);
    const bids = parseBookSide(book.bids);
    const asks = parseBookSide(book.asks);
    yesBid = clamp01(pickBestBid(bids));
    yesAsk = clamp01(pickBestAsk(asks));

    if (!negRisk) {
      if (yesAsk !== null) noBid = clamp01(1 - yesAsk);
      if (yesBid !== null) noAsk = clamp01(1 - yesBid);
    }
  }

  return {
    ts: nowIso,
    exchange: "polymarket",
    marketId: String(tokenId),
    marketTitle,
    outcomeLabel: String(outcomeLabel),
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    rawJson: JSON.stringify({ event, market, book })
  };
}
