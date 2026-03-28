// ─── Shared utilities ─────────────────────────────────────────────────────────
// Single source of truth for helpers duplicated across 10+ files.

/** Promise-based delay. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Round to 2 decimal places (dollars/cents). */
export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Round to 4 decimal places (prices). */
export function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Read a numeric env var with fallback. */
export function numEnv(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

/** Read a boolean env var (anything except "false" is true). */
export function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.trim().toLowerCase() !== "false";
}

/** Read a string env var with trim and fallback. */
export function strEnv(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

/** Clamp a number to [0, 1] or return null. */
export function clamp01(value: number | null): number | null {
  if (value === null) return null;
  return Math.min(1, Math.max(0, value));
}

/** Coerce unknown value to string (handles string | number | other). */
export function pickString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

/** Parse unknown value into string[]. Handles arrays, JSON strings, plain strings. */
export function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    try { const p = JSON.parse(t); if (Array.isArray(p)) return p.map(String); } catch { /**/ }
    return [t];
  }
  return [];
}

/** Normalize Kalshi cents (1-99) to decimal (0.01-0.99). Returns null for out-of-range. */
export function normCents(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return n / 100;
}

/** Normalize a value that could be dollars (0-1 exclusive) or cents (≥1). Returns null for invalid.
 *  Binary market prices: 1-99 cents or 0.01-0.99 dollars. Exactly 1.0 is ambiguous but treated as
 *  1 cent (0.01) since binary markets can't have $1.00 prices (that would be 100% certainty). */
export function normDollarsOrCents(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1) return n / 100;   // treat as cents (1 → 0.01, 99 → 0.99)
  return n;                      // already decimal (0 < n < 1)
}

type AnyRecord = Record<string, unknown>;

/** Extract best (lowest) ask price from a CLOB book side array. */
export function bestAskFromSide(sideData: unknown): number | null {
  if (!Array.isArray(sideData)) return null;
  const prices: number[] = [];
  for (const entry of sideData) {
    let price: number;
    if (Array.isArray(entry)) {
      price = Number(entry[0]);
    } else if (entry && typeof entry === "object") {
      price = Number((entry as AnyRecord).price ?? (entry as AnyRecord)[0] ?? NaN);
    } else {
      price = Number(entry);
    }
    if (Number.isFinite(price) && price > 0 && price < 1) prices.push(price);
  }
  return prices.length ? Math.min(...prices) : null;
}

/** Extract best (highest) bid price from a CLOB book side array. */
export function bestBidFromSide(sideData: unknown): number | null {
  if (!Array.isArray(sideData)) return null;
  const prices: number[] = [];
  for (const entry of sideData) {
    let price: number;
    if (Array.isArray(entry)) {
      price = Number(entry[0]);
    } else if (entry && typeof entry === "object") {
      price = Number((entry as AnyRecord).price ?? (entry as AnyRecord)[0] ?? NaN);
    } else {
      price = Number(entry);
    }
    if (Number.isFinite(price) && price > 0 && price < 1) prices.push(price);
  }
  return prices.length ? Math.max(...prices) : null;
}

// ─── Cross-file arb helpers (single source of truth) ─────────────────────────

/** Map arb direction (A-L) to Kalshi side. Covers tennis (A-D) and soccer (G-L). */
export function kalSideForDir(dir: string): "yes" | "no" {
  return (dir === "C" || dir === "D" || dir === "G" || dir === "H" || dir === "I")
    ? "no" : "yes";
}

/** Compute totalCost for an arb trade, including hedgeCost when applicable.
 *  hedgeCost is additive when EITHER leg cost is 0 — covers both:
 *    - KAL-initial, KAL-opposite hedge (pmCost=0, hedgeCost=KAL opp cost)
 *    - PM-initial, PM-opposite hedge  (kalCost=0, hedgeCost=PM opp cost) */
export function totalCostForTrade(t: { kalCost: number; pmCost: number; hedgeCost?: number }): number {
  const hc = ((t.pmCost === 0 || t.kalCost === 0) && (t.hedgeCost ?? 0) > 0) ? (t.hedgeCost ?? 0) : 0;
  return Math.round((t.kalCost + hc + t.pmCost) * 100) / 100;
}
