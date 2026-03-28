/**
 * scanAll.ts — Universal cross-platform arb scanner
 *
 * Scans ALL sports with game-level binary markets on both Kalshi and Polymarket:
 *
 * Basketball: NBA, CBA, KBL, BBL, Euroleague, EuroCup, LNB Elite, VTB, ABA League
 * Baseball:   MLB
 * Hockey:     NHL
 * Tennis:     ATP, WTA
 * Esports:    CS2, Valorant, LoL, COD
 * Fighting:   UFC, Boxing
 *
 * Soccer/Football group (separate command — 3-way arb math):
 *   EPL, La Liga, Ligue 1, Serie A, Bundesliga, MLS, EFL Championship,
 *   La Liga 2, Eredivisie, Danish Superliga, A-League, Brasileirão,
 *   Colombian Primera, UCL, Europa League, Conference League,
 *   Turkish Süper Lig, Liga MX, K-League, J-League, Serie B,
 *   Argentine Primera, AFL (Aussie Rules)
 *
 * Matching strategy:
 *   - "slug" sports (NBA, NHL, MLB): construct PM slug from Kalshi team codes + date
 *   - "bulk" sports (intl basketball, esports, tennis, fighting):
 *     bulk-fetch PM events by tag, then fuzzy-match team/player names from Kalshi titles
 *
 * Arb formula (binary, 2 outcomes):
 *   Edge A = 1 − KAL_T1_yesAsk − PM_T2_ask
 *   Edge B = 1 − KAL_T2_yesAsk − PM_T1_ask
 *
 * Arb formula (3-way: home/away/draw):
 *   Edge_Home = 1 − KAL_Home_yesAsk − PM_Away_ask − PM_Draw_ask
 *   Edge_Away = 1 − KAL_Away_yesAsk − PM_Home_ask − PM_Draw_ask
 *   Edge_Draw = 1 − KAL_Draw_yesAsk − PM_Home_ask − PM_Away_ask
 *
 * Usage:
 *   npx tsx src/scanAll.ts                    # scan everything (excl. soccer)
 *   npx tsx src/scanAll.ts --nba --nhl        # specific sports only
 *   npx tsx src/scanAll.ts --soccer           # soccer/football group only
 */

import * as dotenv from "dotenv";
import { createRateLimitedFetcher } from "./http.js";

dotenv.config();

type R = Record<string, unknown>;

const retryOpts = { timeoutMs: 15000, maxRetries: 4, baseDelayMs: 700, maxDelayMs: 10000, jitterMs: 300 };
const kalFetch = createRateLimitedFetcher(Number(process.env.KALSHI_REQUEST_INTERVAL_MS ?? 120), retryOpts);
const polyFetch = createRateLimitedFetcher(Number(process.env.POLY_REQUEST_INTERVAL_MS ?? 150), retryOpts);

const KALSHI_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA_BASE = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const CLOB_BASE = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

// ─── Sport configs ───────────────────────────────────────────────────────────

type MatchMode = "slug" | "bulk";

interface SportConfig {
  key: string;
  label: string;
  kalshiSeries: string;
  mode: MatchMode;
  // slug mode: PM slug = `${pmSlugPrefix}-${code1}-${code2}-${date}`
  pmSlugPrefix?: string;
  // bulk mode: fetch PM events by tag, fuzzy-match
  pmTag?: string;
  // For Kalshi team name → PM nickname mapping (slug mode only)
  teamMap?: Record<string, string>;
  // How to extract team/player name from Kalshi market
  nameExtract: "sub_title" | "title_will_win";
  // 3-way markets (home/away/draw) — soccer, AFL
  is3Way?: boolean;
}

// ─── Team maps for slug-mode sports ──────────────────────────────────────────

const NBA_MAP: Record<string, string> = {
  "Atlanta":"Hawks","Boston":"Celtics","Brooklyn":"Nets","Charlotte":"Hornets",
  "Chicago":"Bulls","Cleveland":"Cavaliers","Dallas":"Mavericks","Denver":"Nuggets",
  "Detroit":"Pistons","Golden State":"Warriors","Houston":"Rockets","Indiana":"Pacers",
  "Los Angeles C":"Clippers","Los Angeles L":"Lakers","Memphis":"Grizzlies","Miami":"Heat",
  "Milwaukee":"Bucks","Minnesota":"Timberwolves","New Orleans":"Pelicans","New York":"Knicks",
  "Oklahoma City":"Thunder","Orlando":"Magic","Philadelphia":"76ers","Phoenix":"Suns",
  "Portland":"Trail Blazers","Sacramento":"Kings","San Antonio":"Spurs","Toronto":"Raptors",
  "Utah":"Jazz","Washington":"Wizards",
};

