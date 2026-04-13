import { describe, it, expect, vi } from "vitest";
import fs from "fs";

// Mock heavy dependencies
vi.mock("./ttConfig.js", () => ({
  polyFetch: vi.fn(),
  kalFetch: vi.fn(),
  polyClobFetch: vi.fn(),
  atomicWriteFileSync: vi.fn(),
  fmtPct: (v: number) => (v * 100).toFixed(1) + "%",
  DISCOVERY_CACHE_TTL_MS: 3_600_000,
  FORCE_DISCOVER: false,
  parseGammaEvents: (raw: unknown) => Array.isArray(raw) ? raw : [],
  parseGammaMarkets: (raw: unknown) => Array.isArray(raw) ? raw : [],
  retryOpts: {},
}));
vi.mock("./ttNameMatch.js", () => ({
  extractEntityName: vi.fn((t: string) => t),
  namesMatch: vi.fn(() => false),
  parseDateFromTicker: vi.fn(() => ""),
  parseDateFromEventTitle: vi.fn(() => ""),
  matchCodePrefix: vi.fn((t: string) => t),
  normalizeName: vi.fn((n: string) => n.toLowerCase()),
  pmSlugToken: vi.fn((n: string) => n.toLowerCase().slice(0, 7)),
  nbaNameToAbbr: vi.fn(() => ""),
  nhlNameToAbbr: vi.fn(() => ""),
  mlbNameToAbbr: vi.fn(() => ""),
  soccerNameToAbbr: vi.fn(() => ""),
  cbbNamesMatch: vi.fn(() => false),
  cbbExpandName: vi.fn((n: string) => n),
  fuzzyIntlNamesMatch: vi.fn(() => false),
  SERIES_TO_PM_PREFIX: {},
  TENNIS_SERIES: new Set(),
  NBA_SERIES: new Set(),
  NHL_SERIES: new Set(),
  MLB_SERIES: new Set(),
  SOCCER_SERIES: new Set(),
  CBB_SERIES: new Set(),
  NON_MONEYLINE_BINARY_SERIES: new Set(),
  SET_WINNER_SERIES: new Set(),
}));
vi.mock("./ttPmOrders.js", () => ({
  fetchPmAsk: vi.fn(),
}));
vi.mock("../utils.js", () => ({
  parseJsonArray: (s: string) => { try { return JSON.parse(s); } catch { return []; } },
  pickString: (s: string) => s,
  normCents: (v: number) => v / 100,
  normDollarsOrCents: (v: number) => v,
  bestAskFromSide: vi.fn(),
}));
vi.mock("../http.js", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

const { extractKalshiEventTicker, extractPmSlug, parseStaticPairsCsv } = await import("./ttDiscovery.js");

// --- extractKalshiEventTicker -----------------------------------------------

describe("extractKalshiEventTicker", () => {
  it("extracts last path segment from full URL", () => {
    expect(extractKalshiEventTicker("https://kalshi.com/markets/KXNBAGAME/some-event/KXNBAGAME-25JAN15LALBOS"))
      .toBe("KXNBAGAME-25JAN15LALBOS");
  });

  it("handles URL with trailing slash", () => {
    expect(extractKalshiEventTicker("https://kalshi.com/markets/FOO/")).toBe("FOO");
  });

  it("returns raw string if not a valid URL", () => {
    expect(extractKalshiEventTicker("KXNBAGAME-25JAN15LALBOS")).toBe("KXNBAGAME-25JAN15LALBOS");
  });

  it("handles empty string", () => {
    expect(extractKalshiEventTicker("")).toBe("");
  });

  it("trims whitespace for raw ticker", () => {
    expect(extractKalshiEventTicker("  TICKER123  ")).toBe("TICKER123");
  });
});

// ��-- extractPmSlug ------���---------------------------------------------------

describe("extractPmSlug", () => {
  it("extracts last path segment from PM URL", () => {
    expect(extractPmSlug("https://polymarket.com/sports/cbb/cbb-duke-unc-2025-03-15"))
      .toBe("cbb-duke-unc-2025-03-15");
  });

  it("handles event URL", () => {
    expect(extractPmSlug("https://polymarket.com/event/some-slug"))
      .toBe("some-slug");
  });

  it("returns raw string if not a URL", () => {
    expect(extractPmSlug("some-slug")).toBe("some-slug");
  });

  it("handles empty string", () => {
    expect(extractPmSlug("")).toBe("");
  });
});

// --- parseStaticPairsCsv -------��--------------------------------------------

describe("parseStaticPairsCsv", () => {
  it("returns empty if file doesn't exist", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    expect(parseStaticPairsCsv()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("returns empty for header-only file", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("kalshi,pm\n" as any);
    expect(parseStaticPairsCsv()).toEqual([]);
    vi.restoreAllMocks();
  });

  it("parses valid CSV rows", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "kalshi,pm\nhttps://kalshi.com/a,https://polymarket.com/b\nhttps://kalshi.com/c,https://polymarket.com/d\n" as any
    );
    const result = parseStaticPairsCsv();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kalshiUrl: "https://kalshi.com/a", pmUrl: "https://polymarket.com/b" });
    vi.restoreAllMocks();
  });

  it("skips rows with missing columns", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue("kalshi,pm\nhttps://kalshi.com/a\n,https://polymarket.com/b\n" as any);
    const result = parseStaticPairsCsv();
    expect(result).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it("skips comment lines", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      "kalshi,pm\n# comment line\nhttps://kalshi.com/a,https://polymarket.com/b\n" as any
    );
    const result = parseStaticPairsCsv();
    expect(result).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
