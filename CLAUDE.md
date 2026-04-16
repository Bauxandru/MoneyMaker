# Rules

## Debugging: Data First, No Speculation

- **Never assume or speculate about root causes.** Always read the actual data first: logs, trade records, pending fills, hedge state files, execution metrics.
- Before proposing a fix, find the specific log lines, timestamps, and data records that prove the cause.
- If the data contradicts your theory, abandon the theory immediately. Don't invent explanations to fill gaps.
- When asked "why did X happen", the answer must reference concrete evidence (file contents, log lines, timestamps), not code-path speculation.
- If you can't find the data to confirm a theory, say so. Don't present guesses as findings.

## Code Changes

- Read the code you're about to change. Don't modify code based on assumptions about what it does.
- Check actual runtime behavior (logs, data files) before and after changes when possible.
- When fixing bugs, verify the fix addresses the actual root cause found in data, not a hypothesized one.

## Environment

- **Windows host.** Paths use backslashes in raw PowerShell, forward slashes inside this bash shell. `NUL` on Windows = `/dev/null` in bash. Several runners are `.ps1` (`run_drytest.ps1`, `run_live_tennis.ps1`, `run_live_dota2.ps1`).
- **Line endings.** Don't mass-convert CRLF↔LF; git and the Node runtime handle both. Only normalise if a single file's endings are visibly mixed.

## Scratch files

- Files named `tmp_*.ts|.mts|.cjs|.mjs|.js` and `_debug*` / `_check*` at the repo root are ad-hoc investigation scripts. Do not commit them, do not delete them unless the user asks — they may be active drafts.
- When writing a new scratch script, prefix it with `tmp_` so the existing gitignore patterns catch it.

---

## Project Structure

- **Entry point:** `src/runARB.ts` -> runs via `npm run trade:arb` (`tsx src/runARB.ts`)
- **Runtime:** `tsx` (esbuild-based) — `export let` live bindings don't work across modules. Use getter functions instead.
- **Re-exports:** `src/ARB/index.ts` re-exports all ARB modules via `export *`.

### Module Map

| Module | Purpose |
|--------|---------|
| `ttConfig.ts` | Env vars, constants, rate-limited fetchers, pure helpers |
| `ttTypes.ts` | Shared type definitions (no runtime code) |
| `ttPersistence.ts` | File-based state I/O (trades, hedge, pending, metrics) |
| `ttDiscovery.ts` | Cross-platform pair detection (Kalshi <-> Polymarket) |
| `ttWebSocket.ts` | Live orderbook feeds + momentum tracking |
| `ttPmOrders.ts` | Polymarket CLOB client and order management |
| `ttExecution.ts` | Core arbitrage execution engine (~3800 lines) |
| `ttHedge.ts` | Hedge-mode logic for unhedged positions (~2800 lines) |
| `ttReconcile.ts` | Position reconciliation and ghost-fill handling (~2200 lines) |
| `ttEventLog.ts` | Audit trail for trading events |
| `ttAuditLog.ts` | Structured audit logging for debugging |
| `ttNameMatch.ts` | Cross-platform entity name matching |

### Module Dependency Graph

```
ttConfig ─────────────────────────────────────────────┐
ttTypes (pure types, no deps)                         │
ttAuditLog                                            │
ttPersistence ← ttConfig, ttAuditLog                  │
ttWebSocket ← ttConfig, ttAuditLog                    │
ttPmOrders ← ttConfig, ttWebSocket                    │
ttNameMatch (standalone)                              │
ttDiscovery ← ttConfig, ttNameMatch                   │
ttReconcile ← ttConfig, ttPersistence, ttWebSocket,   │
               ttPmOrders, ttNameMatch                │
ttHedge ← ttConfig, ttPersistence, ttWebSocket,       │
           ttPmOrders, ttReconcile, ttNameMatch        │
ttExecution ← ALL of the above                        │
runARB.ts ← ttExecution (entry point)                 │
```

**Blast radius:** Changes to `ttConfig` affect everything. Changes to `ttHedge` only affect hedge cycles. Changes to `ttReconcile` affect reconciliation + hedge (which calls reconcile functions). Always check the graph before modifying shared modules.

### Data Files

| File | Path | Role | Source of truth? |
|------|------|------|-----------------|
| Trade journal | `data/arb_trades.json` | All trades with status + P&L | No — bookkeeping only |
| Hedge state | `hedge_state.json` | Active hedge positions + orders | No — bookkeeping only |
| Pending fills | `data/pending_fills.json` | Orders in-flight (crash recovery breadcrumbs) | No — intent log |
| Execution metrics | `data/execution_metrics.json` | Timing + outcome per execution | Analytics only |
| Depth opportunities | `data/depth_opportunities.json` | Profitable depth snapshots | Analytics only |
| Book snapshots | `data/book_snapshots.json` | Orderbook samples during execution | Post-mortem analysis |
| Balance log | `data/balance_log.json` | Wallet balance at startup | Snapshot only |
| Reconcile audit | `data/reconcile_audit.json` | P&L correction trail (last 200) | Audit only |