const NHL_MAP: Record<string, string> = {
  "ANA Ducks":"Ducks","AZ Coyotes":"Coyotes","BOS Bruins":"Bruins","BUF Sabres":"Sabres",
  "CAR Hurricanes":"Hurricanes","CBJ Blue Jackets":"Blue Jackets","CGY Flames":"Flames",
  "CHI Blackhawks":"Blackhawks","COL Avalanche":"Avalanche","DAL Stars":"Stars",
  "DET Red Wings":"Red Wings","EDM Oilers":"Oilers","FLA Panthers":"Panthers",
  "LA Kings":"Kings","MIN Wild":"Wild","MTL Canadiens":"Canadiens","NJ Devils":"Devils",
  "NSH Predators":"Predators","NYI Islanders":"Islanders","NYR Rangers":"Rangers",
  "OTT Senators":"Senators","PHI Flyers":"Flyers","PIT Penguins":"Penguins",
  "SEA Kraken":"Kraken","SJ Sharks":"Sharks","STL Blues":"Blues","TB Lightning":"Lightning",
  "TOR Maple Leafs":"Maple Leafs","UTA Hockey Club":"Utah","VAN Canucks":"Canucks",
  "VGK Golden Knights":"Golden Knights","WPG Jets":"Jets","WSH Capitals":"Capitals",
};

const MLB_MAP: Record<string, string> = {
  "Arizona":"Diamondbacks","A's":"Athletics","Atlanta":"Braves","Baltimore":"Orioles",
  "Boston":"Red Sox","Chicago C":"Cubs","Chicago WS":"White Sox","Cincinnati":"Reds",
  "Cleveland":"Guardians","Colorado":"Rockies","Detroit":"Tigers","Houston":"Astros",
  "Kansas City":"Royals","Los Angeles A":"Angels","Los Angeles D":"Dodgers","Miami":"Marlins",
  "Milwaukee":"Brewers","Minnesota":"Twins","New York M":"Mets","New York Y":"Yankees",
  "Philadelphia":"Phillies","Pittsburgh":"Pirates","San Diego":"Padres",
  "San Francisco":"Giants","Seattle":"Mariners","St. Louis":"Cardinals",
  "Tampa Bay":"Rays","Texas":"Rangers","Toronto":"Blue Jays","Washington":"Nationals",
};

// ─── All sport definitions ───────────────────────────────────────────────────

const ALL_SPORTS: SportConfig[] = [
  // Slug-mode sports (clean PM slug patterns)
  { key: "nba", label: "NBA", kalshiSeries: "KXNBAGAME", mode: "slug", pmSlugPrefix: "nba", teamMap: NBA_MAP, nameExtract: "sub_title" },
  { key: "nhl", label: "NHL", kalshiSeries: "KXNHLGAME", mode: "slug", pmSlugPrefix: "nhl", teamMap: NHL_MAP, nameExtract: "sub_title" },
  { key: "mlb", label: "MLB", kalshiSeries: "KXMLBGAME", mode: "slug", pmSlugPrefix: "mlb", teamMap: MLB_MAP, nameExtract: "sub_title" },
  // Bulk-mode sports (fuzzy match PM events by tag)
  { key: "cba", label: "CBA", kalshiSeries: "KXCBAGAME", mode: "bulk", pmTag: "cba", nameExtract: "sub_title" },
  { key: "kbl", label: "KBL", kalshiSeries: "KXKBLGAME", mode: "bulk", pmTag: "kbl", nameExtract: "sub_title" },
  { key: "bbl", label: "BBL", kalshiSeries: "KXBBLGAME", mode: "bulk", pmTag: "bbl", nameExtract: "sub_title" },
  { key: "euroleague", label: "Euroleague", kalshiSeries: "KXEUROLEAGUEGAME", mode: "bulk", pmTag: "euroleague", nameExtract: "sub_title" },
  { key: "eurocup", label: "EuroCup", kalshiSeries: "KXEUROCUPGAME", mode: "bulk", pmTag: "eurocup", nameExtract: "sub_title" },
  { key: "lnb", label: "LNB Elite", kalshiSeries: "KXLNBELITEGAME", mode: "bulk", pmTag: "lnb-elite", nameExtract: "sub_title" },
  { key: "vtb", label: "VTB", kalshiSeries: "KXVTBGAME", mode: "bulk", pmTag: "vtb", nameExtract: "sub_title" },
  // Tennis
  { key: "atp", label: "ATP", kalshiSeries: "KXATPMATCH", mode: "bulk", pmTag: "tennis", nameExtract: "title_will_win" },
  { key: "wta", label: "WTA", kalshiSeries: "KXWTAMATCH", mode: "bulk", pmTag: "tennis", nameExtract: "title_will_win" },
  // Esports
  { key: "cs2", label: "CS2", kalshiSeries: "KXCS2GAME", mode: "bulk", pmTag: "csgo", nameExtract: "sub_title" },
  { key: "valorant", label: "Valorant", kalshiSeries: "KXVALORANTGAME", mode: "bulk", pmTag: "valorant", nameExtract: "sub_title" },
  { key: "lol", label: "LoL", kalshiSeries: "KXLOLGAME", mode: "bulk", pmTag: "league-of-legends", nameExtract: "sub_title" },
  { key: "cod", label: "COD", kalshiSeries: "KXCODGAME", mode: "bulk", pmTag: "call-of-duty", nameExtract: "sub_title" },
  // Fighting
  { key: "ufc", label: "UFC", kalshiSeries: "KXUFCFIGHT", mode: "bulk", pmTag: "mma", nameExtract: "sub_title" },
  { key: "boxing", label: "Boxing", kalshiSeries: "KXBOXING", mode: "bulk", pmTag: "boxing", nameExtract: "sub_title" },
  // Basketball (additional)
  { key: "aba", label: "ABA League", kalshiSeries: "KXABAGAME", mode: "bulk", pmTag: "aba-league", nameExtract: "sub_title" },
];

