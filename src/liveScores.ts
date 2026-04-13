/**
 * Live Scores Aggregation Service
 *
 * Polls API-Football (primary, every ~10s) and ESPN (fallback, every ~30s) for
 * live match scores.  Exposes getMatchState / isLateGame / isMatchFinished for
 * the trading bot to detect match completion and avoid late-game entries.
 *
 * Design: FAIL-OPEN -- if all sources fail, the bot trades exactly as before.
 */

import { fetchJsonWithRetry } from "./http.js";
import { sleep, numEnv } from "./utils.js";

// --- Types --------------------------------------------------------------------

export type TrackedMatch = {
  matchCode: string;       // "Leicester vs QPR"
  sport: "soccer" | "tennis" | "nba" | "ufc" | "esports";
  date: string;            // "YYYY-MM-DD"
  team1: string;           // from kal1.surname
  team2: string;           // from kal2.surname
  is3Way?: boolean;
};

export type MatchState = {
  matchCode: string;
  status: "scheduled" | "live" | "halftime" | "finished" | "cancelled" | "postponed" | "suspended";
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  minute: number;          // elapsed minutes (0 if unknown)
  statusShort: string;     // raw API-Football status: "1H","2H","FT" etc.
  isLateGame: boolean;     // computed: minute >= 75 for soccer
  completionPct: number;   // 0-100
  detail: string;          // "2H 78'" for logging
  source: string;          // "api-football" | "espn"
  lastUpdated: number;     // Date.now()
};

// --- API-Football response types ----------------------------------------------

interface ApiFootballFixture {
  fixture: {
    id: number;
    status: { short: string; elapsed: number | null };
    date?: string;
  };
  league: { id: number; name: string; country?: string };
  teams: {
    home: { id?: number; name: string };
    away: { id?: number; name: string };
  };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
    extratime?: { home: number | null; away: number | null };
    penalty?: { home: number | null; away: number | null };
  };
}

interface ApiFootballResponse {
  results?: number;
  response: ApiFootballFixture[];
  errors?: Record<string, string> | string[];
}

// --- ESPN response types ------------------------------------------------------

interface EspnCompetitor {
  team: { displayName: string; abbreviation?: string };
  score?: string;
  homeAway?: string;
}

interface EspnCompetition {
  id?: string;
  competitors: EspnCompetitor[];
  status: {
    displayClock?: string;
    period?: number;
    type: { name: string; completed?: boolean };
  };
}

interface EspnEvent {
  id: string;
  name?: string;
  competitions: EspnCompetition[];
}

interface EspnScoreboardResponse {
  events?: EspnEvent[];
}

// --- Module state -------------------------------------------------------------

const _matchStates = new Map<string, MatchState>();          // key: matchCode
const _trackedMatches: TrackedMatch[] = [];
const _apiMatchCache = new Map<number, string>();            // API-Football fixtureId -> matchCode
const _espnMatchCache = new Map<string, string>();           // ESPN eventId -> matchCode

let _apiFootballInterval: ReturnType<typeof setInterval> | null = null;
let _espnInterval: ReturnType<typeof setInterval> | null = null;
let _apiFootballErrors = 0;
let _espnErrors = 0;
let _apiFootballPolls = 0;
let _espnPolls = 0;
let _started = false;

// --- Name normalization -------------------------------------------------------

