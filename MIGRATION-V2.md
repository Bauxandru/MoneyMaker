# Polymarket CLOB V2 Migration Plan

**Cutover:** 2026-04-22 ~11:00 UTC (~1h downtime)
**Sources:**
- Discord announcement 2026-04-17 (Danzu | Polymarket)
- https://docs.polymarket.com/changelog (Apr 10 2026 entry)
- https://github.com/Polymarket/clob-client-v2

## Breaking changes

| Area | V1 (current) | V2 (post-Apr-22) |
|---|---|---|
| SDK package | `@polymarket/clob-client` | `@polymarket/clob-client-v2` |
| Collateral | USDC.e | **pUSD** (ERC-20, wraps USDC.e via `CollateralOnramp` at `0x93070a847efEf7F70739046A929D47a521F5B8ee`) |
| Exchange | CTF Exchange V1 / NegRisk V1 | CTF Exchange V2 / NegRisk V2 (addresses TBD from SDK constants) |
| Order struct | `nonce`, `feeRateBps`, `taker` | removed — added `timestamp` (ms), `metadata`, `builder` |
| EIP-712 Exchange domain | `"1"` | `"2"` (ClobAuth stays `"1"`) |
| Constructor | positional `(host, chainId, wallet, creds, sigType, funder)` | options object `{ host, chain, signer, creds, signatureType, funderAddress, builderConfig, ... }` |
| Limit orders | `createOrder()` then `postOrder()` | `createAndPostOrder()` single call |
| Market orders (FAK/FOK) | same `createOrder` with `size` | `createAndPostMarketOrder` — for BUY `amount` is USDC, not shares |
| Fees | per-order `feeRateBps` | set at match time (builders config or per-order `builderCode`) |
| Test host | `clob.polymarket.com` | `clob-v2.polymarket.com` (before Apr 22) — same domain after |
| Open orders | preserved | **wiped at cutover** — all GTCs cancelled |

## Impact on this bot

### Modules affected

| File | V1 state | V2 action |
|---|---|---|
| `src/ARB/ttPmOrders.ts` | wraps v1 `ClobClient` | keep for V1 callers until cutover; will not be called post-flip |
| `src/ARB/ttPmOrdersV2.ts` | **NEW** — wraps v2 `ClobClient` | ready, mirrors V1 public API for drop-in swap |
| `src/polyChain.ts` | reads USDC.e balance at funder | **TODO**: read pUSD balance too (separate contract) |
| `src/polyAuth.ts` | creates API key creds | verify v2 endpoint compatibility (creds may be same, signing domain differs) |
| `package.json` | depends on `@polymarket/clob-client` | **added** `@polymarket/clob-client-v2@1.0.0`, `viem@latest` |

### Not affected

- `ConditionalTokens` at `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` — unchanged. All on-chain share balance queries via `polyChain.getOnChainBalance()` continue to work.
- `data-api.polymarket.com/positions` — unchanged token IDs.
- Kalshi side — fully unaffected.
- WebSocket feeds (`/market`, `/user`) — TBD, need to verify post-cutover.

## Pre-cutover steps (before Apr 22)

1. **Test V2 signing** against `clob-v2.polymarket.com`:
   ```powershell
   $env:POLY_CLOB_URL_V2="https://clob-v2.polymarket.com"
   npx tsx tmp_test_pm_v2.ts
   ```
   (script to be written — small buy + sell via V2 to verify end-to-end)

2. **Check pUSD balance path** — is there a pre-seeded pUSD balance, or do we need to wrap first? Query:
   ```ts
   // pUSD address TBD from v2 SDK config module
   // For now, check via CollateralOnramp's wrapped-supply if our funder has any
   ```

3. **Decide on builderCode** — Polymarket's Builder program offers fee rebates. If we register, pass `builderCode` on orders. Not blocking — can skip and pay standard fees.

## Cutover day (Apr 22)

### T-1h
- Stop bot (Ctrl+C in launcher). All resting PM GTC orders will be cancelled server-side anyway.
- Confirm no in-flight hedge cycle via `data/hedge_state.json` — if sharesHeld > 0 on any, let the cycle complete or accept that those orders will be wiped.

### T+0 (downtime ~1h)
- Wait. No action.

### T+1h (V2 live)
1. **Wrap USDC.e → pUSD** (one-time, manual):
   - Approve `CollateralOnramp` (`0x93070a847efEf7F70739046A929D47a521F5B8ee`) to spend USDC.e at funder address
   - Call `CollateralOnramp.wrap(asset, recipient, amount)` — amount in 6-decimal USDC units
   - Verify pUSD balance appears on funder
   - (Script: `tmp_wrap_usdc_to_pusd.ts` to be written)

2. **Flip the bot to V2**:
   - Edit `src/ARB/ttExecution.ts` + `src/ARB/ttHedge.ts` imports from `./ttPmOrders.js` → `./ttPmOrdersV2.js`
   - Rename V1 functions used: `placePmFAK` → `placePmFAKv2`, etc.
   - OR add a facade wrapper that routes based on `PM_API_VERSION` env
   - Rebuild exe: `npm run build:exe`

3. **Restart bot** — on launch, the hedge cycle will detect the cancelled GTCs (they're gone) and re-place everything at breakeven against V2 contracts with pUSD collateral.

4. **Monitor first hedge-complete** — if P&L sanity-checks (small fees, ~$1 payout per share on settlement), we're done.

### Rollback plan

If V2 is unstable on day 1:
- Revert `ttExecution.ts` + `ttHedge.ts` imports to `./ttPmOrders.js`
- Rebuild exe
- Bot reverts to V1 client. V1 host `clob.polymarket.com` now serves V2 but the SDK contracts don't match — so rollback actually requires V1 endpoint, which is **gone**. **Rollback is not possible** — commit to V2 on cutover day.

This is why we need to test against `clob-v2.polymarket.com` BEFORE Apr 22.

## Things I don't know yet (need docs/testing)

- Exact V2 Exchange contract addresses (embedded in SDK's `config.js`, need to verify)
- Exact pUSD ERC-20 contract address (docs don't state it)
- Whether existing PM API credentials (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE`) work with V2 or need re-derivation via V2 SDK
- PM WebSocket (`/market`, `/user`) — any changes post-V2
- Whether `data-api.polymarket.com/positions` returns new or same `asset` field format
