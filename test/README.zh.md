# 测试

[English](./README.md) | [简体中文](./README.zh.md)

> 离线套件:不需要安装 DSH,不需要网络。

## 怎么跑

```bash
node test/run.mjs          # 全部套件,按文件名顺序
node test/smoke.test.mjs   # 单个套件
node test/stress.test.mjs  # 单个套件
```

每个套件都打印 `结果: N 通过, M 失败`,而 `tools/verify-doc-numbers.mjs` 就是按这行统计的——
这个格式是对外契约,不是装饰。

## 套件

| 套件 | 检查数 | 覆盖什么 |
| --- | --- | --- |
| `smoke.test.mjs` | 52 | 捕获、bash 副作用、去重、配额 GC、恢复语义、rescue、undo、密钥安全、行级 diff |
| `stress.test.mjs` | 21 | 规模、超限/密钥/符号链接边界、路径穿越、压力下的配额 GC、并发 |

合计:**2 个套件,73 项检查**。

## 临时目录

需要工作区的套件每次运行自己建、结束自己删。想换位置就设 `REWIND_STRESS_DIR=/某个目录`。
任何东西都不会写到那个目录之外。

## 为什么不让宿主参与

`lib/` 是纯 Node ESM,所以整层都能在没有 harness 的情况下测。宿主级行为——工具注册、
`fs` 执行事件、合成树——另用真启动 + `--patch` 探针验证,见 `docs/MEASUREMENTS.md`。
