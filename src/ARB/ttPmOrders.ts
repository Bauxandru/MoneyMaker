/**
 * ttPmOrders.ts -- Polymarket CLOB client, PM order placement functions,
 * Kalshi IOC order builder, depth sweep, and PM order status polling.
 *
 * Module-level mutable state:
 *   _pmClientCache -- cached ClobClient instance (30min TTL)
 */

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "../polyAuth.js";
import { sleep, normCents, normDollarsOrCents, bestAskFromSide, bestBidFromSide, pickString } from "../utils.js";
import { getOnChainBalance, getUsdcBalance } from "../polyChain.js";
import { waitForPmFillWs, isPmUserWsReady } from "./ttWebSocket.js";
import {
  kalFetch, polyClobFetch, polyClobFetchHot, hotRetryOpts,
  PM_ORDER_TYPE, PM_MARKETABLE_MIN_VALUE,
} from "./ttConfig.js";
import type {
  KalshiMarket, PmOrderResponse, ClobBookEntry, WatchEntry,
} from "./ttTypes.js";

// --- PM client factory --------------------------------------------------------

let _pmClientCache: { client: ClobClient; createdAt: number } | null = null;
const PM_CLIENT_TTL = 30 * 60_000;

export async function createPmClient(): Promise<{ client: ClobClient; createdAt: number }> {
  if (_pmClientCache && Date.now() - _pmClientCache.createdAt < PM_CLIENT_TTL) {
    return _pmClientCache;
  }
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);
  const funder = process.env.POLY_FUNDER || wallet.address;
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  _pmClientCache = { client: new ClobClient(host, chainId, wallet, creds, sigType, funder), createdAt: Date.now() };
  return _pmClientCache;
}

// --- PM safe price (2dp cost constraint) --------------------------------------

export function pmSafePrice(price: number, shares: number): number {
  if (shares <= 0) return price;
  const costCents = Math.floor(price * shares * 100);
  return costCents / 100 / shares;
}

// --- PM order timeout wrapper ------------------------------------------------

const PM_ORDER_TIMEOUT_MS = 30_000; // 30s max for any PM CLOB order call

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // Force-invalidate the CLOB client cache so the next call creates a fresh
      // connection instead of reusing the stalled one.
      _pmClientCache = null;
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// --- PM order functions ------------------------------------------------------

export async function placePmOrder(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, type: "FAK" };
  const { client } = await createPmClient();
  // Use FAK (Fill And Kill): fills as much as possible, cancels remainder.
  // FOK rejects the entire order if the book can't fill 100% — causes unnecessary failures
  // when the book has slight shortfall (e.g., 10.75 of 11 shares available).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withTimeout((client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FAK
  ), PM_ORDER_TIMEOUT_MS, "placePmOrder");
}

export async function placePmGTCAsk(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "SELL", type: "GTC" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withTimeout((client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.SELL },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.GTC
  ), PM_ORDER_TIMEOUT_MS, "placePmGTCAsk");
}

export async function placePmGTCBid(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "BUY", type: "GTC" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withTimeout((client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.GTC
  ), PM_ORDER_TIMEOUT_MS, "placePmGTCBid");
}

export async function placePmFOK(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  // FAK (Fill And Kill): fills as much as possible, cancels remainder.
  // Better than FOK which kills the ENTIRE order if not 100% fillable.
  // Avoids pm-delayed-zero failures when book has 10.75 of 11 shares.
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, type: "FAK" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withTimeout((client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FAK
  ), PM_ORDER_TIMEOUT_MS, "placePmFOK");
}

export async function placePmFOKSell(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "SELL", type: "FAK" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withTimeout((client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.SELL },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FAK
  ), PM_ORDER_TIMEOUT_MS, "placePmFOKSell");
}

