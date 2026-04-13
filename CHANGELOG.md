# Changelog

All notable changes to this project are documented here. Entries are added by Claude after each modification session.

Format: `[YYYY-MM-DD] CATEGORY: description (files changed)`

Categories: `FEATURE`, `FIX`, `REFACTOR`, `CONFIG`, `SAFETY`, `HEDGE`, `RECONCILE`, `DISCOVERY`, `WS`, `DOCS`, `PERF`, `TEST`

---

## Log

[2026-04-13] DOCS: Upgraded CLAUDE.md — added trading lifecycle, safety invariants, ghost fill handling, hedge state machine, WS architecture, rate limiting, reconciliation phases, module dependency graph, data file semantics, config reference, known limitations, log prefixes, change logging rules, and command reference (CLAUDE.md)
[2026-04-13] DOCS: Added audit & observability systems documentation and Claude efficiency best practices to CLAUDE.md — covers all 3 audit layers (event log, audit log, reconcile audit), debugging playbook, and 19 operational rules for maximizing Claude effectiveness (CLAUDE.md, CHANGELOG.md)
[2026-04-13] SAFETY: Added pre-commit hook secret scanner — blocks .env files, private keys (ETH 0x+64hex, RSA PEM), API keys, RPC URLs, bearer tokens, and large files. Added git commit protocol to CLAUDE.md. Updated .gitignore for binaries/archives. (.git/hooks/pre-commit, CLAUDE.md, .gitignore)
