import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- sweepFullProfitableDepth (pure function, no I/O) ---------------------

// We need to mock ttConfig to avoid import-time side effects
vi.mock("./ttConfig.js", () => ({
  atomicWriteFileSync: vi.fn(),
  DRY_RUN: false,
}));

vi.mock("../dashboardPush.js", () => ({
  pushTradeData: vi.fn().mockResolvedValue(undefined),
}));

const { sweepFullProfitableDepth } = await import("./ttPersistence.js");

describe("sweepFullProfitableDepth", () => {
  it("sweeps all levels below maxPrice", () => {
    const asks: [number, number][] = [[10, 5], [20, 3], [30, 2]];
    const result = sweepFullProfitableDepth(asks, 25, true);
    expect(result.totalQty).toBe(8); // 5 + 3
    expect(result.levels).toHaveLength(2);
    expect(result.avgPrice).toBeCloseTo((5 * 0.1 + 3 * 0.2) / 8, 6);
  });

  it("returns empty for asks above maxPrice", () => {
    const asks: [number, number][] = [[50, 5], [60, 3]];
    const result = sweepFullProfitableDepth(asks, 40, true);
    expect(result.totalQty).toBe(0);
    expect(result.levels).toHaveLength(0);
    expect(result.avgPrice).toBe(0);
  });

  it("handles empty ask levels", () => {
    const result = sweepFullProfitableDepth([], 100, true);
    expect(result.totalQty).toBe(0);
  });

  it("handles decimal (non-cents) mode", () => {
    const asks: [number, number][] = [[0.10, 5], [0.20, 3]];
    const result = sweepFullProfitableDepth(asks, 0.25, false);
    expect(result.totalQty).toBe(8);
    expect(result.levels[0].price).toBe(0.10); // not divided by 100
  });

  it("auto-sorts descending input", () => {
    // Descending order -- the sort guard should fix this
    const asks: [number, number][] = [[30, 2], [20, 3], [10, 5]];
    const result = sweepFullProfitableDepth(asks, 25, true);
    expect(result.totalQty).toBe(8); // should still get 10+20 levels
  });

  it("single level exactly at maxPrice", () => {
    const asks: [number, number][] = [[50, 10]];
    const result = sweepFullProfitableDepth(asks, 50, true);
    expect(result.totalQty).toBe(10);
  });

  it("correctly converts cents to decimal", () => {
    const asks: [number, number][] = [[45, 1]];
    const result = sweepFullProfitableDepth(asks, 45, true);
    expect(result.levels[0].price).toBe(0.45);
    expect(result.totalCost).toBeCloseTo(0.45, 6);
  });
});
