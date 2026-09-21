# dsh-workspace-rewind

**English** | [简体中文](./README.zh-CN.md)

Per-tool-call workspace checkpoints for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) — **captures every file mutation, including shell side effects**, with content-addressed storage, line-level diff preview, selective restore, and undoable restores.

## Why

Every checkpoint system we could find — Claude Code `/rewind`, Cursor, and all four rollback plugins in the DSH market — only tracks changes made through file-editing tools. The [Claude Code docs state it explicitly](https://code.claude.com/docs/en/checkpointing):

> **Bash command changes not tracked** — Checkpointing does not track files modified by Bash commands. For example `rm file.txt`, `mv old.txt new.txt`, `cp source.txt dest.txt` — these cannot be undone through rewind.

Cline solves this with a shadow-git commit of the whole repo after *every* tool call, and [its own docs admit](https://docs.cline.bot/core-workflows/checkpoints) large repositories suffer *significant storage and slowdown*.

`dsh-workspace-rewind` closes the gap with a different mechanism: a stat-only workspace fingerprint diff around each tool call. Any mutation is seen — `bash`, `pwsh`, `write`, `edit`, MCP tools, subagents — while the cost stays O(files) stat work plus content reads *only for files that actually changed*.

## How it works

```
tools/execute (before) ──> mark pending, capture baseline on first call
        │  (the tool runs: bash rm/mv/sed, write, edit, MCP …)
tools/post-execute ─────> fingerprint diff → read changed files →
                          content-addressed blobs (sha-256, deduped) →
                          append-only ledger record
```

- **Storage** lives in `$DSH_HOME/workspace-rewind/` — never inside your workspace, never touches your git repo. Layout: `blobs/<h[:2]>/<sha256>` + `ledger.jsonl`.
- **Restore** has two explicit semantics:
  - `revert` — undo exactly one record's delta (the "undo what just broke" case),
  - `asof` — return the whole workspace to the state recorded at a checkpoint (folds the ledger forward *and* resolves files created after the target).
- **Every restore is protected**: before applying, the affected paths' current state is stored as a *rescue* record. `rewind_undo` restores the rescue — repeated calls toggle undo/redo. Restores are crash-safe (rescue is written before any byte changes).
- **Safety by construction**: symlink/hardlink contents are never followed or written through; `.git`/`node_modules` and friends are excluded; secret-looking files (`.env`, `*.pem`, `*.key`, …) and oversized files are recorded as *events* with no content — they can never be clobbered by a restore plan, only reported.
- **Zero runtime dependencies.** No git CLI, no native modules, no bundler. Pure ESM on Node ≥ 20.

## Install

```bash
dsh plugin --profile web add dsh-workspace-rewind
```

Restart DSH (bundle plugins bind at assembly). Verify: `dsh --profile web --dump-config | grep workspace-rewind`.

## Tools

| Tool | What it does |
| --- | --- |
| `rewind_now` | Create a manual checkpoint right now (e.g. before a risky operation) |
| `rewind_list` | Recent records, newest first: id, time, tool, `+A ~M -D`, sample paths |
| `rewind_diff` | Restore plan + **line-level unified diff**, changes nothing |
| `rewind_restore` | Restore with `mode=revert` (undo one record) or `mode=asof` (point-in-time). `apply=false` (default) = dry run |
| `rewind_undo` | Undo the last restore (toggle = undo/redo) |
| `rewind_status` | Store stats: records, blobs, bytes, quota, config |

`rewind_restore` and `rewind_undo` default to a **dry run** — the agent must pass `apply=true`, which keeps a human (or the agent echoing the plan first) in the loop.

## Configuration (inline config in `cordis.patch.yml`)

```yaml
- insert:
    - id: workspace-rewind
      name: 'dsh-workspace-rewind'
      config:
        capture: all            # all | fileTools | off
        maxFileBytes: 8388608   # per-file content cap (larger = event only)
        maxFiles: 20000         # per-walk file cap
        maxTotalBytes: 536870912  # store quota; LRU eviction of unreferenced blobs
        keepRecords: 500        # ledger trim threshold
        excludes: ['.git', 'node_modules', 'dist', 'build']   # merged with defaults
        secretNames: ['.env', '*.pem', '*.key']               # merged with defaults
```

## Verification

`npm test` runs an offline smoke suite (52 assertions) covering capture, bash side effects, dedup, quota GC, asof/revert restore, rescue, undo toggling, secret-file safety, and the built-in Myers diff. No DSH installation required.

Real-harness verification performed on `0.1.6-alpha.2` (headless profile, isolated `DSH_HOME`): bash-caused file mutation captured with a revertible `prev` hash; revert restored the damaged file on disk; `rewind_undo` toggled the restore back; zero loader errors. See `docs/DESIGN.md` for the competitive evidence and `docs/VERIFICATION.md` for the raw transcripts.

## Known limitations

- External edits made *between* tool calls are attributed to the next captured call (same class of limitation as Cline's approach).
- Files whose content was never captured (secret-named, oversized, or deleted before first capture) cannot be content-restored; plans keep them untouched and say so.
- The fingerprint walk is O(workspace files); huge monorepos should raise `excludes` or use `capture: fileTools`.

## License

MIT
