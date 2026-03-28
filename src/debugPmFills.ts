/**
 * Debug: show raw CLOB fills for specific tokens to verify fill sizes.
 */
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

  const ourAddresses = new Set<string>();
  ourAddresses.add(wallet.address.toLowerCase());
  if (funder) ourAddresses.add(funder.toLowerCase());
  console.log("Our addresses:", [...ourAddresses]);

  const pmFills = (await client.getTrades()) as any[];
  console.log(`Total fills: ${pmFills.length}\n`);

  // Check these suspicious tokens
  const suspectTokens = [
    "9427988285070694243363216955807671252633",  // Cobolli 1930 shares
    "3734411412549068243759047494707693435151",  // Liquid 332 shares
    "9773451544613130955866329981349344138225",  // OG 222 shares
    "6701010720441640513983478412608972989926",  // Heroic 108 shares
  ];

  for (const tokenId of suspectTokens) {
    const fills = pmFills.filter(
      (f: any) => f.asset_id === tokenId && f.side === "BUY" && f.status === "CONFIRMED"
    );
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Token: ${tokenId.slice(0, 40)}...`);
    console.log(`Total BUY fills: ${fills.length}`);

    let rawTotal = 0;
    let correctedTotal = 0;
    let correctedCost = 0;

    for (const f of fills) {
      const rawSize = Number(f.size);
      const price = Number(f.price);
      rawTotal += rawSize;

      console.log(`\n  Fill: rawSize=${rawSize} price=${price} trader_side=${f.trader_side}`);
      console.log(`    maker_address=${f.maker_address}`);

      if (f.trader_side === "MAKER" && f.maker_orders && f.maker_orders.length > 0) {
        console.log(`    maker_orders (${f.maker_orders.length}):`);
        let fillFromUs = 0;
        for (const mo of f.maker_orders) {
          const isOurs = ourAddresses.has(mo.maker_address.toLowerCase());
          const moSize = Number(mo.matched_amount);
          console.log(
            `      addr=${mo.maker_address.slice(0, 12)}... amount=${moSize} ${isOurs ? "<<< OURS" : ""}`
          );
          if (isOurs) {
            fillFromUs += moSize;
          }
        }
        correctedTotal += fillFromUs;
        correctedCost += fillFromUs * price;
        console.log(`    Our fill from maker_orders: ${fillFromUs} (vs raw ${rawSize})`);
      } else {
        correctedTotal += rawSize;
        correctedCost += rawSize * price;
        console.log(`    Using raw size (TAKER): ${rawSize}`);
      }
    }

    console.log(`\n  SUMMARY: raw=${rawTotal} corrected=${correctedTotal} cost=$${correctedCost.toFixed(2)}`);
    if (Math.abs(rawTotal - correctedTotal) > 0.1) {
      console.log(`  >>> INFLATION: ${rawTotal} raw vs ${correctedTotal} actual (${(rawTotal/correctedTotal).toFixed(1)}x)`);
    }
  }
}

main().catch((e) => console.error("ERROR:", e));
