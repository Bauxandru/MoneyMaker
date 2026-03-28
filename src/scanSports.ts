/**
 * scanSports.ts
 *
 * Cross-platform arb scanner for NBA (basketball) and MLB (baseball).
 * Scans Kalshi KXNBAGAME / KXMLBGAME binary game markets against
 * Polymarket individual game markets.
 *
 * Both sports have BINARY outcomes (2 teams, no draw/tie).
 *
 * Kalshi structure:
 *   KXNBAGAME-26MAR17OKCORL-OKC  YES = Oklahoma City wins
 *   KXNBAGAME-26MAR17OKCORL-ORL  YES = Orlando wins
 *
 * Polymarket structure:
 *   slug: nba-okc-orl-2026-03-17  outcomes: ["Thunder","Magic"]
 *
 * Arb formula (same as tennis, binary):
 *   Edge A = 1 − KAL_T1_yesAsk − PM_T2_ask
 *   Edge B = 1 − KAL_T2_yesAsk − PM_T1_ask
 *
 * Usage:
 *   npx tsx src/scanSports.ts           # scan both NBA + MLB
 *   npx tsx src/scanSports.ts --nba     # NBA only
 *   npx tsx src/scanSports.ts --mlb     # MLB only
 */

import * as dotenv from "dotenv";
import { createRateLimitedFetcher } from "./http.js";

dotenv.config();

type AnyRecord = Record<string, unknown>;

// ─── Rate-limited fetch helpers ───────────────────────────────────────────────

const retryOpts = { timeoutMs: 15000, maxRetries: 4, baseDelayMs: 700, maxDelayMs: 10000, jitterMs: 300 };
const kalFetch = createRateLimitedFetcher(Number(process.env.KALSHI_REQUEST_INTERVAL_MS ?? 120), retryOpts);
const polyFetch = createRateLimitedFetcher(Number(process.env.POLY_REQUEST_INTERVAL_MS ?? 150), retryOpts);

// ─── Team mappings ───────────────────────────────────────────────────────────

// Kalshi yes_sub_title (city/name) → PM outcome (nickname)
// Kalshi uses city names, PM uses team nicknames
const NBA_TEAM_MAP: Record<string, string> = {
  "Atlanta": "Hawks", "Boston": "Celtics", "Brooklyn": "Nets",
  "Charlotte": "Hornets", "Chicago": "Bulls", "Cleveland": "Cavaliers",
  "Dallas": "Mavericks", "Denver": "Nuggets", "Detroit": "Pistons",
  "Golden State": "Warriors", "Houston": "Rockets", "Indiana": "Pacers",
  "Los Angeles C": "Clippers", "Los Angeles L": "Lakers",
  "Memphis": "Grizzlies", "Miami": "Heat", "Milwaukee": "Bucks",
  "Minnesota": "Timberwolves", "New Orleans": "Pelicans",
  "New York": "Knicks", "Oklahoma City": "Thunder", "Orlando": "Magic",
  "Philadelphia": "76ers", "Phoenix": "Suns", "Portland": "Trail Blazers",
  "Sacramento": "Kings", "San Antonio": "Spurs",
  "Toronto": "Raptors", "Utah": "Jazz", "Washington": "Wizards",
};

const MLB_TEAM_MAP: Record<string, string> = {
  "Arizona": "Diamondbacks", "A's": "Athletics", "Atlanta": "Braves",
  "Baltimore": "Orioles", "Boston": "Red Sox", "Chicago C": "Cubs",
  "Chicago WS": "White Sox", "Cincinnati": "Reds", "Cleveland": "Guardians",
  "Colorado": "Rockies", "Detroit": "Tigers", "Houston": "Astros",
  "Kansas City": "Royals", "Los Angeles A": "Angels", "Los Angeles D": "Dodgers",
  "Miami": "Marlins", "Milwaukee": "Brewers", "Minnesota": "Twins",
  "New York M": "Mets", "New York Y": "Yankees", "Philadelphia": "Phillies",
  "Pittsburgh": "Pirates", "San Diego": "Padres", "San Francisco": "Giants",
  "Seattle": "Mariners", "St. Louis": "Cardinals", "Tampa Bay": "Rays",
  "Texas": "Rangers", "Toronto": "Blue Jays", "Washington": "Nationals",
};

