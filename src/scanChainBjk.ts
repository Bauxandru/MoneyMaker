/**
 * Targeted scan for BJK/S2G Map1 token transfers around March 2 12:00 UTC.
 */
const RPC = "https://polygon.drpc.org";
const CTF = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const WALLET = "0xba27693a36f959e5ad3a6b3819660f1a75523f88";
const WALLET_PADDED = "0x" + "0".repeat(24) + WALLET.replace("0x", "");
const TOPIC0 = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";

// BJK/S2G Map 1 token IDs
const BJK_TOKEN = "6607037505759920059943393228010876340186704151014066144081247559815914173647";
const S2G_TOKEN = "113545155468797499826868080069115255722779899978715473646718982012321127905222";

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function scanChunk(from: number, to: number, dir: "IN" | "OUT") {
  const topics: (string | null)[] = [TOPIC0, null, null, null];
  if (dir === "IN") topics[3] = WALLET_PADDED;
  else topics[2] = WALLET_PADDED;

  const logs = (await rpc("eth_getLogs", [{
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + to.toString(16),
    address: CTF,
    topics,
  }])) as Array<{ blockNumber: string; transactionHash: string; data: string }>;

  return logs.map(log => {
    const raw = log.data.slice(2);
    const tokenId = BigInt("0x" + raw.slice(0, 64)).toString();
    const qty = Number(BigInt("0x" + raw.slice(64, 128))) / 1e6;
    return {
      block: parseInt(log.blockNumber, 16),
      tx: log.transactionHash,
      tokenId,
      qty,
      dir,
      isBjk: tokenId === BJK_TOKEN || tokenId === S2G_TOKEN,
    };
  });
}

async function main() {
  // March 2 ~09:00-15:00 UTC = blocks ~83660000-83672000
  // Scan wider range to be safe: 83655000-83680000 in 5k chunks
  const START = 83655000;
  const END = 83685000;
  const CHUNK = 5000;

  console.log(`Scanning blocks ${START}..${END} for ALL PM transfers (looking for BJK/S2G)...\n`);

  let allIn: typeof scanChunk extends (...args: unknown[]) => Promise<infer R> ? R : never = [];
  let allOut: typeof allIn = [];

  for (let from = START; from < END; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, END);
    process.stdout.write(`  ${from}..${to}: `);
    try {
      const [inTx, outTx] = await Promise.all([
        scanChunk(from, to, "IN"),
        scanChunk(from, to, "OUT"),
      ]);
      const bjkIn = inTx.filter(t => t.isBjk);
      const bjkOut = outTx.filter(t => t.isBjk);
      console.log(`${inTx.length} in, ${outTx.length} out${bjkIn.length || bjkOut.length ? " *** BJK/S2G FOUND ***" : ""}`);
      allIn.push(...inTx);
      allOut.push(...outTx);
    } catch (e) {
      console.log(`ERROR: ${(e as Error).message.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // Check for BJK/S2G specifically
  const bjkTransfers = [...allIn, ...allOut].filter(t => t.isBjk);
  console.log(`\n=== BJK/S2G Map1 Tokens ===`);
  if (bjkTransfers.length === 0) {
    console.log("NO TRANSFERS FOUND — PM never filled for BJK/S2G Map 1.");
  } else {
    for (const t of bjkTransfers) {
      const which = t.tokenId === BJK_TOKEN ? "Besiktas" : "S2G";
      console.log(`  ${t.dir} ${which} qty=${t.qty} block=${t.block} tx=${t.tx}`);
    }
  }

  // Also show all transfers in this period for context
  console.log(`\nAll ${allIn.length + allOut.length} transfers in range:`);
  const all = [...allIn, ...allOut].sort((a, b) => a.block - b.block);
  for (const t of all) {
    const mark = t.isBjk ? " *** BJK ***" : "";
    console.log(`  ${t.dir.padEnd(3)} block=${t.block} qty=${t.qty.toFixed(1)} token=...${t.tokenId.slice(-12)}${mark}`);
  }
}

main().catch(e => console.error("Fatal:", e));
