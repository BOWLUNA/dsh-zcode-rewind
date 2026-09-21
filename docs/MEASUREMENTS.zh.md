# 实测数据

[English](./MEASUREMENTS.md) | [简体中文](./MEASUREMENTS.zh.md)

> 下面每条主张都由所示命令产出,时间 2026-09-21,环境 DSH `0.1.6-alpha.2`(WSL)与 `0.1.5-rc.2`(桌面版)。

## 套件结果

```text
$ node test/run.mjs
测试套件: 2 个（smoke.test.mjs、stress.test.mjs）
结果: 52 通过, 0 失败
结果: 21 通过, 0 失败
2 个套件全部通过
```

## 装配

```text
$ dsh plugin --profile web add link:<repo>        → Done in 43 ms using pnpm
$ dsh --profile web --dump-config                 → exit 0, stderr 0 bytes
1150:# == dsh-zcode-rewind
1151:- id: workspace-rewind
```

## 活会话里的端到端

让一个跑真实模型的 headless 会话先用 `sed` 改坏文件,再撤销:

```text
模型回报: rewind_list 找到 mutation/bash 记录 → rewind_restore(mode=revert, apply=true) 已恢复 2 个路径
磁盘独立核对: note.txt = alpha/beta/gamma;目录仅剩 note.txt
stderr 错误计数(含 "Cannot find package"): 0
```

## 实例内真实执行

一个 `--patch` 探针走**真实注册表**调用工具(`ctx.tools.get(name).execute(...)`):

```text
### PROBE06EXEC_VERDICT exec 3/3; ledger +1
### PROBE06EXEC_LEDGER_MATCH {"k":"manual","cwd":"…/06-scratch/ws-probe",
  "changes":{".env":{"op":"A","h":null,"s":4,"secret":true},"sample.txt":{"h":"e9024f1a…","s":18}}}
```

## 边界与压力

```text
[1] 3000 文件:指纹遍历 88 ms;基线捕获 2936 ms;零变更捕获 86 ms
[2-4] 超限文件 → 只记事件(s=307200);密钥 → 只打标;符号链接 → 排除
[5] safeRel 拒绝全部 7 个非法路径
[6] 64 KB 配额:GC 删 19 个未引用 blob、释放 348 KB、库回到 62.5 KB
[7] 4 路并发:账本 16 行全部可解析、无交错
```

## 压力测试抓到的缺陷

- `Store.gc()` 把**未被引用** blob 的字节和当成已用量,于是「所有 blob 都被引用」的库完全无视配额
  ——64 KB 配额下涨到 932 KB。
- 0.1.1 修复:先淘汰孤儿,再按最旧优先淘汰非 restore 记录并重写账本。
- 复现:`node test/stress.test.mjs` 第 `[6]` 节。

## 未测量

- 两个会话并发改动同一工作区时的归因准确度。
- 以 Windows shell 工具作为变更工具的路径(捕获集包含它,但只实测了 `bash`)。
- 客户端 UI——它还不存在。
