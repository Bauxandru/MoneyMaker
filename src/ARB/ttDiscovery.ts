/**
 * ttDiscovery.ts -- Discovery module for cross-platform arbitrage pair detection.
 *
 * Scans Kalshi events for head-to-head sports/esports markets and matches them
 * to corresponding Polymarket markets. Handles moneyline, spread, total,
 * game-total, set-winner, and map-level market types across tennis, NBA, NHL,
 * MLB, college basketball, soccer, and esports (CS2, LoL, Dota 2, Valorant, CoD).
 *
 * Extracted from tradeTennis.ts -- discovery section (lines 1358-2892).
 */

import fs from "fs";
import path from "path";

import { parseJsonArray, pickString, normCents, normDollarsOrCents, bestAskFromSide } from "../utils.js";
import { fetchJsonWithRetry } from "../http.js";
import {
  polyFetch, kalFetch, polyClobFetch, atomicWriteFileSync, fmtPct,
  DISCOVERY_CACHE_TTL_MS, FORCE_DISCOVER, parseGammaEvents, parseGammaMarkets, retryOpts,
} from "./ttConfig.js";
import {
  extractEntityName, namesMatch, parseDateFromTicker, parseDateFromEventTitle,
  parseDateFromPmSlug, datesMatch, datesMatchTennis,
  matchCodePrefix, normalizeName, pmSlugToken,
  nbaNameToAbbr, nhlNameToAbbr, mlbNameToAbbr, soccerNameToAbbr,
  cbbNamesMatch, cbbExpandName, fuzzyIntlNamesMatch,
  SERIES_TO_PM_PREFIX, TENNIS_SERIES, NBA_SERIES, NHL_SERIES, MLB_SERIES,
  SOCCER_SERIES, CBB_SERIES, NON_MONEYLINE_BINARY_SERIES, SET_WINNER_SERIES,
} from "./ttNameMatch.js";
import { fetchPmAsk } from "./ttPmOrders.js";
import { updatePairHistoryFromWatchlist } from "./ttPairHistory.js";

/**
 * Extract the per-market PM taker fee rate from a gamma market response.
 * Gamma returns `feeSchedule.rate` as the coefficient for the bell-curve
 * formula: fee = shares × rate × p × (1 - p). If a market has fees disabled
 * or the field is missing, returns 0 / undefined (default will be applied).
 * Source: docs.polymarket.com/trading/fees (verified 2026-04-15)
 */
function extractPmFeeRate(pmMarket: Record<string, unknown>): number | undefined {
  if (pmMarket.feesEnabled === false) return 0;
  const schedule = pmMarket.feeSchedule as { rate?: unknown } | undefined;
  if (schedule && typeof schedule.rate === "number" && Number.isFinite(schedule.rate)) {
    return schedule.rate;
  }
  // Some endpoints return feeSchedule as a JSON string rather than parsed object.
  if (typeof schedule === "string") {
    try {
      const parsed = JSON.parse(schedule as unknown as string) as { rate?: unknown };
      if (typeof parsed.rate === "number" && Number.isFinite(parsed.rate)) return parsed.rate;
    } catch { /* fallthrough */ }
  }
  return undefined;
}
import type { GammaMarket, KalshiEvent, KalshiMarket, WatchEntry, KalshiLeg, PmLeg } from "./ttTypes.js";

// --- Discovery helpers --------------------------------------------------------

export async function searchPolymarketByNames(
  name1: string, name2: string, gammaBase: string
): Promise<GammaMarket | null> {
  // Helper: accept a market if its two outcomes match both names
  function marketMatchesNames(m: GammaMarket): boolean {
    if (m.closed) return false;
    const outcomes = parseJsonArray(m.outcomes ?? "");
    const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
    if (outcomes.length !== 2 || tokenIds.length < 2) return false;
    return outcomes.some((o: string) => namesMatch(name1, o)) &&
           outcomes.some((o: string) => namesMatch(name2, o));
  }

  // Strategy 1: search events with both names combined
  try {
    const q = encodeURIComponent(`${name1} ${name2}`);
    const raw = await polyFetch<unknown>(`${gammaBase}/events?search=${q}&active=true&limit=10`);
    for (const ev of parseGammaEvents(raw)) {
      for (const m of (ev.markets ?? [])) {
        if (marketMatchesNames(m)) return m;
      }
    }
  } catch { /* fall through */ }

  // Strategy 2: search markets by name1 alone
  try {
    const raw = await polyFetch<unknown>(`${gammaBase}/markets?search=${encodeURIComponent(name1)}&active=true&limit=20`);
    for (const m of parseGammaMarkets(raw)) {
      if (marketMatchesNames(m)) return m;
    }
  } catch { /* ignore */ }

  // Strategy 3: search markets by name2 alone (handles cases where name1 search misses it)
  try {
    const raw = await polyFetch<unknown>(`${gammaBase}/markets?search=${encodeURIComponent(name2)}&active=true&limit=20`);
    for (const m of parseGammaMarkets(raw)) {
      if (marketMatchesNames(m)) return m;
    }
  } catch { /* ignore */ }

  // Strategy 4: search events by name2 alone (catches esports events indexed differently)
  try {
    const raw = await polyFetch<unknown>(`${gammaBase}/events?search=${encodeURIComponent(name2)}&active=true&limit=10`);
    for (const ev of parseGammaEvents(raw)) {
      for (const m of (ev.markets ?? [])) {
        if (marketMatchesNames(m)) return m;
      }
    }
  } catch { /* ignore */ }

  return null;
}

// --- Discovery caching --------------------------------------------------------

const DISCOVERY_CACHE_PATH = "discovery_cache.json";

type DiscoveryCache = {
  date: string;              // "YYYY-MM-DD" -- legacy date check (used when DISCOVERY_CACHE_TTL_MS=0)
  savedAt?: number;          // epoch ms -- used for TTL-based invalidation
  watchlist: WatchEntry[];
  noMatchPairs: string[];    // sorted normalized name pairs that had no PM match
};

export function saveDiscoveryCache(watchlist: WatchEntry[], noMatchPairs: string[]): void {
  try {
    const data: DiscoveryCache = {
      date: new Date().toISOString().slice(0, 10),
      savedAt: Date.now(),
      watchlist,
      noMatchPairs,
    };
    atomicWriteFileSync(DISCOVERY_CACHE_PATH, JSON.stringify(data, null, 2));
    console.log(`[DISCOVER] Saved cache: ${watchlist.length} pairs, ${noMatchPairs.length} no-match pairs`);
  } catch (err) {
    console.error(`[DISCOVER] Failed to save cache: ${(err as Error).message}`);
  }
  // Mirror current pairings into the long-lived pair history (7-day retention).
  // Dashboard-only read path — the bot's hot loop still uses discovery_cache.json
  // exclusively, so expired tickers can't accidentally be traded.
  try {
    updatePairHistoryFromWatchlist(watchlist);
  } catch (err) {
    console.warn(`[DISCOVER] pair history update failed (non-fatal): ${(err as Error).message}`);
  }
}

export function loadDiscoveryCache(): DiscoveryCache | null {
  try {
    if (!fs.existsSync(DISCOVERY_CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(DISCOVERY_CACHE_PATH, "utf8")) as DiscoveryCache;
    // TTL-based invalidation (preferred); falls back to date-based for legacy caches
    if (DISCOVERY_CACHE_TTL_MS > 0 && raw.savedAt) {
      const ageMs = Date.now() - raw.savedAt;
      if (ageMs > DISCOVERY_CACHE_TTL_MS) {
        console.log(`[DISCOVER] Cache expired (age ${Math.round(ageMs / 60000)}min > TTL ${Math.round(DISCOVERY_CACHE_TTL_MS / 60000)}min) -- will re-discover`);
        return null;
      }
    } else {
      const today = new Date().toISOString().slice(0, 10);
      if (raw.date !== today) {
        console.log(`[DISCOVER] Cache is stale (${raw.date} vs today ${today}) -- will re-discover`);
        return null;
      }
    }
    if (!Array.isArray(raw.watchlist) || !raw.watchlist.length) return null;
    return raw;
  } catch (err) {
    console.error(`[DISCOVER] Failed to load cache: ${(err as Error).message}`);
    return null;
  }
}

// --- Static pairs loader ------------------------------------------------------
// Reads data/static_pairs.csv with columns: kalshi, pm
// Each row has a Kalshi URL and a Polymarket URL.
// Fetches both APIs on startup to build WatchEntry objects.

const STATIC_PAIRS_PATH = path.join("data", "static_pairs.csv");

export function parseStaticPairsCsv(): { kalshiUrl: string; pmUrl: string }[] {
  if (!fs.existsSync(STATIC_PAIRS_PATH)) return [];
  const raw = fs.readFileSync(STATIC_PAIRS_PATH, "utf8").trim();
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length < 2) return []; // header only or empty
  // Skip header row
  const pairs: { kalshiUrl: string; pmUrl: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length < 2 || !cols[0] || !cols[1]) continue;
    pairs.push({ kalshiUrl: cols[0], pmUrl: cols[1] });
  }
  return pairs;
}

// Extract Kalshi event ticker from URL.
// URL formats:
//   https://kalshi.com/markets/kxncaambgame/..../kxncaambgame-26jan28uclaore
//   https://kalshi.com/markets/KXNBAPTS/.../KXNBAPTS-26FEB06NOPMIN
// The event ticker is the LAST path segment.
export function extractKalshiEventTicker(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
  } catch {
    // Maybe it's just a ticker, not a URL
    return url.trim();
  }
}

// Extract PM slug from URL.
// URL formats:
//   https://polymarket.com/sports/cbb/cbb-soumis-pvam-2025-11-24
//   https://polymarket.com/event/some-slug
// The slug is the LAST path segment.
export function extractPmSlug(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
  } catch {
    return url.trim();
  }
}

