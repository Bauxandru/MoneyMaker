import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

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

type Bucket = {
  dir: "cut" | "hike" | "nochange";
  mag: "0" | "25" | "gt25" | "ge25";
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
      token.length >= 2 && !FDV_TEMPLATE_TOKENS.has(token) && !/^\d+$/.test(token)
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
  // Use overlap coefficient so that "2026" vs "Dec 31, 2026" scores as a full match.
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

function isBinaryYesNo(outcomes: string[]): boolean {
  if (!outcomes.length) return false;
  const normalized = outcomes.map((o) => normalizeText(o));
  const set = new Set(normalized);
  return set.has("yes") && set.has("no") && set.size <= 2;
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

function computeMatch(
  left: MatchMarket,
  right: MatchMarket,
  maxCloseDays: number,
  enforceBucket: boolean
): MatchRow | null {
  const leftTitle = `${left.title ?? ""} ${left.subtitle ?? ""}`.trim();
  const rightTitle = `${right.title ?? ""} ${right.subtitle ?? ""}`.trim();
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
  const numScore = numberScore(leftComparableNums, rightComparableNums);

  if (hasNumericConflict(leftComparableNums, rightComparableNums)) return null;
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
    leftRules || rightRules ? jaccard(tokenize(leftRules), tokenize(rightRules)) : null;

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

function csvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
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

function loadHighPairs(highPath: string) {
  const pairs = new Set<string>();
  if (!fs.existsSync(highPath)) return pairs;
  let header: string[] = [];
  parseCsv(highPath, (row, idx) => {
    if (idx === 0) {
      header = row;
      return;
    }
    if (!header.length) return;
    const aIdx = header.indexOf("a_exchange");
    const bIdx = header.indexOf("b_exchange");
    if (aIdx >= 0 && bIdx >= 0) {
      const aIdIdx = header.indexOf("a_id");
      const bIdIdx = header.indexOf("b_id");
      if (aIdIdx < 0 || bIdIdx < 0) return;
      pairs.add(`${row[aIdx]}::${row[aIdIdx]}::${row[bIdx]}::${row[bIdIdx]}`);
      return;
    }

    const pmIdx = header.indexOf("pm_market_slug");
    const kalIdx = header.indexOf("kal_ticker");
    if (pmIdx < 0 || kalIdx < 0) return;
    pairs.add(`polymarket::${row[pmIdx]}::kalshi::${row[kalIdx]}`);
  });
  return pairs;
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  const reviewPath = path.join(dataDir, "market_matches_review.csv");
  const highPath = path.join(dataDir, "market_matches_high.csv");
  const outHigh = path.join(dataDir, "market_matches_high_rescored.csv");
  const outReview = path.join(dataDir, "market_matches_review_rescored.csv");

  const highScore = num(process.env.MATCH_HIGH_SCORE, 0.82);
  const reviewScore = num(process.env.MATCH_REVIEW_SCORE, 0.7);
  const rulesMinHigh = num(process.env.MATCH_RULES_MIN, 0.25);
  const maxCloseDays = num(process.env.MATCH_MAX_CLOSE_DAYS, 14);
  const allowRulesBypass = parseBool(process.env.MATCH_RULES_BYPASS, true);
  const titleOverride = num(process.env.MATCH_TITLE_OVERRIDE, 0.85);
  const numOverride = num(process.env.MATCH_NUM_OVERRIDE, 0.9);
  const enforceBucket = parseBool(process.env.MATCH_BUCKET_ENFORCE, true);

  if (!fs.existsSync(reviewPath)) {
    throw new Error(`Missing ${reviewPath}`);
  }

  const highPairs = loadHighPairs(highPath);
  fs.writeFileSync(outHigh, `${csvHeader()}\n`, "utf8");
  fs.writeFileSync(outReview, `${csvHeader()}\n`, "utf8");

  if (fs.existsSync(highPath)) {
    const highText = fs.readFileSync(highPath, "utf8");
    // Copy the existing high file body verbatim. The CSV can contain quoted
    // fields with embedded newlines, so line-splitting would corrupt it.
    const newlineIdx = highText.indexOf("\n");
    if (newlineIdx >= 0) {
      fs.appendFileSync(outHigh, highText.slice(newlineIdx + 1), "utf8");
    }
  }

  let header: string[] = [];
  let promoted = 0;
  let remaining = 0;

  parseCsv(reviewPath, (row, idx) => {
    if (idx === 0) {
      header = row;
      return;
    }
    if (!row.length || !header.length) return;
    const hasNewSchema = header.includes("a_exchange");
    const get = (name: string) => {
      const i = header.indexOf(name);
      return i >= 0 ? row[i] ?? "" : "";
    };

    const parseOutcomes = (raw: string) => (raw ? raw.split("|") : []);
    let left: MatchMarket;
    let right: MatchMarket;

    if (hasNewSchema) {
      left = {
        exchange: (get("a_exchange") as MatchMarket["exchange"]) || "polymarket",
        id: get("a_id"),
        title: get("a_title"),
        subtitle: get("a_subtitle"),
        outcomes: parseOutcomes(get("a_outcomes")),
        endDate: get("a_end_date"),
        rulesText: get("a_rules"),
        description: get("a_description"),
        status: get("a_status")
      };
      right = {
        exchange: (get("b_exchange") as MatchMarket["exchange"]) || "kalshi",
        id: get("b_id"),
        title: get("b_title"),
        subtitle: get("b_subtitle"),
        outcomes: parseOutcomes(get("b_outcomes")),
        endDate: get("b_end_date"),
        rulesText: get("b_rules"),
        description: get("b_description"),
        status: get("b_status")
      };
    } else {
      const pmRules = `${get("pm_description")} ${get("pm_resolution_source")}`.trim();
      left = {
        exchange: "polymarket",
        id: get("pm_market_slug"),
        title: get("pm_question"),
        subtitle: "",
        outcomes: parseOutcomes(get("pm_outcomes")),
        endDate: get("pm_end_date"),
        rulesText: pmRules,
        description: get("pm_description"),
        status: ""
      };
      right = {
        exchange: "kalshi",
        id: get("kal_ticker"),
        title: get("kal_title"),
        subtitle: get("kal_subtitle"),
        outcomes: ["Yes", "No"],
        endDate: get("kal_close_time"),
        rulesText: get("kal_rules"),
        description: "",
        status: get("kal_status")
      };
    }

    const key = `${left.exchange}::${left.id}::${right.exchange}::${right.id}`;
    if (highPairs.has(key)) {
      return;
    }

    const match = computeMatch(left, right, maxCloseDays, enforceBucket);
    if (!match) return;

    const hasRules = Boolean(match.left.rulesText) && Boolean(match.right.rulesText);
    const strongTitleMatch =
      match.titleScore >= titleOverride && match.numberScore >= numOverride;
    const rulesOk =
      match.rulesScore === null ||
      match.rulesScore >= rulesMinHigh ||
      (allowRulesBypass && strongTitleMatch);

    if (
      match.score >= highScore &&
      hasRules &&
      rulesOk &&
      isBinaryYesNo(match.left.outcomes) &&
      isBinaryYesNo(match.right.outcomes)
    ) {
      fs.appendFileSync(outHigh, `${csvRow(match)}\n`, "utf8");
      promoted += 1;
    } else if (match.score >= reviewScore) {
      fs.appendFileSync(outReview, `${csvRow(match)}\n`, "utf8");
      remaining += 1;
    }
  });

  console.log(`Promoted to high: ${promoted}`);
  console.log(`Remaining review: ${remaining}`);
  console.log(`Wrote: ${outHigh}`);
  console.log(`Wrote: ${outReview}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
