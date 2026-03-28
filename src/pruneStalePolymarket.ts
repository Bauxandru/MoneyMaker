import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

type CsvRow = string[];

function num(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const v = Number(value);
  return Number.isFinite(v) ? v : fallback;
}

function parseCsv(filePath: string, onRow: (row: CsvRow, idx: number) => void) {
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSlug(slug: string): Promise<number> {
  const base = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const res = await fetch(`${base}/markets/slug/${encodeURIComponent(slug)}`);
  return res.status;
}

function collectPolymarketSlugs(files: string[]) {
  const slugs = new Set<string>();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let header: string[] = [];
    parseCsv(file, (row, idx) => {
      if (idx === 0) {
        header = row;
        return;
      }
      if (!row.length || !header.length) return;
      const aIdx = header.indexOf("a_exchange");
      const bIdx = header.indexOf("b_exchange");
      const aIdIdx = header.indexOf("a_id");
      const bIdIdx = header.indexOf("b_id");
      if (aIdx < 0 || bIdx < 0 || aIdIdx < 0 || bIdIdx < 0) return;
      if (row[aIdx] === "polymarket" && row[aIdIdx]) {
        slugs.add(row[aIdIdx]);
      }
      if (row[bIdx] === "polymarket" && row[bIdIdx]) {
        slugs.add(row[bIdIdx]);
      }
    });
  }
  return Array.from(slugs);
}

function filterMatches(filePath: string, stale: Set<string>) {
  if (!fs.existsSync(filePath)) return;
  const lines: string[] = [];
  let header: string[] = [];
  let removed = 0;
  parseCsv(filePath, (row, idx) => {
    if (idx === 0) {
      header = row;
      lines.push(row.join(","));
      return;
    }
    if (!row.length || !header.length) return;
    const aIdx = header.indexOf("a_exchange");
    const bIdx = header.indexOf("b_exchange");
    const aIdIdx = header.indexOf("a_id");
    const bIdIdx = header.indexOf("b_id");
    if (aIdx < 0 || bIdx < 0 || aIdIdx < 0 || bIdIdx < 0) {
      lines.push(row.join(","));
      return;
    }
    const drop =
      (row[aIdx] === "polymarket" && stale.has(row[aIdIdx])) ||
      (row[bIdx] === "polymarket" && stale.has(row[bIdIdx]));
    if (drop) {
      removed += 1;
      return;
    }
    lines.push(row.join(","));
  });
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log(`[PRUNE] ${path.basename(filePath)} removed=${removed}`);
}

async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  const files = [
    path.join(dataDir, "market_matches_high.csv"),
    path.join(dataDir, "market_matches_review.csv"),
    path.join(dataDir, "market_matches_high_rescored.csv"),
    path.join(dataDir, "market_matches_review_rescored.csv")
  ];
  const slugs = collectPolymarketSlugs(files);
  if (!slugs.length) {
    console.log("[PRUNE] No Polymarket slugs found to validate.");
    return;
  }

  const concurrency = Math.max(1, num(process.env.POLY_PRUNE_CONCURRENCY, 5));
  const delayMs = Math.max(0, num(process.env.POLY_PRUNE_DELAY_MS, 150));

  const stale = new Set<string>();
  let idx = 0;
  let checked = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < slugs.length) {
      const slug = slugs[idx++];
      try {
        const status = await fetchSlug(slug);
        if (status === 404) stale.add(slug);
      } catch (err) {
        console.warn(`[PRUNE] ${slug} fetch failed: ${(err as Error).message}`);
      }
      checked += 1;
      if (delayMs > 0) await sleep(delayMs);
      if (checked % 100 === 0) {
        console.log(`[PRUNE] checked=${checked}/${slugs.length} stale=${stale.size}`);
      }
    }
  });

  await Promise.all(workers);
  console.log(`[PRUNE] checked=${checked} stale=${stale.size}`);
  if (!stale.size) {
    console.log("[PRUNE] No stale slugs detected.");
    return;
  }

  const pmPath = path.join(dataDir, "polymarket_markets.json");
  if (fs.existsSync(pmPath)) {
    const raw = JSON.parse(fs.readFileSync(pmPath, "utf8")) as {
      marketSlug?: string;
    }[];
    const filtered = raw.filter(
      (m) => !m.marketSlug || !stale.has(m.marketSlug)
    );
    fs.writeFileSync(pmPath, JSON.stringify(filtered, null, 2), "utf8");
    console.log(
      `[PRUNE] polymarket_markets.json removed=${raw.length - filtered.length}`
    );
  }

  for (const file of files) {
    filterMatches(file, stale);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
