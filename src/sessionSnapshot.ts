/**
 * sessionSnapshot.ts -- per-startup wealth snapshot + drift detector.
 *
 * Each time the bot starts, we take one snapshot with:
 *   - Kalshi balance
 *   - Polymarket USDC balance
 *   - Open PM positions at mark-to-market (and cost basis)
 *   - Sum of realizedPnl from arb_trades.json
 * and append to data/session_snapshots.json.
 *
 * On second-and-later startups, we compare with the previous snapshot and
 * print a compact session delta:
 *
 *   Δ wealth:        +$12.34    (what actually happened to your money)
 *   Δ bot-claimed:   +$15.00    (what the trade journal says happened)
 *   Net deposits:    +$0.00     (external USDC transfers between snapshots; 0 means none detected)
 *   ─────────────
 *   Drift:           +$2.66     (bot overstates by this much)
 *
 * If |drift| > DRIFT_WARN_THRESHOLD ($5 default), we print a bold warning.
 * For a full investigation, user runs `npm run audit:balances`.
 *
 * Kept separate from balance_log.json so hourly balance snapshots don't
 * mix with per-startup session deltas.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

// Read env lazily so the module works even when imported before dotenv.config runs.
const kalBaseUrl = () => process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const pmDataUrl  = () => process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";
const rpcUrl     = () => process.env.POLY_RPC_URL ?? process.env.POLYGON_RPC_URL ?? "";
const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const SNAPSHOT_PATH = path.join("data", "session_snapshots.json");
const DRIFT_WARN_USD = Number(process.env.DRIFT_WARN_USD ?? 5);
/** Use `local` for local-time day rollover (recommended — matches user's mental model),
 *  `utc` for UTC rollover. Deposit audit runs on the first startup of a new day. */
const DEPOSIT_CHECK_DAY_TZ = (process.env.DRIFT_DEPOSIT_CHECK_TZ ?? "local").toLowerCase();

/** A running bot's wallet snapshot at a single moment. All monetary values in USD. */
export interface SessionSnapshot {
  ts: string;                 // ISO timestamp
  kalshi: number;             // Kalshi balance (cash)
  pmUsdc: number;             // PM wallet USDC balance (cash)
  pmPositionsMark: number;    // sum(shares * curPrice) of open PM positions
  pmPositionsCost: number;    // sum(shares * avgPrice) -- cost basis
  pmPositionCount: number;    // number of open PM tokens
  totalWealth: number;        // kalshi + pmUsdc + pmPositionsMark
  botClaimedPnl: number;      // cumulative realizedPnl from arb_trades.json
  resolvedCount: number;      // number of resolved trades
  activeCount: number;        // number of hedging/filled trades
  note?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadKalPk(): string {
  if (process.env.KALSHI_PRIVATE_KEY) return process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n");
  return fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH!, "utf8");
}

function kalSign(method: string, p: string, ts: string, pem: string): string {
  const s = crypto.createSign("RSA-SHA256");
  s.update(`${ts}${method.toUpperCase()}${p}`);
  s.end();
  return s.sign({ key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, "base64");
}

async function kalBalance(): Promise<number> {
  const keyId = process.env.KALSHI_API_KEY_ID;
  if (!keyId) return -1;
  const pk = loadKalPk();
  const url = new URL(`${kalBaseUrl()}/portfolio/balance`);
  const ts = Date.now().toString();
  const sig = kalSign("GET", url.pathname, ts, pk);
  try {
    const res = await fetch(url.toString(), {
      headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts, "Content-Type": "application/json" },
    });
    if (!res.ok) return -1;
    const j = await res.json() as { balance?: number };
    return Number(j.balance ?? 0) / 100;
  } catch { return -1; }
}

async function pmUsdcBalance(funder: string): Promise<number> {
  if (!rpcUrl()) return -1;
  try {
    const { Contract, JsonRpcProvider } = await import("ethers");
    const prov = new JsonRpcProvider(rpcUrl(), 137, { staticNetwork: true });
    const c = new Contract(USDC, ["function balanceOf(address) view returns (uint256)"], prov);
    const raw: bigint = await c.balanceOf(funder);
    return Number(raw) / 1e6;
  } catch { return -1; }
}

async function pmPositionsMark(funder: string): Promise<{ mark: number; cost: number; count: number }> {
  try {
    const r = await fetch(`${pmDataUrl()}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.001`);
    if (!r.ok) return { mark: 0, cost: 0, count: 0 };
    const pos = (await r.json()) as any[];
    let mark = 0, cost = 0;
    for (const p of pos) {
      const sh = Number(p.size ?? 0);
      mark += sh * Number(p.curPrice ?? 0);
      cost += sh * Number(p.avgPrice ?? 0);
    }
    return { mark: Math.round(mark * 100) / 100, cost: Math.round(cost * 100) / 100, count: pos.length };
  } catch { return { mark: 0, cost: 0, count: 0 }; }
}

