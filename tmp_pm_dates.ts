import dotenv from "dotenv";
dotenv.config();
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./src/polyAuth.js";

async function main() {
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL || "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID || 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE || 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  const trades = (await client.getTrades()) as any[];
  console.log("Total PM trades:", trades.length);

  if (trades.length > 0) {
    console.log("\nSample trade (first):");
    console.log(JSON.stringify(trades[0], null, 2));
    console.log("\nAll keys:", Object.keys(trades[0]).join(", "));

    // Check all date-like fields
    const tsFields = ["match_time", "created_at", "timestamp", "time", "date", "t"];
    for (const f of tsFields) {
      const vals = trades.filter((t: any) => t[f]).map((t: any) => t[f]);
      if (vals.length > 0) {
        console.log(`\nField '${f}': ${vals.length} non-empty, latest 3:`, vals.slice(0, 3));
      }
    }

    // Show date distribution
    const allTs = trades.map((t: any) => {
      for (const f of tsFields) {
        if (t[f]) return String(t[f]).substring(0, 10);
      }
      return "unknown";
    });
    const dateCounts = new Map<string, number>();
    for (const d of allTs) {
      dateCounts.set(d, (dateCounts.get(d) || 0) + 1);
    }
    console.log("\nDate distribution (latest 10):");
    const sorted = [...dateCounts.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [date, count] of sorted.slice(0, 10)) {
      console.log(`  ${date}: ${count} trades`);
    }

    // Show latest 3 trades timestamps
    console.log("\nLatest 3 trades (all timestamp fields):");
    for (const t of trades.slice(0, 3)) {
      const info: any = {};
      for (const f of [...tsFields, "id", "asset_id", "side", "size", "price", "status"]) {
        if (t[f] !== undefined) info[f] = t[f];
      }
      console.log(JSON.stringify(info));
    }
  }
}

main().catch(e => console.error("ERROR:", e));
