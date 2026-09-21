# dsh-workspace-rewind

[English](./README.md) | **简体中文**

面向 DeepSeek Harness(DSH)的**逐工具调用工作区检查点**插件——**连 bash 副作用都能捕获**,内容寻址存储、行级 diff 预览、可选文件还原、恢复本身可撤销。

## 为什么做这个

我们查了所有能找到的检查点实现——Claude Code `/rewind`、Cursor,以及 DSH 市场里全部四个回滚类插件——它们都只追踪「文件编辑工具」造成的改动。[Claude Code 官方文档原话](https://code.claude.com/docs/en/checkpointing):

> **Bash 命令的改动不被追踪** —— `rm file.txt`、`mv old.txt new.txt`、`cp source.txt dest.txt` 这类文件修改无法通过 rewind 撤销。

Cline 用「每次工具调用后对整仓做 shadow-git commit」解决了这个问题,但[它自己的文档承认](https://docs.cline.bot/core-workflows/checkpoints)大仓库会带来 *significant storage and slowdown*。

`dsh-workspace-rewind` 用另一种机制补上这个缺口:**每次工具调用前后做一次只 stat 不读内容的工作区指纹差分**。任何改动都看得见——`bash`、`pwsh`、`write`、`edit`、MCP 工具、子代理——而成本只是一次 O(文件数) 的 stat 遍历,内容读取只发生在真正变了的那几个文件上。

## 工作原理

```
tools/execute (before) ──> 登记 pending;首次调用先打全量基线
        │  (工具执行: bash rm/mv/sed、write、edit、MCP …)
tools/post-execute ─────> 指纹差分 → 读变化文件 →
                          内容寻址 blob 库(sha-256,去重)→
                          追加式 ledger 记录
```

- **存储**在 `$DSH_HOME/workspace-rewind/`——绝不进你的工作区、绝不碰你的 git。布局:`blobs/<h[:2]>/<sha256>` + `ledger.jsonl`。
- **恢复**有两种明确语义:
  - `revert` —— 只抵消某一条记录的增量(「撤销刚才搞坏的东西」最常用);
  - `asof` —— 整个工作区回到某条检查点完成时的状态(折叠 ledger,并正确处理 target 之后新建的文件)。
- **恢复本身永远受保护**:应用前先把受影响路径的当前状态存成 *rescue* 记录。`rewind_undo` 恢复到 rescue——反复调用即 undo/redo 来回切。rescue 先落盘、后改字节,崩溃安全。
- **构造级安全**:符号链接/硬链接不追踪、不穿透写入;`.git`/`node_modules` 等默认排除;密钥样式的文件(`.env`、`*.pem`、`*.key`…)与超限文件只记**事件**不存内容——恢复计划永远不会碰它们,只会如实报告。
- **零运行时依赖**。不要 git CLI、不要原生模块、不要打包器。纯 ESM,Node ≥ 20。

## 安装

```bash
dsh plugin --profile web add dsh-workspace-rewind
```

重启 DSH(bundle 插件在装配期生效)。验证:`dsh --profile web --dump-config | grep workspace-rewind`。

## 工具

| 工具 | 作用 |
| --- | --- |
| `rewind_now` | 立即手动建检查点(比如危险操作前打点) |
| `rewind_list` | 最近记录(新→旧):id、时间、工具、`+增 ~改 -删`、示例路径 |
| `rewind_diff` | 恢复计划 + **行级 unified diff**,不改动任何文件 |
| `rewind_restore` | 恢复:`mode=revert`(撤销单条记录)或 `mode=asof`(回到时间点)。`apply=false`(默认)= 只出计划 |
| `rewind_undo` | 撤销最近一次恢复(反复调用 = undo/redo) |
| `rewind_status` | 快照库状态:记录数、blob 数与占用、配额、配置 |

`rewind_restore` 与 `rewind_undo` 默认 **dry run**——必须显式 `apply=true` 才真正改文件,把人(或先复述计划的 agent)留在决策环里。

## 配置(`cordis.patch.yml` 行内 config)

```yaml
- insert:
    - id: workspace-rewind
      name: 'dsh-workspace-rewind'
      config:
        capture: all            # all | fileTools | off
        maxFileBytes: 8388608   # 单文件内容上限(超过只记事件)
        maxFiles: 20000         # 单次遍历文件数上限
        maxTotalBytes: 536870912  # 快照库配额;超限按最旧未引用 blob 淘汰
        keepRecords: 500        # ledger 裁剪阈值
        excludes: ['.git', 'node_modules', 'dist', 'build']   # 与默认合并
        secretNames: ['.env', '*.pem', '*.key']               # 与默认合并
```

## 验证

`npm test` 运行离线冒烟套件(52 条断言),覆盖捕获、bash 副作用、去重、配额 GC、asof/revert 恢复、rescue、undo 切换、密钥文件安全、内置 Myers diff。不需要安装 DSH。

真机验证在 `0.1.6-alpha.2`(headless profile,隔离 `DSH_HOME`)完成:bash 造成的文件改动被捕获且带可还原的 `prev` 哈希;revert 在磁盘上真实还原了被改坏的文件;`rewind_undo` 把恢复整体撤销;加载器零报错。竞品证据见 `docs/DESIGN.md`,原始验收记录见 `docs/VERIFICATION.md`。

## 已知局限

- 工具调用**之间**的外部改动会被归到下一次捕获(与 Cline 同类限制)。
- 内容从未入库的文件(密钥名、超限、首次捕获前就消失)无法按内容还原;计划会保持它们原样并明确说明。
- 指纹遍历是 O(工作区文件数);巨型 monorepo 请加大 `excludes` 或改用 `capture: fileTools`。

## License

MIT
