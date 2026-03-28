/**
 * polyChain.ts — On-chain Polygon interactions for Polymarket CTF tokens.
 *
 * Provides:
 *   1. getOnChainBalance(tokenId)       — instant fill verification via balanceOf
 *   2. scanTransferHistory(tokenId, ...) — historical PM fill verification
 *   3. subscribeToFills(callback)        — real-time fill notifications via WSS
 *   4. subscribeToSettlements(callback)  — real-time settlement detection via WSS
 *   5. getChainStatus()                  — dashboard status reporting
 *
 * All functions fail gracefully — never block trading if RPC is down.
 */

import { Contract, JsonRpcProvider, WebSocketProvider, ethers, type Log } from "ethers";

/** Safely convert a bigint token amount (1e6 decimals) to a JS number without precision loss. */
function bigintToShares(raw: bigint): number {
  const whole = raw / 1_000_000n;
  const frac = Number(raw % 1_000_000n) / 1e6;
  return Number(whole) + frac;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

// Human-readable ABI fragments (same pattern as approvePolyAllowance.ts)
const CTF_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)",
];

const TRANSFER_SINGLE_TOPIC = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

// ─── Provider management (singletons) ─────────────────────────────────────────

let _httpProvider: JsonRpcProvider | null = null;
let _wssProvider: WebSocketProvider | null = null;
let _ctfContract: Contract | null = null;
let _walletAddress: string | null = null;

const POLYGON_RPC_FALLBACKS = [
  "https://polygon-mainnet.infura.io/v3/2edd1ab9f156476d9408fa798a0ed5ce",
  "https://polygon.drpc.org",
  "https://polygon-bor-rpc.publicnode.com",
  "https://1rpc.io/matic",
  "https://polygon.gateway.tenderly.co",
];

export function getPolygonProvider(): JsonRpcProvider {
  if (_httpProvider) return _httpProvider;
  const rpcUrl = process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL || POLYGON_RPC_FALLBACKS[0];
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  _httpProvider = new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  return _httpProvider;
}

/**
 * Try getOnChainBalance with the current provider. If it fails, cycle through
 * fallback RPCs and retry once with a fresh provider.
 */
export async function getOnChainBalanceWithFallback(tokenId: string): Promise<number> {
  const result = await getOnChainBalance(tokenId);
  if (result >= 0) return result;

  // Primary RPC failed — try fallbacks
  const currentUrl = process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL || POLYGON_RPC_FALLBACKS[0];
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  for (const fallback of POLYGON_RPC_FALLBACKS) {
    if (fallback === currentUrl) continue;
    try {
      console.log(`  [CHAIN] Trying fallback RPC: ${fallback}`);
      const provider = new JsonRpcProvider(fallback, chainId, { staticNetwork: true });
      const ctf = getCTFContract(provider);
      const wallet = getWalletAddress();
      const rawBalance: bigint = await ctf.balanceOf(wallet, BigInt(tokenId));
      const shares = bigintToShares(rawBalance);
      // This fallback works — adopt it as the primary provider
      _httpProvider = provider;
      _ctfContract = null; // reset so it picks up new provider
      console.log(`  [CHAIN] Fallback RPC ${fallback} succeeded. Adopting as primary.`);
      return Math.round(shares);
    } catch {
      continue;
    }
  }
  return -1; // all RPCs failed
}

function getWssProvider(): WebSocketProvider | null {
  if (_wssProvider) return _wssProvider;
  const wssUrl = process.env.POLYGON_WSS_URL;
  if (!wssUrl) return null;
  try {
    const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
    _wssProvider = new WebSocketProvider(wssUrl, chainId);
    // ethers v6 WebSocketLike doesn't expose .on() — cast to EventTarget-like
    const ws = _wssProvider.websocket as unknown as { on(ev: string, fn: (...args: unknown[]) => void): void };
    if (typeof ws.on === "function") {
      ws.on("error", (err: unknown) => {
        console.error("[CHAIN] WSS error:", (err as Error).message ?? err);
        if (_wssProvider) { try { _wssProvider.destroy(); } catch {} }
        _wssProvider = null;
      });
      ws.on("close", () => {
        console.warn("[CHAIN] WSS disconnected — will reconnect on next use.");
        if (_wssProvider) { try { _wssProvider.destroy(); } catch {} }
        _wssProvider = null;
      });
    }
    return _wssProvider;
  } catch (err) {
    console.warn(`[CHAIN] WSS connection failed: ${(err as Error).message}`);
    return null;
  }
}

