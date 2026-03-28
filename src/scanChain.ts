/**
 * scanChain.ts — Scan Polygon for PM conditional token transfers to/from our wallet.
 * Uses free RPC with 10k block pagination.
 * Usage: npx tsx src/scanChain.ts [daysBack]
 */
import dotenv from "dotenv";
dotenv.config();

const RPC = "https://polygon.drpc.org";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const WALLET = (process.env.POLY_FUNDER ?? "").toLowerCase();
const WALLET_PADDED = "0x" + "0".repeat(24) + WALLET.replace("0x", "");

// TransferSingle(address operator, address from, address to, uint256 id, uint256 value)
const TOPIC_SINGLE = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
// TransferBatch(address operator, address from, address to, uint256[] ids, uint256[] values)
const TOPIC_BATCH = "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

const DAYS_BACK = Number(process.argv[2] ?? 7);
const BLOCKS_PER_CHUNK = 9999;
// Polygon ~2s per block
const BLOCKS_PER_DAY = Math.floor(86400 / 2);

interface Transfer {
  block: number;
  tx: string;
  tokenId: string;
  qty: number;
  direction: "IN" | "OUT";
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

async function getBlockTimestamp(blockNum: number): Promise<number> {
  const block = (await rpcCall("eth_getBlockByNumber", ["0x" + blockNum.toString(16), false])) as Record<string, string> | null;
  if (!block) return 0;
  return parseInt(block.timestamp, 16);
}

async function getLogs(fromBlock: number, toBlock: number, toOrFrom: "to" | "from"): Promise<Transfer[]> {
  // topic[2]=from, topic[3]=to
  const topics: (string | null)[] = [TOPIC_SINGLE, null, null, null];
  if (toOrFrom === "to") topics[3] = WALLET_PADDED;
  else topics[2] = WALLET_PADDED;

  const result = (await rpcCall("eth_getLogs", [{
    fromBlock: "0x" + fromBlock.toString(16),
    toBlock: "0x" + toBlock.toString(16),
    address: CTF,
    topics,
  }])) as Array<{ blockNumber: string; transactionHash: string; data: string; topics: string[] }>;

  return result.map(log => {
    const block = parseInt(log.blockNumber, 16);
    const raw = log.data.slice(2);
    const tokenId = BigInt("0x" + raw.slice(0, 64)).toString();
    const qty = Number(BigInt("0x" + raw.slice(64, 128)));
    return {
      block,
      tx: log.transactionHash,
      tokenId,
      qty: qty / 1e6, // USDC has 6 decimals; CTF tokens are in raw units
      direction: toOrFrom === "to" ? "IN" as const : "OUT" as const,
    };
  });
}

async function main() {
  console.log(`Wallet: ${WALLET}`);
  console.log(`Scanning last ${DAYS_BACK} days for PM token transfers...\n`);

  const latestHex = (await rpcCall("eth_blockNumber", [])) as string;
  const latest = parseInt(latestHex, 16);
  const startBlock = latest - BLOCKS_PER_DAY * DAYS_BACK;
  console.log(`Block range: ${startBlock} → ${latest} (${latest - startBlock} blocks)\n`);

  const allTransfers: Transfer[] = [];

  for (let from = startBlock; from <= latest; from += BLOCKS_PER_CHUNK + 1) {
    const to = Math.min(from + BLOCKS_PER_CHUNK, latest);
    process.stdout.write(`  Scanning ${from}..${to} ...`);

    try {
      const [inTx, outTx] = await Promise.all([
        getLogs(from, to, "to"),
        getLogs(from, to, "from"),
      ]);
      allTransfers.push(...inTx, ...outTx);
      console.log(` ${inTx.length} in, ${outTx.length} out`);
    } catch (e) {
      console.log(` ERROR: ${(e as Error).message.slice(0, 80)}`);
    }

    // Rate limit: small delay between chunks
    await new Promise(r => setTimeout(r, 200));
  }

  // Sort by block
  allTransfers.sort((a, b) => a.block - b.block);

  // Group by tokenId
  const byToken = new Map<string, Transfer[]>();
  for (const t of allTransfers) {
    const list = byToken.get(t.tokenId) ?? [];
    list.push(t);
    byToken.set(t.tokenId, list);
  }

  console.log(`\n=== RESULTS: ${allTransfers.length} transfers across ${byToken.size} tokens ===\n`);

  // Load market data for token ID matching
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  let trades: Array<Record<string, unknown>> = [];
  try {
    trades = JSON.parse(readFileSync(join(process.cwd(), "data", "arb_trades.json"), "utf8"));
  } catch { /* no trades file */ }

  // Resolve token IDs to market names by fetching from gamma API
  for (const [tokenId, transfers] of byToken) {
    const totalIn = transfers.filter(t => t.direction === "IN").reduce((s, t) => s + t.qty, 0);
    const totalOut = transfers.filter(t => t.direction === "OUT").reduce((s, t) => s + t.qty, 0);

    // Try to get a timestamp for the first transfer
    let ts = "";
    try {
      const epoch = await getBlockTimestamp(transfers[0].block);
      ts = new Date(epoch * 1000).toISOString().slice(0, 19);
    } catch { /* */ }

    // Try to match to a trade
    let matchLabel = "";
    // Search gamma API for this token
    try {
      const resp = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}&closed=true`);
      const markets = (await resp.json()) as Array<Record<string, unknown>>;
      if (markets.length > 0) {
        matchLabel = String(markets[0].question ?? markets[0].slug ?? "");
      }
    } catch { /* */ }
    if (!matchLabel) {
      try {
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${tokenId}`);
        const markets = (await resp.json()) as Array<Record<string, unknown>>;
        if (markets.length > 0) {
          matchLabel = String(markets[0].question ?? markets[0].slug ?? "");
        }
      } catch { /* */ }
    }

    console.log(`Token: ...${tokenId.slice(-15)}`);
    if (matchLabel) console.log(`  Market: ${matchLabel}`);
    console.log(`  IN: ${totalIn.toFixed(1)} shares | OUT: ${totalOut.toFixed(1)} shares | Net: ${(totalIn - totalOut).toFixed(1)}`);
    console.log(`  First: block ${transfers[0].block} (${ts}) | Txns: ${transfers.length}`);

    // Match against arb_trades
    for (const trade of trades) {
      // Check if any PM token from this trade matches
      const slug = String(trade.pmSlug ?? "");
      const outcome = String(trade.pmOutcome ?? "");
      if (slug && matchLabel.toLowerCase().includes(slug.split("-").slice(0, 3).join("-"))) {
        console.log(`  → MATCHED TRADE: ${trade.match} dir=${trade.dir} shares=${trade.shares} pmCost=$${trade.pmCost}`);
      }
    }
    console.log("");
  }
}

main().catch(e => console.error("Fatal:", e));
