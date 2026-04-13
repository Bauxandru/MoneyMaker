import { describe, it, expect, vi } from "vitest";

// Mock heavy dependencies to avoid import-time side effects
vi.mock("./ttConfig.js", () => ({
  kalFetch: vi.fn(),
  polyClobFetch: vi.fn(),
  retryOpts: {},
  PM_ORDER_TYPE: "FOK",
  PM_MARKETABLE_MIN_VALUE: 1.0,
}));

vi.mock("../polyAuth.js", () => ({ resolvePolyApiCreds: vi.fn() }));
vi.mock("../http.js", () => ({ fetchJsonWithRetry: vi.fn() }));
vi.mock("../polyChain.js", () => ({ getOnChainBalance: vi.fn() }));

const { pmSafePrice, buildKalshiIOCOrder, deriveYesAsks, deriveNoAsks, sweepKalshiDepth } = await import("./ttPmOrders.js");

// --- pmSafePrice ------------------------------------------------------------

describe("pmSafePrice", () => {
  it("returns original price for 0 shares", () => {
    expect(pmSafePrice(0.55, 0)).toBe(0.55);
  });

  it("floors cost to 2 decimal places", () => {
    // 0.33 * 3 = 0.99 -> floor(99) = 99 -> 99/100/3 = 0.33
    const result = pmSafePrice(0.33, 3);
    expect(result * 3 * 100).toBeLessThanOrEqual(Math.floor(0.33 * 3 * 100) + 0.001);
  });

  it("handles very small prices", () => {
    const result = pmSafePrice(0.01, 1);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it("handles large share counts", () => {
    const result = pmSafePrice(0.55, 1000);
    const cost = result * 1000;
    expect(Math.round(cost * 100) / 100).toBe(Math.floor(0.55 * 1000 * 100) / 100);
  });
});

// --- buildKalshiIOCOrder ----------------------------------------------------

describe("buildKalshiIOCOrder", () => {
  it("builds correct yes-side IOC order", () => {
    const order = buildKalshiIOCOrder("KXNBAGAME-25JAN15LALBOS", 0.45, 10, "yes");
    expect(order.ticker).toBe("KXNBAGAME-25JAN15LALBOS");
    expect(order.side).toBe("yes");
    expect(order.action).toBe("buy");
    expect(order.type).toBe("limit");
    expect(order.time_in_force).toBe("immediate_or_cancel");
    expect(order.yes_price).toBe(45);
    expect(order.no_price).toBeUndefined();
    expect(order.count).toBe(10);
    expect(order.count_fp).toBe("10.00");
    expect(order.buy_max_cost).toBe(450); // 10 * 45
  });

  it("builds correct no-side IOC order", () => {
    const order = buildKalshiIOCOrder("TICKER", 0.30, 5, "no");
    expect(order.no_price).toBe(30);
    expect(order.yes_price).toBeUndefined();
    expect(order.buy_max_cost).toBe(150);
  });

  it("clamps price to 1-99 cents", () => {
    const low = buildKalshiIOCOrder("T", 0.001, 1);
    expect(low.yes_price).toBe(1);

    const high = buildKalshiIOCOrder("T", 1.5, 1);
    expect(high.yes_price).toBe(99);
  });

  it("rounds fractional cents", () => {
    const order = buildKalshiIOCOrder("T", 0.456, 1);
    expect(order.yes_price).toBe(46); // Math.round(45.6)
  });
});

// --- deriveYesAsks / deriveNoAsks -------------------------------------------

describe("deriveYesAsks", () => {
  it("derives YES asks from NO bids", () => {
    const noBids: [number, number][] = [[60, 5], [55, 3]];
    const result = deriveYesAsks(noBids);
    // 100-60=40, 100-55=45 -> sorted ascending
    expect(result).toEqual([[40, 5], [45, 3]]);
  });

  it("filters out-of-range prices", () => {
    const noBids: [number, number][] = [[100, 5], [0, 3]];
    const result = deriveYesAsks(noBids);
    expect(result).toEqual([]); // 100-100=0 (filtered), 100-0=100 (filtered)
  });

  it("handles empty input", () => {
    expect(deriveYesAsks([])).toEqual([]);
  });
});

describe("deriveNoAsks", () => {
  it("derives NO asks from YES bids", () => {
    const yesBids: [number, number][] = [[70, 2], [50, 4]];
    const result = deriveNoAsks(yesBids);
    // 100-70=30, 100-50=50 -> sorted ascending
    expect(result).toEqual([[30, 2], [50, 4]]);
  });

  it("handles empty input", () => {
    expect(deriveNoAsks([])).toEqual([]);
  });
});

// --- sweepKalshiDepth -------------------------------------------------------

describe("sweepKalshiDepth", () => {
  it("sweeps depth up to minContracts", () => {
    const asks: [number, number][] = [[30, 5], [35, 10], [40, 20]];
    const result = sweepKalshiDepth(asks, 12, 40);
    expect(result).not.toBeNull();
    expect(result!.totalQty).toBe(12); // 5 + 7
    expect(result!.worstPrice).toBe(35);
    expect(result!.avgPrice).toBeCloseTo((5 * 30 + 7 * 35) / 12, 6);
  });

  it("returns null for empty asks", () => {
    expect(sweepKalshiDepth([], 10, 50)).toBeNull();
  });

  it("returns null when all asks exceed maxPrice", () => {
    const asks: [number, number][] = [[60, 5]];
    expect(sweepKalshiDepth(asks, 5, 50)).toBeNull();
  });

  it("returns partial fill when insufficient depth", () => {
    const asks: [number, number][] = [[30, 3]];
    const result = sweepKalshiDepth(asks, 10, 50);
    expect(result).not.toBeNull();
    expect(result!.totalQty).toBe(3); // only 3 available
  });

  it("stops at maxPriceCents", () => {
    const asks: [number, number][] = [[30, 5], [35, 5], [45, 5]];
    const result = sweepKalshiDepth(asks, 20, 40);
    expect(result).not.toBeNull();
    expect(result!.totalQty).toBe(10); // only 30 and 35
  });

  it("handles single level exact fill", () => {
    const asks: [number, number][] = [[25, 10]];
    const result = sweepKalshiDepth(asks, 10, 30);
    expect(result).not.toBeNull();
    expect(result!.totalQty).toBe(10);
    expect(result!.avgPrice).toBe(25);
    expect(result!.worstPrice).toBe(25);
  });
});
