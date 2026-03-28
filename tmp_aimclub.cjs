const fs = require("fs");
const snaps = JSON.parse(fs.readFileSync("data/book_snapshots.json", "utf8"));
const metrics = JSON.parse(fs.readFileSync("data/execution_metrics.json", "utf8"));

const execSnaps = snaps.filter(s => s.phase === "execution" && s.match && s.match.includes("aimclub"));
console.log("Found", execSnaps.length, "execution snapshots for aimclub");

const metric = metrics.find(m => m.match && m.match.includes("aimclub"));
if (metric) {
  console.log("\nExecution metric:", JSON.stringify({
    firstLeg: metric.firstLeg,
    firstLegOrderMs: metric.firstLegOrderMs,
    firstLegConfirmMs: metric.firstLegConfirmMs,
    secondLegOrderMs: metric.secondLegOrderMs,
    secondLegConfirmMs: metric.secondLegConfirmMs,
    totalMs: metric.totalMs,
    firstLegFilled: metric.firstLegFilled,
    secondLegFilled: metric.secondLegFilled,
    expectedKalPrice: metric.expectedKalPrice,
    expectedPmPrice: metric.expectedPmPrice,
    outcome: metric.outcome,
    kalMakerFill: metric.kalMakerFill,
  }, null, 2));
}

for (const snap of execSnaps) {
  console.log("\nSnap:", snap.match, "dir:", snap.dir, "kalTicker:", snap.kalTicker);
  console.log("Samples:", snap.samples.length);

  // Print EVERY sample with full book state for first 4 seconds, then key moments
  for (let i = 0; i < snap.samples.length; i++) {
    const s = snap.samples[i];
    const t = s.t;

    // Show all samples up to 3000ms, then only every ~2s
    if (t > 3000 && i % 5 !== 0 && t < 19000) continue;

    const kalYesAsks = (s.kalYesAsks || []).sort((a,b) => a[0] - b[0]);
    const kalNoAsks = (s.kalNoAsks || []).sort((a,b) => a[0] - b[0]);
    const pmAsks = (s.pmAsks || []).sort((a,b) => a[0] - b[0]);
    const pmBids = (s.pmBids || []).sort((a,b) => b[0] - a[0]);

    // For aimclub dir=B → kalSide=yes, so we look at kalYesAsks
    const bestKal = kalYesAsks[0] ? kalYesAsks[0][0] / 100 : 1;
    const bestPm = pmAsks[0] ? pmAsks[0][0] : 1;
    const edge = 1 - (bestKal + bestPm);

    let kalDepth = 0;
    for (const [p, q] of kalYesAsks) {
      if (p/100 + bestPm < 1.0) kalDepth += q;
    }
    let pmDepth = 0;
    for (const [p, q] of pmAsks) {
      if (bestKal + p < 1.0) pmDepth += q;
    }
    const arbDepth = Math.min(kalDepth, Math.round(pmDepth));

    const kalStr = kalYesAsks.slice(0, 4).map(l => l[0] + "c x" + l[1]).join(" | ");
    const pmStr = pmAsks.slice(0, 4).map(l => (l[0]*100).toFixed(0) + "c x" + Math.round(l[1])).join(" | ");

    let marker = "";
    if (metric) {
      if (Math.abs(t - metric.firstLegOrderMs) < 100) marker = " ← 1ST ORDER";
      if (Math.abs(t - (metric.firstLegOrderMs + metric.firstLegConfirmMs)) < 100) marker += " ← 1ST CONFIRM";
    }

    console.log(
      "  t=" + String(t).padStart(6) + "ms" +
      "  edge=" + (edge > 0 ? (edge*100).toFixed(1) + "%" : "GONE").padEnd(6) +
      "  arbDepth=" + String(arbDepth).padStart(4) +
      "  kalDepth=" + String(kalDepth).padStart(4) +
      "  pmDepth=" + String(Math.round(pmDepth)).padStart(5) +
      marker
    );
    console.log(
      "         KAL YES asks: " + (kalStr || "EMPTY")
    );
    console.log(
      "         PM asks:      " + (pmStr || "EMPTY")
    );
    if (s.source) console.log("         source: " + s.source);
  }
}
