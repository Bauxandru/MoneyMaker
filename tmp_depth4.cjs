const fs = require("fs");
const snaps = JSON.parse(fs.readFileSync("data/book_snapshots.json", "utf8"));
const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
const metrics = JSON.parse(fs.readFileSync("data/execution_metrics.json", "utf8"));
const today = trades.filter(t => new Date(t.ts) > new Date("2026-03-24T00:00:00Z"));

const execSnaps = snaps.filter(s => s.phase === "execution");
const discSnaps = snaps.filter(s => s.phase === "discovery");

function getDepthDetail(sample, kalSide) {
  const kalAsks = kalSide === "yes" ? (sample.kalYesAsks || []) : (sample.kalNoAsks || []);
  const pmAsks = sample.pmAsks || [];
  const kalSorted = [...kalAsks].sort((a,b) => a[0] - b[0]);
  const pmSorted = [...pmAsks].sort((a,b) => a[0] - b[0]);

  const bestKal = kalSorted[0] ? kalSorted[0][0] / 100 : 1;
  const bestPm = pmSorted[0] ? pmSorted[0][0] : 1;
  const edge = 1 - (bestKal + bestPm);

  // Profitable depth per level
  let kalDepth = 0, pmDepth = 0;
  const kalLevels = [];
  const pmLevels = [];
  for (const [p, q] of kalSorted) {
    if (p/100 + bestPm < 1.0) { kalDepth += q; kalLevels.push([p, q]); }
  }
  for (const [p, q] of pmSorted) {
    if (bestKal + p < 1.0) { pmDepth += q; pmLevels.push([p, q]); }
  }

  return {
    edge: edge > 0 ? edge : 0,
    arbDepth: Math.min(kalDepth, Math.round(pmDepth)),
    kalDepth, pmDepth: Math.round(pmDepth),
    kalBest: kalSorted[0] || null,
    pmBest: pmSorted[0] || null,
    kalLevels,
    pmLevels,
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
    // Find discovery snapshot for comparison
    const disc = discSnaps.find(s => s.match === es.match && s.dir === es.dir &&
      Math.abs(new Date(s.ts).getTime() - new Date(es.ts).getTime()) < 60000);
    const metric = metrics.find(m => {
      const dt = Math.abs(new Date(m.ts).getTime() - new Date(trade.ts).getTime());
      return dt < 60000 && m.match === trade.match;
    });
    matched.push({ exec: es, disc, trade, metric });
  }
}

