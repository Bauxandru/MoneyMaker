/**
 * Standalone discovery test: fetches Kalshi UFC + tennis + esports events,
 * fetches PM sports events, attempts matching, and prints results.
 *
 * Usage: npx tsx src/testDiscovery.ts
 */

import { normCents, normDollarsOrCents } from "./utils.js";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA_BASE = "https://gamma-api.polymarket.com";

// -- Helpers ------------------------------------------------------------------

function pickString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parseJsonArray(s: string): string[] {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function namesMatch(kalName: string, pmOutcome: string): boolean {
  const k = normalizeName(kalName);
  const p = normalizeName(pmOutcome);
  if (!k || !p) return false;
  if (k === p) return true;
  if (p.includes(k) || k.includes(p)) return true;
  const kw = k.split(" "), pw = p.split(" ");
  const [shorter, longer] = kw.length <= pw.length ? [kw, pw] : [pw, kw];
  if (shorter.length === 1 && shorter[0].length >= 4 && shorter.every(w => longer.includes(w))) return true;
  if (shorter.length > 1 && shorter.every(w => longer.includes(w))) return true;
  // Abbreviation fallback
  for (const [full, abbr] of [[k, p], [p, k]] as [string, string][]) {
    const a = abbr.replace(/\d+$/, "").replace(/\s/g, "");
    if (a.length < 2) continue;
    const words = full.split(" ").filter(w => w.length > 0);
    const initials = words.map(w => w[0]).join("");
    if (initials === a) return true;
    if (full.replace(/\s/g, "").startsWith(a)) return true;
  }
  return false;
}

function extractEntityName(title: string): string {
  const m = title.match(/^Will\s+(.+?)\s+win\b/i);
  return m ? m[1].trim() : "";
}

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "discovery-test/1.0" },
  });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} -- ${url}`);
  return resp.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// -- Types --------------------------------------------------------------------

type KalMarket = Record<string, any>;
type KalEvent = { event_ticker?: string; ticker?: string; title?: string; name?: string;
  category?: string; event_category?: string; series_category?: string; markets?: KalMarket[] };

type GammaMarket = Record<string, any>;
type GammaEvent = { slug?: string; markets?: GammaMarket[]; [k: string]: any };

type Candidate = {
  series: string; matchCode: string; eventTitle: string; date: string;
  p1: string; p2: string;
  kal1Ticker: string; kal2Ticker: string;
  kal1YesAsk: number; kal2YesAsk: number;
};

type MatchResult = Candidate & {
  pmSlug: string; pmOutcome1: string; pmOutcome2: string;
  matchMethod: string; // "slug" | "prefetch-name" | "search" | "NOT FOUND"
};

// -- Constants ----------------------------------------------------------------

const SERIES_TO_PM_PREFIX: Record<string, string> = {
  KXATPMATCH: "atp", KXATPGAME: "atp",
  KXLOLMATCH: "lol", KXLOLMAP: "lol", KXLOLGAME: "lol",
  KXVALORANTMATCH: "valorant", KXVALORANTMAP: "valorant", KXVALORANTGAME: "valorant",
  KXCSGOMATCH: "counter-strike", KXCSGOMAP: "counter-strike", KXCSGOGAME: "counter-strike",
  KXDOTA2MATCH: "dota-2", KXDOTA2MAP: "dota-2", KXDOTA2GAME: "dota-2",
  KXUFCFIGHT: "ufc",
};

const OPAQUE_SLUG_SERIES = new Set(["KXUFCFIGHT"]);

const SPORTS_KEYWORDS = ["sport", "tennis", "esport", "gaming", "fight", "mma", "ufc",
  "soccer", "football", "basketball", "lol", "valorant", "dota", "csgo", "counter"];

const POLITICS_BLOCKLIST = ["trump", "biden", "democrat", "republican", "election", "congress", "senate"];

const NON_MONEYLINE_KEYWORDS = ["map-", "game-", "-map", "-game", "round-", "-round",
  "handicap", "total-", "over-under", "first-blood", "first-kill"];

function isNonMoneyline(slug: string, m: GammaMarket): boolean {
  const text = [slug, pickString(m.question ?? m.title ?? "")].join(" ").toLowerCase();
  return NON_MONEYLINE_KEYWORDS.some(kw => text.includes(kw));
}


// -- Phase 1: Fetch Kalshi candidates -----------------------------------------

async function fetchKalshiCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let cursor = "";
  let page = 0;

  while (true) {
    const q = new URLSearchParams({ status: "open", limit: "200", with_nested_markets: "true" });
    if (cursor) q.set("cursor", cursor);
    const url = `${KALSHI_BASE}/events?${q}`;
    let res: { events?: KalEvent[]; cursor?: string; next_cursor?: string };
    try {
      res = await fetchJson<typeof res>(url);
    } catch (err) {
      console.error(`Kalshi fetch error (page ${page}): ${(err as Error).message}`);
      break;
    }

    const events = res.events ?? [];
    if (!events.length) break;
    page++;

    for (const ev of events) {
      const eventTicker = pickString(ev.event_ticker ?? ev.ticker ?? "");
      const eventTitle = pickString(ev.title ?? ev.name ?? "");
      const mlist = (ev.markets ?? []).filter(m => {
        const st = pickString(m.status ?? "").toLowerCase();
        return !st || st === "active";
      });

      const category = pickString(ev.category ?? ev.event_category ?? ev.series_category ?? "").toLowerCase();
      if (category && !SPORTS_KEYWORDS.some(k => category.includes(k))) continue;
      if (mlist.length !== 2) continue;

      const names: string[] = [], asks: number[] = [], tickers: string[] = [];
      for (const m of mlist) {
        const name = extractEntityName(pickString(m.title ?? m.subtitle ?? ""));
        if (!name) break;
        const yesAsk = m.yes_ask_dollars !== undefined
          ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
        if (yesAsk === null) break;
        names.push(name);
        asks.push(yesAsk);
        tickers.push(pickString(m.ticker ?? ""));
      }
      if (names.length !== 2) continue;

      const nameLower = names.join(" ").toLowerCase();
      if (POLITICS_BLOCKLIST.some(kw => nameLower.includes(kw))) continue;

      const priceSum = asks[0] + asks[1];
      if (priceSum < 0.85 || priceSum > 1.20) continue;

      const series = (tickers[0].split("-")[0] ?? "").toUpperCase();

      // Parse date from ticker
      let date = "";
      const dm = tickers[0].match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
      if (dm) {
        const months: Record<string, string> = { JAN:"01",FEB:"02",MAR:"03",APR:"04",MAY:"05",JUN:"06",
          JUL:"07",AUG:"08",SEP:"09",OCT:"10",NOV:"11",DEC:"12" };
        date = `20${dm[1]}-${months[dm[2].toUpperCase()]}-${dm[3].padStart(2,"0")}`;
      }

      candidates.push({
        series, matchCode: eventTicker, eventTitle, date,
        p1: names[0], p2: names[1],
        kal1Ticker: tickers[0], kal2Ticker: tickers[1],
        kal1YesAsk: asks[0], kal2YesAsk: asks[1],
      });
    }

    cursor = pickString(res.next_cursor ?? res.cursor ?? "");
    if (!cursor) break;
    await sleep(120);
  }

  console.log(`[KALSHI] Fetched ${candidates.length} candidates across ${page} pages\n`);
  return candidates;
}

// -- Phase 2: Fetch PM sports markets -----------------------------------------

async function fetchPmSportsMarkets(): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  const sportTags = ["esports", "ufc"];
  for (const tag of sportTags) {
    let tagCount = 0;
    try {
      let offset = 0;
      while (true) {
        const url = `${GAMMA_BASE}/events?tag_slug=${tag}&active=true&closed=false&limit=200&offset=${offset}`;
        const raw = await fetchJson<any>(url);
        const events: GammaEvent[] = Array.isArray(raw) ? raw : (raw?.events ?? raw?.data ?? []);
        if (!events.length) break;
        for (const ev of events) {
          for (const m of (ev.markets ?? [])) {
            if (m.closed) continue;
            const outcomes = parseJsonArray(m.outcomes ?? "");
            const tokenIds = parseJsonArray(m.clobTokenIds ?? "");
            if (outcomes.length !== 2 || tokenIds.length < 2) continue;
            m._eventSlug = pickString(ev.slug ?? "");
            m._tag = tag;
            markets.push(m);
            tagCount++;
          }
        }
        if (events.length < 200) break;
        offset += 200;
        await sleep(100);
      }
    } catch (err) {
      console.error(`[PM] ${tag} prefetch failed: ${(err as Error).message}`);
    }
    console.log(`[PM] tag=${tag}: ${tagCount} 2-outcome markets`);
  }
  console.log(`[PM] Total prefetched: ${markets.length} markets\n`);
  return markets;
}

// -- Phase 3: Match -----------------------------------------------------------

async function matchAll(candidates: Candidate[], pmMarkets: GammaMarket[]): Promise<MatchResult[]> {
  const results: MatchResult[] = [];
  const seen = new Set<string>();

  for (const cand of candidates) {
    const pairKey = [normalizeName(cand.p1), normalizeName(cand.p2)].sort().join("|");
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    let pmSlug = "", pmO1 = "", pmO2 = "", method = "NOT FOUND";

    // Step C: name match against prefetched
    for (const m of pmMarkets) {
      const mSlug = pickString(m.slug ?? m._eventSlug ?? "");
      if (isNonMoneyline(mSlug, m)) continue;
      const outcomes = parseJsonArray(m.outcomes ?? "");
      if (outcomes.some((o: string) => namesMatch(cand.p1, o)) &&
          outcomes.some((o: string) => namesMatch(cand.p2, o))) {
        pmSlug = mSlug;
        pmO1 = outcomes[0]; pmO2 = outcomes[1];
        method = `prefetch-name (tag=${m._tag ?? "?"})`;
        break;
      }
    }

    // Step D: search fallback (only if no prefetch match and not opaque-slug series)
    if (!pmSlug && !OPAQUE_SLUG_SERIES.has(cand.series)) {
      // Try slug guess for tennis
      const pmPrefix = SERIES_TO_PM_PREFIX[cand.series] ?? "";
      if (pmPrefix && cand.date) {
        const t1 = cand.p1.trim().split(/\s+/).pop()?.toLowerCase().slice(0, 7) ?? "";
        const t2 = cand.p2.trim().split(/\s+/).pop()?.toLowerCase().slice(0, 7) ?? "";
        const slugs = [
          `${pmPrefix}-${t1}-${t2}-${cand.date}`,
          `${pmPrefix}-${t2}-${t1}-${cand.date}`,
        ];
        for (const s of slugs) {
          try {
            const raw = await fetchJson<any>(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(s)}`);
            const ml: any[] = Array.isArray(raw) ? raw : [];
            if (ml.length && !ml[0].closed) {
              const outcomes = parseJsonArray(ml[0].outcomes ?? "");
              pmSlug = s;
              pmO1 = outcomes[0] ?? ""; pmO2 = outcomes[1] ?? "";
              method = "slug-guess";
              break;
            }
          } catch { /* skip */ }
          await sleep(100);
        }
      }
    }

    // Step D2: search API fallback
    if (!pmSlug) {
      try {
        const raw = await fetchJson<any>(
          `${GAMMA_BASE}/events?search=${encodeURIComponent(cand.p1)}&active=true&limit=10`
        );
        const events: GammaEvent[] = Array.isArray(raw) ? raw : [];
        for (const ev of events) {
          for (const m of (ev.markets ?? [])) {
            if (m.closed) continue;
            const outcomes = parseJsonArray(m.outcomes ?? "");
            if (outcomes.length === 2 &&
                outcomes.some((o: string) => namesMatch(cand.p1, o)) &&
                outcomes.some((o: string) => namesMatch(cand.p2, o))) {
              pmSlug = pickString(m.slug ?? ev.slug ?? "");
              pmO1 = outcomes[0]; pmO2 = outcomes[1];
              method = "search-api";
              break;
            }
          }
          if (pmSlug) break;
        }
      } catch { /* skip */ }
      await sleep(100);
    }

    results.push({
      ...cand,
      pmSlug, pmOutcome1: pmO1, pmOutcome2: pmO2, matchMethod: method,
    });
  }

  return results;
}

