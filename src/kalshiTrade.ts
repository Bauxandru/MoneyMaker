import crypto from "crypto";
import fs from "fs";
import { kalFetchHedge } from "./ARB/ttConfig.js";
import { sleep } from "./utils.js";

type KalshiOrderSide = "yes" | "no";

type KalshiOrderRequest = {
  ticker: string;
  side: KalshiOrderSide;
  action: "buy" | "sell";
  type: "limit";
  // Kalshi v2 valid values: "fill_or_kill" | "immediate_or_cancel"
  // Omitting this field makes the order a resting limit (GTC) by default.
  time_in_force?: "fill_or_kill" | "immediate_or_cancel";
  yes_price?: number;
  no_price?: number;
  count: number;
  count_fp: string;
  buy_max_cost?: number;
  sell_min_return?: number;
  client_order_id?: string;
};

let _cachedPrivateKey: string | null = null;
function loadPrivateKey(): string {
  if (_cachedPrivateKey) return _cachedPrivateKey;
  if (process.env.KALSHI_PRIVATE_KEY) {
    _cachedPrivateKey = process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  } else {
    const p = process.env.KALSHI_PRIVATE_KEY_PATH;
    if (!p) throw new Error("Missing KALSHI_PRIVATE_KEY or KALSHI_PRIVATE_KEY_PATH.");
    _cachedPrivateKey = fs.readFileSync(p, "utf8");
  }
  return _cachedPrivateKey;
}

function baseUrl() {
  return process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
}