for (const { exec, disc, trade, metric } of matched) {
  const kalSide = ["C","D","G","H","I"].includes(exec.dir) ? "no" : "yes";
  const samples = exec.samples;
  if (!samples || samples.length === 0) continue;

  console.log("\n" + "=".repeat(120));
  console.log("  " + trade.match);
  console.log("  We took: " + trade.shares + " shares | firstLeg=" + (metric ? metric.firstLeg : "?"));
  if (metric) {
    console.log("  Timing: 1st order@" + metric.firstLegOrderMs + "ms, 1st confirm@" + (metric.firstLegOrderMs + metric.firstLegConfirmMs) + "ms, 2nd order@" + (metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs) + "ms, 2nd confirm@" + (metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs + metric.secondLegConfirmMs) + "ms");
  }
  console.log("=".repeat(120));

  // Discovery snapshot — the moment we FOUND the arb
  if (disc && disc.samples && disc.samples.length > 0) {
    const discFirst = disc.samples[0];
    const discState = getDepthDetail(discFirst, kalSide);
    console.log("\n  [DISCOVERY] When we first spotted the arb:");
    console.log("    KAL " + kalSide.toUpperCase() + " asks: " + discState.kalLevels.map(l => l[0] + "c x" + l[1]).join(" | "));
    console.log("    PM asks:       " + discState.pmLevels.map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | "));
    console.log("    Edge: " + (discState.edge * 100).toFixed(1) + "% | Depth: " + discState.arbDepth + " shares (KAL " + discState.kalDepth + ", PM " + discState.pmDepth + ")");
  }

  // Execution snapshot start (t=0) — when execution phase begins
  const execStart = getDepthDetail(samples[0], kalSide);
  console.log("\n  [EXEC START t=0] When execution snapshot begins:");
  console.log("    KAL " + kalSide.toUpperCase() + " asks: " + execStart.kalLevels.map(l => l[0] + "c x" + l[1]).join(" | "));
  console.log("    PM asks:       " + execStart.pmLevels.map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | "));
  console.log("    Edge: " + (execStart.edge * 100).toFixed(1) + "% | Depth: " + execStart.arbDepth + " shares (KAL " + execStart.kalDepth + ", PM " + execStart.pmDepth + ")");

  // Compare discovery vs exec start
  if (disc && disc.samples && disc.samples.length > 0) {
    const discState = getDepthDetail(disc.samples[0], kalSide);
    const kalDiff = execStart.kalDepth - discState.kalDepth;
    const pmDiff = execStart.pmDepth - discState.pmDepth;
    const arbDiff = execStart.arbDepth - discState.arbDepth;
    if (arbDiff !== 0) {
      console.log("    >>> Between discovery and exec start: depth changed by " + arbDiff + " shares (KAL " + (kalDiff >= 0 ? "+" : "") + kalDiff + ", PM " + (pmDiff >= 0 ? "+" : "") + pmDiff + ")");
      if (arbDiff < 0) console.log("    >>> SOMEONE TOOK " + Math.abs(arbDiff) + " shares before us!");
      else console.log("    >>> More depth appeared (+" + arbDiff + " shares)");
    } else {
      console.log("    >>> No change between discovery and exec start — we are first to the book");
    }
  }

  // Now scan all samples to find: when did depth change relative to our order times?
  if (metric) {
    const orderT = metric.firstLegOrderMs;  // when our first order was sent
    const confirmT = metric.firstLegOrderMs + metric.firstLegConfirmMs;
    const order2T = metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs;
    const confirm2T = order2T + metric.secondLegConfirmMs;

    // Find sample right before our first order
    let preOrderSample = samples[0];
    let preOrderState = execStart;
    for (const s of samples) {
      if (s.t <= orderT) {
        preOrderSample = s;
        preOrderState = getDepthDetail(s, kalSide);
      } else break;
    }

    // Find sample right after our first order (but before confirm)
    let postOrderState = null;
    for (const s of samples) {
      if (s.t > orderT && s.t <= orderT + 500) {
        postOrderState = getDepthDetail(s, kalSide);
        break;
      }
    }

    // Find sample at first confirm
    let atConfirmState = null;
    let atConfirmT = null;
    for (const s of samples) {
      if (Math.abs(s.t - confirmT) < 300) {
        atConfirmState = getDepthDetail(s, kalSide);
        atConfirmT = s.t;
        break;
      }
    }

    // Find sample at second order
    let atOrder2State = null;
    for (const s of samples) {
      if (Math.abs(s.t - order2T) < 300) {
        atOrder2State = getDepthDetail(s, kalSide);
        break;
      }
    }

    console.log("\n  [PRE-ORDER t=" + preOrderSample.t + "ms] Right before our 1st order:");
    console.log("    Edge: " + (preOrderState.edge * 100).toFixed(1) + "% | Depth: " + preOrderState.arbDepth + " shares (KAL " + preOrderState.kalDepth + ", PM " + preOrderState.pmDepth + ")");

    // Check if anyone took shares between exec start and our order
    const preOrderDiff = preOrderState.arbDepth - execStart.arbDepth;
    if (preOrderSample.t > 100 && preOrderDiff !== 0) {
      console.log("    >>> Between t=0 and our order: depth changed by " + preOrderDiff + " (others " + (preOrderDiff < 0 ? "took " + Math.abs(preOrderDiff) : "added " + preOrderDiff) + " shares)");
    }

    if (postOrderState) {
      const leg = metric.firstLeg;
      const exchange = leg === "pm" ? "PM" : "KAL";
      console.log("\n  [POST-1ST-ORDER] Right after our 1st order (" + exchange + "):");
      console.log("    Edge: " + (postOrderState.edge > 0 ? (postOrderState.edge * 100).toFixed(1) + "%" : "GONE") + " | Depth: " + postOrderState.arbDepth + " shares (KAL " + postOrderState.kalDepth + ", PM " + postOrderState.pmDepth + ")");
      const depthChange = postOrderState.arbDepth - preOrderState.arbDepth;
      if (depthChange !== 0) {
        console.log("    >>> Immediate impact: " + depthChange + " shares (" + (depthChange < 0 ? "OUR ORDER likely consumed " + Math.abs(depthChange) : "depth appeared?") + ")");
      }
    }

    if (atConfirmState) {
      console.log("\n  [1ST CONFIRM t=" + atConfirmT + "ms] When 1st leg confirmed:");
      console.log("    Edge: " + (atConfirmState.edge > 0 ? (atConfirmState.edge * 100).toFixed(1) + "%" : "GONE") + " | Depth: " + atConfirmState.arbDepth + " shares (KAL " + atConfirmState.kalDepth + ", PM " + atConfirmState.pmDepth + ")");
      const sincePre = atConfirmState.arbDepth - preOrderState.arbDepth;
      console.log("    >>> Since pre-order: " + sincePre + " shares change (includes our fill of ~" + trade.shares + " + any others)");
      const othersEstimate = Math.abs(sincePre) - trade.shares;
      if (othersEstimate > 0) {
        console.log("    >>> Estimated others took: ~" + othersEstimate + " shares in same window");
      } else if (sincePre === 0 && atConfirmState.arbDepth === preOrderState.arbDepth) {
        console.log("    >>> Our order didn't move the book yet — fills may not show in orderbook yet");
      }
    }

    if (atOrder2State) {
      console.log("\n  [2ND ORDER t~" + order2T + "ms]:");
      console.log("    Edge: " + (atOrder2State.edge > 0 ? (atOrder2State.edge * 100).toFixed(1) + "%" : "GONE") + " | Depth: " + atOrder2State.arbDepth + " shares");
    }
  }

  // Scan every sample for exact moment depth drops
  console.log("\n  [FULL DEPTH TIMELINE] Every significant change:");
  let prev = null;
  let prevT = 0;
  for (const s of samples) {
    const state = getDepthDetail(s, kalSide);
    if (prev === null || state.arbDepth !== prev.arbDepth || (state.edge > 0) !== (prev.edge > 0)) {
      const change = prev ? state.arbDepth - prev.arbDepth : 0;
      const changeStr = prev ? (change >= 0 ? "+" + change : "" + change) : "init";
      const dt = s.t - prevT;

      // Only show significant changes or first/last
      if (prev === null || Math.abs(change) >= 2 || state.arbDepth === 0 || (prev && prev.arbDepth === 0 && state.arbDepth > 0)) {
        const edgeStr = state.edge > 0 ? (state.edge * 100).toFixed(1) + "%" : "GONE";
        let annotation = "";
        if (metric) {
          if (Math.abs(s.t - metric.firstLegOrderMs) < 200) annotation = " ← 1ST ORDER SENT";
          else if (Math.abs(s.t - (metric.firstLegOrderMs + metric.firstLegConfirmMs)) < 200) annotation = " ← 1ST CONFIRMED";
          else if (Math.abs(s.t - (metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs)) < 200) annotation = " ← 2ND ORDER SENT";
        }
        console.log("    t=" + String(s.t).padStart(6) + "ms  depth=" + String(state.arbDepth).padStart(4) + "  (" + changeStr.padStart(5) + ")  edge=" + edgeStr.padEnd(6) + "  Δt=" + String(dt).padStart(5) + "ms" + annotation);
      }
      prevT = s.t;
    }
    prev = state;
  }
}

console.log("\n\nDone.");