function getCTFContract(provider?: JsonRpcProvider | WebSocketProvider): Contract {
  if (!provider && _ctfContract) return _ctfContract;
  const p = provider ?? getPolygonProvider();
  const contract = new Contract(CTF_ADDRESS, CTF_ABI, p);
  if (!provider) _ctfContract = contract;
  return contract;
}

function getWalletAddress(): string {
  if (_walletAddress) return _walletAddress;
  const funder = process.env.POLY_FUNDER;
  if (funder) { _walletAddress = funder; return funder; }
  const pk = process.env.POLY_WALLET_PRIVATE_KEY ?? "";
  if (!pk) throw new Error("Cannot derive wallet address: POLY_FUNDER and POLY_WALLET_PRIVATE_KEY are both unset.");
  _walletAddress = ethers.computeAddress(pk);
  return _walletAddress;
}

// ─── Feature 1 + 5: On-chain balance check ───────────────────────────────────

/**
 * Get exact share count for a PM conditional token via on-chain balanceOf.
 * Returns -1 on RPC failure (caller must handle fallback).
 * Polymarket CTF tokens use 1e6 precision (USDC-matching).
 */
export async function getOnChainBalance(tokenId: string): Promise<number> {
  try {
    const wallet = getWalletAddress();
    const ctf = getCTFContract();
    const rawBalance: bigint = await ctf.balanceOf(wallet, BigInt(tokenId));
    const shares = bigintToShares(rawBalance);
    return Math.round(shares);
  } catch (err) {
    console.error(`[CHAIN] balanceOf failed: ${(err as Error).message}`);
    return -1;
  }
}

// ─── Feature 2: Historical transfer scanning ─────────────────────────────────

export type ChainTransfer = {
  block: number;
  txHash: string;
  tokenId: string;
  shares: number;
  direction: "IN" | "OUT";
};

/**
 * Scan on-chain TransferSingle events for a specific token to/from our wallet.
 * Uses 9999-block chunks to stay within free RPC limits.
 */
