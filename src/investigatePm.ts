import dotenv from "dotenv";
dotenv.config();
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";
import fs from "fs";

interface ArbTrade {
  id: string;
  match: string;
  pmTokenId?: string;
  pmSlug?: string;
  kalTicker?: string;
  shares: number;
  pmCost: number;
  pmFillPrice: number;
  status: string;
  dir: string;
  resolutionMethod?: string;
  [k: string]: unknown;
}

async function main() {
  const trades: ArbTrade[] = JSON.parse(
    fs.readFileSync("data/arb_trades.json", "utf8")
  );
  const knownTokens = new Set<string>();
  for (const t of trades) {
    if (t.pmTokenId) knownTokens.add(t.pmTokenId);
  }

  // Fetch PM fills
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

  // Group untracked fills by asset_id
  const byToken = new Map<
    string,
    { totalBought: number; totalCost: number; fills: any[] }
  >();
  for (const ct of pmFills) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    if (knownTokens.has(ct.asset_id)) continue;
    if (!byToken.has(ct.asset_id))
      byToken.set(ct.asset_id, { totalBought: 0, totalCost: 0, fills: [] });
    const g = byToken.get(ct.asset_id)!;
    g.totalBought += Number(ct.size);
    g.totalCost += Number(ct.size) * Number(ct.price);
    g.fills.push(ct);
  }

  // Also group ALL fills (including tracked) by asset_id for full picture
  const allByToken = new Map<
    string,
    { totalBought: number; totalCost: number; fills: any[] }
  >();
  for (const ct of pmFills) {
    if (ct.side !== "BUY" || ct.status !== "CONFIRMED") continue;
    if (!allByToken.has(ct.asset_id))
      allByToken.set(ct.asset_id, { totalBought: 0, totalCost: 0, fills: [] });
    const g = allByToken.get(ct.asset_id)!;
    g.totalBought += Number(ct.size);
    g.totalCost += Number(ct.size) * Number(ct.price);
    g.fills.push(ct);
  }

  // Filter to esports/tennis only (>= 10 shares)
  const filtered = [...byToken.entries()]
    .filter(([, v]) => v.totalBought >= 10 && v.totalCost >= 5)
    .sort((a, b) => b[1].totalCost - a[1].totalCost);

  console.log("Total untracked token groups:", filtered.length);
  console.log("");

  // For each untracked token, resolve market name and check if any arb trade matches
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const [tokenId, data] of filtered) {
    let name = "?";
    let slug = "?";
    let allTokensInMarket: { token_id: string; outcome: string }[] = [];

    try {
      const resp = await fetch(
        "https://gamma-api.polymarket.com/markets?clob_token_ids=" + tokenId
      );
      const markets = (await resp.json()) as any[];
      const mkt = markets[0];
      if (mkt) {
        name = mkt.question || "UNKNOWN";
        slug = mkt.slug || "?";
        allTokensInMarket = mkt.tokens || [];
      }
      await delay(80);
    } catch {}

    // Skip non-esports/non-tennis (politics, crypto, macro)
    const isEsportsTennis =
      /counter-strike|valorant|lol:|dota|esport|tennis|open:|match|game \d|map \d|bo[135]|atp|wta|bnp|chile|merida|mexican/i.test(
        name
      );
    if (!isEsportsTennis) continue;

    // Find matching arb trades by name similarity
    const nameWords = name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/);
    const matchingTrades = trades.filter((t) => {
      const tWords = t.match
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/);
      // Count matching words
      const common = nameWords.filter((w) => w.length > 2 && tWords.includes(w));
      return common.length >= 2;
    });

    // Check if any other token in same market is tracked
    const siblingTokens = allTokensInMarket.filter(
      (t) => t.token_id !== tokenId
    );
    const trackedSiblings = siblingTokens.filter((t) =>
      knownTokens.has(t.token_id)
    );
    const thisOutcome =
      allTokensInMarket.find((t) => t.token_id === tokenId)?.outcome ?? "?";

    // Check if this token has fills that are also tracked (same token, different fills)
    const trackedOnSameToken = allByToken.get(tokenId);

    console.log("=".repeat(100));
    console.log(
      `MARKET: ${name.slice(0, 90)}`
    );
    console.log(
      `  Token: ${tokenId.slice(0, 30)}... | Outcome: ${thisOutcome} | Slug: ${slug}`
    );
    console.log(
      `  Untracked fills: ${Math.round(data.totalBought)} shares, $${data.totalCost.toFixed(2)} (${data.fills.length} fills)`
    );

    if (trackedSiblings.length > 0) {
      console.log(
        `  SIBLING TOKEN TRACKED: ${trackedSiblings.map((t) => t.outcome + " (" + t.token_id.slice(0, 15) + "...)").join(", ")}`
      );
      // Find which arb trades use the sibling
      for (const sib of trackedSiblings) {
        const sibTrades = trades.filter((t) => t.pmTokenId === sib.token_id);
        for (const st of sibTrades) {
          console.log(
            `    -> Arb trade: ${st.id} | ${st.match} | ${st.shares} shares | pmCost=$${st.pmCost} | status=${st.status} | dir=${st.dir}`
          );
        }
      }
    }

    if (matchingTrades.length > 0) {
      console.log(`  MATCHING ARB TRADES (by name):`);
      for (const mt of matchingTrades) {
        const isSameToken = mt.pmTokenId === tokenId;
        const isSibToken = siblingTokens.some(
          (s) => s.token_id === mt.pmTokenId
        );
        console.log(
          `    -> ${mt.id} | ${mt.match} | ${mt.shares} shares | pmToken=${mt.pmTokenId?.slice(0, 15) ?? "none"}... | pmCost=$${mt.pmCost} | status=${mt.status} | dir=${mt.dir} | ${isSameToken ? "SAME TOKEN" : isSibToken ? "SIBLING TOKEN" : "DIFF TOKEN"}`
        );
      }
    }

    if (matchingTrades.length === 0 && trackedSiblings.length === 0) {
      console.log(`  [!] NO MATCHING ARB TRADE FOUND -- likely crash before logging`);
    }

    // Show fill timestamps for context
    const sortedFills = data.fills.sort(
      (a: any, b: any) =>
        new Date(a.created_at || a.match_time || 0).getTime() -
        new Date(b.created_at || b.match_time || 0).getTime()
    );
    if (sortedFills.length <= 5) {
      for (const f of sortedFills) {
        const ts = f.created_at || f.match_time || "?";
        console.log(
          `    Fill: ${Number(f.size).toFixed(1)} @ $${Number(f.price).toFixed(3)} | ${ts}`
        );
      }
    } else {
      const first = sortedFills[0];
      const last = sortedFills[sortedFills.length - 1];
      console.log(
        `    ${sortedFills.length} fills from ${first.created_at || first.match_time || "?"} to ${last.created_at || last.match_time || "?"}`
      );
    }
    console.log("");
  }
}

main().catch((e) => console.error("ERROR:", e));
