# Changelog

[English](./CHANGELOG.md) | [简体中文](./CHANGELOG.zh.md)

> Format: newest first. Each release states what changed, why, and how it was verified.

## 1.0.0

First public release. The 0.1.x versions were development-line increments; they are kept below for history.

### Included

- Per-tool-call workspace checkpoints: every file mutation around a tool call is recorded, including changes made by shell commands rather than by file-editing tools.
- A content-addressed store outside the workspace, two restore modes (`revert` for one record, `asof` for a point in time), and a line-level diff preview with a dry run by default.
- Rescue records written before every restore plus `rewind_undo`, so a restore is itself reversible.
- Secret-named and oversized files are recorded as events only, and a restore plan keeps them as they are instead of guessing their history.

### Compatibility

- Developed and verified on dsh `0.1.5-rc.2` (Windows desktop harness) and `0.1.6-alpha.2` (WSL).
- Host APIs used: `ctx.tools.register` with `defineTool`, the `fs`-scoped `tools/execute` and `tools/post-execute` events, `ctx.systemPrompt.section`, `ctx.logger`, and `resolveDshHome`.

## 0.1.1

- **Fix**: quota GC bounded only *unreferenced* blobs, so a store whose every blob was referenced
  ignored `maxTotalBytes` entirely — measured at 932 KB under a 64 KB quota. The guard now evicts
  orphan blobs first, then drops the oldest non-restore records and rewrites the ledger atomically;
  restore and rescue records are exempt, so the undo trail survives.
- **Add**: `test/stress.test.mjs`, a bounded boundary suite (3000 files, 4-way concurrency) that
  caught the defect above. Repro: its section `[6]`.
- **Add**: measured numbers for the core claim — 88 ms fingerprint walk over 3000 files, 86 ms for a
  no-change capture versus 2936 ms for the initial full-content baseline.

## 0.1.0

- First release: per-tool-call capture built on a stat-only workspace fingerprint, so mutating shell
  commands are visible even though no file-tool argument mentions the paths they touch.
- Content-addressed blob store plus an append-only JSONL ledger under `$DSH_HOME/workspace-rewind/`,
  outside the workspace and outside git.
- Two restore semantics — `revert` (undo one record) and `asof` (return to a point in time) — with a
  line-level unified diff preview and a dry run by default.
- Rescue-before-restore and `rewind_undo`, making a restore itself reversible.
- Secret-named and oversized files are captured as events only, and restore plans keep them as they
  are instead of guessing their history.
- Zero runtime dependencies; offline smoke suite of 52 checks.
