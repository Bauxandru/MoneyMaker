/**
 * scanMultiOutcome.ts — Scan multi-outcome markets (Fed decisions, etc.) for cross-platform arb.
 *
 * Reads data/static_pairs.csv, fetches Kalshi + Polymarket data, matches outcomes by name,
 * and displays edge per outcome.
 *
 * Arb logic per outcome:
 *   Buy Kalshi NO + Buy PM YES → guaranteed $1 payout regardless of result
 *   Edge = 1 - kalNoAsk - pmAsk
 *
 *   Buy Kalshi YES + "Sell" PM (buy complement) is harder in multi-outcome, so we focus on the above.
 *
 * Usage: npx tsx src/scanMultiOutcome.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import { fetchJsonWithRetry } from "./http.js";

dotenv.config();

type AnyRecord = Record<string, unknown>;

const KAL_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const GAMMA_BASE = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
const CLOB_BASE = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";

const retryOpts = { timeoutMs: 12000, maxRetries: 3, baseDelayMs: 600, maxDelayMs: 8000, jitterMs: 200 };

async function fetchKal<T>(url: string): Promise<T> {
  return fetchJsonWithRetry<T>(url, {}, retryOpts);
}

async function fetchPoly<T>(url: string): Promise<T> {
  return fetchJsonWithRetry<T>(url, {}, retryOpts);
}

// ─── CSV parser ──────────────────────────────────────────────────────────────

function loadCsv(): { kalshiUrl: string; pmUrl: string }[] {
  const csvPath = path.join("data", "static_pairs.csv");
  if (!fs.existsSync(csvPath)) { console.log("No static_pairs.csv found."); return []; }
  const raw = fs.readFileSync(csvPath, "utf8").trim();
  const lines = raw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const pairs: { kalshiUrl: string; pmUrl: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length < 2 || !cols[0] || !cols[1]) continue;
    pairs.push({ kalshiUrl: cols[0], pmUrl: cols[1] });
  }
  return pairs;
}

function extractLastPathSegment(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    return segs[segs.length - 1] || "";
  } catch {
    return url.trim();
  }
}

// ─── Kalshi: fetch event with nested markets ─────────────────────────────────

interface KalOutcome {
  ticker: string;
  title: string;
  yesAsk: number;
  noAsk: number;
  yesBid: number;
  volume: number;
}

function normPrice(dollars: unknown, cents: unknown): number {
  if (dollars !== undefined && dollars !== null) {
    const v = Number(dollars);
    return v > 1 ? v / 100 : v; // handle both dollars and cents
  }
  if (cents !== undefined && cents !== null) {
    const v = Number(cents);
    return v > 1 ? v / 100 : v;
  }
  return 0;
}

async function fetchKalshiEvent(eventTickerRaw: string): Promise<{ title: string; outcomes: KalOutcome[] } | null> {
  // Kalshi API requires uppercase event tickers
  const eventTicker = eventTickerRaw.toUpperCase();
  // Strategy 1: try as event ticker with nested markets
  try {
    const res = await fetchKal<AnyRecord>(`${KAL_BASE}/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`);
    const ev = (res.event as AnyRecord) ?? res;
    const title = String(ev.title ?? ev.name ?? eventTicker);
    const mlist = Array.isArray(ev.markets) ? (ev.markets as AnyRecord[]) : [];
    if (mlist.length > 0) {
      const outcomes: KalOutcome[] = [];
      for (const m of mlist) {
        const t = String(m.ticker ?? "");
        const mTitle = String(m.title ?? m.subtitle ?? t);
        const yesAsk = normPrice(m.yes_ask_dollars, m.yes_ask);
        const noAsk = normPrice(m.no_ask_dollars, m.no_ask);
        const yesBid = normPrice(m.yes_bid_dollars, m.yes_bid);
        const vol = Number(m.volume ?? 0);
        outcomes.push({ ticker: t, title: mTitle, yesAsk, noAsk, yesBid, volume: vol });
      }
      return { title, outcomes };
    }
  } catch {
    // Not an event ticker — try other strategies
  }

  // Strategy 2: try as a single market ticker, then get its event_ticker and re-fetch
  try {
    const mRes = await fetchKal<AnyRecord>(`${KAL_BASE}/markets/${encodeURIComponent(eventTicker)}`);
    const mkt = (mRes.market as AnyRecord) ?? mRes;
    const parentEvent = String(mkt.event_ticker ?? "");
    if (parentEvent) {
      console.log(`  [KAL] ${eventTicker} is a market — parent event: ${parentEvent}`);
      const evRes = await fetchKal<AnyRecord>(`${KAL_BASE}/events/${encodeURIComponent(parentEvent)}?with_nested_markets=true`);
      const ev = (evRes.event as AnyRecord) ?? evRes;
      const title = String(ev.title ?? ev.name ?? parentEvent);
      const mlist = Array.isArray(ev.markets) ? (ev.markets as AnyRecord[]) : [];
      const outcomes: KalOutcome[] = [];
      for (const m of mlist) {
        const t = String(m.ticker ?? "");
        const mTitle = String(m.title ?? m.subtitle ?? t);
        const yesAsk = normPrice(m.yes_ask_dollars, m.yes_ask);
        const noAsk = normPrice(m.no_ask_dollars, m.no_ask);
        const yesBid = normPrice(m.yes_bid_dollars, m.yes_bid);
        const vol = Number(m.volume ?? 0);
        outcomes.push({ ticker: t, title: mTitle, yesAsk, noAsk, yesBid, volume: vol });
      }
      return { title, outcomes };
    }
  } catch {}

  // Strategy 3: try as series ticker — fetch all markets in the series
  try {
    const seriesRes = await fetchKal<AnyRecord>(`${KAL_BASE}/markets?series_ticker=${encodeURIComponent(eventTicker.toUpperCase())}&status=open&limit=200`);
    const mlist = Array.isArray(seriesRes.markets) ? (seriesRes.markets as AnyRecord[]) : [];
    if (mlist.length > 0) {
      console.log(`  [KAL] ${eventTicker} matched as series with ${mlist.length} markets`);
      const outcomes: KalOutcome[] = [];
      for (const m of mlist) {
        const t = String(m.ticker ?? "");
        const mTitle = String(m.title ?? m.subtitle ?? t);
        const yesAsk = normPrice(m.yes_ask_dollars, m.yes_ask);
        const noAsk = normPrice(m.no_ask_dollars, m.no_ask);
        const yesBid = normPrice(m.yes_bid_dollars, m.yes_bid);
        const vol = Number(m.volume ?? 0);
        outcomes.push({ ticker: t, title: mTitle, yesAsk, noAsk, yesBid, volume: vol });
      }
      return { title: `Series: ${eventTicker}`, outcomes };
    }
  } catch {}

  console.error(`  [KAL] Could not resolve ${eventTicker} as event, market, or series`);
  return null;
}

// ─── Polymarket: fetch event with markets ────────────────────────────────────

interface PmOutcome {
  name: string;
  tokenId: string;
  ask: number | null;
  slug: string;
}

function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") { try { return JSON.parse(v); } catch { return []; } }
  return [];
}

async function fetchPmBestAsk(tokenId: string): Promise<number | null> {
  try {
    const book = await fetchPoly<AnyRecord>(`${CLOB_BASE}/book?token_id=${encodeURIComponent(tokenId)}`);
    const asks = book.asks;
    if (!Array.isArray(asks) || asks.length === 0) return null;
    let bestAsk = Infinity;
    for (const a of asks) {
      const p = Number((a as AnyRecord).price ?? (a as number[])?.[0] ?? 0);
      if (p > 0 && p < bestAsk) bestAsk = p;
    }
    return bestAsk < Infinity ? bestAsk : null;
  } catch {
    return null;
  }
}

async function fetchPmEvent(slug: string): Promise<{ title: string; outcomes: PmOutcome[] } | null> {
  // Try /events?slug= first (multi-outcome markets are usually events)
  try {
    const raw = await fetchPoly<unknown>(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`);
    const events = Array.isArray(raw) ? (raw as AnyRecord[]) : [];
    if (events.length > 0) {
      const ev = events[0];
      const title = String(ev.title ?? ev.name ?? slug);
      const markets = Array.isArray(ev.markets) ? (ev.markets as AnyRecord[]) : [];
      const outcomes: PmOutcome[] = [];
      for (const m of markets) {
        const oc = parseJsonArray(m.outcomes ?? "");
        const tids = parseJsonArray(m.clobTokenIds ?? "");
        const mSlug = String(m.slug ?? "");
        // Multi-outcome events: each market has 1 outcome (YES token for that outcome)
        // Some have 2 outcomes (Yes/No) — use the first token (YES)
        if (oc.length >= 1 && tids.length >= 1) {
          // Use the market question/title as the outcome name if it's a single-outcome market
          const outcomeName = oc.length === 2 && oc[0] === "Yes"
            ? String(m.question ?? m.title ?? mSlug)
            : oc[0];
          outcomes.push({ name: outcomeName, tokenId: tids[0], ask: null, slug: mSlug });
        }
      }
      // Fetch CLOB prices in parallel
      const asks = await Promise.all(outcomes.map(o => fetchPmBestAsk(o.tokenId)));
      for (let i = 0; i < outcomes.length; i++) outcomes[i].ask = asks[i];
      return { title, outcomes };
    }
  } catch {}

  // Fallback: try /markets?slug=
  try {
    const raw = await fetchPoly<unknown>(`${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`);
    const ml = Array.isArray(raw) ? (raw as AnyRecord[]) : [];
    if (ml.length > 0) {
      const m = ml[0];
      const title = String(m.question ?? m.title ?? slug);
      const oc = parseJsonArray(m.outcomes ?? "");
      const tids = parseJsonArray(m.clobTokenIds ?? "");
      const outcomes: PmOutcome[] = [];
      for (let i = 0; i < oc.length && i < tids.length; i++) {
        outcomes.push({ name: oc[i], tokenId: tids[i], ask: null, slug: String(m.slug ?? "") });
      }
      const asks = await Promise.all(outcomes.map(o => fetchPmBestAsk(o.tokenId)));
      for (let i = 0; i < outcomes.length; i++) outcomes[i].ask = asks[i];
      return { title, outcomes };
    }
  } catch {}

  return null;
}

// ─── Name matching ───────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9 >+]/g, "")  // keep > and + for quantity markers
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the distinctive part of each outcome title by finding and removing
 * the common prefix and suffix shared across all titles in the same event.
 * e.g. ["Will Powell say Expectation at his Mar 2026 press conf",
 *        "Will Powell say Recession at his Mar 2026 press conf"]
 *  → ["expectation", "recession"]
 */