const STRIP_SUFFIXES = /\b(fc|afc|sc|cf|cd|ssc|fk|sk|bk|if|rsc|bsc|vfb|vfl|tsv|sv|fsv|sg|1\.|club|de|real)\b/gi;
const STRIP_COMMON = /\b(city|united|wanderers|rovers|athletic|sporting|hotspur|albion|town|county|borough|rangers|palace|villa|ham|forest|wednesday)\b/gi;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")   // strip diacritics
    .replace(STRIP_SUFFIXES, "")
    .replace(/[''`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Generate matching variants: full normalized, without common words, first word only */
function nameVariants(name: string): string[] {
  const norm = normalizeName(name);
  const withoutCommon = norm.replace(STRIP_COMMON, "").replace(/\s+/g, " ").trim();
  const firstWord = norm.split(" ")[0] ?? norm;
  const variants = [norm];
  if (withoutCommon && withoutCommon !== norm) variants.push(withoutCommon);
  if (firstWord.length >= 3 && firstWord !== norm) variants.push(firstWord);
  return variants;
}

/**
 * Check if two team names plausibly refer to the same team.
 * Returns true if any variant of `a` is a substring of any variant of `b` or vice versa.
 */
function namesMatch(a: string, b: string): boolean {
  const va = nameVariants(a);
  const vb = nameVariants(b);
  for (const x of va) {
    if (x.length < 3) continue;
    for (const y of vb) {
      if (y.length < 3) continue;
      if (x.includes(y) || y.includes(x)) return true;
    }
  }
  return false;
}

// --- Match lookup -------------------------------------------------------------

/**
 * Find the TrackedMatch that corresponds to a live event's home/away names.
 * Uses cached mapping when available.
 */
function findTrackedMatch(
  homeName: string,
  awayName: string,
  cacheKey: string | number,
  cache: Map<string | number, string>
): TrackedMatch | null {
  // Check cache first
  const cachedCode = cache.get(cacheKey);
  if (cachedCode !== undefined) {
    return _trackedMatches.find(m => m.matchCode === cachedCode) ?? null;
  }

  // Fuzzy match
  for (const tm of _trackedMatches) {
    if (tm.sport !== "soccer") continue;  // API-Football/ESPN only cover soccer for now
    const t1 = tm.team1;
    const t2 = tm.team2;
    // Try both orderings: API home=team1,away=team2 or reversed
    const fwd = namesMatch(homeName, t1) && namesMatch(awayName, t2);
    const rev = namesMatch(homeName, t2) && namesMatch(awayName, t1);
    if (fwd || rev) {
      cache.set(cacheKey, tm.matchCode);
      return tm;
    }
  }
  return null;
}

// --- Status mapping -----------------------------------------------------------

const FINISHED_STATUSES = new Set(["FT", "AET", "PEN"]);
const CANCELLED_STATUSES = new Set(["PST", "CANC", "ABD", "AWD", "WO"]);
const SUSPENDED_STATUSES = new Set(["SUSP", "INT"]);
const LIVE_STATUSES = new Set(["1H", "2H", "ET", "BT", "P"]);

function mapApiFootballStatus(short: string): MatchState["status"] {
  if (FINISHED_STATUSES.has(short)) return "finished";
  if (short === "HT") return "halftime";
  if (CANCELLED_STATUSES.has(short)) return "cancelled";
  if (SUSPENDED_STATUSES.has(short)) return "suspended";
  if (LIVE_STATUSES.has(short)) return "live";
  if (short === "NS" || short === "TBD") return "scheduled";
  // For postponed specifically
  if (short === "PST") return "postponed";
  return "scheduled";
}

function computeLateGame(status: string, minute: number, statusShort: string): boolean {
  if (FINISHED_STATUSES.has(statusShort)) return true;  // already finished = definitely late
  if (statusShort === "ET" || statusShort === "BT" || statusShort === "P") return true;
  if (minute >= 75) return true;
  return false;
}

function computeCompletionPct(minute: number, statusShort: string): number {
  if (FINISHED_STATUSES.has(statusShort)) return 100;
  if (statusShort === "HT") return 47;
  if (statusShort === "NS" || statusShort === "TBD") return 0;
  if (statusShort === "ET" || statusShort === "BT") return Math.min(100, 95 + (minute - 90) / 30 * 5);
  if (statusShort === "P") return 99;
  // Normal time: 0-90 minutes -> 0-95%
  return Math.min(95, (minute / 95) * 100);
}

function formatDetail(statusShort: string, minute: number): string {
  const periodMap: Record<string, string> = {
    "1H": "1st Half", "HT": "Half Time", "2H": "2nd Half",
    "ET": "Extra Time", "BT": "ET Break", "P": "Penalties",
    "FT": "Full Time", "AET": "After ET", "PEN": "After Pens",
    "NS": "Not Started", "TBD": "TBD",
    "PST": "Postponed", "CANC": "Cancelled", "ABD": "Abandoned",
    "SUSP": "Suspended", "INT": "Interrupted",
  };
  const period = periodMap[statusShort] ?? statusShort;
  if (minute > 0 && LIVE_STATUSES.has(statusShort)) return `${period} ${minute}'`;
  return period;
}

// --- API-Football provider ----------------------------------------------------

const API_FOOTBALL_BASE = "https://v3.football.api-sports.io";

async function pollApiFootball(): Promise<void> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return;

  try {
    const data = await fetchJsonWithRetry<ApiFootballResponse>(
      `${API_FOOTBALL_BASE}/fixtures?live=all`,
      {
        headers: {
          "x-apisports-key": apiKey,
          "Accept": "application/json",
        },
      },
      { timeoutMs: 15000, maxRetries: 1, baseDelayMs: 1000 }
    );

    // Check for API errors
    if (data.errors && Object.keys(data.errors).length > 0) {
      const errMsg = typeof data.errors === "object" ? JSON.stringify(data.errors) : String(data.errors);
      console.error(`[LIVE] API-Football error: ${errMsg}`);
      _apiFootballErrors++;
      return;
    }

    const fixtures = data.response ?? [];
    let matched = 0;

    for (const f of fixtures) {
      const homeName = f.teams.home.name;
      const awayName = f.teams.away.name;
      const tm = findTrackedMatch(homeName, awayName, f.fixture.id, _apiMatchCache as Map<string | number, string>);
      if (!tm) continue;

      matched++;
      const statusShort = f.fixture.status.short ?? "NS";
      const minute = f.fixture.status.elapsed ?? 0;
      const status = mapApiFootballStatus(statusShort);

      const state: MatchState = {
        matchCode: tm.matchCode,
        status,
        homeTeam: homeName,
        awayTeam: awayName,
        homeScore: f.goals.home ?? 0,
        awayScore: f.goals.away ?? 0,
        minute,
        statusShort,
        isLateGame: computeLateGame(status, minute, statusShort),
        completionPct: computeCompletionPct(minute, statusShort),
        detail: formatDetail(statusShort, minute),
        source: "api-football",
        lastUpdated: Date.now(),
      };

      const prev = _matchStates.get(tm.matchCode);
      _matchStates.set(tm.matchCode, state);

      // Log significant transitions
      if (!prev || prev.status !== state.status) {
        if (state.status === "finished") {
          console.log(`[LIVE] ${tm.matchCode} -> FINISHED (${state.homeScore}-${state.awayScore}) via API-Football`);
        } else if (state.status === "cancelled" || state.status === "suspended") {
          console.warn(`[LIVE] ${tm.matchCode} -> ${state.status.toUpperCase()} via API-Football`);
        } else if (state.status === "live" && (!prev || prev.status === "scheduled")) {
          console.log(`[LIVE] ${tm.matchCode} -> KICKED OFF (${state.detail}) via API-Football`);
        }
      }
    }

    _apiFootballErrors = 0;  // reset on success
    _apiFootballPolls++;

    // Periodic summary (every 30 polls ≈ 5 minutes)
    if (_apiFootballPolls % 30 === 1) {
      console.log(`[LIVE] API-Football poll #${_apiFootballPolls}: ${fixtures.length} live fixtures, ${matched} matched to watchlist, ${_matchStates.size} tracked`);
    }
  } catch (err) {
    _apiFootballErrors++;
    const msg = (err as Error).message ?? String(err);
    // Log every error but keep it brief
    if (_apiFootballErrors <= 3 || _apiFootballErrors % 10 === 0) {
      console.error(`[LIVE] API-Football poll failed (${_apiFootballErrors} consecutive): ${msg.slice(0, 200)}`);
    }
  }
}

