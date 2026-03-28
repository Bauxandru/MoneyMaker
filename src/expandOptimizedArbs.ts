import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fetchKalshiSnapshot } from "./kalshi.js";
import { fetchLimitlessSnapshot } from "./limitless.js";
import { fetchPolymarketSnapshot } from "./polymarket.js";
import { fetchProbableSnapshot } from "./probable.js";
import { Exchange, MarketPairConfig, MarketSnapshot } from "./types.js";

dotenv.config();

type PriceLevel = {
  price: number;
  size: number;
  exchange: Exchange;
  id: string;
};

type LegRef = {
  exchange: Exchange;
  id: string;
};

type LegBook = {
  leg: LegRef;
  yesAsks: PriceLevel[];
  noAsks: PriceLevel[];
  hasBook: boolean;
  endDate?: string;
};

function parseCsv(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf8");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const finishRow = () => {
    if (!row.length) return;
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\"") {
      if (inQuotes && raw[i + 1] === "\"") {
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
      if (ch === "\r" && raw[i + 1] === "\n") i += 1;
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    pushField();
    finishRow();
  }
  return rows;
}

function parseLegs(value: string): LegRef[] {
  if (!value) return [];
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [exchangeRaw, ...rest] = part.split(":");
      return {
        exchange: exchangeRaw as Exchange,
        id: rest.join(":")
      };
    });
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sortLevels(levels: PriceLevel[]) {
  return levels.sort((a, b) => a.price - b.price);
}

function parsePolymarketLevels(
  side: unknown,
  exchange: Exchange,
  id: string
): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const price = toNumber(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size, exchange, id });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const price = toNumber(obj.price ?? obj[0]);
      const size = toNumber(obj.size ?? obj[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size, exchange, id });
      }
    }
  }
  return out;
}

function parseLimitlessLevels(
  side: unknown,
  scale: number,
  exchange: Exchange,
  id: string
): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (!Array.isArray(entry)) continue;
    const price = toNumber(entry[0]);
    const size = toNumber(entry[1]);
    if (price === null || size === null || size <= 0) continue;
    out.push({ price: price / scale, size, exchange, id });
  }
  return out;
}

function impliedAsksFromBids(levels: PriceLevel[]): PriceLevel[] {
  return levels
    .map((level) => ({
      price: 1 - level.price,
      size: level.size,
      exchange: level.exchange,
      id: level.id
    }))
    .filter((level) => level.price >= 0 && level.price <= 1);
}

function normalizeKalshiPriceCents(value: unknown): number | null {
  const raw = toNumber(value);
  if (raw === null) return null;
  if (raw > 1.5) return raw / 100;
  return raw;
}

