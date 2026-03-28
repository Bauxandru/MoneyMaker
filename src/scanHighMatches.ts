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

type MatchPair = {
  id: string;
  groupId: string;
  baseExchange: Exchange;
  baseId: string;
  left: PairLeg;
  right: PairLeg;
};

type LegBook = {
  exchange: Exchange;
  id: string;
  endDate?: string;
  title?: string;
  yesAsks: PriceLevel[];
  noAsks: PriceLevel[];
  hasBook: boolean;
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

function buildComponents(pairs: MatchPair[]) {
  const graph = new Map<string, Set<string>>();
  const legByKey = new Map<string, PairLeg>();

  const addEdge = (a: PairLeg, b: PairLeg) => {
    const keyA = `${a.exchange}:${a.id}`;
    const keyB = `${b.exchange}:${b.id}`;
    if (!graph.has(keyA)) graph.set(keyA, new Set());
    if (!graph.has(keyB)) graph.set(keyB, new Set());
    graph.get(keyA)!.add(keyB);
    graph.get(keyB)!.add(keyA);
    legByKey.set(keyA, a);
    legByKey.set(keyB, b);
  };

  for (const pair of pairs) {
    addEdge(pair.left, pair.right);
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const key of graph.keys()) {
    if (visited.has(key)) continue;
    const stack = [key];
    const group: string[] = [];
    visited.add(key);
    while (stack.length) {
      const current = stack.pop()!;
      group.push(current);
      for (const next of graph.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(group);
  }

  return { components, legByKey };
}

const EXCHANGE_LABEL: Record<Exchange, string> = {
  polymarket: "PM",
  kalshi: "KAL",
  limitless: "LIM",
  probable: "PROB"
};

function exchangeLabel(exchange: Exchange) {
  return EXCHANGE_LABEL[exchange] ?? exchange.toUpperCase();
}

function formatNum(value: number | null) {
  return value === null ? "" : value.toFixed(4);
}

function csvEscape(value: string) {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
    return `"${value.replace(/\"/g, "\"\"")}"`;
  }
  return value;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  const data = line.endsWith("\r") ? line.slice(0, -1) : line;

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
      out.push(field);
      field = "";
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

type ArbBlock = {
  daysToSettle: number | null;
  edge: number | null;
  pairId: string;
  lines: string[];
};

function sortArbRowsByTimeLeft(arbRows: string[]) {
  if (arbRows.length <= 2) return [...arbRows];

  const header = parseCsvLine(arbRows[0] ?? "");
  const tsIdx = header.indexOf("ts");
  const daysIdx = header.indexOf("days_to_settle");
  const dirIdx = header.indexOf("direction");
  const pairIdx = header.indexOf("pair_id");
  const edgeIdx = header.indexOf("edge");
  if (daysIdx < 0 || dirIdx < 0 || pairIdx < 0) return [...arbRows];

  let totalLine: string | null = null;
  const blocks: ArbBlock[] = [];

  for (let i = 1; i < arbRows.length; i += 1) {
    const line = arbRows[i];
    if (!line) continue;
    const fields = parseCsvLine(line);
    const ts = tsIdx >= 0 ? (fields[tsIdx] ?? "") : "";
    const pairId = fields[pairIdx] ?? "";
    if (ts === "TOTAL" || pairId === "TOTAL") {
      totalLine = line;
      continue;
    }
    const direction = fields[dirIdx] ?? "";
    const daysToSettle = toNumber(fields[daysIdx] ?? "");
    const edge = edgeIdx >= 0 ? toNumber(fields[edgeIdx] ?? "") : null;

    if (direction === "GROUPED") {
      const groupLines = [line];
      let j = i + 1;
      while (j < arbRows.length) {
        const nextLine = arbRows[j];
        if (!nextLine) {
          j += 1;
          continue;
        }
        const nextFields = parseCsvLine(nextLine);
        const nextPair = nextFields[pairIdx] ?? "";
        const nextDir = nextFields[dirIdx] ?? "";
        if (nextPair === pairId && nextDir.startsWith("STEP_")) {
          groupLines.push(nextLine);
          j += 1;
          continue;
        }
        break;
      }

      blocks.push({ daysToSettle, edge, pairId, lines: groupLines });
      i = j - 1;
      continue;
    }

    blocks.push({ daysToSettle, edge, pairId, lines: [line] });
  }

  blocks.sort((a, b) => {
    if (a.daysToSettle === null && b.daysToSettle !== null) return 1;
    if (a.daysToSettle !== null && b.daysToSettle === null) return -1;
    if (a.daysToSettle !== null && b.daysToSettle !== null) {
      const diff = a.daysToSettle - b.daysToSettle;
      if (Math.abs(diff) > 1e-12) return diff;
    }

    if (a.edge === null && b.edge !== null) return 1;
    if (a.edge !== null && b.edge === null) return -1;
    if (a.edge !== null && b.edge !== null) {
      const diff = b.edge - a.edge;
      if (Math.abs(diff) > 1e-12) return diff;
    }

    return a.pairId.localeCompare(b.pairId);
  });

  const sorted: string[] = [];
  sorted.push(arbRows[0]);
  for (const block of blocks) {
    sorted.push(...block.lines);
  }
  if (totalLine) sorted.push(totalLine);
  return sorted;
}

function medalCategory(title: string): "gold" | "silver" | "bronze" | "all" | null {
  const normalized = title.toLowerCase();
  if (!normalized.includes("medal")) return null;
  if (normalized.includes("gold")) return "gold";
  if (normalized.includes("silver")) return "silver";
  if (normalized.includes("bronze")) return "bronze";
  return "all";
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

function mergePriceLevels(levels: PriceLevel[]): PriceLevel[] {
  if (!levels.length) return [];
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const merged: PriceLevel[] = [];
  for (const level of sorted) {
    if (!merged.length || merged[merged.length - 1].price !== level.price) {
      merged.push({ price: level.price, size: level.size });
    } else {
      merged[merged.length - 1].size += level.size;
    }
  }
  return merged;
}

function computeOptimizedDepth(
  yesLevels: PriceLevel[],
  noLevels: PriceLevel[],
  maxCost: number,
  allowZeroDepth: boolean
) {
  const yes = mergePriceLevels(yesLevels);
  const no = mergePriceLevels(noLevels);
  if (!yes.length || !no.length) {
    return allowZeroDepth ? { depth: 0, cost: 0 } : { depth: null, cost: null };
  }

  let i = 0;
  let j = 0;
  let yesRemaining = yes[0].size;
  let noRemaining = no[0].size;
  let depth = 0;
  let cost = 0;

  while (i < yes.length && j < no.length) {
    const yesPrice = yes[i].price;
    const noPrice = no[j].price;
    const step = Math.min(yesRemaining, noRemaining);
    const stepCostPerUnit = yesPrice + noPrice;

    if (stepCostPerUnit > maxCost) break;
    depth += step;
    cost += step * stepCostPerUnit;

    yesRemaining -= step;
    noRemaining -= step;
    if (yesRemaining <= 0) {
      i += 1;
      if (i >= yes.length) break;
      yesRemaining = yes[i].size;
    }
    if (noRemaining <= 0) {
      j += 1;
      if (j >= no.length) break;
      noRemaining = no[j].size;
    }
  }

  return { depth, cost };
}

function edgeFromCost(cost: number | null): number | null {
  if (cost === null) return null;
  return 1 - cost;
}

function profitFromDepth(depth: number | null, cost: number | null): number | null {
  if (depth === null || cost === null) return null;
  return depth - cost;
}

function roiFromProfit(profit: number | null, cost: number | null): number | null {
  if (profit === null || cost === null || cost <= 0) return null;
  return profit / cost;
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

function shortError(err: unknown) {
  const message = (err as Error)?.message ?? String(err);
  if (message.length > 180) return `${message.slice(0, 180)}...`;
  return message;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
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
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const price = toNumber(obj.price ?? obj[0]);
      const size = toNumber(obj.size ?? obj[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size });
      }
    }
  }
  return out;
}

function parseProbableLevels(side: unknown): PriceLevel[] {
  return parsePolymarketLevels(side);
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
        out.push({ price, size });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const price = normalizeKalshiPriceCents(obj.price ?? obj[0]);
      const size = toNumber(obj.quantity ?? obj.size ?? obj[1]);
      if (price !== null && size !== null && size > 0) {
        out.push({ price, size });
      }
    }
  }
  return out;
}