// --- ESPN provider (fallback) -------------------------------------------------

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const ESPN_LEAGUE_SLUGS: Record<string, string> = {
  // Soccer -- Top 5
  "epl": "soccer/eng.1",
  "elc": "soccer/eng.2",
  "lal": "soccer/esp.1",
  "bun": "soccer/ger.1",
  "sea": "soccer/ita.1",
  "fl1": "soccer/fra.1",
  // Soccer -- Other major
  "mls": "soccer/usa.1",
  "ucl": "soccer/uefa.champions",
  "uel": "soccer/uefa.europa",
  "ere": "soccer/ned.1",
  "por": "soccer/por.1",
  "scop": "soccer/sco.1",
  "tur": "soccer/tur.1",
  "mex": "soccer/mex.1",
  "bra": "soccer/bra.1",
  "arg": "soccer/arg.1",
  // NBA
  "nba": "basketball/nba",
};

// Deduplicate ESPN slugs (multiple PM prefixes may map to same ESPN slug)
const ESPN_SLUGS_UNIQUE = [...new Set(Object.values(ESPN_LEAGUE_SLUGS))];

let _espnBatchIndex = 0;
const ESPN_BATCH_SIZE = 5;

function mapEspnStatus(typeName: string, completed?: boolean): { status: MatchState["status"]; statusShort: string } {
  if (completed || typeName === "STATUS_FINAL") return { status: "finished", statusShort: "FT" };
  if (typeName === "STATUS_IN_PROGRESS") return { status: "live", statusShort: "2H" };
  if (typeName === "STATUS_HALFTIME") return { status: "halftime", statusShort: "HT" };
  if (typeName === "STATUS_POSTPONED") return { status: "postponed", statusShort: "PST" };
  if (typeName === "STATUS_CANCELED" || typeName === "STATUS_CANCELLED") return { status: "cancelled", statusShort: "CANC" };
  if (typeName === "STATUS_SUSPENDED" || typeName === "STATUS_DELAYED") return { status: "suspended", statusShort: "SUSP" };
  return { status: "scheduled", statusShort: "NS" };
}

