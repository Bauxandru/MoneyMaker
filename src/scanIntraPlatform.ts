/**
 * scanIntraPlatform.ts
 *
 * Scans ALL active Kalshi and Polymarket markets for intra-platform arb:
 *   YES ask + NO ask < $1.00  ->  buy both, guaranteed $1.00 payout, cost < $1.
 *
 * Usage:
 *   npx tsx src/scanIntraPlatform.ts
 *
 * Output: ranked table of opportunities sorted by edge (best first).
 */

import dotenv from "dotenv";
import { createRateLimitedFetcher } from "./http.js";
import { pickString, parseJsonArray, normCents, normDollarsOrCents, bestAskFromSide } from "./utils.js";

dotenv.config();

type AnyRecord = Record<string, unknown>;

// --- Rate-limited fetch helpers -----------------------------------------------

const retryOpts = { timeoutMs: 15000, maxRetries: 4, baseDelayMs: 700, maxDelayMs: 10000, jitterMs: 300 };
const kalFetch = createRateLimitedFetcher(Number(process.env.KALSHI_REQUEST_INTERVAL_MS ?? 120), retryOpts);
const polyFetch = createRateLimitedFetcher(Number(process.env.POLY_REQUEST_INTERVAL_MS ?? 150), retryOpts);

// --- Result types -------------------------------------------------------------

type IntraArb = {
  exchange: "kalshi" | "polymarket";
  id: string;        // ticker (Kalshi) or marketSlug (Polymarket)
  title: string;
  yesAsk: number;
  noAsk: number;
  edge: number;
};

// --- Kalshi scan -------------------------------------------------------------
//
// Kalshi's events endpoint with with_nested_markets=true returns market objects
// that already contain yes_ask / no_ask prices (integer cents, 1–99).
// No extra API calls needed per market.
// ------------------------------------------------------------------------------

async function scanKalshi(): Promise<IntraArb[]> {
  const base =
    process.env.KALSHI_BASE_URL ??
    "https://api.elections.kalshi.com/trade-api/v2";
  const arbs: IntraArb[] = [];
  let cursor = "";
  let totalMarkets = 0;
  let pages = 0;

  while (true) {
    const query = new URLSearchParams({
      limit: "200",
      status: "open",
      with_nested_markets: "true"
    });
    if (cursor) query.set("cursor", cursor);
    const url = `${base}/events?${query.toString()}`;

    let res: AnyRecord;
    try {
      res = await kalFetch<AnyRecord>(url);
    } catch (err) {
      console.error(`[Kalshi] fetch error: ${(err as Error).message}`);
      break;
    }

    const events = Array.isArray(res.events) ? (res.events as AnyRecord[]) : [];
    if (!events.length) break;
    pages++;

    for (const event of events) {
      const eventTitle = pickString(event.title ?? event.name ?? "");
      const markets = Array.isArray(event.markets) ? (event.markets as AnyRecord[]) : [];

      for (const market of markets) {
        const status = pickString(market.status ?? market.state ?? "");
        if (status && status.toLowerCase() !== "active") continue;

        const ticker = pickString(market.ticker ?? market.market_ticker ?? "");
        if (!ticker) continue;

        // Prices come as integer cents (1–99) or dollar strings in the market object
        const yesAsk =
          market.yes_ask_dollars !== undefined
            ? normDollarsOrCents(market.yes_ask_dollars)
            : normCents(market.yes_ask);
        const noAsk =
          market.no_ask_dollars !== undefined
            ? normDollarsOrCents(market.no_ask_dollars)
            : normCents(market.no_ask);

        if (yesAsk === null || noAsk === null) continue;
        if (yesAsk <= 0 || noAsk <= 0 || yesAsk >= 1 || noAsk >= 1) continue;

        totalMarkets++;
        const sum = yesAsk + noAsk;
        if (sum < 1.0) {
          const title = eventTitle
            ? `${eventTitle} / ${pickString(market.title ?? market.subtitle ?? ticker)}`
            : pickString(market.title ?? market.subtitle ?? ticker);
          arbs.push({
            exchange: "kalshi",
            id: ticker,
            title,
            yesAsk,
            noAsk,
            edge: 1 - sum
          });
        }
      }
    }

    const nextCursor = pickString(
      (res as AnyRecord).next_cursor ??
        (res as AnyRecord).cursor ??
        (res as AnyRecord).nextCursor ??
        ""
    );
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;

    process.stderr.write(
      `\r[Kalshi] pages=${pages} markets=${totalMarkets} arbs=${arbs.length}   `
    );
  }

  process.stderr.write(
    `\r[Kalshi] done: ${totalMarkets} markets, ${arbs.length} arbs        \n`
  );
  return arbs;
}

