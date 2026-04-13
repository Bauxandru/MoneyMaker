/**
 * verifyChain.ts -- Cross-reference arb_trades.json PM data against Polygon blockchain.
 *
 * Scans ALL CTF TransferSingle events to/from our wallet, then compares
 * on-chain transfer data with the trade log to find discrepancies.
 *
 * Usage: npx tsx src/verifyChain.ts [daysBack]
 */
import dotenv from "dotenv";
dotenv.config();
import { readFileSync } from "fs";
import { join } from "path";

const RPC = process.env.POLY_RPC_URL || process.env.POLYGON_RPC_URL || "https://polygon.drpc.org";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const WALLET = (process.env.POLY_FUNDER ?? "").toLowerCase();
const WALLET_PADDED = "0x" + "0".repeat(24) + WALLET.replace("0x", "");
const TOPIC_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

const DAYS_BACK = Number(process.argv[2] ?? 10);
const BLOCKS_PER_CHUNK = 9999;
const BLOCKS_PER_DAY = Math.floor(86400 / 2); // ~2s per block on Polygon

interface OnChainTransfer {
  block: number;
  tx: string;
  tokenId: string;
  qty: number;
  direction: "IN" | "OUT";
}

interface ArbTrade {
  id: string;
  ts: string;
  match: string;
  dir: string;
  status: string;
  shares: number;
  kalTicker: string;
  kalCost: number;
  pmOutcome: string;
  pmSlug: string;
  pmTokenId?: string;
  pmFillPrice: number;
  pmCost: number;
  totalCost: number;
  realizedPnl?: number;
  resolutionMethod?: string;
}

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function getLogs(fromBlock: number, toBlock: number, dir: "IN" | "OUT"): Promise<OnChainTransfer[]> {
  const topics: (string | null)[] = [TOPIC_SINGLE, null, null, null];
  if (dir === "IN") topics[3] = WALLET_PADDED;
  else topics[2] = WALLET_PADDED;

  const result = (await rpcCall("eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    address: CTF,
    topics,
  }])) as Array<{ blockNumber: string; transactionHash: string; data: string }>;

  return result.map(log => {
    const raw = log.data.slice(2);
    const tokenId = BigInt("0x" + raw.slice(0, 64)).toString();
    const qty = Number(BigInt("0x" + raw.slice(64, 128))) / 1e6;
    return {
      block: parseInt(log.blockNumber, 16),
      tx: log.transactionHash,
      tokenId,
      qty,
      direction: dir,
    };
  });
}

async function getBlockTimestamp(blockNum: number): Promise<number> {
  const block = (await rpcCall("eth_getBlockByNumber", ["0x" + blockNum.toString(16), false])) as Record<string, string> | null;
  if (!block) return 0;
  return parseInt(block.timestamp, 16);
}

