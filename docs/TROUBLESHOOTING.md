# Troubleshooting

[English](./TROUBLESHOOTING.md) | [简体中文](./TROUBLESHOOTING.zh.md)

> Work through these in order; each one names the command that confirms or clears it.

## The tools do not appear in a session

- Confirm the row is composed: `dsh --profile web --dump-config | grep workspace-rewind`.
- Restart dsh: a bundle plugin binds during startup assembly, not while the process runs.
- Look for the degraded-mode warning about `@deepseek-ai/dsh-tools`; it means peer resolution failed.
- For a `link:`-installed copy on another drive, set `DSH_ROOT` to the dsh install root and retry.

## A path shows kept as is

- That path is secret-named or larger than `maxFileBytes`, so its content was never captured.
- The plugin will not guess its history and will not delete it; that is a deliberate data-safety decision.
- Raise `maxFileBytes` before the change you care about, then take a fresh checkpoint.

## The store keeps growing

- Run `rewind_status` to see `blobBytes / quota`.
- Over quota, GC evicts unreferenced blobs first, then the oldest non-restore records.
- To reclaim space immediately, purge the store directory — after confirming no checkpoint in it is still needed.

## A restore made things worse

- Run `rewind_undo apply=true`: every restore is preceded by a rescue record, so the restore itself is reversible.
- `rewind_undo` is repeatable, so it toggles between the two states like undo and redo.
- If the plan looked wrong before applying it, that is what `rewind_diff` is for — always preview first.

## After uninstalling, old records remain

- By design: `uninstall.sh` keeps the store, because it may be your only rollback evidence.
- Delete it explicitly with `./uninstall.sh --purge --yes` once you are sure.
