/**
 * Hedge-only mode: sync positions + place hedge orders until filled.
 * No new arbs -- only completes existing unhedged positions.
 *
 * Usage:  npx tsx src/_hedge.ts
 *         npm run hedge
 */
import dotenv from "dotenv";
dotenv.config();
import { runHedgeOnly } from "./tradeTennis.js";

runHedgeOnly()
  .then(() => { console.log("\nDone."); process.exit(0); })
  .catch(e => { console.error("Fatal:", e); process.exit(1); });