async function lookupMarket(tokenId: string): Promise<string> {
  try {
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
    const markets = (await resp.json()) as Array<Record<string, unknown>>;
    if (markets.length > 0) return String(markets[0].question ?? markets[0].slug ?? "");
  } catch { /* */ }
  try {
    const resp = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}&closed=true`);
    const markets = (await resp.json()) as Array<Record<string, unknown>>;
    if (markets.length > 0) return String(markets[0].question ?? markets[0].slug ?? "");
  } catch { /* */ }
  return "";
}

async function main() {
  console.log(`=== BLOCKCHAIN VERIFICATION ===`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`RPC: ${RPC}`);
  console.log(`Scanning last ${DAYS_BACK} days...\n`);

  // Step 1: Get block range
  const latestHex = (await rpcCall("eth_blockNumber", [])) as string;
  const latest = parseInt(latestHex, 16);
  const startBlock = latest - BLOCKS_PER_DAY * DAYS_BACK;
  console.log(`Block range: ${startBlock} -> ${latest} (${latest - startBlock} blocks)\n`);

  // Step 2: Scan all transfers
  const allTransfers: OnChainTransfer[] = [];
  for (let from = startBlock; from <= latest; from += BLOCKS_PER_CHUNK + 1) {
    const to = Math.min(from + BLOCKS_PER_CHUNK, latest);
    process.stdout.write(`  Scanning ${from}..${to} ...`);
    try {
      const [inTx, outTx] = await Promise.all([
        getLogs(from, to, "IN"),
        getLogs(from, to, "OUT"),
      ]);
      allTransfers.push(...inTx, ...outTx);
      console.log(` ${inTx.length} in, ${outTx.length} out`);
    } catch (e) {
      console.log(` ERROR: ${(e as Error).message.slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  // Step 3: Group by tokenId
  const byToken = new Map<string, { inQty: number; outQty: number; transfers: OnChainTransfer[] }>();
  for (const t of allTransfers) {
    const entry = byToken.get(t.tokenId) ?? { inQty: 0, outQty: 0, transfers: [] };
    if (t.direction === "IN") entry.inQty += t.qty;
    else entry.outQty += t.qty;
    entry.transfers.push(t);
    byToken.set(t.tokenId, entry);
  }

  console.log(`\nFound ${allTransfers.length} transfers across ${byToken.size} tokens\n`);

  // Step 4: Load trade log
  const trades: ArbTrade[] = JSON.parse(readFileSync(join(process.cwd(), "data", "arb_trades.json"), "utf8"));
  console.log(`Trade log: ${trades.length} trades\n`);

  // Step 5: For each trade with PM involvement, try to match on-chain
  const tradesWithPm = trades.filter(t => t.pmCost > 0 || t.pmFillPrice > 0 || t.pmSlug);
  console.log(`Trades with PM involvement: ${tradesWithPm.length}\n`);

  // Build tokenId -> trade mapping for trades that have pmTokenId
  const tokenToTrade = new Map<string, ArbTrade[]>();
  for (const t of trades) {
    if (t.pmTokenId) {
      const list = tokenToTrade.get(t.pmTokenId) ?? [];
      list.push(t);
      tokenToTrade.set(t.pmTokenId, list);
    }
  }

  // Step 6: Cross-reference
  console.log("=== CROSS-REFERENCE RESULTS ===\n");

  let matched = 0;
  let mismatches = 0;
  let onChainButNotLogged = 0;
  let loggedButNotOnChain = 0;

  // Check each on-chain token against trade log
  for (const [tokenId, chainData] of byToken) {
    const matchedTrades = tokenToTrade.get(tokenId);

    if (matchedTrades && matchedTrades.length > 0) {
      for (const trade of matchedTrades) {
        const loggedShares = trade.shares;
        const chainShares = Math.round(chainData.inQty);
        const hasPmCost = trade.pmCost > 0 || trade.pmFillPrice > 0;

        if (hasPmCost && chainShares > 0) {
          if (Math.abs(chainShares - loggedShares) <= 1) {
            console.log(`  [OK] MATCH: ${trade.match} (${trade.dir}) -- log=${loggedShares} chain=${chainShares} pmCost=$${trade.pmCost.toFixed(2)}`);
            matched++;
          } else {
            console.log(`  [X] MISMATCH: ${trade.match} (${trade.dir}) -- log=${loggedShares} chain=${chainShares} pmCost=$${trade.pmCost.toFixed(2)}`);
            mismatches++;
          }
        } else if (!hasPmCost && chainShares > 0) {
          console.log(`  [!] ON-CHAIN BUT NOT LOGGED: ${trade.match} (${trade.dir}) -- chain=${chainShares} shares, log shows pmCost=$0`);
          onChainButNotLogged++;
        } else if (hasPmCost && chainShares === 0) {
          console.log(`  [!] LOGGED BUT NOT ON-CHAIN: ${trade.match} (${trade.dir}) -- log=${loggedShares} pmCost=$${trade.pmCost.toFixed(2)} but 0 on chain`);
          loggedButNotOnChain++;
        }
      }
    }
  }

  // Check trades with PM slug but no tokenId -- resolve via gamma API
  console.log("\n--- Resolving trades without pmTokenId via Gamma API ---\n");
  const tradesNeedingLookup = tradesWithPm.filter(t => !t.pmTokenId && t.pmSlug);
  for (const trade of tradesNeedingLookup) {
    try {
      const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${trade.pmSlug}`);
      const markets = (await resp.json()) as Array<Record<string, unknown>>;
      if (markets.length > 0) {
        const clobTokenIds = String(markets[0].clobTokenIds ?? "");
        const tokens = clobTokenIds.replace(/[\[\]"]/g, "").split(",").map(s => s.trim()).filter(Boolean);

        let foundOnChain = false;
        for (const tok of tokens) {
          const chainData = byToken.get(tok);
          if (chainData && chainData.inQty > 0) {
            const chainShares = Math.round(chainData.inQty);
            const hasPmCost = trade.pmCost > 0 || trade.pmFillPrice > 0;
            if (hasPmCost) {
              if (Math.abs(chainShares - trade.shares) <= 1) {
                console.log(`  [OK] MATCH (via slug): ${trade.match} (${trade.dir}) -- log=${trade.shares} chain=${chainShares} pmCost=$${trade.pmCost.toFixed(2)}`);
                matched++;
              } else {
                console.log(`  [X] MISMATCH (via slug): ${trade.match} (${trade.dir}) -- log=${trade.shares} chain=${chainShares} pmCost=$${trade.pmCost.toFixed(2)}`);
                mismatches++;
              }
            } else {
              console.log(`  [!] ON-CHAIN (via slug): ${trade.match} (${trade.dir}) -- chain=${chainShares} shares but pmCost=$0 in log`);
              onChainButNotLogged++;
            }
            foundOnChain = true;
            break;
          }
        }
        if (!foundOnChain && (trade.pmCost > 0 || trade.pmFillPrice > 0)) {
          console.log(`  [!] NOT ON-CHAIN: ${trade.match} (${trade.dir}) -- pmCost=$${trade.pmCost.toFixed(2)} but no chain transfer found`);
          loggedButNotOnChain++;
        } else if (!foundOnChain && !trade.pmCost && !trade.pmFillPrice) {
          // No PM cost and no on-chain -- consistent, skip
        }
      }
      await new Promise(r => setTimeout(r, 300)); // rate limit gamma API
    } catch (e) {
      console.log(`  ERROR looking up ${trade.pmSlug}: ${(e as Error).message}`);
    }
  }

  // Step 7: Check for unmatched on-chain tokens
  console.log("\n--- Unmatched on-chain tokens (PM transfers not in trade log) ---\n");
  const allTradeTokenIds = new Set<string>();
  for (const t of trades) {
    if (t.pmTokenId) allTradeTokenIds.add(t.pmTokenId);
  }

  let unmatchedCount = 0;
  for (const [tokenId, chainData] of byToken) {
    if (chainData.inQty > 0 && !allTradeTokenIds.has(tokenId)) {
      // Look up market name
      const marketName = await lookupMarket(tokenId);
      if (marketName) {
        console.log(`  ? UNTRACKED: ${Math.round(chainData.inQty)} shares IN -- ${marketName}`);
        console.log(`    token=...${tokenId.slice(-15)} (${chainData.transfers.length} transfers)`);
        unmatchedCount++;
      }
      await new Promise(r => setTimeout(r, 300));
    }
  }
  if (unmatchedCount === 0) console.log("  (none)");

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  On-chain transfers scanned: ${allTransfers.length}`);
  console.log(`  Unique tokens: ${byToken.size}`);
  console.log(`  Trades with PM: ${tradesWithPm.length}`);
  console.log(`  [OK] Matched (shares agree): ${matched}`);
  console.log(`  [X] Mismatches (shares differ): ${mismatches}`);
  console.log(`  [!] On-chain but not logged (pmCost=0): ${onChainButNotLogged}`);
  console.log(`  [!] Logged but not on-chain: ${loggedButNotOnChain}`);
  console.log(`  ? Untracked on-chain tokens: ${unmatchedCount}`);
}

main().catch(e => console.error("Fatal:", e));
