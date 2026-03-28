import { describe, it, expect } from "vitest";
import { fmtPct, estimateFees, parseGammaEvents, parseGammaMarkets, parseKalshiMarkets } from "./ttConfig.js";

// ─── fmtPct ─────────────────────────────────────────────────────────────────

describe("fmtPct", () => {
  it("formats 0.1234 as 12.3%", () => {
    expect(fmtPct(0.1234)).toBe("12.3%");
  });

  it("formats with custom decimals", () => {
    expect(fmtPct(0.1234, 2)).toBe("12.34%");
  });

  it("formats 0 as 0.0%", () => {
    expect(fmtPct(0)).toBe("0.0%");
  });

  it("formats 1.0 as 100.0%", () => {
    expect(fmtPct(1.0)).toBe("100.0%");
  });

  it("handles negative values", () => {
    expect(fmtPct(-0.05)).toBe("-5.0%");
  });
});

// ─── estimateFees ───────────────────────────────────────────────────────────

describe("estimateFees", () => {
  it("returns 0 for both prices at 0", () => {
    expect(estimateFees(0, 0)).toBe(0);
  });

  it("returns 0 for both prices at 1", () => {
    expect(estimateFees(1, 1)).toBe(0);
  });

  it("calculates Kalshi fee at 50/50 correctly", () => {
    // kalFee = 0.07 * 0.5 * 0.5 = 0.0175
    // pmFee = 0 * 0.5 * 0.5 = 0 (PM_FEE_RATE defaults to 0)
    const result = estimateFees(0.5, 0.5);
    expect(result).toBeCloseTo(0.0175, 4);
  });

  it("fee is symmetric around 0.5 for same exchange", () => {
    // 0.3 * 0.7 = 0.21, 0.7 * 0.3 = 0.21 — same
    expect(estimateFees(0.3, 0)).toBeCloseTo(estimateFees(0.7, 0), 10);
  });
});

// ─── parseGammaEvents ───────────────────────────────────────────────────────

describe("parseGammaEvents", () => {
  it("returns array if raw is already an array", () => {
    const arr = [{ markets: [] }];
    expect(parseGammaEvents(arr)).toBe(arr);
  });

  it("unwraps { events: [...] } wrapper", () => {
    const events = [{ markets: [{ id: "1" }] }];
    expect(parseGammaEvents({ events })).toBe(events);
  });

  it("wraps { markets: [...] } as a single event", () => {
    const markets = [{ id: "1" }];
    const result = parseGammaEvents({ markets });
    expect(result).toHaveLength(1);
    expect(result[0].markets).toBe(markets);
  });

  it("returns empty for null/undefined", () => {
    expect(parseGammaEvents(null)).toEqual([]);
    expect(parseGammaEvents(undefined)).toEqual([]);
  });

  it("returns empty for string", () => {
    expect(parseGammaEvents("not an object")).toEqual([]);
  });

  it("returns empty for object with no recognized keys", () => {
    expect(parseGammaEvents({ foo: "bar" })).toEqual([]);
  });
});

// ─── parseGammaMarkets ──────────────────────────────────────────────────────

describe("parseGammaMarkets", () => {
  it("returns array if raw is array", () => {
    const arr = [{ id: "1" }];
    expect(parseGammaMarkets(arr)).toBe(arr);
  });

  it("returns empty for non-array", () => {
    expect(parseGammaMarkets({ markets: [1] })).toEqual([]);
    expect(parseGammaMarkets("string")).toEqual([]);
    expect(parseGammaMarkets(null)).toEqual([]);
  });
});

// ─── parseKalshiMarkets ─────────────────────────────────────────────────────

describe("parseKalshiMarkets", () => {
  it("returns markets array from response", () => {
    const markets = [{ ticker: "A" }];
    expect(parseKalshiMarkets({ markets } as any)).toBe(markets);
  });

  it("returns empty for missing markets key", () => {
    expect(parseKalshiMarkets({} as any)).toEqual([]);
  });

  it("returns empty for non-array markets", () => {
    expect(parseKalshiMarkets({ markets: "not-array" } as any)).toEqual([]);
  });
});
