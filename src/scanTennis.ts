/**
 * scanTennis.ts
 *
 * Scans Kalshi KXATPMATCH individual ATP match markets against Polymarket
 * ATP tennis categorical markets for cross-platform arbitrage.
 *
 * How it works:
 *  • Kalshi splits each match into TWO binary markets (one per player):
 *      KXATPMATCH-26FEB25VACMON-VAC  YES = Vacherot wins (yesAsk 75%, noAsk 29%)
 *      KXATPMATCH-26FEB25VACMON-MON  YES = Monfils wins  (yesAsk 34%, noAsk 70%)
 *  • Polymarket has ONE categorical market with player-name outcomes:
 *      atp-vachero-monfils-2026-02-25  outcomes ["Vacherot","Monfils"]
 *
 *  Arb: for a match between P1 and P2,
 *    Edge A = 1 − KAL_P1_yesAsk − PM_P2_ask   (both pay $1 in every outcome)
 *    Edge B = 1 − KAL_P2_yesAsk − PM_P1_ask
 *
 * Usage:
 *   npx tsx src/scanTennis.ts
 */

import dotenv from "dotenv";
import { createRateLimitedFetcher } from "./http.js";
import { pickString, parseJsonArray, normCents, normDollarsOrCents, bestAskFromSide } from "./utils.js";

dotenv.config();

type AnyRecord = Record<string, unknown>;

// ─── Rate-limited fetch helpers ───────────────────────────────────────────────

const retryOpts = { timeoutMs: 15000, maxRetries: 4, baseDelayMs: 700, maxDelayMs: 10000, jitterMs: 300 };
const kalFetch = createRateLimitedFetcher(Number(process.env.KALSHI_REQUEST_INTERVAL_MS ?? 120), retryOpts);
const polyFetch = createRateLimitedFetcher(Number(process.env.POLY_REQUEST_INTERVAL_MS ?? 150), retryOpts);

// ─── Player name helpers ──────────────────────────────────────────────────────

/**
 * Extract the player's full name from a Kalshi KXATPMATCH market title.
 * Title format: "Will Valentin Vacherot win the Vacherot vs Monfils match (Feb 25)"
 * Returns: "Valentin Vacherot"
 */
function extractKalshiPlayerName(title: string): string {
  const m = title.match(/^Will\s+(.+?)\s+win\s+the\s+/i);
  return m ? m[1].trim() : "";
}

/**
 * Extract the MATCH title from a Kalshi market title.
 * "Will Valentin Vacherot win the Vacherot vs Monfils match (Feb 25)"
 * Returns: "Vacherot vs Monfils"
 */
function extractKalshiMatchTitle(title: string): string {
  const m = title.match(/will\s+.+?\s+win\s+the\s+(.+?)(?:\s+match|$)/i);
  if (!m) return "";
  return m[1].replace(/\s*\([^)]*\)/g, "").trim();
}

/**
 * Polymarket slug token: first 7 chars of the last word of a player name, lowercased.
 * "Valentin Vacherot" → "vachero"  (7 of "Vacherot")
 * "Carreno Busta" → "busta"        (last word)
 * "Mpetshi Perricard" → "perrica"  (7 of "Perricard")
 */
function pmSlugToken(fullName: string): string {
  const last = fullName.trim().split(/\s+/).pop() ?? fullName;
  return last.toLowerCase().slice(0, 7);
}

/**
 * Parse a date-like code from a Kalshi ticker.
 * "KXATPMATCH-26FEB25VACMON-VAC" → "26FEB25" → "2026-02-25"
 * "KXATPMATCH-26FEB24UGOHAN-UGO" → "26FEB24" → "2026-02-24"
 */
const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

