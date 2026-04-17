import { describe, it, expect, vi } from "vitest";

// Mock all heavy dependencies
vi.mock("./ttConfig.js", () => ({
  DRY_RUN: false,
  KALSHI_FEE_RATE: 0.07,
  PM_FEE_RATE: 0,
  TRADE_USD: 10,
  MAX_CONTRACTS: 999,
  HEDGE_TARGET: "payout",
  STRICT_HEDGE: false,
  PM_ONLY_MAX_CYCLES: 15,
  MIN_EDGE: 0.02,
  kalFetch: vi.fn(),
  polyClobFetch: vi.fn(),
  fmtPct: (v: number) => (v * 100).toFixed(1) + "%",
  ts: () => new Date().toISOString(),
  estimateFees: () => 0,
  KAL_MAKER_MODE: false,
  KAL_MAKER_WAIT_MS: 5000,
  KAL_MAKER_POLL_MS: 500,
  PM_MARKETABLE_MIN_VALUE: 1.0,
  MIN_DEPTH_MULT: 2,
}));

vi.mock("./ttPersistence.js", () => ({
  loadArbTrades: vi.fn(() => []),
  saveArbTrades: vi.fn(),
  resolveArbTrade: vi.fn(),
  logArbTrade: vi.fn(),
  saveHedgeState: vi.fn(),
  saveHedgeStates: vi.fn(),
  loadPendingFills: vi.fn(() => []),
  completePendingFill: vi.fn(),
  _allHedgeStates: [],
  setAllHedgeStates: vi.fn(),
  _reconcileRecoveredTrades: false,
  setReconcileRecoveredTrades: vi.fn(),
  loadMetrics: vi.fn(() => []),
}));

vi.mock("./ttWebSocket.js", () => ({
  getWsKalBestAsk: vi.fn(),
  getWsPmBestAsk: vi.fn(),
  getWsPmBestBid: vi.fn(),
  getWsPmAsks: vi.fn(),
  getWsPmBids: vi.fn(),
  isPmServiceDown: vi.fn(() => false),
  isPm425: vi.fn(() => false),
  markPmDown: vi.fn(),
  markPmUp: vi.fn(),
}));

vi.mock("./ttPmOrders.js", () => ({
  createPmClient: vi.fn(),
  placePmGTCBid: vi.fn(),
  placePmGTCAsk: vi.fn(),
  placePmFAK: vi.fn(),
  placePmFAKSell: vi.fn(),
  cancelPmOrder: vi.fn(),
  cancelAllPmOrdersForToken: vi.fn(),
  getPmOrderFills: vi.fn(),
  buildKalshiIOCOrder: vi.fn(),
  fetchKalshiSingleMarket: vi.fn(),
  fetchPmAsk: vi.fn(),
  sweepKalshiDepth: vi.fn(),
  deriveYesAsks: vi.fn(() => []),
  deriveNoAsks: vi.fn(() => []),
  waitForPmOrderFill: vi.fn(),
}));

vi.mock("./ttReconcile.js", () => ({
  postResolutionFillAudit: vi.fn(),
  fetchPmPositionsCached: vi.fn(() => []),
  sumPmHeld: vi.fn(() => 0),
  extractKalMeta: vi.fn(),
  extractPmMeta: vi.fn(),
  getPmFunder: vi.fn(),
}));

vi.mock("./ttNameMatch.js", () => ({
  namesMatch: vi.fn(() => false),
}));

vi.mock("../kalshiTrade.js", () => ({
  placeKalshiOrder: vi.fn(),
  getKalshiOrder: vi.fn(),
  cancelKalshiOrder: vi.fn(),
  buildKalshiGTCOrder: vi.fn(),
  getKalshiPosition: vi.fn(),
  getKalshiPositionMap: vi.fn(),
  fetchAllKalshiFills: vi.fn(() => []),
  fetchKalshiOrderbook: vi.fn(),
  fetchKalshiMarket: vi.fn(),
  getKalshiBalance: vi.fn(),
  fetchOpenKalshiOrders: vi.fn(() => []),
}));

vi.mock("../polyChain.js", () => ({
  getOnChainBalance: vi.fn(),
  getOnChainBalanceWithFallback: vi.fn(),
}));

vi.mock("../liveScores.js", () => ({
  isMatchFinished: vi.fn(),
  isMatchCancelled: vi.fn(),
  getMatchState: vi.fn(),
}));

vi.mock("../utils.js", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  pickString: (s: string) => s ?? "",
  r2: (n: number) => Math.round(n * 100) / 100,
  kalSideForDir: vi.fn(() => "yes"),
  totalCostForTrade: vi.fn(() => 0),
  normCents: (v: number) => v / 100,
  normDollarsOrCents: (v: number) => v,
}));

const { extractEventDateKey, collectOpenPositions, isScalarSettlement } = await import("./ttHedge.js");

// --- extractEventDateKey ----------------------------------------------------

describe("extractEventDateKey", () => {
  it("extracts series + date from standard ticker", () => {
    expect(extractEventDateKey("KXLOLGAME-26MAR09FNMKOI-MKOI")).toBe("KXLOLGAME-26MAR09");
  });

  it("handles different date formats", () => {
    expect(extractEventDateKey("KXNBAGAME-25JAN15LALBOS-LAL")).toBe("KXNBAGAME-25JAN15");
  });

  it("returns full ticker if less than 2 parts", () => {
    expect(extractEventDateKey("NODASH")).toBe("NODASH");
  });

  it("returns full ticker if no date pattern in middle", () => {
    expect(extractEventDateKey("FOO-BARNODATE-BAZ")).toBe("FOO-BARNODATE-BAZ");
  });

  it("handles empty string", () => {
    expect(extractEventDateKey("")).toBe("");
  });
});

// --- isScalarSettlement -----------------------------------------------------

describe("isScalarSettlement", () => {
  it("returns true for result=scalar", () => {
    expect(isScalarSettlement({ result: "scalar" } as any)).toBe(true);
  });

  it("returns true for result=Scalar (case insensitive)", () => {
    expect(isScalarSettlement({ result: "Scalar" } as any)).toBe(true);
  });

  it("returns false for result=yes", () => {
    expect(isScalarSettlement({ result: "yes" } as any)).toBe(false);
  });

  it("returns false for empty result", () => {
    expect(isScalarSettlement({ result: "" } as any)).toBe(false);
  });

  it("returns false for missing result", () => {
    expect(isScalarSettlement({} as any)).toBe(false);
  });
});

// --- collectOpenPositions ---------------------------------------------------

describe("collectOpenPositions", () => {
  it("returns empty for no trades", async () => {
    const { loadArbTrades } = await import("./ttPersistence.js");
    vi.mocked(loadArbTrades).mockReturnValue([]);
    expect(collectOpenPositions([])).toEqual([]);
  });

  it("skips trades without kalTicker", async () => {
    const { loadArbTrades } = await import("./ttPersistence.js");
    vi.mocked(loadArbTrades).mockReturnValue([
      { id: "1", kalTicker: "", status: "hedging", shares: 5 } as any,
    ]);
    expect(collectOpenPositions([])).toEqual([]);
  });
});
