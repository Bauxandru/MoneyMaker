import fs from "fs";
import path from "path";
import os from "os";
import { Worker } from "worker_threads";
import dotenv from "dotenv";

dotenv.config();

type AnyRecord = Record<string, unknown>;

type PolymarketMarket = {
  id: string;
  marketSlug: string;
  eventSlug: string;
  question: string;
  description: string;
  resolutionSource: string;
  outcomes: string[];
  endDate: string;
  active: boolean | null;
  closed: boolean | null;
  enableOrderBook: boolean | null;
};

type KalshiMarket = {
  ticker: string;
  title: string;
  subtitle: string;
  eventTicker: string;
  status: string;
  closeTime: string;
  rulesText: string;
  outcomeType: string;
};

type LimitlessMarket = {
  id?: number;
  slug?: string;
  title?: string;
  proxyTitle?: string | null;
  description?: string;
  expirationDate?: string;
  expirationTimestamp?: number;
  status?: string;
  tradeType?: string;
  marketType?: string;
  markets?: LimitlessMarket[];
  parentTitle?: string;
  parentSlug?: string;
};

type ProbableMarket = {
  id?: number | string;
  marketSlug?: string;
  question?: string;
  description?: string;
  outcomes?: string[];
  endDate?: string;
  active?: boolean | null;
  closed?: boolean | null;
};

type MatchMarket = {
  exchange: "polymarket" | "kalshi" | "limitless" | "probable";
  id: string;
  title: string;
  subtitle: string;
  outcomes: string[];
  endDate: string;
  rulesText: string;
  description: string;
  status: string;
};

type MatchRow = {
  score: number;
  titleScore: number;
  numberScore: number;
  outcomeScore: number;
  rulesScore: number | null;
  timeDiffDays: number | null;
  reasons: string;
  left: MatchMarket;
  right: MatchMarket;
};

type CsvRow = {
  header: string[];
  values: string[];
};

type Bucket = {
  dir: "cut" | "hike" | "nochange";
  mag: "0" | "25" | "gt25" | "ge25";
};

const STOPWORDS = new Set([
  "who",
  "the",
  "a",
  "an",
  "of",
  "and",
  "to",
  "in",
  "on",
  "for",
  "by",
  "at",
  "from",
  "with",
  "will",
  "be",
  "is",
  "are",
  "was",
  "were",
  "as",
  "that",
  "this",
  "it",
  "its",
  "their",
  "or",
  "vs",
  "vs.",
  "after",
  "before",
  "by",
  "over",
  "under",
  "between",
  "about",
  "into",
  "than",
  // month names (often appear in dates and add noise)
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december"
]);

const FDV_TEMPLATE_TOKENS = new Set([
  "fdv",
  "fully",
  "diluted",
  "valuation",
  "market",
  "cap",
  "above",
  "below",
  "over",
  "under",
  "one",
  "day",
  "after",
  "launch",
  "dollar",
  "usd",
  "million",
  "billion",
  "m",
  "b",
  "greater",
  "less",
  "than"
]);

const MNA_TEMPLATE_TOKENS = new Set([
  "merger",
  "merge",
  "merged",
  "acquire",
  "acquires",
  "acquired",
  "acquisition",
  "buy",
  "buys",
  "bought",
  "purchase",
  "purchased",
  "takeover",
  "deal",
  "officially",
  "official",
  "announce",
  "announced",
  "announcement"
]);

const ENTITY_IGNORE_TOKENS = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "llc",
  "plc",
  "group",
  "holdings",
  "holding",
  "sa",
  "ag",
  "nv"
]);

function num(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean) {
  if (!raw) return fallback;
  return raw.trim().toLowerCase() !== "false";
}

function parseStatusList(raw: string | undefined) {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return [];
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === "open") return "active";
      if (part === "any" || part === "all") return "";
      return part;
    })
    .filter(Boolean);
  return Array.from(new Set(parts));
}

function normalizeKalshiEventStatus(raw: string | undefined) {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "";
  const first = value.includes(",") ? value.split(",")[0].trim() : value;
  if (first === "active") return "open";
  if (first === "all" || first === "any") return "";
  return first;
}

function normalizeBaseUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function buildLimitlessBaseCandidates(raw: string) {
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

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let header: string[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const finishRow = () => {
    if (!row.length) return;
    if (!header.length) {
      header = row.map((cell) => cell.trim());
    } else {
      rows.push({ header, values: row });
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\"") {
      if (inQuotes && text[i + 1] === "\"") {
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
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
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

function getRowValue(row: CsvRow, name: string) {
  const idx = row.header.indexOf(name);
  return idx >= 0 ? row.values[idx] ?? "" : "";
}

function matchKeyFromRow(row: CsvRow) {
  if (row.header.includes("a_exchange")) {
    const aEx = getRowValue(row, "a_exchange");
    const aId = getRowValue(row, "a_id");
    const bEx = getRowValue(row, "b_exchange");
    const bId = getRowValue(row, "b_id");
    return `${aEx}::${aId}::${bEx}::${bId}`;
  }
  const pm = getRowValue(row, "pm_market_slug");
  const kal = getRowValue(row, "kal_ticker");
  return `polymarket::${pm}::kalshi::${kal}`;
}

function isOpenPolymarket(market: PolymarketMarket | undefined) {
  if (!market) return false;
  if (market.active === false) return false;
  if (market.closed === true) return false;
  return true;
}

function isOpenKalshi(market: KalshiMarket | undefined) {
  if (!market) return false;
  return String(market.status ?? "").toLowerCase() === "active";
}

function isOpenLimitless(market: LimitlessMarket | undefined) {
  if (!market) return false;
  return String(market.status ?? "").toLowerCase() === "active";
}

function isOpenProbable(market: ProbableMarket | undefined) {
  if (!market) return false;
  if (market.active === false) return false;
  if (market.closed === true) return false;
  return true;
}

function isRowOpen(
  row: CsvRow,
  pmBySlug: Map<string, PolymarketMarket>,
  kalByTicker: Map<string, KalshiMarket>,
  limBySlug: Map<string, LimitlessMarket>,
  probBySlug: Map<string, ProbableMarket>
) {
  const hasNewSchema = row.header.includes("a_exchange");
  if (!hasNewSchema) {
    const pmSlug = getRowValue(row, "pm_market_slug");
    const kalTicker = getRowValue(row, "kal_ticker");
    return (
      isOpenPolymarket(pmBySlug.get(pmSlug)) &&
      isOpenKalshi(kalByTicker.get(kalTicker))
    );
  }

  const aEx = getRowValue(row, "a_exchange");
  const aId = getRowValue(row, "a_id");
  const bEx = getRowValue(row, "b_exchange");
  const bId = getRowValue(row, "b_id");

  const openA =
    aEx === "polymarket"
      ? isOpenPolymarket(pmBySlug.get(aId))
      : aEx === "kalshi"
        ? isOpenKalshi(kalByTicker.get(aId))
        : isOpenLimitless(limBySlug.get(aId));

  const openB =
    bEx === "polymarket"
      ? isOpenPolymarket(pmBySlug.get(bId))
      : bEx === "kalshi"
        ? isOpenKalshi(kalByTicker.get(bId))
        : bEx === "limitless"
          ? isOpenLimitless(limBySlug.get(bId))
          : isOpenProbable(probBySlug.get(bId));

  return openA && openB;
}

function readExistingRows(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];
  const rows = parseCsv(raw);
  // If the file was previously appended without proper CSV escaping, it can become
  // badly malformed (embedded commas/newlines split records). Keep only rows that
  // match the header width so we don't re-propagate corruption.
  const valid = rows.filter((row) => row.values.length === row.header.length);
  const invalid = rows.length - valid.length;
  if (invalid > 0) {
    const pct = rows.length ? ((invalid / rows.length) * 100).toFixed(1) : "0.0";
    console.warn(
      `[DISCOVER] Skipping ${invalid}/${rows.length} malformed rows in ${filePath} (${pct}%).`
    );
  }
  return valid;
}

function appendMissingRows(
  filePath: string,
  existing: CsvRow[],
  pmBySlug: Map<string, PolymarketMarket>,
  kalByTicker: Map<string, KalshiMarket>,
  limBySlug: Map<string, LimitlessMarket>,
  probBySlug: Map<string, ProbableMarket>
) {
  if (!existing.length) return;
  const currentRaw = fs.readFileSync(filePath, "utf8");
  const currentRows = parseCsv(currentRaw);
  const seen = new Set(currentRows.map((row) => matchKeyFromRow(row)));
  const lines: string[] = [];

  for (const row of existing) {
    if (!isRowOpen(row, pmBySlug, kalByTicker, limBySlug, probBySlug)) continue;
    const key = matchKeyFromRow(row);
    if (seen.has(key)) continue;
    // Preserve proper escaping so fields with commas/newlines don't corrupt the CSV.
    lines.push(row.values.map(csvValue).join(","));
    seen.add(key);
  }

  if (lines.length) {
    fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  }
}

function buildOpenSkipSet(
  existingHigh: CsvRow[],
  existingReview: CsvRow[],
  pmBySlug: Map<string, PolymarketMarket>,
  kalByTicker: Map<string, KalshiMarket>,
  limBySlug: Map<string, LimitlessMarket>,
  probBySlug: Map<string, ProbableMarket>
) {
  const out = new Set<string>();
  const pushRows = (rows: CsvRow[]) => {
    for (const row of rows) {
      if (!isRowOpen(row, pmBySlug, kalByTicker, limBySlug, probBySlug)) continue;
      out.add(matchKeyFromRow(row));
    }
  };
  pushRows(existingHigh);
  pushRows(existingReview);
  return out;
}

type RetryOptions = {
  timeoutMs: number;
  maxRetries: number;
  baseDelayMs: number;
  progress: boolean;
  retryForever: boolean;
  requestDelayMs: number;
  min429DelayMs: number;
};

async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit,
  opts: RetryOptions
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.maxRetries || opts.retryForever; attempt += 1) {
    if (opts.requestDelayMs > 0) {
      await sleep(opts.requestDelayMs + Math.floor(Math.random() * 50));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) {
        return (await res.json()) as T;
      }

      const body = await res.text().catch(() => "");
      const retryAfter = Number(res.headers.get("retry-after"));
      const shouldRetry = res.status === 429 || res.status >= 500;
      const canRetry =
        shouldRetry &&
        (res.status === 429 && opts.retryForever
          ? true
          : attempt < opts.maxRetries);
      if (canRetry) {
        let delay =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : opts.baseDelayMs * Math.pow(2, attempt);
        if (res.status === 429 && opts.min429DelayMs > 0) {
          delay = Math.max(delay, opts.min429DelayMs);
        }
        if (opts.progress) {
          console.log(
            `[DISCOVER] ${res.status} retry in ${Math.round(delay)}ms for ${url}`
          );
        }
        await sleep(delay + Math.floor(Math.random() * 200));
        continue;
      }

      throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}. ${body}`);
    } catch (err) {
      lastError = err;
      const message = (err as Error).message ?? "";
      const retryable =
        message.includes("AbortError") ||
        message.includes("network") ||
        message.includes("ECONNRESET") ||
        message.includes("ENOTFOUND");
      if (retryable && attempt < opts.maxRetries) {
        const delay = opts.baseDelayMs * Math.pow(2, attempt);
        if (opts.progress) {
          console.log(
            `[DISCOVER] retry in ${Math.round(delay)}ms after error: ${message}`
          );
        }
        await sleep(delay + Math.floor(Math.random() * 200));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to fetch.");
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
      return [trimmed];
    }
    return [trimmed];
  }
  return [];
}

function normalizeText(value: string) {
  const raw = String(value ?? "");
  const fixed =
    /[ÃÂ]/.test(raw)
      ? (() => {
          try {
            return Buffer.from(raw, "latin1").toString("utf8");
          } catch {
            return raw;
          }
        })()
      : raw;

  const expanded = fixed
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/\bhead(?:\s+|-)+of(?:\s+|-)+state\b/gi, "leader")
    .replace(/\bfed\b/gi, "federal reserve")
    .replace(/\bfomc\b/gi, "federal open market committee")
    .replace(/\bbps\b/gi, "basis points")
    .replace(/\bcut\b/gi, "decrease")
    .replace(/\bhike\b/gi, "increase")
    .replace(/\braise\b/gi, "increase")
    .replace(/\blower\b/gi, "decrease")
    .replace(/\becb\b/gi, "european central bank")
    .replace(/\bboj\b/gi, "bank of japan")
    .replace(/\bboc\b/gi, "bank of canada")
    .replace(/\bboe\b/gi, "bank of england")
    .replace(/\buefa\b/gi, "union of european football associations")
    .replace(/\bnfl\b/gi, "national football league")
    .replace(/\bnba\b/gi, "national basketball association")
    .replace(/\bleaders?\b/gi, "lead");

  return expanded
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMnaTitle(title: string): boolean {
  const normalized = normalizeText(title);
  return /\b(merger|merge|merged|acquire|acquired|acquisition|takeover|buyout)\b/.test(
    normalized
  );
}

function mnaEntityTokens(title: string, titleTokens: string[]): string[] {
  const normalized = normalizeText(title);
  const mergerIdx = normalized.indexOf(" merger");
  if (mergerIdx >= 0) {
    const head = normalized.slice(0, mergerIdx);
    const headTokens = uniqueTokens(tokenize(head)).filter(
      (token) => token && !ENTITY_IGNORE_TOKENS.has(token) && !/^\d+$/.test(token)
    );
    if (headTokens.length >= 2) return headTokens;
  }
  return titleTokens.filter(
    (token) =>
      token &&
      token.length >= 2 &&
      !ENTITY_IGNORE_TOKENS.has(token) &&
      !MNA_TEMPLATE_TOKENS.has(token) &&
      !/^\d+$/.test(token)
  );
}

function entitiesCompatible(aTokens: string[], bTokens: string[]): boolean {
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  if (!setA.size || !setB.size) return true;
  let intersect = 0;
  for (const token of setA) {
    if (setB.has(token)) intersect += 1;
  }
  const needed = Math.min(2, Math.min(setA.size, setB.size));
  return intersect >= needed;
}

function parseBucket(raw: string): Bucket | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (
    lower.includes("no change") ||
    lower.includes("maintains rate") ||
    lower.includes("maintain rate") ||
    /\b0\s*bps\b/.test(lower)
  ) {
    return { dir: "nochange", mag: "0" };
  }

  let dir: Bucket["dir"] | null = null;
  if (/(decrease|cut)\b/.test(lower)) dir = "cut";
  if (/(increase|hike|raise)\b/.test(lower)) dir = "hike";
  if (!dir) return null;

  if (/(25\s*\+|25\+\s*bps)/.test(lower)) {
    return { dir, mag: "ge25" };
  }
  if (/(>\s*25|greater than 25|over 25|more than 25)/.test(lower)) {
    return { dir, mag: "gt25" };
  }
  if (/(50\s*\+|50\+\s*bps|>\s*50|greater than 50|over 50|more than 50)/.test(lower)) {
    return { dir, mag: "gt25" };
  }
  if (/\b25\b/.test(lower)) {
    return { dir, mag: "25" };
  }

  return null;
}

function bucketsCompatible(pmBucket: Bucket | null, kalBucket: Bucket | null): boolean {
  if (!pmBucket || !kalBucket) return true;
  if (pmBucket.dir !== kalBucket.dir) return false;
  if (pmBucket.dir === "nochange") return kalBucket.mag === "0";

  if (pmBucket.mag === "25") return kalBucket.mag === "25";
  if (pmBucket.mag === "ge25") return kalBucket.mag === "25" || kalBucket.mag === "gt25";
  if (pmBucket.mag === "gt25") return kalBucket.mag === "gt25";
  return true;
}

function tokenize(value: string): string[] {
  if (!value) return [];
  const text = normalizeText(value);
  if (!text) return [];
  return text
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !STOPWORDS.has(token));
}

function uniqueTokens(tokens: string[]): string[] {
  return Array.from(new Set(tokens));
}

function isFdvOneDay(title: string): boolean {
  const normalized = normalizeText(title);
  return normalized.includes("fdv") && normalized.includes("one day after launch");
}

function medalCategory(title: string): "gold" | "silver" | "bronze" | "all" | null {
  const normalized = normalizeText(title);
  if (!normalized.includes("medal")) return null;
  if (normalized.includes("gold")) return "gold";
  if (normalized.includes("silver")) return "silver";
  if (normalized.includes("bronze")) return "bronze";
  return "all";
}

function medalPlacement(title: string): string | null {
  const normalized = normalizeText(title);
  if (!normalized.includes("medal")) return null;
  const nth = normalized.match(/\b(\d+)(st|nd|rd|th)\b/);
  if (nth) return nth[1];
  const word = normalized.match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/
  );
  if (word) {
    const map: Record<string, string> = {
      first: "1",
      second: "2",
      third: "3",
      fourth: "4",
      fifth: "5",
      sixth: "6",
      seventh: "7",
      eighth: "8",
      ninth: "9",
      tenth: "10"
    };
    return map[word[1]];
  }
  if (normalized.includes("most")) return "1";
  if (normalized.includes("least")) return "last";
  return null;
}

function projectTokens(tokens: string[]): string[] {
  return tokens.filter(
    (token) =>
      token.length >= 2 &&
      !FDV_TEMPLATE_TOKENS.has(token) &&
      !/^\d+$/.test(token)
  );
}

function sharesProjectToken(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const setA = new Set(a);
  return b.some((token) => setA.has(token));
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersect = 0;
  for (const token of setA) {
    if (setB.has(token)) intersect += 1;
  }
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function isLikelyCalendarNumber(numVal: number): boolean {
  if (!Number.isInteger(numVal)) return false;
  return numVal >= 1900 && numVal <= 2100;
}

function extractComparableNumbers(value: string): Set<string> {
  const set = new Set<string>();
  if (!value) return set;
  const normalized = normalizeText(value);
  if (!normalized) return set;
  const parts = normalized.split(" ");
  for (let i = 0; i < parts.length; i += 1) {
    const token = parts[i];
    if (!/^\d+(\.\d+)?$/.test(token)) continue;
    const numVal = Number(token);
    if (!Number.isFinite(numVal)) continue;
    if (isLikelyCalendarNumber(numVal)) continue;
    const prev = parts[i - 1] ?? "";
    if (prev === "q" && Number.isInteger(numVal) && numVal >= 1 && numVal <= 4) continue;
    set.add(numVal.toString());
  }
  return set;
}

function numberScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0.5;
  let intersect = 0;
  for (const value of a) {
    if (b.has(value)) intersect += 1;
  }
  // Use overlap coefficient so that "2026" vs "Dec 31, 2026" can still score as a match
  // when comparable non-calendar numbers align.
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : intersect / denom;
}

function hasNumericConflict(a: Set<string>, b: Set<string>): boolean {
  if (!a.size || !b.size) return false;
  for (const value of a) {
    if (b.has(value)) return false;
  }
  return true;
}

function parseDate(value: string | undefined | null): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function daysBetween(a: number, b: number) {
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

function csvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function unwrapArray(res: unknown, keys: string[]): AnyRecord[] {
  if (Array.isArray(res)) return res as AnyRecord[];
  if (res && typeof res === "object") {
    const obj = res as AnyRecord;
    for (const key of keys) {
      const maybe = obj[key];
      if (Array.isArray(maybe)) return maybe as AnyRecord[];
    }
  }
  return [];
}

function pickString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function joinNonEmpty(parts: string[]): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(" ");
}

function toMatchMarketFromPolymarket(market: PolymarketMarket): MatchMarket {
  return {
    exchange: "polymarket",
    id: market.marketSlug || market.id,
    title: market.question ?? "",
    subtitle: "",
    outcomes: market.outcomes ?? [],
    endDate: market.endDate ?? "",
    rulesText: joinNonEmpty([market.description ?? "", market.resolutionSource ?? ""]),
    description: market.description ?? "",
    status:
      market.closed === true
        ? "closed"
        : market.active === false
          ? "inactive"
          : "active"
  };
}

function toMatchMarketFromKalshi(market: KalshiMarket): MatchMarket {
  return {
    exchange: "kalshi",
    id: market.ticker ?? "",
    title: market.title ?? "",
    subtitle: market.subtitle ?? "",
    outcomes: ["Yes", "No"],
    endDate: market.closeTime ?? "",
    rulesText: market.rulesText ?? "",
    description: "",
    status: market.status ?? ""
  };
}

function toMatchMarketFromLimitless(market: LimitlessMarket): MatchMarket | null {
  const slug = market.slug ?? "";
  if (!slug) return null;
  const title = joinNonEmpty([
    market.parentTitle ?? "",
    market.title ?? ""
  ]);
  const subtitle = market.proxyTitle ?? "";
  const endDate =
    market.expirationDate ??
    (market.expirationTimestamp
      ? new Date(market.expirationTimestamp).toISOString()
      : "");
  return {
    exchange: "limitless",
    id: slug,
    title,
    subtitle,
    outcomes: ["Yes", "No"],
    endDate,
    rulesText: market.description ?? "",
    description: market.description ?? "",
    status: market.status ?? ""
  };
}

function toMatchMarketFromProbable(market: ProbableMarket): MatchMarket | null {
  const slug = market.marketSlug ?? "";
  if (!slug) return null;
  return {
    exchange: "probable",
    id: slug,
    title: market.question ?? slug,
    subtitle: "",
    outcomes: market.outcomes ?? ["Yes", "No"],
    endDate: market.endDate ?? "",
    rulesText: market.description ?? "",
    description: market.description ?? "",
    status: market.active === false || market.closed ? "closed" : "active"
  };
}

async function fetchAllPolymarketMarkets(): Promise<PolymarketMarket[]> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const limit = num(process.env.POLY_MARKETS_LIMIT, 100);
  const maxMarkets = num(process.env.POLY_MAX_MARKETS, 0);
  const onlyActive = parseBool(process.env.POLY_ONLY_ACTIVE, true);
  const onlyOpen = parseBool(process.env.POLY_ONLY_OPEN, true);
  const onlyOrderbook = parseBool(process.env.POLY_ONLY_ORDERBOOK, true);
  const stopOnKnown = parseBool(process.env.DISCOVER_STOP_ON_KNOWN, false);
  const useEventsRaw = parseBool(process.env.POLY_USE_EVENTS, true);
  // For incremental "fresh" indexing, prefer /markets so we can stop as soon as
  // we hit already-indexed market slugs (newest-first ordering).
  const useEvents = useEventsRaw && !(stopOnKnown && parseBool(process.env.DISCOVER_INCREMENTAL, true));
  const progress = parseBool(process.env.DISCOVER_PROGRESS, true);
  const incremental = parseBool(process.env.DISCOVER_INCREMENTAL, true);
  const refreshEvents = parseBool(process.env.POLY_REFRESH_EVENTS, false);
  const cacheOnly = parseBool(process.env.DISCOVER_CACHE_ONLY, false);
  const eventPages = num(process.env.POLY_EVENT_PAGES, 0);
  const dataDir = process.env.DATA_DIR ?? "data";
  const retryOpts: RetryOptions = {
    timeoutMs: num(process.env.DISCOVER_TIMEOUT_MS, 15000),
    maxRetries: num(process.env.DISCOVER_RETRIES, 6),
    baseDelayMs: num(process.env.DISCOVER_RETRY_BASE_MS, 800),
    progress,
    retryForever: parseBool(process.env.DISCOVER_RETRY_FOREVER, false),
    requestDelayMs: num(process.env.DISCOVER_REQUEST_DELAY_MS, 0),
    min429DelayMs: num(process.env.DISCOVER_429_MIN_MS, 0)
  };
  const pageDelayMs = num(process.env.DISCOVER_PAGE_DELAY_MS, 0);

  const markets: PolymarketMarket[] = [];
  const knownMarketSlugs = new Set<string>();
  const knownEventSlugs = new Set<string>();
  let cachedMarkets: PolymarketMarket[] = [];
  if (incremental || cacheOnly) {
    const cachePath = path.join(dataDir, "polymarket_markets.json");
    if (fs.existsSync(cachePath)) {
      try {
        cachedMarkets = JSON.parse(fs.readFileSync(cachePath, "utf8")) as PolymarketMarket[];
        for (const market of cachedMarkets) {
          if (market.marketSlug) knownMarketSlugs.add(market.marketSlug);
          if (market.eventSlug) knownEventSlugs.add(market.eventSlug);
        }
        if (progress) {
          console.log(
            `[DISCOVER] Polymarket cache loaded markets=${cachedMarkets.length} events=${knownEventSlugs.size}`
          );
        }
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Polymarket cache: ${(err as Error).message}`);
      }
    }
  }

  if (cacheOnly && cachedMarkets.length) {
    return cachedMarkets;
  }

  if (useEvents) {
    let offset = 0;
    let pageCount = 0;
    while (true) {
      const query = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order: "id",
        ascending: "false"
      });
      if (onlyActive) query.set("active", "true");
      if (onlyOpen) query.set("closed", "false");

      const url = `${gammaBase}/events?${query.toString()}`;
      const res = await fetchJsonWithRetry<unknown>(url, {}, retryOpts);
      const events = unwrapArray(res, ["events"]);
      if (!events.length) break;
      if (progress) {
        console.log(
          `[DISCOVER] Polymarket events offset=${offset} events=${events.length} markets=${markets.length}`
        );
      }

      for (const event of events) {
        const eventSlug = pickString(event.slug ?? event.eventSlug);
        if (incremental && !refreshEvents && eventSlug && knownEventSlugs.has(eventSlug)) {
          continue;
        }
        const eventActive = event.active ?? null;
        const eventClosed = event.closed ?? null;
        const eventEndDate = pickString(event.endDate ?? event.closeTime ?? event.expirationDate);
        const eventDesc = pickString(event.description ?? event.details);
        const eventResolution = pickString(event.resolutionSource ?? event.resolution_source);

        const eventMarkets = unwrapArray(event.markets, ["markets"]);
        for (const market of eventMarkets) {
          const marketActive =
            typeof market.active === "boolean" ? market.active : eventActive;
          const marketClosed =
            typeof market.closed === "boolean" ? market.closed : eventClosed;
          const marketEnable =
            typeof market.enableOrderBook === "boolean"
              ? market.enableOrderBook
              : typeof market.enable_order_book === "boolean"
                ? market.enable_order_book
                : null;

          if (onlyActive && marketActive === false) continue;
          if (onlyOpen && marketClosed === true) continue;
          if (onlyOrderbook && marketEnable === false) continue;

          const question = pickString(
            market.question ?? market.title ?? market.name ?? event.title
          );
          const marketSlug = pickString(market.slug ?? market.marketSlug);
          if (incremental && marketSlug && knownMarketSlugs.has(marketSlug)) {
            continue;
          }
          markets.push({
            id: pickString(market.id ?? market.marketId ?? market.slug ?? ""),
            marketSlug,
            eventSlug,
            question,
            description: pickString(market.description ?? eventDesc),
            resolutionSource: pickString(market.resolutionSource ?? eventResolution),
            outcomes: parseArray(market.outcomes),
            endDate: pickString(market.endDate ?? eventEndDate),
            active: typeof marketActive === "boolean" ? marketActive : null,
            closed: typeof marketClosed === "boolean" ? marketClosed : null,
            enableOrderBook:
              typeof marketEnable === "boolean" ? marketEnable : null
          });
          if (maxMarkets > 0 && markets.length >= maxMarkets) {
            if (progress) {
              console.log(
                `[DISCOVER] Polymarket reached POLY_MAX_MARKETS=${maxMarkets}`
              );
            }
            return markets;
          }
        }
      }

      if (events.length < limit) break;
      offset += limit;
      pageCount += 1;
      if (eventPages > 0 && pageCount >= eventPages) break;
      if (pageDelayMs > 0) await sleep(pageDelayMs);
    }
  }

  if (!markets.length) {
    let offset = 0;
    while (true) {
      const query = new URLSearchParams({
        limit: String(limit),
        offset: String(offset),
        order: "id",
        ascending: "false"
      });
      if (onlyActive) query.set("active", "true");
      if (onlyOpen) query.set("closed", "false");

      const url = `${gammaBase}/markets?${query.toString()}`;
      const res = await fetchJsonWithRetry<unknown>(url, {}, retryOpts);
      const rawMarkets = unwrapArray(res, ["markets"]);
      if (!rawMarkets.length) break;
      if (progress) {
        console.log(
          `[DISCOVER] Polymarket markets offset=${offset} markets=${rawMarkets.length} total=${markets.length}`
        );
      }

      for (const market of rawMarkets) {
        const marketActive =
          typeof market.active === "boolean" ? market.active : null;
        const marketClosed =
          typeof market.closed === "boolean" ? market.closed : null;
        const marketEnable =
          typeof market.enableOrderBook === "boolean"
            ? market.enableOrderBook
            : typeof market.enable_order_book === "boolean"
              ? market.enable_order_book
              : null;

        if (onlyActive && marketActive === false) continue;
        if (onlyOpen && marketClosed === true) continue;
        if (onlyOrderbook && marketEnable === false) continue;

        const marketSlug = pickString(market.slug ?? market.marketSlug);
        if (incremental && marketSlug && knownMarketSlugs.has(marketSlug)) {
          if (stopOnKnown) {
            if (progress) {
              console.log(`[DISCOVER] Polymarket hit known market=${marketSlug}; stopping.`);
            }
            return markets;
          }
          continue;
        }
        markets.push({
          id: pickString(market.id ?? market.marketId ?? market.slug ?? ""),
          marketSlug,
          eventSlug: pickString(market.eventSlug ?? market.event_slug),
          question: pickString(market.question ?? market.title ?? market.name ?? ""),
          description: pickString(market.description ?? market.details),
          resolutionSource: pickString(market.resolutionSource ?? market.resolution_source),
          outcomes: parseArray(market.outcomes),
          endDate: pickString(market.endDate ?? market.closeTime ?? market.expirationDate),
          active: typeof marketActive === "boolean" ? marketActive : null,
          closed: typeof marketClosed === "boolean" ? marketClosed : null,
          enableOrderBook:
            typeof marketEnable === "boolean" ? marketEnable : null
        });
        if (maxMarkets > 0 && markets.length >= maxMarkets) {
          if (progress) {
            console.log(
              `[DISCOVER] Polymarket reached POLY_MAX_MARKETS=${maxMarkets}`
            );
          }
          return markets;
        }
      }

      if (rawMarkets.length < limit) break;
      offset += limit;
      if (pageDelayMs > 0) await sleep(pageDelayMs);
    }
  }

  return markets;
}