function signRequest(method: string, path: string, timestamp: string, privateKeyPem: string) {
  const data = `${timestamp}${method.toUpperCase()}${path}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32
    },
    "base64"
  );
  return signature;
}

export async function placeKalshiOrder(order: KalshiOrderRequest, dryRun: boolean) {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error("Missing KALSHI_API_KEY_ID.");
  const privateKey = loadPrivateKey();

  const url = new URL(`${baseUrl()}/portfolio/orders`);
  const timestamp = Date.now().toString();
  const signature = signRequest("POST", url.pathname, timestamp, privateKey);

  if (dryRun) {
    return {
      dryRun: true,
      url: url.toString(),
      order
    };
  }

  return kalFetchHedge(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp
    },
    body: JSON.stringify(order)
  });
}

export function buildKalshiOrder(
  ticker: string,
  side: KalshiOrderSide,
  price: number,
  usd: number,
  action: "buy" | "sell" = "buy"
): KalshiOrderRequest {
  const cents = Math.round(price * 100);
  if (cents < 1 || cents > 99) {
    throw new Error(`Kalshi price out of bounds: ${price}`);
  }
  const maxCost = Math.round(usd * 100);
  const contracts = Math.max(1, Math.floor(usd / price));
  const count_fp = `${contracts}.00`;
  return {
    ticker,
    side,
    action,
    type: "limit",
    time_in_force: "fill_or_kill",
    yes_price: side === "yes" ? cents : undefined,
    no_price: side === "no" ? cents : undefined,
    count: contracts,
    count_fp,
    buy_max_cost: maxCost
  };
}

// Authenticated GET/DELETE helpers for order management
async function kalshiSignedFetch(method: "GET" | "DELETE", path: string): Promise<unknown> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) throw new Error("Missing KALSHI_API_KEY_ID.");
  const privateKey = loadPrivateKey();
  const fullUrl = new URL(`${baseUrl()}${path}`);
  const timestamp = Date.now().toString();
  // Sign with the full URL pathname (e.g. /trade-api/v2/portfolio/orders/...)
  // to match what the server sees -- same as placeKalshiOrder does for POST.
  const signature = signRequest(method, fullUrl.pathname, timestamp, privateKey);
  return kalFetchHedge(fullUrl.toString(), {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": timestamp
    }
  });
}

export async function getKalshiOrder(orderId: string): Promise<Record<string, unknown>> {
  const res = await kalshiSignedFetch("GET", `/portfolio/orders/${orderId}`);
  const obj = res as Record<string, unknown>;
  return (obj.order as Record<string, unknown>) ?? obj;
}

export async function cancelKalshiOrder(orderId: string, dryRun: boolean): Promise<void> {
  if (dryRun) { console.log(`  [DRY] cancelKalshiOrder ${orderId}`); return; }
  await kalshiSignedFetch("DELETE", `/portfolio/orders/${orderId}`);
}

export type KalshiOpenOrder = {
  orderId: string;
  ticker: string;
  side: string;
  action: string;
  priceCents: number;
  remainingCount: number;
  status: string;
};

/** Fetch all open/resting Kalshi orders. Used at startup to detect orphan orders. */
export async function fetchOpenKalshiOrders(): Promise<KalshiOpenOrder[]> {
  const all: KalshiOpenOrder[] = [];
  let cursor = "";
  while (true) {
    const qs = cursor
      ? `status=resting&limit=200&cursor=${encodeURIComponent(cursor)}`
      : "status=resting&limit=200";
    const res = await kalshiSignedFetch("GET", `/portfolio/orders?${qs}`) as Record<string, unknown>;
    const items = (Array.isArray(res.orders) ? res.orders :
                   Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
    for (const o of items) {
      const yp = Number(o.yes_price ?? (o.yes_price_dollars != null ? Math.round(Number(o.yes_price_dollars) * 100) : 0));
      const np = Number(o.no_price ?? (o.no_price_dollars != null ? Math.round(Number(o.no_price_dollars) * 100) : 0));
      all.push({
        orderId: String(o.order_id ?? o.id ?? ""),
        ticker: String(o.ticker ?? ""),
        side: String(o.side ?? ""),
        action: String(o.action ?? ""),
        priceCents: yp > 0 ? yp : np,
        remainingCount: Number(o.remaining_count ?? o.remaining_count_fp ?? 0),
        status: String(o.status ?? ""),
      });
    }
    if (items.length < 200) break;
    const nextCursor = String(res.cursor ?? res.next_cursor ?? "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(150);
  }
  return all;
}

export function buildKalshiGTCOrder(
  ticker: string,
  action: "buy" | "sell",
  side: KalshiOrderSide,
  priceCents: number,
  count: number
): KalshiOrderRequest {
  const cents = Math.max(1, Math.min(99, priceCents));
  // Resting limit (GTC): omit time_in_force entirely.
  // Kalshi v2 only accepts "fill_or_kill" and "immediate_or_cancel" as explicit values;
  // any other string (including "good_till_cancelled") returns 400 invalid_parameters.
  // When the field is absent, Kalshi treats the order as a resting limit order.
  const contracts = Math.max(1, Math.round(count));
  return {
    ticker,
    side,
    action,
    type: "limit",
    yes_price: side === "yes" ? cents : undefined,
    no_price: side === "no" ? cents : undefined,
    count: contracts,
    count_fp: `${contracts}.00`,
  };
}

// Returns the number of YES contracts we currently hold for a ticker (0 if none or error).
// Used on startup to detect if a Kalshi hedge leg is already filled.
export async function getKalshiPosition(ticker: string): Promise<number> {
  try {
    const path = `/portfolio/positions?ticker=${encodeURIComponent(ticker)}&count_filter=position&limit=10`;
    const res = await kalshiSignedFetch("GET", path) as Record<string, unknown>;
    // API returns { market_positions: [...], event_positions: [...] }
    const items: Record<string, unknown>[] =
      Array.isArray(res.market_positions) ? (res.market_positions as Record<string, unknown>[]) : [];
    for (const item of items) {
      const t = String(item.ticker ?? "");
      if (t === ticker) {
        // position is net contracts: positive = long YES, negative = long NO
        return Math.max(0, Number(item.position ?? item.position_fp ?? 0));
      }
    }
    return 0;
  } catch (err) {
    console.error(`[KAL] getKalshiPosition(${ticker}) FAILED: ${(err as Error).message} -- returning -1`);
    return -1;
  }
}

// Returns the number of NO contracts we currently hold for a ticker (-1 on error, 0 if none).
// Used to detect arb completion via the complete-kal path (YES + NO = $1 guaranteed).
export async function getKalshiNoPosition(ticker: string): Promise<number> {
  try {
    const path = `/portfolio/positions?ticker=${encodeURIComponent(ticker)}&count_filter=position&limit=10`;
    const res = await kalshiSignedFetch("GET", path) as Record<string, unknown>;
    // API returns { market_positions: [...] }
    const items: Record<string, unknown>[] =
      Array.isArray(res.market_positions) ? (res.market_positions as Record<string, unknown>[]) : [];
    for (const item of items) {
      const t = String(item.ticker ?? "");
      if (t === ticker) {
        // position is net contracts: positive = long YES, negative = long NO
        const pos = Number(item.position ?? 0);
        return pos < 0 ? Math.abs(pos) : 0;
      }
    }
    return 0;
  } catch (err) {
    console.error(`[KAL] getKalshiNoPosition(${ticker}) FAILED: ${(err as Error).message} -- returning -1`);
    return -1;
  }
}

// Returns all open YES positions across the entire Kalshi portfolio.
// Used on startup to detect unhedged Kalshi legs (mirror of detectUnhedgedPmPositions).
export async function getKalshiOpenYesPositions(): Promise<Array<{ ticker: string; yesCount: number; avgPriceCents: number }>> {
  try {
    const path = `/portfolio/positions?count_filter=position&limit=200`;
    const res = await kalshiSignedFetch("GET", path) as Record<string, unknown>;
    // API returns { market_positions: [...] }
    const items: Record<string, unknown>[] =
      Array.isArray(res.market_positions) ? (res.market_positions as Record<string, unknown>[]) : [];
    const result: Array<{ ticker: string; yesCount: number; avgPriceCents: number }> = [];
    for (const item of items) {
      const ticker = String(item.ticker ?? "");
      if (!ticker) continue;
      // position: positive = long YES, negative = long NO
      const yesCount = Math.max(0, Number(item.position ?? 0));
      if (yesCount <= 0) continue;
      // Compute average fill price from API fields (cents).
      // total_traded = total amount debited from account in cents (includes fees).
      // Use GROSS cost (total_traded / position) -- this is the true breakeven price.
      // Subtracting fees would give a net cost below actual purchase price, causing
      // exit orders to sell at a guaranteed loss.
      // total_traded_dollars is in dollars (new API); legacy total_traded was in cents
      const totalTradedDollars = item.total_traded_dollars != null
        ? Number(item.total_traded_dollars)
        : Number(item.total_traded ?? 0) / 100;
      const avgPriceCents = yesCount > 0 && totalTradedDollars > 0
        ? Math.round((totalTradedDollars / yesCount) * 100)
        : 0;
      result.push({ ticker, yesCount, avgPriceCents });
    }
    return result;
  } catch {
    return [];
  }
}

// Returns all positions as a Map: ticker -> { yesCount, noCount, avgPriceCents, marketExposureCents, feesPaidCents }.
// Single API call replaces multiple getKalshiPosition() + getKalshiNoPosition() calls.
//
// avgPriceCents is derived from `market_exposure / |position|` — the cost of the CURRENTLY-held
// shares only. Previously this was derived from `total_traded`, which is the cumulative traded
// volume (buys + sells) and diverges wildly from cost-basis once a position has any churn — we
// saw a 467-share position with total_traded ≈ $1284 while market_exposure was the actual
// per-share cost. total_traded is useless as a cost-basis signal; market_exposure is authoritative.
export async function getKalshiPositionMap(): Promise<Map<string, { yesCount: number; noCount: number; avgPriceCents: number; marketExposureCents: number; feesPaidCents: number }>> {
  const map = new Map<string, { yesCount: number; noCount: number; avgPriceCents: number; marketExposureCents: number; feesPaidCents: number }>();
  try {
    const path = `/portfolio/positions?count_filter=position&limit=200`;
    const res = await kalshiSignedFetch("GET", path) as Record<string, unknown>;
    const items: Record<string, unknown>[] =
      Array.isArray(res.market_positions) ? (res.market_positions as Record<string, unknown>[]) : [];
    for (const item of items) {
      const ticker = String(item.ticker ?? "");
      if (!ticker) continue;
      const pos = Number(item.position ?? item.position_fp ?? 0);
      const yesCount = Math.max(0, Math.round(pos));
      const noCount = pos < 0 ? Math.round(Math.abs(pos)) : 0;
      const heldShares = Math.abs(pos);
      // Kalshi API uses _dollars suffixed fields (e.g. "4.670000"); legacy unsuffixed was in cents.
      const marketExposureCents = item.market_exposure_dollars != null
        ? Math.round(Number(item.market_exposure_dollars) * 100)
        : Math.round(Number(item.market_exposure ?? 0));
      const feesPaidCents = item.fees_paid_dollars != null
        ? Math.round(Number(item.fees_paid_dollars) * 100)
        : Math.round(Number(item.fees_paid ?? 0));
      const avgPriceCents = heldShares > 0
        ? Math.round(marketExposureCents / heldShares)
        : 0;
      map.set(ticker, { yesCount, noCount, avgPriceCents, marketExposureCents, feesPaidCents });
    }
  } catch { /* return empty map on error */ }
  return map;
}

// Fetches Kalshi account balance in dollars.
export async function getKalshiBalance(): Promise<number> {
  const res = await kalshiSignedFetch("GET", "/portfolio/balance") as Record<string, unknown>;
  return Number(res.balance ?? 0) / 100;
}

// Fetches a single Kalshi market by ticker. Returns the market object (status, result, etc.).
export async function fetchKalshiMarket(ticker: string): Promise<Record<string, unknown>> {
  const res = await kalshiSignedFetch("GET", `/markets/${ticker}`) as Record<string, unknown>;
  return (res.market as Record<string, unknown>) ?? res;
}

// Fetches the full orderbook for a Kalshi market.
// Returns ask levels as [priceCents, size][] sorted ascending (best ask first).
export async function fetchKalshiOrderbook(ticker: string): Promise<{ yes: [number, number][]; no: [number, number][] }> {
  const path = `/markets/${ticker}/orderbook`;
  const res = await kalshiSignedFetch("GET", path) as Record<string, unknown>;
  const book = (res.orderbook as Record<string, unknown>) ?? res;

  function parseBookLevels(side: unknown): [number, number][] {
    if (!Array.isArray(side)) return [];
    const levels: [number, number][] = [];
    for (const entry of side) {
      let price = 0, size = 0;
      if (Array.isArray(entry)) {
        price = Number(entry[0] ?? 0);
        size = Number(entry[1] ?? 0);
      } else if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        price = Number(o.price ?? 0);
        size = Number(o.quantity ?? o.size ?? 0);
      }
      if (price > 0 && size > 0) levels.push([price, size]);
    }
    // Sort ascending by price (best ask = lowest)
    levels.sort((a, b) => a[0] - b[0]);
    return levels;
  }

  return { yes: parseBookLevels(book.yes), no: parseBookLevels(book.no) };
}

// --- Portfolio data: fills + settlements (for reconciliation) ----------------

export type KalFill = {
  ticker: string;
  action: string;   // "buy" | "sell"
  side: string;      // "yes" | "no"
  count: number;
  yesPrice: number;  // cents
  noPrice: number;   // cents
  feeCost: number;   // dollars (from fee_cost field)
  ts: string;        // ISO timestamp
};

export type KalSettlement = {
  ticker: string;
  revenue: number;      // cents -- payout from Kalshi
  yesCost: number;      // cents -- total cost of YES contracts (no fees)
  noCost: number;       // cents -- total cost of NO contracts (no fees)
  feeCost: number;      // dollars -- actual fee paid
  marketResult: string; // "yes" | "no" | "scalar"
  yesCount: number;
  noCount: number;
  settledTime: string;
};

export async function fetchAllKalshiFills(): Promise<KalFill[]> {
  const all: KalFill[] = [];
  let cursor = "";
  while (true) {
    const qs = cursor ? `limit=200&cursor=${encodeURIComponent(cursor)}` : "limit=200";
    const res = await kalshiSignedFetch("GET", `/portfolio/fills?${qs}`) as Record<string, unknown>;
    const items = (Array.isArray(res.fills) ? res.fills :
                   Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
    for (const f of items) {
      all.push({
        ticker: String(f.ticker ?? ""),
        action: String(f.action ?? ""),
        side: String(f.side ?? ""),
        count: Number(f.count_fp ?? f.count ?? 0),
        // All branches normalize to cents. yes_price and yes_price_fixed are cents; _dollars is dollars.
        // Prefer _dollars fields (6 decimal precision) over legacy integer cents.
        // _dollars = "0.0120" (dollars) → * 100 = 1.2 (cents with sub-penny precision)
        // Legacy yes_price = 1 (integer cents, truncated — loses sub-penny)
        yesPrice: f.yes_price_dollars != null ? Number(f.yes_price_dollars) * 100
          : f.yes_price_fixed != null ? Number(f.yes_price_fixed)
          : f.yes_price != null ? Number(f.yes_price) : 0,
        noPrice: f.no_price_dollars != null ? Number(f.no_price_dollars) * 100
          : f.no_price_fixed != null ? Number(f.no_price_fixed)
          : f.no_price != null ? Number(f.no_price) : 0,
        feeCost: Number.isFinite(parseFloat(String(f.fee_cost ?? "0"))) ? parseFloat(String(f.fee_cost ?? "0")) : 0,
        ts: String(f.created_time ?? ""),
      });
    }
    if (items.length < 200) break;
    const nextCursor = String(res.cursor ?? res.next_cursor ?? "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(150);
  }
  return all;
}

export async function fetchAllKalshiSettlements(): Promise<KalSettlement[]> {
  const all: KalSettlement[] = [];
  let cursor = "";
  while (true) {
    const qs = cursor ? `limit=200&cursor=${encodeURIComponent(cursor)}` : "limit=200";
    const res = await kalshiSignedFetch("GET", `/portfolio/settlements?${qs}`) as Record<string, unknown>;
    const items = (Array.isArray(res.settlements) ? res.settlements :
                   Array.isArray(res.data) ? res.data : []) as Record<string, unknown>[];
    for (const s of items) {
      all.push({
        ticker: String(s.ticker ?? s.market_ticker ?? ""),
        revenue: Number(s.revenue ?? 0),
        yesCost: Number(s.yes_total_cost ?? 0),
        noCost: Number(s.no_total_cost ?? 0),
        feeCost: parseFloat(String(s.fee_cost ?? "0")),
        marketResult: String(s.market_result ?? ""),
        yesCount: Number(s.yes_count ?? s.count ?? 0),
        noCount: Number(s.no_count ?? 0),
        settledTime: String(s.settled_time ?? s.created_time ?? ""),
      });
    }
    if (items.length < 200) break;
    const nextCursor = String(res.cursor ?? res.next_cursor ?? "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
    await sleep(150);
  }
  return all;
}

export function buildKalshiOrderFromCount(
  ticker: string,
  side: KalshiOrderSide,
  price: number,
  count: number,
  action: "buy" | "sell" = "buy"
): KalshiOrderRequest {
  const cents = Math.round(price * 100);
  if (cents < 1 || cents > 99) {
    throw new Error(`Kalshi price out of bounds: ${price}`);
  }
  const contracts = Math.max(1, Math.floor(count));
  const maxCost = Math.round(contracts * price * 100);
  const count_fp = `${contracts}.00`;
  return {
    ticker,
    side,
    action,
    type: "limit",
    time_in_force: "fill_or_kill",
    yes_price: side === "yes" ? cents : undefined,
    no_price: side === "no" ? cents : undefined,
    count: contracts,
    count_fp,
    buy_max_cost: maxCost
  };
}
