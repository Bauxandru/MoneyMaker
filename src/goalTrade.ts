/**
 * goalTrade.ts — Goal-Based Trading Experiment (Multi-Match)
 *
 * Monitors multiple live soccer matches via API-Football, detects goals,
 * and immediately buys "scoring team wins" on both Kalshi and Polymarket.
 * No hedging — just buy and hold.
 *
 * Usage:
 *   DRY_RUN=true npx tsx src/goalTrade.ts       # test mode (no real orders)
 *   DRY_RUN=false npx tsx src/goalTrade.ts       # live trading
 */

import * as dotenv from "dotenv";
dotenv.config();

import { fetchJsonWithRetry } from "./http.js";
import { placeKalshiOrder, buildKalshiOrder } from "./kalshiTrade.js";
import { sleep } from "./utils.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const TRADE_USD = Number(process.env.GOAL_TRADE_USD ?? "50");
const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY ?? "";
const POLL_INTERVAL_MS = Number(process.env.GOAL_POLL_MS ?? "1000");  // 1s polling

// ─── Match Definitions ──────────────────────────────────────────────────────

type MatchConfig = {
  label: string;
  homeTeam: string;
  awayTeam: string;
  apiFootballSearch: string[];   // words to match in team names
  kalshiSeries: string;         // for price fetching
  kalshiEvent: string;          // event ticker
  kalshi: { homeTicker: string; awayTicker: string; tieTicker: string };
  pm: {
    homeTokenId: string;
    awayTokenId: string;
    drawTokenId: string;
    negRisk: boolean;
    tickSize: number;
  };
  // Runtime state
  fixtureId: number | null;
  lastHomeGoals: number;
  lastAwayGoals: number;
  matchStatus: string;
};

const MATCHES: MatchConfig[] = [
  {
    label: "Le Havre vs Lyon",
    homeTeam: "Le Havre",
    awayTeam: "Lyon",
    apiFootballSearch: ["le havre", "lyon"],
    kalshiSeries: "KXLIGUE1GAME",
    kalshiEvent: "KXLIGUE1GAME-26MAR15HACOL",
    kalshi: {
      homeTicker: "KXLIGUE1GAME-26MAR15HACOL-HAC",
      awayTicker: "KXLIGUE1GAME-26MAR15HACOL-OL",
      tieTicker:  "KXLIGUE1GAME-26MAR15HACOL-TIE",
    },
    pm: {
      homeTokenId: "",
      awayTokenId: "",
      drawTokenId: "",
      negRisk: true,
      tickSize: 0.01,
    },
    fixtureId: null,
    lastHomeGoals: -1,
    lastAwayGoals: -1,
    matchStatus: "NS",
  },
];

// ─── State ───────────────────────────────────────────────────────────────────

type GoalTrade = {
  matchLabel: string;
  minute: number;
  scorer: "home" | "away";
  team: string;
  homeGoals: number;
  awayGoals: number;
  kalshiResult?: unknown;
  timestamp: number;
  entryKalAsk: number;
};

const trades: GoalTrade[] = [];

// ─── Price Fetching ──────────────────────────────────────────────────────────

async function getKalshiPricesForMatch(match: MatchConfig) {
  const tickers = [match.kalshi.homeTicker, match.kalshi.awayTicker, match.kalshi.tieTicker];
  const prices: Record<string, { ask: number; bid: number; askSize: number }> = {};
  await Promise.all(tickers.map(async (ticker) => {
    const url = `https://api.elections.kalshi.com/trade-api/v2/markets/${ticker}`;
    const data = await fetchJsonWithRetry(url) as { market: Record<string, unknown> };
    const m = data.market;
    if (m) {
      prices[ticker] = {
        ask: Number(m.yes_ask_dollars ?? 0),
        bid: Number(m.yes_bid_dollars ?? 0),
        askSize: Number(m.yes_ask_size_fp ?? 0),
      };
    }
  }));
  return prices;
}

// ─── API-Football Polling ────────────────────────────────────────────────────

type ScoreResult = {
  homeGoals: number;
  awayGoals: number;
  status: string;
  elapsed: number;
  found: boolean;
};