export async function cancelPmOrder(orderId: string, dryRun: boolean): Promise<void> {
  if (dryRun) { console.log(`  [DRY] cancelPmOrder ${orderId}`); return; }
  const { client } = await createPmClient();
  await withTimeout(
    (client as unknown as { cancelOrder(p: { orderID: string }): Promise<unknown> }).cancelOrder({ orderID: orderId }),
    PM_ORDER_TIMEOUT_MS, "cancelPmOrder"
  );
}

export async function cancelAllPmOrdersForToken(tokenId: string): Promise<number> {
  const { client } = await createPmClient();
  type OpenOrder = { id?: string; orderID?: string; status?: string; asset_id?: string };
  const orders = await (client as unknown as { getOpenOrders(p?: { asset_id?: string }): Promise<OpenOrder[]> })
    .getOpenOrders({ asset_id: tokenId });
  let cancelled = 0;
  for (const o of (Array.isArray(orders) ? orders : [])) {
    const oid = o.id ?? o.orderID;
    if (!oid) continue;
    try {
      await (client as unknown as { cancelOrder(p: { orderID: string }): Promise<unknown> }).cancelOrder({ orderID: oid });
      cancelled++;
    } catch { /* may already be gone */ }
  }
  return cancelled;
}

/**
 * Get actual PM fill cost from CLOB getTrades() API.
 * Returns exact per-fill prices from the exchange — no WS inversion issues.
 * Falls back to USDC balance delta if CLOB fails.
 *
 * @param tokenId - PM token that was bought
 * @param orderId - order ID to match against (optional, improves accuracy)
 * @param expectedShares - how many shares we ordered
 * @param preUsdcBalance - USDC balance before the order (for fallback)
 * @param limitPrice - the limit price we placed the order at (for fallback)
 * @returns { avgPrice, totalCost, totalShares } or null if all methods fail
 */