function extractDistinctiveParts(titles: string[]): string[] {
  if (titles.length <= 1) return titles.map(normalize);
  const normed = titles.map(normalize);
  const words = normed.map(t => t.split(" "));

  // Find common prefix length (in words)
  let prefixLen = 0;
  outer1: for (let i = 0; i < words[0].length; i++) {
    for (let j = 1; j < words.length; j++) {
      if (i >= words[j].length || words[j][i] !== words[0][i]) break outer1;
    }
    prefixLen++;
  }

  // Find common suffix length (in words)
  let suffixLen = 0;
  outer2: for (let i = 0; i < words[0].length - prefixLen; i++) {
    const w0 = words[0][words[0].length - 1 - i];
    for (let j = 1; j < words.length; j++) {
      const idx = words[j].length - 1 - i;
      if (idx < prefixLen || words[j][idx] !== w0) break outer2;
    }
    suffixLen++;
  }

  return words.map(w => {
    const end = suffixLen > 0 ? w.length - suffixLen : w.length;
    const distinctive = w.slice(prefixLen, end).join(" ");
    return distinctive || w.join(" "); // fallback to full if everything is common
  });
}

/** Canonicalize financial synonyms so cross-platform wording matches */
function canonicalize(s: string): string {
  return s
    // Split concatenated number+unit: "25bps" → "25 bps", "0bps" → "0 bps"
    .replace(/(\d+)(bps?|bp)\b/g, "$1 $2")
    // Direction synonyms
    .replace(/\bdecrease\b/g, "cut")
    .replace(/\bincrease\b/g, "hike")
    .replace(/\braise\b/g, "hike")
    .replace(/\blower\b/g, "cut")
    // Hold synonyms
    .replace(/\bno change\b/g, "hold")
    .replace(/\bunchanged\b/g, "hold")
    .replace(/\bmaintain\b/g, "hold")
    .replace(/\bkeep\b/g, "hold")
    // Unit synonyms
    .replace(/\bbasis points?\b/g, "bp")
    .replace(/\bbps\b/g, "bp")
    .replace(/\binterest rates?\b/g, "rates")
    // Quantity: ">25" means "25 or more" in Kalshi = PM's "25+"
    .replace(/\bor more\b/g, "+")
    .replace(/>(\d+)/g, "$1+")  // >25 → 25+
    .replace(/\bany amount\b/g, "0+ bp")
    // 0 bp = hold (Kalshi "Hike rates by 0bps" means no change)
    .replace(/\b(?:hike|cut) rates by 0 bp\b/g, "hold rates")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect if a PM outcome covers a SUPERSET of concepts (e.g. "Crypto/Bitcoin",
 * "Gold or Oil", "Sorry or Pardon"). These break arb logic because PM YES wins
 * in scenarios where the paired Kalshi NO also wins.
 * Returns the extra words not present in the Kalshi title, or null if safe.
 */
function detectCompoundMismatch(kalTitle: string, pmName: string): string | null {
  const pmNorm = normalize(pmName);
  const kalNorm = normalize(kalTitle);

  // Check for quantity thresholds: PM "3+ times" vs Kalshi just "say X" (once)
  const qtyMatch = pmNorm.match(/(\d+)\+?\s*times/);
  if (qtyMatch) {
    const pmQty = Number(qtyMatch[1]);
    const kalQty = kalNorm.match(/(\d+)\+?\s*times/);
    if (!kalQty && pmQty > 1) return `${pmQty}+ times (KAL=once)`;
    if (kalQty && Number(kalQty[1]) !== pmQty) return `${pmQty}+ times (KAL=${kalQty[1]}+ times)`;
  }

  // Find alternatives separated by " or " (with spaces) or "/"
  const altMatches = pmNorm.match(/(\w+)\s*\/\s*(\w+)|(\w+)\s+or\s+(\w+)/g);
  if (!altMatches) return null;
  for (const alt of altMatches) {
    const parts = alt.split(/\s*\/\s*|\s+or\s+/).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    // Check if any part is NOT in the Kalshi title — means PM covers more ground
    const kalHasAll = parts.every(p => kalNorm.includes(p));
    if (!kalHasAll) {
      const extra = parts.filter(p => !kalNorm.includes(p));
      return extra.join(", ");
    }
  }
  return null;
}

function nameScore(kalDistinct: string, pmDistinct: string): number {
  const k = canonicalize(kalDistinct);
  const p = canonicalize(pmDistinct);
  if (k === p) return 1;
  if (k.includes(p) || p.includes(k)) return 0.9;
  // Word overlap — containment coefficient (overlap / smaller set size)
  // Require ≥2 overlapping words to avoid single-word false positives
  const kWords = new Set(k.split(" ").filter(w => w.length > 1));
  const pWords = new Set(p.split(" ").filter(w => w.length > 1));
  let overlap = 0;
  kWords.forEach(w => { if (pWords.has(w)) overlap++; });
  if (overlap < 2) return overlap > 0 ? 0.3 : 0; // single-word match = low confidence
  const minSize = Math.min(kWords.size, pWords.size);
  return minSize > 0 ? overlap / minSize : 0;
}

interface MatchedOutcome {
  kalTicker: string;
  kalTitle: string;
  kalYesAsk: number;
  kalNoAsk: number;
  pmName: string;
  pmAsk: number | null;
  pmTokenId: string;
  edge: number | null; // 1 - kalNoAsk - pmAsk
  matchScore: number;
  compoundWarning?: string; // set if PM covers superset → arb invalid
}

function matchOutcomes(kal: KalOutcome[], pm: PmOutcome[]): MatchedOutcome[] {
  const matched: MatchedOutcome[] = [];
  const usedPm = new Set<number>();
  const usedKal = new Set<number>();

  // Extract distinctive parts to avoid matching on shared boilerplate
  const kalDistinct = extractDistinctiveParts(kal.map(k => k.title));
  const pmDistinct = extractDistinctiveParts(pm.map(p => p.name));

  // Pre-compute all scores
  const scores: { ki: number; pj: number; score: number }[] = [];
  for (let ki = 0; ki < kal.length; ki++) {
    for (let pj = 0; pj < pm.length; pj++) {
      const score = nameScore(kalDistinct[ki], pmDistinct[pj]);
      if (score > 0.4) scores.push({ ki, pj, score });
    }
  }
  // Sort by score descending — best matches first, prevents greedy order issues
  scores.sort((a, b) => b.score - a.score);

  for (const { ki, pj, score } of scores) {
    if (usedKal.has(ki) || usedPm.has(pj)) continue;
    usedKal.add(ki);
    usedPm.add(pj);
    const ko = kal[ki];
    const po = pm[pj];
    const compound = detectCompoundMismatch(ko.title, po.name);
    const edge = (ko.noAsk > 0 && po.ask !== null && !compound) ? 1 - ko.noAsk - po.ask : null;
    matched.push({
      kalTicker: ko.ticker, kalTitle: ko.title,
      kalYesAsk: ko.yesAsk, kalNoAsk: ko.noAsk,
      pmName: po.name, pmAsk: po.ask, pmTokenId: po.tokenId,
      edge, matchScore: score,
      compoundWarning: compound ?? undefined,
    });
  }

  // Second pass: unmatched Kalshi outcomes can re-use PM outcomes that cover
  // a broader range (e.g. PM "25+" covers both KAL "25bp" and KAL ">25bp")
  for (let ki = 0; ki < kal.length; ki++) {
    if (usedKal.has(ki)) continue;
    let bestPj = -1, bestScore = 0.4;
    for (let pj = 0; pj < pm.length; pj++) {
      const score = nameScore(kalDistinct[ki], pmDistinct[pj]);
      if (score > bestScore) { bestScore = score; bestPj = pj; }
    }
    if (bestPj >= 0) {
      usedKal.add(ki);
      const ko = kal[ki];
      const po = pm[bestPj];
      const compound = detectCompoundMismatch(ko.title, po.name);
      const edge = (ko.noAsk > 0 && po.ask !== null && !compound) ? 1 - ko.noAsk - po.ask : null;
      matched.push({
        kalTicker: ko.ticker, kalTitle: ko.title,
        kalYesAsk: ko.yesAsk, kalNoAsk: ko.noAsk,
        pmName: po.name, pmAsk: po.ask, pmTokenId: po.tokenId,
        edge, matchScore: bestScore,
        compoundWarning: compound ?? undefined,
      });
    } else {
      matched.push({
        kalTicker: kal[ki].ticker, kalTitle: kal[ki].title,
        kalYesAsk: kal[ki].yesAsk, kalNoAsk: kal[ki].noAsk,
        pmName: "???", pmAsk: null, pmTokenId: "",
        edge: null, matchScore: 0,
      });
    }
  }

  // Also list unmatched PM outcomes
  for (let j = 0; j < pm.length; j++) {
    if (usedPm.has(j)) continue;
    matched.push({
      kalTicker: "", kalTitle: "???",
      kalYesAsk: 0, kalNoAsk: 0,
      pmName: pm[j].name, pmAsk: pm[j].ask, pmTokenId: pm[j].tokenId,
      edge: null, matchScore: 0,
    });
  }

  return matched;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const pairs = loadCsv();
  if (!pairs.length) {
    console.log("No pairs in static_pairs.csv. Add rows with kalshi,pm URLs.");
    return;
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`MULTI-OUTCOME ARB SCANNER — ${pairs.length} pair(s)`);
  console.log(`${"=".repeat(80)}\n`);

  let totalArbs = 0;

  for (const pair of pairs) {
    const kalEventTicker = extractLastPathSegment(pair.kalshiUrl);
    const pmSlug = extractLastPathSegment(pair.pmUrl);

    console.log(`\n${"─".repeat(70)}`);
    console.log(`KAL: ${kalEventTicker}`);
    console.log(`PM:  ${pmSlug}`);
    console.log(`${"─".repeat(70)}`);

    // Fetch both sides
    const [kalData, pmData] = await Promise.all([
      fetchKalshiEvent(kalEventTicker),
      fetchPmEvent(pmSlug),
    ]);

    if (!kalData) { console.log("  [SKIP] Could not fetch Kalshi event"); continue; }
    if (!pmData) { console.log("  [SKIP] Could not fetch PM event"); continue; }

    console.log(`  KAL: "${kalData.title}" — ${kalData.outcomes.length} outcomes`);
    console.log(`  PM:  "${pmData.title}" — ${pmData.outcomes.length} outcomes`);

    // Match and display
    const matched = matchOutcomes(kalData.outcomes, pmData.outcomes);

    console.log();
    console.log(
      "  " +
      "OUTCOME".padEnd(40) +
      "KAL_YES".padStart(8) +
      "KAL_NO".padStart(8) +
      "PM_ASK".padStart(8) +
      "EDGE".padStart(8) +
      "  MATCH"
    );
    console.log("  " + "─".repeat(80));

    for (const m of matched) {
      const label = (m.kalTitle !== "???" ? m.kalTitle : m.pmName).slice(0, 38);
      const kalYes = m.kalYesAsk > 0 ? (m.kalYesAsk * 100).toFixed(0) + "¢" : "  --";
      const kalNo = m.kalNoAsk > 0 ? (m.kalNoAsk * 100).toFixed(0) + "¢" : "  --";
      const pmAsk = m.pmAsk !== null ? (m.pmAsk * 100).toFixed(0) + "¢" : "  --";
      const edgeStr = m.edge !== null ? (m.edge >= 0 ? "+" : "") + (m.edge * 100).toFixed(1) + "%" : "  --";
      const edgeColor = m.edge !== null && m.edge > 0 ? " ***" : "";
      const matchStr = m.matchScore >= 0.8 ? "OK" : m.matchScore > 0 ? `~${(m.matchScore * 100).toFixed(0)}%` : "MISS";
      const warnStr = m.compoundWarning ? ` [SKIP: PM has "${m.compoundWarning}"]` : "";

      console.log(
        "  " +
        label.padEnd(40) +
        kalYes.padStart(8) +
        kalNo.padStart(8) +
        pmAsk.padStart(8) +
        edgeStr.padStart(8) +
        `  ${matchStr}${edgeColor}${warnStr}`
      );

      if (m.edge !== null && m.edge > 0) totalArbs++;
    }

    // Summary for this event
    const arbs = matched.filter(m => m.edge !== null && m.edge > 0);
    if (arbs.length > 0) {
      console.log();
      console.log(`  >>> ${arbs.length} ARB(S) FOUND:`);
      for (const a of arbs) {
        console.log(`      Buy KAL NO ${a.kalTicker} @${(a.kalNoAsk * 100).toFixed(0)}¢ + PM "${a.pmName}" @${(a.pmAsk! * 100).toFixed(0)}¢ → edge=${(a.edge! * 100).toFixed(2)}%`);
      }
    } else {
      console.log(`\n  No arb opportunities.`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`TOTAL ARB OPPORTUNITIES: ${totalArbs}`);
  console.log(`${"=".repeat(80)}\n`);
}

main().catch(err => console.error("Fatal:", err));
