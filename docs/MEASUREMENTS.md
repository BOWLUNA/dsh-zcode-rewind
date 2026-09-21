# Measurements

[English](./MEASUREMENTS.md) | [简体中文](./MEASUREMENTS.zh.md)

> Every claim below was produced by the command shown, on 2026-09-21, DSH `0.1.6-alpha.2` (WSL) and `0.1.5-rc.2` (desktop).

## Suite results

```text
$ node test/run.mjs
测试套件: 2 个（smoke.test.mjs、stress.test.mjs）
结果: 52 通过, 0 失败
结果: 21 通过, 0 失败
2 个套件全部通过
```

## Assembly

```text
$ dsh plugin --profile web add link:<repo>        → Done in 43 ms using pnpm
$ dsh --profile web --dump-config                 → exit 0, stderr 0 bytes
1150:# == dsh-zcode-rewind
1151:- id: workspace-rewind
```

## End to end in a live session

A headless session with a real model was asked to break a file with `sed` and then revert it:

```text
模型回报: rewind_list 找到 mutation/bash 记录 → rewind_restore(mode=revert, apply=true) 已恢复 2 个路径
磁盘独立核对: note.txt = alpha/beta/gamma;目录仅剩 note.txt
stderr 错误计数(含 "Cannot find package"): 0
```

## In-instance execution

A `--patch` probe called the tools through the real registry (`ctx.tools.get(name).execute(...)`):

```text
### PROBE06EXEC_VERDICT exec 3/3; ledger +1
### PROBE06EXEC_LEDGER_MATCH {"k":"manual","cwd":"…/06-scratch/ws-probe",
  "changes":{".env":{"op":"A","h":null,"s":4,"secret":true},"sample.txt":{"h":"e9024f1a…","s":18}}}
```

## Boundaries and stress

```text
[1] 3000 files: fingerprint walk 88 ms; baseline capture 2936 ms; no-change capture 86 ms
[2-4] oversized file → event only (s=307200); secret → flag only; symlink excluded
[5] safeRel rejects all 7 illegal paths
[6] 64 KB quota: GC removed 19 unreferenced blobs, freed 348 KB, store back to 62.5 KB
[7] 4-way concurrency: 16 ledger lines, all parseable, no interleaving
```

## Defect the stress suite found

- `Store.gc()` used the byte total of *unreferenced* blobs as "used", so a store whose blobs were all
  referenced ignored the quota — 932 KB under a 64 KB quota.
- Fixed before the first public release (1.0.0): evict orphans, then drop the oldest non-restore records and rewrite the ledger.
- Reproduction: `node test/stress.test.mjs`, section `[6]`.

## Not measured

- Attribution accuracy when two sessions mutate the same workspace concurrently.
- The Windows shell tool as the mutating tool (it is in the capture set; only `bash` was exercised).
- A client-side UI, which does not exist yet.
