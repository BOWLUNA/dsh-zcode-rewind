# Architecture

[English](./ARCHITECTURE.md) | [简体中文](./ARCHITECTURE.zh.md)

> Why this plugin exists, and which design decisions are load-bearing.

## The gap

| Project | Capture mechanism | Blind spot |
| --- | --- | --- |
| Claude Code | per-turn checkpoint of file-tool edits | official docs: bash-modified files are not tracked |
| Cline | whole-repo shadow git commit after every tool call | docs admit large repos slow down and use significant storage |
| `dsh-rewind-plugin` | copies the target file before `write`/`edit` | parses only `args.file_path` |
| `@anionex/dsh-turn-rewind` | full-workspace snapshot before the first step of a turn | mid-turn shell changes are invisible |
| `dsh-undo-savepoint` | fs.watch over config and plugin trees | does not cover workspace files |
| `dsh-recall-plugin` | whole-tree git tag per user message | needs an external git CLI; path-list diffs only |

## How capture works

```text
tools/execute (before) ──> mark pending; first capture writes a full baseline
        │  (the tool runs)
tools/post-execute ─────> fingerprint diff → read changed files →
                          content-addressed blobs → append-only ledger record
```

## Load-bearing decisions

| Decision | Reason |
| --- | --- |
| Fingerprint diff instead of pre-walking before each call | one walk per capture; the previous state comes from the previous record |
| A first-capture baseline | without it there is no revertible previous hash; blobs dedupe across sessions |
| Rolling per-session `stateHashes` | gives `revert` an exact pre-change hash instead of a guess |
| Single append-only JSONL ledger | crash-safe by construction, and cheaper to trim than many manifests |
| Rescue before every restore | makes a restore itself reversible; restore/rescue records are exempt from eviction |
| Content-unknown paths are never deleted | folding a `null` hash into "did not exist" once produced a plan that would have deleted a live secret file |

## Coexistence with the host

- No base row is disabled, replaced or re-pointed; we only insert our own row.
- Our row id and tool prefix avoid every existing id and tool name.
- Capture hooks ride the same `fs`-scoped events the host's own file tools use.

## Lessons paid for

- `ctx.effect` must not wrap tool registration: registrations silently did not happen.
- `export const inject` is mandatory, or startup fails with `cannot get property "tools" without inject`.
- `--dump-config` proves nothing about loading; only a real boot does.
- Peer resolution needs multiple anchors, or a `link:`-installed copy dies at assembly.
