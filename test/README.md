# Tests

[English](./README.md) | [简体中文](./README.zh.md)

> Offline suites: they need no DSH installation and no network.

## Running

```bash
node test/run.mjs          # all suites, in filename order
node test/smoke.test.mjs   # one suite
node test/stress.test.mjs  # one suite
```

Every suite prints `结果: N 通过, M 失败`, and `tools/verify-doc-numbers.mjs` counts those lines —
the format is a contract, not cosmetics.

## Suites

| Suite | Checks | What it covers |
| --- | --- | --- |
| `smoke.test.mjs` | 52 | capture, bash side effects, dedup, quota GC, restore semantics, rescue, undo, secret safety, line diff |
| `stress.test.mjs` | 21 | scale, oversized/secret/symlink boundaries, path traversal, quota GC under pressure, concurrency |

Total: **2 suites, 73 checks**.

## Scratch directories

Suites that need a workspace create one per run and delete it afterwards. Point them elsewhere with
`REWIND_STRESS_DIR=/some/dir`. Nothing is ever written outside that directory.

## Why no host in the loop

`lib/` is plain Node ESM, so all of it is testable without a running harness. Host-level behaviour —
tool registration, the `fs` execution events, the composed tree — is verified separately with a real
boot and a `--patch` probe; see `docs/MEASUREMENTS.md`.
