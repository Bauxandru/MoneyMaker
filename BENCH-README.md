# arb-bench.exe — server location speed test

Standalone Windows exe that measures latency from the current machine to every
API/WebSocket/RPC the bot uses, plus optionally places + cancels live test orders
to benchmark round-trip order placement speed.

## Usage

Copy `dist/arb-bench.exe` to a VPS. Run it:

```powershell
# Minimum (network latency only, no live orders):
$env:BENCH_LOCATION="ashburn-vps"
.\arb-bench.exe
```

Output → console + a `bench-<location>-<timestamp>.json` file with full details.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `BENCH_LOCATION` | hostname | Tag for this run (appears in filename + summary) |
| `BENCH_SAMPLES` | `10` | Samples per test (increase for better p95) |
| `BENCH_SKIP_LIVE` | `false` | `true` = skip live order tests (no auth needed) |
| `BENCH_KAL_TICKER` | unset | Kalshi ticker to use for live GTC buy/cancel test (e.g. `KXNHLGAME-26APR17SEACOL-SEA`) |
| `BENCH_PM_TOKEN_ID` | unset | Polymarket token ID for live GTC buy/cancel test |

**Creds** (same as the main bot's `.env`): `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, `POLY_WALLET_PRIVATE_KEY`, `POLY_FUNDER`, `POLY_RPC_URL`, etc. Already embedded in the exe at build time — you don't set them again on the VPS.

## What gets measured

### HTTP endpoints (10 samples each by default)
- Kalshi `/markets` — main REST API
- Polymarket CLOB `/ok` — order placement + cancellation base URL
- Polymarket Gamma `/events` — discovery API
- Polymarket data-api `/positions` — live position lookups

For each HTTP request: DNS resolve, TCP connect, TLS handshake, time-to-first-byte, total response time. p50/p95/max.

### WebSocket connect times (5 samples each)
- Kalshi WS
- Polymarket WS (market channel)

### Polygon RPC
- `eth_blockNumber` roundtrip via `POLY_RPC_URL`

### Live order tests (opt-in — set `BENCH_KAL_TICKER` / `BENCH_PM_TOKEN_ID`)
- **Kalshi**: place GTC BUY YES @ 1¢ (far below any ask, cannot fill) → cancel. Round-trip time per cycle.
- **Polymarket**: place GTC BUY @ 1¢ on target token → cancel. Round-trip time.

Each iteration is a full client→server→ack cycle. All orders cancelled within 500ms of placement. Zero financial risk: 1¢ orders never match against realistic asks (~20-90¢).

## Example output

```
=== ARB SPEED BENCHMARK ===
Location tag: ashburn-vps
Hostname    : vps-ashburn-01   CPU: AMD EPYC 7532 32-Core Processor
Samples per test: 10

--- HTTP endpoints (DNS+connect+TLS+response) ---
  Kalshi /markets total          n=10 min=  18ms p50=  21ms p95=  34ms max=  48ms mean=  23ms
  PM CLOB /ok total              n=10 min=  15ms p50=  17ms p95=  25ms max=  31ms mean=  18ms
  PM gamma /events total         n=10 min=  22ms p50=  26ms p95=  52ms max=  61ms mean=  30ms
  ...

--- Kalshi live order (1¢ BUY YES, never fills) ---
  KAL place GTC (roundtrip)      n=10 min=  85ms p50= 104ms p95= 156ms max= 189ms mean= 112ms
  KAL cancel GTC (roundtrip)     n=10 min=  72ms p50=  88ms p95= 121ms max= 142ms mean=  94ms

=== SUMMARY for ashburn-vps ===
  KAL API total p50=21ms  PM CLOB total p50=17ms
  ...
```

## Comparing locations

Run on each candidate VPS, collect the JSON files, diff the p50 and p95:

```powershell
# On each VPS:
$env:BENCH_LOCATION="ashburn"; .\arb-bench.exe
$env:BENCH_LOCATION="toronto"; .\arb-bench.exe
# Copy the bench-*.json files back, compare.
```

### What to look for

- **KAL API total p50 < 30ms** → VPS is US-east, close to Kalshi.
- **KAL API p50 > 100ms** → far (EU, Asia) or bad routing.
- **PM CLOB total p50 < 30ms** → close to Cloudflare + PM origin (probably US-east).
- **KAL + PM order placement p50 < 150ms** → exchange-grade latency. You'll be competitive with HFT bots.
- **> 300ms on either** → arbs will often evaporate before your order lands.

### Order placement is the headline metric

API reads (markets, positions) matter less than order PLACEMENT, because that's the time-sensitive path. Prioritize locations with the lowest `KAL place GTC` and `PM place GTC` p50.

## Caveats

- p95 is noisy with only 10 samples. Bump `BENCH_SAMPLES=50` for better tail numbers if you have time.
- Kalshi WS may fail to connect with auth — that's expected if you haven't set `KALSHI_API_KEY_ID`. HTTP latency is the more important signal.
- PM data-api uses Cloudflare CDN, so PM CLOB p50 is what matters for orders.
- A first request has DNS + TLS cold-start overhead. Samples after the first use connection keepalive — p50 reflects steady-state.