// -- Main ---------------------------------------------------------------------

async function main() {
  console.log("=== Discovery Test ===\n");

  const [candidates, pmMarkets] = await Promise.all([
    fetchKalshiCandidates(),
    fetchPmSportsMarkets(),
  ]);

  const results = await matchAll(candidates, pmMarkets);

  // Group by series
  const bySeries = new Map<string, MatchResult[]>();
  for (const r of results) {
    const arr = bySeries.get(r.series) || [];
    arr.push(r);
    bySeries.set(r.series, arr);
  }

  // Print results
  let matchedTotal = 0, notFoundTotal = 0;

  console.log("\n" + "=".repeat(100));
  console.log("DISCOVERY RESULTS");
  console.log("=".repeat(100));

  for (const [series, entries] of [...bySeries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const matched = entries.filter(e => e.matchMethod !== "NOT FOUND");
    const notFound = entries.filter(e => e.matchMethod === "NOT FOUND");
    matchedTotal += matched.length;
    notFoundTotal += notFound.length;

    console.log(`\n-- ${series} (${matched.length} matched, ${notFound.length} not found) --`);

    for (const r of entries) {
      const status = r.matchMethod !== "NOT FOUND" ? "[OK]" : "[X]";
      const kalPrices = `KAL: ${(r.kal1YesAsk*100).toFixed(0)}c/${(r.kal2YesAsk*100).toFixed(0)}c`;
      const edge = Math.max(
        1 - r.kal1YesAsk - r.kal2YesAsk,  // combined overround gap
        0
      );

      console.log(`  ${status} ${r.p1} vs ${r.p2}  [${r.date || "no-date"}]  ${kalPrices}  sum=${((r.kal1YesAsk+r.kal2YesAsk)*100).toFixed(0)}c`);
      if (r.matchMethod !== "NOT FOUND") {
        console.log(`    PM: ${r.pmSlug}  outcomes=[${r.pmOutcome1}, ${r.pmOutcome2}]  via=${r.matchMethod}`);
      } else {
        console.log(`    PM: NOT FOUND`);
      }
    }
  }

  console.log(`\n${"=".repeat(100)}`);
  console.log(`TOTAL: ${results.length} pairs | ${matchedTotal} matched | ${notFoundTotal} not found`);
  console.log("=".repeat(100));

  // Write JSON for easy review
  const outPath = "data/discovery_test_results.json";
  const fs = await import("fs");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