function parseLimitlessLevels(side: unknown, scale: number): PriceLevel[] {
  if (!Array.isArray(side)) return [];
  const out: PriceLevel[] = [];
  for (const entry of side) {
    if (Array.isArray(entry)) {
      const rawPrice = toNumber(entry[0]);
      const price = rawPrice !== null && rawPrice > 1.5 ? rawPrice / 100 : rawPrice;
      const sizeRaw = toNumber(entry[1]);
      if (price !== null && sizeRaw !== null && sizeRaw > 0) {
        out.push({ price, size: sizeRaw / scale });
      }
      continue;
    }
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      const rawPrice = toNumber(obj.price ?? obj[0]);
      const price = rawPrice !== null && rawPrice > 1.5 ? rawPrice / 100 : rawPrice;
      const sizeRaw = toNumber(obj.size ?? obj.quantity ?? obj.amount ?? obj[1]);
      if (price !== null && sizeRaw !== null && sizeRaw > 0) {
        out.push({ price, size: sizeRaw / scale });
      }
    }
  }
  return out;
}

function sortLevels(levels: PriceLevel[]) {
  levels.sort((a, b) => a.price - b.price);
  return levels;
}

function impliedAsksFromBids(bids: PriceLevel[]): PriceLevel[] {
  const asks: PriceLevel[] = [];
  for (const level of bids) {
    const askPrice = 1 - level.price;
    if (askPrice >= 0 && askPrice <= 1) {
      asks.push({ price: askPrice, size: level.size });
    }
  }
  return sortLevels(asks);
}

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
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