// Poll ALL live matches in one request, return per-match results
async function pollAllScores(): Promise<Map<MatchConfig, ScoreResult>> {
  const results = new Map<MatchConfig, ScoreResult>();

  try {
    // If all matches have fixture IDs, use individual requests (cheaper, more reliable)
    const allHaveIds = MATCHES.every(m => m.fixtureId !== null);

    let fixtures: Array<Record<string, unknown>> = [];

    if (allHaveIds) {
      // Fetch each fixture individually (parallel)
      const responses = await Promise.all(
        MATCHES.map(async (m) => {
          const url = `https://v3.football.api-sports.io/fixtures?id=${m.fixtureId}`;
          const data = await fetchJsonWithRetry(url, {
            headers: { "x-apisports-key": API_FOOTBALL_KEY },
          }) as { response: Array<Record<string, unknown>> };
          return { match: m, fixtures: data.response || [] };
        })
      );
      for (const { match, fixtures: fxs } of responses) {
        if (fxs.length > 0) {
          const f = fxs[0];
          const fixture = f.fixture as { id: number; status: { short: string; elapsed: number } };
          const goals = f.goals as { home: number; away: number };
          results.set(match, {
            homeGoals: goals.home ?? 0,
            awayGoals: goals.away ?? 0,
            status: fixture.status.short,
            elapsed: fixture.status.elapsed ?? 0,
            found: true,
          });
        } else {
          results.set(match, { homeGoals: match.lastHomeGoals, awayGoals: match.lastAwayGoals, status: "NOT_FOUND", elapsed: 0, found: false });
        }
      }
    } else {
      // Use single live=all request to find matches
      const url = `https://v3.football.api-sports.io/fixtures?live=all`;
      const data = await fetchJsonWithRetry(url, {
        headers: { "x-apisports-key": API_FOOTBALL_KEY },
      }) as { response: Array<Record<string, unknown>> };
      fixtures = data.response || [];

      for (const match of MATCHES) {
        if (match.fixtureId) {
          // Already have ID, find by ID
          const f = fixtures.find((fx: Record<string, unknown>) => {
            const fxt = fx.fixture as { id: number };
            return fxt.id === match.fixtureId;
          });
          if (f) {
            const fixture = f.fixture as { id: number; status: { short: string; elapsed: number } };
            const goals = f.goals as { home: number; away: number };
            results.set(match, { homeGoals: goals.home ?? 0, awayGoals: goals.away ?? 0, status: fixture.status.short, elapsed: fixture.status.elapsed ?? 0, found: true });
          } else {
            results.set(match, { homeGoals: match.lastHomeGoals, awayGoals: match.lastAwayGoals, status: "NOT_FOUND", elapsed: 0, found: false });
          }
        } else {
          // Search by team names
          const f = fixtures.find((fx: Record<string, unknown>) => {
            const teams = fx.teams as { home: { name: string }; away: { name: string } };
            const all = (teams.home.name + " " + teams.away.name).toLowerCase();
            return match.apiFootballSearch.every(w => all.includes(w));
          });
          if (f) {
            const fixture = f.fixture as { id: number; status: { short: string; elapsed: number } };
            match.fixtureId = fixture.id;
            console.log(`[GOAL] ${match.label}: Found fixture ID ${fixture.id}`);
            const goals = f.goals as { home: number; away: number };
            results.set(match, { homeGoals: goals.home ?? 0, awayGoals: goals.away ?? 0, status: fixture.status.short, elapsed: fixture.status.elapsed ?? 0, found: true });
          } else {
            results.set(match, { homeGoals: match.lastHomeGoals, awayGoals: match.lastAwayGoals, status: "NOT_FOUND", elapsed: 0, found: false });
          }
        }
      }
    }
  } catch (err) {
    console.error(`[GOAL] API-Football poll error:`, err);
    for (const match of MATCHES) {
      results.set(match, { homeGoals: match.lastHomeGoals, awayGoals: match.lastAwayGoals, status: "ERROR", elapsed: 0, found: false });
    }
  }

  return results;
}

// ─── Order Execution ─────────────────────────────────────────────────────────

