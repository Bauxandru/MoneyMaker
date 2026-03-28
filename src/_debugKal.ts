import { fetchJsonWithRetry } from "./http.js";
import * as dotenv from "dotenv";
dotenv.config();

const BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const opts = { timeoutMs: 10000, maxRetries: 1, baseDelayMs: 500, maxDelayMs: 5000, jitterMs: 100 };

async function main() {
  console.log("BASE:", BASE);

  console.log("\n1. Market ticker...");
  try {
    const r = await fetchJsonWithRetry(`${BASE}/markets/kxfeddecision-26mar`, {}, opts);
    console.log("  OK:", JSON.stringify(r).slice(0, 400));
  } catch (e: any) { console.log("  ERR:", e.message.slice(0, 200)); }

  console.log("\n2. Series search...");
  try {
    const r = await fetchJsonWithRetry(`${BASE}/markets?series_ticker=KXFEDDECISION&status=open&limit=5`, {}, opts);
    console.log("  OK:", JSON.stringify(r).slice(0, 400));
  } catch (e: any) { console.log("  ERR:", e.message.slice(0, 200)); }

  console.log("\n3. Event ticker (lowercase)...");
  try {
    const r = await fetchJsonWithRetry(`${BASE}/events/kxfeddecision-26mar?with_nested_markets=true`, {}, opts);
    console.log("  OK:", JSON.stringify(r).slice(0, 400));
  } catch (e: any) { console.log("  ERR:", e.message.slice(0, 200)); }

  console.log("\n4. Event ticker (uppercase)...");
  try {
    const r = await fetchJsonWithRetry(`${BASE}/events/KXFEDDECISION-26MAR?with_nested_markets=true`, {}, opts);
    console.log("  OK:", JSON.stringify(r).slice(0, 400));
  } catch (e: any) { console.log("  ERR:", e.message.slice(0, 200)); }

  console.log("\n5. All open events with 'fed'...");
  try {
    const r: any = await fetchJsonWithRetry(`${BASE}/events?status=open&limit=5&with_nested_markets=true`, {}, opts);
    const events = Array.isArray(r.events) ? r.events : [];
    console.log(`  Got ${events.length} events`);
    for (const ev of events.slice(0, 3)) {
      console.log(`  - ${ev.event_ticker}: ${(ev.title || "").slice(0, 60)}`);
    }
  } catch (e: any) { console.log("  ERR:", e.message.slice(0, 200)); }
}

main().catch(e => console.error("Fatal:", e));