export async function scanTransferHistory(
  tokenId: string,
  fromBlock: number,
  toBlock?: number
): Promise<ChainTransfer[]> {
  const provider = getPolygonProvider();
  const wallet = getWalletAddress().toLowerCase();
  const walletPadded = "0x" + "0".repeat(24) + wallet.replace("0x", "");

  if (!toBlock) toBlock = await provider.getBlockNumber();

  const results: ChainTransfer[] = [];
  const CHUNK = 9999;

  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK, toBlock);
    try {
      const [inLogs, outLogs] = await Promise.all([
        provider.getLogs({
          address: CTF_ADDRESS, fromBlock: from, toBlock: to,
          topics: [TRANSFER_SINGLE_TOPIC, null, null, walletPadded],
        }),
        provider.getLogs({
          address: CTF_ADDRESS, fromBlock: from, toBlock: to,
          topics: [TRANSFER_SINGLE_TOPIC, null, walletPadded, null],
        }),
      ]);

      for (const log of [...inLogs, ...outLogs]) {
        const raw = log.data.slice(2);
        const logTokenId = BigInt("0x" + raw.slice(0, 64)).toString();
        if (logTokenId !== tokenId) continue;
        const qty = bigintToShares(BigInt("0x" + raw.slice(64, 128)));
        const isIn = inLogs.includes(log);
        results.push({
          block: log.blockNumber, txHash: log.transactionHash,
          tokenId: logTokenId, shares: qty, direction: isIn ? "IN" : "OUT",
        });
      }
    } catch (err) {
      console.warn(`[CHAIN] Log scan ${from}..${to} failed: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 200));
  }

  return results.sort((a, b) => a.block - b.block);
}

// ─── Feature 3: Real-time fill notifications ─────────────────────────────────

export type FillCallback = (tokenId: string, shares: number, txHash: string, block: number) => void;

let _fillSubscriptionActive = false;

/**
 * Subscribe to TransferSingle events TO our wallet via WebSocket.
 * Returns an unsubscribe function. No-op if POLYGON_WSS_URL not set.
 */
export async function subscribeToFills(callback: FillCallback): Promise<() => void> {
  const provider = getWssProvider();
  if (!provider) {
    console.warn("[CHAIN] No POLYGON_WSS_URL — fill subscription unavailable.");
    return () => {};
  }

  const walletPadded = "0x" + "0".repeat(24) + getWalletAddress().toLowerCase().replace("0x", "");

  const filter = {
    address: CTF_ADDRESS,
    topics: [TRANSFER_SINGLE_TOPIC, null, null, walletPadded],
  };

  const handler = (log: Log) => {
    try {
      const raw = log.data.slice(2);
      const tokenId = BigInt("0x" + raw.slice(0, 64)).toString();
      const shares = bigintToShares(BigInt("0x" + raw.slice(64, 128)));
      callback(tokenId, Math.round(shares), log.transactionHash, log.blockNumber);
    } catch (err) {
      console.error(`[CHAIN] Fill event parse error: ${(err as Error).message}`);
    }
  };

  provider.on(filter, handler);
  _fillSubscriptionActive = true;
  console.log("[CHAIN] Subscribed to fill events via WSS.");

  return () => {
    provider.off(filter, handler);
    _fillSubscriptionActive = false;
    console.log("[CHAIN] Unsubscribed from fill events.");
  };
}

export function isFillSubscriptionActive(): boolean {
  return _fillSubscriptionActive;
}

// ─── Feature 4: Real-time settlement detection ──────────────────────────────

export type SettlementCallback = (conditionId: string, payoutNumerators: bigint[], block: number) => void;

let _settlementSubscriptionActive = false;

/**
 * Subscribe to ConditionResolution events on the CTF contract via WebSocket.
 * Fires when any PM market resolves (not filtered to our wallet).
 * Returns an unsubscribe function. No-op if POLYGON_WSS_URL not set.
 */
export async function subscribeToSettlements(callback: SettlementCallback): Promise<() => void> {
  const provider = getWssProvider();
  if (!provider) {
    console.warn("[CHAIN] No POLYGON_WSS_URL — settlement subscription unavailable.");
    return () => {};
  }

  const CONDITION_RESOLUTION_TOPIC = ethers.id(
    "ConditionResolution(bytes32,address,bytes32,uint256,uint256[])"
  );

  const filter = {
    address: CTF_ADDRESS,
    topics: [CONDITION_RESOLUTION_TOPIC],
  };

  const ctf = getCTFContract(provider);

  const handler = (log: Log) => {
    try {
      const parsed = ctf.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return;
      const conditionId = parsed.args[0] as string;
      const payoutNumerators = parsed.args[4] as bigint[];
      callback(conditionId, payoutNumerators, log.blockNumber);
    } catch (err) {
      console.error(`[CHAIN] Settlement event parse error: ${(err as Error).message}`);
    }
  };

  provider.on(filter, handler);
  _settlementSubscriptionActive = true;
  console.log("[CHAIN] Subscribed to settlement events via WSS.");

  return () => {
    provider.off(filter, handler);
    _settlementSubscriptionActive = false;
  };
}

// ─── USDC balance on Polygon ──────────────────────────────────────────────────

const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_ABI = ["function balanceOf(address account) view returns (uint256)"];

/**
 * Get USDC balance on Polygon for our wallet. Returns dollars, -1 on failure.
 */
export async function getUsdcBalance(): Promise<number> {
  try {
    const provider = getPolygonProvider();
    const wallet = getWalletAddress();
    const usdc = new Contract(USDC_ADDRESS, USDC_ABI, provider);
    const rawBalance: bigint = await usdc.balanceOf(wallet);
    return bigintToShares(rawBalance);
  } catch (err) {
    console.error(`[CHAIN] USDC balance failed: ${(err as Error).message}`);
    return -1;
  }
}

// ─── Dashboard status ─────────────────────────────────────────────────────────

export function getChainStatus() {
  return {
    httpProviderConnected: _httpProvider !== null,
    wssProviderConnected: _wssProvider !== null,
    fillSubscriptionActive: _fillSubscriptionActive,
    settlementSubscriptionActive: _settlementSubscriptionActive,
    rpcUrl: (process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL || "not set").replace(/^(https?:\/\/[^/]+).*/, "$1"),
    wssUrl: process.env.POLYGON_WSS_URL ? "configured" : "not set",
    ctfAddress: CTF_ADDRESS,
    walletAddress: _walletAddress ?? "not initialized",
  };
}
