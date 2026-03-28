import dotenv from "dotenv";
dotenv.config();
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { resolvePolyApiCreds } from "./src/polyAuth.js";

async function main() {
  const pk = process.env.POLY_WALLET_PRIVATE_KEY;
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const funder = process.env.POLY_FUNDER;
  const wallet = new Wallet(pk);
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  const trades = await client.getTrades();

  // Find Bilibili BUY at 09:18
  for (const t of trades) {
    const ts = Number(t.match_time) * 1000;
    if (ts > new Date("2026-03-08T09:17:00Z").getTime() && ts < new Date("2026-03-08T09:20:00Z").getTime()) {
      console.log(`asset_id: ${t.asset_id}`);
      console.log(`size: ${t.size} price: ${t.price} side: ${t.side} status: ${t.status}`);
      console.log(`match_time: ${new Date(ts).toISOString()}`);
      console.log('');
    }
  }

  // Also find JD Gaming BUY at 09:41
  for (const t of trades) {
    const ts = Number(t.match_time) * 1000;
    if (ts > new Date("2026-03-08T09:40:00Z").getTime() && ts < new Date("2026-03-08T09:43:00Z").getTime()) {
      console.log(`JD Gaming trade:`);
      console.log(`asset_id: ${t.asset_id}`);
      console.log(`size: ${t.size} price: ${t.price} side: ${t.side} status: ${t.status}`);
      console.log(`match_time: ${new Date(ts).toISOString()}`);
      console.log('');
    }
  }
}
main().catch(console.error);
