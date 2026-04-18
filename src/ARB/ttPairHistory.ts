/**
 * ttPairHistory.ts -- Long-lived KAL↔PM pairing index.
 *
 * Problem: discovery_cache.json only keeps markets that are currently live.
 * Once a match finalizes and drops off Kalshi's API, its watchlist entry
 * disappears. But we may still hold the KAL shares (waiting for settlement)
 * and the PM shares (waiting for claim/sell). The dashboard's Wallet Arbs
 * tab needs the pairing info to correctly label these positions — without
 * reviving the old arb_trades.json dependency.
 *
 * Solution: every time discovery saves a fresh watchlist, we upsert each
 * (kalTicker → pmTokenId) pairing into data/pair_history.json with a
 * `lastSeenAt` timestamp. On load we prune entries older than 7 days.
 *
 * The bot's hot path does NOT read this file — only the dashboard does.
 * Keeping it read-only for the display side preserves the trading loop's
 * behaviour (it still only sees live markets via discovery_cache.json)
 * while letting the dashboard recover pairing info for recently-resolved
 * markets.
 */

import fs from "node:fs";
import { atomicWriteFileSync } from "./ttConfig.js";
import type { WatchEntry } from "./ttTypes.js";

const PAIR_HISTORY_PATH = "data/pair_history.json";
const PAIR_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface HistoricalPair {
  kalTicker: string;
  pmTokenId: string;
  pmOutcome: string;
  pmSlug: string;
  matchName: string;
  pairedKalTicker: string;   // opposite KAL leg (may be "" for 3-way)
  pairedPmTokenId: string;   // opposite PM leg (may be "" for 3-way)
  firstSeenAt: number;
  lastSeenAt: number;
}

type PairHistoryFile = { entries: HistoricalPair[] };

/**
 * Load the pair history, pruning entries older than the TTL.
 * Returns an empty Map on missing/invalid file (always safe to call).
 */
export function loadPairHistory(): Map<string, HistoricalPair> {
  const map = new Map<string, HistoricalPair>();
  try {
    if (!fs.existsSync(PAIR_HISTORY_PATH)) return map;
    const raw = JSON.parse(fs.readFileSync(PAIR_HISTORY_PATH, "utf8")) as PairHistoryFile;
    const now = Date.now();
    for (const e of raw.entries ?? []) {
      if (!e?.kalTicker) continue;
      if (typeof e.lastSeenAt !== "number") continue;
      if (now - e.lastSeenAt > PAIR_HISTORY_TTL_MS) continue;
      map.set(e.kalTicker, e);
    }
  } catch { /* ignore — return empty */ }
  return map;
}

/**
 * Merge current watchlist pairings into the on-disk history.
 * Preserves firstSeenAt for already-known entries and bumps lastSeenAt to now.
 * Entries older than TTL are dropped on the load step before merging.
 */
export function updatePairHistoryFromWatchlist(watchlist: WatchEntry[]): void {
  const current = loadPairHistory(); // already pruned
  const now = Date.now();

  function upsert(kalTicker: string, pmTokenId: string, pmOutcome: string, pmSlug: string, matchName: string, pairedKal: string, pairedPm: string): void {
    if (!kalTicker || !pmTokenId) return;
    const prev = current.get(kalTicker);
    current.set(kalTicker, {
      kalTicker,
      pmTokenId,
      pmOutcome,
      pmSlug,
      matchName,
      pairedKalTicker: pairedKal,
      pairedPmTokenId: pairedPm,
      firstSeenAt: prev?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  }

  for (const w of watchlist) {
    const w2 = w as WatchEntry & { is3Way?: boolean; pm3?: { tokenId?: string; outcome?: string }; kal3?: { ticker?: string; surname?: string } };
    if (!w2.kal1 || !w2.kal2 || !w2.pm1 || !w2.pm2) continue;
    const baseMatchName = `${w2.kal1.surname ?? ""} vs ${w2.kal2.surname ?? ""}`;
    upsert(
      w2.kal1.ticker, w2.pm1.tokenId, w2.pm1.outcome ?? "", w2.pmSlug ?? "", baseMatchName,
      w2.kal2.ticker, w2.pm2.tokenId
    );
    upsert(
      w2.kal2.ticker, w2.pm2.tokenId, w2.pm2.outcome ?? "", w2.pmSlug ?? "", baseMatchName,
      w2.kal1.ticker, w2.pm1.tokenId
    );
    if (w2.kal3?.ticker && w2.pm3?.tokenId) {
      const threeWayMatch = `${w2.kal1.surname ?? ""} / ${w2.kal2.surname ?? ""} / ${w2.kal3.surname ?? ""}`;
      upsert(
        w2.kal3.ticker, w2.pm3.tokenId, w2.pm3.outcome ?? "", w2.pmSlug ?? "", threeWayMatch,
        "", ""
      );
    }
  }

  try {
    const arr = Array.from(current.values());
    atomicWriteFileSync(PAIR_HISTORY_PATH, JSON.stringify({ entries: arr }, null, 2));
  } catch (err) {
    // Best-effort — log but don't throw. History is a display aid, never on the trading path.
    console.warn(`[PAIR-HISTORY] failed to write: ${(err as Error).message}`);
  }
}
