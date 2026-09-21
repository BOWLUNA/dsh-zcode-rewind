# 架构

[English](./ARCHITECTURE.md) | [简体中文](./ARCHITECTURE.zh.md)

> 这个插件为什么存在,以及哪些设计决策是承重的。

## 缺口

| 项目 | 捕获机制 | 盲区 |
| --- | --- | --- |
| Claude Code | 按 turn 记录文件工具的编辑 | 官方文档:被 bash 修改的文件不追踪 |
| Cline | 每次工具调用后整仓提交 shadow git | 文档自认大仓库变慢、明显吃存储 |
| `dsh-rewind-plugin` | `write`/`edit` 之前拷贝目标文件 | 只解析 `args.file_path` |
| `@anionex/dsh-turn-rewind` | turn 首步前全量快照工作区 | turn 中途的 shell 改动看不见 |
| `dsh-undo-savepoint` | fs.watch 盯配置与插件树 | 不覆盖工作区普通文件 |
| `dsh-recall-plugin` | 每条用户消息一个整树 git tag | 依赖外部 git CLI;只有路径清单级 diff |

## 捕获怎么工作

```text
tools/execute (before) ──> 登记 pending;首次捕获写一份全量基线
        │  (工具执行)
tools/post-execute ─────> 指纹差分 → 读变化文件 →
                          内容寻址 blob → 追加式账本记录
```

## 承重决策

| 决策 | 理由 |
| --- | --- |
| 用指纹差分,而不是每次调用前 pre-walk | 每次捕获只走一次遍历;前态由上一条记录给出 |
| 首次捕获打全量基线 | 没有基线就没有可还原的改动前哈希;blob 跨会话去重 |
| 会话内滚动 `stateHashes` | 让 `revert` 拿到确切的改动前哈希,而不是猜 |
| 单一追加式 JSONL 账本 | 构造上就崩溃安全,且比多份 manifest 好裁剪 |
| 每次恢复前写 rescue | 使恢复本身可逆;restore/rescue 记录豁免淘汰 |
| 内容未知的路径永不删除 | 把 `null` 哈希折叠成「不存在」曾生成过会删掉现存密钥文件的计划 |

## 与宿主共存

- 不 disable、不替换、不改指向任何 base 行;只插入自己那一行。
- 行 id 与工具名前缀避开了全部现存 id 与工具名。
- 捕获钩子与宿主自己的文件工具走同一批 `fs` 域事件。

## 花代价换来的教训

- `ctx.effect` 不能用来包工具注册:注册会**静默不发生**。
- `export const inject` 必写,否则启动失败 `cannot get property "tools" without inject`。
- `--dump-config` 证明不了能不能加载;只有真启动能。
- peer 解析要多锚点,否则 `link:` 挂载的副本会在装配期直接死。
