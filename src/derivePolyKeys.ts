import dotenv from "dotenv";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

dotenv.config();

async function main() {
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Missing POLY_WALLET_PRIVATE_KEY in .env.");
  }
  const nonceRaw = process.env.POLY_API_NONCE;
  const nonce =
    nonceRaw && nonceRaw.trim().length ? Number(nonceRaw.trim()) : undefined;
  if (nonceRaw && !Number.isFinite(nonce)) {
    throw new Error("POLY_API_NONCE must be a finite number.");
  }
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);

  const client = new ClobClient(host, chainId, wallet, undefined, sigType);
  let creds;
  try {
    creds = await client.createApiKey(nonce);
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.warn(`[WARN] createApiKey failed: ${message}`);
    try {
      creds = await client.deriveApiKey(nonce);
    } catch (deriveErr) {
      const deriveMessage = (deriveErr as Error).message || String(deriveErr);
      if (!nonceRaw) {
        console.error(
          "[ERROR] deriveApiKey failed. Set POLY_API_NONCE to a new integer (e.g. current unix seconds) and retry."
        );
      }
      throw new Error(`deriveApiKey failed: ${deriveMessage}`);
    }
  }

  console.log("POLY_API_KEY=" + creds.key);
  console.log("POLY_API_SECRET=" + creds.secret);
  console.log("POLY_PASSPHRASE=" + creds.passphrase);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
