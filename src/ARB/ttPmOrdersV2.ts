/**
 * ttPmOrdersV2.ts — Polymarket CLOB V2 adapter.
 *
 * V2 MIGRATION (live 2026-04-22 ~11:00 UTC):
 *   - New package:     @polymarket/clob-client-v2 (already installed)
 *   - Collateral:      USDC.e → pUSD (wrap via CollateralOnramp 0x93070a847efEf7F70739046A929D47a521F5B8ee)
 *   - New exchange:    CTF Exchange V2 + Neg Risk CTF Exchange V2
 *   - Order struct:    REMOVED nonce/feeRateBps/taker, ADDED timestamp(ms)/metadata/builder
 *   - EIP-712 domain:  v1 → v2 (ClobAuth stays v1)
 *   - Test host:       https://clob-v2.polymarket.com (before Apr 22)
 *   - Post-cutover:    https://clob.polymarket.com (V2 takes over)
 *
 * This module mirrors the V1 ttPmOrders.ts public API so existing callers in
 * ttExecution.ts / ttHedge.ts can switch by swapping one import. Flip via env:
 *   PM_API_VERSION=v2   → routes through this module
 *   unset / v1          → routes through ttPmOrders.ts (legacy)
 *
 * NOT YET WIRED into the main bot — this is PREP work. The bot continues
 * using V1 (ttPmOrders.ts) until we flip the import on Apr 22 cutover day.
 *
 * Module-level mutable state:
 *   _pmClientCacheV2 — cached V2 ClobClient instance (30min TTL)
 */

import { ClobClient, OrderType, Side, Chain } from "@polymarket/clob-client-v2";
import { Wallet } from "@ethersproject/wallet";
import { resolvePolyApiCreds } from "../polyAuth.js";

// --- V2 client factory ----------------------------------------------------

let _pmClientCacheV2: { client: ClobClient; createdAt: number } | null = null;
const PM_CLIENT_TTL = 30 * 60_000;

export async function createPmClientV2(): Promise<{ client: ClobClient; createdAt: number }> {
  if (_pmClientCacheV2 && Date.now() - _pmClientCacheV2.createdAt < PM_CLIENT_TTL) {
    return _pmClientCacheV2;
  }
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("Missing POLY_WALLET_PRIVATE_KEY");
  // Prefer the new V2 host during testing; after Apr 22 cutover the main host
  // transparently becomes V2 so either POLY_CLOB_URL value still works.
  const host = process.env.POLY_CLOB_URL_V2 ?? process.env.POLY_CLOB_URL ?? "https://clob-v2.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  // Chain enum in V2: Chain.POLYGON = 137, Chain.AMOY = 80002
  const chain = chainId as Chain;
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);
  const funder = process.env.POLY_FUNDER || wallet.address;
  // ClobSigner accepts EthersSigner OR viem WalletClient. Our ethers Wallet
  // implements _signTypedData + getAddress, so it satisfies EthersSigner.
  const creds = await resolvePolyApiCreds({ host, chainId, sigType, wallet });
  _pmClientCacheV2 = {
    client: new ClobClient({
      host,
      chain,
      signer: wallet as any,
      creds,
      signatureType: sigType as any,
      funderAddress: funder,
    }),
    createdAt: Date.now(),
  };
  return _pmClientCacheV2;
}

// --- V2 order placement helpers -------------------------------------------
// Mirrors the V1 ttPmOrders signatures so other modules can swap imports
// without changing call sites. Key V2 differences:
//   - createAndPostOrder replaces V1's createOrder + postOrder
//   - Market orders (FAK/FOK) now use createAndPostMarketOrder w/ `amount`
//     (USDC for BUY, shares for SELL) instead of `size` (always shares in V1)
//   - No more feeRateBps / nonce / taker in the user order
//   - Builder attribution via `builderConfig` on client, or `builderCode` per order
//     (see https://docs.polymarket.com/builders/overview)

export async function placePmFAKv2(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) { console.log(`  [DRY][V2] placePmFAK ${shares}x${tokenId.slice(0, 10)}...@${price}`); return { dryRun: true }; }
  const { client } = await createPmClientV2();
  // V2 market order: for BUY, `amount` = USDC to spend (shares * price)
  // FAK = Fill-And-Kill = fills as much as possible, cancels remainder.
  // We keep this aligned with V1 behavior — same contract, same risk profile.
  const amount = shares * price;
  return client.createAndPostMarketOrder(
    { tokenID: tokenId, amount, side: Side.BUY, orderType: OrderType.FAK } as any,
    { tickSize: String(tickSize), negRisk } as any,
    OrderType.FAK,
  );
}

