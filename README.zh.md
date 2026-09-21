# dsh-zcode-rewind

[English](./README.md) | **简体中文**

> 面向 DeepSeek Harness 的逐工具调用工作区检查点——连 shell 副作用一起捕获。

## 为什么做这个

我们能找到的检查点实现,都只追踪「文件编辑工具」造成的改动。Claude Code 官方文档把话说得很直:
「检查点不追踪被 Bash 命令修改的文件」——`rm file.txt`、`mv old.txt new.txt`、
`cp source.txt dest.txt` 都无法通过 rewind 撤销。Cline 确实能捕获命令副作用,代价是每次工具调用后
把整个仓库提交进一个 shadow git,而它自己的文档提醒:大仓库会明显吃存储、明显变慢。

DSH 自己的市场也一样:我们读过的四个回滚插件(`dsh-rewind-plugin`、`@anionex/dsh-turn-rewind`、
`dsh-undo-savepoint`、`dsh-recall-plugin`)要么只解析 `write`/`edit` 的 `file_path` 参数,
要么只在 turn 边界打快照——所以一个 turn 中途的 `sed -i`,它们全都看不见。

## 它捕获什么

- 每一次会改动文件的工具调用:`bash`、`pwsh`、`write`、`edit`、MCP 工具、子代理工具。
- 删除、新建、修改——每个路径都带一个**可还原的改动前内容哈希**。
- 内容寻址的文件内容,跨会话、跨工作区去重。
- 一份持久账本:谁在什么顺序上改了什么,重启后仍在。

## 工作原理

```text
tools/execute (before) ──> 登记 pending;首次捕获写一份全量基线
        │  (工具执行: bash rm/mv/sed、write、edit、MCP …)
tools/post-execute ─────> 指纹差分 → 读变化文件 →
                          内容寻址 blob 库(sha-256,去重)→
                          追加式账本记录
```

指纹是整棵工作区的 `路径 → 大小 + mtime`。每次捕获的成本是一次 `O(文件数)` 的 stat 遍历,
加上**只对真正变化的文件**读内容——3000 个文件实测 88 ms;首次全量基线 2936 ms,
而零变更捕获只要 86 ms。

## 安装

```bash
dsh plugin --profile web add dsh-zcode-rewind
```

重启 DSH——bundle 插件在启动装配期生效。用
`dsh --profile web --dump-config | grep workspace-rewind` 验证合成树。快照库在工作区**之外**,
位于 `$DSH_HOME/workspace-rewind/`,绝不碰你的 git 仓库。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rewind_now` | 立即手动建检查点,比如危险操作之前 |
| `rewind_list` | 最近记录(新→旧):id、时间、工具、`+新增 ~修改 -删除`、示例路径 |
| `rewind_diff` | 恢复计划 + 行级 unified diff,不改动任何文件 |
| `rewind_restore` | `mode=revert` 撤销单条记录;`mode=asof` 回到某个时间点 |
| `rewind_undo` | 撤销最近一次恢复——反复执行即 undo/redo 来回切 |
| `rewind_status` | 快照库状态:记录数、blob、占用、配额、当前配置 |

## 配置

```yaml
- insert:
    - id: workspace-rewind
      name: 'dsh-zcode-rewind'
      config:
        capture: all            # all | fileTools | off
        maxFileBytes: 8388608   # 超过此大小的文件只记事件
        maxFiles: 20000         # 单次遍历文件数上限
        maxTotalBytes: 536870912  # 快照库配额;超限淘汰最旧未引用 blob
        keepRecords: 500        # 账本裁剪阈值
        excludes: ['.git', 'node_modules', 'dist']
        secretNames: ['.env', '*.pem', '*.key']
```

## 恢复语义

| 模式 | 含义 |
| --- | --- |
| `revert` | 只抵消某一条记录的增量——「撤销刚才搞坏的东西」用这个 |
| `asof` | 把工作区回到某条检查点记录的状态:折叠账本,并正确处理 target 之后新建的文件 |

## 安全

- 恢复默认 dry-run;必须显式 `apply=true` 才会动文件系统。
- 每次恢复前先写一条 rescue 保护记录,所以 `rewind_undo` 能撤销它——而且可以反复撤销。
- restore / rescue 记录**豁免配额淘汰**:撤销链永远不会被清掉。
- 密钥样式的文件与超限文件只记事件,恢复计划**保持它们原样**,而不是去猜它们的历史。

## 兼容性

在 DSH `0.1.5-rc.2`(桌面版 harness)与 `0.1.6-alpha.2`(WSL)上开发并验证。声明的区间是:

```text
>=0.1.5-alpha.1 || >=0.1.6-alpha.1
```

用到的宿主 API:`ctx.tools.register` 配 `defineTool`、`ctx.inject(['fs'], …)` 及其
`tools/execute` / `tools/post-execute` / `tools/result` 事件、`ctx.systemPrompt.section`、
`ctx.logger`,以及 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`。peer 走多锚点
`createRequire` 解析,所以用 `link:` 装的副本**不需要**本地 `node_modules`。

## 测试与守卫

```bash
node test/run.mjs                                    # 2 个套件,73 项检查——不需要 DSH
node tools/verify-translation-pairing.mjs --write     # 双语配对哈希
node tools/verify-doc-numbers.mjs                     # 文档数字 vs 真实运行
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
```

## 已知限制

- 工具调用**之间**的外部改动会被归到下一次捕获——与整树 shadow commit 同一类限制。
- 内容从未入库的文件(密钥名、超限、首次捕获前就消失)无法按内容还原;计划会保持它们原样并说明。
- 巨型 monorepo 需要更大的 `excludes` 列表,或改用 `capture: fileTools`。

## 许可证

MIT