// ─── Date and ticker parsing ─────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/**
 * Parse date from Kalshi event ticker.
 * "KXNBAGAME-26MAR17OKCORL" → "2026-03-17"
 */
function parseDateFromEventTicker(eventTicker: string): string {
  const m = eventTicker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  return `20${m[1]}-${MONTHS[m[2].toUpperCase()]}-${m[3]}`;
}

/**
 * Extract team codes from event ticker.
 * "KXNBAGAME-26MAR17OKCORL" → codes after the date portion
 * We get them from the market tickers instead (more reliable).
 */
function extractTeamCodesFromMarkets(markets: AnyRecord[]): string[] {
  return markets.map(m => {
    const ticker = String(m.ticker || "");
    return ticker.split("-").pop() || "";
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type KalshiTeamMarket = {
  ticker: string;
  teamCode: string;    // e.g. "OKC"
  teamName: string;    // e.g. "Oklahoma City" (yes_sub_title)
  nickname: string;    // e.g. "Thunder" (mapped)
  yesAsk: number;      // decimal 0–1
  yesBid: number;
};

type KalshiGameGroup = {
  eventTicker: string;
  date: string;
  teams: KalshiTeamMarket[];  // exactly 2
  sport: "nba" | "mlb";
};

type ArbOpportunity = {
  eventTicker: string;
  pmSlug: string;
  matchTitle: string;
  sport: string;
  // Direction A: buy KAL T1_YES + PM T2_token
  dirA_kalTicker: string;
  dirA_kalYesAsk: number;
  dirA_pmOutcome: string;
  dirA_pmAsk: number;
  edgeA: number;
  // Direction B
  dirB_kalTicker: string;
  dirB_kalYesAsk: number;
  dirB_pmOutcome: string;
  dirB_pmAsk: number;
  edgeB: number;
};

// ─── Kalshi: Fetch game markets ──────────────────────────────────────────────

async function fetchKalshiGames(
  seriesTicker: string,
  sport: "nba" | "mlb",
  teamMap: Record<string, string>
): Promise<KalshiGameGroup[]> {
  const base = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const allMarkets: AnyRecord[] = [];
  let cursor = "";

  while (true) {
    const query = new URLSearchParams({ series_ticker: seriesTicker, status: "open", limit: "200" });
    if (cursor) query.set("cursor", cursor);

    let res: AnyRecord;
    try {
      res = await kalFetch<AnyRecord>(`${base}/markets?${query}`);
    } catch (err) {
      console.error(`[Kalshi/${seriesTicker}] ${(err as Error).message}`);
      break;
    }

    const mlist = Array.isArray(res.markets) ? (res.markets as AnyRecord[]) : [];
    if (!mlist.length) break;
    allMarkets.push(...mlist);

    cursor = String(res.next_cursor ?? res.cursor ?? "");
    if (!cursor) break;
  }

  // Group by event_ticker
  const eventMap = new Map<string, AnyRecord[]>();
  for (const m of allMarkets) {
    const ev = String(m.event_ticker || "");
    if (!eventMap.has(ev)) eventMap.set(ev, []);
    eventMap.get(ev)!.push(m);
  }

  // Now fetch individual market prices (list endpoint returns null prices)
  const groups: KalshiGameGroup[] = [];

  for (const [ev, markets] of eventMap) {
    if (markets.length !== 2) continue;

    const date = parseDateFromEventTicker(ev);
    if (!date) continue;

    const teams: KalshiTeamMarket[] = [];

    for (const m of markets) {
      const ticker = String(m.ticker || "");
      const teamCode = ticker.split("-").pop() || "";
      const teamName = String(m.yes_sub_title || m.subtitle || "");
      const nickname = teamMap[teamName] || teamName;

      // Fetch individual market for real prices
      let yesAsk = 0, yesBid = 0;
      try {
        const detail = await kalFetch<AnyRecord>(`${base}/markets/${ticker}`);
        const mkt = (detail as AnyRecord).market as AnyRecord | undefined;
        if (mkt) {
          yesAsk = Number(mkt.yes_ask_dollars || 0);
          yesBid = Number(mkt.yes_bid_dollars || 0);
        }
      } catch {
        // Use list prices as fallback
        yesAsk = Number(m.yes_ask_dollars || m.last_price_dollars || 0);
        yesBid = Number(m.yes_bid_dollars || 0);
      }

      if (yesAsk <= 0) continue;
      teams.push({ ticker, teamCode, teamName, nickname, yesAsk, yesBid });
    }

    if (teams.length === 2) {
      groups.push({ eventTicker: ev, date, teams, sport });
      process.stderr.write(
        `\r[Kalshi] ${ev}: ${teams[0].teamName}(${fmtPct(teams[0].yesAsk)}) vs ${teams[1].teamName}(${fmtPct(teams[1].yesAsk)})   \n`
      );
    }
  }

  console.log(`[Kalshi] ${seriesTicker}: ${groups.length} complete game pairs`);
  return groups;
}

// ─── Polymarket: Find and fetch game market ──────────────────────────────────

async function fetchPmGameMarket(
  sport: "nba" | "mlb",
  teamCodes: string[],
  date: string
): Promise<{ slug: string; outcomes: string[]; tokenIds: string[] } | null> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";

  // Try both orderings of team codes
  const [c1, c2] = teamCodes.map(c => c.toLowerCase());
  const slugCandidates = [
    `${sport}-${c1}-${c2}-${date}`,
    `${sport}-${c2}-${c1}-${date}`,
  ];

  for (const slug of slugCandidates) {
    try {
      const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
      const markets = Array.isArray(raw) ? (raw as AnyRecord[]) : [];
      if (!markets.length) continue;
      const m = markets[0];

      let outcomes: string[];
      if (typeof m.outcomes === "string") {
        try { outcomes = JSON.parse(m.outcomes); } catch { continue; }
      } else if (Array.isArray(m.outcomes)) {
        outcomes = m.outcomes as string[];
      } else continue;

      let tokenIds: string[];
      const raw_ids = m.clobTokenIds ?? m.clob_token_ids ?? "";
      if (typeof raw_ids === "string") {
        try { tokenIds = JSON.parse(raw_ids); } catch { continue; }
      } else if (Array.isArray(raw_ids)) {
        tokenIds = raw_ids as string[];
      } else continue;

      if (outcomes.length < 2 || tokenIds.length < 2) continue;
      return { slug, outcomes, tokenIds };
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchPmPrices(
  tokenIds: string[],
  outcomes: string[]
): Promise<Map<string, number>> {
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const priceMap = new Map<string, number>();

  for (let i = 0; i < outcomes.length; i++) {
    try {
      const book = await polyFetch<AnyRecord>(`${clobBase}/book?token_id=${encodeURIComponent(tokenIds[i])}`);
      const asks = Array.isArray(book.asks) ? (book.asks as AnyRecord[]) : [];
      // Asks sorted DESCENDING — cheapest (best) is LAST
      if (asks.length > 0) {
        const bestAsk = Number(asks[asks.length - 1].price || 0);
        if (bestAsk > 0) priceMap.set(outcomes[i], bestAsk);
      }
    } catch {
      // skip
    }
  }
  return priceMap;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

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
  const args = process.argv.slice(2);
  const doNba = args.length === 0 || args.includes("--nba");
  const doMlb = args.length === 0 || args.includes("--mlb");

  console.log(`[SPORTS ARB] Scanning: ${doNba ? "NBA " : ""}${doMlb ? "MLB " : ""}\n`);

  const allGames: KalshiGameGroup[] = [];

  if (doNba) {
    const nbaGames = await fetchKalshiGames("KXNBAGAME", "nba", NBA_TEAM_MAP);
    allGames.push(...nbaGames);
  }
  if (doMlb) {
    const mlbGames = await fetchKalshiGames("KXMLBGAME", "mlb", MLB_TEAM_MAP);
    allGames.push(...mlbGames);
  }

  if (!allGames.length) {
    console.log("[SPORTS ARB] No Kalshi game groups found.");
    return;
  }

  const arbs: ArbOpportunity[] = [];
  let matched = 0, notFound = 0, priceMissing = 0;

  for (const game of allGames) {
    const [t1, t2] = game.teams;

    // Find PM market
    const pmMarket = await fetchPmGameMarket(game.sport, [t1.teamCode, t2.teamCode], game.date);
    if (!pmMarket) {
      notFound++;
      process.stderr.write(`\r[PM] NOT FOUND: ${t1.teamName} vs ${t2.teamName} (${game.date}) [${game.sport}]\n`);
      continue;
    }
    matched++;

    // Fetch CLOB prices
    const pmPrices = await fetchPmPrices(pmMarket.tokenIds, pmMarket.outcomes);

    // Match Kalshi team → PM outcome by nickname
    function findPmAsk(nickname: string, teamName: string): { outcome: string; ask: number } | null {
      for (const [outcome, ask] of pmPrices) {
        const oNorm = outcome.toLowerCase();
        const nNorm = nickname.toLowerCase();
        const tNorm = teamName.toLowerCase();
        if (oNorm === nNorm || oNorm.includes(nNorm) || nNorm.includes(oNorm) ||
            oNorm === tNorm || oNorm.includes(tNorm) || tNorm.includes(oNorm)) {
          return { outcome, ask };
        }
      }
      return null;
    }

    const pm1 = findPmAsk(t1.nickname, t1.teamName);
    const pm2 = findPmAsk(t2.nickname, t2.teamName);

    if (!pm1 || !pm2) {
      priceMissing++;
      process.stderr.write(
        `\r[PM] PRICE MISS: ${t1.nickname}=${pm1?.ask} ${t2.nickname}=${pm2?.ask} @ ${pmMarket.slug}\n`
      );
      continue;
    }

    const edgeA = 1 - t1.yesAsk - pm2.ask;
    const edgeB = 1 - t2.yesAsk - pm1.ask;

    const matchTitle = `${t1.teamName} vs ${t2.teamName} (${game.date})`;

    arbs.push({
      eventTicker: game.eventTicker,
      pmSlug: pmMarket.slug,
      matchTitle,
      sport: game.sport.toUpperCase(),
      dirA_kalTicker: t1.ticker,
      dirA_kalYesAsk: t1.yesAsk,
      dirA_pmOutcome: pm2.outcome,
      dirA_pmAsk: pm2.ask,
      edgeA,
      dirB_kalTicker: t2.ticker,
      dirB_kalYesAsk: t2.yesAsk,
      dirB_pmOutcome: pm1.outcome,
      dirB_pmAsk: pm1.ask,
      edgeB,
    });

    process.stderr.write(
      `\r[${game.sport.toUpperCase()}] ${matchTitle}: edgeA=${fmtPct(edgeA)} edgeB=${fmtPct(edgeB)}   \n`
    );
  }

  // Sort by best edge
  arbs.sort((a, b) => Math.max(b.edgeA, b.edgeB) - Math.max(a.edgeA, a.edgeB));

  console.log(
    `\n[SPORTS ARB] Summary: ${allGames.length} Kalshi games | ` +
    `${matched} PM matched | ${notFound} not found | ${priceMissing} price missing\n`
  );

  if (!arbs.length) {
    console.log("[SPORTS ARB] No pairs with complete prices found.");
    return;
  }

  // Print table
  const header = [
    padLeft("#", 3),
    padRight("Sport", 5),
    padRight("Edge", 7),
    padRight("Direction", 18),
    padRight("KAL ticker", 36),
    padRight("KAL YES", 9),
    padRight("PM outcome", 20),
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
        padRight(a.sport, 5),
        padRight(fmtPct(a.edgeA), 7),
        padRight("KAL_T1_YES+PM_T2", 18),
        padRight(a.dirA_kalTicker, 36),
        padRight(fmtPct(a.dirA_kalYesAsk), 9),
        padRight(a.dirA_pmOutcome, 20),
        padRight(fmtPct(a.dirA_pmAsk), 8),
        `${flagA} ${a.matchTitle}`,
      ].join("  ")
    );
    console.log(
      [
        "   ",
        padRight("", 5),
        padRight(fmtPct(a.edgeB), 7),
        padRight("KAL_T2_YES+PM_T1", 18),
        padRight(a.dirB_kalTicker, 36),
        padRight(fmtPct(a.dirB_kalYesAsk), 9),
        padRight(a.dirB_pmOutcome, 20),
        padRight(fmtPct(a.dirB_pmAsk), 8),
        `${flagB} ${a.pmSlug}`,
      ].join("  ")
    );
    console.log();
  }

  const posArbs = arbs.filter(a => a.edgeA > 0 || a.edgeB > 0);
  if (!posArbs.length) {
    console.log("[SPORTS ARB] No positive-edge arbitrage found.");
    console.log("[SPORTS ARB] Closest opportunities:");
    arbs.slice(0, 5).forEach(a => {
      const best = Math.max(a.edgeA, a.edgeB);
      const dir = a.edgeA >= a.edgeB
        ? `Buy KAL_YES ${a.dirA_kalTicker} (${fmtPct(a.dirA_kalYesAsk)}) + PM ${a.dirA_pmOutcome} (${fmtPct(a.dirA_pmAsk)})`
        : `Buy KAL_YES ${a.dirB_kalTicker} (${fmtPct(a.dirB_kalYesAsk)}) + PM ${a.dirB_pmOutcome} (${fmtPct(a.dirB_pmAsk)})`;
      console.log(`  ${fmtPct(best, 2)} edge: ${dir} [${a.matchTitle}]`);
    });
  } else {
    console.log(`\n[SPORTS ARB] *** ${posArbs.length} POSITIVE-EDGE OPPORTUNITIES ***`);
    for (const a of posArbs) {
      if (a.edgeA > 0) {
        console.log(
          `  EDGE ${fmtPct(a.edgeA, 2)}: Buy KAL_YES ${a.dirA_kalTicker} (${fmtPct(a.dirA_kalYesAsk)}) + PM ${a.dirA_pmOutcome} (${fmtPct(a.dirA_pmAsk)})`
        );
        console.log(`    Match: ${a.matchTitle}  |  PM slug: ${a.pmSlug}`);
      }
      if (a.edgeB > 0) {
        console.log(
          `  EDGE ${fmtPct(a.edgeB, 2)}: Buy KAL_YES ${a.dirB_kalTicker} (${fmtPct(a.dirB_kalYesAsk)}) + PM ${a.dirB_pmOutcome} (${fmtPct(a.dirB_pmAsk)})`
        );
        console.log(`    Match: ${a.matchTitle}  |  PM slug: ${a.pmSlug}`);
      }
    }
  }

  console.log("\n[SPORTS ARB] Done.");
}

main().catch(err => {
  console.error("[SPORTS ARB] Fatal:", (err as Error).message ?? err);
  process.exit(1);
});
