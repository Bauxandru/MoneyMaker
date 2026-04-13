/**
 * ttAuditLog.ts -- Structured append-only audit log for trade actions.
 *
 * Writes one JSON object per line to data/arb_audit.log.
 * Rotates at ~5MB, keeps 3 old files (.log.1, .log.2, .log.3).
 *
 * Zero dependencies on other ARB modules -- leaf import only.
 */

import fs from "fs";
import path from "path";

const DATA_DIR = path.resolve("data");
const AUDIT_LOG_PATH = path.join(DATA_DIR, "arb_audit.log");
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATIONS = 3;

export interface AuditEntry {
  ts?: string;
  module: "exec" | "hedge" | "reconcile" | "persist" | "ws" | "ghost";
  fn: string;
  action: string;
  tradeId?: string;
  kalTicker?: string;
  pmSlug?: string;
  shares?: number;
  price?: number;
  cost?: number;
  trigger?: string;
  durationMs?: number;
  context?: Record<string, unknown>;
}

/** Start a timer. Call the returned function to get elapsed ms.
 *  Usage: const elapsed = startTimer(); ... audit({ durationMs: elapsed() }); */
export function startTimer(): () => number {
  const t0 = performance.now();
  return () => Math.round(performance.now() - t0);
}

let _rotateCheckedAt = 0; // don't stat() every call -- throttle to once per second

export function audit(entry: AuditEntry): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";

    // Rotate check (at most once per second to avoid stat() overhead in tight loops)
    const now = Date.now();
    if (now - _rotateCheckedAt > 1000) {
      _rotateCheckedAt = now;
      try {
        const stats = fs.statSync(AUDIT_LOG_PATH);
        if (stats.size >= MAX_FILE_SIZE) rotateLog();
      } catch { /* file doesn't exist yet -- fine */ }
    }

    fs.appendFileSync(AUDIT_LOG_PATH, line, "utf8");
  } catch (err) {
    // Audit log failure should never crash the bot -- log to stderr and continue
    console.error(`[AUDIT-LOG] Write failed: ${(err as Error).message}`);
  }
}

function rotateLog(): void {
  try {
    // Delete oldest rotation
    const oldest = `${AUDIT_LOG_PATH}.${MAX_ROTATIONS}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    // Shift .2 -> .3, .1 -> .2, etc.
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${AUDIT_LOG_PATH}.${i}`;
      const to = `${AUDIT_LOG_PATH}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }

    // Current -> .1
    if (fs.existsSync(AUDIT_LOG_PATH)) {
      fs.renameSync(AUDIT_LOG_PATH, `${AUDIT_LOG_PATH}.1`);
    }
  } catch (err) {
    console.error(`[AUDIT-LOG] Rotation failed: ${(err as Error).message}`);
  }
}
