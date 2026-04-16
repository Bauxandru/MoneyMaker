/**
 * auditBalances.ts — daily P&L health-check.
 *
 * Reconciles three independent views of your money:
 *   1. Bot's claimed realized P&L (from data/arb_trades.json)
 *   2. Actual wallet wealth now (Kalshi + PM USDC + PM positions at mark)
 *   3. External money flows (PM USDC deposits/withdrawals via Alchemy,
 *      Kalshi balance deltas vs. bot's recorded trade activity)
 *
 * Prints:
 *   - Current wallet snapshot
 *   - External deposits/withdrawals since start (per on-chain data)
 *   - Daily table: bot's reported P&L vs. wealth-delta
 *   - Cumulative true P&L vs. cumulative bot P&L, gap = phantom profit
 *
 * Run: npm run audit:balances
 *      npx tsx src/auditBalances.ts [--since YYYY-MM-DD]
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const USDC = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const KAL_BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
const RPC = process.env.POLY_RPC_URL ?? process.env.POLYGON_RPC_URL ?? "";
const PM_DATA = process.env.POLY_DATA_URL ?? "https://data-api.polymarket.com";

/** Polymarket infrastructure addresses. Transfers with these counterparties are
 *  part of normal trading activity, not external deposits/withdrawals. */
const PM_INTERNAL = new Set([
  "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // ConditionalTokens (CTF)
  "0xc5d563a36ae78145c45a50134d48a1215220f80a", // NegRisk CTF Exchange
  "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e", // CTF Exchange
  "0x3a3bd7bb9528e159577f7c2e685cc81a765002e2", // NegRisk Adapter
  "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296", // Legacy exchange
  "0x57f5e098cad7a3d1eed53991d4d66c45c9af7812", // Safe proxy factory
  "0xeebabf4edab67ab9fd1502bda81bc97660a40c28", // Polymarket relay
]);

