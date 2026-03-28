import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { ArbOpportunity, MarketSnapshot } from "./types.js";

export function openDb(dbPath: string) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  return db;
}

export function initDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_snapshot (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      exchange TEXT NOT NULL,
      market_id TEXT NOT NULL,
      market_title TEXT NOT NULL,
      outcome_label TEXT NOT NULL,
      yes_bid REAL,
      yes_ask REAL,
      no_bid REAL,
      no_ask REAL,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS arb_opportunity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      pair_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      cost REAL,
      edge REAL
    );
  `);
}

export function insertSnapshot(db: Database.Database, snap: MarketSnapshot) {
  const stmt = db.prepare(`
    INSERT INTO market_snapshot (
      ts, exchange, market_id, market_title, outcome_label,
      yes_bid, yes_ask, no_bid, no_ask, raw_json
    ) VALUES (
      @ts, @exchange, @marketId, @marketTitle, @outcomeLabel,
      @yesBid, @yesAsk, @noBid, @noAsk, @rawJson
    );
  `);
  stmt.run({
    ts: snap.ts,
    exchange: snap.exchange,
    marketId: snap.marketId,
    marketTitle: snap.marketTitle,
    outcomeLabel: snap.outcomeLabel,
    yesBid: snap.yesBid,
    yesAsk: snap.yesAsk,
    noBid: snap.noBid,
    noAsk: snap.noAsk,
    rawJson: snap.rawJson
  });
}

export function insertArb(db: Database.Database, arb: ArbOpportunity) {
  const stmt = db.prepare(`
    INSERT INTO arb_opportunity (
      ts, pair_id, direction, cost, edge
    ) VALUES (
      @ts, @pairId, @direction, @cost, @edge
    );
  `);
  stmt.run({
    ts: arb.ts,
    pairId: arb.pairId,
    direction: arb.direction,
    cost: arb.cost,
    edge: arb.edge
  });
}
