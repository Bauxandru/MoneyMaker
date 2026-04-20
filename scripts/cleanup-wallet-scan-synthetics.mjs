#!/usr/bin/env node
// Cleanup: remove all arb-wallet-scan-* synthetic entries from
// arb_trades.json and hedge_state.json.
//
// Context: the 2026-04-20 wallet-first-scan auto-hedge code shipped with a
// bug where _planAutoHedge only checked hedge_state (not arb_trades) for
// coverage. Resolved trades — which get purged from hedge_state — looked
// untracked to the scan, so synthetic duplicates were created for already-
// paired positions. See ttWalletFirst.ts BUGFIX comment.
//
// This script:
//   1. Backs up arb_trades.json and hedge_state.json with timestamp suffix
//   2. Filters out entries whose id starts with "arb-wallet-scan-"
//   3. Saves the filtered files atomically
//   4. Prints a before/after summary
//
// Safety: only removes arb-wallet-scan-* IDs. Every other trade + hedge_state
// entry is preserved bit-for-bit. Backups give you a rollback path.
//
// Run on the VPS, BEFORE starting the fixed bot build. Otherwise the buggy
// code will re-create synthetics before your next restart.
//
// Usage (from repo root):
//   node scripts/cleanup-wallet-scan-synthetics.mjs
//   node scripts/cleanup-wallet-scan-synthetics.mjs --dry-run

import fs from "node:fs";
import path from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = process.cwd();
const ARB_TRADES_PATH = path.join(ROOT, "data", "arb_trades.json");
const HEDGE_STATE_PATH = path.join(ROOT, "hedge_state.json");

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function cleanup(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.log(`[${label}] file not found (skipping): ${filePath}`);
    return { scanned: 0, removed: 0, kept: 0 };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    console.error(`[${label}] FAILED to parse JSON (aborting): ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(data)) {
    console.error(`[${label}] expected top-level array, got ${typeof data} (aborting)`);
    process.exit(3);
  }

  const getId = (entry) => entry?.id ?? entry?.position?.tradeId ?? "";
  const synthetic = data.filter(e => getId(e).startsWith("arb-wallet-scan-"));
  const clean = data.filter(e => !getId(e).startsWith("arb-wallet-scan-"));

  console.log(`\n[${label}] ${filePath}`);
  console.log(`  scanned: ${data.length}`);
  console.log(`  synthetic to remove: ${synthetic.length}`);
  console.log(`  after cleanup: ${clean.length}`);

  if (synthetic.length > 0) {
    console.log(`  synthetic IDs (first 5): ${synthetic.slice(0, 5).map(getId).join(", ")}`);
  }

  if (DRY_RUN) {
    console.log(`  DRY RUN — no files written`);
    return { scanned: data.length, removed: synthetic.length, kept: clean.length };
  }

  if (synthetic.length === 0) {
    console.log(`  nothing to remove`);
    return { scanned: data.length, removed: 0, kept: clean.length };
  }

  // Backup first
  const backupPath = `${filePath}.backup-${stamp()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`  backup → ${backupPath}`);

  // Write the filtered data
  fs.writeFileSync(filePath, JSON.stringify(clean, null, 2), "utf8");
  console.log(`  wrote: ${filePath}`);

  return { scanned: data.length, removed: synthetic.length, kept: clean.length };
}

console.log(`cleanup-wallet-scan-synthetics.mjs ${DRY_RUN ? "(DRY RUN)" : ""}`);
console.log(`  cwd: ${ROOT}`);

const a = cleanup(ARB_TRADES_PATH, "arb_trades");
const h = cleanup(HEDGE_STATE_PATH, "hedge_state");

console.log(`\n=== SUMMARY ===`);
console.log(`arb_trades:  ${a.removed} synthetic removed (${a.kept} kept)`);
console.log(`hedge_state: ${h.removed} synthetic removed (${h.kept} kept)`);
if (!DRY_RUN && (a.removed > 0 || h.removed > 0)) {
  console.log(`backups written alongside originals — rollback by \`mv *.backup-TIMESTAMP\` if needed`);
}