async function buyOnGoal(match: MatchConfig, scorer: "home" | "away", minute: number, homeGoals: number, awayGoals: number) {
  const scorerTeam = scorer === "home" ? match.homeTeam : match.awayTeam;

  // Strategy: scoring team wins — buy their YES shares
  const buyLabel = scorerTeam;
  const kalTicker = scorer === "home" ? match.kalshi.homeTicker : match.kalshi.awayTicker;

  console.log(`\n${"=".repeat(70)}`);
  console.log(`[GOAL] ${match.label}: ${scorerTeam} SCORED! ${match.homeTeam} ${homeGoals}-${awayGoals} ${match.awayTeam} (${minute}')`);
  console.log(`[GOAL] Strategy: buying $${TRADE_USD} of "${buyLabel}" on Kalshi`);
  console.log(`${"=".repeat(70)}\n`);

  const trade: GoalTrade = {
    matchLabel: match.label,
    minute,
    scorer,
    team: buyLabel,
    homeGoals,
    awayGoals,
    timestamp: Date.now(),
    entryKalAsk: 0,
  };

  // ── Fetch Kalshi prices ──────────────────────────────────────────────
  console.log(`[GOAL] Fetching Kalshi prices...`);
  const kalPrices = await getKalshiPricesForMatch(match);

  const kalPrice = kalPrices[kalTicker];
  if (!kalPrice) {
    console.error(`[GOAL] Kalshi market ${kalTicker} not found!`);
    return;
  }

  console.log(`[GOAL] Kalshi ${kalTicker}: ask=${kalPrice.ask} bid=${kalPrice.bid} size=${kalPrice.askSize}`);
  trade.entryKalAsk = kalPrice.ask;

  // ── Place Kalshi order (no slippage — buy at best ask) ───────────────
  const kalAskCents = Math.round(kalPrice.ask * 100);
  const kalContracts = Math.max(1, Math.floor(TRADE_USD / (kalAskCents / 100)));

  console.log(`[GOAL] Kalshi: buying ${kalContracts} contracts of ${kalTicker} YES @ ${kalAskCents}¢ (FOK)`);

  if (DRY_RUN) {
    console.log(`[DRY] Would place Kalshi FOK: ${kalContracts}x ${kalTicker} YES @ ${kalAskCents}¢`);
    trade.kalshiResult = { dryRun: true, contracts: kalContracts, price: kalAskCents };
  } else {
    try {
      const kalOrder = buildKalshiOrder(kalTicker, "yes", kalAskCents / 100, TRADE_USD);
      const res = await placeKalshiOrder(kalOrder, false);
      trade.kalshiResult = res;
      console.log(`[GOAL] Kalshi order result:`, JSON.stringify(res));
    } catch (err) {
      console.error(`[GOAL] Kalshi order FAILED:`, err);
      trade.kalshiResult = { error: String(err) };
    }
  }

  trades.push(trade);
}

