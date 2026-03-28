import dotenv from "dotenv";
dotenv.config();
import { Wallet } from "@ethersproject/wallet";
import { ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";

const mwToken = "112322018357526834859700464391179829707565101189304210843630272088404644364147";
const b2bToken = "58372017685980635646784362638300423909987201684642588122185701032502552065402";

async function main() {
  const pk = process.env.POLY_WALLET_PRIVATE_KEY!;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);

  console.log("Wallet:", wallet.address);
  console.log("Funder:", funder);

  const pmFills = (await (client as any).getTrades()) as any[];
  console.log("Total PM fills from getTrades():", pmFills.length);

  console.log("\n=== MW token (112322...) fills ===");
  const mwFills = pmFills.filter((f: any) => f.asset_id === mwToken);
  console.log("Count:", mwFills.length);
  for (const f of mwFills) {
    console.log(`  ${f.side} ${f.size} @ $${Number(f.price).toFixed(3)} status=${f.status} ts=${f.match_time ?? f.created_at ?? "?"}`);
    console.log(`    maker=${f.maker_address ?? "?"}`);
    console.log(`    taker=${f.taker_address ?? "?"}`);
    console.log(`    raw: ${JSON.stringify(f)}`);
  }

  console.log("\n=== B2B token (58372...) fills ===");
  const b2bFills = pmFills.filter((f: any) => f.asset_id === b2bToken);
  console.log("Count:", b2bFills.length);
  for (const f of b2bFills) {
    console.log(`  ${f.side} ${f.size} @ $${Number(f.price).toFixed(3)} status=${f.status} ts=${f.match_time ?? f.created_at ?? "?"}`);
    console.log(`    maker=${f.maker_address ?? "?"}`);
    console.log(`    taker=${f.taker_address ?? "?"}`);
  }
}

main().catch(e => console.error("ERR:", e));