async function fetchAllKalshiMarkets(): Promise<KalshiMarket[]> {
  const base = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const limit = num(process.env.KALSHI_MARKETS_LIMIT, 200);
  const eventLimit = num(process.env.KALSHI_EVENTS_LIMIT, 200);
  const maxMarkets = num(process.env.KALSHI_MAX_MARKETS, 0);
  const statusList = parseStatusList(process.env.KALSHI_STATUS ?? "active");
  const useEvents = parseBool(process.env.KALSHI_USE_EVENTS, true);
  const useEventMarkets = parseBool(process.env.KALSHI_EVENTS_WITH_MARKETS, true);
  const eventStatus = normalizeKalshiEventStatus(
    process.env.KALSHI_EVENT_STATUS ?? "open"
  );
  const eventMarketFallback = parseBool(
    process.env.KALSHI_EVENT_MARKET_FALLBACK,
    false
  );
  const progress = parseBool(process.env.DISCOVER_PROGRESS, true);
  const incremental = parseBool(process.env.DISCOVER_INCREMENTAL, true);
  const refreshEvents = parseBool(process.env.KALSHI_REFRESH_EVENTS, false);
  const stopOnKnown = parseBool(process.env.DISCOVER_STOP_ON_KNOWN, false);
  const cacheOnly = parseBool(process.env.DISCOVER_CACHE_ONLY, false);
  const eventPages = num(process.env.KALSHI_EVENT_PAGES, 0);
  const dataDir = process.env.DATA_DIR ?? "data";
  const retryOpts: RetryOptions = {
    timeoutMs: num(process.env.DISCOVER_TIMEOUT_MS, 15000),
    maxRetries: num(process.env.DISCOVER_RETRIES, 6),
    baseDelayMs: num(process.env.DISCOVER_RETRY_BASE_MS, 800),
    progress,
    retryForever: parseBool(process.env.DISCOVER_RETRY_FOREVER, false),
    requestDelayMs: num(process.env.DISCOVER_REQUEST_DELAY_MS, 0),
    min429DelayMs: num(process.env.DISCOVER_429_MIN_MS, 0)
  };
  const pageDelayMs = num(process.env.DISCOVER_PAGE_DELAY_MS, 0);

  const markets: KalshiMarket[] = [];
  const seenTickers = new Set<string>();
  const knownEventTickers = new Set<string>();
  let cachedMarkets: KalshiMarket[] = [];
  if (incremental || cacheOnly) {
    const cachePath = path.join(dataDir, "kalshi_markets.json");
    if (fs.existsSync(cachePath)) {
      try {
        cachedMarkets = JSON.parse(fs.readFileSync(cachePath, "utf8")) as KalshiMarket[];
        for (const market of cachedMarkets) {
          if (market.ticker) seenTickers.add(market.ticker);
          if (market.eventTicker) knownEventTickers.add(market.eventTicker);
        }
        if (progress) {
          console.log(
            `[DISCOVER] Kalshi cache loaded markets=${cachedMarkets.length} events=${knownEventTickers.size}`
          );
        }
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Kalshi cache: ${(err as Error).message}`);
      }
    }
  }

  if (cacheOnly && cachedMarkets.length) {
    return cachedMarkets;
  }

  const shouldIncludeStatus = (status: string) => {
    if (!statusList.length) return true;
    const normalized = status.toLowerCase();
    return statusList.includes(normalized);
  };

  const pushMarket = (
    market: AnyRecord,
    context?: { eventTitle?: string; eventSubtitle?: string }
  ): boolean => {
    const ticker = pickString(market.ticker ?? market.market_ticker);
    if (!ticker || seenTickers.has(ticker)) return false;
    const status = pickString(market.status ?? market.state);
    if (status && !shouldIncludeStatus(status)) return false;

    const eventTitle = pickString(context?.eventTitle);
    const eventSubtitle = pickString(context?.eventSubtitle);
    const marketTitle = pickString(market.title ?? market.subtitle ?? "");
    const marketSubtitle = joinNonEmpty([
      pickString(market.subtitle ?? ""),
      pickString(market.yes_sub_title ?? market.yes_subtitle ?? market.yes_subTitle ?? ""),
      pickString(market.no_sub_title ?? market.no_subtitle ?? market.no_subTitle ?? "")
    ]);
    const title = joinNonEmpty([eventTitle, marketTitle]);
    const subtitle = joinNonEmpty([eventSubtitle, marketSubtitle]);

    const rulesText = joinNonEmpty([
      pickString(market.rules_primary ?? market.rulesPrimary),
      pickString(market.rules_secondary ?? market.rulesSecondary),
      pickString(market.rules ?? market.rulebook),
      pickString(market.rules_summary ?? market.rulesSummary),
      pickString(market.settlement_source ?? market.settlementSource)
    ]);

    markets.push({
      ticker,
      title: title || pickString(market.title ?? market.subtitle ?? ""),
      subtitle: subtitle || pickString(market.subtitle ?? market.short_title),
      eventTicker: pickString(market.event_ticker ?? market.eventTicker),
      status,
      closeTime: pickString(market.close_time ?? market.closeTime ?? market.expiration_time),
      rulesText,
      outcomeType: pickString(market.outcome_type ?? market.outcomeType ?? "")
    });
    seenTickers.add(ticker);
    return true;
  };

  if (useEvents) {
    let cursor = "";
    let pageCount = 0;
    let safety = 0;
    while (safety < 20000) {
      safety += 1;
      const query = new URLSearchParams({ limit: String(eventLimit) });
      if (cursor) query.set("cursor", cursor);
      if (eventStatus) query.set("status", eventStatus);
      if (useEventMarkets) query.set("with_nested_markets", "true");
      const url = `${base}/events?${query.toString()}`;
      const res = await fetchJsonWithRetry<unknown>(url, {}, retryOpts);
      const events = unwrapArray(res, ["events"]);
      if (!events.length) break;
      let pageAdded = 0;
      let pageSawKnown = false;
      if (progress) {
        console.log(
          `[DISCOVER] Kalshi events cursor=${cursor || "start"} events=${events.length} totalMarkets=${markets.length}`
        );
      }

      for (const event of events) {
        const eventTicker = pickString(event.event_ticker ?? event.eventTicker);
        if (!eventTicker) continue;
        if (incremental && knownEventTickers.has(eventTicker)) {
          pageSawKnown = true;
        }
        if (incremental && !refreshEvents && knownEventTickers.has(eventTicker)) {
          continue;
        }
        let eventMarkets: AnyRecord[] = [];
        const eventTitle = pickString(event.title ?? event.name ?? "");
        const eventSubtitle = pickString(event.sub_title ?? event.subtitle ?? "");
        if (useEventMarkets) {
          eventMarkets = unwrapArray(event.markets, ["markets"]);
        }

        if (eventMarkets.length) {
          for (const market of eventMarkets) {
            if (pushMarket(market, { eventTitle, eventSubtitle })) {
              pageAdded += 1;
            }
            if (maxMarkets > 0 && markets.length >= maxMarkets) {
              if (progress) {
                console.log(
                  `[DISCOVER] Kalshi reached KALSHI_MAX_MARKETS=${maxMarkets}`
                );
              }
              return markets;
            }
          }
        } else if (eventMarketFallback) {
          let marketCursor = "";
          let marketSafety = 0;
          while (marketSafety < 500) {
            marketSafety += 1;
            const mQuery = new URLSearchParams({
              limit: String(limit),
              event_ticker: eventTicker
            });
            if (marketCursor) mQuery.set("cursor", marketCursor);
            const mUrl = `${base}/markets?${mQuery.toString()}`;
            const mRes = await fetchJsonWithRetry<unknown>(mUrl, {}, retryOpts);
            const rawMarkets = unwrapArray(mRes, ["markets"]);
            if (!rawMarkets.length) break;

            for (const market of rawMarkets) {
              if (pushMarket(market, { eventTitle, eventSubtitle })) {
                pageAdded += 1;
              }
              if (maxMarkets > 0 && markets.length >= maxMarkets) {
                if (progress) {
                  console.log(
                    `[DISCOVER] Kalshi reached KALSHI_MAX_MARKETS=${maxMarkets}`
                  );
                }
                return markets;
              }
            }

            const mObj = mRes as AnyRecord;
            const nextMarketCursor = pickString(
              mObj.next_cursor ?? mObj.cursor ?? mObj.nextCursor
            );
            if (!nextMarketCursor || nextMarketCursor === marketCursor) break;
            marketCursor = nextMarketCursor;
            if (pageDelayMs > 0) await sleep(pageDelayMs);
          }
        }
      }

      const resObj = res as AnyRecord;
      const nextCursor = pickString(resObj.next_cursor ?? resObj.cursor ?? resObj.nextCursor);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
      pageCount += 1;
      if (eventPages > 0 && pageCount >= eventPages) break;
      if (pageDelayMs > 0) await sleep(pageDelayMs);

      if (stopOnKnown && incremental && pageSawKnown && pageAdded === 0) {
        if (progress) {
          console.log("[DISCOVER] Kalshi stop-on-known reached; stopping.");
        }
        break;
      }
    }
  } else {
    let cursor = "";
    let safety = 0;
    let statusFallbackUsed = false;
    let statusParam = statusList[0] ?? "";
    while (safety < 20000) {
      safety += 1;
      const query = new URLSearchParams({ limit: String(limit) });
      if (statusParam) query.set("status", statusParam);
      if (cursor) query.set("cursor", cursor);
      const url = `${base}/markets?${query.toString()}`;
      let res: unknown;
      try {
        res = await fetchJsonWithRetry<unknown>(url, {}, retryOpts);
      } catch (err) {
        const message = (err as Error).message ?? "";
        if (!statusFallbackUsed && message.toLowerCase().includes("invalid status filter")) {
          statusFallbackUsed = true;
          if (progress) {
            console.warn(
              `[DISCOVER] Kalshi status "${statusParam}" rejected; retrying without status filter.`
            );
          }
          statusParam = "";
          cursor = "";
          continue;
        }
        throw err;
      }
      const rawMarkets = unwrapArray(res, ["markets"]);
      if (!rawMarkets.length) break;
      if (progress) {
        console.log(
          `[DISCOVER] Kalshi cursor=${cursor || "start"} markets=${rawMarkets.length} total=${markets.length}`
        );
      }

      for (const market of rawMarkets) {
        pushMarket(market);
        if (maxMarkets > 0 && markets.length >= maxMarkets) {
          if (progress) {
            console.log(
              `[DISCOVER] Kalshi reached KALSHI_MAX_MARKETS=${maxMarkets}`
            );
          }
          return markets;
        }
      }

      const resObj = res as AnyRecord;
      const nextCursor = pickString(resObj.next_cursor ?? resObj.cursor ?? resObj.nextCursor);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
      if (pageDelayMs > 0) await sleep(pageDelayMs);
    }
  }

  return markets;
}

async function fetchAllLimitlessMarkets(): Promise<LimitlessMarket[]> {
  const baseRaw = process.env.LIMITLESS_BASE_URL ?? "https://api.limitless.exchange";
  const baseCandidates = buildLimitlessBaseCandidates(baseRaw);
  let activeBase: string | null = null;
  const limitRaw = num(process.env.LIMITLESS_MARKETS_LIMIT, 25);
  const limit = Math.min(25, Math.max(1, limitRaw));
  const maxMarkets = num(process.env.LIMITLESS_MAX_MARKETS, 0);
  const progress = parseBool(process.env.DISCOVER_PROGRESS, true);
  const incremental = parseBool(process.env.DISCOVER_INCREMENTAL, true);
  const stopOnKnown = parseBool(process.env.DISCOVER_STOP_ON_KNOWN, false);
  const cacheOnly = parseBool(process.env.DISCOVER_CACHE_ONLY, false);
  const dataDir = process.env.DATA_DIR ?? "data";
  const retryOpts: RetryOptions = {
    timeoutMs: num(process.env.DISCOVER_TIMEOUT_MS, 15000),
    maxRetries: num(process.env.DISCOVER_RETRIES, 6),
    baseDelayMs: num(process.env.DISCOVER_RETRY_BASE_MS, 800),
    progress,
    retryForever: parseBool(process.env.DISCOVER_RETRY_FOREVER, false),
    requestDelayMs: num(process.env.DISCOVER_REQUEST_DELAY_MS, 0),
    min429DelayMs: num(process.env.DISCOVER_429_MIN_MS, 0)
  };

  const fetchLimitless = async <T>(path: string): Promise<T> => {
    const urlPath = path.startsWith("/") ? path : `/${path}`;
    const ordered = activeBase
      ? [activeBase, ...baseCandidates.filter((b) => b !== activeBase)]
      : baseCandidates;
    let lastErr: unknown;
    for (const base of ordered) {
      try {
        const res = await fetchJsonWithRetry<T>(`${base}${urlPath}`, {}, retryOpts);
        activeBase = base;
        return res;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error("Failed to fetch Limitless markets.");
  };

  const knownSlugs = new Set<string>();
  let cachedMarkets: LimitlessMarket[] = [];
  const cachePath = path.join(dataDir, "limitless_markets.json");
  if (incremental || cacheOnly) {
    if (fs.existsSync(cachePath)) {
      try {
        cachedMarkets = JSON.parse(fs.readFileSync(cachePath, "utf8")) as LimitlessMarket[];
        for (const market of cachedMarkets) {
          if (market.slug) knownSlugs.add(market.slug);
        }
        if (progress) {
          console.log(
            `[DISCOVER] Limitless cache loaded markets=${cachedMarkets.length}`
          );
        }
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Limitless cache: ${(err as Error).message}`);
      }
    }
  }

  if (cacheOnly && cachedMarkets.length) {
    return cachedMarkets;
  }

  const markets: LimitlessMarket[] = [];

  const pushMarket = (raw: AnyRecord, parent?: LimitlessMarket) => {
    const marketType = pickString(raw.marketType);
    if (marketType === "group" && Array.isArray(raw.markets)) {
      const group: LimitlessMarket = {
        slug: pickString(raw.slug),
        title: pickString(raw.title)
      };
      for (const child of raw.markets as AnyRecord[]) {
        pushMarket(child, group);
      }
      return;
    }

    const slug = pickString(raw.slug);
    if (!slug) return;
    if (incremental && knownSlugs.has(slug)) return;

    const market: LimitlessMarket = {
      id: typeof raw.id === "number" ? raw.id : Number(raw.id),
      slug,
      title: pickString(raw.title),
      proxyTitle: pickString(raw.proxyTitle),
      description: pickString(raw.description),
      expirationDate: pickString(raw.expirationDate),
      expirationTimestamp: Number(raw.expirationTimestamp),
      status: pickString(raw.status),
      tradeType: pickString(raw.tradeType),
      marketType: pickString(raw.marketType),
      parentTitle: parent?.title,
      parentSlug: parent?.slug
    };

    markets.push(market);
  };

  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  while (markets.length < total) {
    const query = new URLSearchParams({
      limit: String(limit),
      page: String(page)
    });
    const res = await fetchLimitless<unknown>(
      `/markets/active?${query.toString()}`
    );
    const obj = res as AnyRecord;
    const data = Array.isArray(obj.data) ? (obj.data as AnyRecord[]) : [];
    let pageAdded = 0;
    let pageSawKnown = false;

    const totalCount = Number(obj.totalMarketsCount ?? obj.totalCount ?? 0);
    if (Number.isFinite(totalCount) && totalCount > 0) {
      total = totalCount;
    }

    for (const raw of data) {
      const slug = pickString(raw.slug);
      if (incremental && slug && knownSlugs.has(slug)) pageSawKnown = true;
      const before = markets.length;
      pushMarket(raw);
      if (markets.length > before) pageAdded += markets.length - before;
      if (maxMarkets > 0 && markets.length >= maxMarkets) {
        if (progress) {
          console.log(
            `[DISCOVER] Limitless reached LIMITLESS_MAX_MARKETS=${maxMarkets}`
          );
        }
        return markets;
      }
    }

    if (progress) {
      console.log(
        `[DISCOVER] Limitless page=${page} markets=${markets.length}`
      );
    }

    if (data.length < limit) break;
    page += 1;

    if (stopOnKnown && incremental && pageSawKnown && pageAdded === 0) {
      if (progress) {
        console.log("[DISCOVER] Limitless stop-on-known reached; stopping.");
      }
      break;
    }
  }

  return markets;
}

