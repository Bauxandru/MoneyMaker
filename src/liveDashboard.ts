/**
 * liveDashboard.ts — WebSocket push-based dashboard inspired by the Rust arb bot.
 *
 * Architecture (different from the HTTP-polling dashboard on port 3456):
 *  - Single-page HTML served on port 3457
 *  - WebSocket endpoint /ws pushes atomic snapshots to clients
 *  - Snapshots rebuilt every ~500ms if data changed (dirty flag)
 *  - Multiple clients supported, each with their own WS connection
 *  - No lock contention with the trading path (reads files, doesn't share state)
 *
 * Usage:
 *   npm run dashboard:live    (runs this file)
 *   open http://localhost:3457
 */

import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = typeof import.meta?.url === "string" ? fileURLToPath(import.meta.url) : process.argv[1] ?? "";
const __dirname = __filename ? dirname(__filename) : process.cwd();
const ROOT = path.join(__dirname, "..");

const PORT = parseInt(process.env.LIVE_DASHBOARD_PORT || "3457", 10);
const SNAPSHOT_INTERVAL_MS = 500;
const ARB_TRADES_PATH = path.join(ROOT, "data", "arb_trades.json");
const METRICS_PATH = path.join(ROOT, "data", "execution_metrics.json");
const HEDGE_STATE_PATH = path.join(ROOT, "hedge_state.json");

// --- State tracking ---
interface Snapshot {
  ts: number;
  totalTrades: number;
  totalPnl: number;
  todayPnl: number;
  todayTrades: number;
  bothLegsRate: number;
  hedgingCount: number;
  recentTrades: unknown[];
  latencyStats: {
    kalAvg: number;
    pmConfirmAvg: number;
    totalAvg: number;
    sampleSize: number;
  };
  serverBreakdown: { [server: string]: { trades: number; pnl: number } };
}

let _latestSnapshot: Snapshot | null = null;
let _lastFileSize = 0;
let _lastMtime = 0;

function buildSnapshot(): Snapshot | null {
  try {
    const stat = fs.statSync(ARB_TRADES_PATH);
    // Skip rebuild if file unchanged
    if (stat.size === _lastFileSize && stat.mtimeMs === _lastMtime && _latestSnapshot) {
      return _latestSnapshot;
    }
    _lastFileSize = stat.size;
    _lastMtime = stat.mtimeMs;

    const trades: Array<{
      id?: string;
      ts?: string;
      match?: string;
      dir?: string;
      status?: string;
      shares?: number;
      kalCost?: number;
      pmCost?: number;
      totalCost?: number;
      realizedPnl?: number;
      resolutionMethod?: string;
      serverId?: string;
      kalFillPrice?: number;
      pmFillPrice?: number;
      pmOutcome?: string;
      kalTicker?: string;
    }> = JSON.parse(fs.readFileSync(ARB_TRADES_PATH, "utf8"));

    const today = new Date().toISOString().slice(0, 10);
    const todayTrades = trades.filter(t => t.ts?.startsWith(today));
    const resolvedToday = todayTrades.filter(t => t.status === "resolved");
    const bothLegs = resolvedToday.filter(t => t.resolutionMethod === "both-legs");

    const totalPnl = trades.reduce((s, t) => s + (t.realizedPnl || 0), 0);
    const todayPnl = todayTrades.reduce((s, t) => s + (t.realizedPnl || 0), 0);

    const hedging = trades.filter(t => t.status === "hedging").length;

    // Recent trades (last 20)
    const recentTrades = trades.slice(-20).reverse();

    // Server breakdown
    const serverBreakdown: { [server: string]: { trades: number; pnl: number } } = {};
    for (const t of trades) {
      const srv = t.serverId || "unknown";
      if (!serverBreakdown[srv]) serverBreakdown[srv] = { trades: 0, pnl: 0 };
      serverBreakdown[srv].trades++;
      serverBreakdown[srv].pnl += (t.realizedPnl || 0);
    }

    // Latency stats from metrics
    let kalAvg = 0, pmConfirmAvg = 0, totalAvg = 0, sampleSize = 0;
    try {
      const metrics: Array<{
        ts?: string;
        outcome?: string;
        firstLegOrderMs?: number;
        secondLegConfirmMs?: number;
        totalMs?: number;
      }> = JSON.parse(fs.readFileSync(METRICS_PATH, "utf8"));
      const execMetrics = metrics.filter(m => m.outcome && !m.outcome.startsWith("abort"));
      const recent = execMetrics.slice(-50);
      if (recent.length > 0) {
        kalAvg = recent.reduce((s, m) => s + (m.firstLegOrderMs || 0), 0) / recent.length;
        pmConfirmAvg = recent.reduce((s, m) => s + (m.secondLegConfirmMs || 0), 0) / recent.length;
        totalAvg = recent.reduce((s, m) => s + (m.totalMs || 0), 0) / recent.length;
        sampleSize = recent.length;
      }
    } catch { /* metrics file missing or invalid */ }

    const snap: Snapshot = {
      ts: Date.now(),
      totalTrades: trades.length,
      totalPnl: Math.round(totalPnl * 100) / 100,
      todayPnl: Math.round(todayPnl * 100) / 100,
      todayTrades: todayTrades.length,
      bothLegsRate: resolvedToday.length > 0 ? bothLegs.length / resolvedToday.length : 0,
      hedgingCount: hedging,
      recentTrades,
      latencyStats: {
        kalAvg: Math.round(kalAvg),
        pmConfirmAvg: Math.round(pmConfirmAvg),
        totalAvg: Math.round(totalAvg),
        sampleSize,
      },
      serverBreakdown,
    };
    _latestSnapshot = snap;
    return snap;
  } catch (err) {
    console.error("[LIVE-DASH] Failed to build snapshot:", (err as Error).message);
    return _latestSnapshot;
  }
}

