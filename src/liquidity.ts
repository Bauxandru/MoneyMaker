import { fetchJson } from "./http.js";

type AnyRecord = Record<string, unknown>;

type PriceLevel = {
  price: number;
  size: number;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parsePolymarketLevels(side: unknown): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const price = toNumber(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null) out.push({ price, size });
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      const price = toNumber(obj.price ?? obj[0]);
      const size = toNumber(obj.size ?? obj[1]);
      if (price !== null && size !== null) out.push({ price, size });
    }
  }
  return out;
}

function parseKalshiLevels(side: unknown): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const price = toNumber(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null) out.push({ price, size });
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as AnyRecord;
      const price = toNumber(obj.price ?? obj[0]);
      const size = toNumber(obj.quantity ?? obj.size ?? obj[1]);
      if (price !== null && size !== null) out.push({ price, size });
    }
  }
  return out;
}

export async function getPolymarketAskLiquidity(
  tokenId: string,
  limitPrice: number
): Promise<number> {
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const book = await fetchJson<AnyRecord>(
    `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
  );
  const asks = parsePolymarketLevels(book.asks);
  let total = 0;
  for (const level of asks) {
    if (level.price <= limitPrice) total += level.size;
  }
  return total;
}

export async function getKalshiImpliedAskLiquidity(
  ticker: string,
  side: "yes" | "no",
  limitPrice: number
): Promise<number> {
  const base = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const bookRes = await fetchJson<AnyRecord>(`${base}/markets/${ticker}/orderbook`);
  const orderbook = (bookRes.orderbook as AnyRecord) ?? bookRes;
  const bids = side === "yes" ? orderbook.no : orderbook.yes;
  const levels = parseKalshiLevels(bids);
  const thresholdCents = Math.round((1 - limitPrice) * 100);
  let total = 0;
  for (const level of levels) {
    if (level.price >= thresholdCents) total += level.size;
  }
  return total;
}