async function pollEspnBatch(): Promise<void> {
  // Poll a batch of ESPN leagues
  const start = _espnBatchIndex;
  const batch = ESPN_SLUGS_UNIQUE.slice(start, start + ESPN_BATCH_SIZE);
  _espnBatchIndex = (start + ESPN_BATCH_SIZE) >= ESPN_SLUGS_UNIQUE.length ? 0 : start + ESPN_BATCH_SIZE;

  if (batch.length === 0) return;

  for (const slug of batch) {
    try {
      const data = await fetchJsonWithRetry<EspnScoreboardResponse>(
        `${ESPN_BASE}/${slug}/scoreboard`,
        {},
        { timeoutMs: 10000, maxRetries: 1, baseDelayMs: 500 }
      );

      const events = data.events ?? [];
      for (const ev of events) {
        const comp = ev.competitions?.[0];
        if (!comp) continue;

        const homeComp = comp.competitors.find(c => c.homeAway === "home") ?? comp.competitors[0];
        const awayComp = comp.competitors.find(c => c.homeAway === "away") ?? comp.competitors[1];
        if (!homeComp || !awayComp) continue;

        const homeName = homeComp.team.displayName;
        const awayName = awayComp.team.displayName;

        const tm = findTrackedMatch(homeName, awayName, ev.id, _espnMatchCache as Map<string | number, string>);
        if (!tm) continue;

        // Don't overwrite fresher API-Football data
        const existing = _matchStates.get(tm.matchCode);
        if (existing && existing.source === "api-football" && (Date.now() - existing.lastUpdated) < 30_000) {
          continue;
        }

        const { status, statusShort } = mapEspnStatus(comp.status.type.name, comp.status.type.completed);
        const minute = comp.status.period === 2 ? 45 + (parseInt(comp.status.displayClock ?? "0") || 0) :
                       comp.status.period === 1 ? parseInt(comp.status.displayClock ?? "0") || 0 : 0;

        const state: MatchState = {
          matchCode: tm.matchCode,
          status,
          homeTeam: homeName,
          awayTeam: awayName,
          homeScore: parseInt(homeComp.score ?? "0") || 0,
          awayScore: parseInt(awayComp.score ?? "0") || 0,
          minute,
          statusShort,
          isLateGame: computeLateGame(status, minute, statusShort),
          completionPct: computeCompletionPct(minute, statusShort),
          detail: formatDetail(statusShort, minute),
          source: "espn",
          lastUpdated: Date.now(),
        };

        const prev = _matchStates.get(tm.matchCode);
        _matchStates.set(tm.matchCode, state);

        // Log significant transitions (only if we're the sole source)
        if ((!prev || prev.source === "espn") && prev?.status !== state.status) {
          if (state.status === "finished") {
            console.log(`[LIVE] ${tm.matchCode} -> FINISHED (${state.homeScore}-${state.awayScore}) via ESPN`);
          }
        }
      }

      _espnErrors = 0;
    } catch (err) {
      _espnErrors++;
      if (_espnErrors <= 3 || _espnErrors % 20 === 0) {
        console.error(`[LIVE] ESPN poll failed for ${slug}: ${((err as Error).message ?? "").slice(0, 150)}`);
      }
    }

    // Small delay between league fetches to be polite
    await sleep(500);
  }

  _espnPolls++;
}

