const fs = require("fs");
const snaps = JSON.parse(fs.readFileSync("data/book_snapshots.json", "utf8"));
const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
const today = trades.filter(t => new Date(t.ts) > new Date("2026-03-24T00:00:00Z"));

const execSnaps = snaps.filter(s => s.phase === "execution");
const discSnaps = snaps.filter(s => s.phase === "discovery");

function analyzeBook(snap, trade) {
  const dir = snap.dir;
  const kalSide = ["C","D","G","H","I"].includes(dir) ? "no" : "yes";
  const samples = snap.samples;
  if (!samples.length) return null;

  const s0 = samples[0];
  const sLast = samples[samples.length - 1];

  // What we BUY on KAL
  const kalAsks = kalSide === "no" ? (s0.kalNoBids || []) : (s0.kalYesAsks || []);
  // Wait — kalNoBids are people wanting to buy NO = liquidity we sell into
  // Actually for buying: we need asks. kalYesAsks = derived from noBids (100-noBidPrice).
  // kalNoAsks = derived from yesBids (100-yesBidPrice).
  // So to BUY yes: use kalYesAsks. To BUY no: use kalNoAsks.
  const kalAskBook = kalSide === "yes" ? (s0.kalYesAsks || []) : (s0.kalNoAsks || []);
  const pmAskBook = (s0.pmAsks || []);

  const kalAsksSorted = [...kalAskBook].sort((a,b) => a[0] - b[0]);
  const pmAsksSorted = [...pmAskBook].sort((a,b) => a[0] - b[0]);

  if (!kalAsksSorted.length || !pmAsksSorted.length) return null;

  const bestKalAsk = kalAsksSorted[0][0]; // cents
  const bestPmAsk = pmAsksSorted[0][0];   // dollars
  const arbCostPerShare = bestKalAsk / 100 + bestPmAsk;
  const edge = 1 - arbCostPerShare;

  // Calculate cumulative depth: how many shares at what cost
  function cumulativeDepth(kalAsks, pmAsks) {
    // Build price ladder for the arb
    // At each KAL price level, pair with cheapest available PM
    const results = [];
    let kalCum = 0, pmCum = 0;
    let kalCumCost = 0, pmCumCost = 0;
    let ki = 0, pi = 0;
    let kalUsed = 0, pmUsed = 0;

    // Simple approach: walk through both order books simultaneously
    // The arb size is limited by min(KAL depth, PM depth) at each price level
    const kalLevels = kalAsks.map(([p,q]) => ({ price: p/100, qty: q }));
    const pmLevels = pmAsks.map(([p,q]) => ({ price: p, qty: q }));

    let kalTotal = 0, pmTotal = 0, totalCost = 0;
    let kalI = 0, pmI = 0;
    let kalRemain = kalLevels[0] ? kalLevels[0].qty : 0;
    let pmRemain = pmLevels[0] ? pmLevels[0].qty : 0;

    while (kalI < kalLevels.length && pmI < pmLevels.length) {
      const kp = kalLevels[kalI].price;
      const pp = pmLevels[pmI].price;
      const combinedCost = kp + pp;

      if (combinedCost >= 1.0) break; // No more profitable arb

      const fillSize = Math.min(kalRemain, Math.round(pmRemain));
      if (fillSize <= 0) {
        if (kalRemain <= 0) { kalI++; kalRemain = kalI < kalLevels.length ? kalLevels[kalI].qty : 0; }
        if (pmRemain <= 0) { pmI++; pmRemain = pmI < pmLevels.length ? pmLevels[pmI].qty : 0; }
        continue;
      }

      kalTotal += fillSize;
      pmTotal += fillSize;
      totalCost += fillSize * combinedCost;
      kalRemain -= fillSize;
      pmRemain -= fillSize;

      results.push({
        shares: kalTotal,
        costPerShare: combinedCost,
        totalCost: totalCost,
        edge: 1 - combinedCost,
        profit: kalTotal - totalCost,
      });

      if (kalRemain <= 0) { kalI++; kalRemain = kalI < kalLevels.length ? kalLevels[kalI].qty : 0; }
      if (Math.round(pmRemain) <= 0) { pmI++; pmRemain = pmI < pmLevels.length ? pmLevels[pmI].qty : 0; }
    }
    return results;
  }

  const depth = cumulativeDepth(kalAsksSorted, pmAsksSorted);
  const maxEntry = depth.length > 0 ? depth[depth.length - 1] : null;

  // After trade (last sample)
  const kalAskAfter = kalSide === "yes" ? (sLast.kalYesAsks || []) : (sLast.kalNoAsks || []);
  const pmAskAfter = sLast.pmAsks || [];
  const kalAfterSorted = [...kalAskAfter].sort((a,b) => a[0] - b[0]);
  const pmAfterSorted = [...pmAskAfter].sort((a,b) => a[0] - b[0]);
  const depthAfter = cumulativeDepth(kalAfterSorted, pmAfterSorted);
  const maxAfter = depthAfter.length > 0 ? depthAfter[depthAfter.length - 1] : null;

  return {
    kalSide, bestKalAsk, bestPmAsk, arbCostPerShare, edge,
    kalTopLevels: kalAsksSorted.slice(0,6),
    pmTopLevels: pmAsksSorted.slice(0,6),
    depth,
    maxShares: maxEntry ? maxEntry.shares : 0,
    maxProfit: maxEntry ? maxEntry.profit : 0,
    maxTotalCost: maxEntry ? maxEntry.totalCost : 0,
    afterBestKal: kalAfterSorted[0] || null,
    afterBestPm: pmAfterSorted[0] || null,
    afterMaxShares: maxAfter ? maxAfter.shares : 0,
    afterMaxProfit: maxAfter ? maxAfter.profit : 0,
  };
}