export async function getActualPmFillCost(
  tokenId: string,
  orderId: string | null,
  expectedShares: number,
  preUsdcBalance: number,
  limitPrice: number,
): Promise<{ avgPrice: number; totalCost: number; totalShares: number } | null> {
  // -- Primary: CLOB getTrades() API --
  // Fetches all recent trades and filters to our token + BUY side + CONFIRMED status.
  // Matches by order_id if available, otherwise by token + timestamp proximity.
  try {
    const { client } = await createPmClient();
    const allTrades = await withTimeout(
      (client.getTrades() as Promise<unknown>),
      10_000, "getActualPmFillCost"
    ) as Array<{
      asset_id: string; size: string; price: string; fee_rate_bps: string;
      side: string; status: string; taker_order_id?: string; order_id?: string;
    }>;

    if (allTrades && allTrades.length > 0) {
      // Filter to our token, BUY side, CONFIRMED status
      let fills = allTrades.filter(t =>
        t.asset_id === tokenId && t.side === "BUY" &&
        (t.status === "CONFIRMED" || t.status === "MATCHED" || t.status === "MINED")
      );

      // If we have an order ID, filter to that specific order
      if (orderId && fills.length > 0) {
        const orderFills = fills.filter(t =>
          t.taker_order_id === orderId || t.order_id === orderId
        );
        if (orderFills.length > 0) fills = orderFills;
      }

      if (fills.length > 0) {
        // Sum up actual fill cost
        let totalCost = 0;
        let totalShares = 0;
        for (const f of fills) {
          const price = Number(f.price);
          const size = Number(f.size);
          if (price > 0 && size > 0) {
            totalCost += price * size;
            totalShares += size;
          }
        }
        if (totalShares > 0) {
          const avgPrice = totalCost / totalShares;
          // Sanity: avg price should be within 20% of limit
          if (Math.abs(avgPrice - limitPrice) < 0.20) {
            console.log(`  [PM COST] CLOB getTrades: ${totalShares.toFixed(2)} shares @ avg ${(avgPrice * 100).toFixed(1)}c = $${totalCost.toFixed(2)} (${fills.length} fills)`);
            return {
              avgPrice: Math.round(avgPrice * 10000) / 10000,
              totalCost: Math.round(totalCost * 100) / 100,
              totalShares: Math.round(totalShares),
            };
          }
          // Price might be from complement side — try inverting
          const invAvg = 1 - avgPrice;
          if (Math.abs(invAvg - limitPrice) < 0.20) {
            const invCost = invAvg * totalShares;
            console.log(`  [PM COST] CLOB getTrades (inverted): ${totalShares.toFixed(2)} shares @ avg ${(invAvg * 100).toFixed(1)}c = $${invCost.toFixed(2)}`);
            return {
              avgPrice: Math.round(invAvg * 10000) / 10000,
              totalCost: Math.round(invCost * 100) / 100,
              totalShares: Math.round(totalShares),
            };
          }
          console.warn(`  [PM COST] CLOB price ${(avgPrice * 100).toFixed(1)}c too far from limit ${(limitPrice * 100).toFixed(1)}c — skipping CLOB data`);
        }
      }
    }
  } catch (e) {
    console.warn(`  [PM COST] CLOB getTrades failed: ${(e as Error).message}`);
  }

  // -- Fallback: USDC balance delta --
  // Compare USDC balance before and after to get exact dollars spent.
  if (preUsdcBalance > 0) {
    try {
      const postBalance = await getUsdcBalance();
      if (postBalance >= 0) {
        const usdcSpent = preUsdcBalance - postBalance;
        if (usdcSpent > 0 && usdcSpent < expectedShares * 2) { // sanity: not more than $2/share
          const avgPrice = usdcSpent / expectedShares;
          console.log(`  [PM COST] USDC delta: spent $${usdcSpent.toFixed(2)} on ${expectedShares} shares = avg ${(avgPrice * 100).toFixed(1)}c`);
          return {
            avgPrice: Math.round(avgPrice * 10000) / 10000,
            totalCost: Math.round(usdcSpent * 100) / 100,
            totalShares: expectedShares,
          };
        }
        console.warn(`  [PM COST] USDC delta unreliable: spent=$${usdcSpent.toFixed(2)} for ${expectedShares} shares`);
      }
    } catch (e) {
      console.warn(`  [PM COST] USDC balance check failed: ${(e as Error).message}`);
    }
  }

  console.warn(`  [PM COST] All methods failed — falling back to limit price ${(limitPrice * 100).toFixed(1)}c`);
  return null; // caller will use limit price
}

export async function getPmOrderFills(orderId: string): Promise<{ filledShares: number; status: string }> {
  const { client } = await createPmClient();
  const order = await withTimeout(
    (client as unknown as { getOrder(id: string): Promise<PmOrderResponse & { size_matched?: number; filled?: number }> }).getOrder(orderId),
    PM_ORDER_TIMEOUT_MS, "getPmOrderFills"
  );
  const filledShares = Number(order.size_matched ?? order.filled ?? 0);
  const status = String(order.status ?? "unknown");
  return { filledShares, status };
}

/** Pre-sign a PM order (Step 1). Returns a signed order ready to post. */
export async function preSignPmOrder(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean
): Promise<unknown> {
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).createOrder(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
  );
}

/** Post a pre-signed PM order (Step 2). Submits to CLOB for matching. */
export async function postPreSignedPmOrder(signedOrder: unknown): Promise<unknown> {
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client as any).postOrder(signedOrder, PM_ORDER_TYPE);
}

// --- PM order status polling --------------------------------------------------

