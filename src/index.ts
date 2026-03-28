import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { openDb, initDb, insertSnapshot, insertArb } from "./db.js";
import { fetchKalshiSnapshot } from "./kalshi.js";
import { fetchPolymarketSnapshot } from "./polymarket.js";
import { AutoPairConfig, MarketPairConfig, MarketSnapshot } from "./types.js";
import { buildAutoPairs } from "./autoPairs.js";

dotenv.config();

type ConfigFile = {
  pairs: MarketPairConfig[];
  autoPairs?: AutoPairConfig[];
};

function readConfig(configPath: string): ConfigFile {
  const raw = fs.readFileSync(configPath, "utf8");
  return JSON.parse(raw) as ConfigFile;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatNum(value: number | null) {
  return value === null ? "" : value.toFixed(4);
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

function edgeFromCost(cost: number | null): number | null {
  if (cost === null) return null;
  return 1 - cost;
}

function normalizeKalshiSide(kal: MarketSnapshot, side: "YES" | "NO") {
  if (side === "YES") {
    return {
      yesBid: kal.yesBid,
      yesAsk: kal.yesAsk,
      noBid: kal.noBid,
      noAsk: kal.noAsk
    };
  }
  return {
    yesBid: kal.noBid,
    yesAsk: kal.noAsk,
    noBid: kal.yesBid,
    noAsk: kal.yesAsk
  };
}


async function main() {
  const dataDir = process.env.DATA_DIR ?? "data";
  ensureDir(dataDir);

  const configPath = path.resolve("config", "markets.json");
  const config = readConfig(configPath);
  const db = openDb(path.join(dataDir, "arb.sqlite"));
  initDb(db);

  let pairs: MarketPairConfig[] = [...config.pairs];
  if (config.autoPairs?.length) {
    for (const auto of config.autoPairs) {
      const autoPairs = await buildAutoPairs(auto);
      pairs = pairs.concat(autoPairs);
    }
  }

  const quotesRows: string[] = [];
  const arbRows: string[] = [];
  const summaryRows: string[] = [];
  quotesRows.push(
    [
      "ts",
      "pair_id",
      "exchange",
      "market_id",
      "market_title",
      "outcome_label",
      "yes_bid",
      "yes_ask",
      "no_bid",
      "no_ask"
    ].join(",")
  );
  arbRows.push(["ts", "pair_id", "direction", "cost", "edge"].join(","));
  summaryRows.push(
    ["ts", "group_id", "pm_market_slug", "direction", "best_edge", "best_cost", "kalshi_ticker"].join(",")
  );

  const groupBest = new Map<
    string,
    {
      pmMarketSlug: string;
      best: Record<
        "PM_YES_KAL_NO" | "KAL_YES_PM_NO",
        { edge: number | null; cost: number | null; kalshiTicker: string }
      >;
    }
  >();

  for (const pair of pairs) {
    const nowIso = new Date().toISOString();
    let pm: MarketSnapshot | null = null;
    let kal: MarketSnapshot | null = null;

    try {
      pm = await fetchPolymarketSnapshot(pair, nowIso);
      insertSnapshot(db, pm);
      quotesRows.push(
        [
          pm.ts,
          pair.id,
          pm.exchange,
          pm.marketId,
          pm.marketTitle,
          pm.outcomeLabel,
          formatNum(pm.yesBid),
          formatNum(pm.yesAsk),
          formatNum(pm.noBid),
          formatNum(pm.noAsk)
        ].join(",")
      );
    } catch (err) {
      console.error(`[Polymarket] ${pair.id}: ${(err as Error).message}`);
    }

    try {
      kal = await fetchKalshiSnapshot(pair, nowIso);
      insertSnapshot(db, kal);
      quotesRows.push(
        [
          kal.ts,
          pair.id,
          kal.exchange,
          kal.marketId,
          kal.marketTitle,
          kal.outcomeLabel,
          formatNum(kal.yesBid),
          formatNum(kal.yesAsk),
          formatNum(kal.noBid),
          formatNum(kal.noAsk)
        ].join(",")
      );
    } catch (err) {
      console.error(`[Kalshi] ${pair.id}: ${(err as Error).message}`);
    }

    if (!pm || !kal) continue;

    const kalAligned = normalizeKalshiSide(kal, pair.kalshi.side);

    const costA = sumNullable(pm.yesAsk, kalAligned.noAsk);
    const edgeA = edgeFromCost(costA);
    insertArb(db, {
      ts: nowIso,
      pairId: pair.id,
      direction: "PM_YES_KAL_NO",
      cost: costA,
      edge: edgeA
    });
    arbRows.push([nowIso, pair.id, "PM_YES_KAL_NO", formatNum(costA), formatNum(edgeA)].join(","));

    const costB = sumNullable(kalAligned.yesAsk, pm.noAsk);
    const edgeB = edgeFromCost(costB);
    insertArb(db, {
      ts: nowIso,
      pairId: pair.id,
      direction: "KAL_YES_PM_NO",
      cost: costB,
      edge: edgeB
    });
    arbRows.push([nowIso, pair.id, "KAL_YES_PM_NO", formatNum(costB), formatNum(edgeB)].join(","));

    console.log(`Pair ${pair.id}`);
    console.log(`  PM ${pm.outcomeLabel} YES bid/ask: ${formatNum(pm.yesBid)} / ${formatNum(pm.yesAsk)}`);
    console.log(
      `  KAL aligned YES bid/ask: ${formatNum(kalAligned.yesBid)} / ${formatNum(kalAligned.yesAsk)}`
    );
    console.log(
      `  Arb PM YES + KAL NO cost=${formatNum(costA)} edge=${formatNum(edgeA)}`
    );
    console.log(
      `  Arb KAL YES + PM NO cost=${formatNum(costB)} edge=${formatNum(edgeB)}`
    );

    if (pair.groupId) {
      const entry =
        groupBest.get(pair.groupId) ??
        {
          pmMarketSlug: pair.pmMarketSlug ?? "",
          best: {
            PM_YES_KAL_NO: { edge: null, cost: null, kalshiTicker: "" },
            KAL_YES_PM_NO: { edge: null, cost: null, kalshiTicker: "" }
          }
        };

      const bestA = entry.best.PM_YES_KAL_NO;
      if (edgeA !== null && (bestA.edge === null || edgeA > bestA.edge)) {
        entry.best.PM_YES_KAL_NO = {
          edge: edgeA,
          cost: costA,
          kalshiTicker: pair.kalshi.ticker
        };
      }
      const bestB = entry.best.KAL_YES_PM_NO;
      if (edgeB !== null && (bestB.edge === null || edgeB > bestB.edge)) {
        entry.best.KAL_YES_PM_NO = {
          edge: edgeB,
          cost: costB,
          kalshiTicker: pair.kalshi.ticker
        };
      }

      groupBest.set(pair.groupId, entry);
    }
  }

  fs.writeFileSync(path.join(dataDir, "latest_quotes.csv"), quotesRows.join("\n"), "utf8");
  fs.writeFileSync(path.join(dataDir, "latest_arbs.csv"), arbRows.join("\n"), "utf8");

  for (const [groupId, entry] of groupBest.entries()) {
    const nowIso = new Date().toISOString();
    const a = entry.best.PM_YES_KAL_NO;
    summaryRows.push(
      [
        nowIso,
        groupId,
        entry.pmMarketSlug,
        "PM_YES_KAL_NO",
        formatNum(a.edge),
        formatNum(a.cost),
        a.kalshiTicker
      ].join(",")
    );
    const b = entry.best.KAL_YES_PM_NO;
    summaryRows.push(
      [
        nowIso,
        groupId,
        entry.pmMarketSlug,
        "KAL_YES_PM_NO",
        formatNum(b.edge),
        formatNum(b.cost),
        b.kalshiTicker
      ].join(",")
    );
  }
  fs.writeFileSync(path.join(dataDir, "latest_arbs_summary.csv"), summaryRows.join("\n"), "utf8");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
