/**
 * ttPmOrders.ts — Polymarket CLOB client, PM order placement functions,
 * Kalshi IOC order builder, depth sweep, and PM order status polling.
 *
 * Module-level mutable state:
 *   _pmClientCache — cached ClobClient instance (30min TTL)
 */

import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "../polyAuth.js";
import { fetchJsonWithRetry } from "../http.js";
import { sleep, normCents, normDollarsOrCents, bestAskFromSide, bestBidFromSide, pickString } from "../utils.js";
import { getOnChainBalance } from "../polyChain.js";
import {
  kalFetch, polyClobFetch, retryOpts,
  PM_ORDER_TYPE, PM_MARKETABLE_MIN_VALUE,
} from "./ttConfig.js";
import type {
  KalshiMarket, PmOrderResponse, ClobBookEntry, WatchEntry,
} from "./ttTypes.js";

// ─── PM client factory ────────────────────────────────────────────────────────

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

// ─── PM safe price (2dp cost constraint) ──────────────────────────────────────

export function pmSafePrice(price: number, shares: number): number {
  if (shares <= 0) return price;
  const costCents = Math.floor(price * shares * 100);
  return costCents / 100 / shares;
}

// ─── PM order functions ──────────────────────────────────────────────────────

export async function placePmOrder(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    PM_ORDER_TYPE
  );
}

export async function placePmGTCAsk(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "SELL", type: "GTC" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.SELL },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.GTC
  );
}

export async function placePmGTCBid(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "BUY", type: "GTC" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.GTC
  );
}

export async function placePmFOK(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, type: "FOK" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FOK
  );
}

export async function placePmFOKSell(
  tokenId: string, price: number, shares: number,
  tickSize: number, negRisk: boolean, dryRun: boolean
): Promise<unknown> {
  if (dryRun) return { dryRun: true, tokenId: tokenId.slice(0, 12) + "...", price, shares, side: "SELL", type: "FOK" };
  const { client } = await createPmClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price: pmSafePrice(price, shares), size: shares, side: Side.SELL },
    { tickSize: tickSize.toString(), negRisk },
    OrderType.FOK
  );
}

export async function cancelPmOrder(orderId: string, dryRun: boolean): Promise<void> {
  if (dryRun) { console.log(`  [DRY] cancelPmOrder ${orderId}`); return; }
  const { client } = await createPmClient();
  await (client as unknown as { cancelOrder(p: { orderID: string }): Promise<unknown> }).cancelOrder({ orderID: orderId });
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

export async function getPmOrderFills(orderId: string): Promise<{ filledShares: number; status: string }> {
  const { client } = await createPmClient();
  const order = await (client as unknown as { getOrder(id: string): Promise<PmOrderResponse & { size_matched?: number; filled?: number }> }).getOrder(orderId);
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

// ─── PM order status polling ──────────────────────────────────────────────────

export async function waitForPmOrderFill(
  orderId: string,
  timeoutMs = 12_000,
  tokenId?: string,
  preBalance = 0
): Promise<"matched" | "cancelled" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 500;

  while (Date.now() < deadline) {
    await sleep(pollInterval);
    if (tokenId) {
      try {
        const bal = await getOnChainBalance(tokenId);
        if (bal > preBalance) {
          console.log(`  [PM FILL] On-chain balance confirms fill: ${bal} shares (was ${preBalance} before order)`);
          return "matched";
        }
      } catch { /* fall through to CLOB API */ }
    }
    try {
      const { client } = await createPmClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await (client as any).getOrder(orderId);
      const resp = raw as PmOrderResponse;
      const order = resp?.order ?? resp;
      const status = String(order?.status ?? order?.order_status ?? "");
      if (status === "matched") return "matched";
      if (status === "cancelled" || status === "unmatched" || status === "rejected") return "cancelled";
    } catch { /* retry */ }
  }
  return "timeout";
}

// ─── Kalshi IOC order builder ─────────────────────────────────────────────────

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
  buy_max_cost: number;
  client_order_id?: string;
};

export function buildKalshiIOCOrder(ticker: string, limitPriceDec: number, count: number, side: "yes" | "no" = "yes"): KalshiOrderRequest {
  const cents = Math.max(1, Math.min(99, Math.round(limitPriceDec * 100)));
  const maxCost = Math.round(count * cents);
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
    buy_max_cost: maxCost,
  };
}

// ─── Orderbook depth helpers ──────────────────────────────────────────────────

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

// ─── PM / Kalshi fetch helpers ───────────────────────────────────────────────

export async function fetchPmAsk(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await polyClobFetch<{ asks?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`
    );
    return bestAskFromSide(book.asks);
  } catch { return null; }
}

export async function fetchPmAskDirect(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await fetchJsonWithRetry<{ asks?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`, {}, retryOpts
    );
    return bestAskFromSide(book.asks);
  } catch { return null; }
}

export async function fetchPmBidDirect(tokenId: string, clobBase: string): Promise<number | null> {
  try {
    const book = await fetchJsonWithRetry<{ bids?: unknown }>(
      `${clobBase}/book?token_id=${encodeURIComponent(tokenId)}`, {}, retryOpts
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