**The on-chain wallet is the ultimate source of truth for positions.** Data files are bookkeeping. When files and wallet disagree, trust the wallet. Reconciliation bridges the gap between files and reality.

---

## Trading Lifecycle (Execution Flow)

The bot executes Kalshi-Polymarket arbitrage. The execution order is **intentional and safety-critical**:

```
1. DISCOVER pairs (Kalshi <-> PM matching)
2. SUBSCRIBE to WebSocket feeds (live orderbooks)
3. SCAN for edge (MIN_EDGE threshold across all directions)
4. DEPTH CHECK (verify MIN_DEPTH_MULT liquidity on both sides)
5. EXECUTE Kalshi leg FIRST (IOC or maker GTC)
6. EXECUTE PM leg SECOND (FOK — only if Kalshi filled)
7. RESULT:
   ├── Both filled → "resolved" (instant arb, P&L calculated)
   ├── Kalshi filled, PM failed → "hedging" (enter hedge mode)
   └── Both failed → abort (zero exposure)
8. HEDGE CYCLE (if hedging): place GTC orders to close position
9. RECONCILE (startup + hourly + on settlement)
```

### Why Kalshi First

Kalshi is executed first because:
- Kalshi IOC orders resolve in milliseconds (fill-or-reject)
- PM FOK orders are also instant, but PM has higher failure rates (425 errors, service down)
- If PM fails after Kalshi fills, we enter hedge mode (manageable). If Kalshi fails, we abort with zero exposure (safe).
- **Never reverse this order.** Executing PM first would create unhedged PM exposure on Kalshi failure with no reliable hedge path.

### Trading Directions

**2-way markets** (tennis, NBA, binary):
- `A`: buy KAL P1 YES + buy PM P2
- `B`: buy KAL P2 YES + buy PM P1
- `C`: buy KAL P1 NO + buy PM P1
- `D`: buy KAL P2 NO + buy PM P2

**3-way soccer** (Home/Draw/Away — KAL NO side):
- `G`: buy KAL Home NO + buy PM Home YES
- `H`: buy KAL Draw NO + buy PM Draw YES
- `I`: buy KAL Away NO + buy PM Away YES

**3-way soccer** (PM NO side):
- `J`: buy KAL Home YES + buy PM Home NO
- `K`: buy KAL Draw YES + buy PM Draw NO
- `L`: buy KAL Away YES + buy PM Away NO

---

## Critical Safety Invariants

**These rules exist to prevent real money losses. Do not remove, weaken, or bypass them.**

1. **Never execute the PM leg without confirmed Kalshi fill.** The PM order is only placed after Kalshi fill confirmation. This is the core safety guarantee — Kalshi-first execution means we never have naked PM exposure. *Exception:* `PARALLEL_MODE=true` races both legs simultaneously and relies on hedge-mode recovery to close any unmatched side. This breaks the invariant in exchange for latency; only enable it when KAL API latency is known stable and hedge capacity is available. The default is `false`.

2. **Reject edges > 45%.** Edges above 0.45 are almost certainly data errors (stale orderbook, mismatched markets). The bot aborts and session-skips. Esports/tennis can legitimately show 20-35% edges due to thin liquidity, but >45% is always suspicious.

3. **On-chain verification is mandatory for PM fills.** After PM order, the bot checks on-chain balance (RPC), then falls back to CLOB API, then data-api positions. Do not skip or remove these checks — PM orders can silently fail or silently succeed (ghost fills).

4. **FOK order type on PM.** PM uses Fill-Or-Kill (`OrderType.FOK`). This prevents partial fills that would leave mismatched position sizes. The CLOB also supports FAK (Fill-And-Kill) which allows partials — do not switch to FAK without understanding the hedge implications.

5. **Rate limiters must wrap every API call.** Every exchange API call must go through the rate-limited fetchers (`kalFetch`, `kalFetchHedge`, `polyFetch`, `polyClobFetch`). Raw `fetch()` calls will trigger 429 rate limit bans.

6. **Circuit breaker stops new arbs, not the bot.** When `MAX_CONSECUTIVE_ERRORS` (5) is hit or `MAX_HEDGE_POSITIONS` (8) is reached, the bot stops opening new positions but continues running (hedge cycles, reconciliation, WS feeds stay active). Do not change this to a full shutdown — active hedges need the bot running.

7. **DRY_RUN defaults to `true`.** The config defaults to dry-run mode. This is intentional — the bot must be explicitly enabled for live trading via env var `DRY_RUN=false`. Never change the default.

8. **Pending fills must not be deleted while executing.** The `_activePendingFillId` guard prevents ghost-fill detection from acting on a fill that's currently being processed by the execution engine. Removing this guard causes double-counting.

---

## Ghost Fill Handling

**Problem:** PM orders can appear to fail (HTTP timeout, 425 error) but actually fill on-chain. These are "ghost fills" — the bot thinks it has zero PM exposure, but shares were actually transferred.

