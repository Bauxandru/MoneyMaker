import dotenv from "dotenv";
import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "./polyAuth.js";

dotenv.config();

function env(name: string) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing ${name} in .env.`);
  }
  return value.trim();
}

function parseServerTime(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const candidates = [
      obj.serverTime,
      obj.server_time,
      (obj.data as Record<string, unknown> | undefined)?.serverTime,
      (obj.data as Record<string, unknown> | undefined)?.server_time,
      obj.timestamp,
      obj.ts
    ];
    for (const c of candidates) {
      const parsed = parseServerTime(c);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function extractError(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const obj = res as Record<string, unknown>;
  if (typeof obj.error === "string") {
    if (typeof obj.status === "number") {
      return `${obj.error} (status ${obj.status})`;
    }
    return obj.error;
  }
  if (typeof obj.status === "number" && obj.status >= 400) {
    return `HTTP ${obj.status}`;
  }
  return null;
}

async function main() {
  const privateKey = env("POLY_WALLET_PRIVATE_KEY");

  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);

  const creds = await resolvePolyApiCreds({
    host,
    chainId,
    sigType,
    wallet
  });

  const client = new ClobClient(
    host,
    chainId,
    wallet,
    creds,
    sigType,
    process.env.POLY_FUNDER || undefined
  );

  try {
    const serverTime = await client.getServerTime();
    const local = Math.floor(Date.now() / 1000);
    const serverEpoch = parseServerTime(serverTime);
    if (serverEpoch !== null) {
      const delta = serverEpoch - local;
      if (Number.isFinite(delta) && Math.abs(delta) > 30) {
        console.warn(`[WARN] Clock skew vs server is ~${delta}s. L2 signatures are time-bound.`);
      }
    } else {
      console.warn("[WARN] Could not parse server time response; skipping clock skew check.");
    }
  } catch (err) {
    console.warn(`[WARN] Could not fetch server time: ${(err as Error).message}`);
  }

  try {
    const res = await client.getApiKeys();
    const apiErr = extractError(res);
    if (apiErr) {
      throw new Error(apiErr);
    }
    console.log("[OK] Polymarket L2 auth valid.");
  } catch (err) {
    const message = (err as Error).message || String(err);
    console.error(`[ERROR] Polymarket L2 auth failed: ${message}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
