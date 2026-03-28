const fs = require("fs");
const snaps = JSON.parse(fs.readFileSync("data/book_snapshots.json", "utf8"));
const trades = JSON.parse(fs.readFileSync("data/arb_trades.json", "utf8"));
const metrics = JSON.parse(fs.readFileSync("data/execution_metrics.json", "utf8"));
const today = trades.filter(t => new Date(t.ts) > new Date("2026-03-24T00:00:00Z"));

const execSnaps = snaps.filter(s => s.phase === "execution");

// Match execution snapshots to trades
const matched = [];
for (const es of execSnaps) {
  const trade = today.find(t => {
    const dt = Math.abs(new Date(t.ts).getTime() - new Date(es.ts).getTime());
    return dt < 120000 && (t.kalTicker === es.kalTicker || (t.match && es.match && t.match.includes(es.match.substring(0,15))));
  });
  if (trade && !matched.find(m => m.trade.id === trade.id)) {
    // Find the CORRECT metric — must match trade timestamp closely AND have filled outcome
    const metric = metrics
      .filter(m => m.match === trade.match || (es.match && m.match && m.match.includes(es.match.substring(0,15))))
      .filter(m => {
        const dt = Math.abs(new Date(m.ts).getTime() - new Date(trade.ts).getTime());
        return dt < 60000;
      })
      .filter(m => m.outcome !== "abort-pre-first" && m.outcome !== "abort-pre-second" && m.outcome !== "abort-safety")
      .sort((a, b) => Math.abs(new Date(a.ts).getTime() - new Date(trade.ts).getTime()) - Math.abs(new Date(b.ts).getTime() - new Date(trade.ts).getTime()))[0];
    matched.push({ exec: es, trade, metric });
  }
}

