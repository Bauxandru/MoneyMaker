import { readFileSync } from 'fs';

const metrics = JSON.parse(readFileSync('data/execution_metrics.json', 'utf8'));

// Trades where PM was first and had a confirm/poll time (= delayed status)
const pmFirstDelayed = metrics.filter(m =>
  (m.outcome === 'both-filled' || m.outcome === 'hedge-entry') &&
  m.firstLeg === 'pm' &&
  m.firstLegConfirmMs > 0
);

// Trades where PM was second and had a confirm time
const pmSecondDelayed = metrics.filter(m =>
  (m.outcome === 'both-filled' || m.outcome === 'hedge-entry') &&
  m.firstLeg === 'kal' &&
  m.secondLegConfirmMs > 0
);

console.log('=== PM DELAYED ORDER CONFIRMATION TIMES ===\n');
console.log(`PM-first trades with delayed status: ${pmFirstDelayed.length}`);
console.log(`PM-second trades with delayed status: ${pmSecondDelayed.length}\n`);

// Reconstruct the polling schedule
// Sleep happens BEFORE the check, starting at 500ms with 1.5x backoff capped at 2000ms
// Poll 1: sleep 500ms → check at ~500ms
// Poll 2: sleep 750ms → check at ~1250ms
// Poll 3: sleep 1125ms → check at ~2375ms
// Poll 4: sleep 1688ms → check at ~4063ms
// Poll 5: sleep 2000ms → check at ~6063ms  (capped)
// Poll 6: sleep 2000ms → check at ~8063ms
// Poll 7: sleep 2000ms → check at ~10063ms
// Poll 8: sleep 2000ms → check at ~12063ms

const pollSchedule = [];
let interval = 500;
let cumulative = 0;
for (let i = 0; i < 15; i++) {
  cumulative += interval;
  pollSchedule.push({ poll: i + 1, sleepMs: interval, checkAtMs: cumulative });
  interval = Math.min(2000, Math.round(interval * 1.5));
}

console.log('Polling schedule (sleep → cumulative check time):');
for (const p of pollSchedule) {
  console.log(`  Poll ${p.poll}: sleep ${p.sleepMs}ms → check at ~${p.checkAtMs}ms`);
}
console.log('');

// For each delayed trade, estimate which poll iteration confirmed it
const allDelayed = [
  ...pmFirstDelayed.map(m => ({ match: m.match, ts: m.ts, pollMs: m.firstLegConfirmMs, leg: 'PM-first', edge: m.edge })),
  ...pmSecondDelayed.map(m => ({ match: m.match, ts: m.ts, pollMs: m.secondLegConfirmMs, leg: 'PM-second', edge: m.edge })),
];

allDelayed.sort((a, b) => a.pollMs - b.pollMs);

console.log('=== INDIVIDUAL DELAYED CONFIRMATIONS ===\n');
console.log('Match'.padEnd(45) + ' | Poll time | Est. poll # | Leg        | Edge');
console.log('-'.repeat(110));

for (const d of allDelayed) {
  // Estimate which poll iteration
  let estPoll = '?';
  for (const p of pollSchedule) {
    if (d.pollMs <= p.checkAtMs + 500) { // +500ms tolerance for network time
      estPoll = `#${p.poll}`;
      break;
    }
  }

  const match = d.match.padEnd(45).slice(0, 45);
  const pollTime = `${(d.pollMs / 1000).toFixed(1)}s`.padStart(8);
  const edge = d.edge ? `${(d.edge * 100).toFixed(1)}%` : '?';
  console.log(`${match} | ${pollTime} | ${estPoll.padStart(11)} | ${d.leg.padEnd(10)} | ${edge}`);
}

// Stats
const pollTimes = allDelayed.map(d => d.pollMs);
if (pollTimes.length > 0) {
  const sorted = [...pollTimes].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log(`\n=== STATS (${sorted.length} delayed confirmations) ===`);
  console.log(`  Min:    ${(sorted[0] / 1000).toFixed(1)}s`);
  console.log(`  Median: ${(med / 1000).toFixed(1)}s`);
  console.log(`  Avg:    ${(avg / 1000).toFixed(1)}s`);
  console.log(`  Max:    ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`);

  // Distribution
  console.log('\n  Distribution:');
  const buckets = [2000, 4000, 6000, 8000, 10000, 12000, 15000, 20000, 25000];
  for (const b of buckets) {
    const count = sorted.filter(v => v <= b).length;
    const bar = '#'.repeat(Math.round(count / sorted.length * 30));
    console.log(`    <= ${(b/1000).toFixed(0).padStart(2)}s: ${String(count).padStart(2)}/${sorted.length} (${(count/sorted.length*100).toFixed(0).padStart(3)}%) ${bar}`);
  }
}

// Also check: what's the ACTUAL on-chain confirmation time vs our poll detection?
// Our poll can only detect at poll boundaries, so actual confirmation is somewhere
// between (pollTime - lastSleepInterval) and pollTime.
console.log('\n=== ESTIMATED ACTUAL CONFIRMATION TIME (between polls) ===\n');
for (const d of allDelayed) {
  // Find which poll interval boundary this falls in
  let lowerBound = 0;
  let upperBound = d.pollMs;
  for (let i = 0; i < pollSchedule.length; i++) {
    if (d.pollMs <= pollSchedule[i].checkAtMs + 500) {
      lowerBound = i > 0 ? pollSchedule[i - 1].checkAtMs : 0;
      upperBound = pollSchedule[i].checkAtMs;
      break;
    }
  }
  const match = d.match.slice(0, 40).padEnd(40);
  console.log(`  ${match} | Detected at ${(d.pollMs/1000).toFixed(1)}s | Actual confirmation: ${(lowerBound/1000).toFixed(1)}s - ${(upperBound/1000).toFixed(1)}s`);
}
