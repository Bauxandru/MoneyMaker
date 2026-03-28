const fs = require("fs");
const snaps = JSON.parse(fs.readFileSync("data/book_snapshots.json", "utf8"));
const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
const metrics = JSON.parse(fs.readFileSync("data/execution_metrics.json", "utf8"));
const today = trades.filter(t => new Date(t.ts) > new Date("2026-03-24T00:00:00Z"));

const execSnaps = snaps.filter(s => s.phase === "execution");

function getEdgeAndDepth(sample, kalSide) {
  const kalAsks = kalSide === "yes" ? (sample.kalYesAsks || []) : (sample.kalNoAsks || []);
  const pmAsks = sample.pmAsks || [];
  const kalSorted = [...kalAsks].sort((a,b) => a[0] - b[0]);
  const pmSorted = [...pmAsks].sort((a,b) => a[0] - b[0]);

  const bestKal = kalSorted[0] ? kalSorted[0][0] / 100 : 1;
  const bestPm = pmSorted[0] ? pmSorted[0][0] : 1;
  const edge = 1 - (bestKal + bestPm);

  let kalDepth = 0, pmDepth = 0;
  for (const [p, q] of kalSorted) {
    if (p/100 + bestPm < 1.0) kalDepth += q;
  }
  for (const [p, q] of pmSorted) {
    if (bestKal + p < 1.0) pmDepth += q;
  }

  return {
    edge: edge > 0 ? edge : 0,
    arbDepth: Math.min(kalDepth, Math.round(pmDepth)),
    kalBest: kalSorted[0] || null,
    pmBest: pmSorted[0] || null,
    kalDepth,
    pmDepth: Math.round(pmDepth),
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
    const metric = metrics.find(m => {
      const dt = Math.abs(new Date(m.ts).getTime() - new Date(trade.ts).getTime());
      return dt < 60000 && m.match === trade.match;
    });
    matched.push({ exec: es, trade, metric });
  }
}

