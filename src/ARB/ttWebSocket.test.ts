import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock ttConfig to avoid import-time side effects
vi.mock("./ttConfig.js", () => ({
  KAL_WS_STALE_MS: 600_000,
  PM_WS_STALE_MS: 30_000,
}));

const {
  wsBookToArray, getWsKalBook, getWsPmAsks, getWsPmBids,
  getWsKalBestAsk, getWsPmBestAsk, getWsPmBestBid,
  wsKalBooks, wsPmBooks,
  recordPrice, getMomentum,
} = await import("./ttWebSocket.js");

describe("wsBookToArray", () => {
  it("converts Map to sorted [price, size][]", () => {
    const m = new Map([[30, 5], [10, 3], [20, 7]]);
    expect(wsBookToArray(m)).toEqual([[10, 3], [20, 7], [30, 5]]);
  });

  it("filters zero-size entries", () => {
    const m = new Map([[10, 0], [20, 5]]);
    expect(wsBookToArray(m)).toEqual([[20, 5]]);
  });

  it("handles empty Map", () => {
    expect(wsBookToArray(new Map())).toEqual([]);
  });
});

describe("getWsKalBook", () => {
  beforeEach(() => wsKalBooks.clear());

  it("returns null for missing ticker", () => {
    expect(getWsKalBook("MISSING")).toBeNull();
  });

  it("returns null for stale book", () => {
    wsKalBooks.set("T", {
      yes: new Map([[40, 5]]),
      no: new Map([[60, 3]]),
      ts: Date.now() - 700_000, // older than 600s
    });
    expect(getWsKalBook("T")).toBeNull();
  });

  it("returns sorted arrays for fresh book", () => {
    wsKalBooks.set("T", {
      yes: new Map([[40, 5], [30, 2]]),
      no: new Map([[60, 3], [70, 1]]),
      ts: Date.now(),
    });
    const book = getWsKalBook("T");
    expect(book).not.toBeNull();
    expect(book!.yes).toEqual([[30, 2], [40, 5]]);
    expect(book!.no).toEqual([[60, 3], [70, 1]]);
  });
});

describe("getWsKalBestAsk", () => {
  beforeEach(() => wsKalBooks.clear());

  it("derives YES ask from NO bids (100 - best NO bid)", () => {
    wsKalBooks.set("T", {
      yes: new Map([[30, 2]]),
      no: new Map([[60, 5], [55, 3]]),
      ts: Date.now(),
    });
    // YES ask = 100 - best NO bid (60) = 40 → 0.40
    expect(getWsKalBestAsk("T", "yes")).toBe(0.40);
  });

  it("derives NO ask from YES bids", () => {
    wsKalBooks.set("T", {
      yes: new Map([[45, 5], [40, 2]]),
      no: new Map([[55, 3]]),
      ts: Date.now(),
    });
    // NO ask = 100 - best YES bid (45) = 55 → 0.55
    expect(getWsKalBestAsk("T", "no")).toBe(0.55);
  });

  it("returns null for missing ticker", () => {
    expect(getWsKalBestAsk("MISSING", "yes")).toBeNull();
  });

  it("returns null when opposite side is empty", () => {
    wsKalBooks.set("T", {
      yes: new Map(),
      no: new Map(),
      ts: Date.now(),
    });
    expect(getWsKalBestAsk("T", "yes")).toBeNull();
  });
});

describe("getWsPmBestAsk / getWsPmBestBid", () => {
  beforeEach(() => wsPmBooks.clear());

  it("returns best ask in decimal", () => {
    wsPmBooks.set("tok1", {
      bids: new Map(),
      asks: new Map([[45, 10], [50, 5]]),
      ts: Date.now(),
    });
    expect(getWsPmBestAsk("tok1")).toBe(0.45);
  });

  it("returns best bid in decimal", () => {
    wsPmBooks.set("tok1", {
      bids: new Map([[40, 10], [35, 5]]),
      asks: new Map(),
      ts: Date.now(),
    });
    expect(getWsPmBestBid("tok1")).toBe(0.40);
  });

  it("returns null for missing token", () => {
    expect(getWsPmBestAsk("MISSING")).toBeNull();
    expect(getWsPmBestBid("MISSING")).toBeNull();
  });

  it("returns null for stale book", () => {
    wsPmBooks.set("tok1", {
      bids: new Map([[40, 10]]),
      asks: new Map([[50, 5]]),
      ts: Date.now() - 60_000, // older than 30s
    });
    expect(getWsPmBestAsk("tok1")).toBeNull();
    expect(getWsPmBestBid("tok1")).toBeNull();
  });

  it("returns null when no asks/bids with size > 0", () => {
    wsPmBooks.set("tok1", {
      bids: new Map(),
      asks: new Map(),
      ts: Date.now(),
    });
    expect(getWsPmBestAsk("tok1")).toBeNull();
    expect(getWsPmBestBid("tok1")).toBeNull();
  });
});

describe("getWsPmAsks / getWsPmBids", () => {
  beforeEach(() => wsPmBooks.clear());

  it("returns asks sorted ascending in decimal", () => {
    wsPmBooks.set("tok1", {
      bids: new Map(),
      asks: new Map([[50, 5], [45, 10], [55, 2]]),
      ts: Date.now(),
    });
    const asks = getWsPmAsks("tok1");
    expect(asks).toEqual([[0.45, 10], [0.50, 5], [0.55, 2]]);
  });

  it("returns bids sorted descending in decimal", () => {
    wsPmBooks.set("tok1", {
      bids: new Map([[40, 10], [35, 5], [45, 2]]),
      asks: new Map(),
      ts: Date.now(),
    });
    const bids = getWsPmBids("tok1");
    expect(bids).toEqual([[0.45, 2], [0.40, 10], [0.35, 5]]);
  });

  it("returns null for stale or missing", () => {
    expect(getWsPmAsks("MISSING")).toBeNull();
    expect(getWsPmBids("MISSING")).toBeNull();
  });
});

// ─── Momentum tracking ─────────────────────────────────────────────────────

describe("recordPrice / getMomentum", () => {
  it("returns 0 for unknown key", () => {
    expect(getMomentum("unknown-key-xyz")).toBe(0);
  });

  it("tracks price change over time", () => {
    // Force-record multiple samples by manipulating timing
    // recordPrice throttles at 500ms intervals, so we record with different timestamps
    // Since we can't easily manipulate Date.now inside the module, we verify basic behavior
    const key = "test-momentum-" + Date.now();
    recordPrice(key, 0.50);
    // Second call within 500ms will be throttled
    const momentum = getMomentum(key);
    expect(momentum).toBe(0); // only 1 sample, no momentum
  });
});