export async function loadStaticPairs(): Promise<WatchEntry[]> {
  const csvPairs = parseStaticPairsCsv();
  if (!csvPairs.length) return [];

  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const entries: WatchEntry[] = [];

  for (const pair of csvPairs) {
    const eventTicker = extractKalshiEventTicker(pair.kalshiUrl);
    const pmSlug = extractPmSlug(pair.pmUrl);
    if (!eventTicker || !pmSlug) {
      console.warn(`[STATIC] SKIP -- missing ticker or slug: kal=${pair.kalshiUrl} pm=${pair.pmUrl}`);
      continue;
    }

    console.log(`[STATIC] Loading: ${eventTicker} ↔ ${pmSlug}`);

    // -- Fetch Kalshi event with nested markets --
    let kalNames: string[] = [], kalAsks: number[] = [], kalNoAsks: number[] = [], kalTickers: string[] = [];
    let kalYesAskSizes: number[] = [], kalNoAskSizes: number[] = [];
    try {
      const evRes = await kalFetch<{ event?: KalshiEvent }>(`${kalBase}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
      const ev = evRes.event ?? evRes as unknown as KalshiEvent;
      const mlist = ev.markets ?? [];
      if (mlist.length !== 2) {
        console.warn(`[STATIC] SKIP -- Kalshi event ${eventTicker} has ${mlist.length} markets (need 2)`);
        continue;
      }
      for (const m of mlist) {
        const name = extractEntityName(pickString(m.title ?? m.subtitle ?? ""));
        const yesAsk = m.yes_ask_dollars !== undefined
          ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
        const noAsk = m.no_ask_dollars !== undefined
          ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
        kalNames.push(name || pickString(m.ticker ?? ""));
        kalAsks.push(yesAsk ?? 0);
        kalNoAsks.push(noAsk ?? 1);
        kalTickers.push(pickString(m.ticker ?? ""));
        kalYesAskSizes.push(Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0);
        kalNoAskSizes.push(Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0);
      }
      if (kalNames.length !== 2 || !kalTickers[0] || !kalTickers[1]) {
        console.warn(`[STATIC] SKIP -- could not parse Kalshi markets for ${eventTicker}`);
        continue;
      }
    } catch (err) {
      console.warn(`[STATIC] SKIP -- Kalshi fetch failed for ${eventTicker}: ${(err as Error).message}`);
      continue;
    }

    // -- Fetch PM market from slug --
    let pmMarket: GammaMarket | null = null;
    try {
      const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(pmSlug)}`);
      const ml = parseGammaMarkets(raw);
      if (ml.length > 0) pmMarket = ml[0];
    } catch (err) { console.warn(`[DISC] PM /markets fetch failed for ${pmSlug}: ${(err as Error).message}`); }
    // Also try /events?slug= if /markets didn't work
    if (!pmMarket) {
      try {
        const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(pmSlug)}`);
        const events = parseGammaEvents(raw);
        if (events.length > 0) {
          const markets = events[0].markets ?? [];
          // Find the moneyline market (2 outcomes)
          for (const m of markets) {
            const oc = parseJsonArray(m.outcomes ?? "");
            if (oc.length === 2) { pmMarket = m; break; }
          }
        }
      } catch (err) { console.warn(`[DISC] PM /events fetch failed for ${pmSlug}: ${(err as Error).message}`); }
    }

    if (!pmMarket) {
      console.warn(`[STATIC] SKIP -- PM market not found for slug: ${pmSlug}`);
      continue;
    }

    const outcomes = parseJsonArray(pmMarket.outcomes ?? "");
    const tokenIds = parseJsonArray(pmMarket.clobTokenIds ?? "");
    if (outcomes.length !== 2 || tokenIds.length < 2) {
      console.warn(`[STATIC] SKIP -- PM ${pmSlug} has ${outcomes.length} outcomes (need 2)`);
      continue;
    }

    const tickSize = Number(pmMarket.orderPriceMinTickSize ?? 0.01);
    const minSize = Number(pmMarket.orderMinSize ?? 1);
    const negRisk = Boolean(pmMarket.negRisk);
    const feeRate = extractPmFeeRate(pmMarket as Record<string, unknown>);

    // -- Map Kalshi names to PM outcomes --
    function findPmToken(kalName: string): { outcome: string; tokenId: string } | null {
      for (let i = 0; i < outcomes.length; i++) {
        if (namesMatch(kalName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
      }
      return null;
    }

    let pm1Info = findPmToken(kalNames[0]);
    let pm2Info = findPmToken(kalNames[1]);

    if (!pm1Info || !pm2Info || pm1Info.tokenId === pm2Info.tokenId) {
      console.warn(`[STATIC] SKIP -- outcome mismatch: KAL=[${kalNames[0]}, ${kalNames[1]}] PM=${JSON.stringify(outcomes)}`);
      continue;
    }

    // -- Cross-validate token mapping via CLOB prices --
    // Only swap when name matches were ambiguous -- price divergence is expected for arb opportunities.
    const staticPm1Confident = namesMatch(kalNames[0], pm1Info.outcome);
    const staticPm2Confident = namesMatch(kalNames[1], pm2Info.outcome);
    const staticBothConfident = staticPm1Confident && staticPm2Confident;
    try {
      const [ask1, ask2] = await Promise.all([
        fetchPmAsk(pm1Info.tokenId, clobBase),
        fetchPmAsk(pm2Info.tokenId, clobBase),
      ]);
      if (ask1 !== null && ask2 !== null && kalAsks[0] > 0 && kalAsks[1] > 0) {
        const diff_correct = Math.abs(kalAsks[0] - ask1) + Math.abs(kalAsks[1] - ask2);
        const diff_swapped = Math.abs(kalAsks[0] - ask2) + Math.abs(kalAsks[1] - ask1);
        if (diff_swapped < diff_correct - 0.10) {
          if (staticBothConfident) {
            console.log(`[STATIC] Price divergence for ${pmSlug} -- names confident, NOT swapping`);
          } else {
            console.warn(`[STATIC] TOKEN SWAP DETECTED for ${pmSlug} -- swapping pm1↔pm2`);
            [pm1Info, pm2Info] = [pm2Info, pm1Info];
          }
        }
      }
    } catch {}

    const date = parseDateFromTicker(kalTickers[0]) || "";
    const matchCode = kalTickers[0].includes("-") ? matchCodePrefix(kalTickers[0]) : eventTicker;
    const pmDateStatic = parseDateFromPmSlug(pmSlug);
    const staticSeries = (kalTickers[0].split("-")[0] ?? "").toUpperCase();
    const dateCheckStatic = TENNIS_SERIES.has(staticSeries) ? datesMatchTennis : datesMatch;
    if (date && pmDateStatic && !dateCheckStatic(date, pmDateStatic)) {
      console.warn(`[STATIC] DATE MISMATCH: KAL=${date} PM=${pmDateStatic} slug=${pmSlug} -- SKIPPING`);
      continue;
    }

    entries.push({
      matchCode, pmSlug, date,
      kal1: { ticker: kalTickers[0], surname: kalNames[0], yesAsk: kalAsks[0], noAsk: kalNoAsks[0], yesAskSize: kalYesAskSizes[0] ?? 0, noAskSize: kalNoAskSizes[0] ?? 0 },
      kal2: { ticker: kalTickers[1], surname: kalNames[1], yesAsk: kalAsks[1], noAsk: kalNoAsks[1], yesAskSize: kalYesAskSizes[1] ?? 0, noAskSize: kalNoAskSizes[1] ?? 0 },
      pm1: { outcome: pm1Info.outcome, tokenId: pm1Info.tokenId, tickSize, minSize, negRisk, feeRate },
      pm2: { outcome: pm2Info.outcome, tokenId: pm2Info.tokenId, tickSize, minSize, negRisk, feeRate },
    });
    console.log(`[STATIC] LOADED: ${kalNames[0]} vs ${kalNames[1]} -> ${pmSlug}`);
  }

  return entries;
}

// --- Discovery ----------------------------------------------------------------

type KalEntity = { ticker: string; name: string; yesAsk: number; noAsk: number; yesAskSize?: number; noAskSize?: number };
type KalCandidate = {
  matchCode: string; eventTicker: string; eventTitle: string; date: string;
  e1: KalEntity;
  e2: KalEntity;
  e3?: KalEntity;  // Draw/Tie market (soccer 3-way)
  is3Way?: boolean;
  isBinary?: boolean;           // single-ticker binary (spreads, totals, game totals)
  binarySlugSuffix?: string;    // PM slug suffix to append to moneyline base slug
  binarySlugSuffixAlt?: string; // alt suffix (spreads: try both home/away)
  marketType: string; // "moneyline" | "map_1" | "map_2" | "spread" | "total" | "game_total" | "match_total" | "set_winner"
};

const SPORTS_KEYWORDS = ["sport", "esport", "tennis", "soccer", "basketball", "baseball", "hockey", "football", "golf", "mma", "boxing", "rugby", "cricket", "gaming", "match"];
const POLITICS_BLOCKLIST = ["republican", "democrat", "democratic", "congress", "senate", "house seat", "governor", "president", "election", "primary", "ballot", "mayor", "representative"];
const SKIP_MARKET_KEYWORDS = [
  "handicap", "spread", "cover",
  "total games", "total maps", "total rounds", "total sets",
  "over ", "under ",
  "first blood", "first kill", "first tower", "first baron",
  "+1.5", "-1.5", "+2.5", "-2.5", "+0.5", "-0.5",
  "game-handicap",
];
const NON_MONEYLINE_KEYWORDS = [
  ...SKIP_MARKET_KEYWORDS,
  "game 1", "game 2", "game 3", "game 4", "game 5",
  "game-1", "game-2", "game-3", "game-4", "game-5",
  "map 1", "map 2", "map 3", "map 4", "map 5",
  "map-1", "map-2", "map-3", "map-4", "map-5",
  "round 1", "round 2", "round 3", "round 4", "round 5",
  "round-1", "round-2", "round-3", "round-4", "round-5",
  "set 1", "set 2", "set 3", "set 4", "set 5",
  "set-1", "set-2", "set-3", "set-4", "set-5",
  "game-winner", "map-winner",
];

export function detectMapType(allTitles: string): string | null {
  const m = allTitles.match(/\b(?:map|game)\s*(\d+)\b/i);
  return m ? `map_${m[1]}` : null;
}

export function isNonMoneyline(slug: string, market?: GammaMarket): boolean {
  const text = [slug, market ? pickString(market.question ?? market.title ?? "") : ""].join(" ").toLowerCase();
  return NON_MONEYLINE_KEYWORDS.some(kw => text.includes(kw));
}

/** Parse team names from non-moneyline event title for namePairKey matching. */
export function parseNonMoneylineTeams(title: string, seriesPrefix: string): [string, string] | null {
  // NBA/CBB/NHL/Soccer: "Orlando at Los Angeles L: Spread ..." or "Crystal Palace at Tottenham: Spreads ..."
  // Soccer spread/total series all use the same "Away at Home:" format
  if (seriesPrefix.includes("NBA") || seriesPrefix.includes("NCAAMB") || seriesPrefix.includes("NHL") ||
      seriesPrefix.endsWith("SPREAD") || seriesPrefix.endsWith("TOTAL")) {
    const m = title.match(/^(.+?)\s+at\s+(.+?):/);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  // ATP: "Jack Draper vs Daniil Medvedev: Total Games ..."
  if (seriesPrefix.includes("ATP")) {
    const m = title.match(/^(.+?)\s+vs\s+(.+?):/);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  // CS2/LoL: "League Name: Team1 vs. Team2 Total Maps ..."
  if (seriesPrefix.includes("CS2") || seriesPrefix.includes("LOL")) {
    const afterColon = title.split(": ").slice(1).join(": ");
    const m = afterColon.match(/^(.+?)\s+vs\.?\s+(.+?)\s+Total/i);
    if (m) return [m[1].trim(), m[2].trim()];
  }
  return null;
}

/** Build PM slug suffix(es) from a binary KAL market ticker.
 *  Returns the suffix to append to the moneyline base slug, plus a display label. */
export function buildBinarySlugSuffix(
  ticker: string, series: string
): { suffix: string; suffixAlt?: string; type: string; label: string; teamAbbr?: string; lineNum?: string } | null {
  const parts = ticker.split("-");
  const lastPart = parts[parts.length - 1]; // e.g., "LAL8", "233", "3"

  // Spreads: NBA, CBB, NHL, and all soccer leagues (KXEPL, KXMLS, KXUCL, etc.)
  if (series === "KXNBASPREAD" || series === "KXNCAAMBSPREAD" || series === "KXNHLSPREAD" || series.endsWith("SPREAD")) {
    // Ticker suffix: {TEAM_ABBR}{NUMBER} e.g., "LAL8" -> "LAL wins by >8.5"
    const m = lastPart.match(/^([A-Z]+)(\d+)$/i);
    if (!m) return null;
    const lineNum = m[2]; // integer part; actual line = lineNum.5
    const teamAbbr = m[1].toUpperCase();
    // Caller must determine home/away from event title to pick correct suffix.
    // Return both variants + teamAbbr so caller can disambiguate.
    return {
      suffix: `spread-home-${lineNum}pt5`,
      suffixAlt: `spread-away-${lineNum}pt5`,
      type: "spread",
      label: `${teamAbbr} -${lineNum}.5`,
      teamAbbr,
      lineNum,
    };
  }

  // Totals: NBA, NHL, and all soccer leagues
  if (series === "KXNBATOTAL" || series === "KXNHLTOTAL" || series.endsWith("TOTAL")) {
    // Ticker suffix: {NUMBER} e.g., "233" -> PM "total-233pt5"
    if (!/^\d+$/.test(lastPart)) return null;
    return {
      suffix: `total-${lastPart}pt5`,
      type: "total",
      label: `O/U ${lastPart}.5`,
    };
  }

  if (series === "KXATPGAMETOTAL") {
    // Ticker suffix: {NUMBER} e.g., "27" -> PM "match-total-27pt5"
    // ATP games are integers: KAL "over 27" = PM ">27.5"
    if (!/^\d+$/.test(lastPart)) return null;
    return {
      suffix: `match-total-${lastPart}pt5`,
      type: "match_total",
      label: `Match O/U ${lastPart}.5`,
    };
  }

  if (series === "KXCS2TOTALMAPS" || series === "KXLOLTOTALMAPS") {
    // Ticker suffix: {N} e.g., "3" -> "over 2.5 maps" -> PM "total-games-2pt5"
    // Suffix N = minimum count for YES, line = N - 0.5, PM integer part = N - 1
    const count = parseInt(lastPart, 10);
    if (isNaN(count) || count < 2) return null;
    const pmLine = count - 1; // suffix 3 -> 2.5 -> "2pt5"
    return {
      suffix: `total-games-${pmLine}pt5`,
      type: "game_total",
      label: `Maps O/U ${pmLine}.5`,
    };
  }

  return null;
}

/** Phase 1: Scan all open Kalshi events and build candidate list of head-to-head pairs. */
export async function fetchKalshiCandidates(kalBase: string): Promise<KalCandidate[]> {
  const candidates: KalCandidate[] = [];
  let cursor = "";

  while (true) {
    const q = new URLSearchParams({ status: "open", limit: "200", with_nested_markets: "true" });
    if (cursor) q.set("cursor", cursor);
    let res: { events?: KalshiEvent[]; cursor?: string; next_cursor?: string };
    try { res = await kalFetch<typeof res>(`${kalBase}/events?${q}`); }
    catch (err) { console.error(`[DISCOVER] Kalshi events error: ${(err as Error).message}`); break; }

    const events = res.events ?? [];
    if (!events.length) break;

    for (const ev of events) {
      const eventTicker = pickString(ev.event_ticker ?? ev.ticker ?? "");
      const eventTitle  = pickString(ev.title ?? ev.name ?? "");
      const mlist = (ev.markets ?? [])
        .filter(m => { const st = pickString(m.status ?? "").toLowerCase(); return !st || st === "active"; });

      const category = pickString(ev.category ?? ev.event_category ?? ev.series_category ?? "").toLowerCase();
      if (category && !SPORTS_KEYWORDS.some(k => category.includes(k))) continue;

      // -- Extract series prefix for non-moneyline branching ---------------
      const evSeriesPrefix = eventTicker.split("-")[0]?.toUpperCase() ?? "";

      // -- Non-moneyline binary series (spreads, totals, game totals) ------
      // These events have MANY markets per event (one per line value).
      // Extract each market as an independent binary candidate.
      if (NON_MONEYLINE_BINARY_SERIES.has(evSeriesPrefix)) {
        const teamNames = parseNonMoneylineTeams(eventTitle, evSeriesPrefix);
        if (!teamNames) {
          console.log(`[DISCOVER] SKIP (cant parse teams for ${evSeriesPrefix}): "${eventTitle}"`);
          continue;
        }

        const sampleTicker = mlist[0] ? pickString(mlist[0].ticker ?? "") : "";
        const date = parseDateFromTicker(sampleTicker) || parseDateFromEventTitle(eventTitle);

        for (const m of mlist) {
          const ticker = pickString(m.ticker ?? "");
          const yesAsk = m.yes_ask_dollars !== undefined
            ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
          if (yesAsk === null) continue;
          const noAsk = m.no_ask_dollars !== undefined
            ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
          const yesAskSz = Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0;
          const noAskSz = Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0;

          const slugInfo = buildBinarySlugSuffix(ticker, evSeriesPrefix);
          if (!slugInfo) continue;

          // For spreads: determine if this ticker's team is home or away so we
          // match the CORRECT PM market (same team, same line).  Kalshi has
          // separate tickers per team (DET1 = "Det >1.5", LAL1 = "LAL >1.5") --
          // matching DET1 to PM "Lakers -1.5" would NOT be an arb because a
          // close game makes both positions lose.
          let finalSuffix = slugInfo.suffix;
          let finalSuffixAlt = slugInfo.suffixAlt;
          if (slugInfo.type === "spread" && slugInfo.teamAbbr) {
            // teamNames = [awayName, homeName] from parseNonMoneylineTeams
            // Kalshi market title: "Away at Home: Spread TEAM wins by over N.5 Points?"
            const mTitle = pickString(m.title ?? m.subtitle ?? "").toLowerCase();
            const awayLower = teamNames[0].toLowerCase();
            const homeLower = teamNames[1].toLowerCase();
            // Check which team name appears after "spread" in the title
            const spreadIdx = mTitle.indexOf("spread");
            const afterSpread = spreadIdx >= 0 ? mTitle.slice(spreadIdx) : mTitle;
            if (afterSpread.includes(homeLower)) {
              // This ticker is about the HOME team -> use spread-home only
              finalSuffix = `spread-home-${slugInfo.lineNum}pt5`;
              finalSuffixAlt = undefined;
            } else if (afterSpread.includes(awayLower)) {
              // This ticker is about the AWAY team -> use spread-away only
              finalSuffix = `spread-away-${slugInfo.lineNum}pt5`;
              finalSuffixAlt = undefined;
            }
            // If neither matches (shouldn't happen), keep both as fallback
          }

          const entity: KalEntity = {
            ticker, name: slugInfo.label, yesAsk, noAsk: noAsk ?? 1,
            yesAskSize: yesAskSz, noAskSize: noAskSz,
          };
          // Use team names as e1.name / e2.name so namePairKey matches moneyline
          // Store the display label in the ticker surname for dashboard display
          candidates.push({
            matchCode: eventTicker, eventTicker, eventTitle, date,
            marketType: slugInfo.type, isBinary: true,
            binarySlugSuffix: finalSuffix,
            binarySlugSuffixAlt: finalSuffixAlt,
            e1: { ...entity, name: teamNames[0] },
            e2: { ...entity, name: teamNames[1] },
          });
        }
        continue;
      }

      // -- Set winner series (KXATPSETWINNER): 2-market events, Set 1 only -
      const isSetWinner = SET_WINNER_SERIES.has(evSeriesPrefix);
      if (isSetWinner) {
        // PM only has "first-set-winner" -- skip Set 2, 3, etc.
        const titleLower = eventTitle.toLowerCase();
        if (!titleLower.includes("set 1") && !eventTicker.endsWith("-1")) continue;
        // Fall through to normal 2-market processing (but skip SKIP_MARKET_KEYWORDS)
      }

      if (mlist.length !== 2 && mlist.length !== 3) continue;

      const names: string[] = [], asks: number[] = [], noAsks: number[] = [], tickers: string[] = [];
      const yesAskSizes: number[] = [], noAskSizes: number[] = [];
      for (const m of mlist) {
        // Prefer yes_sub_title (clean name: "Sacramento", "Tie", "Vacherot")
        // Fall back to title parsing for older/different formats
        const yesSubTitle = pickString(m.yes_sub_title ?? "");
        const name = yesSubTitle || extractEntityName(pickString(m.title ?? m.subtitle ?? ""));
        if (!name) continue;
        const yesAsk = m.yes_ask_dollars !== undefined
          ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
        if (yesAsk === null) continue;
        const noAsk = m.no_ask_dollars !== undefined
          ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
        const yesAskSz = Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0;
        const noAskSz = Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0;
        names.push(name); asks.push(yesAsk); noAsks.push(noAsk ?? 1); tickers.push(pickString(m.ticker ?? ""));
        yesAskSizes.push(yesAskSz); noAskSizes.push(noAskSz);
      }

      // 3-way soccer events: exactly 3 markets (Home, Away, Tie)
      const is3Way = mlist.length === 3 && names.length === 3;
      if (!is3Way && names.length !== 2) continue;
      if (is3Way && names.length !== 3) continue;

      const nameLower = names.join(" ").toLowerCase();
      if (POLITICS_BLOCKLIST.some(kw => nameLower.includes(kw))) continue;

      const allTitles = [eventTitle, ...mlist.map(m => pickString(m.title ?? m.subtitle ?? ""))].join(" ").toLowerCase();
      // Skip non-moneyline keywords -- but NOT for set-winner events (their titles contain "set 1")
      if (!isSetWinner && SKIP_MARKET_KEYWORDS.some(kw => allTitles.includes(kw))) continue;

      const detectedMap = detectMapType(allTitles);
      const marketType = isSetWinner ? "set_winner" : (detectedMap ?? "moneyline");

      if (is3Way) {
        // Soccer 3-way: identify Home, Away, Tie markets
        // Tie market has "tie" or "draw" in the entity name or ticker ends with -TIE
        let homeIdx = -1, awayIdx = -1, tieIdx = -1;
        for (let i = 0; i < 3; i++) {
          const nm = names[i].toLowerCase();
          const tk = tickers[i].toLowerCase();
          if (nm === "tie" || nm === "draw" || tk.endsWith("-tie") || tk.endsWith("-draw")) {
            tieIdx = i;
          }
        }
        if (tieIdx === -1) continue; // can't identify tie market
        // Remaining two are Home and Away (order as listed)
        const teamIdxs = [0, 1, 2].filter(i => i !== tieIdx);
        homeIdx = teamIdxs[0]; awayIdx = teamIdxs[1];

        const priceSum = asks[homeIdx] + asks[awayIdx] + asks[tieIdx];
        if (priceSum < 0.85 || priceSum > 1.30) continue;

        const date = parseDateFromTicker(tickers[0]) || parseDateFromEventTitle(eventTitle);
        const code = tickers[homeIdx].includes("-") ? matchCodePrefix(tickers[homeIdx]) : eventTicker;
        candidates.push({ matchCode: code, eventTicker, eventTitle, date, marketType, is3Way: true,
          e1: { ticker: tickers[homeIdx], name: names[homeIdx], yesAsk: asks[homeIdx], noAsk: noAsks[homeIdx], yesAskSize: yesAskSizes[homeIdx], noAskSize: noAskSizes[homeIdx] },
          e2: { ticker: tickers[awayIdx], name: names[awayIdx], yesAsk: asks[awayIdx], noAsk: noAsks[awayIdx], yesAskSize: yesAskSizes[awayIdx], noAskSize: noAskSizes[awayIdx] },
          e3: { ticker: tickers[tieIdx], name: names[tieIdx], yesAsk: asks[tieIdx], noAsk: noAsks[tieIdx], yesAskSize: yesAskSizes[tieIdx], noAskSize: noAskSizes[tieIdx] } });
      } else {
        const priceSum = asks[0] + asks[1];
        if (priceSum < 0.85 || priceSum > 1.20) continue;

        const date = parseDateFromTicker(tickers[0]) || parseDateFromEventTitle(eventTitle);
        const code = tickers[0].includes("-") ? matchCodePrefix(tickers[0]) : eventTicker;
        candidates.push({ matchCode: code, eventTicker, eventTitle, date, marketType,
          e1: { ticker: tickers[0], name: names[0], yesAsk: asks[0], noAsk: noAsks[0], yesAskSize: yesAskSizes[0], noAskSize: noAskSizes[0] },
          e2: { ticker: tickers[1], name: names[1], yesAsk: asks[1], noAsk: noAsks[1], yesAskSize: yesAskSizes[1], noAskSize: noAskSizes[1] } });
      }
    }

    cursor = pickString(res.next_cursor ?? res.cursor ?? "");
    if (!cursor) break;
  }

  candidates.sort((a, b) => {
    const aML = a.marketType === "moneyline" ? 0 : 1;
    const bML = b.marketType === "moneyline" ? 0 : 1;
    if (aML !== bML) return aML - bML;
    const aKnown = SERIES_TO_PM_PREFIX[(a.e1.ticker.split("-")[0] ?? "").toUpperCase()] ? 0 : 1;
    const bKnown = SERIES_TO_PM_PREFIX[(b.e1.ticker.split("-")[0] ?? "").toUpperCase()] ? 0 : 1;
    return aKnown - bKnown;
  });

  const binaryCount = candidates.filter(c => c.isBinary).length;
  const spreadCount = candidates.filter(c => c.marketType === "spread").length;
  if (binaryCount > 0) {
    console.log(`[DISCOVER] Kalshi candidates: ${candidates.length} total, ${binaryCount} binary (${spreadCount} spreads)`);
  }

  return candidates;
}

/** Phase 2a: Pre-fetch all active PM sports events by tag (bulk fetch, scan locally). */
export async function prefetchPmSportsMarkets(gammaBase: string): Promise<GammaMarket[]> {
  // Fetch multiple sport tags -- Gamma API tag_slug works on /events endpoint
  // Soccer is excluded -- handled by separate soccer scanner command.
  const sportTags = [
    "esports", "nba", "basketball", "baseball", "mlb",
    "dota-2", "valorant", "call-of-duty",        // esports sub-tags (PM splits them)
    "nbl", "cba", "kbl",                          // international basketball (PM uses own tags)
    "march-madness", "ncaa",                       // NCAA basketball (march-madness is subset of ncaa)
    "cwbb",                                        // NCAA women's basketball games
    "tennis",                                      // ATP + WTA match-level events (moneyline, set-winner, totals)
    "nhl",                                         // NHL hockey (match-level events)
    "soccer",                                      // Soccer spreads & totals (EPL, MLS, La Liga, etc.)
    "euroleague",                                  // EuroLeague basketball
  ];

  // Fetch each tag in PARALLEL — rate limiter inside polyFetch serializes the
  // actual HTTP calls at 30/s, but without parallel dispatch there were idle
  // gaps between tags while we waited sequentially. 2026-04-18 measurement:
  // sequential prefetch took ~10.5s; parallel reduces to ~2-3s.
  async function fetchTagPages(tag: string): Promise<GammaMarket[]> {
    const out: GammaMarket[] = [];
    let offset = 0;
    try {
      while (true) {
        const raw = await polyFetch<unknown>(
          `${gammaBase}/events?tag_slug=${tag}&active=true&closed=false&limit=200&offset=${offset}`
        );
        const events = parseGammaEvents(raw);
        if (!events.length) break;
        for (const ev of events) {
          for (const m of (ev.markets ?? [])) {
            if (m.closed) continue;
            const outcomes = parseJsonArray(m.outcomes ?? "");
            const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
            if (outcomes.length !== 2 || tokenIds.length < 2) continue;
            m._eventSlug = pickString(ev.slug ?? "");
            out.push(m);
          }
        }
        if (events.length < 200) break;
        offset += 200;
      }
    } catch (err) {
      console.error(`[DISCOVER] PM ${tag} prefetch failed: ${(err as Error).message}`);
    }
    return out;
  }

  const results = await Promise.all(sportTags.map(fetchTagPages));
  // Deduplicate across tags (soccer may overlap with specific league tags)
  const seenTokenIds = new Set<string>();
  const markets: GammaMarket[] = [];
  for (const batch of results) {
    for (const m of batch) {
      const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
      const tid = tokenIds[0];
      if (seenTokenIds.has(tid)) continue;
      seenTokenIds.add(tid);
      markets.push(m);
    }
  }
  console.log(`[DISCOVER] PM sports prefetch: ${markets.length} 2-outcome markets (tags: ${sportTags.join(", ")})`);
  return markets;
}

export async function discoverWatchlist(): Promise<{ watchlist: WatchEntry[]; noMatchPairs: string[] }> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";

  // -- Phase 1 + 2a: Run in PARALLEL (independent data sources) -------------
  const t0 = performance.now();
  const [candidates, pmEsportsMarkets] = await Promise.all([
    fetchKalshiCandidates(kalBase),
    prefetchPmSportsMarkets(gammaBase),
  ]);
  console.log(`[DISCOVER] Kalshi: ${candidates.length} head-to-head pairs | PM prefetch: ${pmEsportsMarkets.length} markets (${((performance.now() - t0) / 1000).toFixed(1)}s parallel)`);

  // Build event slug index for fast soccer 3-way lookups (Step E) -- avoids re-fetching events from API
  const pmEventIndex = new Map<string, GammaMarket[]>();
  // Build market slug index so Phase 2 can resolve slugs from the in-memory
  // prefetch instead of hitting gamma API. Every hit = saved API call + rate
  // limit delay. 2026-04-18 measurement: Phase 2 made thousands of gamma
  // lookups one-at-a-time; using this map eliminates most of them.
  const pmMarketBySlug = new Map<string, GammaMarket>();
  for (const m of pmEsportsMarkets) {
    const evSlug = pickString(m._eventSlug ?? "");
    if (evSlug) {
      let arr = pmEventIndex.get(evSlug);
      if (!arr) { arr = []; pmEventIndex.set(evSlug, arr); }
      arr.push(m);
    }
    const mktSlug = pickString(m.slug ?? "");
    if (mktSlug) pmMarketBySlug.set(mktSlug, m);
  }
  console.log(`[DISCOVER] PM event index: ${pmEventIndex.size} events, ${pmMarketBySlug.size} markets cached`);

  // -- Load slug cache from previous discovery (speeds up re-discovery) -------
  // Even with FORCE_DISCOVER, we can reuse known PM slug mappings from last run
  // to skip expensive slug-guessing API calls. The slug is validated against
  // the prefetch anyway, so stale entries are harmless (just won't match).
  const slugCache = new Map<string, string>(); // namePairKey -> pmSlug
  const noMatchCache = new Set<string>(); // namePairKey known to have no PM match
  try {
    const prevCache = loadDiscoveryCache();
    if (prevCache) {
      for (const entry of prevCache.watchlist) {
        const key = [normalizeName(entry.kal1.surname), normalizeName(entry.kal2.surname)].sort().join("|");
        slugCache.set(key, entry.pmSlug);
      }
      if (!FORCE_DISCOVER) {
        for (const pair of prevCache.noMatchPairs) {
          noMatchCache.add(pair.replace(/:moneyline$/, "")); // strip marketType suffix for lookup
        }
      }
      console.log(`[DISCOVER] Slug cache: ${slugCache.size} known slugs, ${noMatchCache.size} known no-match from previous run`);
    }
  } catch { /* ignore */ }

  // -- Phase 2: For each Kalshi pair, find matching Polymarket market ---------
  const watchlist: WatchEntry[] = [];
  // seenPairs: player pairs already processed (matched or not-found) -- skip duplicates.
  // Key: sorted normalized names joined by "|" + ":" + marketType.
  const seenPairs = new Set<string>();
  const noMatchPairs: string[] = [];
  // matchedSlugs: PM slugs already in the watchlist -- prevents same PM token appearing
  // multiple times when several Kalshi market types (KXLOLMAP, KXLOLGAME) all point
  // to the same PM market, which would create fake arbs.
  const matchedSlugs = new Set<string>();
  // Cache moneyline PM base slugs by player pair, so map_N candidates can derive
  // their PM slug as {baseSlug}-gameN without re-doing the full matching.
  const moneylineBaseSlugs = new Map<string, string>(); // pairKey -> PM base slug

  function esportsSlugToken(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  // These series have PM slugs that can't be guessed from team names -- rely on
  // prefetch name-matching (Step C) instead of slug guessing (Step A).
  const OPAQUE_SLUG_SERIES = new Set([
    "KXUCLGAME", "KXUELGAME",                         // UCL/UEL use codes like cfc1, psg1
    "KXJLEAGUEGAME",                                   // J1 uses j1-100- prefix
    "KXCONCACAFCCUPGAME", "KXAFCCLGAME",               // cup competitions with opaque codes
    "KXINTLFRIENDLYGAME", "KXFIFAGAME",                // international matches
    "KXFACUPGAME", "KXEFLCUPGAME",                     // domestic cups
    "KXEWSLGAME",                                       // women's
    // International basketball -- PM slug patterns unknown, rely on name matching
    "KXNBLGAME", "KXCBAGAME", "KXKBLGAME", "KXACBGAME",
    "KXBBLGAME", "KXBSLGAME", "KXVTBGAME", "KXABAGAME",
    "KXEUROLEAGUEGAME", "KXARGLNBGAME", "KXBBSERIEAGAME",
    // College basketball -- PM slug abbreviations are custom, rely on name matching
    "KXNCAAMBGAME", "KXNCAAWBGAME",
  ]);

  for (const cand of candidates) {
    const { e1, e2, marketType } = cand;
    const seriesPrefix = (e1.ticker.split("-")[0] ?? "").toUpperCase();

    // Whitelist: only scan tennis, esports, basketball, baseball, hockey
    const ALLOWED_SERIES = new Set([
      // Tennis
      "KXATPMATCH", "KXWTAMATCH",
      "KXATPCHALLENGERMATCH",     // ATP Challenger tours
      "KXWTACHALLENGERMATCH",     // WTA Challenger / WTA 125
      // Esports
      "KXCS2GAME", "KXCS2MAP", "KXLOLGAME", "KXLOLMAP",
      "KXDOTA2GAME", "KXDOTA2MAP",  // Dota 2 (BO3/BO5 = binary, BO2 = 3-way with TIE -> auto-skipped)
      "KXVALORANTGAME", "KXVALORANTMAP",
      "KXCODGAME", "KXCODMAP",
      // Hockey -- NHL
      "KXNHLGAME",
      // Basketball -- NBA + international leagues
      "KXNBAGAME",
      "KXNBLGAME",          // NBL (Australia)
      "KXCBAGAME",          // CBA (China)
      "KXKBLGAME",          // KBL (South Korea)
      "KXACBGAME",          // ACB (Spain)
      "KXBBLGAME",          // BBL (Germany)
      "KXBSLGAME",          // BSL (Turkey)
      "KXVTBGAME",          // VTB (Russia)
      "KXABAGAME",          // ABA League
      "KXEUROLEAGUEGAME",   // EuroLeague
      "KXARGLNBGAME",       // Argentina Liga Nacional Basketball
      "KXBBSERIEAGAME",     // Italy Serie A Basketball
      // Baseball
      "KXMLBGAME",          // MLB regular season
      "KXMLBSTGAME",        // MLB Spring Training
      // College basketball
      "KXNCAAMBGAME",       // NCAA Men's Basketball
      "KXNCAAWBGAME",       // NCAA Women's Basketball
      // Non-moneyline: spreads, totals, set winners, game totals
      "KXATPSETWINNER",     // ATP Set 1 Winners (2-market events like moneyline)
      "KXNBASPREAD",        // NBA Spreads (single-ticker binary)
      "KXNBATOTAL",         // NBA Totals (single-ticker binary)
      "KXNHLSPREAD",        // NHL Spreads (single-ticker binary)
      "KXNHLTOTAL",         // NHL Totals (single-ticker binary)
      "KXNCAAMBSPREAD",     // CBB Spreads (single-ticker binary)
      "KXATPGAMETOTAL",     // ATP Match Totals (single-ticker binary)
      "KXCS2TOTALMAPS",     // CS2 Total Maps (single-ticker binary)
      "KXLOLTOTALMAPS",     // LoL Total Maps (single-ticker binary)
      // Soccer spreads & totals (no moneyline -- user only wants non-ML)
      "KXEPLSPREAD", "KXEPLTOTAL",
      "KXMLSSPREAD", "KXMLSTOTAL",
      "KXUCLSPREAD", "KXUCLTOTAL",
      "KXUELSPREAD", "KXUELTOTAL",
      "KXLALIGASPREAD", "KXLALIGATOTAL",
      "KXSERIEASPREAD", "KXSERIEATOTAL",
      "KXBUNDESLIGASPREAD", "KXBUNDESLIGATOTAL",
      "KXLIGUE1SPREAD", "KXLIGUE1TOTAL",
      "KXBRASILEIROSPREAD", "KXBRASILEIROTOTAL",
      "KXSAUDIPLSPREAD", "KXSAUDIPLTOTAL",
    ]);
    if (seriesPrefix && !ALLOWED_SERIES.has(seriesPrefix)) continue;

    // Skip if we already processed this player pair + type (either found or not found).
    // Kalshi sometimes lists the same match in multiple event structures.
    const namePairKey = [normalizeName(e1.name), normalizeName(e2.name)].sort().join("|");
    const pairKey = `${namePairKey}:${marketType}`;
    if (seenPairs.has(pairKey)) continue;
    const pmPrefix = SERIES_TO_PM_PREFIX[seriesPrefix] ?? "";

    let pmMarket: GammaMarket | null = null, pmSlug = "";

    // Step C (FIRST -- free, no API calls): scan pre-fetched sports markets by name matching
    if (pmEsportsMarkets.length > 0) {
      for (const m of pmEsportsMarkets) {
        const mSlug = pickString(m.slug ?? m._eventSlug ?? "");
        if (isNonMoneyline(mSlug, m)) continue;
        // Sport-prefix filter: only scan PM markets whose slug starts with the expected prefix.
        // Prevents cross-sport false matches (e.g. CS2 Kalshi pair matching a LoL PM market).
        if (pmPrefix && mSlug && !mSlug.startsWith(pmPrefix + "-")) continue;
        const outcomes = parseJsonArray(m.outcomes ?? "");
        const mTitle = pickString(m.question ?? m.title ?? "").toLowerCase();
        const isCBB = CBB_SERIES.has(seriesPrefix);
        const FUZZY_INTL_SERIES = new Set(["KXEUROLEAGUEGAME", "KXKBLGAME", "KXARGLNBGAME", "KXBBSERIEAGAME", "KXACBGAME", "KXNBLGAME"]);
        const isFuzzyIntl = FUZZY_INTL_SERIES.has(seriesPrefix);
        const nm = isCBB ? cbbNamesMatch : isFuzzyIntl ? fuzzyIntlNamesMatch : namesMatch;
        // Require each player to match a DIFFERENT outcome (prevents "Daniel" matching both)
        const e1Matches = outcomes.filter((o: string) => nm(e1.name, o));
        const e2Matches = outcomes.filter((o: string) => nm(e2.name, o));
        const matchByOutcomes = e1Matches.length > 0 && e2Matches.length > 0 &&
            !(e1Matches.length === 1 && e2Matches.length === 1 && e1Matches[0] === e2Matches[0]);
        const matchByTitle = mTitle.includes(normalizeName(e1.name)) && mTitle.includes(normalizeName(e2.name));
        // CBB alias expansion for title matching (e.g., "UConn" -> "connecticut" ⊂ title)
        const matchByTitleCBB = isCBB && !matchByTitle &&
            mTitle.includes(cbbExpandName(e1.name)) && mTitle.includes(cbbExpandName(e2.name));
        if (matchByOutcomes || matchByTitle || matchByTitleCBB) {
          // Date validation: PM slug must contain the same date as the Kalshi event.
          // Without this, the bot can pair different games of the same teams on different dates.
          const pmDate = parseDateFromPmSlug(mSlug);
          const dateCheckFn = TENNIS_SERIES.has(seriesPrefix) ? datesMatchTennis : datesMatch;
          if (cand.date && pmDate && !dateCheckFn(cand.date, pmDate)) {
            console.log(`  [DISC] Date mismatch: KAL=${cand.date} PM=${pmDate} slug=${mSlug} -- skipping`);
            continue;
          }
          pmMarket = m;
          pmSlug = mSlug;
          break;
        }
      }
    }

    // Step A0: try cached slug from previous discovery (free, no API call)
    if (!pmMarket && slugCache.has(namePairKey)) {
      const cachedSlug = slugCache.get(namePairKey)!;
      // Look up the cached slug in the prefetch data (validate it still exists)
      for (const m of pmEsportsMarkets) {
        const mSlug = pickString(m.slug ?? m._eventSlug ?? "");
        if (mSlug === cachedSlug || pickString(m._eventSlug ?? "") === cachedSlug) {
          pmMarket = m;
          pmSlug = cachedSlug;
          break;
        }
      }
      // If not in prefetch, try fetching directly (one API call vs many slug guesses)
      if (!pmMarket) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(cachedSlug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && ml[0].active && !ml[0].closed && ml[0].clobTokenIds) {
            pmMarket = ml[0]; pmSlug = cachedSlug;
          }
        } catch { /* skip */ }
      }
      if (!pmMarket) {
        // Also try as event slug
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(cachedSlug)}`);
          for (const ev of parseGammaEvents(raw)) {
            for (const m of (ev.markets ?? [])) {
              if (m.closed) continue;
              const outcomes = parseJsonArray(m.outcomes ?? "");
              const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
              if (outcomes.length !== 2 || tokenIds.length < 2) continue;
              pmMarket = m;
              pmMarket._eventSlug = pickString(ev.slug ?? cachedSlug);
              pmSlug = pickString(m.slug ?? cachedSlug);
              break;
            }
            if (pmMarket) break;
          }
        } catch { /* skip */ }
      }
    }

    // Skip early if this pair was already known to have no PM match (saves all API calls)
    if (!pmMarket && noMatchCache.has(namePairKey) && marketType === "moneyline") {
      // Still mark as processed but don't waste API calls
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    // -- Outcome verification helper -------------------------------------------
    // After slug/event lookup (Steps A/B/D), verify that at least one PM outcome
    // matches at least one Kalshi entity name.  Without this, a slug guess that
    // happens to return a valid but WRONG market is silently accepted -- causing
    // cross-match trades (e.g. CS2 pair matched to a LoL market with NaVi).
    function outcomesSanityCheck(market: GammaMarket | null): boolean {
      if (!market) return false;
      const oc = parseJsonArray(market.outcomes ?? "");
      if (oc.length < 2) return false;
      const any1 = oc.some((o: string) => namesMatch(e1.name, o));
      const any2 = oc.some((o: string) => namesMatch(e2.name, o));
      return any1 && any2;  // BOTH players must match an outcome (prevents cross-match trades)
    }

    // Step A: slug guessing (API calls -- only if prefetch + cache didn't match)
    if (!pmMarket && pmPrefix && cand.date && !OPAQUE_SLUG_SERIES.has(seriesPrefix)) {
      const isTennis = TENNIS_SERIES.has(seriesPrefix);
      let slugVariants: string[];
      if (isTennis) {
        const t1 = pmSlugToken(e1.name), t2 = pmSlugToken(e2.name);
        slugVariants = [
          `${pmPrefix}-${t1}-${t2}-${cand.date}`,
          `${pmPrefix}-${t2}-${t1}-${cand.date}`,
          `${pmPrefix}-${t1.slice(0,6)}-${t2.slice(0,6)}-${cand.date}`,
          `${pmPrefix}-${t2.slice(0,6)}-${t1.slice(0,6)}-${cand.date}`,
        ];
      } else if (NBA_SERIES.has(seriesPrefix)) {
        const a1 = nbaNameToAbbr(e1.name), a2 = nbaNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else if (NHL_SERIES.has(seriesPrefix)) {
        const a1 = nhlNameToAbbr(e1.name), a2 = nhlNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else if (MLB_SERIES.has(seriesPrefix)) {
        const a1 = mlbNameToAbbr(e1.name), a2 = mlbNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else if (SOCCER_SERIES.has(seriesPrefix)) {
        const a1 = soccerNameToAbbr(e1.name), a2 = soccerNameToAbbr(e2.name);
        if (a1 && a2) {
          slugVariants = [
            `${pmPrefix}-${a1}-${a2}-${cand.date}`,
            `${pmPrefix}-${a2}-${a1}-${cand.date}`,
          ];
        } else {
          slugVariants = [];
        }
      } else {
        // Esports: try full team names, last-word only, and short variants
        const f1 = esportsSlugToken(e1.name), f2 = esportsSlugToken(e2.name);
        const l1 = (e1.name.split(/\s+/).pop() ?? e1.name).toLowerCase();
        const l2 = (e2.name.split(/\s+/).pop() ?? e2.name).toLowerCase();
        slugVariants = [
          `${pmPrefix}-${f1}-${f2}-${cand.date}`,
          `${pmPrefix}-${f2}-${f1}-${cand.date}`,
          `${pmPrefix}-${l1}-${l2}-${cand.date}`,
          `${pmPrefix}-${l2}-${l1}-${cand.date}`,
          `${pmPrefix}-${f1}-${f2}`,
          `${pmPrefix}-${f2}-${f1}`,
        ];
      }
      for (const slug of [...new Set(slugVariants)]) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && ml[0].active && !ml[0].closed && ml[0].clobTokenIds && !isNonMoneyline(slug, ml[0])) {
            if (outcomesSanityCheck(ml[0])) {
              pmMarket = ml[0]; pmSlug = slug; break;
            }
          }
        } catch { /* skip */ }
        // Also try as event slug -- esports often have event-level slugs
        if (!pmMarket) {
          try {
            const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(slug)}`);
            for (const ev of parseGammaEvents(raw)) {
              for (const m of (ev.markets ?? [])) {
                if (m.closed) continue;
                const outcomes = parseJsonArray(m.outcomes ?? "");
                const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
                if (outcomes.length !== 2 || tokenIds.length < 2) continue;
                const mSlug = pickString(m.slug ?? slug);
                if (isNonMoneyline(mSlug, m)) continue;
                if (!outcomesSanityCheck(m)) continue;
                pmMarket = m;
                pmMarket._eventSlug = pickString(ev.slug ?? slug);
                pmSlug = mSlug;
                break;
              }
              if (pmMarket) break;
            }
          } catch { /* skip */ }
        }
        if (pmMarket) break;
      }
    }

    // Step B: generic slug guessing for unknown series (esports, UFC, darts, etc.)
    // Polymarket esports slugs typically follow "{team1}-vs-{team2}" at the EVENT level.
    // We try both /markets?slug= and /events?slug= since Polymarket has both hierarchies.
    // IMPORTANT: Skip Step B when pmPrefix is known -- Step A already tried sport-prefixed
    // slug variants.  Generic (unprefixed) slugs risk cross-sport false matches because
    // the same org can compete in multiple games (e.g. TNC in CS2 and MLBB).
    if (!pmMarket && !pmPrefix) {
      const s1 = esportsSlugToken(e1.name), s2 = esportsSlugToken(e2.name);
      const genericSlugs = [...new Set([
        `${s1}-vs-${s2}`,
        `${s2}-vs-${s1}`,
        ...(cand.date ? [
          `${s1}-vs-${s2}-${cand.date}`,
          `${s2}-vs-${s1}-${cand.date}`,
        ] : []),
      ])];
      for (const slug of genericSlugs) {
        if (pmMarket) break;
        // Try market-level slug first
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && !ml[0].closed && ml[0].clobTokenIds && !isNonMoneyline(slug, ml[0])) {
            if (outcomesSanityCheck(ml[0])) {
              pmMarket = ml[0]; pmSlug = slug; break;
            }
          }
        } catch { /* skip */ }
        // Then try event-level slug and pick the first valid 2-outcome market inside it
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(slug)}`);
          for (const ev of parseGammaEvents(raw)) {
            for (const m of (ev.markets ?? [])) {
              if (m.closed) continue;
              const outcomes = parseJsonArray(m.outcomes ?? "");
              const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
              if (outcomes.length !== 2 || tokenIds.length < 2) continue;
              const mSlug = pickString(m.slug ?? slug);
              if (isNonMoneyline(mSlug, m)) continue;
              if (!outcomesSanityCheck(m)) continue;
              pmMarket = m;
              pmMarket._eventSlug = pickString(ev.slug ?? slug);
              pmSlug = mSlug; break;
            }
            if (pmMarket) break;
          }
        } catch { /* skip */ }
      }
    }

    // Step D: search API fallback (last resort -- mostly broken)
    // Skip for known series (they should be caught by prefetch or slug guess).
    // Only use for completely unknown series as a last-ditch effort.
    if (!pmMarket && !pmPrefix && !OPAQUE_SLUG_SERIES.has(seriesPrefix)) {
      const candidate = await searchPolymarketByNames(e1.name, e2.name, gammaBase);
      if (candidate) {
        const cSlug = pickString(candidate.slug ?? candidate.marketSlug ?? "");
        const pmDateD = parseDateFromPmSlug(cSlug);
        const dateCheckD = TENNIS_SERIES.has(seriesPrefix) ? datesMatchTennis : datesMatch;
        if (!isNonMoneyline(cSlug, candidate) && (!cand.date || !pmDateD || dateCheckD(cand.date, pmDateD))) {
          pmMarket = candidate;
          pmSlug = cSlug;
        }
      }
    }

    // -- Type-aware PM resolution ----------------------------------------------
    // Steps A-D above find the MONEYLINE PM market (they filter isNonMoneyline).
    // For non-moneyline Kalshi candidates, we derive the PM slug from the cached
    // moneyline base slug or the just-found market's event slug.

    if (cand.isBinary) {
      // -- Binary (spreads, totals, game totals): derive PM slug from base slug + suffix --
      let baseSlug = moneylineBaseSlugs.get(namePairKey) ?? "";
      // NHL spread/total names ("Toronto") differ from moneyline names ("TOR Maple Leafs")
      // -- try abbreviation-based alias key
      if (!baseSlug && seriesPrefix.includes("NHL")) {
        const a1 = nhlNameToAbbr(e1.name), a2 = nhlNameToAbbr(e2.name);
        if (a1 && a2) {
          const abbrKey = [a1, a2].sort().join("|");
          baseSlug = moneylineBaseSlugs.get(abbrKey) ?? "";
        }
      }
      if (!baseSlug && pmMarket) {
        baseSlug = pickString(pmMarket._eventSlug ?? pmSlug);
      }
      if (!baseSlug) {
        // Binary needs moneyline base slug -- skip if not available
        console.log(`[DISCOVER] SKIP (no base slug for binary ${marketType}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      // Try primary slug suffix, then alt (for spreads: home/away)
      const suffixes = [cand.binarySlugSuffix!, ...(cand.binarySlugSuffixAlt ? [cand.binarySlugSuffixAlt] : [])];
      let found = false;
      for (const sfx of suffixes) {
        const slug = `${baseSlug}-${sfx}`;
        // Fast path: check the in-memory pmMarketBySlug index first. Every hit
        // saves one gamma API call + rate-limit delay (~235ms each).
        const cached = pmMarketBySlug.get(slug);
        if (cached && !cached.closed && cached.clobTokenIds) {
          pmMarket = cached; pmSlug = slug; found = true;
          break;
        }
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && !ml[0].closed && ml[0].clobTokenIds) {
            pmMarket = ml[0]; pmSlug = slug; found = true;
            console.log(`[DISCOVER] Resolved binary ${marketType} -> PM slug: ${slug}`);
            break;
          }
        } catch { /* skip */ }
      }
      if (!found) {
        console.log(`[DISCOVER] SKIP (binary PM slug not found, tried: ${suffixes.map(s => `${baseSlug}-${s}`).join(", ")}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

    } else if (marketType === "set_winner") {
      // -- Set winner: derive PM slug from base slug + first-set-winner-{P1}-vs-{P2} --
      let baseSlug = moneylineBaseSlugs.get(namePairKey) ?? "";
      if (!baseSlug && pmMarket) {
        baseSlug = pickString(pmMarket._eventSlug ?? pmSlug);
      }
      // Guard: if baseSlug already contains a set-winner suffix (e.g. PM search returned the
      // set-winner market itself rather than moneyline), strip it to avoid double-suffix.
      baseSlug = baseSlug.replace(/-first-set-winner-.+$/, "");
      if (!baseSlug) {
        console.log(`[DISCOVER] NOT FOUND (no base slug for set_winner): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      // PM uses last-name-only tokens, try both orders, both lowercase and capitalized
      const lastN1 = e1.name.split(/\s+/).pop() ?? e1.name;
      const lastN2 = e2.name.split(/\s+/).pop() ?? e2.name;
      const slugVariants = [
        // Capitalized (PM often uses "Dietrich-vs-Glinka")
        `${baseSlug}-first-set-winner-${lastN1}-vs-${lastN2}`,
        `${baseSlug}-first-set-winner-${lastN2}-vs-${lastN1}`,
        // Lowercase
        `${baseSlug}-first-set-winner-${lastN1.toLowerCase()}-vs-${lastN2.toLowerCase()}`,
        `${baseSlug}-first-set-winner-${lastN2.toLowerCase()}-vs-${lastN1.toLowerCase()}`,
      ];
      let found = false;
      for (const slug of [...new Set(slugVariants)]) {
        // Fast path: in-memory pmMarketBySlug hit bypasses gamma API.
        const cached = pmMarketBySlug.get(slug);
        if (cached && !cached.closed && cached.clobTokenIds) {
          pmMarket = cached; pmSlug = slug; found = true;
          break;
        }
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(slug)}`);
          const ml = parseGammaMarkets(raw);
          if (ml.length && !ml[0].closed && ml[0].clobTokenIds) {
            pmMarket = ml[0]; pmSlug = slug; found = true;
            console.log(`[DISCOVER] Resolved set_winner -> PM slug: ${slug}`);
            break;
          }
        } catch { /* skip */ }
      }
      if (!found) {
        console.log(`[DISCOVER] NOT FOUND (set_winner PM slug): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

    } else if (marketType !== "moneyline") {
      // -- Map N: derive PM slug from moneyline base slug --
      const mapNum = marketType.replace("map_", ""); // "1", "2", etc.
      let baseSlug = moneylineBaseSlugs.get(namePairKey) ?? "";

      if (!baseSlug && pmMarket) {
        baseSlug = pickString(pmMarket._eventSlug ?? pmSlug);
      }

      if (!baseSlug) {
        console.log(`[DISCOVER] NOT FOUND (no base slug for ${marketType}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      const mapSlug = `${baseSlug}-game${mapNum}`;
      try {
        const raw = await polyFetch<unknown>(`${gammaBase}/markets?slug=${encodeURIComponent(mapSlug)}`);
        const ml = parseGammaMarkets(raw);
        if (ml.length && !ml[0].closed && ml[0].clobTokenIds) {
          pmMarket = ml[0]; pmSlug = mapSlug;
          console.log(`[DISCOVER] Resolved ${marketType} -> PM slug: ${mapSlug}`);
        } else {
          console.log(`[DISCOVER] NOT FOUND (PM ${mapSlug} doesn't exist): ${e1.name} vs ${e2.name}`);
          seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
        }
      } catch {
        console.log(`[DISCOVER] NOT FOUND (PM ${mapSlug} fetch failed): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
    } else {
      // -- Moneyline: validate PM market is actually moneyline --
      if (!pmMarket || !pmSlug) {
        console.log(`[DISCOVER] NOT FOUND on PM: ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      const pmSportsType = pickString(pmMarket.sportsMarketType ?? "").toLowerCase();
      if (pmSportsType && pmSportsType !== "moneyline") {
        console.log(`[DISCOVER] SKIP (PM sportsMarketType=${pmSportsType}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      const pmCheckText = [pmSlug, pickString(pmMarket.question ?? pmMarket.title ?? "")].join(" ").toLowerCase();
      if (NON_MONEYLINE_KEYWORDS.some(kw => pmCheckText.includes(kw))) {
        console.log(`[DISCOVER] SKIP (non-moneyline PM: ${pmSlug}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      // Cache moneyline base slug for map_N / binary / set_winner candidates to use
      moneylineBaseSlugs.set(namePairKey, pmSlug);
      // NHL moneyline names ("TOR Maple Leafs") differ from spread/total names ("Toronto").
      // Store an abbreviation-based alias so binary candidates can find the base slug.
      if (seriesPrefix === "KXNHLGAME") {
        const a1 = nhlNameToAbbr(e1.name), a2 = nhlNameToAbbr(e2.name);
        if (a1 && a2) {
          const abbrKey = [a1, a2].sort().join("|");
          moneylineBaseSlugs.set(abbrKey, pmSlug);
        }
      }
    }

    // Bug 3 fix: if this PM slug is already in the watchlist (another Kalshi market type
    // matched to the same PM market), skip -- prevents same PM token from being traded
    // from multiple Kalshi angles (e.g. KXLOLMAP + KXLOLGAME both -> same handicap slug).
    if (matchedSlugs.has(pmSlug)) {
      console.log(`[DISCOVER] SKIP (dup PM slug ${pmSlug}): ${e1.name} vs ${e2.name}`);
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    // -- Binary (non-moneyline) WatchEntry creation -------------------------
    // For binary candidates (spreads, totals, game totals): kal1=kal2=same ticker,
    // pm1=first outcome token, pm2=second outcome token.
    // Only dirs A (KAL YES + PM2) and C (KAL NO + PM1) produce valid arbs.
    if (cand.isBinary) {
      if (!pmMarket) { seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue; }
      const outcomes = parseJsonArray(pmMarket.outcomes ?? "");
      const tokenIds = parseJsonArray(pmMarket.clobTokenIds ?? "");
      if (outcomes.length !== 2 || tokenIds.length < 2) {
        console.log(`[DISCOVER] SKIP (binary ${outcomes.length} outcomes): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      const tickSize = Number(pmMarket.orderPriceMinTickSize ?? 0.01);
      const minSize  = Number(pmMarket.orderMinSize ?? 1);
      const negRisk  = Boolean(pmMarket.negRisk);
      const feeRate  = extractPmFeeRate(pmMarket as Record<string, unknown>);

      // For binary markets: kal1 = kal2 = same Kalshi market
      // pm1 = first PM outcome (Over / team covers), pm2 = second PM outcome (Under / opp team)
      // KAL YES and PM outcome[0] must track the SAME underlying proposition.
      // SAFETY CHECK for spreads: verify PM outcome[0] matches the KAL ticker's team.
      // If mismatched (e.g. DET1 matched to "Lakers -1.5"), it's NOT an arb.
      if (marketType === "spread") {
        const pmQuestion = pickString(pmMarket.question ?? pmMarket.title ?? "").toLowerCase();
        const kalLabel = cand.e1.ticker.split("-").pop() ?? "";
        const kalTeamAbbr = kalLabel.replace(/\d+$/, "").toUpperCase();
        const pmOutcome0 = outcomes[0].toLowerCase();
        // Check: does PM outcome[0] or question reference the KAL ticker's team?
        // Use sport-specific name-to-abbr, otherwise substring match
        const pmAbbr = (nbaNameToAbbr(outcomes[0]) || nhlNameToAbbr(outcomes[0]) || soccerNameToAbbr(outcomes[0])).toUpperCase();
        const teamMatch = pmAbbr === kalTeamAbbr ||
          pmOutcome0.startsWith(kalTeamAbbr.toLowerCase()) ||
          kalTeamAbbr.length >= 3 && pmOutcome0.includes(kalTeamAbbr.toLowerCase());
        if (!teamMatch) {
          console.log(`[DISCOVER] SKIP (spread team mismatch: KAL=${kalTeamAbbr} PM_outcome0=${outcomes[0]}): ${pmSlug}`);
          seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
        }
      }
      const kalEntity = cand.e1; // same ticker as e2 (cloned)
      // e1.name/e2.name were overridden to teamNames -- use them for display surnames
      // so match shows "Detroit vs Los Angeles L" instead of duplicate team names
      const surname1 = cand.e1.name;
      const surname2 = cand.e2.name;
      const pmDateBin = parseDateFromPmSlug(pmSlug);
      const dateCheckBin = TENNIS_SERIES.has(seriesPrefix) ? datesMatchTennis : datesMatch;
      if (cand.date && pmDateBin && !dateCheckBin(cand.date, pmDateBin)) {
        console.warn(`[DISCOVER] DATE MISMATCH (binary): KAL=${cand.date} PM=${pmDateBin} slug=${pmSlug} -- REJECTING`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      seenPairs.add(pairKey);
      matchedSlugs.add(pmSlug);
      watchlist.push({
        matchCode: cand.matchCode, pmSlug, date: cand.date, isBinary: true,
        kal1: { ticker: kalEntity.ticker, surname: surname1, yesAsk: kalEntity.yesAsk, noAsk: kalEntity.noAsk, yesAskSize: kalEntity.yesAskSize ?? 0, noAskSize: kalEntity.noAskSize ?? 0 },
        kal2: { ticker: kalEntity.ticker, surname: surname2, yesAsk: kalEntity.yesAsk, noAsk: kalEntity.noAsk, yesAskSize: kalEntity.yesAskSize ?? 0, noAskSize: kalEntity.noAskSize ?? 0 },
        pm1: { outcome: outcomes[0], tokenId: tokenIds[0], tickSize, minSize, negRisk, feeRate },
        pm2: { outcome: outcomes[1], tokenId: tokenIds[1], tickSize, minSize, negRisk, feeRate },
      });
      console.log(`[DISCOVER] MATCHED BINARY [${seriesPrefix}] ${marketType}: ${surname1} vs ${surname2} -> ${pmSlug} (${outcomes[0]}/${outcomes[1]})`);
      continue;
    }

    // -- Step E: Soccer 3-way discovery --------------------------------------
    // For 3-way candidates, we need to find 3 separate PM binary markets
    // inside the PM event (home-win, draw, away-win).
    if (cand.is3Way && cand.e3) {
      // Get PM event sub-markets -- try prefetch cache first (free), then API fallback
      const eventSlug = (pmMarket as any)?._eventSlug ?? pmSlug;
      let pmEventMarkets: GammaMarket[] = pmEventIndex.get(eventSlug) ?? [];
      // Prefetch only stores 2-outcome markets; for 3-way we need all sub-markets from the event
      // If we got some from cache, great. If not enough, fetch from API.
      if (pmEventMarkets.length < 3) {
        try {
          const raw = await polyFetch<unknown>(`${gammaBase}/events?slug=${encodeURIComponent(eventSlug)}`);
          for (const ev of parseGammaEvents(raw)) {
            pmEventMarkets = (ev.markets ?? []).filter(m => !m.closed);
          }
        } catch { /* skip */ }
      }
      if (pmEventMarkets.length < 3) {
        console.log(`[DISCOVER] SKIP (3-way PM event has ${pmEventMarkets.length} markets): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      // Match each PM sub-market to: Home team, Away team, Draw
      // Use slug SUFFIX (last segment after date) to avoid false matches -- the event base
      // slug contains both team abbreviations (e.g. epl-tot-not-2026-03-22), so .includes()
      // would match both teams on every sub-market.
      let pmHome: GammaMarket | null = null, pmAway: GammaMarket | null = null, pmDraw: GammaMarket | null = null;
      const a1 = soccerNameToAbbr(e1.name), a2 = soccerNameToAbbr(e2.name);
      for (const m of pmEventMarkets) {
        const mSlug = pickString(m.slug ?? "").toLowerCase();
        const mTitle = pickString(m.question ?? m.title ?? "").toLowerCase();
        const outcomes = parseJsonArray(m.outcomes ?? "");
        if (outcomes.length !== 2) continue; // each sub-market is binary YES/NO
        // Extract slug suffix: last segment after the date (e.g. "tot" from "epl-tot-not-2026-03-22-tot")
        const slugSuffix = mSlug.split("-").pop() ?? "";
        if (mSlug.endsWith("-draw") || slugSuffix === "draw" || mTitle.includes("draw") || mTitle.includes("tie")) {
          pmDraw = m;
        } else if (namesMatch(e1.name, mTitle) || slugSuffix === a1) {
          pmHome = m;
        } else if (namesMatch(e2.name, mTitle) || slugSuffix === a2) {
          pmAway = m;
        }
      }
      if (!pmHome || !pmAway || !pmDraw) {
        console.log(`[DISCOVER] SKIP (3-way PM can't map all 3: home=${!!pmHome} away=${!!pmAway} draw=${!!pmDraw}): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      // Extract YES tokenId from each binary sub-market (index 0 = YES)
      const extractYesToken = (m: GammaMarket): { outcome: string; tokenId: string; noTokenId: string; tickSize: number; minSize: number; negRisk: boolean } | null => {
        const outcomes = parseJsonArray(m.outcomes ?? "");
        const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
        if (outcomes.length < 2 || tokenIds.length < 2) return null;
        // YES token is typically index 0, but verify by checking outcome label
        const yesIdx = outcomes.findIndex((o: string) => o.toLowerCase() === "yes");
        const idx = yesIdx >= 0 ? yesIdx : 0;
        const noIdx = idx === 0 ? 1 : 0;
        return {
          outcome: pickString(m.question ?? m.title ?? outcomes[idx]),
          tokenId: tokenIds[idx],
          noTokenId: tokenIds[noIdx],
          tickSize: Number(m.orderPriceMinTickSize ?? 0.01),
          minSize: Number(m.orderMinSize ?? 1),
          negRisk: Boolean(m.negRisk),
          feeRate: extractPmFeeRate(m as Record<string, unknown>),
        };
      };
      const pm1Token = extractYesToken(pmHome);
      const pm2Token = extractYesToken(pmAway);
      const pm3Token = extractYesToken(pmDraw);
      if (!pm1Token || !pm2Token || !pm3Token) {
        console.log(`[DISCOVER] SKIP (3-way PM token extraction failed): ${e1.name} vs ${e2.name}`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }

      const pmDate3w = parseDateFromPmSlug(pmSlug);
      if (cand.date && pmDate3w && !datesMatch(cand.date, pmDate3w)) {
        console.warn(`[DISCOVER] DATE MISMATCH (3-way): KAL=${cand.date} PM=${pmDate3w} slug=${pmSlug} -- REJECTING`);
        seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
      }
      seenPairs.add(pairKey);
      matchedSlugs.add(pmSlug);
      watchlist.push({
        matchCode: cand.matchCode, pmSlug, date: cand.date, is3Way: true,
        kal1: { ticker: e1.ticker, surname: e1.name, yesAsk: e1.yesAsk, noAsk: e1.noAsk, yesAskSize: e1.yesAskSize ?? 0, noAskSize: e1.noAskSize ?? 0 },
        kal2: { ticker: e2.ticker, surname: e2.name, yesAsk: e2.yesAsk, noAsk: e2.noAsk, yesAskSize: e2.yesAskSize ?? 0, noAskSize: e2.noAskSize ?? 0 },
        kal3: { ticker: cand.e3.ticker, surname: cand.e3.name, yesAsk: cand.e3.yesAsk, noAsk: cand.e3.noAsk, yesAskSize: cand.e3.yesAskSize ?? 0, noAskSize: cand.e3.noAskSize ?? 0 },
        pm1: { outcome: pm1Token.outcome, tokenId: pm1Token.tokenId, noTokenId: pm1Token.noTokenId, tickSize: pm1Token.tickSize, minSize: pm1Token.minSize, negRisk: pm1Token.negRisk },
        pm2: { outcome: pm2Token.outcome, tokenId: pm2Token.tokenId, noTokenId: pm2Token.noTokenId, tickSize: pm2Token.tickSize, minSize: pm2Token.minSize, negRisk: pm2Token.negRisk },
        pm3: { outcome: pm3Token.outcome, tokenId: pm3Token.tokenId, noTokenId: pm3Token.noTokenId, tickSize: pm3Token.tickSize, minSize: pm3Token.minSize, negRisk: pm3Token.negRisk },
      });
      console.log(`[DISCOVER] MATCHED 3-WAY [${seriesPrefix}]: ${e1.name} vs ${e2.name} (draw) -> ${pmSlug}`);
      continue;
    }

    // Step E: outcome mapping (2-way tennis/NBA/esports/set-winners)
    if (!pmMarket) { seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue; }
    const outcomes = parseJsonArray(pmMarket.outcomes ?? "");
    const tokenIds = parseJsonArray(pmMarket.clobTokenIds ?? "");
    if (outcomes.length !== 2 || tokenIds.length < 2) {
      console.log(`[DISCOVER] SKIP (${outcomes.length} outcomes): ${e1.name} vs ${e2.name}`);
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    const tickSize = Number(pmMarket.orderPriceMinTickSize ?? 0.01);
    const minSize  = Number(pmMarket.orderMinSize ?? 1);
    const negRisk  = Boolean(pmMarket.negRisk);
    const feeRate  = extractPmFeeRate(pmMarket as Record<string, unknown>);

    function findToken(entityName: string): { outcome: string; tokenId: string } | null {
      for (let i = 0; i < outcomes.length; i++)
        if (namesMatch(entityName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
      // NBA fallback: Kalshi uses city names ("Sacramento"), PM uses nicknames ("Kings")
      // Try matching via NBA_TEAM_ABBRS (both map to the same 3-letter code)
      if (NBA_SERIES.has(seriesPrefix)) {
        const entityAbbr = nbaNameToAbbr(entityName);
        if (entityAbbr) {
          for (let i = 0; i < outcomes.length; i++) {
            if (nbaNameToAbbr(outcomes[i]) === entityAbbr) return { outcome: outcomes[i], tokenId: tokenIds[i] };
          }
        }
      }
      // MLB fallback: Kalshi uses city names ("Los Angeles D"), PM uses full names ("Los Angeles Dodgers")
      if (MLB_SERIES.has(seriesPrefix)) {
        const entityAbbr = mlbNameToAbbr(entityName);
        if (entityAbbr) {
          for (let i = 0; i < outcomes.length; i++) {
            if (mlbNameToAbbr(outcomes[i]) === entityAbbr) return { outcome: outcomes[i], tokenId: tokenIds[i] };
          }
        }
      }
      // NHL fallback: Kalshi uses "UTA Mammoth", PM uses "Utah"
      if (NHL_SERIES.has(seriesPrefix)) {
        const entityAbbr = nhlNameToAbbr(entityName);
        if (entityAbbr) {
          for (let i = 0; i < outcomes.length; i++) {
            if (nhlNameToAbbr(outcomes[i]) === entityAbbr) return { outcome: outcomes[i], tokenId: tokenIds[i] };
          }
        }
      }
      // CBB fallback: Kalshi uses abbreviations ("UConn"), PM uses full names ("Connecticut Huskies")
      if (CBB_SERIES.has(seriesPrefix)) {
        for (let i = 0; i < outcomes.length; i++) {
          if (cbbNamesMatch(entityName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
        }
      }
      // International basketball fallback: fuzzy word matching for Euroleague, KBL, Argentine, etc.
      const FUZZY_INTL_SERIES2 = new Set(["KXEUROLEAGUEGAME", "KXKBLGAME", "KXARGLNBGAME", "KXBBSERIEAGAME", "KXACBGAME", "KXNBLGAME"]);
      if (FUZZY_INTL_SERIES2.has(seriesPrefix)) {
        for (let i = 0; i < outcomes.length; i++) {
          if (fuzzyIntlNamesMatch(entityName, outcomes[i])) return { outcome: outcomes[i], tokenId: tokenIds[i] };
        }
      }
      return null;
    }
    let pm1Info = findToken(e1.name), pm2Info = findToken(e2.name);
    if (!pm1Info || !pm2Info || pm1Info.tokenId === pm2Info.tokenId) {
      console.log(`[DISCOVER] OUTCOME MISMATCH: ${e1.name}/${e2.name} vs PM ${JSON.stringify(outcomes)}`);
      seenPairs.add(pairKey);
      noMatchPairs.push(pairKey);
      continue;
    }

    // -- Cross-validate PM tokenId mapping by fetching actual CLOB prices ------
    // IMPORTANT: Only apply price-based swap when BOTH name matches are ambiguous
    // (e.g. abbreviation-only matches). When findToken() made confident name matches,
    // trust the names -- price divergence between platforms is expected (that's the arb).
    const pm1NameConfident = namesMatch(e1.name, pm1Info.outcome);
    const pm2NameConfident = namesMatch(e2.name, pm2Info.outcome);
    const bothNamesConfident = pm1NameConfident && pm2NameConfident;

    const clobBaseDiscover = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
    try {
      const [ask1, ask2] = await Promise.all([
        fetchPmAsk(pm1Info.tokenId, clobBaseDiscover),
        fetchPmAsk(pm2Info.tokenId, clobBaseDiscover),
      ]);
      if (ask1 !== null && ask2 !== null && e1.yesAsk > 0 && e2.yesAsk > 0) {
        const diff_correct = Math.abs(e1.yesAsk - ask1) + Math.abs(e2.yesAsk - ask2);
        const diff_swapped = Math.abs(e1.yesAsk - ask2) + Math.abs(e2.yesAsk - ask1);
        if (diff_swapped < diff_correct - 0.10) {
          if (bothNamesConfident) {
            // Names matched confidently -- price divergence is the arb opportunity, not a mapping error.
            // Log but do NOT swap.
            console.log(
              `[DISCOVER] Price divergence (expected for arb): ${e1.name}/${e2.name}` +
              ` KAL=[${fmtPct(e1.yesAsk)},${fmtPct(e2.yesAsk)}]` +
              ` PM=[${fmtPct(ask1)},${fmtPct(ask2)}]` +
              ` diff_correct=${diff_correct.toFixed(2)} diff_swapped=${diff_swapped.toFixed(2)}` +
              ` -- names confident, NOT swapping`
            );
          } else {
            console.warn(
              `[DISCOVER] [!] TOKEN SWAP DETECTED: ${e1.name}/${e2.name}` +
              ` KAL=[${fmtPct(e1.yesAsk)},${fmtPct(e2.yesAsk)}]` +
              ` PM=[${fmtPct(ask1)},${fmtPct(ask2)}]` +
              ` diff_correct=${diff_correct.toFixed(2)} diff_swapped=${diff_swapped.toFixed(2)}` +
              ` -- swapping pm1↔pm2`
            );
            [pm1Info, pm2Info] = [pm2Info, pm1Info];
          }
        }
      }
    } catch (e) {
      console.warn(`[DISCOVER] Token validation fetch failed: ${(e as Error).message}`);
    }

    // Final safety-net: reject if PM slug date doesn't match Kalshi date
    // Tennis gets ±1 day tolerance (Kalshi uses tournament-day dates, PM uses ET calendar dates)
    const pmDateFinal = parseDateFromPmSlug(pmSlug);
    const dateCheckFinal = TENNIS_SERIES.has(seriesPrefix) ? datesMatchTennis : datesMatch;
    if (cand.date && pmDateFinal && !dateCheckFinal(cand.date, pmDateFinal)) {
      console.warn(`[DISCOVER] DATE MISMATCH (safety-net): KAL=${cand.date} PM=${pmDateFinal} slug=${pmSlug} -- REJECTING ${e1.name} vs ${e2.name}`);
      seenPairs.add(pairKey); noMatchPairs.push(pairKey); continue;
    }

    seenPairs.add(pairKey);
    matchedSlugs.add(pmSlug);
    watchlist.push({
      matchCode: cand.matchCode, pmSlug, date: cand.date,
      kal1: { ticker: e1.ticker, surname: e1.name, yesAsk: e1.yesAsk, noAsk: e1.noAsk, yesAskSize: e1.yesAskSize ?? 0, noAskSize: e1.noAskSize ?? 0 },
      kal2: { ticker: e2.ticker, surname: e2.name, yesAsk: e2.yesAsk, noAsk: e2.noAsk, yesAskSize: e2.yesAskSize ?? 0, noAskSize: e2.noAskSize ?? 0 },
      pm1: { outcome: pm1Info.outcome, tokenId: pm1Info.tokenId, tickSize, minSize, negRisk, feeRate },
      pm2: { outcome: pm2Info.outcome, tokenId: pm2Info.tokenId, tickSize, minSize, negRisk, feeRate },
    });
    console.log(`[DISCOVER] MATCHED [${seriesPrefix || cand.eventTicker}] ${marketType}: ${e1.name} vs ${e2.name} -> ${pmSlug} (tick=${tickSize} negRisk=${negRisk})`);
  }

  console.log(`[DISCOVER] Watchlist: ${watchlist.length} matched cross-platform pairs`);
  return { watchlist, noMatchPairs };
}

// --- Quick new-market scanner ------------------------------------------------
// Lightweight check that runs between full discoveries. Only fetches Kalshi
// event tickers and compares against current watchlist. If new tickers are
// found, runs a full discovery and returns the delta.
// Cost: 1 paginated Kalshi API call (~200ms) if no new markets.
//       Full discovery (~5-10s) only when new markets appear.

export async function quickScanNewMarkets(
  currentWatchlist: WatchEntry[]
): Promise<WatchEntry[]> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const t0 = performance.now();

  // Collect all Kalshi tickers we're already watching
  const knownTickers = new Set<string>();
  for (const e of currentWatchlist) {
    knownTickers.add(e.kal1.ticker);
    knownTickers.add(e.kal2.ticker);
  }

  // Also load the no-match pairs from cache so we don't re-discover known misses
  let knownNoMatch = new Set<string>();
  try {
    const cache = loadDiscoveryCache();
    if (cache?.noMatchPairs) {
      knownNoMatch = new Set(cache.noMatchPairs);
    }
  } catch { /* ignore */ }

  // Fetch current Kalshi candidates (just tickers + names)
  let candidates: KalCandidate[];
  try {
    candidates = await fetchKalshiCandidates(kalBase);
  } catch (err) {
    console.warn(`[QUICK-SCAN] Kalshi fetch failed: ${(err as Error).message}`);
    return [];
  }

  // Check if any candidate has tickers NOT in the current watchlist
  const newCandidates = candidates.filter(c => {
    const hasNew = !knownTickers.has(c.e1.ticker) || !knownTickers.has(c.e2.ticker);
    if (!hasNew) return false;
    // Skip if this pair was already tried and had no PM match
    const pairKey = [normalizeName(c.e1.name), normalizeName(c.e2.name)].sort().join("|") + ":" + c.marketType;
    return !knownNoMatch.has(pairKey);
  });

  const elapsed = (performance.now() - t0).toFixed(0);

  if (newCandidates.length === 0) {
    console.log(`[QUICK-SCAN] No new markets (${candidates.length} total, ${elapsed}ms)`);
    return [];
  }

  console.log(`[QUICK-SCAN] Found ${newCandidates.length} new Kalshi candidates! Running full discovery... (${elapsed}ms)`);

  // New tickers found -- run full discovery to match them against PM
  const result = await discoverWatchlist();

  // Find entries in the new discovery that aren't in the current watchlist
  const currentMatchCodes = new Set(currentWatchlist.map(w => w.matchCode));
  const newEntries = result.watchlist.filter(w => !currentMatchCodes.has(w.matchCode));

  if (newEntries.length > 0) {
    // Update cache with the full new discovery
    saveDiscoveryCache(result.watchlist, result.noMatchPairs);
    console.log(`[QUICK-SCAN] ${newEntries.length} new pairs added to watchlist!`);
  } else {
    console.log(`[QUICK-SCAN] New Kalshi tickers found but no new PM matches.`);
    // Still update cache to record the no-match pairs (avoids re-scanning them)
    saveDiscoveryCache(result.watchlist, result.noMatchPairs);
  }

  return newEntries;
}