for (const { exec, trade, metric } of matched) {
  const kalSide = ["C","D","G","H","I"].includes(exec.dir) ? "no" : "yes";
  const samples = exec.samples;
  if (!samples || samples.length === 0) continue;

  console.log("\n" + "=".repeat(120));
  console.log("  " + trade.match);
  console.log("  Shares: " + trade.shares + " | KAL $" + trade.kalCost + " + PM $" + trade.pmCost + " = $" + trade.totalCost + " | P&L $" + (trade.realizedPnl ?? "?"));
  if (metric) {
    console.log("  Execution: total=" + metric.totalMs + "ms, 1st=" + metric.firstLeg + " order@" + metric.firstLegOrderMs + "ms confirm@" + (metric.firstLegOrderMs + metric.firstLegConfirmMs) + "ms, 2nd order@" + (metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs) + "ms");
  }
  console.log("=".repeat(120));

  // Track when edge/depth disappears — scan ALL samples
  let lastEdge = null;
  let edgeDisappearedAt = null;
  let edgeReappearedAt = null;
  let lastDepth = null;
  let depthDropEvents = [];
  let peakDepth = 0;
  let peakDepthAt = 0;

  // Key execution milestones
  const milestones = [];
  if (metric) {
    milestones.push({ label: "1st leg ORDER", t: metric.firstLegOrderMs });
    milestones.push({ label: "1st leg CONFIRM", t: metric.firstLegOrderMs + metric.firstLegConfirmMs });
    milestones.push({ label: "2nd leg ORDER", t: metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs });
    milestones.push({ label: "2nd leg CONFIRM", t: metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs + metric.secondLegConfirmMs });
  }

  // Scan every sample
  const timeline = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const state = getEdgeAndDepth(s, kalSide);
    const t = s.t;

    // Track peak depth
    if (state.arbDepth > peakDepth) {
      peakDepth = state.arbDepth;
      peakDepthAt = t;
    }

    // Detect edge disappearance
    if (lastEdge !== null && lastEdge > 0 && state.edge === 0 && edgeDisappearedAt === null) {
      edgeDisappearedAt = t;
    }
    if (lastEdge !== null && lastEdge === 0 && state.edge > 0 && edgeDisappearedAt !== null && edgeReappearedAt === null) {
      edgeReappearedAt = t;
    }

    // Detect significant depth drops (>20% drop from previous)
    if (lastDepth !== null && lastDepth > 0 && state.arbDepth < lastDepth) {
      const drop = lastDepth - state.arbDepth;
      const pct = (drop / lastDepth * 100).toFixed(0);
      if (drop >= 3 || parseInt(pct) >= 20) {
        depthDropEvents.push({ t, from: lastDepth, to: state.arbDepth, drop, pct });
      }
    }

    // Check if this sample is near a milestone
    const nearMilestone = milestones.find(m => Math.abs(m.t - t) < 200);
    if (nearMilestone) {
      nearMilestone.state = state;
      nearMilestone.sampleT = t;
    }

    lastEdge = state.edge;
    lastDepth = state.arbDepth;

    // Store for first/last
    if (i === 0 || i === samples.length - 1) {
      timeline.push({ t, state, label: i === 0 ? "START" : "END (t=" + t + "ms)" });
    }
  }

  // Print timeline
  const startState = timeline[0].state;
  const endState = timeline[1].state;

  console.log("\n  INITIAL STATE (t=0):");
  console.log("    Edge: " + (startState.edge * 100).toFixed(1) + "% | Depth: " + startState.arbDepth + " shares (KAL " + startState.kalDepth + ", PM " + startState.pmDepth + ")");
  console.log("    KAL best: " + (startState.kalBest ? startState.kalBest[0] + "c x" + startState.kalBest[1] : "EMPTY") +
    " | PM best: " + (startState.pmBest ? (startState.pmBest[0]*100).toFixed(0) + "c x" + Math.round(startState.pmBest[1]) : "EMPTY"));

  if (peakDepth > startState.arbDepth) {
    console.log("    Peak depth: " + peakDepth + " shares at t=" + peakDepthAt + "ms");
  }

  // Milestones
  if (milestones.length > 0) {
    console.log("\n  EXECUTION MILESTONES:");
    for (const m of milestones) {
      if (m.state) {
        const edgeStr = m.state.edge > 0 ? (m.state.edge * 100).toFixed(1) + "%" : "GONE";
        const depthStr = m.state.arbDepth > 0 ? m.state.arbDepth + " shares" : "EMPTY";
        console.log("    " + m.label.padEnd(18) + " t=" + String(m.t).padStart(6) + "ms → edge " + edgeStr.padEnd(6) + " depth " + depthStr);
      } else {
        console.log("    " + m.label.padEnd(18) + " t=" + String(m.t).padStart(6) + "ms → (no sample near this time)");
      }
    }
  }

  // Edge disappearance
  console.log("\n  EDGE TIMELINE:");
  if (edgeDisappearedAt !== null) {
    console.log("    Edge DISAPPEARED at t=" + edgeDisappearedAt + "ms (" + (edgeDisappearedAt / 1000).toFixed(1) + "s)");
    if (edgeReappearedAt !== null) {
      console.log("    Edge REAPPEARED at t=" + edgeReappearedAt + "ms (" + (edgeReappearedAt / 1000).toFixed(1) + "s)");
    }
  } else {
    console.log("    Edge persisted throughout entire 20s window!");
  }

  // Depth drops
  if (depthDropEvents.length > 0) {
    console.log("\n  DEPTH DROP EVENTS:");
    for (const d of depthDropEvents) {
      console.log("    t=" + String(d.t).padStart(6) + "ms (" + (d.t/1000).toFixed(1) + "s): " + d.from + " → " + d.to + " shares (-" + d.drop + ", -" + d.pct + "%)");
    }
  }

  // Final state
  console.log("\n  FINAL STATE (t=" + timeline[1].t + "ms):");
  console.log("    Edge: " + (endState.edge > 0 ? (endState.edge * 100).toFixed(1) + "%" : "GONE") + " | Depth: " + endState.arbDepth + " shares");

  // Verdict
  console.log("\n  VERDICT:");
  console.log("    We took " + trade.shares + "/" + startState.arbDepth + " shares (" + (trade.shares / Math.max(1, startState.arbDepth) * 100).toFixed(0) + "% of initial depth)");
  if (endState.arbDepth > 0 && endState.edge > 0) {
    const missed = endState.arbDepth;
    const missedProfit = (missed * endState.edge).toFixed(2);
    console.log("    REMAINING: " + missed + " shares at " + (endState.edge * 100).toFixed(1) + "% edge = $" + missedProfit + " left on table");
  } else {
    console.log("    Depth fully consumed within " + (edgeDisappearedAt ? (edgeDisappearedAt/1000).toFixed(1) + "s" : "20s window"));
  }
}

console.log("\n\nDone.");