function readBotPnlState(): { claimed: number; resolved: number; active: number } {
  try {
    const path2 = "data/arb_trades.json";
    if (!fs.existsSync(path2)) return { claimed: 0, resolved: 0, active: 0 };
    const trades = JSON.parse(fs.readFileSync(path2, "utf8")) as any[];
    let claimed = 0, resolved = 0, active = 0;
    for (const t of trades) {
      if (t.status === "resolved" && t.realizedPnl != null) { claimed += t.realizedPnl; resolved++; }
      else if (t.status === "hedging" || t.status === "filled") active++;
    }
    return { claimed: Math.round(claimed * 100) / 100, resolved, active };
  } catch { return { claimed: 0, resolved: 0, active: 0 }; }
}

// ─── Alchemy: net external USDC flow between two timestamps ────────────────

async function alchemyNetExternalFlow(funder: string, fromTs: number, toTs: number): Promise<number | null> {
  if (!rpcUrl()) return null;
  const fromBlock = "0x" + Math.max(0, Math.floor((fromTs - 60) * 2 - 1_800_000 + 80_000_000)).toString(16);
  // That estimate is rough; use a large back-window and we'll filter by timestamp.
  // Actually simpler: request latest 500 transfers each direction, filter by ts in [fromTs,toTs].
  async function call(params: any): Promise<any> {
    const res = await fetch(rpcUrl(), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [params] }),
    });
    const j = await res.json() as any;
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  // Trading infra addresses — transfers with these counterparties don't count as external.
  const PM_INTERNAL = new Set([
    "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
    "0x3a3bd7bb9528e159577f7c2e685cc81a765002e2",
    "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296",
    "0x57f5e098cad7a3d1eed53991d4d66c45c9af7812",
    "0xeebabf4edab67ab9fd1502bda81bc97660a40c28",
  ]);
  try {
    const base = {
      fromBlock: "0x0", toBlock: "latest",
      category: ["erc20"], contractAddresses: [USDC],
      maxCount: "0x1f4", order: "desc", withMetadata: true,
    };
    const [inc, out] = await Promise.all([
      call({ ...base, toAddress: funder }),
      call({ ...base, fromAddress: funder }),
    ]);
    let net = 0;
    function consider(list: any, dir: "IN" | "OUT") {
      const items = (list && Array.isArray(list.transfers)) ? list.transfers : Array.isArray(list) ? list : [];
      for (const t of items) {
        const ts = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() / 1000 : 0;
        if (ts < fromTs || ts > toTs) continue;
        const other = String(dir === "IN" ? t.from : t.to).toLowerCase();
        if (PM_INTERNAL.has(other)) continue;
        const usd = Number(t.value);
        net += dir === "IN" ? usd : -usd;
      }
    }
    consider(inc, "IN");
    consider(out, "OUT");
    return Math.round(net * 100) / 100;
  } catch { return null; }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function takeSessionSnapshot(funder: string): Promise<SessionSnapshot> {
  const [kalshi, pmUsdc, pm] = await Promise.all([
    kalBalance(),
    pmUsdcBalance(funder),
    pmPositionsMark(funder),
  ]);
  const bot = readBotPnlState();
  return {
    ts: new Date().toISOString(),
    kalshi: Math.round(kalshi * 100) / 100,
    pmUsdc: Math.round(pmUsdc * 100) / 100,
    pmPositionsMark: pm.mark,
    pmPositionsCost: pm.cost,
    pmPositionCount: pm.count,
    totalWealth: Math.round((Math.max(0, kalshi) + Math.max(0, pmUsdc) + pm.mark) * 100) / 100,
    botClaimedPnl: bot.claimed,
    resolvedCount: bot.resolved,
    activeCount: bot.active,
  };
}

export function loadSessionSnapshots(): SessionSnapshot[] {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return [];
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as SessionSnapshot[];
  } catch { return []; }
}

export function appendSessionSnapshot(s: SessionSnapshot): void {
  const all = loadSessionSnapshots();
  all.push(s);
  // Keep last 500 to bound file size
  const trimmed = all.length > 500 ? all.slice(-500) : all;
  const tmp = SNAPSHOT_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmp, SNAPSHOT_PATH);
}

/** Print a compact session-delta report comparing `curr` to the snapshot right
 *  before it. Warns when the drift between bot-claimed and actual wealth delta
 *  exceeds DRIFT_WARN_USD. Returns true iff there was a previous snapshot. */
