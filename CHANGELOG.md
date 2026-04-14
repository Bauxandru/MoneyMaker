# Changelog

All notable changes to this project are documented here. Entries are added by Claude after each modification session.

Format: `[YYYY-MM-DD] CATEGORY: description (files changed)`

Categories: `FEATURE`, `FIX`, `REFACTOR`, `CONFIG`, `SAFETY`, `HEDGE`, `RECONCILE`, `DISCOVERY`, `WS`, `DOCS`, `PERF`, `TEST`

---

## Log

[2026-04-13] DOCS: Upgraded CLAUDE.md — added trading lifecycle, safety invariants, ghost fill handling, hedge state machine, WS architecture, rate limiting, reconciliation phases, module dependency graph, data file semantics, config reference, known limitations, log prefixes, change logging rules, and command reference (CLAUDE.md)
[2026-04-13] DOCS: Added audit & observability systems documentation and Claude efficiency best practices to CLAUDE.md — covers all 3 audit layers (event log, audit log, reconcile audit), debugging playbook, and 19 operational rules for maximizing Claude effectiveness (CLAUDE.md, CHANGELOG.md)
[2026-04-13] SAFETY: Added pre-commit hook secret scanner — blocks .env files, private keys (ETH 0x+64hex, RSA PEM), API keys, RPC URLs, bearer tokens, and large files. Added git commit protocol to CLAUDE.md. Updated .gitignore for binaries/archives. (.git/hooks/pre-commit, CLAUDE.md, .gitignore)
[2026-04-13] FIX: Resolved 14 audit bugs across 5 files:
  - CRITICAL: Added persistence mutex (withArbTrades) to prevent concurrent read-modify-write races (ttPersistence.ts)
  - CRITICAL: Added idempotency guard to resolveArbTrade — prevents double-resolution within 5min (ttPersistence.ts)
  - CRITICAL: Added graceful shutdown handler (SIGINT/SIGTERM) — saves hedge state on exit (runARB.ts)
  - HIGH: Fixed ghost fill undercounting — filter now includes hedging trades with pmCost=0 (ttExecution.ts)
  - HIGH: Fixed min-size budget overrun — threshold reduced from 2x to 1.1x TRADE_USD (ttExecution.ts)
  - HIGH: Fixed hedge cost calc for PM-initial trades — uses hedgeKalFees instead of total kalFees (ttExecution.ts)
  - HIGH: Fixed NaN division in reconciliation when matched.shares=0 (ttReconcile.ts)
  - HIGH: Clear PM orderbooks on WS disconnect to prevent stale prices (ttWebSocket.ts)
  - HIGH: Added input validation on Kalshi WS data — rejects NaN, negative, out-of-range prices (ttWebSocket.ts)
  - MEDIUM: Fixed maker mode log always showing 5000ms elapsed (arithmetic bug) (ttExecution.ts)
  - MEDIUM: Fixed post-cancel fill default from stale kalFilled to 0 (ttExecution.ts)
  - MEDIUM: Added .catch() to hedge cycle Promise.race to prevent unhandled rejections (ttExecution.ts)
  - MEDIUM: Added hourly reconciliation overlap guard (runARB.ts)
  - MEDIUM: Added pending fill expiration (15-min TTL) with startup cleanup (ttPersistence.ts, runARB.ts)
  - FIX: Added missing audit import and ttAuditLog re-export (runARB.ts, index.ts)
[2026-04-14] FIX: Fixed hedge cycle deadlock — Promise.race timeout was not releasing _hedgeCycleLocks, causing all subsequent hedge cycles to skip forever. Added releaseHedgeCycleLock() export from ttHedge.ts. Timeout increased from 90s to 150s to accommodate max sequential await chain (waitForPmOrderFill 60s + verifyPmFill 60s = 120s). (ttExecution.ts, ttHedge.ts)
[2026-04-14] FIX: Added hedge inflight guard (_hedgeInflight set) preventing orphaned promise flood when runHedgeCycle hangs — at most 1 hanging cycle per position. (ttExecution.ts)
[2026-04-14] FIX: Added stale GTC order timeout (2h) in hedge cycle — orders with 0 fills after 2 hours are auto-cancelled instead of checking CLOB API (which hangs for settled markets). Reconciliation resolves the trade when market settles. (ttHedge.ts)
