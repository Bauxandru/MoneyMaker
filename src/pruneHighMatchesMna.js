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
  "over",
  "under",
  "between",
  "about",
  "into",
  "than",
  // month names
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

function parseCsv(filePath, onRow) {
  const data = fs.readFileSync(filePath, "utf8");
  let row = [];
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

function csvValue(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvLine(fields) {
  return fields.map((v) => csvValue(v)).join(",");
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  const filePath = path.join(dataDir, "market_matches_high.csv");
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dataDir, `market_matches_high.bak_${stamp}.csv`);
  fs.copyFileSync(filePath, backupPath);

  const tmpPath = path.join(dataDir, `market_matches_high.tmp_${stamp}.csv`);

  let header = [];
  let kept = 0;
  let dropped = 0;
  let total = 0;

  parseCsv(filePath, (row, idx) => {
    if (idx === 0) {
      header = row;
      fs.writeFileSync(tmpPath, `${csvLine(row)}\n`, "utf8");
      return;
    }
    if (!header.length || !row.length || row.length !== header.length) return;
    total += 1;

    const get = (name) => {
      const i = header.indexOf(name);
      return i >= 0 ? row[i] ?? "" : "";
    };

    const leftTitle = `${get("a_title")} ${get("a_subtitle")}`.trim();
    const rightTitle = `${get("b_title")} ${get("b_subtitle")}`.trim();

    if (isMnaTitle(leftTitle) && isMnaTitle(rightTitle)) {
      const leftTokens = uniqueTokens(tokenize(leftTitle));
      const rightTokens = uniqueTokens(tokenize(rightTitle));
      const leftEntities = mnaEntityTokens(leftTitle, leftTokens);
      const rightEntities = mnaEntityTokens(rightTitle, rightTokens);
      if (!entitiesCompatible(leftEntities, rightEntities)) {
        dropped += 1;
        return;
      }
    }

    kept += 1;
    fs.appendFileSync(tmpPath, `${csvLine(row)}\n`, "utf8");
  });

  fs.renameSync(tmpPath, filePath);
  console.log(
    `[PRUNE] High matches: kept=${kept} dropped_mna_mismatch=${dropped} total=${total} (backup=${backupPath})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