for (const { exec, trade, metric } of matched) {
  const kalSide = ["C","D","G","H","I"].includes(exec.dir) ? "no" : "yes";
  const kalAsksKey = kalSide === "yes" ? "kalYesAsks" : "kalNoAsks";
  const samples = exec.samples;
  if (!samples || samples.length === 0) continue;

  console.log("\n" + "=".repeat(120));
  console.log("  " + trade.match);
  console.log("  We took: " + trade.shares + " shares | KAL $" + trade.kalCost + " PM $" + trade.pmCost + " | P&L $" + (trade.realizedPnl ?? "?"));
  if (metric) {
    console.log("  Execution: firstLeg=" + metric.firstLeg + " outcome=" + metric.outcome);
    console.log("  Timing: KAL order@" + (metric.firstLeg === "kal" ? metric.firstLegOrderMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs) +
      "ms confirm@" + (metric.firstLeg === "kal" ? metric.firstLegOrderMs + metric.firstLegConfirmMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs + metric.secondLegConfirmMs) +
      "ms | PM order@" + (metric.firstLeg === "pm" ? metric.firstLegOrderMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs) +
      "ms confirm@" + (metric.firstLeg === "pm" ? metric.firstLegOrderMs + metric.firstLegConfirmMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs + metric.secondLegConfirmMs) + "ms");
  }
  console.log("=".repeat(120));

  // Scan all samples and show every change on KAL or PM profitable levels
  let prevKalLevels = null;
  let prevPmLevels = null;
  let prevArbDepth = null;

  // Track cumulative changes
  let totalKalTaken = 0;
  let totalPmTaken = 0;
  let ourKalTake = null; // detected when KAL drops by ~trade.shares
  let ourPmTake = null;

  const events = [];

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const t = s.t;
    const kalAsks = (s[kalAsksKey] || []).sort((a,b) => a[0] - b[0]);
    const pmAsks = (s.pmAsks || []).sort((a,b) => a[0] - b[0]);

    const bestKal = kalAsks[0] ? kalAsks[0][0] / 100 : 1;
    const bestPm = pmAsks[0] ? pmAsks[0][0] : 1;

    // Build level strings for comparison
    const kalStr = kalAsks.slice(0, 6).map(l => l[0] + "c x" + l[1]).join(" | ");
    const pmStr = pmAsks.slice(0, 6).map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | ");

    // Profitable depth
    let kalDepth = 0, pmDepth = 0;
    for (const [p, q] of kalAsks) { if (p/100 + bestPm < 1.0) kalDepth += q; }
    for (const [p, q] of pmAsks) { if (bestKal + p < 1.0) pmDepth += q; }
    const arbDepth = Math.min(kalDepth, Math.round(pmDepth));
    const edge = 1 - (bestKal + bestPm);

    // Detect changes
    const kalChanged = kalStr !== prevKalLevels;
    const pmChanged = pmStr !== prevPmLevels;

    if (kalChanged || pmChanged || i === 0 || i === samples.length - 1) {
      // Figure out what changed
      let kalDelta = "";
      let pmDelta = "";

      if (prevKalLevels !== null && kalChanged) {
        // Parse prev and current first level
        const prevFirst = prevKalLevels ? parseInt(prevKalLevels.split(" x")[0]) : 0;
        const currFirst = kalAsks[0] ? kalAsks[0][0] : 0;
        if (prevFirst === currFirst && prevKalLevels) {
          // Same price, qty changed
          const prevQty = parseInt(prevKalLevels.split("x")[1]);
          const currQty = kalAsks[0] ? kalAsks[0][1] : 0;
          const diff = currQty - prevQty;
          if (diff !== 0) kalDelta = "  [KAL " + currFirst + "c: " + (diff > 0 ? "+" : "") + diff + "]";
        } else if (prevFirst !== currFirst) {
          kalDelta = "  [KAL level moved " + prevFirst + "c → " + currFirst + "c]";
        }
      }
      if (prevPmLevels !== null && pmChanged) {
        const prevFirst = prevPmLevels ? parseInt(prevPmLevels.split("c x")[0]) : 0;
        const currFirst = pmAsks[0] ? Math.round(pmAsks[0][0] * 100) : 0;
        if (prevFirst === currFirst && prevPmLevels) {
          const prevQty = parseInt(prevPmLevels.split("x")[1]);
          const currQty = pmAsks[0] ? Math.round(pmAsks[0][1]) : 0;
          const diff = currQty - prevQty;
          if (diff !== 0) pmDelta = "  [PM " + currFirst + "c: " + (diff > 0 ? "+" : "") + diff + "]";
        } else if (prevFirst !== currFirst) {
          pmDelta = "  [PM level moved " + prevFirst + "c → " + currFirst + "c]";
        }
      }

      // Annotation
      let marker = "";
      if (metric) {
        const kalOrderT = metric.firstLeg === "kal" ? metric.firstLegOrderMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs;
        const kalConfirmT = metric.firstLeg === "kal" ? metric.firstLegOrderMs + metric.firstLegConfirmMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs + metric.secondLegConfirmMs;
        const pmOrderT = metric.firstLeg === "pm" ? metric.firstLegOrderMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs;
        const pmConfirmT = metric.firstLeg === "pm" ? metric.firstLegOrderMs + metric.firstLegConfirmMs : metric.firstLegOrderMs + metric.firstLegConfirmMs + metric.secondLegOrderMs + metric.secondLegConfirmMs;

        if (Math.abs(t - kalOrderT) < 100) marker += " ◄ KAL ORDER";
        if (Math.abs(t - kalConfirmT) < 100) marker += " ◄ KAL CONFIRM";
        if (Math.abs(t - pmOrderT) < 100) marker += " ◄ PM ORDER";
        if (Math.abs(t - pmConfirmT) < 100) marker += " ◄ PM CONFIRM";
      }

      // Only show if something meaningful changed
      const depthChanged = prevArbDepth !== null && arbDepth !== prevArbDepth;
      const significantChange = kalDelta || pmDelta || marker || i === 0 || i === samples.length - 1 || depthChanged;

      if (significantChange) {
        const edgeStr = edge > 0 ? (edge*100).toFixed(1) + "%" : "GONE";
        console.log(
          "  t=" + String(t).padStart(6) + "ms" +
          "  KAL " + kalSide.toUpperCase() + ": " + (kalStr || "EMPTY").padEnd(55) +
          "  PM: " + (pmStr || "EMPTY").padEnd(50) +
          (kalDelta || "") + (pmDelta || "") + marker
        );
      }

      prevKalLevels = kalStr;
      prevPmLevels = pmStr;
      prevArbDepth = arbDepth;
    }
  }
}

console.log("\n\nDone.");