// Find matched pairs
const matched = [];
for (const es of execSnaps) {
  const trade = today.find(t => {
    const dt = Math.abs(new Date(t.ts).getTime() - new Date(es.ts).getTime());
    return dt < 120000 && (t.kalTicker === es.kalTicker || (t.match && es.match && t.match.includes(es.match.substring(0,15))));
  });
  if (trade && !matched.find(m => m.trade.id === trade.id)) {
    // Find corresponding discovery snapshot
    const disc = discSnaps.find(s => s.match === es.match && s.dir === es.dir &&
      Math.abs(new Date(s.ts).getTime() - new Date(es.ts).getTime()) < 30000);
    matched.push({ exec: es, disc, trade });
  }
}

console.log("DEPTH ANALYSIS — " + matched.length + " trades with execution snapshots\n");

for (const m of matched) {
  const { exec, disc, trade } = m;

  console.log("═".repeat(110));
  console.log("  " + trade.match);
  console.log("  " + trade.shares + " shares | KAL $" + trade.kalCost + " + PM $" + trade.pmCost + " = $" + trade.totalCost + " | P&L $" + (trade.realizedPnl||"?"));
  console.log("═".repeat(110));

  if (disc) {
    const d = analyzeBook(disc, trade);
    if (d) {
      console.log("\n  📡 DISCOVERY (" + disc.ts.substring(11,19) + "):");
      console.log("    Best arb: KAL " + d.bestKalAsk + "c + PM " + (d.bestPmAsk*100).toFixed(0) + "c = " + (d.arbCostPerShare*100).toFixed(1) + "c/share → edge " + (d.edge*100).toFixed(2) + "%");
      console.log("    KAL asks: " + d.kalTopLevels.map(l => l[0] + "c x" + l[1]).join(" | "));
      console.log("    PM  asks: " + d.pmTopLevels.map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | "));
      console.log("    Max profitable arb: " + d.maxShares + " shares, profit $" + d.maxProfit.toFixed(2) + ", capital needed $" + d.maxTotalCost.toFixed(2));
    }
  }

  const e = analyzeBook(exec, trade);
  if (e) {
    console.log("\n  ⚡ EXECUTION (" + exec.ts.substring(11,19) + "):");
    console.log("    Best arb: KAL " + e.bestKalAsk + "c + PM " + (e.bestPmAsk*100).toFixed(0) + "c = " + (e.arbCostPerShare*100).toFixed(1) + "c/share → edge " + (e.edge*100).toFixed(2) + "%");
    console.log("    KAL asks: " + e.kalTopLevels.map(l => l[0] + "c x" + l[1]).join(" | "));
    console.log("    PM  asks: " + e.pmTopLevels.map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | "));
    console.log("    Max profitable arb: " + e.maxShares + " shares, profit $" + e.maxProfit.toFixed(2) + ", capital needed $" + e.maxTotalCost.toFixed(2));

    // Depth table
    if (e.depth.length > 0) {
      console.log("\n    DEPTH LADDER (how much more capital → how much more profit):");
      console.log("    " + "Shares".padEnd(10) + "Cost/sh".padEnd(10) + "Total $".padEnd(12) + "Edge".padEnd(10) + "Profit $");
      console.log("    " + "-".repeat(52));
      const milestones = [11, 25, 50, 100, 250, 500, 1000];
      let lastPrinted = 0;
      for (const level of e.depth) {
        const shouldPrint = milestones.some(ms => level.shares >= ms && lastPrinted < ms) || level === e.depth[e.depth.length-1];
        if (shouldPrint) {
          const marker = level.shares <= trade.shares ? " ◄ WE ARE HERE" : "";
          console.log("    " + (level.shares+"").padEnd(10) + (level.costPerShare.toFixed(4)).padEnd(10) + ("$"+level.totalCost.toFixed(2)).padEnd(12) + ((level.edge*100).toFixed(2)+"%").padEnd(10) + "$" + level.profit.toFixed(2) + marker);
          lastPrinted = level.shares;
        }
      }
    }

    console.log("\n  📉 AFTER OUR TRADE (+20s, last sample):");
    if (e.afterBestKal && e.afterBestPm) {
      const afterCost = e.afterBestKal[0]/100 + e.afterBestPm[0];
      const afterEdge = 1 - afterCost;
      console.log("    KAL best: " + e.afterBestKal[0] + "c x" + e.afterBestKal[1] + " | PM best: " + (e.afterBestPm[0]*100).toFixed(0) + "c x" + Math.round(e.afterBestPm[1]));
      console.log("    Remaining arb: " + (afterEdge > 0 ? (afterEdge*100).toFixed(2) + "% edge, " + e.afterMaxShares + " shares, $" + e.afterMaxProfit.toFixed(2) + " profit" : "GONE (spread closed)"));
    } else {
      console.log("    No asks remaining on one side");
    }

    console.log("\n  💰 CAPITAL EFFICIENCY:");
    console.log("    We traded: " + trade.shares + " / " + e.maxShares + " available (" + (trade.shares/Math.max(1,e.maxShares)*100).toFixed(0) + "%)");
    if (e.maxShares > trade.shares) {
      const extraProfit = e.maxProfit - (trade.realizedPnl || 0);
      console.log("    Missed profit: $" + extraProfit.toFixed(2) + " (if we filled all " + e.maxShares + " shares)");
    }
  }
  console.log("");
}

// Clean up
console.log("\nDone. " + matched.length + " trades analyzed.");