async function buyOnGoalDraw(match: MatchConfig, minute: number) {
  const kalTicker = match.kalshi.tieTicker;
  console.log(`[GOAL] Fetching Kalshi Draw price...`);
  const kalPrices = await getKalshiPricesForMatch(match);
  const kalPrice = kalPrices[kalTicker];
  if (!kalPrice) { console.error(`[GOAL] Kalshi Draw market ${kalTicker} not found!`); return; }

  console.log(`[GOAL] Kalshi ${kalTicker}: ask=${kalPrice.ask} bid=${kalPrice.bid}`);
  const kalAskCents = Math.round(kalPrice.ask * 100);
  const kalContracts = Math.max(1, Math.floor(TRADE_USD / (kalAskCents / 100)));

  console.log(`[GOAL] Kalshi: buying ${kalContracts} contracts of ${kalTicker} YES @ ${kalAskCents}¢ (FOK)`);

  const trade: GoalTrade = { matchLabel: match.label, minute, scorer: "home", team: "Draw", homeGoals: 0, awayGoals: 0, timestamp: Date.now(), entryKalAsk: kalPrice.ask };

  if (DRY_RUN) {
    console.log(`[DRY] Would place Kalshi FOK: ${kalContracts}x ${kalTicker} YES @ ${kalAskCents}¢`);
    trade.kalshiResult = { dryRun: true, contracts: kalContracts, price: kalAskCents };
  } else {
    try {
      const kalOrder = buildKalshiOrder(kalTicker, "yes", kalAskCents / 100, TRADE_USD);
      const res = await placeKalshiOrder(kalOrder, false);
      trade.kalshiResult = res;
      console.log(`[GOAL] Kalshi Draw order result:`, JSON.stringify(res));
    } catch (err) {
      console.error(`[GOAL] Kalshi Draw order FAILED:`, err);
      trade.kalshiResult = { error: String(err) };
    }
  }
  trades.push(trade);
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`[GOAL TRADE] Multi-Match Goal-Based Trading Experiment`);
  console.log(`[GOAL TRADE] DRY_RUN=${DRY_RUN} | TRADE_USD=$${TRADE_USD} | POLL=${POLL_INTERVAL_MS}ms | Kalshi only | Buy scoring team YES`);
  console.log(`[GOAL TRADE] Matches:`);
  for (const m of MATCHES) console.log(`  - ${m.label} (${m.kalshiEvent})`);
  console.log(`${"=".repeat(70)}\n`);

  if (!DRY_RUN) {
    if (!process.env.KALSHI_API_KEY_ID) throw new Error("Missing KALSHI_API_KEY_ID");
    console.log(`[GOAL] LIVE trading mode — Kalshi only, no slippage`);
  }

  // Pre-fetch initial prices for all matches
  console.log(`[GOAL] Fetching initial Kalshi prices...`);
  for (const match of MATCHES) {
    const kalPrices = await getKalshiPricesForMatch(match);
    const h = kalPrices[match.kalshi.homeTicker];
    const a = kalPrices[match.kalshi.awayTicker];
    const t = kalPrices[match.kalshi.tieTicker];
    console.log(`[GOAL] ${match.label}:`);
    console.log(`  Kalshi: ${match.homeTeam}=${h?.ask} | ${match.awayTeam}=${a?.ask} | Tie=${t?.ask}`);
  }
  console.log(`[GOAL] Waiting for matches to start...\n`);

  // Poll loop
  let pollCount = 0;
  let lastLogTime = 0;
  let finishedCount = 0;

  while (finishedCount < MATCHES.length) {
    const scoreMap = await pollAllScores();
    pollCount++;

    for (const match of MATCHES) {
      const score = scoreMap.get(match);
      if (!score) continue;

      // Status change
      if (score.status !== match.matchStatus && score.found) {
        console.log(`[GOAL] ${match.label}: ${match.matchStatus} -> ${score.status} (${score.elapsed}')`);
        if (["FT", "AET", "PEN"].includes(score.status) && !["FT", "AET", "PEN"].includes(match.matchStatus)) {
          console.log(`[GOAL] ${match.label}: FINISHED ${match.homeTeam} ${score.homeGoals}-${score.awayGoals} ${match.awayTeam}`);
          // If 0-0 draw and no goals were traded, buy Draw
          const matchTrades = trades.filter(t => t.matchLabel === match.label);
          if (score.homeGoals === 0 && score.awayGoals === 0 && matchTrades.length === 0) {
            console.log(`[GOAL] ${match.label}: 0-0 with no goals → buying Draw!`);
            await buyOnGoalDraw(match, score.elapsed);
          }
          finishedCount++;
        }
        match.matchStatus = score.status;
      }

      // Skip finished matches
      if (["FT", "AET", "PEN"].includes(match.matchStatus)) continue;

      // Detect goals
      if (score.found && match.lastHomeGoals >= 0 && ["1H", "2H", "ET", "HT"].includes(score.status)) {
        if (score.homeGoals > match.lastHomeGoals) {
          for (let i = 0; i < score.homeGoals - match.lastHomeGoals; i++) {
            await buyOnGoal(match, "home", score.elapsed, score.homeGoals, score.awayGoals);
          }
        }
        if (score.awayGoals > match.lastAwayGoals) {
          for (let i = 0; i < score.awayGoals - match.lastAwayGoals; i++) {
            await buyOnGoal(match, "away", score.elapsed, score.homeGoals, score.awayGoals);
          }
        }
      }

      // Initialize baseline
      if (score.found && match.lastHomeGoals < 0 && score.homeGoals >= 0) {
        match.lastHomeGoals = score.homeGoals;
        match.lastAwayGoals = score.awayGoals;
        console.log(`[GOAL] ${match.label}: Baseline set ${score.homeGoals}-${score.awayGoals}`);
      } else if (score.found && score.homeGoals >= 0) {
        match.lastHomeGoals = score.homeGoals;
        match.lastAwayGoals = score.awayGoals;
      }
    }

    // Log every poll
    const now = Date.now();
    if (true) {
      for (const match of MATCHES) {
        const score = scoreMap.get(match);
        if (!score) continue;
        if (score.found && score.status !== "NOT_FOUND") {
          console.log(`[GOAL] ${match.label}: ${score.status} ${score.elapsed}' | ${match.homeTeam} ${score.homeGoals}-${score.awayGoals} ${match.awayTeam}`);
        } else if (!["FT", "AET", "PEN"].includes(match.matchStatus)) {
          console.log(`[GOAL] ${match.label}: Waiting...`);
        }
      }
      console.log(`[GOAL] polls: ${pollCount}`);
      lastLogTime = now;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // ── Final Summary ──────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(70)}`);
  console.log(`[GOAL TRADE] Session Summary`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Goals detected: ${trades.length}`);
  console.log(`  Total polls: ${pollCount}`);

  for (const t of trades) {
    console.log(`\n  [${t.matchLabel}] Goal (${t.minute}') -> ${t.homeGoals}-${t.awayGoals} | Bought: ${t.team} @ ${t.entryKalAsk}`);
    console.log(`    Kalshi result: ${JSON.stringify(t.kalshiResult)}`);
  }
  console.log(`\n${"=".repeat(70)}\n`);
}

main().catch(err => {
  console.error("[GOAL] Fatal error:", err);
  process.exit(1);
});
