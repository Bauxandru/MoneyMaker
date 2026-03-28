/**
 * runReconcile.ts — Standalone reconciliation runner.
 * Usage: npx tsx src/runReconcile.ts
 */
import dotenv from "dotenv";
dotenv.config();

import { reconcilePositions } from "./tradeTennis.js";

await reconcilePositions();
console.log("[RECONCILE] Done.");
