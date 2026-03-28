import dotenv from "dotenv";
import { Contract, JsonRpcProvider, MaxUint256, Wallet as WalletV6 } from "ethers";
import { Wallet as WalletV5 } from "@ethersproject/wallet";
import { AssetType, ClobClient } from "@polymarket/clob-client";
import { resolvePolyApiCreds } from "./polyAuth.js";

dotenv.config();

const DEFAULT_EXCHANGES = [
  // Polymarket exchange contracts (Polygon)
  "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296"
];

const DEFAULT_USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const DEFAULT_CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const ERC1155_ABI = [
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)"
];

function parseMode(raw: string | undefined) {
  const mode = (raw ?? "collateral").trim().toLowerCase();
  if (mode === "collateral" || mode === "conditional" || mode === "both") return mode;
  throw new Error('POLY_APPROVE_MODE must be "collateral", "conditional", or "both".');
}

function readList(raw: string | undefined, fallback: string[]) {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

async function approveCollateral(
  usdc: Contract,
  owner: string,
  spender: string
) {
  const current: bigint = await usdc.allowance(owner, spender);
  if (current === MaxUint256) {
    console.log(`[SKIP] USDC allowance already max for ${spender}`);
    return;
  }
  const tx = await usdc.approve(spender, MaxUint256);
  console.log(`[TX] USDC approve ${spender} -> ${tx.hash}`);
  await tx.wait();
  console.log(`[OK] USDC allowance set for ${spender}`);
}

async function approveConditional(ctf: Contract, owner: string, spender: string) {
  const approved: boolean = await ctf.isApprovedForAll(owner, spender);
  if (approved) {
    console.log(`[SKIP] CTF approval already set for ${spender}`);
    return;
  }
  const tx = await ctf.setApprovalForAll(spender, true);
  console.log(`[TX] CTF setApprovalForAll ${spender} -> ${tx.hash}`);
  await tx.wait();
  console.log(`[OK] CTF approval set for ${spender}`);
}

async function refreshClobAllowance(
  privateKey: string,
  approveMode: "collateral" | "conditional" | "both"
) {
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const v5Wallet = new WalletV5(privateKey);
  const creds = await resolvePolyApiCreds({
    host,
    chainId,
    sigType,
    wallet: v5Wallet
  });
  const funder = process.env.POLY_FUNDER || v5Wallet.address;
  const client = new ClobClient(host, chainId, v5Wallet, creds, sigType, funder);

  await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  if (approveMode !== "collateral") {
    const tokenId = process.env.POLY_CONDITIONAL_TOKEN_ID;
    if (tokenId && tokenId.trim()) {
      await client.updateBalanceAllowance({
        asset_type: AssetType.CONDITIONAL,
        token_id: tokenId.trim()
      });
    }
  }
}

async function main() {
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Missing POLY_WALLET_PRIVATE_KEY in .env.");
  }

  const rpcUrl = process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Missing POLY_RPC_URL (or POLYGON_RPC_URL).");
  }

  const approveMode = parseMode(process.env.POLY_APPROVE_MODE);
  const exchanges = readList(process.env.POLY_EXCHANGE_ADDRESSES, DEFAULT_EXCHANGES);
  if (!exchanges.length) {
    throw new Error("No exchange addresses configured for allowance approvals.");
  }

  const usdcAddress = process.env.POLY_USDC_ADDRESS ?? DEFAULT_USDC;
  const ctfAddress = process.env.POLY_CTF_ADDRESS ?? DEFAULT_CTF;

  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const provider = new JsonRpcProvider(rpcUrl, chainId);
  const wallet = new WalletV6(privateKey, provider);
  const owner = await wallet.getAddress();

  const usdc = new Contract(usdcAddress, ERC20_ABI, wallet);
  const ctf = new Contract(ctfAddress, ERC1155_ABI, wallet);

  console.log(`[INFO] Owner: ${owner}`);
  console.log(`[INFO] Approve mode: ${approveMode}`);
  console.log(`[INFO] Exchanges: ${exchanges.join(", ")}`);

  for (const spender of exchanges) {
    if (approveMode === "collateral" || approveMode === "both") {
      await approveCollateral(usdc, owner, spender);
    }
    if (approveMode === "conditional" || approveMode === "both") {
      await approveConditional(ctf, owner, spender);
    }
  }

  const refresh = (process.env.POLY_REFRESH_ALLOWANCE ?? "true").toLowerCase() !== "false";
  if (refresh) {
    try {
      await refreshClobAllowance(privateKey, approveMode);
      console.log("[OK] CLOB balance/allowance refreshed.");
    } catch (err) {
      console.warn(
        `[WARN] Could not refresh CLOB balance/allowance: ${(err as Error).message}`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
