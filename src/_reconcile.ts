/**
 * Full sync + dashboard (no trading).
 * Reconciles trade log, cleans hedge state, scans wallets, then starts the dashboard.
 *
 * Usage:  npx tsx src/_reconcile.ts
 *   --no-dashboard    skip starting the dashboard server
 */
import dotenv from "dotenv";
dotenv.config();
import { runFullSync } from "./tradeTennis.js";

const noDash = process.argv.includes("--no-dashboard");

runFullSync()
  .then(async () => {
    console.log("\n[SYNC] Done.");
    if (noDash) {
      process.exit(0);
    } else {
      console.log("[SYNC] Starting dashboard...\n");
      await import("./dashboard.js");
      // dashboard keeps the process alive with its HTTP server
    }
  })
  .catch(e => { console.error("Fatal:", e); process.exit(1); });