**Why this matters:** Without ghost fill detection, the bot would:
- Not know it holds PM shares (lost capital)
- Not enter hedge mode (unhedged exposure)
- Potentially re-arb the same market (double exposure)

**Detection mechanisms (in priority order):**
1. **PM User WebSocket** — listens to `/user` channel for fill confirmations (most reliable)
2. **On-chain TransferSingle events** — watches conditional token transfers via WSS
3. **Execution-time verification** — captures on-chain balance before/after PM order and checks for new shares

**Recovery flow (`handleGhostFill`):**
1. Ghost detected via WS or on-chain event
2. Guard: skip if `_activePendingFillId` matches (execution in progress)
3. Guard: skip if resolved trade already exists (stale duplicate)
4. Find matching trade in `"hedging"` status
5. Apply actual fill price via CLOB API (fallback to pending fill price)
6. Resolve trade if margin allows (costPerShare < $1), else enter hedge mode

**Do not simplify or remove:**
- The `pending_fills.json` system (crash recovery breadcrumbs)
- The on-chain balance checks in execution (ghost detection)
- The `_activePendingFillId` guard (prevents race conditions)

---

## Hedge State Machine

Trades follow this state machine:

```
                    ┌─────────────┐
    Both legs fill  │  "resolved" │  ← terminal state, P&L calculated
    instantly       └─────────────┘
         ▲                ▲    ▲
         │                │    │
   ┌───────────┐    hedge │    │ market
   │ "filled"  │    completes  │ settles
   └───────────┘          │    │
         ▲          ┌───────────┐
         │          │ "hedging" │  ← one leg filled, other failed
    both legs       └───────────┘
    filled               ▲
    (legacy)             │
                    one leg fails
```

### Status Values
- `"hedging"` — One leg filled, actively placing GTC orders to close the other side
- `"filled"` — Both legs confirmed filled, awaiting settlement (legacy; new trades go straight to resolved)
- `"resolved"` — Terminal. P&L calculated. Trade is done.

### Resolution Methods
- `"both-legs"` — Both initial legs filled immediately (instant arb)
- `"hedge-complete"` — Hedge GTC order filled after initial partial
- `"settlement"` — Market settled while position was hedging
- `"hedge-reconciled-onchain"` — On-chain verification during reconciliation confirmed hedge

### Hedge Persistence
- Hedge state lives in `hedge_state.json` (survives restarts)
- Tracks: shares held, exchange held (kal/pm), cost basis, active GTC orders, fill progress
- **Known issue:** Resolved trades may linger in `hedge_state.json` after resolution — reconciliation cleans this up but there can be a lag

### Scalar Settlement / Cancellation Detection
- Markets can be cancelled or settle as "scalar" (fractional payout, not binary 0/1)
- `isScalarSettlement()` detects non-binary settlement values
- `runCancellationMonitor()` periodically checks for void/cancelled markets
- On cancellation: emergency sell PM shares if possible, mark `scalarSettlement: true`

---

## WebSocket Architecture

### Orderbook State (in-memory Maps)

```typescript
wsKalBooks: Map<string, WsLiveBook>   // ticker -> { yes: Map<price,size>, no: Map<price,size>, ts }
wsPmBooks:  Map<string, WsPmBook>     // tokenId -> { bids: Map<price,size>, asks: Map<price,size>, ts }
```

These Maps are the **primary price source** during execution. The main loop reads from them with zero API calls per cycle.

### Staleness Rules
- **Kalshi WS stale:** `KAL_WS_STALE_MS` = 600,000ms (10 min) — falls back to REST orderbook
- **PM WS stale:** `PM_WS_STALE_MS` = 300,000ms (5 min) — falls back to CLOB data-api
- Stale detection checks the `ts` field on each book entry

### Momentum Tracking
- `_priceHistory: Map<string, PriceSample[]>` — keyed as `"kal:{ticker}:{yes|no}"` or `"pm:{tokenId}"`
- Window: `MOMENTUM_WINDOW_MS` = 60,000ms (1 min)
- Sample interval: `MOMENTUM_SAMPLE_INTERVAL_MS` = 500ms
- Pruned every `PRUNE_INTERVAL_MS` = 300,000ms (5 min)

### PM Service Down Handling
- 425 errors trigger exponential backoff: base 30s, max 300s
- `pmServiceDownUntil` timestamp blocks PM orders during backoff
- `pmConsecutive425` counter tracks consecutive failures

---

## Rate Limiting & Timing

**All API calls MUST use the rate-limited fetchers. Never use raw `fetch()`.**

| Fetcher | Interval | Rate | Use for |
|---------|----------|------|---------|
| `kalFetch` | 50ms | ~20/s | Main Kalshi API calls |
| `kalFetchHedge` | 50ms | ~20/s | Hedge-specific Kalshi calls (separate queue) |
| `polyFetch` | 35ms | ~30/s | Gamma API (discovery, market data) |
| `polyClobFetch` | 7ms | ~150/s | CLOB orderbook + order placement |