// --- Also check for recently-finished matches via /fixtures?date= -------------
// The live=all endpoint only returns currently-in-progress matches.
// Once a match finishes, it drops off the live feed. We poll ?date= less
// frequently to catch matches that just finished between our polls.

let _lastDatePoll = 0;
const DATE_POLL_INTERVAL = 60_000;  // every 60 seconds

async function pollApiFootballDate(): Promise<void> {
  const apiKey = process.env.API_FOOTBALL_KEY;
  if (!apiKey) return;
  if (Date.now() - _lastDatePoll < DATE_POLL_INTERVAL) return;
  _lastDatePoll = Date.now();

  const today = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD

  try {
    const data = await fetchJsonWithRetry<ApiFootballResponse>(
      `${API_FOOTBALL_BASE}/fixtures?date=${today}`,
      {
        headers: {
          "x-apisports-key": apiKey,
          "Accept": "application/json",
        },
      },
      { timeoutMs: 20000, maxRetries: 1, baseDelayMs: 2000 }
    );

    const fixtures = data.response ?? [];
    let newFinished = 0;

    for (const f of fixtures) {
      const statusShort = f.fixture.status.short ?? "NS";
      // Only care about finished/cancelled matches we're tracking
      if (!FINISHED_STATUSES.has(statusShort) && !CANCELLED_STATUSES.has(statusShort) && !SUSPENDED_STATUSES.has(statusShort)) continue;

      const homeName = f.teams.home.name;
      const awayName = f.teams.away.name;
      const tm = findTrackedMatch(homeName, awayName, f.fixture.id, _apiMatchCache as Map<string | number, string>);
      if (!tm) continue;

      const existing = _matchStates.get(tm.matchCode);
      if (existing?.status === "finished") continue;  // already known

      const status = mapApiFootballStatus(statusShort);
      const minute = f.fixture.status.elapsed ?? 90;

      _matchStates.set(tm.matchCode, {
        matchCode: tm.matchCode,
        status,
        homeTeam: homeName,
        awayTeam: awayName,
        homeScore: f.goals.home ?? 0,
        awayScore: f.goals.away ?? 0,
        minute,
        statusShort,
        isLateGame: true,
        completionPct: 100,
        detail: formatDetail(statusShort, minute),
        source: "api-football",
        lastUpdated: Date.now(),
      });

      if (status === "finished") {
        console.log(`[LIVE] ${tm.matchCode} -> FINISHED (${f.goals.home ?? 0}-${f.goals.away ?? 0}) via date poll`);
        newFinished++;
      } else if (status === "cancelled" || status === "suspended") {
        console.warn(`[LIVE] ${tm.matchCode} -> ${status.toUpperCase()} via date poll`);
      }
    }

    if (newFinished > 0) {
      console.log(`[LIVE] Date poll: ${newFinished} newly-finished match(es) detected`);
    }
  } catch (err) {
    // Non-critical -- live poll is primary. Don't spam logs.
    if (_apiFootballPolls % 30 === 0) {
      console.error(`[LIVE] Date poll failed: ${((err as Error).message ?? "").slice(0, 150)}`);
    }
  }
}

// --- Public API ---------------------------------------------------------------

const STALE_THRESHOLD = 120_000;  // 2 minutes -- treat data as stale

/**
 * Start polling live scores in the background.
 * Call once after watchlist is built.
 */