export async function reportSessionDelta(
  curr: SessionSnapshot,
  funder: string
): Promise<boolean> {
  const all = loadSessionSnapshots();
  if (all.length === 0) {
    console.log("[SESSION] First snapshot — nothing to compare against. Baseline recorded.");
    return false;
  }
  const prev = all[all.length - 1];
  const gapMinutes = (Date.parse(curr.ts) - Date.parse(prev.ts)) / 60_000;

  // Wealth delta (the actual change in value of all wallets)
  const wealthDelta = curr.totalWealth - prev.totalWealth;
  // Bot-claimed delta (what the trade journal says happened since then)
  const botDelta = curr.botClaimedPnl - prev.botClaimedPnl;

  // Deposit audit runs only on the first startup of a new calendar day (vs. the
  // previous snapshot). Avoids the slow Alchemy call on same-day restarts.
  const prevDay = dayString(new Date(prev.ts));
  const currDay = dayString(new Date(curr.ts));
  const isNewDay = prevDay !== currDay;

  let netExternal: number | null = null;
  if (isNewDay && funder && rpcUrl()) {
    netExternal = await alchemyNetExternalFlow(
      funder,
      Date.parse(prev.ts) / 1000,
      Date.parse(curr.ts) / 1000
    );
  }

  // True P&L = wealth delta minus externally deposited/withdrawn funds
  const trueDelta = netExternal != null ? wealthDelta - netExternal : wealthDelta;
  const drift = botDelta - trueDelta;

  const hours = gapMinutes / 60;
  console.log("");
  console.log("[SESSION] ─────────── Session delta since last startup ───────────");
  console.log(`[SESSION] Previous:  ${prev.ts}  (${hours >= 1 ? hours.toFixed(1) + "h" : gapMinutes.toFixed(0) + "m"} ago)`);
  console.log(`[SESSION]   prev wealth=$${prev.totalWealth.toFixed(2)}  bot-P&L=$${prev.botClaimedPnl.toFixed(2)}  resolved=${prev.resolvedCount}`);
  console.log(`[SESSION] Current:   ${curr.ts}`);
  console.log(`[SESSION]   wealth  =$${curr.totalWealth.toFixed(2)}  bot-P&L=$${curr.botClaimedPnl.toFixed(2)}  resolved=${curr.resolvedCount}`);
  console.log(`[SESSION]`);
  console.log(`[SESSION]   Δ wealth:           ${fmt$(wealthDelta)}   (cash + positions at mark)`);
  console.log(`[SESSION]   Δ bot-claimed P&L:  ${fmt$(botDelta)}   (${curr.resolvedCount - prev.resolvedCount} new resolved)`);
  if (netExternal != null) {
    console.log(`[SESSION]   Net PM deposits:    ${fmt$(netExternal)}   (external USDC movement via Alchemy)`);
    console.log(`[SESSION]   ─────────`);
    console.log(`[SESSION]   Drift (bot - true): ${fmt$(drift)}${Math.abs(drift) > DRIFT_WARN_USD ? "   ⚠ LARGER THAN $" + DRIFT_WARN_USD : ""}`);
  } else {
    console.log(`[SESSION]   Drift (bot - wealth): ${fmt$(drift)}   (no deposit audit — same-day restart)`);
    if (Math.abs(drift) > DRIFT_WARN_USD) {
      console.log(`[SESSION]   ⚠ Drift exceeds $${DRIFT_WARN_USD}. Run \`npm run audit:balances\` for a full investigation.`);
    }
  }
  console.log("[SESSION] ──────────────────────────────────────────────────────");
  console.log("");
  return true;
}

function fmt$(n: number): string {
  const s = Math.abs(n).toFixed(2);
  return (n >= 0 ? "+$" + s : "-$" + s).padStart(10);
}

/** Calendar-day string for rollover detection. Local time by default so the
 *  "new day" matches when the user actually considers it a new day. */
function dayString(d: Date): string {
  if (DEPOSIT_CHECK_DAY_TZ === "utc") return d.toISOString().slice(0, 10);
  // Local time YYYY-MM-DD
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Convenience: take snapshot, print delta, persist. Call from bot startup. */
export async function recordStartupSnapshot(funder: string): Promise<SessionSnapshot | null> {
  try {
    const curr = await takeSessionSnapshot(funder);
    await reportSessionDelta(curr, funder);
    appendSessionSnapshot(curr);
    return curr;
  } catch (err) {
    console.warn(`[SESSION] snapshot failed: ${(err as Error).message}`);
    return null;
  }
}

// ─── CLI entry ─────────────────────────────────────────────────────────────
// Run directly: `npx tsx src/sessionSnapshot.ts` — useful for manual testing.
// Guarded so the module can also be imported from runARB without side effects.
// `import.meta.url` is undefined inside Node's SEA single-executable bundle, so
// we wrap the check to prevent the CLI path from crashing the .exe startup.

import { fileURLToPath } from "url";
let isMain = false;
try {
  const metaUrl = (import.meta as { url?: string }).url;
  if (metaUrl && process.argv[1]) {
    isMain = fileURLToPath(metaUrl) === path.resolve(process.argv[1]);
  }
} catch { isMain = false; }
if (isMain) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();
    const { Wallet } = await import("ethers");
    const pk = process.env.POLY_WALLET_PRIVATE_KEY ?? "";
    let funder = process.env.POLY_FUNDER ?? "";
    if (!funder && pk) { try { funder = new Wallet(pk).address; } catch {} }
    if (!funder) { console.error("Need POLY_FUNDER or POLY_WALLET_PRIVATE_KEY"); process.exit(1); }
    await recordStartupSnapshot(funder);
  })().catch(e => { console.error(e); process.exit(1); });
}
