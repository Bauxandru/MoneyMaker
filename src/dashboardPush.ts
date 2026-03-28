import { type ArbTradeRecord, type ExecMetric } from "./types.js";

const PUSH_URL = () => process.env.DASHBOARD_PUSH_URL || "";
const TOKEN = () => process.env.LICENSE_TOKEN || "";

let _pushInterval: ReturnType<typeof setInterval> | null = null;
let _latestTrades: ArbTradeRecord[] = [];
let _latestMetrics: ExecMetric[] = [];

/**
 * Push trade data to the central dashboard. Fire-and-forget.
 */
export async function pushTradeData(
  trades: ArbTradeRecord[],
  metrics: ExecMetric[]
): Promise<void> {
  // Cache latest for periodic sync
  _latestTrades = trades;
  _latestMetrics = metrics;

  await _doPush(trades, metrics);
}

async function _doPush(
  trades: ArbTradeRecord[],
  metrics: ExecMetric[]
): Promise<void> {
  const url = PUSH_URL();
  const token = TOKEN();

  if (!url || !token) return; // push not configured, skip silently

  const endpoint = `${url.replace(/\/+$/, "")}/api/ingest`;

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        trades,
        metrics,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    console.warn(`[PUSH] Failed to push to dashboard: ${err.message}`);
  }
}

/**
 * Start periodic push (every 5 minutes) for stats sync.
 */
export function startPeriodicPush(): void {
  if (_pushInterval) return;

  const intervalMs = parseInt(
    process.env.DASHBOARD_PUSH_INTERVAL_MS || "300000",
    10
  ); // 5 min

  console.log(
    `[PUSH] Periodic dashboard sync every ${Math.round(intervalMs / 60000)} min`
  );

  _pushInterval = setInterval(() => {
    if (_latestTrades.length > 0) {
      _doPush(_latestTrades, _latestMetrics);
    }
  }, intervalMs);
}

/**
 * Stop periodic push.
 */
export function stopPeriodicPush(): void {
  if (_pushInterval) {
    clearInterval(_pushInterval);
    _pushInterval = null;
  }
}