// --- Polymarket scan ----------------------------------------------------------
//
// Two-phase approach:
//  Phase 1: Paginate the Gamma /events endpoint to collect all binary YES/NO
//           markets and their two CLOB token IDs. (fast)
//  Phase 2: For each market, fetch both YES and NO CLOB order books.
//           Check if bestYesAsk + bestNoAsk < 1.00. (slower, ~2 req/market)
// ------------------------------------------------------------------------------

type RawPolyMarket = {
  slug: string;
  question: string;
  yesTokenId: string;
  noTokenId: string;
};

async function fetchPolymarketMarketList(): Promise<RawPolyMarket[]> {
  const gammaBase =
    process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const markets: RawPolyMarket[] = [];
  let offset = 0;
  let pages = 0;

  while (true) {
    const query = new URLSearchParams({
      limit: "100",
      offset: String(offset),
      order: "id",
      ascending: "false",
      active: "true",
      closed: "false"
    });
    const url = `${gammaBase}/events?${query.toString()}`;

    let events: AnyRecord[];
    try {
      const res = await polyFetch<unknown>(url);
      if (Array.isArray(res)) {
        events = res as AnyRecord[];
      } else if (
        res &&
        typeof res === "object" &&
        Array.isArray((res as AnyRecord).events)
      ) {
        events = (res as AnyRecord).events as AnyRecord[];
      } else {
        events = [];
      }
    } catch (err) {
      console.error(`[Polymarket] market list fetch error: ${(err as Error).message}`);
      break;
    }

    if (!events.length) break;
    pages++;

    for (const event of events) {
      const eventMarkets = Array.isArray(event.markets)
        ? (event.markets as AnyRecord[])
        : [];
      for (const market of eventMarkets) {
        const slug = pickString(market.slug ?? market.marketSlug ?? "");
        if (!slug) continue;

        const question = pickString(
          market.question ?? market.title ?? event.title ?? slug
        );
        const outcomes = parseJsonArray(market.outcomes ?? "");
        const tokenIds = parseJsonArray(market.clobTokenIds ?? market.clob_token_ids ?? "");

        const yesIdx = outcomes.findIndex(
          (o) => o.trim().toLowerCase() === "yes"
        );
        const noIdx = outcomes.findIndex(
          (o) => o.trim().toLowerCase() === "no"
        );

        // Only binary markets with exactly yes+no outcomes and two token IDs
        if (yesIdx < 0 || noIdx < 0) continue;
        const yesTokenId = tokenIds[yesIdx];
        const noTokenId = tokenIds[noIdx];
        if (!yesTokenId || !noTokenId) continue;

        markets.push({ slug, question, yesTokenId, noTokenId });
      }
    }

    if (events.length < 100) break;
    offset += 100;
    process.stderr.write(
      `\r[Polymarket] fetching market list... pages=${pages} markets=${markets.length}   `
    );
  }

  process.stderr.write(
    `\r[Polymarket] market list: ${markets.length} binary YES/NO markets      \n`
  );
  return markets;
}

