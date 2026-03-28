import dotenv from "dotenv";
dotenv.config();
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";

async function main() {
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  console.log("Wallet address:", wallet.address);
  console.log("Funder:", funder);
  console.log("");

  const pmFills = (await client.getTrades()) as any[];
  console.log("Total fills returned by getTrades():", pmFills.length);
  console.log("");

  // Show raw structure of first fill
  console.log("=== Sample fill (first one) ===");
  console.log(JSON.stringify(pmFills[0], null, 2));
  console.log("");

  // Check: are these all OUR trades? Look at maker_address / taker fields
  const makers = new Set<string>();
  const takers = new Set<string>();
  const owners = new Set<string>();
  for (const f of pmFills) {
    if (f.maker_address) makers.add(f.maker_address.toLowerCase());
    if (f.taker_address) takers.add(f.taker_address.toLowerCase());
    if (f.owner) owners.add(f.owner.toLowerCase());
    if (f.trader) owners.add(f.trader.toLowerCase());
  }
  console.log("Unique maker addresses:", [...makers]);
  console.log("Unique taker addresses:", [...takers]);
  console.log("Unique owner/trader:", [...owners]);
  console.log("");

  // Look at the suspicious large fills
  const largeFills = pmFills
    .filter((f: any) => f.side === "BUY" && f.status === "CONFIRMED")
    .filter((f: any) => Number(f.size) > 100)
    .sort((a: any, b: any) => Number(b.size) - Number(a.size));

  console.log("=== Large BUY fills (>100 shares) ===");
  for (const f of largeFills.slice(0, 20)) {
    const walletLower = wallet.address.toLowerCase();
    const funderLower = funder?.toLowerCase();
    const isMaker = f.maker_address?.toLowerCase() === walletLower || f.maker_address?.toLowerCase() === funderLower;
    const isTaker = f.taker_address?.toLowerCase() === walletLower || f.taker_address?.toLowerCase() === funderLower;
    console.log(
      `  ${Number(f.size).toFixed(0).padStart(7)} shares @ $${Number(f.price).toFixed(3)} = $${(Number(f.size) * Number(f.price)).toFixed(2).padStart(10)} | ` +
      `side=${f.side} | maker=${f.maker_address?.slice(0,10)}... | ` +
      `weAreMaker=${isMaker} weAreTaker=${isTaker} | ` +
      `asset=${f.asset_id?.slice(0,15)}... | ${f.match_time || f.created_at || '?'}`
    );
  }

  // Check: does getTrades() return OTHER people's trades too?
  // Look at the 3DMAX vs SemperFi fill specifically
  const threeDmax = pmFills.filter((f: any) =>
    f.asset_id?.startsWith("34375011738512928172") && f.side === "BUY"
  );
  console.log("\n=== 3DMAX vs SemperFi fills ===");
  for (const f of threeDmax) {
    console.log(JSON.stringify(f, null, 2));
  }
}

main().catch((e) => console.error("ERROR:", e));