function extractPolymarketBooks(pm: MarketSnapshot): {
  yesAsks: PriceLevel[];
  noAsks: PriceLevel[];
  yesTokenId?: string;
  noTokenId?: string;
} {
  let yesAsks: PriceLevel[] = [];
  let noAsks: PriceLevel[] = [];
  let yesTokenId: string | undefined;
  let noTokenId: string | undefined;

  try {
    const raw = JSON.parse(pm.rawJson) as Record<string, unknown>;
    const book = raw.book as Record<string, unknown> | undefined;
    if (book?.yes || book?.no) {
      const yesBook = book.yes as Record<string, unknown> | undefined;
      const noBook = book.no as Record<string, unknown> | undefined;
      yesAsks = parsePolymarketLevels(yesBook?.asks);
      noAsks = parsePolymarketLevels(noBook?.asks);
    } else if (book?.asks) {
      const label = normalizeLabel(pm.outcomeLabel ?? "");
      if (label === "yes") {
        yesAsks = parsePolymarketLevels(book.asks);
      } else if (label === "no") {
        noAsks = parsePolymarketLevels(book.asks);
      }
    }

    const market = raw.market as Record<string, unknown> | undefined;
    const outcomes = parseArray(market?.outcomes);
    const tokenIds = parseArray(market?.clobTokenIds);
    const normalized = outcomes.map(normalizeLabel);
    const yesIdx = normalized.indexOf("yes");
    const noIdx = normalized.indexOf("no");
    if (yesIdx >= 0) yesTokenId = tokenIds[yesIdx];
    if (noIdx >= 0) noTokenId = tokenIds[noIdx];
  } catch {
    // ignore parse issues
  }

  return {
    yesAsks: sortLevels(yesAsks),
    noAsks: sortLevels(noAsks),
    yesTokenId,
    noTokenId
  };
}

function extractProbableBooks(prob: MarketSnapshot): {
  yesAsks: PriceLevel[];
  noAsks: PriceLevel[];
  hasBook: boolean;
} {
  let yesAsks: PriceLevel[] = [];
  let noAsks: PriceLevel[] = [];
  let hasBook = false;

  try {
    const raw = JSON.parse(prob.rawJson) as Record<string, unknown>;
    const yesBook = raw.yesBook as Record<string, unknown> | undefined;
    const noBook = raw.noBook as Record<string, unknown> | undefined;
    if (yesBook || noBook) {
      hasBook = true;
      yesAsks = parseProbableLevels(yesBook?.asks);
      noAsks = parseProbableLevels(noBook?.asks);
    }
  } catch {
    // ignore parse issues
  }

  return {
    yesAsks: sortLevels(yesAsks),
    noAsks: sortLevels(noAsks),
    hasBook
  };
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

function extractLimitlessBooks(lim: MarketSnapshot): {
  yesAsks: PriceLevel[];
  noAsks: PriceLevel[];
  hasBook: boolean;
} {
  let yesAsks: PriceLevel[] = [];
  let noAsks: PriceLevel[] = [];
  let hasBook = false;
  try {
    const raw = JSON.parse(lim.rawJson) as Record<string, unknown>;
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
        scale
      );
      const yesAsksRaw = parseLimitlessLevels(
        orderbook.asks ?? orderbook.yesAsks ?? orderbook.yes_asks,
        scale
      );
      const noBids = parseLimitlessLevels(
        orderbook.noBids ?? orderbook.no_bids,
        scale
      );
      const noAsksRaw = parseLimitlessLevels(
        orderbook.noAsks ?? orderbook.no_asks,
        scale
      );

      yesAsks = sortLevels(yesAsksRaw);
      noAsks = sortLevels(noAsksRaw);

      if (!yesAsks.length && noBids.length) {
        yesAsks = impliedAsksFromBids(noBids);
      }
      if (!noAsks.length && yesBids.length) {
        noAsks = impliedAsksFromBids(yesBids);
      }
    }
  } catch {
    // ignore parse issues
  }

  return { yesAsks, noAsks, hasBook };
}

