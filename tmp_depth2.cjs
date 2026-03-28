const fs = require("fs");
const snaps = JSON.parse(fs.readFileSync("data/book_snapshots.json", "utf8"));
const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
const metrics = JSON.parse(fs.readFileSync("data/execution_metrics.json", "utf8"));
const today = trades.filter(t => new Date(t.ts) > new Date("2026-03-24T00:00:00Z"));

const execSnaps = snaps.filter(s => s.phase === "execution");
const discSnaps = snaps.filter(s => s.phase === "discovery");

function getBookState(sample, kalSide) {
  // To BUY yes: use kalYesAsks. To BUY no: use kalNoAsks.
  const kalAsks = kalSide === "yes" ? (sample.kalYesAsks || []) : (sample.kalNoAsks || []);
  const pmAsks = sample.pmAsks || [];
  const kalSorted = [...kalAsks].sort((a,b) => a[0] - b[0]);
  const pmSorted = [...pmAsks].sort((a,b) => a[0] - b[0]);

  // Cumulative depth at profitable levels
  let kalDepth = 0, kalCost = 0;
  let pmDepth = 0, pmCost = 0;
  const bestPm = pmSorted[0] ? pmSorted[0][0] : 1;
  const bestKal = kalSorted[0] ? kalSorted[0][0] / 100 : 1;

  for (const [p, q] of kalSorted) {
    if (p/100 + bestPm < 1.0) { kalDepth += q; kalCost += q * p / 100; }
  }
  for (const [p, q] of pmSorted) {
    if (bestKal + p < 1.0) { pmDepth += q; pmCost += q * p; }
  }

  return {
    kalBest: kalSorted[0] || null,
    pmBest: pmSorted[0] || null,
    kalTop5: kalSorted.slice(0, 5),
    pmTop5: pmSorted.slice(0, 5),
    kalDepth, pmDepth,
    arbDepth: Math.min(kalDepth, Math.round(pmDepth)),
    arbEdge: kalSorted[0] && pmSorted[0] ? 1 - (kalSorted[0][0]/100 + pmSorted[0][0]) : 0,
  };
}

// Match execution snapshots to trades
const matched = [];
for (const es of execSnaps) {
  const trade = today.find(t => {
    const dt = Math.abs(new Date(t.ts).getTime() - new Date(es.ts).getTime());
    return dt < 120000 && (t.kalTicker === es.kalTicker || (t.match && es.match && t.match.includes(es.match.substring(0,15))));
  });
  if (trade && !matched.find(m => m.trade.id === trade.id)) {
    const disc = discSnaps.find(s => s.match === es.match && s.dir === es.dir &&
      Math.abs(new Date(s.ts).getTime() - new Date(es.ts).getTime()) < 30000);
    // Find execution metric
    const metric = metrics.find(m => {
      const dt = Math.abs(new Date(m.ts).getTime() - new Date(trade.ts).getTime());
      return dt < 60000 && m.match === trade.match;
    });
    matched.push({ exec: es, disc, trade, metric });
  }
}

