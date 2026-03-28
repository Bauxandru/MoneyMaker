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
  const pmFills = (await client.getTrades()) as any[];

  // Show sample match_time values
  console.log("PM sample match_time:", pmFills.slice(0, 5).map((f: any) => f.match_time));
  console.log("PM sample created_at:", pmFills.slice(0, 5).map((f: any) => f.created_at));

  // Check what format match_time is
  const mt0 = pmFills[0]?.match_time;
  console.log("\nFirst match_time raw:", mt0, "type:", typeof mt0);
  console.log("As number:", Number(mt0));
  console.log("As date:", new Date(Number(mt0) * 1000).toISOString());

  // Test cutoff filter
  const cutoff = "2026-03-14";
  const cutoffEpoch = new Date(cutoff).getTime() / 1000;
  console.log("\nCutoff epoch:", cutoffEpoch);

  const after = pmFills.filter((f: any) => {
    const mt = Number(f.match_time);
    if (mt > 1000000000) return mt >= cutoffEpoch;
    return f.match_time >= cutoff;
  });
  console.log("PM fills after cutoff:", after.length, "/", pmFills.length);
}
main().catch(e => console.error(e));
