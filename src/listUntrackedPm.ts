import dotenv from "dotenv";
dotenv.config();
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";
import fs from "fs";

async function main() {
  const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
  const knownTokens = new Set<string>();
  for (const t of trades) {
    if (t.pmTokenId) knownTokens.add(t.pmTokenId);
  }
  console.log("Known arb tokens:", knownTokens.size);

  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  console.log("Fetching PM CLOB trades...");
  const pmFills = (await client.getTrades()) as any[];
  console.log("Total PM fills:", pmFills.length);

  // Group by asset_id, only BUY+CONFIRMED, exclude known arb tokens
  const byToken = new Map<string, { totalBought: number; totalCost: number }>();
  for (const ct of pmFills) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    if (knownTokens.has(ct.asset_id)) continue;
    if (!byToken.has(ct.asset_id))
      byToken.set(ct.asset_id, { totalBought: 0, totalCost: 0 });
    const g = byToken.get(ct.asset_id)!;
    g.totalBought += Number(ct.size);
    g.totalCost += Number(ct.size) * Number(ct.price);
  }

  // Filter >= 10 shares & >= $5
  const filtered = [...byToken.entries()]
    .filter(([, v]) => v.totalBought >= 10 && v.totalCost >= 5)
    .sort((a, b) => b[1].totalCost - a[1].totalCost);

  console.log("Untracked PM token groups:", filtered.length);
  console.log("\nResolving market names...\n");

  const lines: string[] = [];
  lines.push(
    "SHARES".padStart(7) +
      " | " +
      "COST".padStart(10) +
      " | OUTCOME | MARKET"
  );
  lines.push("-".repeat(120));

  for (const [tokenId, data] of filtered) {
    try {
      const resp = await fetch(
        "https://gamma-api.polymarket.com/markets?clob_token_ids=" + tokenId
      );
      const markets = (await resp.json()) as any[];
      const mkt = markets[0];
      const name = mkt ? mkt.question || "UNKNOWN" : "NOT FOUND";
      let outcome = "?";
      if (mkt && mkt.tokens) {
        const tok = mkt.tokens.find((t: any) => t.token_id === tokenId);
        if (tok) outcome = tok.outcome;
      }
      const line =
        String(Math.round(data.totalBought)).padStart(7) +
        " | " +
        ("$" + data.totalCost.toFixed(2)).padStart(10) +
        " | " +
        outcome.padEnd(7).slice(0, 7) +
        " | " +
        name.slice(0, 90);
      lines.push(line);
      console.log(line);
      await new Promise((r) => setTimeout(r, 80));
    } catch (e) {
      const line =
        String(Math.round(data.totalBought)).padStart(7) +
        " | " +
        ("$" + data.totalCost.toFixed(2)).padStart(10) +
        " | ?       | token:" +
        tokenId.slice(0, 30) +
        "...";
      lines.push(line);
      console.log(line);
    }
  }

  fs.writeFileSync("data/untracked_pm_fills.txt", lines.join("\n"), "utf8");
  console.log("\nSaved to data/untracked_pm_fills.txt");
}

main().catch((e) => console.error("ERROR:", e));
