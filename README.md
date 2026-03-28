# Polymarket x Kalshi arbitrage scanner (read-only)

This script pulls market data from Polymarket and Kalshi, stores snapshots in SQLite,
and computes simple cross-exchange arbitrage edges.

## Requirements
- Node.js 18+ (for built-in `fetch`)

## Setup
```bash
npm install
npm run dev
```

## Output
- SQLite DB: `data/arb.sqlite`
- CSVs for Excel:
  - `data/latest_quotes.csv`
  - `data/latest_arbs.csv`

## Configure markets
Edit `config/markets.json`.

You can define:
- `pairs`: explicit Polymarket+Kalshi pairs.
- `autoPairs`: build pairs automatically for a Polymarket event slug + Kalshi event ticker.

Notes:
- For Polymarket multi-outcome events, set `outcomeLabel` (or `outcomeIndex`) so the script
  can resolve the correct outcome token.
- If the outcome label is wrong, the script will print available outcomes in the error message.

## Environment variables (optional)
- `POLY_GAMMA_URL` (default: `https://gamma-api.polymarket.com`)
- `POLY_CLOB_URL` (default: `https://clob.polymarket.com`)
- `POLY_API_NONCE` (optional: used when deriving API creds at runtime; defaults to 0)
- `POLY_FEE_EXPONENT` (optional: fee curve exponent; default `2`)
- `POLY_RPC_URL` (required for on-chain allowance approvals)
- `POLY_APPROVE_MODE` (optional: `collateral`, `conditional`, or `both`; default `collateral`)
- `POLY_REFRESH_ALLOWANCE` (optional: set to `false` to skip CLOB cache refresh after approvals)
- `TRADE_BASE_EXCHANGE` (optional: `AUTO`, `PM`, or `KAL`; default `AUTO`)
- `HEDGE_TARGET` (optional: `profit` or `payout`; default `profit`)
- `KALSHI_FEE_TYPE` (optional: `taker` or `maker`; default `taker`)
- `KALSHI_COUNT_ROUND` (optional: `round`, `floor`, or `ceil` for sizing Kalshi contracts)
- `KALSHI_BASE_URL` (default: `https://api.elections.kalshi.com/trade-api/v2`)
- `DATA_DIR` (default: `data`)
- `DEBUG_SIZING` (optional: `true` to print sizing math details)
- `POLY_MARKETS_LIMIT` (optional: page size for market discovery; default `100`)
- `POLY_MAX_MARKETS` (optional: stop after this many Polymarket markets; default `0` = no limit)
- `POLY_ONLY_ACTIVE` (optional: filter Polymarket active markets; default `true`)
- `POLY_ONLY_OPEN` (optional: filter Polymarket open markets; default `true`)
- `POLY_ONLY_ORDERBOOK` (optional: filter Polymarket orderbook markets; default `true`)
- `POLY_USE_EVENTS` (optional: use `/events` first for Polymarket; default `true`)
- `POLY_REFRESH_EVENTS` (optional: re-scan events even if cached; default `false`)
- `POLY_EVENT_PAGES` (optional: only scan this many Polymarket event pages; default `0` = no limit)
- `KALSHI_MARKETS_LIMIT` (optional: page size for Kalshi discovery; default `200`)
- `KALSHI_STATUS` (optional: Kalshi status filter for discovery; default `active`)
- `KALSHI_MAX_MARKETS` (optional: stop after this many Kalshi markets; default `0` = no limit)
- `KALSHI_EVENTS_LIMIT` (optional: page size for Kalshi event discovery; default `200`)
- `KALSHI_USE_EVENTS` (optional: `true` to discover Kalshi markets via events; default `true`)
- `KALSHI_EVENTS_WITH_MARKETS` (optional: `true` to use `with_nested_markets` on events; default `true`)
- `KALSHI_EVENT_STATUS` (optional: event status filter for Kalshi events; default `open`)
- `KALSHI_EVENT_MARKET_FALLBACK` (optional: call `/markets` per event if nested markets missing; default `false`)
- `KALSHI_REFRESH_EVENTS` (optional: re-scan events even if cached; default `false`)
- `KALSHI_EVENT_PAGES` (optional: only scan this many Kalshi event pages; default `0` = no limit)
- `MATCH_HIGH_SCORE` (optional: high-precision match score threshold; default `0.82`)
- `MATCH_REVIEW_SCORE` (optional: review-needed match threshold; default `0.7`)
- `MATCH_RULES_MIN` (optional: minimum rules similarity for high precision; default `0.25`)
- `MATCH_RULES_BYPASS` (optional: allow high-precision if title/number scores are strong; default `true`)
- `MATCH_TITLE_OVERRIDE` (optional: title score needed to bypass low rules; default `0.85`)
- `MATCH_NUM_OVERRIDE` (optional: number score needed to bypass low rules; default `0.9`)
- `MATCH_BUCKET_ENFORCE` (optional: enforce 25 vs >25 bucket compatibility; default `true`)
- `MATCH_MAX_CLOSE_DAYS` (optional: max close-time gap in days; default `14`)
- `MATCH_MAX_PER_PM` (optional: max matches per Polymarket market; default `10`)
- `WRITE_MARKETS` (optional: write raw market dumps; default `true`)
- `DISCOVER_PROGRESS` (optional: `true` to log progress; default `true`)
- `DISCOVER_INCREMENTAL` (optional: use cached markets and only fetch missing; default `true`)
- `DISCOVER_CACHE_ONLY` (optional: skip network and use cached markets only; default `false`)
- `DISCOVER_RETRIES` (optional: retry count for discovery calls; default `6`)
- `DISCOVER_RETRY_BASE_MS` (optional: base backoff delay; default `800`)
- `DISCOVER_TIMEOUT_MS` (optional: per-request timeout; default `15000`)
- `DISCOVER_PAGE_DELAY_MS` (optional: sleep between pages; default `0`)
- `DISCOVER_RETRY_FOREVER` (optional: keep retrying 429s indefinitely; default `false`)
- `DISCOVER_REQUEST_DELAY_MS` (optional: delay before each request; default `0`)
- `DISCOVER_429_MIN_MS` (optional: minimum wait for 429 retries; default `0`)
- `DISCOVER_MATCH_PROGRESS` (optional: `true` to log match progress; default `true`)
- `DISCOVER_MATCH_LOG_EVERY` (optional: log every N Polymarket markets; default `100`)
- `MATCH_FLUSH_EVERY` (optional: flush match CSVs every N rows; default `1000`)
- `MATCH_WORKERS` (optional: number of parallel workers for matching; default `1`)