### Retry Configuration
- Default: `timeoutMs: 12000, maxRetries: 3, baseDelayMs: 600, maxDelayMs: 8000, jitterMs: 200`
- Hedge fetcher: `maxRetries: 1, timeoutMs: 8000` (faster failure for time-sensitive hedge orders)

### Timing Constants
- `POLL_INTERVAL_MS` = 0 (max speed main loop, configurable via `TRADE_LOOP_MIN_INTERVAL_MS`)
- `TRADE_COOLDOWN_MS` = 60,000ms (1 min between arb attempts on same pair)
- `KAL_MAKER_WAIT_MS` = 5,000ms (GTC maker order timeout before IOC fallback)
- `KAL_MAKER_POLL_MS` = 500ms (poll interval during maker wait)

---

## Reconciliation

### Test coverage (what is and is not tested)

Test files under `src/ARB/*.test.ts` (run with `npm run test`):
- `ttConfig.test.ts` — fee math only
- `ttDiscovery.test.ts` — helper functions (not the main discovery loop)
- `ttHedge.test.ts` — `isScalarSettlement` only (not `runHedgeCycle`)
- `ttNameMatch.test.ts` — reasonably thorough
- `ttPersistence.test.ts`, `ttPmOrders.test.ts`, `ttWebSocket.test.ts` — smoke-level

**Untested:** `ttExecution.ts` (`executeArb`, `monitorLoop`), the four reconciliation phases in `ttReconcile.ts`, `runHedgeCycle` in `ttHedge.ts`, ghost-fill recovery. Assume any change to these lands without a safety net — walk the code path carefully and verify invariants manually.

### When It Runs
- **Startup** — `reconcilePositions("startup")` — initial state repair
- **Hourly** — `setInterval` in `runARB.ts`
- **Settlement** — triggered when Kalshi market settlement detected via WS

### Phases (executed in order)

| Phase | What it does |
|-------|-------------|
| **(a)** Fix "hedging" trades | Check if market settled, find Kalshi fills by timestamp, look for hedge fills, resolve if both legs found |
| **(a2)** Fix hedging with both legs | If both legs have costs > 0, mark resolved with "both-legs" |
| **(b)** Fix "filled" instant-arbs | Legacy — verify both legs have prices, mark resolved |
| **(c)** Repair PM costs via CLOB | Fetch all CLOB trades, match by timestamp (+-1h), fix pmFillPrice + pmCost |
| **(d)** Verify & fix P&L | Recalculate based on settlement result, handle scalar/void, fix hedge-complete math |

### Timestamp Matching
- Phase (c) matches PM fills by timestamp within +-1 hour
- This is a **heuristic** — it can miss fills or mis-assign if multiple trades happen close together
- Known fragility: the reconciliation system is the most complex and brittle component (~1000 lines)

### Audit Trail
- All field changes logged to `data/reconcile_audit.json`
- Tracked fields: status, resolutionMethod, kalCost, pmCost, totalCost, kalFillPrice, pmFillPrice, realizedPnl, resolvedTs, hedgeCost
- Rolling log, last 200 entries

---

## Configuration Reference

### Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `true` | **Must be explicitly set to `false` for live trading** |
| `TRADE_USD` | `10` | Budget per arb in USD |
| `MAX_CONTRACTS` | `999` | Max contracts per leg |
| `MIN_EDGE` | `0.02` (2%) | Minimum edge to trigger arb |
| `MIN_DEPTH_MULT` | `2` | Liquidity must be >= Nx trade size (0 = disable) |
| `HEDGE_TARGET` | `"payout"` | Hedge pricing target (`"payout"` or `"profit"`) |
| `KAL_MAKER_MODE` | `false` | Use GTC maker orders on Kalshi (1.75% fee vs 7%) |
| `MAX_CONSECUTIVE_ERRORS` | `5` | Circuit breaker threshold |
| `MAX_HEDGE_POSITIONS` | `8` | Max concurrent hedge positions |
| `DISCOVERY_CACHE_TTL_MS` | `21,600,000` (6h) | Discovery cache lifetime (0 = date-based, stale at midnight UTC) |
| `LIVE_ONLY` | `false` | Skip pre-match trades |
| `FORCE_DISCOVER` | `false` | Force fresh discovery ignoring cache |
| `PM_ONLY_MAX_CYCLES` | `15` | Max cycles for PM-only mode |
| `STRICT_HEDGE` | `false` | Strict hedge matching |

### Fee Rates
- **Kalshi taker:** 7% (`KALSHI_FEE_RATE = 0.07`)
- **Kalshi maker:** 1.75% (`KALSHI_MAKER_FEE_RATE = 0.0175`)
- **PM taker:** 3% (`PM_FEE_RATE = 0.03`), PM makers pay 0%

---

## Known Limitations & Technical Debt

These are known issues. Do not waste time "discovering" them — they're documented here intentionally. Tags: **[important]** = watch for regressions / fix when related work touches it, **[cosmetic]** = acknowledged, low priority.