export async function waitForPmOrderFill(
  orderId: string,
  timeoutMs?: number,
  _tokenId?: string,
  _preBalance = 0
): Promise<"matched" | "cancelled" | "timeout"> {
  // Race the PM User WS against CLOB polling. Whichever returns a terminal
  // status first wins. This replaces the previous "WS first, fall to one REST
  // check on timeout" pattern, which stalled up to 30 min when the WS
  // disconnected silently (no callers passed a timeoutMs, so the 30-min
  // safety cap kicked in).
  //
  // CLOB /order/{id} typically responds in 100-300 ms and becomes "matched"
  // the moment the match engine commits. WS delivers MATCHED events with
  // similar latency but can die silently between reconnects. Racing both
  // means we pick up MATCHED as soon as EITHER channel sees it — and we
  // give up after `timeoutMs` instead of waiting forever.
  //
  // Per the audit of 42 probe cycles + 11 days of bot history, MATCHED→MINED
  // conversion is 100% (zero FAILED events). Treating MATCHED as done is safe.
  const effectiveTimeoutMs = timeoutMs ?? 30_000; // was: undefined → 30-min safety cap

  type Result = "matched" | "cancelled";

  // WS branch: resolve on first terminal event. Rejects on null/timeout so
  // Promise.any falls through to CLOB polling.
  const wsBranch = (async (): Promise<Result> => {
    if (!isPmUserWsReady()) throw new Error("ws-not-ready");
    const evt = await waitForPmFillWs(orderId, effectiveTimeoutMs);
    if (!evt) throw new Error("ws-no-event");
    const status = evt.status?.toUpperCase();
    if (status === "MATCHED" || status === "CONFIRMED" || status === "MINED") {
      console.log(`  [PM FILL] WS ${status}: ${evt.size} shares @ ${evt.price}`);
      return "matched";
    }
    if (status === "FAILED") return "cancelled";
    throw new Error("ws-unknown-status");
  })();

  // CLOB polling branch: 500 ms interval until terminal or deadline.
  // Uses the rate-limited polyClobFetch queue indirectly via client.getOrder.
  const clobBranch = (async (): Promise<Result> => {
    const deadline = Date.now() + effectiveTimeoutMs;
    const { client } = await createPmClient();
    while (Date.now() < deadline) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const raw = await (client as any).getOrder(orderId);
        const resp = raw as PmOrderResponse;
        const order = resp?.order ?? resp;
        const status = String(order?.status ?? order?.order_status ?? "");
        if (status === "matched") {
          console.log(`  [PM FILL] CLOB poll: matched`);
          return "matched";
        }
        if (status === "cancelled" || status === "unmatched" || status === "rejected") {
          return "cancelled";
        }
      } catch { /* transient CLOB error — retry next tick */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("clob-poll-timeout");
  })();

  // Promise.any resolves with the first branch that returns a terminal status.
  try {
    return await Promise.any([wsBranch, clobBranch]);
  } catch {
    // Both branches exhausted their timeouts without seeing a terminal status.
    return "timeout";
  }
}

// --- Kalshi IOC order builder -------------------------------------------------

export type KalshiOrderRequest = {
  ticker: string;
  side: "yes" | "no";
  action: "buy";
  type: "limit";
  time_in_force: "immediate_or_cancel";
  yes_price?: number;
  no_price?: number;
  count: number;
  count_fp: string;
  buy_max_cost?: number;
  client_order_id?: string;
};

export function buildKalshiIOCOrder(ticker: string, limitPriceDec: number, count: number, side: "yes" | "no" = "yes"): KalshiOrderRequest {
  const cents = Math.max(1, Math.min(99, Math.round(limitPriceDec * 100)));
  // Do NOT set buy_max_cost — Kalshi forces FOK behavior when max_cost is present,
  // rejecting the entire order if it can't fill 100%. Without it, true IOC behavior:
  // fills what's available, cancels the rest.
  return {
    ticker,
    side,
    action: "buy",
    type: "limit",
    time_in_force: "immediate_or_cancel",
    yes_price: side === "yes" ? cents : undefined,
    no_price: side === "no" ? cents : undefined,
    count,
    count_fp: `${count}.00`,
  };
}

// --- Orderbook depth helpers --------------------------------------------------