for (const { exec, disc, trade, metric } of matched) {
  const kalSide = ["C","D","G","H","I"].includes(exec.dir) ? "no" : "yes";
  const snapStartMs = new Date(exec.ts).getTime();
  const tradeMs = new Date(trade.ts).getTime();
  const tradeOffset = tradeMs - snapStartMs;

  console.log("\n" + "=".repeat(110));
  console.log("  " + trade.match);
  console.log("  Bought " + trade.shares + " shares | KAL $" + trade.kalCost + " + PM $" + trade.pmCost + " = $" + trade.totalCost + " | P&L $" + (trade.realizedPnl||"?"));
  console.log("  Trade ts: " + trade.ts.substring(11,23) + " | Snap start: " + exec.ts.substring(11,23) + " | Offset: " + tradeOffset + "ms");
  if (metric) {
    console.log("  Execution timing: total=" + metric.totalMs + "ms, 1st leg=" + metric.firstLegOrderMs + "ms, 2nd leg=" + metric.secondLegOrderMs + "ms, firstLeg=" + metric.firstLeg);
  }
  console.log("=".repeat(110));

  const samples = exec.samples;

  // Find key moments:
  // 1. First sample (execution snapshot begins)
  // 2. Sample closest to trade timestamp (when order was placed)
  // 3. Sample ~2s after trade (when fills likely confirmed)
  // 4. Sample ~5s after trade
  // 5. Last sample (+20s)

  const moments = [
    { label: "Snapshot start (t=0)", offset: 0 },
  ];

  if (metric) {
    // First leg order sent
    moments.push({ label: "1st leg ORDER sent", offset: metric.firstLegOrderMs || tradeOffset });
    // First leg confirmed
    moments.push({ label: "1st leg CONFIRMED", offset: (metric.firstLegOrderMs || 0) + (metric.firstLegConfirmMs || 0) });
    // Second leg order sent
    moments.push({ label: "2nd leg ORDER sent", offset: (metric.firstLegOrderMs||0) + (metric.firstLegConfirmMs||0) + (metric.secondLegOrderMs||0) });
    // Second leg confirmed
    moments.push({ label: "2nd leg CONFIRMED", offset: (metric.firstLegOrderMs||0) + (metric.firstLegConfirmMs||0) + (metric.secondLegOrderMs||0) + (metric.secondLegConfirmMs||0) });
  } else {
    moments.push({ label: "Trade timestamp", offset: tradeOffset });
    moments.push({ label: "+2s after trade", offset: tradeOffset + 2000 });
    moments.push({ label: "+5s after trade", offset: tradeOffset + 5000 });
  }

  moments.push({ label: "+10s", offset: 10000 });
  moments.push({ label: "+20s (end)", offset: 20000 });

  for (const moment of moments) {
    // Find closest sample
    let bestSample = samples[0];
    let bestDist = Infinity;
    for (const s of samples) {
      const dist = Math.abs(s.t - moment.offset);
      if (dist < bestDist) { bestDist = dist; bestSample = s; }
    }

    if (!bestSample) continue;
    const state = getBookState(bestSample, kalSide);

    const kalBestStr = state.kalBest ? state.kalBest[0] + "c x" + state.kalBest[1] : "EMPTY";
    const pmBestStr = state.pmBest ? (state.pmBest[0]*100).toFixed(0) + "c x" + Math.round(state.pmBest[1]) : "EMPTY";
    const edgeStr = state.arbEdge > 0 ? (state.arbEdge * 100).toFixed(2) + "%" : "NONE";

    console.log("\n  " + moment.label + " (t=" + moment.offset + "ms, sample t=" + bestSample.t + "ms):");
    console.log("    KAL " + kalSide.toUpperCase() + " asks: " + state.kalTop5.map(l => l[0] + "c x" + l[1]).join(" | "));
    console.log("    PM asks:       " + state.pmTop5.map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | "));
    console.log("    Best arb: " + kalBestStr + " + " + pmBestStr + " = edge " + edgeStr);
    console.log("    Profitable depth: KAL " + state.kalDepth + " contracts | PM " + Math.round(state.pmDepth) + " shares → arb " + state.arbDepth + " shares");
  }

  // Summary: what changed
  const s0 = getBookState(samples[0], kalSide);
  const sLast = getBookState(samples[samples.length - 1], kalSide);

  console.log("\n  SUMMARY:");
  console.log("    Depth BEFORE: " + s0.arbDepth + " shares at " + (s0.arbEdge*100).toFixed(2) + "% edge");
  console.log("    Depth AFTER:  " + sLast.arbDepth + " shares at " + (sLast.arbEdge > 0 ? (sLast.arbEdge*100).toFixed(2) + "% edge" : "NO EDGE"));
  console.log("    We took: " + trade.shares + " shares (" + (trade.shares / Math.max(1, s0.arbDepth) * 100).toFixed(1) + "% of available)");
  const depthConsumed = s0.arbDepth - sLast.arbDepth;
  console.log("    Depth consumed (by us + others): " + depthConsumed + " shares in 20s window");
  if (sLast.arbDepth > 0 && sLast.arbEdge > 0) {
    console.log("    STILL PROFITABLE: " + sLast.arbDepth + " more shares could be arbed at " + (sLast.arbEdge*100).toFixed(2) + "% edge → $" + (sLast.arbDepth * sLast.arbEdge).toFixed(2) + " potential profit");
  }
}

console.log("\n\nDone.");