1. **[important] Fractional share rounding.** PM can return fractional shares (e.g., 11.55 instead of 11). Kalshi only supports integers. Rounding is handled ad-hoc throughout the codebase rather than with fixed-point math.

2. **[important] Reconciliation timestamp matching is heuristic.** Phase (c) matches PM fills by timestamp within +-1 hour. Multiple trades in the same window can be mis-assigned. The `usedPmIdx` / `otherKalClaimedC` claim-sets in `ttReconcile.ts` prevent the worst cases — **do not remove them**. There's no direct fill-to-trade ID linkage.

3. **[important] PM data-api avgPrice may differ from fill price.** When on-chain RPC fails and data-api is used as fallback, the reported price may be market price, not actual fill price. Binary market price inversion guards exist but edge cases remain.

4. **[cosmetic] Pending fills have no expiration.** If execution crashes after creating a pending fill but before marking it complete, the record stays forever. Ghost detector handles some cases; a 15-min startup sweep now exists but runtime expiration does not.

5. **[cosmetic] Hedge state cleanup lag.** Resolved trades can linger in `hedge_state.json` after the trade is marked resolved in `arb_trades.json`. Reconciliation eventually cleans this up but there's a window of inconsistency.

6. **[cosmetic] No running P&L on hedge positions.** Hedging trades don't show estimated profit/loss until resolved. Capital tied up in hedges is a black box until resolution.

7. **[cosmetic] No slippage tracking.** Projected edge at discovery time is not compared to actual fill prices. No metric for how much slippage occurs.

8. **[cosmetic] Session skip set is session-wide, not status-aware.** `sessionSkipSet` blocks re-arbing a match for the entire session; at startup it's seeded from `recent (3 days)` OR `active (hedging/filled)` trades, so old-but-active positions are covered. There's no runtime sync — if a hedging trade resolves mid-session the match stays skipped, which is the intended conservative behaviour.

---

## Log Prefixes

| Prefix | Component |
|--------|-----------|
| `[BOOT]` | Startup phase |
| `[TRADER]` | Entry point messages |
| `[DISCOVER]` | Watchlist discovery |
| `[WS]` | WebSocket status |
| `[STARTUP]` | Startup reconciliation |
| `[CHAIN]` | On-chain events |
| `[RECONCILE]` | Hourly/settlement reconciliation |
| `[HEDGE]` | Hedge cycle progress |
| `[EXECUTE]` | Order execution |
| `[GHOST]` | Ghost fill detection |
| `[TIMING]` | Execution timing breakdown |
| `[DEPTH]` | Liquidity depth checks |
| `[PENDING]` | Pending fill tracking |
| `[ABORT]` | Failed executions (with reasons) |
| `[DRY]` | Dry-run mode |

---

## Change Logging Protocol

**After every code modification session, Claude must:**

1. **Append an entry to `CHANGELOG.md`** with format:
   ```
   [YYYY-MM-DD] CATEGORY: description (files changed)
   ```
   Categories: `FEATURE`, `FIX`, `REFACTOR`, `CONFIG`, `SAFETY`, `HEDGE`, `RECONCILE`, `DISCOVERY`, `WS`, `DOCS`, `PERF`, `TEST`

2. **Update this CLAUDE.md if the change is significant.** A change is significant if it:
   - Adds, removes, or renames a module
   - Changes the execution flow or leg ordering
   - Adds or modifies a safety invariant
   - Changes the hedge state machine (new status, new resolution method)
   - Adds or removes a data file
   - Changes fee rates, rate limiter intervals, or default config values
   - Changes WebSocket channels or staleness thresholds
   - Changes reconciliation phases or triggers
   - Adds or resolves a known limitation
   - Adds a new npm script / command

3. **What NOT to log:** Typo fixes, comment edits, log message tweaks, formatting-only changes. Only log changes that affect behavior.

4. **When updating CLAUDE.md:** Update the specific section affected — don't rewrite the whole file. If adding a new module, add it to the Module Map and Dependency Graph. If changing a default, update the Configuration Reference table.

---

## Git Commit Protocol

**Claude must commit and push after every modification session.** This is a hard rule to prevent work loss.

### Explicit commit authorization (overrides default "ask before committing")

The user hereby authorizes Claude to `git commit` and `git push` to
`origin main` at the end of every modification session, **without
asking first**, provided:

- All staged files are source (`.ts`, `.tsx`, `.js`, `.mjs`, `.md`),
  config (`package.json`, `tsconfig.json`, `.gitignore`), or tests.
- No file under `data/`, `.env*`, `hedge_state.json`, `node_modules/`,
  `dist/`, or `secrets/` is staged.
- The pre-commit secret scanner hook passes.
- The commit message uses the project's style: short subject line
  (under 70 chars), bulleted body explaining *why* and *what*,
  `Co-Authored-By: Claude <noreply@anthropic.com>` (or the current model identifier)
  trailer.