async function fetchAllProbableMarkets(): Promise<ProbableMarket[]> {
  const base = process.env.PROB_MARKET_BASE ?? "https://market-api.probable.markets";
  const limitRaw = num(process.env.PROB_MARKETS_LIMIT, 20);
  const limit = Math.min(20, Math.max(1, limitRaw));
  const maxMarkets = num(process.env.PROB_MAX_MARKETS, 0);
  const onlyActive = parseBool(process.env.PROB_ONLY_ACTIVE, true);
  const onlyOpen = parseBool(process.env.PROB_ONLY_OPEN, true);
  const progress = parseBool(process.env.DISCOVER_PROGRESS, true);
  const incremental = parseBool(process.env.DISCOVER_INCREMENTAL, true);
  const stopOnKnown = parseBool(process.env.DISCOVER_STOP_ON_KNOWN, false);
  const cacheOnly = parseBool(process.env.DISCOVER_CACHE_ONLY, false);
  const dataDir = process.env.DATA_DIR ?? "data";
  const retryOpts: RetryOptions = {
    timeoutMs: num(process.env.DISCOVER_TIMEOUT_MS, 15000),
    maxRetries: num(process.env.DISCOVER_RETRIES, 6),
    baseDelayMs: num(process.env.DISCOVER_RETRY_BASE_MS, 800),
    progress,
    retryForever: parseBool(process.env.DISCOVER_RETRY_FOREVER, false),
    requestDelayMs: num(process.env.DISCOVER_REQUEST_DELAY_MS, 0),
    min429DelayMs: num(process.env.DISCOVER_429_MIN_MS, 0)
  };

  const cachePath = path.join(dataDir, "probable_markets.json");
  const knownSlugs = new Set<string>();
  let cachedMarkets: ProbableMarket[] = [];
  if (incremental || cacheOnly) {
    if (fs.existsSync(cachePath)) {
      try {
        cachedMarkets = JSON.parse(fs.readFileSync(cachePath, "utf8")) as ProbableMarket[];
        for (const market of cachedMarkets) {
          if (market.marketSlug) knownSlugs.add(market.marketSlug);
        }
        if (progress) {
          console.log(
            `[DISCOVER] Probable cache loaded markets=${cachedMarkets.length}`
          );
        }
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Probable cache: ${(err as Error).message}`);
      }
    }
  }

  if (cacheOnly && cachedMarkets.length) {
    return cachedMarkets;
  }

  const markets: ProbableMarket[] = [];
  let page = 1;
  while (true) {
    const query = new URLSearchParams({
      page: String(page),
      limit: String(limit)
    });
    if (onlyActive) query.set("active", "true");
    if (onlyOpen) query.set("closed", "false");

    const url = `${base}/public/api/v1/markets/?${query.toString()}`;
    const res = await fetchJsonWithRetry<unknown>(url, {}, retryOpts);
    const obj = res as AnyRecord;
    const data = Array.isArray(obj.markets)
      ? (obj.markets as AnyRecord[])
      : Array.isArray(obj.results)
        ? (obj.results as AnyRecord[])
        : Array.isArray(obj)
          ? (obj as AnyRecord[])
          : Array.isArray(obj.data)
            ? (obj.data as AnyRecord[])
            : [];

    if (!data.length) break;
    let pageAdded = 0;
    let pageSawKnown = false;
    if (progress) {
      console.log(
        `[DISCOVER] Probable page=${page} markets=${markets.length}`
      );
    }

    for (const raw of data) {
      const marketSlug = pickString(raw.market_slug ?? raw.marketSlug ?? raw.slug);
      if (!marketSlug) continue;
      if (incremental && knownSlugs.has(marketSlug)) {
        pageSawKnown = true;
        continue;
      }
      const market: ProbableMarket = {
        id: raw.id ?? marketSlug,
        marketSlug,
        question: pickString(raw.question ?? raw.title ?? raw.name),
        description: pickString(raw.description ?? raw.details),
        outcomes: parseArray(raw.outcomes ?? raw.outcomeTokens),
        endDate: pickString(raw.end_date ?? raw.endDate ?? raw.close_time),
        active: typeof raw.active === "boolean" ? raw.active : null,
        closed: typeof raw.closed === "boolean" ? raw.closed : null
      };
      if (onlyActive && market.active === false) continue;
      if (onlyOpen && market.closed === true) continue;
      markets.push(market);
      pageAdded += 1;
      if (maxMarkets > 0 && markets.length >= maxMarkets) {
        if (progress) {
          console.log(
            `[DISCOVER] Probable reached PROB_MAX_MARKETS=${maxMarkets}`
          );
        }
        return markets;
      }
    }

    if (data.length < limit) break;
    page += 1;

    if (stopOnKnown && incremental && pageSawKnown && pageAdded === 0) {
      if (progress) {
        console.log("[DISCOVER] Probable stop-on-known reached; stopping.");
      }
      break;
    }
  }

  return markets;
}

function isBinaryYesNo(outcomes: string[]): boolean {
  if (!outcomes.length) return false;
  const normalized = outcomes.map((o) => normalizeText(o));
  const set = new Set(normalized);
  return set.has("yes") && set.has("no") && set.size <= 2;
}

function buildTokenIndex(markets: MatchMarket[]) {
  const index = new Map<string, number[]>();

  markets.forEach((market, idx) => {
    const tokens = uniqueTokens(
      tokenize(`${market.title} ${market.subtitle}`.trim())
    ).filter((token) => token.length >= 4 && !/^\d+$/.test(token));
    for (const token of tokens) {
      const list = index.get(token) ?? [];
      list.push(idx);
      index.set(token, list);
    }
  });

  return { index };
}

function computeMatch(
  left: MatchMarket,
  right: MatchMarket,
  maxCloseDays: number,
  enforceBucket: boolean
): MatchRow | null {
  const leftTitle = joinNonEmpty([left.title, left.subtitle]);
  const rightTitle = joinNonEmpty([right.title, right.subtitle]);
  const leftRules = left.rulesText ?? "";
  const rightRules = right.rulesText ?? "";

  const leftTitleTokens = uniqueTokens(tokenize(leftTitle));
  const rightTitleTokens = uniqueTokens(tokenize(rightTitle));
  if (isMnaTitle(leftTitle) && isMnaTitle(rightTitle)) {
    const leftEntities = mnaEntityTokens(leftTitle, leftTitleTokens);
    const rightEntities = mnaEntityTokens(rightTitle, rightTitleTokens);
    if (!entitiesCompatible(leftEntities, rightEntities)) {
      return null;
    }
  }
  if (isFdvOneDay(leftTitle) && isFdvOneDay(rightTitle)) {
    const leftProject = projectTokens(leftTitleTokens);
    const rightProject = projectTokens(rightTitleTokens);
    if (!sharesProjectToken(leftProject, rightProject)) {
      return null;
    }
  }
  const leftMedal = medalCategory(leftTitle);
  const rightMedal = medalCategory(rightTitle);
  if (leftMedal && rightMedal && leftMedal !== rightMedal) {
    return null;
  }
  const leftPlace = medalPlacement(leftTitle);
  const rightPlace = medalPlacement(rightTitle);
  if (leftPlace && rightPlace && leftPlace !== rightPlace) {
    return null;
  }
  const leftTitleTokensNoNums = leftTitleTokens.filter((t) => !/^\d+$/.test(t));
  const rightTitleTokensNoNums = rightTitleTokens.filter((t) => !/^\d+$/.test(t));
  const titleScore = jaccard(leftTitleTokensNoNums, rightTitleTokensNoNums);

  const leftComparableNums = extractComparableNumbers(leftTitle);
  const rightComparableNums = extractComparableNumbers(rightTitle);
  if (hasNumericConflict(leftComparableNums, rightComparableNums)) return null;
  const numScore = numberScore(leftComparableNums, rightComparableNums);
  // If both markets expose non-calendar numeric thresholds/ranges, require a full overlap.
  // This blocks false positives like "1.0-1.5%" incorrectly matching "3.0-3.5%".
  if (leftComparableNums.size && rightComparableNums.size && numScore < 1) return null;

  if (enforceBucket) {
    const leftBucket = parseBucket(leftTitle);
    const rightBucket = parseBucket(rightTitle);
    if (!bucketsCompatible(leftBucket, rightBucket)) {
      return null;
    }
  }

  const leftBinary = isBinaryYesNo(left.outcomes);
  const rightBinary = isBinaryYesNo(right.outcomes);
  const outcomeScore = leftBinary && rightBinary ? 1 : 0.4;

  const rulesScore =
    leftRules || rightRules
      ? jaccard(tokenize(leftRules), tokenize(rightRules))
      : null;

  const leftClose = parseDate(left.endDate);
  const rightClose = parseDate(right.endDate);
  let timeDiffDays: number | null = null;
  let timeConflict = false;
  if (leftClose !== null && rightClose !== null) {
    timeDiffDays = daysBetween(leftClose, rightClose);
    if (timeDiffDays > maxCloseDays) timeConflict = true;
  }
  if (timeConflict) return null;

  const score =
    0.6 * titleScore + 0.2 * numScore + 0.1 * outcomeScore + 0.1 * (rulesScore ?? 0);

  const reasons: string[] = [];
  if (!leftBinary) reasons.push("left_not_binary");
  if (!rightBinary) reasons.push("right_not_binary");
  if (!leftRules) reasons.push("left_rules_missing");
  if (!rightRules) reasons.push("right_rules_missing");
  if (rulesScore !== null && rulesScore < 0.2) reasons.push("rules_low_similarity");
  if (timeDiffDays !== null && timeDiffDays > maxCloseDays * 0.6) reasons.push("time_far");

  return {
    score,
    titleScore,
    numberScore: numScore,
    outcomeScore,
    rulesScore,
    timeDiffDays,
    reasons: reasons.join(";"),
    left,
    right
  };
}

function matchMarkets(
  leftMarkets: MatchMarket[],
  rightMarkets: MatchMarket[],
  opts: {
    highScore: number;
    reviewScore: number;
    rulesMinHigh: number;
    maxCloseDays: number;
    maxPerPm: number;
    enforceBucket: boolean;
    allowRulesBypass: boolean;
    titleOverride: number;
    numOverride: number;
    progress: boolean;
    logEvery: number;
    skipKeys?: Set<string>;
    onHigh?: (row: MatchRow) => void;
    onReview?: (row: MatchRow) => void;
  }
) {
  const { index } = buildTokenIndex(rightMarkets);
  let highCount = 0;
  let reviewCount = 0;
  const start = Date.now();

  for (let i = 0; i < leftMarkets.length; i += 1) {
    const left = leftMarkets[i];
    const leftTokens = uniqueTokens(
      tokenize(`${left.title} ${left.subtitle} ${left.description} ${left.rulesText}`)
    ).filter((token) => token.length >= 4 && !/^\d+$/.test(token));
    const candidateSet = new Set<number>();
    for (const token of leftTokens) {
      const list = index.get(token);
      if (!list) continue;
      for (const idx of list) candidateSet.add(idx);
    }

    if (!candidateSet.size) continue;
    const candidates: MatchRow[] = [];
    for (const idx of candidateSet) {
      const right = rightMarkets[idx];
      if (!right) continue;
      const key = `${left.exchange}::${left.id}::${right.exchange}::${right.id}`;
      if (opts.skipKeys?.has(key)) continue;
      const match = computeMatch(left, right, opts.maxCloseDays, opts.enforceBucket);
      if (!match) continue;
      candidates.push(match);
    }

    candidates.sort((a, b) => b.score - a.score);
    const sliced = candidates.slice(0, opts.maxPerPm);
    for (const match of sliced) {
      const hasRules = Boolean(match.left.rulesText) && Boolean(match.right.rulesText);
      const strongTitleMatch =
        match.titleScore >= opts.titleOverride && match.numberScore >= opts.numOverride;
      const rulesOk =
        match.rulesScore === null ||
        match.rulesScore >= opts.rulesMinHigh ||
        (opts.allowRulesBypass && strongTitleMatch);
      if (
        match.score >= opts.highScore &&
        hasRules &&
        rulesOk &&
        isBinaryYesNo(match.left.outcomes) && isBinaryYesNo(match.right.outcomes)
      ) {
        highCount += 1;
        opts.onHigh?.(match);
      } else if (match.score >= opts.reviewScore) {
        reviewCount += 1;
        opts.onReview?.(match);
      }
    }

    if (opts.progress && (i + 1) % opts.logEvery === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[MATCH] ${i + 1}/${leftMarkets.length} processed ` +
          `high=${highCount} review=${reviewCount} elapsed=${elapsed}s`
      );
    }
  }

  if (opts.progress) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[MATCH] done processed=${leftMarkets.length} high=${highCount} review=${reviewCount} ` +
        `elapsed=${elapsed}s`
    );
  }

  return { highCount, reviewCount };
}

function csvHeader() {
  return [
    "score",
    "title_score",
    "number_score",
    "outcome_score",
    "rules_score",
    "time_diff_days",
    "reasons",
    "a_exchange",
    "a_id",
    "a_title",
    "a_subtitle",
    "a_outcomes",
    "a_end_date",
    "a_rules",
    "a_description",
    "a_status",
    "b_exchange",
    "b_id",
    "b_title",
    "b_subtitle",
    "b_outcomes",
    "b_end_date",
    "b_rules",
    "b_description",
    "b_status"
  ].join(",");
}

function csvRow(row: MatchRow) {
  const left = row.left;
  const right = row.right;
  return [
    row.score.toFixed(4),
    row.titleScore.toFixed(4),
    row.numberScore.toFixed(4),
    row.outcomeScore.toFixed(4),
    row.rulesScore === null ? "" : row.rulesScore.toFixed(4),
    row.timeDiffDays === null ? "" : row.timeDiffDays.toFixed(2),
    row.reasons,
    left.exchange,
    left.id,
    left.title,
    left.subtitle,
    left.outcomes.join("|"),
    left.endDate,
    left.rulesText,
    left.description,
    left.status,
    right.exchange,
    right.id,
    right.title,
    right.subtitle,
    right.outcomes.join("|"),
    right.endDate,
    right.rulesText,
    right.description,
    right.status
  ]
    .map(csvValue)
    .join(",");
}

function mergeUnique<T>(base: T[], added: T[], keyFn: (item: T) => string) {
  const map = new Map<string, T>();
  for (const item of base) {
    const key = keyFn(item);
    if (key) map.set(key, item);
  }
  for (const item of added) {
    const key = keyFn(item);
    if (!key) continue;
    map.set(key, item);
  }
  return Array.from(map.values());
}

function createCsvWriter(filePath: string, header: string, flushEvery: number) {
  fs.writeFileSync(filePath, `${header}\n`, "utf8");
  const buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    fs.appendFileSync(filePath, `${buffer.join("\n")}\n`, "utf8");
    buffer.length = 0;
  };

  const writeRow = (row: MatchRow) => {
    buffer.push(csvRow(row));
    if (buffer.length >= flushEvery) flush();
  };

  const close = () => {
    flush();
  };

  return { writeRow, close };
}

function createCsvAppender(filePath: string, header: string, flushEvery: number) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
    fs.writeFileSync(filePath, `${header}\n`, "utf8");
  }

  const buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    fs.appendFileSync(filePath, `${buffer.join("\n")}\n`, "utf8");
    buffer.length = 0;
  };

  const writeRow = (row: MatchRow) => {
    buffer.push(csvRow(row));
    if (buffer.length >= flushEvery) flush();
  };

  const close = () => {
    flush();
  };

  return { writeRow, close };
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  ensureDir(dataDir);

  const writeMarkets = parseBool(process.env.WRITE_MARKETS, true);
  const highScore = num(process.env.MATCH_HIGH_SCORE, 0.82);
  const reviewScore = num(process.env.MATCH_REVIEW_SCORE, 0.7);
  const rulesMinHigh = num(process.env.MATCH_RULES_MIN, 0.25);
  const maxCloseDays = num(process.env.MATCH_MAX_CLOSE_DAYS, 14);
  const maxPerPm = num(process.env.MATCH_MAX_PER_PM, 10);
  const matchProgress = parseBool(process.env.DISCOVER_MATCH_PROGRESS, true);
  const matchLogEvery = num(process.env.DISCOVER_MATCH_LOG_EVERY, 100);
  const matchFlushEvery = Math.max(1, num(process.env.MATCH_FLUSH_EVERY, 1000));
  const matchWorkers = Math.max(1, num(process.env.MATCH_WORKERS, 1));
  const incremental = parseBool(process.env.DISCOVER_INCREMENTAL, true);
  const fresh = parseBool(process.env.DISCOVER_FRESH, false);
  const skipPoly = parseBool(process.env.DISCOVER_SKIP_POLY, false);
  const skipKalshi = parseBool(process.env.DISCOVER_SKIP_KALSHI, false);
  const pruneStale = parseBool(process.env.DISCOVER_PRUNE_STALE, false);
  const skipMatch = parseBool(process.env.DISCOVER_SKIP_MATCH, false);
  const allowRulesBypass = parseBool(process.env.MATCH_RULES_BYPASS, true);
  const titleOverride = num(process.env.MATCH_TITLE_OVERRIDE, 0.85);
  const numOverride = num(process.env.MATCH_NUM_OVERRIDE, 0.9);
  const enforceBucket = parseBool(process.env.MATCH_BUCKET_ENFORCE, true);
  const skipPmKal = parseBool(process.env.MATCH_SKIP_PM_KAL, false);
  const persistMatches = parseBool(process.env.MATCH_PERSIST, true);

  if (fresh) {
    // Default fresh runs to fast, incremental behavior unless explicitly disabled.
    if (process.env.DISCOVER_STOP_ON_KNOWN === undefined) {
      process.env.DISCOVER_STOP_ON_KNOWN = "true";
    }
    if (process.env.KALSHI_REFRESH_EVENTS === undefined) {
      process.env.KALSHI_REFRESH_EVENTS = "true";
    }
  }

  const [pmNew, kalNew, limNew, probNew] = await Promise.all([
    skipPoly ? Promise.resolve([]) : fetchAllPolymarketMarkets(),
    skipKalshi ? Promise.resolve([]) : fetchAllKalshiMarkets(),
    fetchAllLimitlessMarkets(),
    fetchAllProbableMarkets()
  ]);

  const pmPath = path.join(dataDir, "polymarket_markets.json");
  const kalPath = path.join(dataDir, "kalshi_markets.json");
  const limPath = path.join(dataDir, "limitless_markets.json");
  const probPath = path.join(dataDir, "probable_markets.json");
  let cachedPm: PolymarketMarket[] = [];
  let cachedKal: KalshiMarket[] = [];
  let cachedLim: LimitlessMarket[] = [];
  let cachedProb: ProbableMarket[] = [];
  if (incremental) {
    if (fs.existsSync(pmPath)) {
      try {
        cachedPm = JSON.parse(fs.readFileSync(pmPath, "utf8")) as PolymarketMarket[];
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Polymarket cache: ${(err as Error).message}`);
      }
    }
    if (fs.existsSync(kalPath)) {
      try {
        cachedKal = JSON.parse(fs.readFileSync(kalPath, "utf8")) as KalshiMarket[];
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Kalshi cache: ${(err as Error).message}`);
      }
    }
    if (fs.existsSync(limPath)) {
      try {
        cachedLim = JSON.parse(fs.readFileSync(limPath, "utf8")) as LimitlessMarket[];
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Limitless cache: ${(err as Error).message}`);
      }
    }
    if (fs.existsSync(probPath)) {
      try {
        cachedProb = JSON.parse(fs.readFileSync(probPath, "utf8")) as ProbableMarket[];
      } catch (err) {
        console.warn(`[DISCOVER] Failed to read Probable cache: ${(err as Error).message}`);
      }
    }
  }

  const pmKey = (m: PolymarketMarket) => m.marketSlug || m.id;
  const kalKey = (m: KalshiMarket) => m.ticker;
  const limKey = (m: LimitlessMarket) => m.slug || String(m.id ?? "");
  const probKey = (m: ProbableMarket) => m.marketSlug || String(m.id ?? "");

  const pmMerged = incremental ? mergeUnique(cachedPm, pmNew, pmKey) : pmNew;
  const kalMerged = incremental ? mergeUnique(cachedKal, kalNew, kalKey) : kalNew;
  const limMerged = incremental ? mergeUnique(cachedLim, limNew, limKey) : limNew;
  const probMerged = incremental
    ? mergeUnique(cachedProb, probNew, probKey)
    : probNew;

  const pmNewKeys = new Set(pmNew.map(pmKey).filter(Boolean));
  const kalNewKeys = new Set(kalNew.map(kalKey).filter(Boolean));
  const limNewKeys = new Set(limNew.map(limKey).filter(Boolean));
  const probNewKeys = new Set(probNew.map(probKey).filter(Boolean));

  const pmMarkets =
    pruneStale && pmNewKeys.size
      ? pmMerged.filter((m) => pmNewKeys.has(pmKey(m)))
      : pmMerged;
  const kalMarkets =
    pruneStale && kalNewKeys.size
      ? kalMerged.filter((m) => kalNewKeys.has(kalKey(m)))
      : kalMerged;
  const limMarkets =
    pruneStale && limNewKeys.size
      ? limMerged.filter((m) => limNewKeys.has(limKey(m)))
      : limMerged;
  const probMarkets =
    pruneStale && probNewKeys.size
      ? probMerged.filter((m) => probNewKeys.has(probKey(m)))
      : probMerged;

  if (writeMarkets) {
    fs.writeFileSync(pmPath, JSON.stringify(pmMarkets, null, 2), "utf8");
    fs.writeFileSync(kalPath, JSON.stringify(kalMarkets, null, 2), "utf8");
    fs.writeFileSync(limPath, JSON.stringify(limMarkets, null, 2), "utf8");
    fs.writeFileSync(probPath, JSON.stringify(probMarkets, null, 2), "utf8");
  }

  if (skipMatch) {
    console.log(
      `Indexed markets only. Polymarket markets=${pmMarkets.length} ` +
        `Kalshi markets=${kalMarkets.length} Limitless markets=${limMarkets.length} ` +
        `Probable markets=${probMarkets.length}`
    );
    return;
  }

  const highPath = path.join(dataDir, "market_matches_high.csv");
  const reviewPath = path.join(dataDir, "market_matches_review.csv");

  const existingHigh = persistMatches || fresh ? readExistingRows(highPath) : [];
  const existingReview = persistMatches || fresh ? readExistingRows(reviewPath) : [];

  let highCount = 0;
  let reviewCount = 0;

  const pmMatch = pmMarkets.map(toMatchMarketFromPolymarket);
  const kalMatch = kalMarkets.map(toMatchMarketFromKalshi);
  const limMatch = limMarkets
    .map(toMatchMarketFromLimitless)
    .filter((m): m is MatchMarket => Boolean(m));
  const probMatch = probMarkets
    .map(toMatchMarketFromProbable)
    .filter((m): m is MatchMarket => Boolean(m));

  const pmBySlug = new Map(pmMarkets.map((m) => [m.marketSlug, m]));
  const kalByTicker = new Map(kalMarkets.map((m) => [m.ticker, m]));
  const limBySlug = new Map(
    limMarkets.map((m) => [m.slug ?? String(m.id ?? ""), m])
  );
  const probBySlug = new Map(
    probMarkets.map((m) => [m.marketSlug ?? String(m.id ?? ""), m])
  );
  const skipKeys = persistMatches
    ? buildOpenSkipSet(
        existingHigh,
        existingReview,
        pmBySlug,
        kalByTicker,
        limBySlug,
        probBySlug
      )
    : new Set<string>();

  if (fresh) {
    if (!incremental) {
      console.warn(
        "[DISCOVER] DISCOVER_FRESH=true with DISCOVER_INCREMENTAL=false will behave like a full match."
      );
    }

    const reverseKey = (key: string) => {
      const parts = key.split("::");
      if (parts.length < 4) return key;
      return `${parts[2]}::${parts[3]}::${parts[0]}::${parts[1]}`;
    };

    // Skip any existing match (in either orientation) to keep files stable and avoid duplicates.
    const skipSym = new Set<string>();
    for (const row of [...existingHigh, ...existingReview]) {
      const key = matchKeyFromRow(row);
      if (!key) continue;
      skipSym.add(key);
      skipSym.add(reverseKey(key));
    }

    const highAppender = createCsvAppender(highPath, csvHeader(), matchFlushEvery);
    const reviewAppender = createCsvAppender(reviewPath, csvHeader(), matchFlushEvery);

    const highFreshPath = path.join(dataDir, "market_matches_high_fresh.csv");
    const reviewFreshPath = path.join(dataDir, "market_matches_review_fresh.csv");
    const highFreshWriter = createCsvWriter(highFreshPath, csvHeader(), matchFlushEvery);
    const reviewFreshWriter = createCsvWriter(reviewFreshPath, csvHeader(), matchFlushEvery);

    const limNewMatch = limNew
      .map(toMatchMarketFromLimitless)
      .filter((m): m is MatchMarket => Boolean(m));
    const probNewMatch = probNew
      .map(toMatchMarketFromProbable)
      .filter((m): m is MatchMarket => Boolean(m));

    const newByExchange: Record<MatchMarket["exchange"], MatchMarket[]> = {
      polymarket: pmNew.map(toMatchMarketFromPolymarket),
      kalshi: kalNew.map(toMatchMarketFromKalshi),
      limitless: limNewMatch,
      probable: probNewMatch
    };

    const allByExchange: Record<MatchMarket["exchange"], MatchMarket[]> = {
      polymarket: pmMatch,
      kalshi: kalMatch,
      limitless: limMatch,
      probable: probMatch
    };

    const pairCandidates: Array<{
      tag: string;
      left: MatchMarket["exchange"];
      right: MatchMarket["exchange"];
    }> = [
      { tag: "pm_kal", left: "polymarket", right: "kalshi" },
      { tag: "pm_lim", left: "polymarket", right: "limitless" },
      { tag: "kal_lim", left: "kalshi", right: "limitless" },
      { tag: "pm_prob", left: "polymarket", right: "probable" },
      { tag: "kal_prob", left: "kalshi", right: "probable" },
      { tag: "lim_prob", left: "limitless", right: "probable" }
    ];
    const pairs = pairCandidates.filter(
      (pair) => !(skipPmKal && pair.tag === "pm_kal")
    );

    const writeIfNew = (
      row: MatchRow,
      writer: { writeRow: (row: MatchRow) => void },
      freshWriter: { writeRow: (row: MatchRow) => void },
      countKey: "high" | "review"
    ) => {
      const key = `${row.left.exchange}::${row.left.id}::${row.right.exchange}::${row.right.id}`;
      if (skipSym.has(key)) return;
      skipSym.add(key);
      skipSym.add(reverseKey(key));
      writer.writeRow(row);
      freshWriter.writeRow(row);
      if (countKey === "high") highCount += 1;
      else reviewCount += 1;
    };

    const swapRow = (row: MatchRow): MatchRow => ({
      ...row,
      left: row.right,
      right: row.left
    });

    for (const pair of pairs) {
      const leftAll = allByExchange[pair.left];
      const rightAll = allByExchange[pair.right];
      if (!leftAll.length || !rightAll.length) continue;

      const leftNew = newByExchange[pair.left];
      if (leftNew.length) {
        matchMarkets(leftNew, rightAll, {
          highScore,
          reviewScore,
          rulesMinHigh,
          maxCloseDays,
          maxPerPm,
          enforceBucket,
          allowRulesBypass,
          titleOverride,
          numOverride,
          progress: matchProgress,
          logEvery: matchLogEvery,
          skipKeys: skipSym,
          onHigh: (row) =>
            writeIfNew(row, highAppender, highFreshWriter, "high"),
          onReview: (row) =>
            writeIfNew(row, reviewAppender, reviewFreshWriter, "review")
        });
      }

      const rightNew = newByExchange[pair.right];
      if (rightNew.length) {
        matchMarkets(rightNew, leftAll, {
          highScore,
          reviewScore,
          rulesMinHigh,
          maxCloseDays,
          maxPerPm,
          enforceBucket,
          allowRulesBypass,
          titleOverride,
          numOverride,
          progress: matchProgress,
          logEvery: matchLogEvery,
          skipKeys: skipSym,
          onHigh: (row) =>
            writeIfNew(swapRow(row), highAppender, highFreshWriter, "high"),
          onReview: (row) =>
            writeIfNew(
              swapRow(row),
              reviewAppender,
              reviewFreshWriter,
              "review"
            )
        });
      }
    }

    highAppender.close();
    reviewAppender.close();
    highFreshWriter.close();
    reviewFreshWriter.close();

    console.log(
      `Fresh matches added high=${highCount} review=${reviewCount} (see *_fresh.csv for delta).`
    );
    return;
  }

  if (matchWorkers > 1 && pmMatch.length > 0) {
    const partsDir = path.join(dataDir, "match_parts");
    ensureDir(partsDir);

    fs.writeFileSync(highPath, `${csvHeader()}\n`, "utf8");
    fs.writeFileSync(reviewPath, `${csvHeader()}\n`, "utf8");

    const workerPromises = [];
    const processedByWorker = new Map<number, number>();
    const highByWorker = new Map<number, number>();
    const reviewByWorker = new Map<number, number>();
    const matchStart = Date.now();
    let lastLogged = 0;
    const pairs = [
      { tag: "pm_kal", left: pmMatch, right: kalMatch },
      { tag: "pm_lim", left: pmMatch, right: limMatch },
      { tag: "kal_lim", left: kalMatch, right: limMatch },
      { tag: "pm_prob", left: pmMatch, right: probMatch },
      { tag: "kal_prob", left: kalMatch, right: probMatch },
      { tag: "lim_prob", left: limMatch, right: probMatch }
    ].filter((pair) => !(skipPmKal && pair.tag === "pm_kal"));

    for (const pair of pairs) {
      if (!pair.left.length || !pair.right.length) continue;

      const rightPath = path.join(partsDir, `match_right_${pair.tag}.json`);
      fs.writeFileSync(rightPath, JSON.stringify(pair.right, null, 2), "utf8");

      const pairStart = Date.now();
      const pairWorkerCount = Math.min(matchWorkers, os.cpus().length, pair.left.length);
      const pairChunk = Math.ceil(pair.left.length / pairWorkerCount);
      const workerPromises = [];
      const processedByWorker = new Map<number, number>();
      const highByWorker = new Map<number, number>();
      const reviewByWorker = new Map<number, number>();
      let lastLogged = 0;

      for (let i = 0; i < pairWorkerCount; i += 1) {
        const start = i * pairChunk;
        const end = Math.min(pair.left.length, start + pairChunk);
        const leftSlice = pair.left.slice(start, end);
        if (!leftSlice.length) continue;

        const highPart = path.join(partsDir, `market_matches_high.${pair.tag}.part${i}.csv`);
        const reviewPart = path.join(partsDir, `market_matches_review.${pair.tag}.part${i}.csv`);
        if (fs.existsSync(highPart)) fs.unlinkSync(highPart);
        if (fs.existsSync(reviewPart)) fs.unlinkSync(reviewPart);

        const worker = new Worker(new URL("./matchWorker.js", import.meta.url), {
          type: "module",
          workerData: {
            leftSlice,
            rightPath,
            skipKeys: Array.from(skipKeys),
            opts: {
              highScore,
              reviewScore,
              rulesMinHigh,
              maxCloseDays,
              maxPerPm,
              enforceBucket,
              allowRulesBypass,
              titleOverride,
              numOverride
            },
            highPath: highPart,
            reviewPath: reviewPart,
            flushEvery: matchFlushEvery,
            progress: matchProgress,
            logEvery: matchLogEvery,
            workerId: i,
            pairTag: pair.tag
          }
        });

        const promise = new Promise((resolve, reject) => {
          worker.on("message", (msg) => {
            if (msg?.error) {
              reject(new Error(msg.error));
              return;
            }

            if (msg?.type === "progress") {
              processedByWorker.set(msg.workerId, msg.processed ?? 0);
              highByWorker.set(msg.workerId, msg.highCount ?? 0);
              reviewByWorker.set(msg.workerId, msg.reviewCount ?? 0);
              const totalProcessed = Array.from(processedByWorker.values()).reduce(
                (sum, val) => sum + val,
                0
              );
              if (matchProgress && totalProcessed - lastLogged >= matchLogEvery) {
                lastLogged = totalProcessed;
                const totalHigh = Array.from(highByWorker.values()).reduce(
                  (sum, val) => sum + val,
                  0
                );
                const totalReview = Array.from(reviewByWorker.values()).reduce(
                  (sum, val) => sum + val,
                  0
                );
                const elapsed = ((Date.now() - pairStart) / 1000).toFixed(1);
                console.log(
                  `[MATCH:${pair.tag}] ${totalProcessed}/${pair.left.length} processed ` +
                    `high=${totalHigh} review=${totalReview} elapsed=${elapsed}s`
                );
              }
              return;
            }

            if (msg?.type === "done") {
              processedByWorker.set(msg.workerId, msg.processed ?? 0);
              highByWorker.set(msg.workerId, msg.highCount ?? 0);
              reviewByWorker.set(msg.workerId, msg.reviewCount ?? 0);
              highCount += msg.highCount ?? 0;
              reviewCount += msg.reviewCount ?? 0;
              resolve();
            }
          });
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0) {
              reject(new Error(`Worker exited with code ${code}`));
            }
          });
        });

        workerPromises.push(promise);
      }

      await Promise.all(workerPromises);

      const partFiles = fs.readdirSync(partsDir);
      for (const file of partFiles) {
        if (file.startsWith(`market_matches_high.${pair.tag}.part`)) {
          const content = fs.readFileSync(path.join(partsDir, file), "utf8");
          if (content.trim()) fs.appendFileSync(highPath, content, "utf8");
        } else if (file.startsWith(`market_matches_review.${pair.tag}.part`)) {
          const content = fs.readFileSync(path.join(partsDir, file), "utf8");
          if (content.trim()) fs.appendFileSync(reviewPath, content, "utf8");
        }
      }
    }
  } else {
    const highWriter = createCsvWriter(highPath, csvHeader(), matchFlushEvery);
    const reviewWriter = createCsvWriter(reviewPath, csvHeader(), matchFlushEvery);

    const pairs = [
      { tag: "pm_kal", left: pmMatch, right: kalMatch },
      { tag: "pm_lim", left: pmMatch, right: limMatch },
      { tag: "kal_lim", left: kalMatch, right: limMatch },
      { tag: "pm_prob", left: pmMatch, right: probMatch },
      { tag: "kal_prob", left: kalMatch, right: probMatch },
      { tag: "lim_prob", left: limMatch, right: probMatch }
    ].filter((pair) => !(skipPmKal && pair.tag === "pm_kal"));

    for (const pair of pairs) {
      if (!pair.left.length || !pair.right.length) continue;
      const result = matchMarkets(pair.left, pair.right, {
        highScore,
        reviewScore,
        rulesMinHigh,
        maxCloseDays,
        maxPerPm,
        enforceBucket,
        allowRulesBypass,
        titleOverride,
        numOverride,
        progress: matchProgress,
        logEvery: matchLogEvery,
        skipKeys,
        onHigh: (row) => highWriter.writeRow(row),
        onReview: (row) => reviewWriter.writeRow(row)
      });

      highCount += result.highCount;
      reviewCount += result.reviewCount;
    }

    highWriter.close();
    reviewWriter.close();
  }

  console.log(
    `Polymarket markets=${pmMarkets.length} Kalshi markets=${kalMarkets.length} ` +
      `Limitless markets=${limMarkets.length} Probable markets=${probMarkets.length}`
  );
  console.log(`High matches=${highCount} Review matches=${reviewCount}`);

  if (persistMatches) {
    appendMissingRows(
      highPath,
      existingHigh,
      pmBySlug,
      kalByTicker,
      limBySlug,
      probBySlug
    );
    appendMissingRows(
      reviewPath,
      existingReview,
      pmBySlug,
      kalByTicker,
      limBySlug,
      probBySlug
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