function kalshiImpliedAskLevels(
  orderbook: Record<string, unknown>,
  outcome: "yes" | "no",
  exchange: Exchange,
  id: string
): PriceLevel[] {
  const sideKey = outcome === "yes" ? "yes" : "no";
  const bids = orderbook.bids as Record<string, unknown> | undefined;
  const asks = orderbook.asks as Record<string, unknown> | undefined;
  const levels: PriceLevel[] = [];

  const rawAsks = asks?.[sideKey];
  if (Array.isArray(rawAsks)) {
    for (const entry of rawAsks) {
      if (!Array.isArray(entry)) continue;
      const price = normalizeKalshiPriceCents(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null && size > 0) {
        levels.push({ price, size, exchange, id });
      }
    }
  }

  const rawBids = bids?.[sideKey];
  if (Array.isArray(rawBids) && rawBids.length) {
    const bidLevels: PriceLevel[] = [];
    for (const entry of rawBids) {
      if (!Array.isArray(entry)) continue;
      const price = normalizeKalshiPriceCents(entry[0]);
      const size = toNumber(entry[1]);
      if (price !== null && size !== null && size > 0) {
        bidLevels.push({ price, size, exchange, id });
      }
    }
    levels.push(...impliedAsksFromBids(bidLevels));
  }

  return sortLevels(levels);
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
  leg: LegRef,
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

function extractPolymarketBooks(
  snapshot: MarketSnapshot,
  exchange: Exchange,
  id: string
) {
  let yesAsks: PriceLevel[] = [];
  let noAsks: PriceLevel[] = [];
  let hasBook = false;
  try {
    const raw = JSON.parse(snapshot.rawJson) as Record<string, unknown>;
    const book = raw.book as Record<string, unknown> | undefined;
    if (book?.yes || book?.no) {
      hasBook = true;
      const yesBook = book.yes as Record<string, unknown> | undefined;
      const noBook = book.no as Record<string, unknown> | undefined;
      yesAsks = parsePolymarketLevels(yesBook?.asks, exchange, id);
      noAsks = parsePolymarketLevels(noBook?.asks, exchange, id);
    }
  } catch {
    // ignore
  }
  return { yesAsks: sortLevels(yesAsks), noAsks: sortLevels(noAsks), hasBook };
}

function extractLimitlessBooks(snapshot: MarketSnapshot, id: string) {
  let yesAsks: PriceLevel[] = [];
  let noAsks: PriceLevel[] = [];
  let hasBook = false;
  try {
    const raw = JSON.parse(snapshot.rawJson) as Record<string, unknown>;
    const orderbook = raw.orderbook as Record<string, unknown> | undefined;
    const market = raw.market as Record<string, unknown> | undefined;
    const decimalsRaw = (market?.collateralToken as Record<string, unknown> | undefined)
      ?.decimals;
    const decimals = toNumber(decimalsRaw) ?? 6;
    const scale = decimals > 0 ? Math.pow(10, decimals) : 1;
    if (orderbook) {
      hasBook = true;
      const yesBids = parseLimitlessLevels(
        orderbook.bids ?? orderbook.yesBids ?? orderbook.yes_bids,
        scale,
        "limitless",
        id
      );
      const yesAsksRaw = parseLimitlessLevels(
        orderbook.asks ?? orderbook.yesAsks ?? orderbook.yes_asks,
        scale,
        "limitless",
        id
      );
      const noBids = parseLimitlessLevels(
        orderbook.noBids ?? orderbook.no_bids,
        scale,
        "limitless",
        id
      );
      const noAsksRaw = parseLimitlessLevels(
        orderbook.noAsks ?? orderbook.no_asks,
        scale,
        "limitless",
        id
      );
      yesAsks = yesAsksRaw.length ? yesAsksRaw : impliedAsksFromBids(yesBids);
      noAsks = noAsksRaw.length ? noAsksRaw : impliedAsksFromBids(noBids);
    }
  } catch {
    // ignore
  }
  return { yesAsks: sortLevels(yesAsks), noAsks: sortLevels(noAsks), hasBook };
}

function extractProbableBooks(snapshot: MarketSnapshot, id: string) {
  let yesAsks: PriceLevel[] = [];
  let noAsks: PriceLevel[] = [];
  let hasBook = false;
  try {
    const raw = JSON.parse(snapshot.rawJson) as Record<string, unknown>;
    const yesBook = raw.yesBook as Record<string, unknown> | undefined;
    const noBook = raw.noBook as Record<string, unknown> | undefined;
    if (yesBook || noBook) {
      hasBook = true;
      yesAsks = parsePolymarketLevels(yesBook?.asks, "probable", id);
      noAsks = parsePolymarketLevels(noBook?.asks, "probable", id);
    }
  } catch {
    // ignore
  }
  return { yesAsks: sortLevels(yesAsks), noAsks: sortLevels(noAsks), hasBook };
}

function mergeLevels(levels: PriceLevel[]) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  return sorted;
}