export function deriveYesAsks(noBids: [number, number][]): [number, number][] {
  return noBids
    .map(([noPrice, size]) => [100 - noPrice, size] as [number, number])
    .filter(([p]) => p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}

export function deriveNoAsks(yesBids: [number, number][]): [number, number][] {
  return yesBids
    .map(([yesPrice, size]) => [100 - yesPrice, size] as [number, number])
    .filter(([p]) => p > 0 && p < 100)
    .sort((a, b) => a[0] - b[0]);
}

export function sweepKalshiDepth(
  askLevels: [number, number][],
  minContracts: number,
  maxPriceCents: number
): { totalQty: number; worstPrice: number; avgPrice: number } | null {
  if (askLevels.length === 0) return null;
  let totalQty = 0, totalCost = 0, worstPrice = 0;
  for (const [priceCents, size] of askLevels) {
    if (priceCents > maxPriceCents) break;
    const take = Math.min(size, minContracts - totalQty);
    if (take <= 0) break;
    totalQty += take;
    totalCost += take * priceCents;
    worstPrice = priceCents;
    if (totalQty >= minContracts) break;
  }
  if (totalQty === 0) return null;
  return { totalQty, worstPrice, avgPrice: totalCost / totalQty };
}

export function sweepPmDepth(
  askLevels: [number, number][],
  maxPrice: number
): { totalQty: number; avgPrice: number } {
  let totalQty = 0, totalCost = 0;
  for (const [price, size] of askLevels) {
    if (price > maxPrice) break;
    totalQty += size;
    totalCost += size * price;
  }
  return { totalQty, avgPrice: totalQty > 0 ? totalCost / totalQty : 0 };
}

// --- PM / Kalshi fetch helpers -----------------------------------------------

export async function fetchPmAsk(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await polyClobFetch<{ asks?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    return bestAskFromSide(book.asks);
  } catch { return null; }
}

export async function fetchPmAskDirect(tokenId: string, clobBase: string): Promise<number | null> {
  // Uses raw fetchJsonWithRetry (no rate-limiter queue) — intentional.
  // This function is called 20-40× per cycle from the pm-prices REST batch, all in parallel
  // inside a 3s Promise.race. If routed through polyClobFetchHot, abandoned calls from
  // timed-out batches accumulate slot reservations, pushing nextAllowedAt minutes into the
  // future and freezing all subsequent callers (observed as 5-min pm-prices watchdog stall).
  // The outer Promise.race + hotRetryOpts (2s timeout, 1 retry) bound the per-call blast.
  try {
    const { fetchJsonWithRetry } = await import("../http.js");
    const book = await fetchJsonWithRetry<{ asks?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`, {}, hotRetryOpts
    );
    return bestAskFromSide(book.asks);
  } catch { return null; }
}

export async function fetchPmBidDirect(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await polyClobFetchHot<{ bids?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    return bestBidFromSide(book.bids);
  } catch { return null; }
}

export async function fetchPmAskDepth(tokenId: string, clobBase: string): Promise<[number, number][]> {
  try {
    const book = await polyClobFetch<{ asks?: ClobBookEntry[] }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    if (!Array.isArray(book.asks)) return [];
    const levels: [number, number][] = [];
    for (const entry of book.asks as ClobBookEntry[]) {
      let price = 0, size = 0;
      if (Array.isArray(entry)) { price = Number(entry[0]); size = Number(entry[1]); }
      else if (entry && typeof entry === "object") { price = Number(entry.price ?? 0); size = Number(entry.size ?? 0); }
      if (price > 0 && price < 1 && size > 0) levels.push([price, size]);
    }
    levels.sort((a, b) => a[0] - b[0]);
    return levels;
  } catch { return []; }
}

export async function fetchKalshiSingleMarket(ticker: string): Promise<{ ask: number | null; bid: number | null; noAsk: number | null }> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  try {
    const res = await kalFetch<{ market?: KalshiMarket }>(`${kalBase}/markets/${ticker}`);
    const mkt = res.market ?? res as unknown as KalshiMarket;
    const ask = mkt.yes_ask_dollars !== undefined ? normDollarsOrCents(mkt.yes_ask_dollars) : normCents(mkt.yes_ask);
    const bid = mkt.yes_bid_dollars !== undefined ? normDollarsOrCents(mkt.yes_bid_dollars) : normCents(mkt.yes_bid);
    const noAsk = mkt.no_ask_dollars !== undefined ? normDollarsOrCents(mkt.no_ask_dollars) : normCents(mkt.no_ask);
    return { ask, bid, noAsk };
  } catch { return { ask: null, bid: null, noAsk: null }; }
}

export async function refreshKalshiPrices(watchlist: WatchEntry[]): Promise<void> {
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
  const seriesSet = new Set<string>();
  for (const entry of watchlist) {
    const s1 = entry.kal1.ticker.split("-")[0];
    const s2 = entry.kal2.ticker.split("-")[0];
    if (s1) seriesSet.add(s1.toUpperCase());
    if (s2) seriesSet.add(s2.toUpperCase());
    if (entry.kal3) { const s3 = entry.kal3.ticker.split("-")[0]; if (s3) seriesSet.add(s3.toUpperCase()); }
  }
  const priceMap = new Map<string, { yes: number; no: number; yesAskSize: number; noAskSize: number }>();
  for (const series of seriesSet) {
    let cursor = "";
    try {
      while (true) {
        const q = new URLSearchParams({ series_ticker: series, status: "open", limit: "200" });
        if (cursor) q.set("cursor", cursor);
        const res = await kalFetch<{ markets?: KalshiMarket[]; next_cursor?: string; cursor?: string }>(`${kalBase}/markets?${q}`);
        const mlist = res.markets ?? [];
        for (const m of mlist) {
          const ticker = pickString(m.ticker ?? "");
          const yesAsk = m.yes_ask_dollars !== undefined ? normDollarsOrCents(m.yes_ask_dollars) : normCents(m.yes_ask);
          const noAsk = m.no_ask_dollars !== undefined ? normDollarsOrCents(m.no_ask_dollars) : normCents(m.no_ask);
          const yesAskSz = Number(m.yes_ask_size_fp ?? m.yes_ask_size ?? 0) || 0;
          const noAskSz = Number(m.no_ask_size_fp ?? m.no_ask_size ?? 0) || 0;
          if (ticker && yesAsk !== null) priceMap.set(ticker, { yes: yesAsk, no: noAsk ?? 1, yesAskSize: yesAskSz, noAskSize: noAskSz });
        }
        cursor = pickString(res.next_cursor ?? res.cursor ?? "");
        if (!cursor || mlist.length < 200) break;
      }
    } catch (err) {
      console.error(`[POLL] Kalshi ${series} error: ${(err as Error).message}`);
    }
  }
  for (const entry of watchlist) {
    const p1 = priceMap.get(entry.kal1.ticker);
    const p2 = priceMap.get(entry.kal2.ticker);
    if (p1) { entry.kal1.yesAsk = p1.yes; entry.kal1.noAsk = p1.no; entry.kal1.yesAskSize = p1.yesAskSize; entry.kal1.noAskSize = p1.noAskSize; }
    if (p2) { entry.kal2.yesAsk = p2.yes; entry.kal2.noAsk = p2.no; entry.kal2.yesAskSize = p2.yesAskSize; entry.kal2.noAskSize = p2.noAskSize; }
    if (entry.kal3) {
      const p3 = priceMap.get(entry.kal3.ticker);
      if (p3) { entry.kal3.yesAsk = p3.yes; entry.kal3.noAsk = p3.no; entry.kal3.yesAskSize = p3.yesAskSize; entry.kal3.noAskSize = p3.noAskSize; }
    }
  }
}