This authorization **overrides** the default global "never commit
unless user explicitly asks" safety. The scope is limited to this
repo. When in doubt about whether a file belongs in the commit,
err on the side of leaving it unstaged and ask — but don't use
uncertainty about one file as an excuse to skip committing the rest.

An external `Stop` hook at `~/.claude/hooks/git-uncommitted-check.sh`
warns if a session ends with uncommitted source files, as a safety net.

### After Every Change

1. **Stage changed files** — use specific filenames, never `git add -A` or `git add .`
2. **Commit** with a descriptive message following the project style
3. **Push** to `origin main`

### What Gets Committed

- All modified source files (`src/**/*.ts`)
- Config files (`package.json`, `tsconfig.json`, `.gitignore`)
- Documentation (`CLAUDE.md`, `CHANGELOG.md`, `README.md`)
- Build/deploy scripts (`build/`, `scripts/`)
- Test files (`*.test.ts`, `vitest.config.ts`)

### What NEVER Gets Committed

- `.env`, `.env.*` — secrets (blocked by pre-commit hook)
- `secrets/`, `certs/` — key files (blocked by pre-commit hook)
- `data/` — runtime trade data, logs, metrics
- `hedge_state.json` — live hedge positions
- `discovery_cache.json` — ephemeral cache
- `node_modules/`, `dist/` — build artifacts
- `tmp_*`, `_temp*` — debug/scratch files
- `*.7z`, `*.exe`, `*.lnk` — binaries/shortcuts

### Secret Scanner (Pre-Commit Hook)