async function fetchLegBooks(legs: LegRef[], nowIso: string) {
  const books: LegBook[] = [];
  for (const leg of legs) {
    const snapshot = await fetchSnapshotForLeg(leg, nowIso);
    if (leg.exchange === "polymarket") {
      const book = extractPolymarketBooks(snapshot, leg.exchange, leg.id);
      books.push({ leg, ...book });
    } else if (leg.exchange === "kalshi") {
      const orderbook = JSON.parse(snapshot.rawJson) as Record<string, unknown>;
      const yesAsks = kalshiImpliedAskLevels(orderbook, "yes", "kalshi", leg.id);
      const noAsks = kalshiImpliedAskLevels(orderbook, "no", "kalshi", leg.id);
      books.push({ leg, yesAsks, noAsks, hasBook: true });
    } else if (leg.exchange === "probable") {
      const book = extractProbableBooks(snapshot, leg.id);
      books.push({ leg, ...book });
    } else {
      const book = extractLimitlessBooks(snapshot, leg.id);
      books.push({ leg, ...book });
    }
  }
  return books;
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  const filePath = path.join(dataDir, "latest_arbs_high.csv");
  const rows = parseCsv(filePath);
  const header = rows[0];
  const dirIdx = header.indexOf("direction");
  const pairIdx = header.indexOf("pair_id");
  const yesIdx = header.indexOf("yes_legs");
  const noIdx = header.indexOf("no_legs");
  if (dirIdx < 0 || pairIdx < 0 || yesIdx < 0 || noIdx < 0) {
    throw new Error("Missing required columns in latest_arbs_high.csv");
  }

  const nowIso = new Date().toISOString();
  const outLines: string[] = [];
  outLines.push(
    [
      "pair_id",
      "step",
      "yes_exchange",
      "yes_id",
      "yes_price",
      "no_exchange",
      "no_id",
      "no_price",
      "size",
      "unit_cost",
      "unit_edge",
      "cum_depth",
      "cum_cost",
      "cum_profit"
    ].join(",")
  );

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row.length) continue;
    if (row[pairIdx] === "TOTAL") continue;
    if (row[dirIdx] !== "OPT_YES_NO") continue;

    const pairId = row[pairIdx];
    const yesLegs = parseLegs(row[yesIdx]);
    const noLegs = parseLegs(row[noIdx]);
    const legs = [...yesLegs, ...noLegs];
    const books = await fetchLegBooks(legs, nowIso);
    const yesLevels = mergeLevels(books.flatMap((b) => b.yesAsks));
    const noLevels = mergeLevels(books.flatMap((b) => b.noAsks));
    if (!yesLevels.length || !noLevels.length) continue;

    let iYes = 0;
    let iNo = 0;
    let yesRemaining = yesLevels[0].size;
    let noRemaining = noLevels[0].size;
    let cumDepth = 0;
    let cumCost = 0;
    let step = 1;
    const maxCost = 0.99;

    while (iYes < yesLevels.length && iNo < noLevels.length) {
      const yes = yesLevels[iYes];
      const no = noLevels[iNo];
      const take = Math.min(yesRemaining, noRemaining);
      const unitCost = yes.price + no.price;
      if (unitCost > maxCost) break;

      const size = take;
      const stepCost = unitCost * size;
      const stepProfit = size - stepCost;
      cumDepth += size;
      cumCost += stepCost;

      outLines.push(
        [
          pairId,
          step,
          yes.exchange,
          yes.id,
          yes.price.toFixed(4),
          no.exchange,
          no.id,
          no.price.toFixed(4),
          size.toFixed(4),
          unitCost.toFixed(4),
          (1 - unitCost).toFixed(4),
          cumDepth.toFixed(4),
          cumCost.toFixed(4),
          (cumDepth - cumCost).toFixed(4)
        ].join(",")
      );

      step += 1;
      yesRemaining -= take;
      noRemaining -= take;
      if (yesRemaining <= 0) {
        iYes += 1;
        if (iYes >= yesLevels.length) break;
        yesRemaining = yesLevels[iYes].size;
      }
      if (noRemaining <= 0) {
        iNo += 1;
        if (iNo >= noLevels.length) break;
        noRemaining = noLevels[iNo].size;
      }
    }
  }

  const outPath = path.join(dataDir, "opt_steps.csv");
  fs.writeFileSync(outPath, `${outLines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${outLines.length - 1} steps to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
