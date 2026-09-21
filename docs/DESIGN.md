# 设计与竞品证据(design rationale)

> 本文回答三个问题:缺口是怎么核实的、为什么这样设计、以及每条安全决策的出处。
> 所有竞品结论都来自对 npm 发布产物的源码阅读(2026-09-21,DSH 市场目录快照 4062 条,更新于 2026-09-20)。

## 1. 缺口核实

### 1.1 DSH 市场内的四个回滚插件(全部下载 tarball 读源码)

| 插件 | 捕获机制 | 副作用盲区 | 证据 |
| --- | --- | --- | --- |
| `dsh-rewind-plugin` 0.12.2(82★) | 工具执行前 copyFile 备份 | **只解析 `write`/`edit` 的 `args.file_path`**,bash/pwsh 改动完全不可见 | `lib/index.js:2275-2281`(`mutationPathOf` 仅识别 write/edit);`:2250`(TRACKED_TOOLS) |
| `@anionex/dsh-turn-rewind` 0.3.8(117★) | turn 首步前全量快照,内容寻址 blob | **turn 中途**的 bash 改动无感知(下一次 turn 才被包进快照) | `src/rewind-host.ts:177-182`(捕获挂在 `agent/pre-step` step===1) |
| `dsh-undo-savepoint` 0.4.9(160★) | fs.watch 监听**配置文件**与插件树 | 不覆盖工作区普通文件;消息级撤销只认 `write/edit/replace/patch` 白名单且 256KB 上限 | `lib/index.js:70`(`fileToolWhitelist`)、`:948-950` |
| `dsh-recall-plugin` 2.3.24(33★) | 每条用户消息前整树打 git tag(外部 git CLI) | 按消息粒度,bash 改动会被下一条消息的快照吸收;恢复为整树覆盖、无行级 diff | `lib/scripts.posix.js:211-243` |

### 1.2 业界对照

- **Claude Code**:官方文档明示 "Bash command changes not tracked … cannot be undone through rewind",且 subagent 编辑、外部改动同样不追踪(code.claude.com/docs/en/checkpointing,Limitations 节)。
- **Cline**:shadow git 在**每次工具调用后**提交全仓——能看见副作用,但官方文档承认 "For very large repositories, checkpoints may use significant storage and slow down Cline … Consider disabling them"(docs.cline.bot/core-workflows/checkpoints)。

### 1.3 结论

「**逐工具调用 + 捕获含命令副作用 + 低成本**」这个交集没人做。本插件用指纹差分占住它:
每次捕获 = 一次 O(files) 的 stat 遍历 + 只对差分命中的文件读内容/算哈希/入 blob 库。
对照 Cline:同样的可见性,成本模型完全不同(无 git、无整仓提交、无全量历史放大)。

## 2. 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 滚动 `lastKnown` 指纹,不在工具前做 pre-walk | 每次捕获只走一次遍历;pre 状态由上一条记录的状态图给出(`prev` 哈希) |
| 首次捕获打全量基线(内容入库) | 没有基线就没有 `prev`;跨会话按内容寻址去重,第二次会话基本只花哈希时间 |
| `prev` 来自滚动 `stateHashes` | 保证 revert 有确切的"改动前哈希",而不是猜 mtime |
| ledger 单文件 JSONL、追加写 | 崩溃安全(尾部半行忽略);比 SQLite 少一个依赖、比多文件 manifest 好裁剪 |
| blob 名 = sha256,`tmp + rename` 原子落盘 | 跨工作区/跨会话去重;半写 blob 不可能被读到 |
| 恢复 = 计划 → 行级 diff → dry_run 默认 → 显式 apply | 四家竞品都没有工作区文件的行级预览;把"人留在环里"做成默认值而不是文档建议 |
| rescue 先行 + restore 记录带 `rescueId` | 验收标准「回滚本身可回滚」的直接实现;undo 可反复(等价 redo) |
| 密钥/超限文件:记事件、不存内容,且**折叠时视为未知状态** | 把 `h:null` 折叠成"文件不存在"会让恢复计划误删现存的 `.env`——这类路径只能"保持现状 + 警告" |
| 存储放 `$DSH_HOME` 而不是工作区 | 不污染 git status;recall-plugin 的 `.dsh-recall-snapshots` 目录方案会出现在用户的 `git status` 里 |
| `dsh.bundle.patch` + 单行 insert | 与 `dsh-rewind-plugin` 同款装配;行 id `workspace-rewind` 已对照 base 层 169 个现存 id 确认无撞车 |

## 3. 与 base 层的共存

- 不 disable、不覆盖任何 base 行(dump-config 对比:568 → 571 行,仅新增本插件一层 3 行)。
- 工具名 `rewind_*` 前缀对 base 全量工具名(实测枚举:`bash/pwsh/read/read_image/write/edit/glob/grep/web_search/web_fetch/job_*/todo_write/goal 相关`)无冲突;与 `dsh-undo-savepoint` 的 `undo_*` 15 个工具、recall 的 REST API 也无冲突。
- 钩子接线与 `dsh-rewind-plugin` 同款:`ctx.inject(['fs'], scope => scope.on('tools/execute' | 'tools/post-execute' | 'tools/result'))`。

## 4. 教训(实测踩到)

1. **`ctx.effect(fn, label)` 不要用来包工具注册**——官方 `dsh-tool-web` 直接调 `ctx.tools.register`,其 JSDoc 说明 tools/systemPrompt 注册"effect-scoped and unregister on plugin dispose"是**注册 API 自带**的语义。包一层 effect 在 0.1.6-alpha.2 上静默不执行,且错误只进 harness logger、stderr 不可见。
2. **`export const inject` 不能省**——缺了它,任何 `ctx.<service>` 访问都会被加载器拒绝:`cannot get property "tools" without inject`。第一轮 E2E 没报错只是因为工具注册从未执行,钩子(`ctx.inject` 动态注入)恰好不需要静态声明。
3. **peer 解析要多锚点**——`link:` 跨文件系统挂载时 `createRequire(import.meta.url)` 解析不到 hoisted peer。本插件顺序:插件自身位置 → `DSH_ROOT` → `process.execPath` 推导的全局 `lib/node_modules/@deepseek-ai/dsh`(与 `dsh-undo-savepoint` 的多锚点思路一致,实测第三锚点命中)。
4. **`--dump-config` 查不出工具名冲突与注入契约问题**——只有真 `--port` 启动才暴露(本插件的 `inject` 缺失就是这样抓到的;与登记表中 08 号窗口记录的 `dsh-tool-git` P0 事故同款教训)。

## 附录 A:base 层只读工具名清单(2026-09-21 实测)

`read`、`read_image`、`glob`、`grep`、`web_search`、`web_fetch`、`job_list`、`job_output`、`get_goal`、`create_goal`、`update_goal`、`todo_write`。
变更类:`bash`、`pwsh`、`write`、`edit`(MCP/子代理工具按"非只读"处理)。