A git pre-commit hook (`.git/hooks/pre-commit`) automatically scans every commit for:
- `.env` files, `.pem` files, `secrets/` directory
- Ethereum private keys (`0x` + 64 hex chars)
- API key assignments (`API_KEY = ...`, `POLY_API_SECRET = ...`)
- RSA/EC private key headers (`-----BEGIN PRIVATE KEY-----`)
- Alchemy/Infura RPC keys in URLs
- Hardcoded passwords and bearer tokens
- Files > 1 MB (warns but doesn't block)

**If the hook blocks a commit:** Fix the issue. Only use `--no-verify` if you're 100% sure it's a false positive.

**If the hook is missing after a fresh clone:** Re-create it from this doc or copy from another local clone. Git hooks are not tracked in the repo.

---

## Command Reference

### Core Bot

| Command | What it does |
|---------|-------------|
| `npm run trade:arb` | **Start the live ARB bot** (main entry point, `src/runARB.ts`) |
| `npm run trade` | Run the legacy trade bot (`src/trade.ts`) |
| `npm run trade:tennis` | Run tennis-specific trader (`src/tradeTennis.ts`) |
| `npm run dashboard` | Start the web dashboard (`src/dashboard.ts`) |

### Scanning / Discovery

| Command | What it does |
|---------|-------------|
| `npm run discover` | Run market discovery (`src/discover.ts`) |
| `npm run scan:all` | Scan all sports for arb opportunities |
| `npm run scan:sports` | Scan sports markets |
| `npm run scan:tennis` | Scan tennis markets only |
| `npm run scan:nba` | Scan NBA markets only |
| `npm run scan:mlb` | Scan MLB markets only |
| `npm run scan:nhl` | Scan NHL markets only |
| `npm run scan:soccer` | Scan soccer markets only |
| `npm run scan:esports` | Scan esports (CS2, Valorant, LoL, CoD) |
| `npm run scan:high` | Scan for high-edge matches |
| `npm run scan:intra` | Scan intra-platform opportunities |
| `npm run scan:multi` | Scan multi-outcome markets |
| `npm run scan:negrisk` | Scan negative-risk strategy opportunities |
| `npm run scan:focus` | Focused scan (uses PowerShell script) |
| `npm run scan:focus:fast` | Focused scan, skip discovery phase |
| `npm run scan:excel-only` | Scan Excel-only arbs (PowerShell) |
| `npm run scan:excel-similar` | Scan Excel-similar arbs (PowerShell) |

### Maintenance / Repair

| Command | What it does |
|---------|-------------|
| `npm run sync` | Run position reconciliation (`src/_reconcile.ts`) |
| `npm run hedge` | Run standalone hedge cycle (`src/_hedge.ts`) |
| `npm run repair:trades` | Repair trade records (`src/repairTrades.ts`) |
| `npm run audit:balances` | Compare bot P&L vs actual wallet wealth; detect deposits/withdrawals (`src/auditBalances.ts`) |
| `npm run prune:pm` | Remove stale Polymarket data |
| `npm run prune:high:mna` | Prune high-match MNA data |
| `npm run expand:opt` | Expand optimized arb entries |

### Polymarket Wallet

| Command | What it does |
|---------|-------------|
| `npm run derive:poly` | Derive Polymarket keys from wallet |
| `npm run check:poly` | Verify Polymarket auth/credentials |
| `npm run approve:poly` | Approve CLOB token allowance |

### Reports / Analysis

| Command | What it does |
|---------|-------------|
| `npm run watchlist:report` | Generate watchlist arbs report (PowerShell) |
| `npm run build:sotu-config` | Build SOTU config (PowerShell) |
| `npm run bench:latency` | Benchmark API latency |
| `npm run live:mention` | Live mention tracker |

### Build / Deploy

| Command | What it does |
|---------|-------------|
| `npm run build` | TypeScript compile (`tsc`) |
| `npm run build:exe` | Build standalone executable |
| `npm run deploy` | Deploy (patch version bump) |
| `npm run deploy:minor` | Deploy with minor version bump |
| `npm run deploy:major` | Deploy with major version bump |
| `npm run start` | Run compiled dist (`node dist/index.js`) |

### Development / Testing

| Command | What it does |
|---------|-------------|
| `npm run dev` | Run dev mode (`tsx src/index.ts`) |
| `npm run test` | Run tests (`vitest run`) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run license-server` | Start license server |

### Most Used (Quick Reference)

```bash
npm run trade:arb        # Start the bot
npm run sync             # Reconcile positions
npm run hedge            # Run hedge cycle
npm run dashboard        # Start dashboard
npm run scan:all         # Scan all markets
npm run repair:trades    # Fix trade records
npm run test             # Run tests
```

---

## Audit & Observability Systems

The bot has 3 distinct audit layers. Know which one to read for what.

### Layer 1: Exchange Event Log (authoritative trade reconstruction)

- **File:** `data/exchange_events.jsonl` (JSONL, one event per line)
- **Rotation:** 50 MB + 3 rotated files (.1, .2, .3) — ~2-3 weeks retention
- **Sequence:** Monotonic `seq` counter persisted in `data/event_seq.txt`
- **In-memory indexes:** `_tradeIndex` (by tradeId), `_orderIndex` (by orderId), `_fillCumMap` (dedup)
- **Query API:** `getTradeEvents(tradeId)`, `getOrderEvents(orderId)`, `getAllEvents()`
- **Shadow comparison:** `shadowCompare()` runs every 60s, compares JSON trade records vs event-computed records

**Event types:**
| Event | When | Key fields |
|-------|------|------------|
| `order-placed` | Order submitted | exchange, orderId, shares, price, role (initial/hedge-complete/hedge-exit) |
| `fill-detected` | Fill received | shares, price, cumulativeFilled, source (ws-matched/rest-poll/onchain/clob-trades) |
| `order-cancelled` | Order cancelled | preCancelFills |
| `settlement-detected` | Market settled | result, payout, source (kal-ws/kal-api/pm-resolution/reconcile) |
| `position-snapshot` | Position verified | shares, source (kal-api/pm-onchain/pm-clob) |
| `fill-correction` | Retroactive fix | oldPrice, newPrice, reason |

**When to use:** Reconstructing what actually happened for a specific trade. This is the most reliable source for fill-level detail.

### Layer 2: Structured Audit Log (debugging breadcrumbs)

- **File:** `data/arb_audit.log` (JSONL)
- **Rotation:** 5 MB + 3 rotated files — ~2-3 days retention
- **No in-memory index** — append-only, parse externally with `jq`/`grep`
- **Fields:** `ts`, `module` (exec/hedge/reconcile/persist/ws/ghost), `fn`, `action`, `tradeId`, `context`

**When to use:** Understanding *why* something happened. The event log tells you *what* (fill at price X), the audit log tells you *why* (reconciliation triggered because hourly timer fired).

### Layer 3: Reconciliation Audit (P&L change trail)

- **File:** `data/reconcile_audit.json` (JSON array)
- **Retention:** Last 200 entries — ~1-2 weeks
- **Tracked fields:** status, resolutionMethod, kalCost, pmCost, totalCost, kalFillPrice, pmFillPrice, realizedPnl, resolvedTs, hedgeCost
- **Format:** `{ ts, trigger, changeCount, changes: [{ tradeId, field, oldValue, newValue }] }`

**When to use:** Understanding why a trade's P&L or status changed. Shows before/after for every reconciliation modification.

### Audit Gaps (known)

1. **No centralized database** — 8+ separate files with different formats and retention
2. **No cross-file correlation** — can't easily link event → audit → reconcile → trade record in one query
3. **SQLite exists but unused by ARB** — `better-sqlite3` in deps, tables in `src/db.ts`, but only for discovery, not the trading system
4. **No archive strategy** — rotated files are deleted, not archived
5. **Retention is short** — event log ~2-3 weeks, audit log ~2-3 days, reconcile audit ~1-2 weeks

### Debugging Playbook

| Question | Where to look | How |
|----------|--------------|-----|
| "What fills did trade X get?" | Event log | `getTradeEvents(tradeId)` → filter `fill-detected` |
| "Why was trade X's P&L changed?" | Reconcile audit | Parse `reconcile_audit.json`, filter by tradeId |
| "Why did reconciliation run?" | Audit log | `grep "reconcile" data/arb_audit.log \| jq .trigger` |
| "Is trade record accurate?" | Shadow compare | `computeTradeFromEvents(tradeId)` vs `arb_trades.json` |
| "What's the on-chain position?" | Event log | Filter `position-snapshot` events for the token |
| "Did a ghost fill happen?" | Audit log | `grep "ghost" data/arb_audit.log` |
| "What orders are still open?" | Hedge state | Read `hedge_state.json` → `activeOrders` |
| "How long did execution take?" | Metrics | Read `data/execution_metrics.json` |

---

## Claude Efficiency & Best Practices

**These rules maximize Claude's effectiveness when working on this codebase. Follow them in every session.**

### Before Touching Code

1. **Read before writing.** Always read the file you're about to modify. This bot has subtle interdependencies — a function that looks simple may have safety implications documented only in its callers.

2. **Check the dependency graph.** Before modifying a shared module (ttConfig, ttPersistence, ttWebSocket), understand what depends on it. The Module Dependency Graph section above shows the blast radius.

3. **Check the known limitations list.** Before investigating a bug, scan the Known Limitations section. The issue may already be documented. Don't waste a session rediscovering a known problem.

4. **Read the data, not just the code.** This is a live trading bot. When debugging, always check `data/arb_trades.json`, `hedge_state.json`, `data/pending_fills.json`, and relevant log files. The data often reveals the problem faster than tracing code paths.

### During Code Changes

5. **One concern per change.** Don't mix a bug fix with a refactor with a feature. Each change should be isolated and reviewable. If you find a secondary issue while fixing something, note it but don't fix it in the same change.

6. **Preserve safety invariants.** Before modifying execution, hedge, or reconciliation code, re-read the Critical Safety Invariants section. If your change would violate any invariant, stop and discuss with the user.

7. **Use the audit systems.** When adding new trade-affecting logic:
   - Add `logEvent()` calls for exchange-level actions (orders, fills, settlements)
   - Add `audit()` calls for decision-level actions (why something happened)
   - These are not optional logging — they are the trade reconstruction trail

8. **Test with DRY_RUN=true.** Never suggest running live trades to test a change. Always verify logic with dry-run first. The bot defaults to dry-run for this reason.

9. **Rate limiters are mandatory.** Every new API call must use the appropriate rate-limited fetcher. Check the Rate Limiting section for which fetcher to use. Raw `fetch()` = exchange ban.

### When Debugging

10. **Follow the evidence chain.** For any trade issue, work through these layers in order:
    - Event log (`exchange_events.jsonl`) — what fills/orders actually happened
    - Trade record (`arb_trades.json`) — what the bot thinks happened
    - On-chain state (if accessible) — what actually happened on-chain
    - Audit log (`arb_audit.log`) — why the bot made decisions
    - Reconcile audit (`reconcile_audit.json`) — what was corrected after the fact

11. **Timestamps are your friend.** Every system uses ISO timestamps. When correlating across files, match by time window. The event log has millisecond precision; the audit log has second precision.

12. **Shadow compare catches drift.** If trade records seem wrong, check if `shadowCompare()` has flagged discrepancies. The event log is authoritative — if it disagrees with `arb_trades.json`, the event log is right.

### When Proposing Architecture Changes

13. **Scope before building.** For anything beyond a single-file change, outline the plan first: which files change, what's the blast radius, what could break. Get user confirmation before implementing.

14. **Don't migrate mid-session.** Large refactors (like moving from JSON files to SQLite) should be planned across sessions with rollback strategy. Don't start a migration you can't finish in one session.

15. **Backward compatibility matters.** The bot persists state in JSON files. If you change a schema (add/remove/rename fields), ensure the code handles old records gracefully. Use `??` defaults, not hard crashes.

### Session Workflow

16. **Start by understanding the ask.** Read the user's request, identify which modules are involved, and read those modules before proposing changes. Don't start coding from a summary — read the actual code.

17. **After every change, update the changelog.** Follow the Change Logging Protocol section. If the change is significant, update this CLAUDE.md too.

18. **End with verification.** After making changes:
    - Run `npm run build` to verify TypeScript compiles
    - Run `npm run test` if tests exist for the modified area
    - If modifying execution/hedge/reconcile, walk through the affected code path mentally and verify safety invariants still hold

19. **When unsure, ask.** This is a live trading bot handling real money. If you're uncertain whether a change is safe, ask the user rather than guessing. The cost of a wrong change is measured in dollars, not just bugs.

### What NOT to Do

- **Don't add console.log for debugging and leave it in.** Use the audit systems (`audit()`, `logEvent()`) instead.
- **Don't create wrapper utilities for one-time operations.** This codebase values directness over abstraction.
- **Don't "optimize" reconciliation heuristics without data.** The timestamp matching, phase ordering, and fallback logic was tuned against real trade data. Changes need evidence, not theory.
- **Don't change file formats without a migration path.** JSON → JSONL, array → object, field renames — all need backward-compatible reads.
- **Don't add dependencies without justification.** Each dependency is an attack surface and a maintenance burden. The bot runs on a minimal dep set intentionally.