export function startLiveScores(matches: TrackedMatch[]): void {
  if (_started) {
    console.warn("[LIVE] Already started -- ignoring duplicate startLiveScores call");
    return;
  }

  const apiKey = process.env.API_FOOTBALL_KEY;

  // Register tracked matches
  _trackedMatches.length = 0;
  _trackedMatches.push(...matches);

  const soccerCount = matches.filter(m => m.sport === "soccer").length;
  const otherCount = matches.length - soccerCount;

  if (!apiKey) {
    console.warn("[LIVE] API_FOOTBALL_KEY not set -- live scores disabled. Set it in .env for live match detection.");
    // Still start ESPN as fallback
  }

  const apiInterval = numEnv("API_FOOTBALL_INTERVAL_MS", 10_000);  // 10 seconds default
  const espnInterval = numEnv("ESPN_INTERVAL_MS", 30_000);          // 30 seconds default

  // API-Football polling loop
  if (apiKey) {
    // Initial poll after 3 seconds (let watchlist settle)
    setTimeout(() => {
      pollApiFootball().catch(() => {});
    }, 3000);

    _apiFootballInterval = setInterval(async () => {
      // Adaptive interval: double on repeated failures
      if (_apiFootballErrors >= 10) {
        // Keepalive mode: poll every 5 minutes
        if (_apiFootballPolls % 30 !== 0) return;
      } else if (_apiFootballErrors >= 3) {
        // Degraded: poll every other interval
        if (_apiFootballPolls % 2 !== 0) { _apiFootballPolls++; return; }
      }

      await pollApiFootball();
      await pollApiFootballDate();  // piggyback date poll (has its own internal throttle)
    }, apiInterval);

    console.log(`[LIVE] API-Football polling started: every ${(apiInterval / 1000).toFixed(0)}s (budget: ~${Math.floor(86400000 / apiInterval)} req/day of 7500)`);
  }

  // ESPN fallback polling loop
  setTimeout(() => {
    pollEspnBatch().catch(() => {});
  }, 8000);  // delayed start to avoid thundering herd

  _espnInterval = setInterval(() => {
    pollEspnBatch().catch(() => {});
  }, espnInterval);

  _started = true;
  console.log(`[LIVE] Started: tracking ${soccerCount} soccer + ${otherCount} other matches. API-Football=${apiKey ? "ON" : "OFF"} ESPN=ON`);
}

/** Stop all polling loops. */
export function stopLiveScores(): void {
  if (_apiFootballInterval) { clearInterval(_apiFootballInterval); _apiFootballInterval = null; }
  if (_espnInterval) { clearInterval(_espnInterval); _espnInterval = null; }
  _started = false;
  console.log("[LIVE] Stopped.");
}

/** Get current match state. Returns null if no data available. */
export function getMatchState(matchCode: string): MatchState | null {
  const state = _matchStates.get(matchCode);
  if (!state) return null;
  // Mark stale data
  if (Date.now() - state.lastUpdated > STALE_THRESHOLD) return null;
  return state;
}

/**
 * Is the match in a late-game phase where entering new arbs is risky?
 * Returns FALSE if no data available (fail-open -- don't block trading).
 */
export function isLateGame(matchCode: string): boolean {
  const state = getMatchState(matchCode);
  if (!state) return false;  // fail-open
  return state.isLateGame;
}

/**
 * Has the match finished according to live score sources?
 * Returns FALSE if no data available (fail-open -- falls back to Kalshi detection).
 */
export function isMatchFinished(matchCode: string): boolean {
  const state = getMatchState(matchCode);
  if (!state) return false;  // fail-open
  return state.status === "finished";
}

/**
 * Is the match cancelled, abandoned, or suspended?
 * Returns FALSE if no data available.
 */
export function isMatchCancelled(matchCode: string): boolean {
  const state = getMatchState(matchCode);
  if (!state) return false;
  return state.status === "cancelled" || state.status === "suspended" || state.status === "postponed";
}

/** Summary string for logging. */
export function getLiveScoresSummary(): string {
  const total = _matchStates.size;
  const live = [..._matchStates.values()].filter(s => s.status === "live" || s.status === "halftime").length;
  const finished = [..._matchStates.values()].filter(s => s.status === "finished").length;
  const stale = [..._matchStates.values()].filter(s => Date.now() - s.lastUpdated > STALE_THRESHOLD).length;
  return `[LIVE] ${total} tracked (${live} live, ${finished} finished, ${stale} stale) | API-Football: ${_apiFootballPolls} polls, ${_apiFootballErrors} errors | ESPN: ${_espnPolls} polls`;
}

/**
 * Dynamically add matches to track (e.g., when watchlist changes).
 */
export function addTrackedMatches(matches: TrackedMatch[]): void {
  for (const m of matches) {
    if (!_trackedMatches.find(t => t.matchCode === m.matchCode)) {
      _trackedMatches.push(m);
    }
  }
}
