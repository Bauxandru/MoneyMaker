import fs from "fs";
import path from "path";
import { parentPort, workerData } from "worker_threads";

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

function normalizeText(value) {
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

function isMnaTitle(title) {
  const normalized = normalizeText(title);
  return /\b(merger|merge|merged|acquire|acquired|acquisition|takeover|buyout)\b/.test(
    normalized
  );
}

function mnaEntityTokens(title, titleTokens) {
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

function entitiesCompatible(aTokens, bTokens) {
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

function parseBucket(raw) {
  if (!raw) return null;
  const lower = String(raw).toLowerCase();

  if (
    lower.includes("no change") ||
    lower.includes("maintains rate") ||
    lower.includes("maintain rate") ||
    /\b0\s*bps\b/.test(lower)
  ) {
    return { dir: "nochange", mag: "0" };
  }

  let dir = null;
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

function bucketsCompatible(pmBucket, kalBucket) {
  if (!pmBucket || !kalBucket) return true;
  if (pmBucket.dir !== kalBucket.dir) return false;
  if (pmBucket.dir === "nochange") return kalBucket.mag === "0";

  if (pmBucket.mag === "25") return kalBucket.mag === "25";
  if (pmBucket.mag === "ge25") return kalBucket.mag === "25" || kalBucket.mag === "gt25";
  if (pmBucket.mag === "gt25") return kalBucket.mag === "gt25";
  return true;
}

function tokenize(value) {
  if (!value) return [];
  const text = normalizeText(value);
  if (!text) return [];
  return text
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !STOPWORDS.has(token));
}

function uniqueTokens(tokens) {
  return Array.from(new Set(tokens));
}

function isFdvOneDay(title) {
  const normalized = normalizeText(title);
  return normalized.includes("fdv") && normalized.includes("one day after launch");
}

function medalCategory(title) {
  const normalized = normalizeText(title);
  if (!normalized.includes("medal")) return null;
  if (normalized.includes("gold")) return "gold";
  if (normalized.includes("silver")) return "silver";
  if (normalized.includes("bronze")) return "bronze";
  return "all";
}

function medalPlacement(title) {
  const normalized = normalizeText(title);
  if (!normalized.includes("medal")) return null;
  const nth = normalized.match(/\b(\d+)(st|nd|rd|th)\b/);
  if (nth) return nth[1];
  const word = normalized.match(
    /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/
  );
  if (word) {
    const map = {
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

function projectTokens(tokens) {
  return tokens.filter(
    (token) =>
      token.length >= 2 && !FDV_TEMPLATE_TOKENS.has(token) && !/^\d+$/.test(token)
  );
}

function sharesProjectToken(a, b) {
  if (!a.length || !b.length) return false;
  const setA = new Set(a);
  return b.some((token) => setA.has(token));
}

function jaccard(a, b) {
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

function isLikelyCalendarNumber(numVal) {
  if (!Number.isInteger(numVal)) return false;
  return numVal >= 1900 && numVal <= 2100;
}

function extractComparableNumbers(value) {
  const set = new Set();
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

function numberScore(a, b) {
  if (!a.size || !b.size) return 0.5;
  let intersect = 0;
  for (const value of a) {
    if (b.has(value)) intersect += 1;
  }
  // Use overlap coefficient so that "2026" vs "Dec 31, 2026" scores as a full match.
  const denom = Math.min(a.size, b.size);
  return denom === 0 ? 0 : intersect / denom;
}

function hasNumericConflict(a, b) {
  if (!a.size || !b.size) return false;
  for (const value of a) {
    if (b.has(value)) return false;
  }
  return true;
}

function parseDate(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function daysBetween(a, b) {
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvRow(row) {
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

function buildTokenIndex(markets) {
  const index = new Map();
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

function isBinaryYesNo(outcomes) {
  if (!outcomes || !outcomes.length) return false;
  const normalized = outcomes.map((o) => normalizeText(o));
  const set = new Set(normalized);
  return set.has("yes") && set.has("no") && set.size <= 2;
}

function computeMatch(left, right, maxCloseDays, enforceBucket) {
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
  let timeDiffDays = null;
  let timeConflict = false;
  if (leftClose !== null && rightClose !== null) {
    timeDiffDays = daysBetween(leftClose, rightClose);
    if (timeDiffDays > maxCloseDays) timeConflict = true;
  }
  if (timeConflict) return null;

  const score =
    0.6 * titleScore + 0.2 * numScore + 0.1 * outcomeScore + 0.1 * (rulesScore ?? 0);

  const reasons = [];
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

function createCsvWriter(filePath, flushEvery) {
  const buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    fs.appendFileSync(filePath, `${buffer.join("\n")}\n`, "utf8");
    buffer.length = 0;
  };
  const writeRow = (row) => {
    buffer.push(csvRow(row));
    if (buffer.length >= flushEvery) flush();
  };
  const close = () => {
    flush();
  };
  return { writeRow, close };
}

async function run() {
  const {
    leftSlice,
    rightPath,
    skipKeys,
    opts,
    highPath,
    reviewPath,
    flushEvery,
    progress,
    logEvery,
    workerId
  } = workerData;

  const rightMarkets = JSON.parse(fs.readFileSync(rightPath, "utf8"));
  const { index } = buildTokenIndex(rightMarkets);
  const skipSet = new Set(skipKeys ?? []);

  const highWriter = createCsvWriter(highPath, flushEvery);
  const reviewWriter = createCsvWriter(reviewPath, flushEvery);

  let highCount = 0;
  let reviewCount = 0;
  let processed = 0;
  const start = Date.now();

  for (const left of leftSlice) {
    processed += 1;
    const leftTokens = uniqueTokens(
      tokenize(`${left.title} ${left.subtitle} ${left.description} ${left.rulesText}`)
    ).filter((token) => token.length >= 4 && !/^\d+$/.test(token));
    const candidateSet = new Set();
    for (const token of leftTokens) {
      const list = index.get(token);
      if (!list) continue;
      for (const idx of list) candidateSet.add(idx);
    }

    if (!candidateSet.size) continue;
    const candidates = [];
    for (const idx of candidateSet) {
      const right = rightMarkets[idx];
      if (!right) continue;
      const key = `${left.exchange}::${left.id}::${right.exchange}::${right.id}`;
      if (skipSet.has(key)) continue;
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
        isBinaryYesNo(match.left.outcomes) &&
        isBinaryYesNo(match.right.outcomes)
      ) {
        highCount += 1;
        highWriter.writeRow(match);
      } else if (match.score >= opts.reviewScore) {
        reviewCount += 1;
        reviewWriter.writeRow(match);
      }
    }

    if (progress && logEvery > 0 && processed % logEvery === 0) {
      parentPort.postMessage({
        type: "progress",
        workerId,
        processed,
        highCount,
        reviewCount,
        elapsedSec: (Date.now() - start) / 1000
      });
    }
  }

  highWriter.close();
  reviewWriter.close();
  parentPort.postMessage({
    type: "done",
    workerId,
    highCount,
    reviewCount,
      processed: leftSlice.length
    });
}

run().catch((err) => {
  parentPort.postMessage({ error: err.message ?? String(err) });
});