// Soccer / football group — scanned separately via --soccer
// All are 3-way (home/away/draw), Kalshi has 3 binary markets per event
const SOCCER_SPORTS: SportConfig[] = [
  // Top 5 leagues
  { key: "epl", label: "EPL", kalshiSeries: "KXEPLGAME", mode: "bulk", pmTag: "premier-league", nameExtract: "sub_title", is3Way: true },
  { key: "laliga", label: "La Liga", kalshiSeries: "KXLALIGAGAME", mode: "bulk", pmTag: "la-liga", nameExtract: "sub_title", is3Way: true },
  { key: "ligue1", label: "Ligue 1", kalshiSeries: "KXLIGUE1GAME", mode: "bulk", pmTag: "ligue-1", nameExtract: "sub_title", is3Way: true },
  { key: "seriea", label: "Serie A", kalshiSeries: "KXSERIEAGAME", mode: "bulk", pmTag: "serie-a", nameExtract: "sub_title", is3Way: true },
  { key: "bundesliga", label: "Bundesliga", kalshiSeries: "KXBUNDESLIGAGAME", mode: "bulk", pmTag: "bundesliga", nameExtract: "sub_title", is3Way: true },
  // Other European leagues
  { key: "efl", label: "EFL Champ", kalshiSeries: "KXEFLCHAMPIONSHIPGAME", mode: "bulk", pmTag: "efl-championship", nameExtract: "sub_title", is3Way: true },
  { key: "laliga2", label: "La Liga 2", kalshiSeries: "KXLALIGA2GAME", mode: "bulk", pmTag: "segunda-division", nameExtract: "sub_title", is3Way: true },
  { key: "serieb", label: "Serie B", kalshiSeries: "KXSERIEBGAME", mode: "bulk", pmTag: "serie-b", nameExtract: "sub_title", is3Way: true },
  { key: "eredivisie", label: "Eredivisie", kalshiSeries: "KXEREDIVISIEGAME", mode: "bulk", pmTag: "eredivisie", nameExtract: "sub_title", is3Way: true },
  { key: "superlig", label: "Süper Lig", kalshiSeries: "KXSUPERLIGGAME", mode: "bulk", pmTag: "super-lig", nameExtract: "sub_title", is3Way: true },
  { key: "danish", label: "Dan Superliga", kalshiSeries: "KXDENSUPERLIGAGAME", mode: "bulk", pmTag: "danish-superliga", nameExtract: "sub_title", is3Way: true },
  // European cups
  { key: "ucl", label: "UCL", kalshiSeries: "KXUCLGAME", mode: "bulk", pmTag: "champions-league", nameExtract: "sub_title", is3Way: true },
  { key: "uel", label: "Europa League", kalshiSeries: "KXUELGAME", mode: "bulk", pmTag: "europa-league", nameExtract: "sub_title", is3Way: true },
  { key: "uecl", label: "Conf League", kalshiSeries: "KXUECLGAME", mode: "bulk", pmTag: "conference-league", nameExtract: "sub_title", is3Way: true },
  // Americas
  { key: "mls", label: "MLS", kalshiSeries: "KXMLSGAME", mode: "bulk", pmTag: "mls", nameExtract: "sub_title", is3Way: true },
  { key: "ligamx", label: "Liga MX", kalshiSeries: "KXLIGAMXGAME", mode: "bulk", pmTag: "liga-mx", nameExtract: "sub_title", is3Way: true },
  { key: "brasileirao", label: "Brasileirão", kalshiSeries: "KXBRASILEIROGAME", mode: "bulk", pmTag: "brasileirao", nameExtract: "sub_title", is3Way: true },
  { key: "dimayor", label: "Col Primera", kalshiSeries: "KXDIMAYORGAME", mode: "bulk", pmTag: "liga-dimayor", nameExtract: "sub_title", is3Way: true },
  { key: "argentina", label: "Arg Primera", kalshiSeries: "KXARGPREMDIVGAME", mode: "bulk", pmTag: "primera-division", nameExtract: "sub_title", is3Way: true },
  // Asia/Oceania
  { key: "kleague", label: "K-League", kalshiSeries: "KXKLEAGUEGAME", mode: "bulk", pmTag: "k-league", nameExtract: "sub_title", is3Way: true },
  { key: "jleague", label: "J-League", kalshiSeries: "KXJLEAGUEGAME", mode: "bulk", pmTag: "j-league", nameExtract: "sub_title", is3Way: true },
  { key: "aleague", label: "A-League", kalshiSeries: "KXALEAGUEGAME", mode: "bulk", pmTag: "a-league", nameExtract: "sub_title", is3Way: true },
  // Aussie Rules (binary, but grouped with soccer/football)
  { key: "afl", label: "AFL", kalshiSeries: "KXAFLGAME", mode: "bulk", pmTag: "afl", nameExtract: "sub_title" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface KalshiTeam {
  ticker: string;
  code: string;
  name: string;     // yes_sub_title or extracted name
  yesAsk: number;
  yesBid: number;
}

interface KalshiGame {
  eventTicker: string;
  date: string;
  teams: KalshiTeam[];
  sport: SportConfig;
}

interface ArbOpp {
  sport: string;
  matchTitle: string;
  pmSlug: string;
  dirA_kalTicker: string; dirA_kalAsk: number; dirA_pmOutcome: string; dirA_pmAsk: number; edgeA: number;
  dirB_kalTicker: string; dirB_kalAsk: number; dirB_pmOutcome: string; dirB_pmAsk: number; edgeB: number;
}

interface ArbOpp3Way {
  sport: string;
  matchTitle: string;
  pmSlug: string;
  // 3 directions: buy Kalshi X YES + PM other two
  dirs: {
    label: string;           // "Home" / "Away" / "Draw"
    kalTicker: string;
    kalAsk: number;
    pmOut1: string; pmAsk1: number;
    pmOut2: string; pmAsk2: number;
    edge: number;            // 1 - kalAsk - pmAsk1 - pmAsk2
  }[];
  bestEdge: number;
}

// ─── Date parsing ────────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
  JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12",
};

function parseDateFromTicker(ticker: string): string {
  const m = ticker.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return "";
  return `20${m[1]}-${MONTHS[m[2].toUpperCase()]}-${m[3]}`;
}

function extractNameFromTitle(title: string): string {
  const m = title.match(/^Will\s+(.+?)\s+win\s+the\s+/i);
  return m ? m[1].trim() : "";
}

// ─── Kalshi: Fetch all game markets for a series ─────────────────────────────

async function fetchKalshiGames(sport: SportConfig): Promise<KalshiGame[]> {
  const allMarkets: R[] = [];
  let cursor = "";

  while (true) {
    const q = new URLSearchParams({ series_ticker: sport.kalshiSeries, status: "open", limit: "200" });
    if (cursor) q.set("cursor", cursor);
    let res: R;
    try { res = await kalFetch<R>(`${KALSHI_BASE}/markets?${q}`); }
    catch { break; }
    const mlist = Array.isArray(res.markets) ? (res.markets as R[]) : [];
    if (!mlist.length) break;
    allMarkets.push(...mlist);
    cursor = String(res.next_cursor ?? res.cursor ?? "");
    if (!cursor) break;
  }

  // Group by event
  const evMap = new Map<string, R[]>();
  for (const m of allMarkets) {
    const ev = String(m.event_ticker || "");
    if (!evMap.has(ev)) evMap.set(ev, []);
    evMap.get(ev)!.push(m);
  }

  const games: KalshiGame[] = [];

  const expectedCount = sport.is3Way ? 3 : 2;

  for (const [ev, mkts] of evMap) {
    if (mkts.length !== expectedCount) continue;
    const date = parseDateFromTicker(ev);
    if (!date) continue;

    const teams: KalshiTeam[] = [];
    for (const m of mkts) {
      const ticker = String(m.ticker || "");
      const code = ticker.split("-").pop() || "";

      let name = "";
      if (sport.nameExtract === "title_will_win") {
        name = extractNameFromTitle(String(m.title || ""));
      } else {
        name = String(m.yes_sub_title || m.subtitle || "");
      }

      // Fetch individual market for prices (list endpoint often returns null)
      let yesAsk = 0, yesBid = 0;
      try {
        const d = await kalFetch<R>(`${KALSHI_BASE}/markets/${ticker}`);
        const mkt = d.market as R | undefined;
        if (mkt) {
          yesAsk = Number(mkt.yes_ask_dollars || 0);
          yesBid = Number(mkt.yes_bid_dollars || 0);
        }
      } catch {
        yesAsk = Number(m.last_price_dollars || 0);
      }

      if (yesAsk <= 0) continue;
      teams.push({ ticker, code, name, yesAsk, yesBid });
    }

    if (teams.length === expectedCount) {
      games.push({ eventTicker: ev, date, teams, sport });
    }
  }

  if (games.length > 0) {
    console.log(`[${sport.label}] ${games.length} games on Kalshi`);
  }
  return games;
}

// ─── PM: Slug-mode matching (NBA, NHL, MLB) ─────────────────────────────────

async function findPmBySlug(
  game: KalshiGame
): Promise<{ slug: string; outcomes: string[]; tokenIds: string[] } | null> {
  const prefix = game.sport.pmSlugPrefix!;
  const [c1, c2] = game.teams.map(t => t.code.toLowerCase());
  const slugs = [`${prefix}-${c1}-${c2}-${game.date}`, `${prefix}-${c2}-${c1}-${game.date}`];

  for (const slug of slugs) {
    try {
      const raw = await polyFetch<unknown>(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`);
      const arr = Array.isArray(raw) ? (raw as R[]) : [];
      if (!arr.length) continue;
      const m = arr[0];
      const outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes;
      const tokenIds = typeof (m.clobTokenIds ?? m.clob_token_ids ?? "") === "string"
        ? JSON.parse(String(m.clobTokenIds ?? m.clob_token_ids ?? "[]"))
        : (m.clobTokenIds ?? m.clob_token_ids);
      if (outcomes?.length >= 2 && tokenIds?.length >= 2) return { slug, outcomes, tokenIds };
    } catch { /* next */ }
  }
  return null;
}

// ─── PM: Bulk-mode matching (esports, intl basketball, tennis, fighting) ────

// Cache PM events per tag so we don't re-fetch
const pmEventCache = new Map<string, R[]>();

async function fetchPmEventsByTag(tag: string): Promise<R[]> {
  if (pmEventCache.has(tag)) return pmEventCache.get(tag)!;

  const allEvents: R[] = [];
  // Fetch up to 200 events
  for (let offset = 0; offset < 200; offset += 50) {
    try {
      const raw = await polyFetch<unknown>(`${GAMMA_BASE}/events?tag_slug=${tag}&limit=50&offset=${offset}&active=true`);
      const events = Array.isArray(raw) ? (raw as R[]) : [];
      if (!events.length) break;
      allEvents.push(...events);
    } catch { break; }
  }
  pmEventCache.set(tag, allEvents);
  return allEvents;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function findPmByBulk(
  game: KalshiGame
): Promise<{ slug: string; outcomes: string[]; tokenIds: string[] } | null> {
  const tag = game.sport.pmTag!;
  const events = await fetchPmEventsByTag(tag);

  const [t1, t2] = game.teams;
  const name1 = normalize(t1.name);
  const name2 = normalize(t2.name);
  // Also try surname (last word) for tennis
  const sur1 = normalize(t1.name.split(/\s+/).pop() || t1.name);
  const sur2 = normalize(t2.name.split(/\s+/).pop() || t2.name);

  for (const event of events) {
    const markets = Array.isArray(event.markets) ? (event.markets as R[]) : [];
    for (const m of markets) {
      const question = normalize(String(m.question || ""));
      const slug = String(m.slug || "");
      const outcomesRaw = m.outcomes;
      const tokenIdsRaw = m.clobTokenIds ?? m.clob_token_ids ?? "";

      let outcomes: string[];
      try {
        outcomes = typeof outcomesRaw === "string" ? JSON.parse(outcomesRaw) : (outcomesRaw as string[]);
      } catch { continue; }

      let tokenIds: string[];
      try {
        tokenIds = typeof tokenIdsRaw === "string" ? JSON.parse(tokenIdsRaw || "[]") : (tokenIdsRaw as string[]);
      } catch { continue; }

      if (!outcomes || outcomes.length < 2 || !tokenIds || tokenIds.length < 2) continue;

      // Check if this market matches our Kalshi game
      // Match: both team names (or surnames for tennis) appear in question or outcomes
      const outcomeNorms = outcomes.map(o => normalize(o));
      const allText = question + " " + outcomeNorms.join(" ");

      const match1 = allText.includes(name1) || allText.includes(sur1) ||
        outcomeNorms.some(o => o.includes(name1) || name1.includes(o) || o.includes(sur1) || sur1.includes(o));
      const match2 = allText.includes(name2) || allText.includes(sur2) ||
        outcomeNorms.some(o => o.includes(name2) || name2.includes(o) || o.includes(sur2) || sur2.includes(o));

      if (match1 && match2) {
        return { slug, outcomes, tokenIds };
      }
    }
  }
  return null;
}

// ─── PM: Fetch CLOB prices ──────────────────────────────────────────────────

async function fetchPmPrices(tokenIds: string[], outcomes: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  for (let i = 0; i < outcomes.length; i++) {
    try {
      const book = await polyFetch<R>(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenIds[i])}`);
      const asks = Array.isArray(book.asks) ? (book.asks as R[]) : [];
      if (asks.length > 0) {
        // Asks sorted DESCENDING — cheapest (best) is LAST
        const bestAsk = Number(asks[asks.length - 1].price || 0);
        if (bestAsk > 0) prices.set(outcomes[i], bestAsk);
      }
    } catch { /* skip */ }
  }
  return prices;
}

// ─── Match Kalshi team → PM outcome ──────────────────────────────────────────

function matchTeamToOutcome(
  team: KalshiTeam,
  pmPrices: Map<string, number>,
  teamMap?: Record<string, string>
): { outcome: string; ask: number } | null {
  const nickname = teamMap?.[team.name] || team.name;
  const nameNorm = normalize(team.name);
  const nickNorm = normalize(nickname);
  const surNorm = normalize(team.name.split(/\s+/).pop() || team.name);

  for (const [outcome, ask] of pmPrices) {
    const oNorm = normalize(outcome);
    if (
      oNorm === nickNorm || oNorm === nameNorm || oNorm === surNorm ||
      oNorm.includes(nickNorm) || nickNorm.includes(oNorm) ||
      oNorm.includes(nameNorm) || nameNorm.includes(oNorm) ||
      oNorm.includes(surNorm) || surNorm.includes(oNorm)
    ) {
      return { outcome, ask };
    }
  }
  return null;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtPct(v: number, d = 1): string { return (v * 100).toFixed(d) + "%"; }
function pad(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function padL(s: string, n: number): string { return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s; }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2).map(a => a.replace("--", ""));
  const isSoccerMode = args.includes("soccer");
  const filteredArgs = args.filter(a => a !== "soccer");
  const scanAll = filteredArgs.length === 0 && !isSoccerMode;

  let sports: SportConfig[];
  if (isSoccerMode) {
    sports = SOCCER_SPORTS;
  } else {
    sports = ALL_SPORTS.filter(s => scanAll || filteredArgs.includes(s.key));
  }

  if (!sports.length) {
    console.log("No sports selected. Available: " + ALL_SPORTS.map(s => s.key).join(", ") + ", soccer");
    return;
  }

  console.log(`[SCAN ALL] Scanning ${sports.length} sports: ${sports.map(s => s.label).join(", ")}\n`);

  const allArbs: ArbOpp[] = [];
  const all3WayArbs: ArbOpp3Way[] = [];
  let totalGames = 0, totalMatched = 0, totalNotFound = 0, totalPriceMiss = 0;

  for (const sport of sports) {
    const games = await fetchKalshiGames(sport);
    if (!games.length) continue;
    totalGames += games.length;

    for (const game of games) {
      // Find PM market
      const pmMarket = sport.mode === "slug"
        ? await findPmBySlug(game)
        : await findPmByBulk(game);

      if (!pmMarket) {
        totalNotFound++;
        continue;
      }
      totalMatched++;

      // Fetch CLOB prices
      const pmPrices = await fetchPmPrices(pmMarket.tokenIds, pmMarket.outcomes);

      if (sport.is3Way && game.teams.length === 3) {
        // ── 3-way arb (soccer) ──
        // Match all 3 Kalshi teams to PM outcomes
        const pmMatches = game.teams.map(t => matchTeamToOutcome(t, pmPrices, sport.teamMap));
        // Also try matching "Draw"/"Tie" directly for the draw market
        for (let i = 0; i < game.teams.length; i++) {
          if (pmMatches[i]) continue;
          const nameL = game.teams[i].name.toLowerCase();
          if (nameL === "draw" || nameL === "tie") {
            for (const [outcome, ask] of pmPrices) {
              const oL = outcome.toLowerCase();
              if (oL === "draw" || oL === "tie") {
                pmMatches[i] = { outcome, ask };
                break;
              }
            }
          }
        }

        if (pmMatches.some(m => !m)) { totalPriceMiss++; continue; }

        const dirs: ArbOpp3Way["dirs"] = [];
        for (let i = 0; i < 3; i++) {
          const others = [0, 1, 2].filter(j => j !== i);
          const edge = 1 - game.teams[i].yesAsk - pmMatches[others[0]]!.ask - pmMatches[others[1]]!.ask;
          const nameL = game.teams[i].name.toLowerCase();
          const label = (nameL === "draw" || nameL === "tie") ? "Draw" : game.teams[i].name;
          dirs.push({
            label,
            kalTicker: game.teams[i].ticker,
            kalAsk: game.teams[i].yesAsk,
            pmOut1: pmMatches[others[0]]!.outcome, pmAsk1: pmMatches[others[0]]!.ask,
            pmOut2: pmMatches[others[1]]!.outcome, pmAsk2: pmMatches[others[1]]!.ask,
            edge,
          });
        }

        const teamNames = game.teams.filter(t => t.name.toLowerCase() !== "draw" && t.name.toLowerCase() !== "tie").map(t => t.name);
        const title = `${teamNames[0] ?? "?"} vs ${teamNames[1] ?? "?"} (${game.date})`;

        all3WayArbs.push({
          sport: sport.label,
          matchTitle: title,
          pmSlug: pmMarket.slug,
          dirs,
          bestEdge: Math.max(...dirs.map(d => d.edge)),
        });
      } else {
        // ── Binary arb (2-outcome) ──
        const [t1, t2] = game.teams;
        const pm1 = matchTeamToOutcome(t1, pmPrices, sport.teamMap);
        const pm2 = matchTeamToOutcome(t2, pmPrices, sport.teamMap);

        if (!pm1 || !pm2) { totalPriceMiss++; continue; }

        const edgeA = 1 - t1.yesAsk - pm2.ask;
        const edgeB = 1 - t2.yesAsk - pm1.ask;
        const title = `${t1.name} vs ${t2.name} (${game.date})`;

        allArbs.push({
          sport: sport.label,
          matchTitle: title,
          pmSlug: pmMarket.slug,
          dirA_kalTicker: t1.ticker, dirA_kalAsk: t1.yesAsk, dirA_pmOutcome: pm2.outcome, dirA_pmAsk: pm2.ask, edgeA,
          dirB_kalTicker: t2.ticker, dirB_kalAsk: t2.yesAsk, dirB_pmOutcome: pm1.outcome, dirB_pmAsk: pm1.ask, edgeB,
        });
      }
    }
  }

  console.log(
    `\n[SCAN ALL] Summary: ${totalGames} Kalshi games | ` +
    `${totalMatched} PM matched | ${totalNotFound} not found | ${totalPriceMiss} price missing\n`
  );

  // ── Print binary arbs ──
  if (allArbs.length > 0) {
    allArbs.sort((a, b) => Math.max(b.edgeA, b.edgeB) - Math.max(a.edgeA, a.edgeB));

    const hdr = [
      padL("#", 3), pad("Sport", 12), pad("Edge", 7), pad("Direction", 18),
      pad("KAL ticker", 40), pad("KAL ask", 8), pad("PM outcome", 22), pad("PM ask", 8), "Match",
    ].join("  ");
    console.log(hdr);
    console.log("─".repeat(hdr.length));

    for (let i = 0; i < allArbs.length; i++) {
      const a = allArbs[i];
      const fA = a.edgeA > 0 ? "***" : "   ";
      const fB = a.edgeB > 0 ? "***" : "   ";

      console.log([
        padL(String(i + 1), 3), pad(a.sport, 12), pad(fmtPct(a.edgeA), 7), pad("KAL_T1+PM_T2", 18),
        pad(a.dirA_kalTicker, 40), pad(fmtPct(a.dirA_kalAsk), 8), pad(a.dirA_pmOutcome, 22), pad(fmtPct(a.dirA_pmAsk), 8),
        `${fA} ${a.matchTitle}`,
      ].join("  "));
      console.log([
        "   ", pad("", 12), pad(fmtPct(a.edgeB), 7), pad("KAL_T2+PM_T1", 18),
        pad(a.dirB_kalTicker, 40), pad(fmtPct(a.dirB_kalAsk), 8), pad(a.dirB_pmOutcome, 22), pad(fmtPct(a.dirB_pmAsk), 8),
        `${fB} ${a.pmSlug}`,
      ].join("  "));
      console.log();
    }

    const posArbs = allArbs.filter(a => a.edgeA > 0 || a.edgeB > 0);
    if (!posArbs.length) {
      console.log("[SCAN] No positive-edge binary arbitrage found.");
      console.log("[SCAN] Top 10 closest:");
      allArbs.slice(0, 10).forEach(a => {
        const best = Math.max(a.edgeA, a.edgeB);
        const dir = a.edgeA >= a.edgeB
          ? `KAL ${a.dirA_kalTicker}(${fmtPct(a.dirA_kalAsk)}) + PM ${a.dirA_pmOutcome}(${fmtPct(a.dirA_pmAsk)})`
          : `KAL ${a.dirB_kalTicker}(${fmtPct(a.dirB_kalAsk)}) + PM ${a.dirB_pmOutcome}(${fmtPct(a.dirB_pmAsk)})`;
        console.log(`  ${fmtPct(best, 2)}: ${dir} [${a.sport}] ${a.matchTitle}`);
      });
    } else {
      console.log(`\n[SCAN] *** ${posArbs.length} POSITIVE-EDGE BINARY OPPORTUNITIES ***`);
      for (const a of posArbs) {
        if (a.edgeA > 0) {
          console.log(`  ${a.sport} EDGE ${fmtPct(a.edgeA, 2)}: KAL ${a.dirA_kalTicker}(${fmtPct(a.dirA_kalAsk)}) + PM ${a.dirA_pmOutcome}(${fmtPct(a.dirA_pmAsk)})`);
          console.log(`    ${a.matchTitle} | ${a.pmSlug}`);
        }
        if (a.edgeB > 0) {
          console.log(`  ${a.sport} EDGE ${fmtPct(a.edgeB, 2)}: KAL ${a.dirB_kalTicker}(${fmtPct(a.dirB_kalAsk)}) + PM ${a.dirB_pmOutcome}(${fmtPct(a.dirB_pmAsk)})`);
          console.log(`    ${a.matchTitle} | ${a.pmSlug}`);
        }
      }
    }
  }

  // ── Print 3-way arbs ──
  if (all3WayArbs.length > 0) {
    all3WayArbs.sort((a, b) => b.bestEdge - a.bestEdge);

    console.log(`\n${"═".repeat(100)}`);
    console.log(`[SOCCER 3-WAY] ${all3WayArbs.length} matches with complete prices\n`);

    const hdr3 = [
      padL("#", 3), pad("League", 14), pad("Edge", 7), pad("Buy KAL", 14),
      pad("KAL ask", 8), pad("+ PM 1", 16), pad("PM ask1", 8), pad("+ PM 2", 16), pad("PM ask2", 8), "Match",
    ].join("  ");
    console.log(hdr3);
    console.log("─".repeat(hdr3.length));

    for (let i = 0; i < all3WayArbs.length; i++) {
      const a = all3WayArbs[i];
      for (const d of a.dirs) {
        const flag = d.edge > 0 ? "***" : "   ";
        console.log([
          padL(i === 0 || all3WayArbs[i - 1] !== a ? String(i + 1) : "", 3),
          pad(a.sport, 14), pad(fmtPct(d.edge), 7), pad(d.label, 14),
          pad(fmtPct(d.kalAsk), 8), pad(d.pmOut1, 16), pad(fmtPct(d.pmAsk1), 8),
          pad(d.pmOut2, 16), pad(fmtPct(d.pmAsk2), 8),
          `${flag} ${a.matchTitle}`,
        ].join("  "));
      }
      console.log();
    }

    const pos3Way = all3WayArbs.filter(a => a.bestEdge > 0);
    if (!pos3Way.length) {
      console.log("[SOCCER] No positive-edge 3-way arbitrage found.");
      console.log("[SOCCER] Top 10 closest:");
      all3WayArbs.slice(0, 10).forEach(a => {
        const best = a.dirs.reduce((b, d) => d.edge > b.edge ? d : b, a.dirs[0]);
        console.log(`  ${fmtPct(best.edge, 2)}: KAL ${best.label}(${fmtPct(best.kalAsk)}) + PM ${best.pmOut1}(${fmtPct(best.pmAsk1)}) + PM ${best.pmOut2}(${fmtPct(best.pmAsk2)}) [${a.sport}] ${a.matchTitle}`);
      });
    } else {
      console.log(`\n[SOCCER] *** ${pos3Way.length} POSITIVE-EDGE 3-WAY OPPORTUNITIES ***`);
      for (const a of pos3Way) {
        for (const d of a.dirs.filter(d => d.edge > 0)) {
          console.log(`  ${a.sport} EDGE ${fmtPct(d.edge, 2)}: KAL ${d.label}(${fmtPct(d.kalAsk)}) + PM ${d.pmOut1}(${fmtPct(d.pmAsk1)}) + PM ${d.pmOut2}(${fmtPct(d.pmAsk2)})`);
          console.log(`    ${a.matchTitle} | ${a.pmSlug}`);
        }
      }
    }
  }

  if (!allArbs.length && !all3WayArbs.length) {
    console.log("[SCAN ALL] No pairs with complete prices found.");
  }

  console.log("\n[SCAN ALL] Done.");
}

main().catch(err => {
  console.error("[SCAN ALL] Fatal:", (err as Error).message ?? err);
  process.exit(1);
});
