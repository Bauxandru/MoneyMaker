/**
 * ttIgnoreList.ts -- Persistent "don't monitor" list for wallet positions.
 *
 * Some positions are manual trades (e.g. FEDDECISION), untracked orphans, or
 * genuinely-naked exposures the user doesn't plan to hedge or close. This module
 * lets the user mark them as ignored so they stop cluttering the active Wallet
 * Arbs buckets, while still being visible in a dedicated "Ignored" section for
 * audit.
 */

import fs from "node:fs";
import { atomicWriteFileSync } from "./ttConfig.js";

const IGNORE_LIST_PATH = "data/ignore_list.json";

export interface IgnoreEntry {
  kalTicker?: string;
  pmTokenId?: string;
  reason?: string;
  addedAt: number;
}

type IgnoreFile = { entries: IgnoreEntry[] };

export interface IgnoreSet {
  kalTickers: Set<string>;
  pmTokenIds: Set<string>;
  entries: IgnoreEntry[]; // preserved for display
}

export function loadIgnoreList(): IgnoreSet {
  const result: IgnoreSet = { kalTickers: new Set(), pmTokenIds: new Set(), entries: [] };
  try {
    if (!fs.existsSync(IGNORE_LIST_PATH)) return result;
    const raw = JSON.parse(fs.readFileSync(IGNORE_LIST_PATH, "utf8")) as IgnoreFile;
    for (const e of raw.entries ?? []) {
      if (e.kalTicker) result.kalTickers.add(e.kalTicker);
      if (e.pmTokenId) result.pmTokenIds.add(e.pmTokenId);
      result.entries.push(e);
    }
  } catch { /* ignore — return empty */ }
  return result;
}

function saveIgnoreList(entries: IgnoreEntry[]): void {
  try {
    atomicWriteFileSync(IGNORE_LIST_PATH, JSON.stringify({ entries }, null, 2));
  } catch (e) {
    console.warn(`[IGNORE-LIST] save failed: ${(e as Error).message}`);
  }
}

export function addToIgnoreList(entry: Omit<IgnoreEntry, "addedAt">): IgnoreEntry {
  const current = loadIgnoreList();
  // Dedup: if same (kalTicker, pmTokenId) pair already exists, update it.
  const filtered = current.entries.filter(e =>
    (e.kalTicker ?? "") !== (entry.kalTicker ?? "") ||
    (e.pmTokenId ?? "") !== (entry.pmTokenId ?? "")
  );
  const newEntry: IgnoreEntry = { ...entry, addedAt: Date.now() };
  filtered.push(newEntry);
  saveIgnoreList(filtered);
  return newEntry;
}

export function removeFromIgnoreList(args: { kalTicker?: string; pmTokenId?: string }): boolean {
  const current = loadIgnoreList();
  const before = current.entries.length;
  const filtered = current.entries.filter(e =>
    (e.kalTicker ?? "") !== (args.kalTicker ?? "") ||
    (e.pmTokenId ?? "") !== (args.pmTokenId ?? "")
  );
  if (filtered.length === before) return false;
  saveIgnoreList(filtered);
  return true;
}
