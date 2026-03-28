import { fetchJson } from "./http.js";
import { AutoPairConfig, MarketPairConfig } from "./types.js";

type PmMarket = {
  slug?: string;
  question?: string;
  groupItemTitle?: string;
};

type KalMarket = {
  ticker: string;
  title?: string;
};

type Category = {
  dir: "cut" | "hike" | "nochange";
  mag: "0" | "25" | "gt25" | "ge25";
};

function normalizeText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function categorizePolymarket(m: PmMarket): Category | null {
  const label = normalizeText(m.groupItemTitle ?? m.question ?? "");
  if (!label) return null;
  if (label.includes("no change")) return { dir: "nochange", mag: "0" };
  if (label.includes("25 bps decrease")) return { dir: "cut", mag: "25" };
  if (label.includes("50+ bps decrease")) return { dir: "cut", mag: "gt25" };
  if (label.includes("25+ bps increase")) return { dir: "hike", mag: "ge25" };
  return null;
}

function categorizeKalshi(m: KalMarket): Category | null {
  const label = normalizeText(m.title ?? "");
  if (!label) return null;
  if (label.includes("hike rates by 0bps")) return { dir: "nochange", mag: "0" };
  if (label.includes("hike rates by 25bps")) return { dir: "hike", mag: "25" };
  if (label.includes("hike rates by >25bps")) return { dir: "hike", mag: "gt25" };
  if (label.includes("cut rates by 25bps")) return { dir: "cut", mag: "25" };
  if (label.includes("cut rates by >25bps")) return { dir: "cut", mag: "gt25" };
  return null;
}

function categoryId(c: Category) {
  return `${c.dir}_${c.mag}`;
}

export async function buildAutoPairs(auto: AutoPairConfig): Promise<MarketPairConfig[]> {
  const gammaBase = process.env.POLY_GAMMA_URL ?? "https://gamma-api.polymarket.com";
  const kalBase = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";

  const pmEventRes = await fetchJson<unknown>(
    `${gammaBase}/events/slug/${auto.polymarketEventSlug}`
  );
  const pmEvent =
    (pmEventRes as { event?: { markets?: PmMarket[] } }).event ??
    (pmEventRes as { markets?: PmMarket[] });
  const pmMarkets = pmEvent?.markets ?? [];

  const kalRes = await fetchJson<{ markets: KalMarket[] }>(
    `${kalBase}/markets?event_ticker=${encodeURIComponent(auto.kalshiEventTicker)}&limit=200`
  );
  const kalMarkets = kalRes.markets ?? [];

  const pmCats = pmMarkets
    .map((m) => ({ m, c: categorizePolymarket(m) }))
    .filter((v) => v.c !== null) as { m: PmMarket; c: Category }[];
  const kalCats = kalMarkets
    .map((m) => ({ m, c: categorizeKalshi(m) }))
    .filter((v) => v.c !== null) as { m: KalMarket; c: Category }[];

  const kalByCat = new Map<string, KalMarket[]>();
  for (const { m, c } of kalCats) {
    const key = categoryId(c);
    const list = kalByCat.get(key) ?? [];
    list.push(m);
    kalByCat.set(key, list);
  }

  const pairs: MarketPairConfig[] = [];
  for (const { m: pm, c: pmc } of pmCats) {
    if (!pm.slug) continue;
    if (pmc.dir === "hike" && pmc.mag === "ge25") {
      const h25 = kalByCat.get("hike_25") ?? [];
      const hgt = kalByCat.get("hike_gt25") ?? [];
      for (const km of [...h25, ...hgt]) {
        const mag = km.title?.includes(">25") ? "gt25" : "25";
        pairs.push({
          id: `${auto.idPrefix}_hike_${mag}_${km.ticker}`,
          groupId: pm.slug,
          pmMarketSlug: pm.slug,
          polymarket: {
            marketSlug: pm.slug,
            outcomeLabel: "Yes",
            outcomeIndex: 0
          },
          kalshi: {
            ticker: km.ticker,
            side: "YES"
          },
          notes:
            "Polymarket '25+ bps increase' spans both 25 and >25; this pair is approximate."
        });
      }
      continue;
    }

    const key = categoryId(pmc);
    const kmList = kalByCat.get(key) ?? [];
    for (const km of kmList) {
      pairs.push({
        id: `${auto.idPrefix}_${key}_${km.ticker}`,
        groupId: pm.slug,
        pmMarketSlug: pm.slug,
        polymarket: {
          marketSlug: pm.slug,
          outcomeLabel: "Yes",
          outcomeIndex: 0
        },
        kalshi: {
          ticker: km.ticker,
          side: "YES"
        }
      });
    }
  }

  return pairs;
}