## Trading (prep only)
- Copy `.env.example` to `.env` and fill in your keys locally.
- Keep `DRY_RUN=true` until you explicitly want live orders.

Notes:
- Polymarket trading is via the CLOB API. There isn’t an alternate official trading API path.
- Kalshi trading uses the trade API with RSA signing.

### Derive Polymarket API keys from your wallet
1) Set `POLY_WALLET_PRIVATE_KEY` in `.env`
2) Run:
```bash
npm run derive:poly
```
3) Copy the printed `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_PASSPHRASE` into `.env`

### Validate Polymarket API credentials
```bash
npm run check:poly
```

### Approve Polymarket CLOB allowances (direct EOA)
```bash
npm run approve:poly
```
Notes:
- Requires `POLY_RPC_URL` (Polygon RPC) and `POLY_WALLET_PRIVATE_KEY`.
- By default this approves USDC (collateral) only. Set `POLY_APPROVE_MODE=both` to also approve conditional tokens.

### Run a $1 test (live only when DRY_RUN=false)
1) Set `TRADE_PAIR_ID`, `TRADE_DIRECTION`, `TRADE_USD=1`
2) Set `DRY_RUN=false` when you are ready to go live
3) Run:
```bash
npm run trade
```

### Share-based sizing
If you set `TRADE_SHARES`, the script will treat that as the base leg size.
By default it sizes the other leg to match *winning-leg* profit after fees.
To match payout instead, set `HEDGE_TARGET=payout`:

```
TRADE_SHARES=100
TRADE_BASE_EXCHANGE=PM   # or KAL
HEDGE_TARGET=payout      # optional
```

Notes:
- Kalshi contract counts are rounded using `KALSHI_COUNT_ROUND`.
- The script logs an estimated net PnL for YES/NO outcomes in the post-trade summary.

### USD-based sizing with auto base exchange
If `TRADE_SHARES` is not set, the script uses `TRADE_USD` as the **total budget cap**
across both legs and auto-selects the base exchange by liquidity:

```
TRADE_USD=1
TRADE_BASE_EXCHANGE=AUTO   # default
```

It compares available liquidity at the limit price on both exchanges and
chooses the more constrained side first so the hedge can be sized reliably.

Notes:
- `TRADE_PARALLEL=true` submits both orders at the same time (best effort).
- Using FOK/IOC does not guarantee atomic execution across two exchanges.
- `AUTO_PICK=true` will ignore `TRADE_PAIR_ID` and pick the highest edge above `MIN_EDGE`.
- `HEDGE_TARGET=payout` will size both legs to the same payout (equal shares/contracts).

## Market discovery and matching
This script pulls all active/open markets from Polymarket and Kalshi, then
creates two CSVs:
- `data/market_matches_high.csv`
- `data/market_matches_review.csv`

Run:
```bash
npm run discover
```

### Rescore review matches (no re-scrape)
This re-scores only the existing review matches using the current logic and
promotes any that now qualify as high-precision:

```bash
npm run rescore:review
```

Outputs:
- `data/market_matches_high_rescored.csv`
- `data/market_matches_review_rescored.csv`

### Scan arbitrage from high matches
Uses `market_matches_high_rescored.csv` if it exists, otherwise `market_matches_high.csv`.
Writes:
- `data/latest_quotes_high.csv`
- `data/latest_arbs_high.csv`
- `data/latest_arbs_summary_high.csv`

Run:
```bash
npm run scan:high
```

## Notes
- The script assumes a standard (non-negative-risk) Polymarket market when deriving NO prices
  from YES bids/asks. If the market is negative-risk, NO prices are left blank.
- This is a read-only data collector; it does not place trades.