// --- HTML frontend ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Arb Bot — Live Dashboard</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#c9d1d9;margin:0;padding:20px}
h1{color:#58a6ff;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:15px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:15px}
.card h3{margin:0 0 8px;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
.val{font-size:28px;font-weight:600;color:#c9d1d9}
.pos{color:#3fb950}.neg{color:#f85149}.ok{color:#58a6ff}
.small{font-size:12px;color:#8b949e;margin-top:4px}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:6px;overflow:hidden}
th{background:#0d1117;color:#8b949e;font-size:11px;text-transform:uppercase;padding:10px;text-align:left;border-bottom:1px solid #30363d}
td{padding:8px 10px;border-bottom:1px solid #21262d;font-size:13px}
tr:hover{background:#1c2128}
.status-ok{background:#1f4d2e;color:#3fb950;padding:2px 6px;border-radius:3px;font-size:10px}
.status-loss{background:#4d1e1e;color:#f85149;padding:2px 6px;border-radius:3px;font-size:10px}
.status-hdg{background:#2d2d00;color:#d29922;padding:2px 6px;border-radius:3px;font-size:10px}
.connection{position:fixed;top:10px;right:10px;padding:5px 10px;border-radius:3px;font-size:11px}
.connected{background:#1f4d2e;color:#3fb950}
.disconnected{background:#4d1e1e;color:#f85149}
.header-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.badge{background:#30363d;color:#8b949e;padding:2px 6px;border-radius:3px;font-size:10px;font-family:monospace}
.server-label{background:#0969da;color:#fff;padding:1px 5px;border-radius:3px;font-size:10px}
</style>
</head>
<body>
<div class="connection" id="conn">Connecting...</div>
<div class="header-row">
  <h1>Arb Bot — Live Dashboard</h1>
  <div class="small">Push-based via WebSocket • Updated: <span id="lastUpdate">--</span></div>
</div>

<div class="grid">
  <div class="card"><h3>Total P&L</h3><div class="val" id="totalPnl">--</div><div class="small" id="totalTrades">0 trades</div></div>
  <div class="card"><h3>Today P&L</h3><div class="val" id="todayPnl">--</div><div class="small" id="todayTrades">0 trades today</div></div>
  <div class="card"><h3>Both-Legs Rate</h3><div class="val" id="bothLegs">--</div><div class="small">instant arbs today</div></div>
  <div class="card"><h3>Hedging</h3><div class="val" id="hedgingCount">--</div><div class="small">open positions</div></div>
  <div class="card"><h3>KAL IOC Avg</h3><div class="val" id="kalAvg">--<span style="font-size:14px;color:#8b949e"> ms</span></div><div class="small" id="kalSample">--</div></div>
  <div class="card"><h3>PM Confirm Avg</h3><div class="val" id="pmAvg">--<span style="font-size:14px;color:#8b949e"> ms</span></div><div class="small">last 50 trades</div></div>
  <div class="card"><h3>Total Exec Avg</h3><div class="val" id="totalAvg">--<span style="font-size:14px;color:#8b949e"> ms</span></div><div class="small">scan to fill</div></div>
</div>

<div class="card">
  <h3>Server Breakdown</h3>
  <div id="serverBreakdown" style="display:flex;gap:20px;margin-top:10px"></div>
</div>

<h3 style="color:#58a6ff;margin-top:30px">Recent Trades</h3>
<table>
  <thead>
    <tr>
      <th>Time</th><th>Match</th><th>Dir</th><th>KAL</th><th>PM</th><th>Shares</th><th>Cost</th><th>P&L</th><th>Method</th><th>Server</th>
    </tr>
  </thead>
  <tbody id="tradesBody">
    <tr><td colspan="10" style="text-align:center;color:#8b949e;padding:20px">Waiting for data...</td></tr>
  </tbody>
</table>

<script>
const ws = new WebSocket('ws://' + location.host + '/ws');
const connEl = document.getElementById('conn');

ws.onopen = () => { connEl.textContent = 'Connected'; connEl.className = 'connection connected'; };
ws.onclose = () => { connEl.textContent = 'Disconnected'; connEl.className = 'connection disconnected'; };
ws.onerror = () => { connEl.textContent = 'Error'; connEl.className = 'connection disconnected'; };

function fmtMoney(v) {
  const sign = v >= 0 ? '+' : '';
  return sign + '$' + v.toFixed(2);
}
function fmtTime(iso) {
  if (!iso) return '--';
  return iso.slice(11, 19);
}
function esc(s) { return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

ws.onmessage = (e) => {
  try {
    const snap = JSON.parse(e.data);
    document.getElementById('lastUpdate').textContent = new Date(snap.ts).toLocaleTimeString();

    // KPI cards
    const totalEl = document.getElementById('totalPnl');
    totalEl.textContent = fmtMoney(snap.totalPnl);
    totalEl.className = 'val ' + (snap.totalPnl >= 0 ? 'pos' : 'neg');
    document.getElementById('totalTrades').textContent = snap.totalTrades + ' trades';

    const todayEl = document.getElementById('todayPnl');
    todayEl.textContent = fmtMoney(snap.todayPnl);
    todayEl.className = 'val ' + (snap.todayPnl >= 0 ? 'pos' : 'neg');
    document.getElementById('todayTrades').textContent = snap.todayTrades + ' trades today';

    document.getElementById('bothLegs').textContent = (snap.bothLegsRate * 100).toFixed(0) + '%';
    document.getElementById('hedgingCount').textContent = snap.hedgingCount;

    document.getElementById('kalAvg').innerHTML = snap.latencyStats.kalAvg + '<span style="font-size:14px;color:#8b949e"> ms</span>';
    document.getElementById('kalSample').textContent = 'n=' + snap.latencyStats.sampleSize;
    document.getElementById('pmAvg').innerHTML = snap.latencyStats.pmConfirmAvg + '<span style="font-size:14px;color:#8b949e"> ms</span>';
    document.getElementById('totalAvg').innerHTML = snap.latencyStats.totalAvg + '<span style="font-size:14px;color:#8b949e"> ms</span>';

    // Server breakdown
    const srvEl = document.getElementById('serverBreakdown');
    srvEl.innerHTML = '';
    for (const [name, data] of Object.entries(snap.serverBreakdown)) {
      const cls = data.pnl >= 0 ? 'pos' : 'neg';
      srvEl.innerHTML += '<div><span class="server-label">' + esc(name) + '</span> <span class="' + cls + '">' + fmtMoney(data.pnl) + '</span> <span class="small">(' + data.trades + ')</span></div>';
    }

    // Recent trades
    const tbody = document.getElementById('tradesBody');
    if (snap.recentTrades && snap.recentTrades.length > 0) {
      tbody.innerHTML = snap.recentTrades.map(t => {
        const pnl = t.realizedPnl != null ? fmtMoney(t.realizedPnl) : '--';
        const pnlCls = t.realizedPnl != null ? (t.realizedPnl >= 0 ? 'pos' : 'neg') : '';
        const statusCls = t.status === 'hedging' ? 'status-hdg' :
                          (t.realizedPnl >= 0 ? 'status-ok' : 'status-loss');
        return '<tr>' +
          '<td>' + fmtTime(t.ts) + '</td>' +
          '<td>' + esc((t.match || '').slice(0, 35)) + '</td>' +
          '<td><span class="badge">' + esc(t.dir) + '</span></td>' +
          '<td>' + (t.kalFillPrice ? (t.kalFillPrice * 100).toFixed(0) + '¢' : '--') + '</td>' +
          '<td>' + (t.pmFillPrice ? (t.pmFillPrice * 100).toFixed(0) + '¢' : '--') + '</td>' +
          '<td>' + (t.shares || 0) + '</td>' +
          '<td>$' + (t.totalCost || 0).toFixed(2) + '</td>' +
          '<td class="' + pnlCls + '">' + pnl + '</td>' +
          '<td><span class="' + statusCls + '">' + esc(t.resolutionMethod || t.status || '--') + '</span></td>' +
          '<td><span class="server-label">' + esc(t.serverId || 'local') + '</span></td>' +
          '</tr>';
      }).join('');
    }
  } catch (err) { console.error('Parse error:', err); }
};
</script>
</body>
</html>`;

// --- HTTP server ---
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
  } else if (req.url === "/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(_latestSnapshot || {}));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// --- WebSocket server ---
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  console.log(`[LIVE-DASH] Client connected (total: ${wss.clients.size})`);
  // Send latest snapshot immediately
  if (_latestSnapshot) {
    ws.send(JSON.stringify(_latestSnapshot));
  }
  ws.on("close", () => {
    console.log(`[LIVE-DASH] Client disconnected (total: ${wss.clients.size})`);
  });
});

// --- Snapshot broadcast loop ---
setInterval(() => {
  const snap = buildSnapshot();
  if (!snap) return;
  const msg = JSON.stringify(snap);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}, SNAPSHOT_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[LIVE-DASH] Live dashboard running at http://localhost:${PORT}`);
  console.log(`[LIVE-DASH] WebSocket push updates every ${SNAPSHOT_INTERVAL_MS}ms`);
});