// ─── Kalshi signing ─────────────────────────────────────────────────────────

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
async function kalGet(p: string): Promise<any> {
  const keyId = process.env.KALSHI_API_KEY_ID!;
  const pk = loadKalPk();
  const url = new URL(`${KAL_BASE}${p}`);
  const ts = Date.now().toString();
  const sig = kalSign("GET", url.pathname, ts, pk);
  const res = await fetch(url.toString(), {
    headers: { "KALSHI-ACCESS-KEY": keyId, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`Kalshi ${p} HTTP ${res.status}`);
  return res.json();
}

// ─── Alchemy asset-transfer paging ──────────────────────────────────────────

async function alchemy(method: string, params: any[]): Promise<any> {
  const res = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}
async function listTransfers(from: string | null, to: string | null, fromBlock: string): Promise<any[]> {
  const all: any[] = [];
  let pageKey: string | undefined;
  for (let i = 0; i < 50; i++) {
    const params: any = {
      fromBlock, toBlock: "latest",
      category: ["erc20"], contractAddresses: [USDC],
      maxCount: "0x3e8", order: "desc", withMetadata: true,
    };
    if (from) params.fromAddress = from;
    if (to) params.toAddress = to;
    if (pageKey) params.pageKey = pageKey;
    const r = await alchemy("alchemy_getAssetTransfers", [params]);
    all.push(...r.transfers);
    pageKey = r.pageKey;
    if (!pageKey) break;
    await new Promise(x => setTimeout(x, 80));
  }
  return all;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function r2(n: number): number { return Math.round(n * 100) / 100; }
function fmt$(n: number): string { const s = n.toFixed(2); return (n >= 0 ? "+$" + s : "-$" + Math.abs(n).toFixed(2)).padStart(10); }
function argSince(): string {
  const idx = process.argv.indexOf("--since");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return ""; // default: balance_log's first entry
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { Wallet, Contract, JsonRpcProvider } = await import("ethers");
  const pk = process.env.POLY_WALLET_PRIVATE_KEY ?? "";
  let funder = process.env.POLY_FUNDER ?? "";
  if (!funder && pk) { try { funder = new Wallet(pk).address; } catch {} }
  if (!funder) { console.error("POLY_FUNDER or POLY_WALLET_PRIVATE_KEY required"); process.exit(1); }
  if (!RPC) { console.error("POLY_RPC_URL required (Alchemy endpoint recommended)"); process.exit(1); }

  const funderLc = funder.toLowerCase();
  const balLogPath = "data/balance_log.json";
  const balLog = fs.existsSync(balLogPath) ? JSON.parse(fs.readFileSync(balLogPath, "utf8")) as any[] : [];
  const since = argSince() || (balLog[0]?.ts?.slice(0, 10) ?? new Date().toISOString().slice(0, 10));
  const sinceTs = new Date(since + "T00:00:00Z").getTime() / 1000;

  // ── Current snapshot ──────────────────────────────────────────────────────
  const kalBal = (await kalGet("/portfolio/balance")).balance / 100;
  const prov = new JsonRpcProvider(RPC, 137, { staticNetwork: true });
  const usdc = new Contract(USDC, ["function balanceOf(address) view returns (uint256)"], prov);
  const pmUsd = Number((await usdc.balanceOf(funder)) as bigint) / 1e6;
  const pmPosRes = await fetch(`${PM_DATA}/positions?user=${encodeURIComponent(funder)}&sizeThreshold=0.001`);
  const pmPos = (await pmPosRes.json()) as any[];
  const pmMark = pmPos.reduce((s, p) => s + Number(p.size ?? 0) * Number(p.curPrice ?? 0), 0);
  const pmCost = pmPos.reduce((s, p) => s + Number(p.size ?? 0) * Number(p.avgPrice ?? 0), 0);
  const cashNow = kalBal + pmUsd;
  const wealthNow = cashNow + pmMark;

  console.log("╔" + "═".repeat(88) + "╗");
  console.log("║" + "  Daily P&L Balance Audit".padEnd(88) + "║");
  console.log("╚" + "═".repeat(88) + "╝");
  console.log(`Wallet:        ${funder}`);
  console.log(`Window:        ${since} → ${new Date().toISOString().slice(0, 10)}`);
  console.log("");
  console.log("Current state:");
  console.log(`  Kalshi cash:                  $${kalBal.toFixed(2).padStart(10)}`);
  console.log(`  Polymarket USDC:              $${pmUsd.toFixed(2).padStart(10)}`);
  console.log(`  Open PM positions (mark):     $${pmMark.toFixed(2).padStart(10)}  (cost basis $${pmCost.toFixed(2)})`);
  console.log(`                                 ───────────`);
  console.log(`  Total wealth:                 $${wealthNow.toFixed(2).padStart(10)}`);

  // ── External money flow (PM side, on-chain) ───────────────────────────────
  const current = await alchemy("eth_blockNumber", []);
  const blocksBack = Math.min(1_800_000, (new Date().getTime() / 1000 - sinceTs) * 2 + 100_000);
  const fromBlock = "0x" + Math.max(0, parseInt(current, 16) - Math.floor(blocksBack)).toString(16);
  console.log(`\nFetching USDC transfers for PM wallet (Alchemy, since block ${parseInt(fromBlock, 16)})…`);
  const [inc, out] = await Promise.all([
    listTransfers(null, funder, fromBlock),
    listTransfers(funder, null, fromBlock),
  ]);
  type Flow = { ts: number; usd: number; other: string; isTrade: boolean; dir: "IN" | "OUT"; hash: string };
  const flows: Flow[] = [];
  for (const t of inc) {
    const tsStr = t.metadata?.blockTimestamp ?? "";
    const ts = tsStr ? new Date(tsStr).getTime() / 1000 : 0;
    if (ts < sinceTs) continue;
    const other = String(t.from).toLowerCase();
    flows.push({ ts, usd: Number(t.value), other, isTrade: PM_INTERNAL.has(other), dir: "IN", hash: t.hash });
  }
  for (const t of out) {
    const tsStr = t.metadata?.blockTimestamp ?? "";
    const ts = tsStr ? new Date(tsStr).getTime() / 1000 : 0;
    if (ts < sinceTs) continue;
    const other = String(t.to).toLowerCase();
    flows.push({ ts, usd: Number(t.value), other, isTrade: PM_INTERNAL.has(other), dir: "OUT", hash: t.hash });
  }
  flows.sort((a, b) => a.ts - b.ts);
  const extDep = flows.filter(f => f.dir === "IN" && !f.isTrade);
  const extWd = flows.filter(f => f.dir === "OUT" && !f.isTrade);
  const extNet = extDep.reduce((s, f) => s + f.usd, 0) - extWd.reduce((s, f) => s + f.usd, 0);

  console.log("");
  console.log("PM external money flow:");
  console.log(`  Deposits:                     $${extDep.reduce((s, f) => s + f.usd, 0).toFixed(2).padStart(10)}  (${extDep.length} transfer${extDep.length === 1 ? "" : "s"})`);
  console.log(`  Withdrawals:                  $${extWd.reduce((s, f) => s + f.usd, 0).toFixed(2).padStart(10)}  (${extWd.length} transfer${extWd.length === 1 ? "" : "s"})`);
  console.log(`  Net external inflow:          $${extNet.toFixed(2).padStart(10)}`);
  if (extDep.length + extWd.length > 0 && extDep.length + extWd.length <= 20) {
    console.log(`  Details:`);
    for (const f of [...extDep, ...extWd].sort((a, b) => a.ts - b.ts)) {
      const sign = f.dir === "IN" ? "+" : "-";
      console.log(`    ${new Date(f.ts * 1000).toISOString().slice(0, 19)}  ${sign}$${f.usd.toFixed(2).padStart(9)}  ${f.dir === "IN" ? "from" : "to  "} ${f.other.slice(0, 16)}…`);
    }
  }

  // ── Kalshi implied withdrawals from balance jumps ─────────────────────────
  // Look for suspicious balance drops that don't match nearby trading cost.
  // A single-snapshot drop > $200 without corresponding fills likely = withdrawal.
  console.log("\nKalshi money flow (inferred from balance_log, no public API):");
  if (balLog.length < 2) {
    console.log("  (balance_log.json has no history)");
  } else {
    let maxInferred = 0;
    const jumps: any[] = [];
    for (let i = 1; i < balLog.length; i++) {
      const d = balLog[i].kalshi - balLog[i - 1].kalshi;
      if (balLog[i].pm <= 0 || balLog[i - 1].pm <= 0) continue; // skip pm-fetch glitches
      if (Math.abs(d) >= 200) jumps.push({ ts: balLog[i].ts, d });
      if (d < -200) maxInferred += Math.abs(d);
    }
    console.log(`  Start balance (${balLog[0].ts.slice(0, 10)}): $${balLog[0].kalshi.toFixed(2)}`);
    console.log(`  Current balance:                 $${kalBal.toFixed(2)}`);
    console.log(`  Net cash change on Kalshi:       $${(kalBal - balLog[0].kalshi).toFixed(2)}`);
    if (jumps.length > 0) {
      console.log(`  Large single-snapshot jumps (>$200) — potential withdrawals/deposits:`);
      for (const j of jumps.slice(0, 10)) {
        console.log(`    ${j.ts}  Δ${fmt$(j.d)}`);
      }
    }
    console.log(`  (Verify in Kalshi web UI → Account → Deposits/Withdrawals)`);
  }

  // ── Bot-reported P&L vs. wealth delta (daily table) ───────────────────────
  const tradesPath = "data/arb_trades.json";
  const trades = fs.existsSync(tradesPath) ? JSON.parse(fs.readFileSync(tradesPath, "utf8")) as any[] : [];
  const byDayPnl = new Map<string, number>();
  for (const t of trades) {
    if (t.status !== "resolved" || t.realizedPnl == null) continue;
    const d = (t.resolvedTs ?? t.ts ?? "").slice(0, 10);
    if (!d || d < since) continue;
    byDayPnl.set(d, (byDayPnl.get(d) ?? 0) + t.realizedPnl);
  }
  // One wealth sample per day from balance_log (last sample that day).
  const byDayWealth = new Map<string, number>();
  for (const b of balLog) {
    const d = b.ts.slice(0, 10);
    if (d < since || b.pm <= 0) continue; // skip pm-fetch glitches
    byDayWealth.set(d, b.kalshi + b.pm);
  }
  const todayDate = new Date().toISOString().slice(0, 10);
  byDayWealth.set(todayDate, cashNow); // append today's cash

  const days = Array.from(new Set([...byDayPnl.keys(), ...byDayWealth.keys()])).sort();
  console.log("\n" + "─".repeat(90));
  console.log("Daily P&L vs. wealth delta");
  console.log("─".repeat(90));
  console.log("  Date        Bot P&L   Wealth     ΔWealth     Cumulative bot   Cumulative true");
  let cumBot = 0, lastWealth = balLog[0]?.total ?? cashNow;
  const startWealth = balLog[0]?.total ?? cashNow;
  let cumDeposits = 0; // cumulative external deposits up to this day
  const depsByDay = new Map<string, number>();
  for (const f of flows) {
    if (f.isTrade) continue;
    const d = new Date(f.ts * 1000).toISOString().slice(0, 10);
    depsByDay.set(d, (depsByDay.get(d) ?? 0) + (f.dir === "IN" ? f.usd : -f.usd));
  }
  for (const d of days) {
    const p = byDayPnl.get(d) ?? 0;
    const w = byDayWealth.get(d);
    if (w == null) continue;
    const dw = w - lastWealth;
    cumBot += p;
    cumDeposits += depsByDay.get(d) ?? 0;
    const cumTrue = w - startWealth - cumDeposits;
    const marker = p !== 0 || Math.abs(dw) > 1 ? "  " : "--";
    console.log(
      `  ${d}  ${fmt$(p)}  $${w.toFixed(2).padStart(8)}  ${fmt$(dw)}  ${fmt$(cumBot).padStart(10)}   ${fmt$(cumTrue).padStart(10)} ${marker}`
    );
    lastWealth = w;
  }

  // ── Final reconciliation line ─────────────────────────────────────────────
  // Sum ALL big (>$200) Kalshi drops that coincide with a PM deposit within ±24h:
  // these are almost certainly Kalshi→PM bank-bridge transfers, not trading losses.
  let kalOutflowHint = 0;
  const depTimes = flows.filter(f => f.dir === "IN" && !f.isTrade).map(f => f.ts);
  // Detect glitch rows: pm reported as 0, kalshi wildly out of plausible range, or
  // same kalshi value next to itself. Skip them.
  function plausible(entry: any): boolean {
    return entry && Number(entry.pm) > 0 && Number(entry.kalshi) > 0 && Number(entry.kalshi) < 50000;
  }
  for (let i = 1; i < balLog.length; i++) {
    if (!plausible(balLog[i]) || !plausible(balLog[i - 1])) continue;
    const d = Number(balLog[i].kalshi) - Number(balLog[i - 1].kalshi);
    if (d > -200) continue;
    const ts = new Date(balLog[i].ts).getTime() / 1000;
    const nearDeposit = depTimes.some(dt => Math.abs(dt - ts) < 86400);
    if (nearDeposit) kalOutflowHint += Math.abs(d);
  }

  const trueGain = wealthNow - startWealth - extNet;
  const trueGainIncludingKalBridge = wealthNow - startWealth - extNet + kalOutflowHint;
  const claimedResolved = trades.filter(t => t.status === "resolved" && t.realizedPnl != null)
                                .reduce((s, t) => s + (t.realizedPnl ?? 0), 0);
  const pmUnrealized = pmMark - pmCost;

  console.log("\n" + "═".repeat(90));
  console.log("Summary");
  console.log("═".repeat(90));
  console.log(`  Starting wealth:               $${startWealth.toFixed(2).padStart(10)}`);
  console.log(`  Current wealth (cash + mark):  $${wealthNow.toFixed(2).padStart(10)}`);
  console.log(`  External deposits (PM):        $${extNet.toFixed(2).padStart(10)}`);
  if (kalOutflowHint > 0) {
    console.log(`  Inferred Kalshi outflows:      $${kalOutflowHint.toFixed(2).padStart(10)}  (jumps near PM deposits — likely bank bridge)`);
  }
  console.log("");
  console.log(`  Bot's claimed realized P&L:      ${fmt$(claimedResolved)}`);
  console.log("");
  console.log("  Scenario A — PM deposits are fresh money from outside:");
  console.log(`    True trading gain:             ${fmt$(trueGain)}`);
  console.log(`    Realized-component estimate:   ${fmt$(trueGain - pmUnrealized)}`);
  console.log(`    Gap (bot overstates by):       ${fmt$(claimedResolved - (trueGain - pmUnrealized))}`);
  if (kalOutflowHint > 0) {
    console.log("");
    console.log("  Scenario B — PM deposits are your own money bridged FROM Kalshi:");
    console.log(`    True trading gain:             ${fmt$(trueGainIncludingKalBridge)}`);
    console.log(`    Realized-component estimate:   ${fmt$(trueGainIncludingKalBridge - pmUnrealized)}`);
    console.log(`    Gap (bot overstates by):       ${fmt$(claimedResolved - (trueGainIncludingKalBridge - pmUnrealized))}`);
    console.log("");
    console.log("  Check Kalshi web UI → Deposits/Withdrawals to pick the correct scenario.");
  }
  console.log("");
  console.log("Tips:");
  console.log("  · Positive gap = bot overstates profit (phantom P&L in data/arb_trades.json)");
  console.log("  · If gap > $50, run npm run sync and rerun this audit");
  console.log("  · Run with --since YYYY-MM-DD to audit a specific window");
}

main().catch(e => { console.error("Audit failed:", e); process.exit(1); });