async function getKalshiOrderbook(
  ticker: string,
  kal: MarketSnapshot
): Promise<Record<string, unknown>> {
  try {
    const raw = JSON.parse(kal.rawJson) as Record<string, unknown>;
    const orderbook = raw.orderbook as Record<string, unknown> | undefined;
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

function kalshiImpliedAskLevels(
  orderbook: Record<string, unknown>,
  side: "yes" | "no"
): PriceLevel[] {
  const bids = (side === "yes" ? orderbook.no : orderbook.yes) as unknown;
  const levels = parseKalshiLevels(bids);
  const asks: PriceLevel[] = [];
  for (const level of levels) {
    const askPrice = 1 - level.price / 100;
    if (askPrice >= 0 && askPrice <= 1) {
      asks.push({ price: askPrice, size: level.size });
    }
  }
  return sortLevels(asks);
}

function computeDepthAndCost(
  pmLevels: PriceLevel[],
  kalLevels: PriceLevel[],
  maxCost: number,
  emptyAsZero: boolean
) {
  if (!pmLevels.length || !kalLevels.length || !Number.isFinite(maxCost)) {
    if (emptyAsZero && Number.isFinite(maxCost)) {
      return { depth: 0, cost: 0 };
    }
    return { depth: null as number | null, cost: null as number | null };
  }

  let i = 0;
  let j = 0;
  let pmRemaining = pmLevels[0].size;
  let kalRemaining = kalLevels[0].size;
  let depth = 0;
  let cost = 0;

  while (i < pmLevels.length && j < kalLevels.length) {
    const pmPrice = pmLevels[i].price;
    const kalPrice = kalLevels[j].price;
    const combined = pmPrice + kalPrice;
    if (combined > maxCost + 1e-9) break;

    const take = Math.min(pmRemaining, kalRemaining);
    if (take <= 0) break;

    depth += take;
    cost += take * combined;

    pmRemaining -= take;
    kalRemaining -= take;

    if (pmRemaining <= 1e-12) {
      i += 1;
      if (i >= pmLevels.length) break;
      pmRemaining = pmLevels[i].size;
    }
    if (kalRemaining <= 1e-12) {
      j += 1;
      if (j >= kalLevels.length) break;
      kalRemaining = kalLevels[j].size;
    }
  }

  return { depth, cost };
}

function parseCsv(
  filePath: string,
  onRow: (row: string[], idx: number) => void
) {
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
    if (ch === '"') {
      const next = data[i + 1];
      if (inQuotes && next === '"') {
        field += '"';
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

const VALID_EXCHANGES = new Set<Exchange>([
  "polymarket",
  "kalshi",
  "limitless",
  "probable"
]);

function normalizeExchange(value: string) {
  return value.trim().toLowerCase();
}

function readHighMatchesFile(filePath: string): MatchPair[] {
  if (!fs.existsSync(filePath)) return [];

  const pairs: MatchPair[] = [];
  let header: string[] = [];
  const seen = new Set<string>();

  parseCsv(filePath, (row, idx) => {
    if (idx === 0) {
      header = row;
      return;
    }
    if (!header.length || !row.length) return;
    if (row.length !== header.length) return;
    const get = (name: string) => {
      const i = header.indexOf(name);
      return i >= 0 ? row[i] ?? "" : "";
    };

    const hasNewSchema = header.includes("a_exchange");
    let leftExchange = "";
    let rightExchange = "";
    let leftId = "";
    let rightId = "";
    let leftEnd = "";
    let rightEnd = "";

    if (hasNewSchema) {
      leftExchange = get("a_exchange");
      rightExchange = get("b_exchange");
      leftId = get("a_id");
      rightId = get("b_id");
      leftEnd = get("a_end_date");
      rightEnd = get("b_end_date");
    } else {
      leftExchange = "polymarket";
      rightExchange = "kalshi";
      leftId = get("pm_market_slug");
      rightId = get("kal_ticker");
      leftEnd = get("pm_end_date");
      rightEnd = get("kal_close_time");
    }

    leftExchange = normalizeExchange(leftExchange);
    rightExchange = normalizeExchange(rightExchange);

    if (
      !leftExchange ||
      !rightExchange ||
      !leftId ||
      !rightId ||
      !VALID_EXCHANGES.has(leftExchange as Exchange) ||
      !VALID_EXCHANGES.has(rightExchange as Exchange)
    ) {
      return;
    }

    const key = `${leftExchange}::${leftId}::${rightExchange}::${rightId}`;
    if (seen.has(key)) return;
    seen.add(key);

    const pairId = `${leftExchange}_${leftId}__${rightExchange}_${rightId}`;
    const groupId = `${leftExchange}:${leftId}`;

    pairs.push({
      id: pairId,
      groupId,
      baseExchange: leftExchange as Exchange,
      baseId: leftId,
      left: {
        exchange: leftExchange as Exchange,
        id: leftId,
        endDate: leftEnd
      },
      right: {
        exchange: rightExchange as Exchange,
        id: rightId,
        endDate: rightEnd
      }
    });
  });

  return pairs;
}

function readHighMatches(): MatchPair[] {
  const dataDir = process.env.DATA_DIR ?? "data";
  const preferred = path.join(dataDir, "market_matches_high_rescored.csv");
  const fallback = path.join(dataDir, "market_matches_high.csv");
  const preferRescored = parseBool(process.env.SCAN_PREFER_RESCORED, true);

  const preferredPairs = readHighMatchesFile(preferred);
  const fallbackPairs = readHighMatchesFile(fallback);

  if (preferredPairs.length === 0 && fallbackPairs.length === 0) return [];
  if (preferRescored) {
    return preferredPairs.length ? preferredPairs : fallbackPairs;
  }
  return fallbackPairs.length ? fallbackPairs : preferredPairs;
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

async function getOrderbookAsks(
  leg: PairLeg,
  snapshot: MarketSnapshot
): Promise<{ yesAsks: PriceLevel[]; noAsks: PriceLevel[]; hasBook: boolean }> {
  if (leg.exchange === "polymarket") {
    const pmBooks = extractPolymarketBooks(snapshot);
    const yesAsks = await ensurePolymarketAsks(pmBooks.yesAsks, pmBooks.yesTokenId);
    const noAsks = await ensurePolymarketAsks(pmBooks.noAsks, pmBooks.noTokenId);
    return { yesAsks, noAsks, hasBook: true };
  }
  if (leg.exchange === "kalshi") {
    const orderbook = await getKalshiOrderbook(leg.id, snapshot);
    const yesAsks = kalshiImpliedAskLevels(orderbook, "yes");
    const noAsks = kalshiImpliedAskLevels(orderbook, "no");
    return { yesAsks, noAsks, hasBook: true };
  }
  if (leg.exchange === "probable") {
    return extractProbableBooks(snapshot);
  }
  return extractLimitlessBooks(snapshot);
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  ensureDir(dataDir);

  const minEdge = num(process.env.MIN_EDGE, 0);
  const logEvery = Math.max(1, num(process.env.SCAN_LOG_EVERY, 200));
  const depthEdge = num(process.env.ARB_DEPTH_EDGE, 0.01);
  const depthMaxCost = 1 - depthEdge;
  const depthEmptyAsZero = parseBool(process.env.DEPTH_EMPTY_AS_ZERO, true);

  const scanFresh = parseBool(process.env.SCAN_FRESH, false);
  const freshPairsPath = path.join(dataDir, "market_matches_high_fresh.csv");
  const fullPairsPath = path.join(dataDir, "market_matches_high.csv");

  const pairs = scanFresh ? readHighMatchesFile(freshPairsPath) : readHighMatches();
  if (!pairs.length) {
    if (scanFresh) {
      console.log("[SCAN] No fresh high matches found; nothing to do.");
      return;
    }
    throw new Error("No high matches found to scan.");
  }

  const allPairs = scanFresh ? readHighMatchesFile(fullPairsPath) : pairs;
  if (scanFresh && !allPairs.length) {
    throw new Error(
      `SCAN_FRESH=true but ${fullPairsPath} is empty; run a full discover first.`
    );
  }

  const runIso = new Date().toISOString();
  const runTs = Date.parse(runIso);
  const snapshotCache = new Map<string, Promise<MarketSnapshot | null>>();
  const asksCache = new Map<
    string,
    Promise<{ yesAsks: PriceLevel[]; noAsks: PriceLevel[]; hasBook: boolean }>
  >();
  const legBooks = new Map<string, LegBook>();

  const legKey = (leg: PairLeg) => `${leg.exchange}:${leg.id}`;
  const { components, legByKey } = buildComponents(allPairs);
  const legToComponent = new Map<string, number>();
  for (let i = 0; i < components.length; i += 1) {
    for (const key of components[i]) {
      legToComponent.set(key, i);
    }
  }
  const targetComponents = new Set<number>();
  const targetLegKeys = new Set<string>();
  if (scanFresh) {
    for (const pair of pairs) {
      const aIdx = legToComponent.get(legKey(pair.left));
      if (aIdx !== undefined) targetComponents.add(aIdx);
      const bIdx = legToComponent.get(legKey(pair.right));
      if (bIdx !== undefined) targetComponents.add(bIdx);
    }
    for (const idx of targetComponents) {
      const component = components[idx] ?? [];
      for (const key of component) targetLegKeys.add(key);
    }
    console.log(
      `[SCAN] Fresh mode: seedPairs=${pairs.length} components=${targetComponents.size} legs=${targetLegKeys.size}`
    );
  }
  const getSnapshotCached = (leg: PairLeg) => {
    const key = legKey(leg);
    if (!snapshotCache.has(key)) {
      snapshotCache.set(
        key,
        fetchSnapshotForLeg(leg, runIso).catch((err) => {
          console.error(
            `[${exchangeLabel(leg.exchange)}] ${leg.id}: ${shortError(err)}`
          );
          return null;
        })
      );
    }
    return snapshotCache.get(key)!;
  };

  const getAsksCached = (leg: PairLeg, snapshot: MarketSnapshot) => {
    const key = legKey(leg);
    if (!asksCache.has(key)) {
      asksCache.set(
        key,
        getOrderbookAsks(leg, snapshot).catch((err) => {
          console.warn(
            `[${exchangeLabel(leg.exchange)}] ${leg.id}: unable to parse orderbook: ${shortError(err)}`
          );
          return { yesAsks: [], noAsks: [], hasBook: false };
        })
      );
    }
    return asksCache.get(key)!;
  };

  const tagLevels = (levels: PriceLevel[], leg: PairLeg) =>
    levels.map((level) => ({
      ...level,
      exchange: leg.exchange,
      id: leg.id
    }));

  const storeLegBook = (
    leg: PairLeg,
    asks: { yesAsks: PriceLevel[]; noAsks: PriceLevel[]; hasBook: boolean },
    title?: string
  ) => {
    const key = legKey(leg);
    if (legBooks.has(key)) return;
    legBooks.set(key, {
      exchange: leg.exchange,
      id: leg.id,
      endDate: leg.endDate,
      title,
      yesAsks: tagLevels(asks.yesAsks, leg),
      noAsks: tagLevels(asks.noAsks, leg),
      hasBook: asks.hasBook
    });
  };

  const quotesRows: string[] = [];
  const arbRows: string[] = [];
  const summaryRows: string[] = [];
  quotesRows.push(
    [
      "ts",
      "pair_id",
      "exchange",
      "market_id",
      "market_title",
      "outcome_label",
      "yes_bid",
      "yes_ask",
      "no_bid",
      "no_ask"
    ].join(",")
  );
  arbRows.push(
    [
      "ts",
      "pair_id",
      "direction",
      "cost",
      "edge",
      "depth_1pct",
      "capital_1pct",
      "profit_1pct",
      "roi_1pct",
      "days_to_settle",
      "roi_1pct_annualized",
      "yes_legs",
      "no_legs"
    ].join(",")
  );
  summaryRows.push(
    [
      "ts",
      "group_id",
      "base_exchange",
      "base_market_id",
      "direction",
      "best_edge",
      "best_cost",
      "other_exchange",
      "other_market_id"
    ].join(",")
  );

  let totalCapital = 0;
  let totalProfit = 0;
  let totalWeightedDays = 0;
  let totalCapitalForDays = 0;

  const groupBest = new Map<
    string,
    {
      baseExchange: Exchange;
      baseMarketId: string;
      best: Record<
        string,
        {
          edge: number | null;
          cost: number | null;
          otherExchange: Exchange;
          otherMarketId: string;
        }
      >;
    }
  >();

  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    const left = await getSnapshotCached(pair.left);
    const right = await getSnapshotCached(pair.right);

    if (left) {
      quotesRows.push(
        [
          left.ts,
          pair.id,
          left.exchange,
          left.marketId,
          left.marketTitle,
          left.outcomeLabel,
          formatNum(left.yesBid),
          formatNum(left.yesAsk),
          formatNum(left.noBid),
          formatNum(left.noAsk)
        ].join(",")
      );
    }
    if (right) {
      quotesRows.push(
        [
          right.ts,
          pair.id,
          right.exchange,
          right.marketId,
          right.marketTitle,
          right.outcomeLabel,
          formatNum(right.yesBid),
          formatNum(right.yesAsk),
          formatNum(right.noBid),
          formatNum(right.noAsk)
        ].join(",")
      );
    }

    if (!left || !right) continue;

    const leftAsks = await getAsksCached(pair.left, left);
    const rightAsks = await getAsksCached(pair.right, right);
    storeLegBook(pair.left, leftAsks, left.marketTitle);
    storeLegBook(pair.right, rightAsks, right.marketTitle);
    const allowZeroDepth =
      depthEmptyAsZero && leftAsks.hasBook && rightAsks.hasBook;

    const leftLabel = exchangeLabel(pair.left.exchange);
    const rightLabel = exchangeLabel(pair.right.exchange);
    const dirA = `${leftLabel}_YES_${rightLabel}_NO`;
    const dirB = `${rightLabel}_YES_${leftLabel}_NO`;

    const costA = sumNullable(left.yesAsk, right.noAsk);
    const edgeA = edgeFromCost(costA);
    const depthA = computeDepthAndCost(
      leftAsks.yesAsks,
      rightAsks.noAsks,
      depthMaxCost,
      allowZeroDepth
    );
    const profitA = profitFromDepth(depthA.depth, depthA.cost);
    const roiA = roiFromProfit(profitA, depthA.cost);
    const leftEndTs = parseDate(pair.left.endDate);
    const rightEndTs = parseDate(pair.right.endDate);
    const settleTs = latestDate(leftEndTs, rightEndTs);
    const daysToSettle = settleTs !== null ? daysBetween(runTs, settleTs) : null;
    const roiAAnnual = annualizedRoi(roiA, daysToSettle);
    if (edgeA !== null && edgeA >= minEdge) {
      arbRows.push(
        [
          runIso,
          pair.id,
          dirA,
          formatNum(costA),
          formatNum(edgeA),
          formatNum(depthA.depth),
          formatNum(depthA.cost),
          formatNum(profitA),
          formatNum(roiA),
          formatNum(daysToSettle),
          formatNum(roiAAnnual),
          "",
          ""
        ].join(",")
      );
    }

    const costB = sumNullable(right.yesAsk, left.noAsk);
    const edgeB = edgeFromCost(costB);
    const depthB = computeDepthAndCost(
      rightAsks.yesAsks,
      leftAsks.noAsks,
      depthMaxCost,
      allowZeroDepth
    );
    const profitB = profitFromDepth(depthB.depth, depthB.cost);
    const roiB = roiFromProfit(profitB, depthB.cost);
    const roiBAnnual = annualizedRoi(roiB, daysToSettle);
    if (edgeB !== null && edgeB >= minEdge) {
      arbRows.push(
        [
          runIso,
          pair.id,
          dirB,
          formatNum(costB),
          formatNum(edgeB),
          formatNum(depthB.depth),
          formatNum(depthB.cost),
          formatNum(profitB),
          formatNum(roiB),
          formatNum(daysToSettle),
          formatNum(roiBAnnual),
          "",
          ""
        ].join(",")
      );
    }

    if (pair.groupId) {
      const entry =
        groupBest.get(pair.groupId) ??
        {
          baseExchange: pair.left.exchange,
          baseMarketId: pair.left.id,
          best: {}
        };

      const updateBest = (direction: string, edge: number | null, cost: number | null) => {
        const current = entry.best[direction];
        if (!current) {
          entry.best[direction] = {
            edge,
            cost,
            otherExchange: pair.right.exchange,
            otherMarketId: pair.right.id
          };
          return;
        }
        if (edge !== null && (current.edge === null || edge > current.edge)) {
          entry.best[direction] = {
            edge,
            cost,
            otherExchange: pair.right.exchange,
            otherMarketId: pair.right.id
          };
        }
      };

      updateBest(dirA, edgeA, costA);
      updateBest(dirB, edgeB, costB);
      groupBest.set(pair.groupId, entry);
    }

    if ((i + 1) % logEvery === 0) {
      console.log(`[SCAN] ${i + 1}/${pairs.length} processed`);
    }
  }

  if (scanFresh) {
    for (const key of targetLegKeys) {
      if (legBooks.has(key)) continue;
      const leg = legByKey.get(key);
      if (!leg) continue;
      const snap = await getSnapshotCached(leg);
      if (!snap) continue;
      quotesRows.push(
        [
          snap.ts,
          "FRESH",
          snap.exchange,
          snap.marketId,
          snap.marketTitle,
          snap.outcomeLabel,
          formatNum(snap.yesBid),
          formatNum(snap.yesAsk),
          formatNum(snap.noBid),
          formatNum(snap.noAsk)
        ].join(",")
      );
      const asks = await getAsksCached(leg, snap);
      storeLegBook(leg, asks, snap.marketTitle);
    }
  }

  const componentIndices = scanFresh
    ? Array.from(targetComponents).sort((a, b) => a - b)
    : components.map((_, idx) => idx);

  for (const idx of componentIndices) {
    const component = components[idx] ?? [];
    if (component.length < 2) continue;
    const legs: LegBook[] = [];
    let allBooks = true;
    for (const key of component) {
      const leg = legByKey.get(key);
      if (!leg) continue;
      const book = legBooks.get(key);
      if (book) {
        legs.push(book);
        if (!book.hasBook) allBooks = false;
      } else {
        allBooks = false;
      }
    }
    if (!legs.length) continue;

    const medalTypes = new Set<string>();
    for (const leg of legs) {
      const source = leg.title ?? leg.id;
      const category = medalCategory(source);
      if (category) medalTypes.add(category);
    }
    if (medalTypes.size > 1) continue;

    const yesLevels = legs.flatMap((leg) => leg.yesAsks);
    const noLevels = legs.flatMap((leg) => leg.noAsks);
    if (!yesLevels.length || !noLevels.length) continue;

    const bestYes = Math.min(...yesLevels.map((l) => l.price));
    const bestNo = Math.min(...noLevels.map((l) => l.price));
    const spotCost = bestYes + bestNo;
    const spotEdge = edgeFromCost(spotCost);
    if (spotEdge === null || spotEdge < minEdge) continue;

    const allowZeroDepth = depthEmptyAsZero && allBooks;
    const depthOpt = computeOptimizedDepth(
      yesLevels,
      noLevels,
      depthMaxCost,
      allowZeroDepth
    );
    const profitOpt = profitFromDepth(depthOpt.depth, depthOpt.cost);
    const roiOpt = roiFromProfit(profitOpt, depthOpt.cost);
    const settleTs = legs.reduce((latest, leg) => {
      const ts = parseDate(leg.endDate);
      return latestDate(latest, ts);
    }, null as number | null);
    const daysToSettle = settleTs !== null ? daysBetween(runTs, settleTs) : null;
    const roiOptAnnual = annualizedRoi(roiOpt, daysToSettle);

    const yesLegIds = legs
      .filter((leg) => leg.yesAsks.length)
      .map((leg) => `${leg.exchange}:${leg.id}`);
    const noLegIds = legs
      .filter((leg) => leg.noAsks.length)
      .map((leg) => `${leg.exchange}:${leg.id}`);
    const yesValue = csvEscape(yesLegIds.join("|"));
    const noValue = csvEscape(noLegIds.join("|"));

    const groupId = `group_${component[0].replace(/[:]/g, "_")}`;
    arbRows.push(
      [
        runIso,
        groupId,
        "GROUPED",
        formatNum(spotCost),
        formatNum(spotEdge),
        formatNum(depthOpt.depth),
        formatNum(depthOpt.cost),
        formatNum(profitOpt),
        formatNum(roiOpt),
        formatNum(daysToSettle),
        formatNum(roiOptAnnual),
        yesValue,
        noValue
      ].join(",")
    );
    const groupRowIndex = arbRows.length - 1;
    let singleStepYesLeg: string | null = null;
    let singleStepNoLeg: string | null = null;

    const sortedYes = [...yesLevels].sort((a, b) => a.price - b.price);
    const sortedNo = [...noLevels].sort((a, b) => a.price - b.price);
    if (sortedYes.length && sortedNo.length) {
      let yi = 0;
      let ni = 0;
      let yesRemaining = sortedYes[0].size;
      let noRemaining = sortedNo[0].size;
      let step = 1;
      let cumDepth = 0;
      let cumCost = 0;
      let stepsEmitted = 0;

      while (yi < sortedYes.length && ni < sortedNo.length) {
        const yes = sortedYes[yi];
        const no = sortedNo[ni];
        const take = Math.min(yesRemaining, noRemaining);
        const unitCost = yes.price + no.price;

        if (unitCost <= depthMaxCost) {
          const stepCost = take * unitCost;
          const stepProfit = take - stepCost;
          cumDepth += take;
          cumCost += stepCost;

          const stepRoi = stepCost > 0 ? stepProfit / stepCost : null;
          const stepAnnual = annualizedRoi(stepRoi, daysToSettle);
          const stepYesLeg = csvEscape(`${yes.exchange}:${yes.id}`);
          const stepNoLeg = csvEscape(`${no.exchange}:${no.id}`);
          if (stepsEmitted === 0) {
            singleStepYesLeg = stepYesLeg;
            singleStepNoLeg = stepNoLeg;
          }

          stepsEmitted += 1;
          arbRows.push(
            [
              runIso,
              groupId,
              `STEP_${step}`,
              formatNum(unitCost),
              formatNum(1 - unitCost),
              formatNum(take),
              formatNum(stepCost),
              formatNum(stepProfit),
              formatNum(stepRoi),
              formatNum(daysToSettle),
              formatNum(stepAnnual),
              stepYesLeg,
              stepNoLeg
            ].join(",")
          );

          step += 1;
          yesRemaining -= take;
          noRemaining -= take;
          if (yesRemaining <= 0) {
            yi += 1;
            if (yi >= sortedYes.length) break;
            yesRemaining = sortedYes[yi].size;
          }
          if (noRemaining <= 0) {
            ni += 1;
            if (ni >= sortedNo.length) break;
            noRemaining = sortedNo[ni].size;
          }
          continue;
        }

        if (cumDepth === 0) break;
        const numerator = depthMaxCost * cumDepth - cumCost;
        const denominator = unitCost - depthMaxCost;
        const maxStep = denominator > 0 ? numerator / denominator : take;
        if (maxStep > 0) {
          const size = Math.min(take, maxStep);
          const stepCost = size * unitCost;
          const stepProfit = size - stepCost;
          cumDepth += size;
          cumCost += stepCost;

          const stepRoi = stepCost > 0 ? stepProfit / stepCost : null;
          const stepAnnual = annualizedRoi(stepRoi, daysToSettle);
          const stepYesLeg = csvEscape(`${yes.exchange}:${yes.id}`);
          const stepNoLeg = csvEscape(`${no.exchange}:${no.id}`);
          if (stepsEmitted === 0) {
            singleStepYesLeg = stepYesLeg;
            singleStepNoLeg = stepNoLeg;
          }

          stepsEmitted += 1;
          arbRows.push(
            [
              runIso,
              groupId,
              `STEP_${step}`,
              formatNum(unitCost),
              formatNum(1 - unitCost),
              formatNum(size),
              formatNum(stepCost),
              formatNum(stepProfit),
              formatNum(stepRoi),
              formatNum(daysToSettle),
              formatNum(stepAnnual),
              stepYesLeg,
              stepNoLeg
            ].join(",")
          );
        }
        break;
      }

      if (stepsEmitted === 1) {
        arbRows.pop();
        if (singleStepYesLeg && singleStepNoLeg) {
          const groupRow = arbRows[groupRowIndex].split(",");
          groupRow[11] = singleStepYesLeg;
          groupRow[12] = singleStepNoLeg;
          arbRows[groupRowIndex] = groupRow.join(",");
        }
      }
    }
  }

  const header = arbRows[0].split(",");
  const parsedRows = arbRows
    .slice(1)
    .map((line) => line.split(","))
    .filter((row) => row.length);
  const hasGrouped = parsedRows.some((row) => {
    const dirIdx = header.indexOf("direction");
    return dirIdx >= 0 && row[dirIdx] === "GROUPED";
  });

  for (const row of parsedRows) {
    const get = (name: string) => {
      const idx = header.indexOf(name);
      return idx >= 0 ? row[idx] ?? "" : "";
    };
    if (get("pair_id") === "TOTAL") continue;
    const direction = get("direction") ?? "";
    if (direction.startsWith("STEP_")) continue;
    if (hasGrouped && direction !== "GROUPED") continue;
    const capital = toNumber(get("capital_1pct"));
    const profit = toNumber(get("profit_1pct"));
    const days = toNumber(get("days_to_settle"));
    if (capital === null || profit === null) continue;
    totalCapital += capital;
    totalProfit += profit;
    if (days !== null) {
      totalWeightedDays += capital * days;
      totalCapitalForDays += capital;
    }
  }

  const totalRoi = totalCapital > 0 ? totalProfit / totalCapital : null;
  const avgDaysToSettle =
    totalCapitalForDays > 0 ? totalWeightedDays / totalCapitalForDays : null;
  const totalRoiAnnual = annualizedRoi(totalRoi, avgDaysToSettle);
  arbRows.push(
    [
      "TOTAL",
      "",
      "",
      "",
      "",
      "",
      formatNum(totalCapital),
      formatNum(totalProfit),
      formatNum(totalRoi),
      formatNum(avgDaysToSettle),
      formatNum(totalRoiAnnual),
      "",
      ""
    ].join(",")
  );

  for (const [groupId, entry] of groupBest.entries()) {
    const nowIso = runIso;
    for (const [direction, best] of Object.entries(entry.best)) {
      summaryRows.push(
        [
          nowIso,
          groupId,
          entry.baseExchange,
          entry.baseMarketId,
          direction,
          formatNum(best.edge),
          formatNum(best.cost),
          best.otherExchange,
          best.otherMarketId
        ].join(",")
      );
    }
  }

  const outSuffix = scanFresh ? "_fresh" : "";
  fs.writeFileSync(
    path.join(dataDir, `latest_quotes_high${outSuffix}.csv`),
    quotesRows.join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, `latest_arbs_high${outSuffix}.csv`),
    arbRows.join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, `latest_arbs_high_timeleft${outSuffix}.csv`),
    sortArbRowsByTimeLeft(arbRows).join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dataDir, `latest_arbs_summary_high${outSuffix}.csv`),
    summaryRows.join("\n"),
    "utf8"
  );

  console.log(
    `Scanned high matches${scanFresh ? " (fresh)" : ""}: pairs=${pairs.length} edges>=${minEdge} logged.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
