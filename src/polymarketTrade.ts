import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { fetchJson } from "./http.js";
import { resolvePolyApiCreds } from "./polyAuth.js";

type GammaMarket = {
  orderPriceMinTickSize?: number;
  orderMinSize?: number;
  negRisk?: boolean;
  clobTokenIds?: string;
  outcomes?: string;
};

function parseArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
    } catch {
      return [value];
    }
  }
  return [];
}

function normalizeLabel(value: string) {
  return value.trim().toLowerCase();
}

async function fetchMarketBySlug(slug: string): Promise<GammaMarket> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const res = await fetchJson<unknown>(`${gammaBase}/markets/slug/${slug}`);
  const market =
    (res as { market?: GammaMarket }).market ?? (res as GammaMarket);
  return market;
}

function getTokenId(market: GammaMarket, outcomeLabel: string) {
  const outcomes = parseArray(market.outcomes);
  const tokenIds = parseArray(market.clobTokenIds);
  const idx = outcomes.findIndex((o) => normalizeLabel(o) === normalizeLabel(outcomeLabel));
  if (idx < 0) throw new Error(`Outcome "${outcomeLabel}" not found in market.`);
  if (idx >= tokenIds.length) throw new Error(`Token ID missing for outcome index ${idx} (${tokenIds.length} token IDs for ${outcomes.length} outcomes).`);
  return tokenIds[idx];
}

export type PolymarketTradeInfo = {
  tokenId: string;
  tickSize: number;
  minSize: number;
  negRisk: boolean;
};

export async function getPolymarketTradeInfo(
  marketSlug: string,
  outcomeLabel: "Yes" | "No"
): Promise<PolymarketTradeInfo> {
  const market = await fetchMarketBySlug(marketSlug);
  const tickSize = market.orderPriceMinTickSize ?? 0.001;
  const minSize = market.orderMinSize ?? 1;
  const negRisk = Boolean(market.negRisk);
  const tokenId = getTokenId(market, outcomeLabel);
  if (!tokenId) throw new Error("Missing tokenId for outcome.");
  return { tokenId, tickSize, minSize, negRisk };
}

export async function getPolymarketFeeRateBps(tokenId: string): Promise<number> {
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("Missing POLY_WALLET_PRIVATE_KEY for fee lookup.");
  }
  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);
  const funder = process.env.POLY_FUNDER || wallet.address;
  const creds = await resolvePolyApiCreds({
    host,
    chainId,
    sigType,
    wallet
  });
  const client = new ClobClient(host, chainId, wallet, creds, sigType, funder);
  const feeRate = await client.getFeeRateBps(tokenId);
  return Number(feeRate) || 0;
}

export async function placePolymarketOrder(
  marketSlug: string,
  outcomeLabel: "Yes" | "No",
  price: number,
  amount: number,
  dryRun: boolean,
  orderType: OrderType,
  amountType: "usd" | "shares" = "usd",
  tradeInfo?: PolymarketTradeInfo
) {
  const privateKey = process.env.POLY_WALLET_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("Missing POLY_WALLET_PRIVATE_KEY for order signing.");
  }

  const info =
    tradeInfo ?? (await getPolymarketTradeInfo(marketSlug, outcomeLabel));
  const { tokenId, tickSize, minSize, negRisk } = info;

  if (amountType === "usd" && price <= 0) {
    throw new Error(`Cannot compute order size: price is ${price} (must be > 0).`);
  }
  const size = amountType === "usd" ? amount / price : amount;
  if (size < minSize) {
    throw new Error(`Order size ${size.toFixed(4)} is below min size ${minSize}.`);
  }

  if (dryRun) {
    return {
      dryRun: true,
      marketSlug,
      outcomeLabel,
      tokenId,
      price,
      size
    };
  }

  const host = process.env.POLY_CLOB_URL ?? "https://clob.polymarket.com";
  const chainId = Number(process.env.POLY_CHAIN_ID ?? 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE ?? 0);
  const wallet = new Wallet(privateKey);
  const funder = process.env.POLY_FUNDER || wallet.address;

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
    funder
  );

  // orderType must be the 3rd argument; placing it inside the userOrder object is silently ignored by the library.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (client.createAndPostOrder as any)(
    { tokenID: tokenId, price, size, side: Side.BUY },
    { tickSize: tickSize.toString(), negRisk },
    orderType
  );
}