export async function placePmFAKSellv2(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) { console.log(`  [DRY][V2] placePmFAKSell ${shares}x${tokenId.slice(0, 10)}...@${price}`); return { dryRun: true }; }
  const { client } = await createPmClientV2();
  // V2 market SELL: `amount` = shares to sell (not USDC).
  return client.createAndPostMarketOrder(
    { tokenID: tokenId, amount: shares, side: Side.SELL, orderType: OrderType.FAK } as any,
    { tickSize: String(tickSize), negRisk } as any,
    OrderType.FAK,
  );
}

export async function placePmGTCBidv2(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) { console.log(`  [DRY][V2] placePmGTCBid ${shares}x${tokenId.slice(0, 10)}...@${price}`); return { dryRun: true }; }
  const { client } = await createPmClientV2();
  return client.createAndPostOrder(
    { tokenID: tokenId, price, side: Side.BUY, size: shares } as any,
    { tickSize: String(tickSize), negRisk } as any,
    OrderType.GTC,
  );
}

export async function placePmGTCAskv2(
  tokenId: string,
  price: number,
  shares: number,
  tickSize: number,
  negRisk: boolean,
  dryRun: boolean
): Promise<unknown> {
  if (dryRun) { console.log(`  [DRY][V2] placePmGTCAsk ${shares}x${tokenId.slice(0, 10)}...@${price}`); return { dryRun: true }; }
  const { client } = await createPmClientV2();
  return client.createAndPostOrder(
    { tokenID: tokenId, price, side: Side.SELL, size: shares } as any,
    { tickSize: String(tickSize), negRisk } as any,
    OrderType.GTC,
  );
}

export async function cancelPmOrderV2(orderId: string, dryRun: boolean): Promise<void> {
  if (dryRun) { console.log(`  [DRY][V2] cancelPmOrder ${orderId}`); return; }
  const { client } = await createPmClientV2();
  await client.cancelOrder({ orderID: orderId } as any);
}

/** List currently-live PM BUY orders on a tokenId. Same semantics as V1 helper. */
export async function getOpenPmBuyOrdersForTokenV2(
  tokenId: string
): Promise<Array<{ orderId: string; price: number; size: number }>> {
  try {
    const { client } = await createPmClientV2();
    const resp = await client.getOpenOrders({ asset_id: tokenId } as any);
    // V2 returns OpenOrdersResponse { orders, next_cursor }. V1 returned raw array.
    const arr = (resp as any)?.orders ?? (Array.isArray(resp) ? resp : []);
    return arr
      .filter((o: any) => String(o?.side ?? "").toUpperCase() === "BUY")
      .map((o: any) => ({
        orderId: String(o.id ?? o.orderID ?? ""),
        price: Number(o.price ?? 0),
        size: Number(o.size ?? o.original_size ?? 0),
      }))
      .filter((o: any) => !!o.orderId);
  } catch { return []; }
}

// --- Unresolved V2 gaps (TODO before Apr 22 cutover) ----------------------
//
// 1. pUSD collateral wrapping/unwrapping
//    - BEFORE first V2 trade, existing USDC.e funder balance must be wrapped
//      to pUSD via CollateralOnramp.wrap() at 0x93070a847efEf7F70739046A929D47a521F5B8ee
//    - polyChain.ts currently reads USDC.e balance. Add a new read for pUSD
//      balance on the funder. Update getUsdcBalance() to prefer pUSD under V2.
//    - Unwrap path needed for withdrawals (not hot-path; manual only).
//
// 2. Builder attribution (optional, for fee rebates)
//    - See Settings → Builder dashboard for builderCode.
//    - Attach via builderConfig on ClobClient constructor or builderCode per order.
//
// 3. getPmOrderFills equivalent
//    - V1 used /order/{id} endpoint to poll fill status.
//    - V2 may have a different endpoint name; TBD (test against clob-v2.polymarket.com).
//
// 4. Post-migration data-api token IDs
//    - Current data-api.polymarket.com/positions returns CTF token IDs — unchanged
//      by V2 (ConditionalTokens contract didn't change). Our on-chain balance
//      queries via polyChain.ts continue to work without changes.
//
// 5. Event log / WS feeds
//    - PM WebSocket feed URL + auth may change. Re-verify ttWebSocket.ts PM
//      connection logic against V2 docs.
//
// Testing plan:
//   - Point POLY_CLOB_URL=https://clob-v2.polymarket.com before Apr 22
//   - Run tmp_test_pm_v2_min.ts (to be written) — small buy + sell against V2
//   - Verify order matches + on-chain fill arrives on new pUSD collateral path