async function checkPolymarketMarket(
  market: RawPolyMarket,
  clobBase: string
): Promise<IntraArb | null> {
  try {
    const [yesBook, noBook] = await Promise.all([
      polyFetch<AnyRecord>(
        `${clobBase}/book?token_id=${encodeURIComponent(market.yesTokenId)}`
      ),
      polyFetch<AnyRecord>(
        `${clobBase}/book?token_id=${encodeURIComponent(market.noTokenId)}`
      )
    ]);

    const yesAsk = bestAskFromSide(yesBook.asks);
    const noAsk = bestAskFromSide(noBook.asks);

    if (yesAsk === null || noAsk === null) return null;

    const sum = yesAsk + noAsk;
    if (sum < 1.0) {
      return {
        exchange: "polymarket",
        id: market.slug,
        title: market.question,
        yesAsk,
        noAsk,
        edge: 1 - sum
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function scanPolymarket(): Promise<IntraArb[]> {
  const clobBase = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const marketList = await fetchPolymarketMarketList();

  const arbs: IntraArb[] = [];
  let completed = 0;
  const total = marketList.length;

  // Concurrently dispatch CLOB checks -- all requests still flow through the
  // single polyQueue so rate limiting is honoured automatically.
  const concurrency = 12;
  const pending = [...marketList];

  async function worker() {
    while (true) {
      const market = pending.shift();
      if (!market) break;
      const arb = await checkPolymarketMarket(market, clobBase);
      completed++;
      if (arb) arbs.push(arb);
      if (completed % 50 === 0 || completed === total) {
        process.stderr.write(
          `\r[Polymarket] checking CLOB... ${completed}/${total} arbs=${arbs.length}   `
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  process.stderr.write(
    `\r[Polymarket] done: ${completed} markets, ${arbs.length} arbs        \n`
  );
  return arbs;
}

// --- Main ---------------------------------------------------------------------

function fmtPct(v: number, decimals = 2): string {
  return (v * 100).toFixed(decimals) + "%";
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

async function main() {
  console.log("[SCAN] Intra-platform arb scan -- scanning Kalshi and Polymarket simultaneously\n");

  const [kalArbs, pmArbs] = await Promise.all([scanKalshi(), scanPolymarket()]);

  const all: IntraArb[] = [...kalArbs, ...pmArbs];
  all.sort((a, b) => b.edge - a.edge);

  console.log();
  if (!all.length) {
    console.log("[SCAN] No intra-platform arb opportunities found across either exchange.");
    console.log(
      "[SCAN] This is expected -- both markets are usually well-arbitraged."
    );
    return;
  }

  const kalCount = all.filter((a) => a.exchange === "kalshi").length;
  const pmCount = all.filter((a) => a.exchange === "polymarket").length;
  console.log(`[SCAN] Found ${all.length} opportunities -- Kalshi: ${kalCount}  Polymarket: ${pmCount}\n`);

  const TITLE_W = 60;
  const header = [
    "#".padStart(4),
    padRight("Exchange", 12),
    padRight("YesAsk", 8),
    padRight("NoAsk", 8),
    padRight("Sum", 8),
    padRight("Edge", 8),
    "Title / ID"
  ].join("  ");

  console.log(header);
  console.log("-".repeat(header.length + 10));

  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const sum = a.yesAsk + a.noAsk;
    const exchLabel =
      a.exchange === "kalshi" ? "KALSHI" : "POLYMARKET";
    const title =
      a.title.length > TITLE_W ? a.title.slice(0, TITLE_W - 1) + "…" : a.title;

    console.log(
      [
        String(i + 1).padStart(4),
        padRight(exchLabel, 12),
        padRight(fmtPct(a.yesAsk), 8),
        padRight(fmtPct(a.noAsk), 8),
        padRight(fmtPct(sum), 8),
        padRight("+" + fmtPct(a.edge), 8),
        `${title}  [${a.id}]`
      ].join("  ")
    );
  }

  console.log();
  console.log("[SCAN] Done.");
}

main().catch((err) => {
  console.error("[SCAN] Fatal:", (err as Error).message ?? err);
  process.exit(1);
});