function parseDateFromTicker(ticker: string): string {
  const m = ticker.match(/KXATPMATCH-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  const year = `20${m[1]}`;
  const month = MONTHS[m[2].toUpperCase()] ?? "01";
  const day = m[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Extract the match code prefix from a ticker.
 * "KXATPMATCH-26FEB25VACMON-VAC" → "KXATPMATCH-26FEB25VACMON"
 */
function matchCode(ticker: string): string {
  return ticker.replace(/-[^-]+$/, "");
}

// ─── Types ────────────────────────────────────────────────────────────────────

type KalshiPlayerMarket = {
  ticker: string;
  fullName: string;   // e.g. "Valentin Vacherot"
  surname: string;    // last word, e.g. "Vacherot"
  yesAsk: number;     // decimal 0–1
  noAsk: number;
};

type KalshiMatchGroup = {
  matchCode: string;              // e.g. "KXATPMATCH-26FEB25VACMON"
  date: string;                   // e.g. "2026-02-25"
  players: KalshiPlayerMarket[];  // exactly 2 (or more for safety)
};

type PolyMatchMarket = {
  slug: string;
  outcomes: string[];             // player names, e.g. ["Vacherot","Monfils"]
  tokenIds: string[];             // CLOB token ID per outcome
};

type ArbOpportunity = {
  matchCode: string;
  pmSlug: string;
  matchTitle: string;
  // Direction A: buy KAL P1_YES + PM P2_token
  dirA_kalTicker: string;
  dirA_kalYesAsk: number;
  dirA_pmOutcome: string;
  dirA_pmAsk: number;
  edgeA: number;
  // Direction B: buy KAL P2_YES + PM P1_token
  dirB_kalTicker: string;
  dirB_kalYesAsk: number;
  dirB_pmOutcome: string;
  dirB_pmAsk: number;
  edgeB: number;
};

// ─── Kalshi: Fetch and group KXATPMATCH markets ───────────────────────────────

async function fetchKalshiMatchGroups(): Promise<KalshiMatchGroup[]> {
  const base =
    process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const playerMarkets: KalshiPlayerMarket[] = [];

  // First try /markets?series_ticker=KXATPMATCH (most efficient)
  let cursor = "";
  let pages = 0;
  let gotAny = false;

  while (true) {
    const query = new URLSearchParams({ series_ticker: "KXATPMATCH", status: "open", limit: "200" });
    if (cursor) query.set("cursor", cursor);
    const url = `${base}/markets?${query}`;

    let res: AnyRecord;
    try {
      res = await kalFetch<AnyRecord>(url);
    } catch (err) {
      console.error(`[Kalshi/markets] ${(err as Error).message}`);
      break;
    }

    const mlist = Array.isArray(res.markets) ? (res.markets as AnyRecord[]) : [];
    if (!mlist.length) break;
    gotAny = true;
    pages++;

    for (const m of mlist) {
      const status = pickString(m.status ?? m.state ?? "");
      if (status && status.toLowerCase() !== "active") continue;

      const ticker = pickString(m.ticker ?? "");
      if (!ticker || !ticker.startsWith("KXATPMATCH")) continue;

      const title = pickString(m.title ?? m.subtitle ?? "");
      const fullName = extractKalshiPlayerName(title);
      if (!fullName) continue;

      const surname = fullName.trim().split(/\s+/).pop() ?? fullName;

      const yesAsk =
        m.yes_ask_dollars !== undefined
          ? normDollarsOrCents(m.yes_ask_dollars)
          : normCents(m.yes_ask);
      const noAsk =
        m.no_ask_dollars !== undefined
          ? normDollarsOrCents(m.no_ask_dollars)
          : normCents(m.no_ask);

      if (yesAsk === null || noAsk === null) continue;
      playerMarkets.push({ ticker, fullName, surname, yesAsk, noAsk });
    }

    cursor = pickString((res as AnyRecord).next_cursor ?? (res as AnyRecord).cursor ?? "");
    if (!cursor) break;

    process.stderr.write(`\r[Kalshi] /markets pages=${pages} playerMarkets=${playerMarkets.length}   `);
  }

  if (!gotAny) {
    // Fallback: iterate /events and filter by series_ticker field
    process.stderr.write("\r[Kalshi] /markets empty → falling back to /events scan…\n");
    cursor = "";
    pages = 0;

    while (pages < 120) {
      const query = new URLSearchParams({ status: "open", limit: "200", with_nested_markets: "true" });
      if (cursor) query.set("cursor", cursor);

      let res: AnyRecord;
      try {
        res = await kalFetch<AnyRecord>(`${base}/events?${query}`);
      } catch (err) {
        console.error(`[Kalshi/events] ${(err as Error).message}`);
        break;
      }

      const events = Array.isArray(res.events) ? (res.events as AnyRecord[]) : [];
      if (!events.length) break;
      pages++;

      for (const event of events) {
        if (pickString(event.series_ticker) !== "KXATPMATCH") continue;
        const eventMarkets = Array.isArray(event.markets) ? (event.markets as AnyRecord[]) : [];

        for (const m of eventMarkets) {
          if (pickString(m.status ?? m.state ?? "").toLowerCase() !== "active") continue;
          const ticker = pickString(m.ticker ?? "");
          if (!ticker) continue;
          const title = pickString(m.title ?? m.subtitle ?? "");
          const fullName = extractKalshiPlayerName(title);
          if (!fullName) continue;
          const surname = fullName.trim().split(/\s+/).pop() ?? fullName;

          const yesAsk =
            m.yes_ask_dollars !== undefined
              ? normDollarsOrCents(m.yes_ask_dollars)
              : normCents(m.yes_ask);
          const noAsk =
            m.no_ask_dollars !== undefined
              ? normDollarsOrCents(m.no_ask_dollars)
              : normCents(m.no_ask);

          if (yesAsk === null || noAsk === null) continue;
          playerMarkets.push({ ticker, fullName, surname, yesAsk, noAsk });
        }
      }

      cursor = pickString(
        (res as AnyRecord).next_cursor ?? (res as AnyRecord).cursor ?? (res as AnyRecord).nextCursor ?? ""
      );
      if (!cursor) break;

      process.stderr.write(`\r[Kalshi] /events pages=${pages} playerMarkets=${playerMarkets.length}   `);
    }
  }

  process.stderr.write(`\r[Kalshi] done: ${playerMarkets.length} player markets      \n`);

  // Group by match code
  const groupMap = new Map<string, KalshiMatchGroup>();
  for (const pm of playerMarkets) {
    const code = matchCode(pm.ticker);
    const date = parseDateFromTicker(pm.ticker);
    if (!groupMap.has(code)) {
      groupMap.set(code, { matchCode: code, date, players: [] });
    }
    groupMap.get(code)!.players.push(pm);
  }

  // Only return groups with exactly 2 players (complete matches)
  const groups = [...groupMap.values()].filter((g) => g.players.length === 2);
  console.log(`[Kalshi] ${groups.length} complete match pairs (from ${playerMarkets.length} player markets)`);
  return groups;
}

// ─── Polymarket: Fetch ATP categorical market by slug ─────────────────────────

async function fetchPolyMatchMarket(slug: string): Promise<PolyMatchMarket | null> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  try {
    const raw = await polyFetch<unknown>(
      `${gammaBase}/markets?slug=${encodeURIComponent(slug)}`
    );
    const markets = Array.isArray(raw) ? (raw as AnyRecord[]) : [];
    if (!markets.length) return null;
    const m = markets[0];
    if (!m.active || m.closed) return null;
    const outcomes = parseJsonArray(m.outcomes ?? "");
    const tokenIds = parseJsonArray(m.clobTokenIds ?? m.clob_token_ids ?? "");
    if (outcomes.length < 2 || tokenIds.length < 2) return null;
    return { slug, outcomes, tokenIds };
  } catch {
    return null;
  }
}

/**
 * Try multiple slug variants to find the Polymarket market for a Kalshi match group.
 * Returns the market and which order the outcomes are in relative to kalshi players.
 */
async function findPolyMatch(
  group: KalshiMatchGroup
): Promise<PolyMatchMarket | null> {
  const [p1, p2] = group.players;
  const t1 = pmSlugToken(p1.fullName);
  const t2 = pmSlugToken(p2.fullName);
  const date = group.date;

  const slugCandidates = [
    `atp-${t1}-${t2}-${date}`,
    `atp-${t2}-${t1}-${date}`,
    // fallback: try 6-char prefixes
    `atp-${t1.slice(0, 6)}-${t2.slice(0, 6)}-${date}`,
    `atp-${t2.slice(0, 6)}-${t1.slice(0, 6)}-${date}`,
  ];

  for (const slug of [...new Set(slugCandidates)]) {
    const market = await fetchPolyMatchMarket(slug);
    if (market) return market;
  }
  return null;
}

// ─── Fetch Polymarket CLOB ask prices for each outcome token ─────────────────

async function fetchPolyOutcomePrices(
  market: PolyMatchMarket,
  clobBase: string
): Promise<Map<string, number>> {
  const priceMap = new Map<string, number>();
  for (let i = 0; i < market.outcomes.length; i++) {
    const tokenId = market.tokenIds[i];
    const outcome = market.outcomes[i];
    try {
      const book = await polyFetch<AnyRecord>(
        `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
      );
      const ask = bestAskFromSide(book.asks);
      if (ask !== null) priceMap.set(outcome, ask);
    } catch {
      // skip
    }
  }
  return priceMap;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtPct(v: number, d = 1): string {
  return (v * 100).toFixed(d) + "%";
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    "[TENNIS ARB] Scanning Kalshi KXATPMATCH vs Polymarket ATP categorical markets\n"
  );

  const groups = await fetchKalshiMatchGroups();

  if (!groups.length) {
    console.log("[TENNIS ARB] No Kalshi KXATPMATCH match groups found.");
    return;
  }

  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const arbs: ArbOpportunity[] = [];
  let matched = 0;
  let notFound = 0;
  let priceMissing = 0;

  for (const group of groups) {
    const [kalP1, kalP2] = group.players;

    // Find Polymarket market
    const pmMarket = await findPolyMatch(group);
    if (!pmMarket) {
      notFound++;
      process.stderr.write(
        `\r[Poly] NOT FOUND: ${kalP1.surname} vs ${kalP2.surname} (${group.date})   \n`
      );
      continue;
    }
    matched++;

    // Fetch CLOB prices for each outcome
    const pmPrices = await fetchPolyOutcomePrices(pmMarket, clobBase);

    // Match Kalshi player → PM outcome by surname
    function findPmAsk(kalSurname: string): { outcome: string; ask: number } | null {
      for (const [outcome, ask] of pmPrices) {
        const outcomeNorm = outcome.toLowerCase();
        const surNorm = kalSurname.toLowerCase();
        if (
          outcomeNorm === surNorm ||
          outcomeNorm.startsWith(surNorm) ||
          surNorm.startsWith(outcomeNorm)
        ) {
          return { outcome, ask };
        }
      }
      return null;
    }

    const pm1 = findPmAsk(kalP1.surname); // PM outcome matching P1
    const pm2 = findPmAsk(kalP2.surname); // PM outcome matching P2

    if (!pm1 || !pm2) {
      priceMissing++;
      process.stderr.write(
        `\r[Poly] PRICE MISS: ${kalP1.surname}=${pm1?.ask} ${kalP2.surname}=${pm2?.ask} @ ${pmMarket.slug}\n`
      );
      continue;
    }

    // Arb A: KAL P1_YES + PM P2_token → pays $1 if P1 wins (KAL) or P2 wins (PM)
    //         combined pays $1 in ALL scenarios
    const edgeA = 1 - kalP1.yesAsk - pm2.ask;
    // Arb B: KAL P2_YES + PM P1_token
    const edgeB = 1 - kalP2.yesAsk - pm1.ask;

    const matchTitle = `${kalP1.surname} vs ${kalP2.surname} (${group.date})`;

    arbs.push({
      matchCode: group.matchCode,
      pmSlug: pmMarket.slug,
      matchTitle,
      dirA_kalTicker: kalP1.ticker,
      dirA_kalYesAsk: kalP1.yesAsk,
      dirA_pmOutcome: pm2.outcome,
      dirA_pmAsk: pm2.ask,
      edgeA,
      dirB_kalTicker: kalP2.ticker,
      dirB_kalYesAsk: kalP2.yesAsk,
      dirB_pmOutcome: pm1.outcome,
      dirB_pmAsk: pm1.ask,
      edgeB,
    });

    process.stderr.write(
      `\r[Poly] ${matchTitle}: edgeA=${fmtPct(edgeA)} edgeB=${fmtPct(edgeB)}   \n`
    );
  }

  // Sort by best edge (highest first)
  arbs.sort((a, b) => Math.max(b.edgeA, b.edgeB) - Math.max(a.edgeA, a.edgeB));

  console.log(
    `\n[TENNIS ARB] Summary: ${groups.length} Kalshi groups | ` +
    `${matched} PM matched | ${notFound} not found | ${priceMissing} price missing\n`
  );

  if (!arbs.length) {
    console.log("[TENNIS ARB] No pairs with complete prices found.");
    return;
  }

  // ── Print table ─────────────────────────────────────────────────────────────

  const header = [
    padLeft("#", 3),
    padRight("Edge", 7),
    padRight("Direction", 18),
    padRight("KAL ticker", 36),
    padRight("KAL YES", 9),
    padRight("PM outcome", 16),
    padRight("PM ask", 8),
    "Match",
  ].join("  ");
  console.log(header);
  console.log("─".repeat(header.length));

  for (let i = 0; i < arbs.length; i++) {
    const a = arbs[i];
    const flagA = a.edgeA > 0 ? "***" : "   ";
    const flagB = a.edgeB > 0 ? "***" : "   ";

    console.log(
      [
        padLeft(String(i + 1), 3),
        padRight(fmtPct(a.edgeA), 7),
        padRight("KAL_P1_YES+PM_P2", 18),
        padRight(a.dirA_kalTicker, 36),
        padRight(fmtPct(a.dirA_kalYesAsk), 9),
        padRight(a.dirA_pmOutcome, 16),
        padRight(fmtPct(a.dirA_pmAsk), 8),
        `${flagA} ${a.matchTitle}`,
      ].join("  ")
    );
    console.log(
      [
        "   ",
        padRight(fmtPct(a.edgeB), 7),
        padRight("KAL_P2_YES+PM_P1", 18),
        padRight(a.dirB_kalTicker, 36),
        padRight(fmtPct(a.dirB_kalYesAsk), 9),
        padRight(a.dirB_pmOutcome, 16),
        padRight(fmtPct(a.dirB_pmAsk), 8),
        `${flagB} ${a.pmSlug}`,
      ].join("  ")
    );
    console.log();
  }

  const posArbs = arbs.filter((a) => a.edgeA > 0 || a.edgeB > 0);
  if (!posArbs.length) {
    console.log("[TENNIS ARB] No positive-edge arbitrage found.");
    console.log("[TENNIS ARB] Closest opportunities (negative edge = gap to close):");
    arbs.slice(0, 3).forEach((a) => {
      const best = Math.max(a.edgeA, a.edgeB);
      const dir =
        a.edgeA >= a.edgeB
          ? `Buy KAL_YES ${a.dirA_kalTicker} (${fmtPct(a.dirA_kalYesAsk)}) + PM ${a.dirA_pmOutcome} (${fmtPct(a.dirA_pmAsk)})`
          : `Buy KAL_YES ${a.dirB_kalTicker} (${fmtPct(a.dirB_kalYesAsk)}) + PM ${a.dirB_pmOutcome} (${fmtPct(a.dirB_pmAsk)})`;
      console.log(`  ${fmtPct(best, 2)} edge: ${dir} [${a.matchTitle}]`);
    });
  } else {
    console.log(`\n[TENNIS ARB] *** ${posArbs.length} POSITIVE-EDGE OPPORTUNITIES ***`);
    for (const a of posArbs) {
      if (a.edgeA > 0) {
        console.log(
          `  EDGE ${fmtPct(a.edgeA, 2)}: ` +
          `Buy KAL_YES ${a.dirA_kalTicker} (${fmtPct(a.dirA_kalYesAsk)}) + PM ${a.dirA_pmOutcome} (${fmtPct(a.dirA_pmAsk)})`
        );
        console.log(`    Match: ${a.matchTitle}  |  PM slug: ${a.pmSlug}`);
      }
      if (a.edgeB > 0) {
        console.log(
          `  EDGE ${fmtPct(a.edgeB, 2)}: ` +
          `Buy KAL_YES ${a.dirB_kalTicker} (${fmtPct(a.dirB_kalYesAsk)}) + PM ${a.dirB_pmOutcome} (${fmtPct(a.dirB_pmAsk)})`
        );
        console.log(`    Match: ${a.matchTitle}  |  PM slug: ${a.pmSlug}`);
      }
    }
  }

  console.log("\n[TENNIS ARB] Done.");
}

main().catch((err) => {
  console.error("[TENNIS ARB] Fatal:", (err as Error).message ?? err);
  process.exit(1);
});
