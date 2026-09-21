# 验证记录(verification log)

> 全部实测于 2026-09-21,DSH `0.1.6-alpha.2`,隔离 `DSH_HOME=/tmp/dsh-lab-06`(不触碰生产 profile)。
> Windows 侧源码目录以 `link:` 方式挂进 lab 的 `web` 与 `headless` 两个 profile。

## A. 离线冒烟(tools/smoke.mjs,52 断言)

```
$ npm test
结果:52 通过,0 失败
```

覆盖:基线捕获、bash 副作用差分(A/M/D + prev 哈希)、node_modules/.git 排除、
secret 文件只记事件、asof/revert 计划、行级 unified diff(插入/删除/修改/二进制/多 hunk)、
恢复应用、rescue、undo 切换、blob 去重、GC 不误删、符号链接跳过。

## B. 装配验证

```
$ DSH_HOME=/tmp/dsh-lab-06 dsh plugin --profile web add link:<repo>
dependencies: + dsh-workspace-rewind link:…
$ DSH_HOME=/tmp/dsh-lab-06 dsh web --dump-config   # exit=0,stderr 0 字节
569:# == dsh-workspace-rewind
570:- id: workspace-rewind
571:  name: dsh-workspace-rewind
```

基线对比:568 行 → 571 行,仅新增本插件一层,原 169 个行 id 零改动、零 disable。
真启动:`dsh --profile web --port 31860 --no-open` → 打印服务 URL,加载期零报错。

## C. 端到端(headless profile,真实 LLM 会话)

### C1 bash 副作用捕获

任务:write 创建 e2e-a.txt → bash `rm e2e-a.txt && echo hello-from-bash > e2e-b.txt`。

ledger 实录(节选):

```json
{"k":"mutation","tool":"bash","changes":{
  "e2e-b.txt":{"op":"A","h":"e9e49da7…","s":16},
  "e2e-a.txt":{"op":"D","h":null,"prev":"4fdbc441…"}}}
```

bash 造成的删除带着可还原的 `prev` 哈希进了账本——这是本插件与全部四个市场竞品、
以及 Claude Code 的分界线。

### C2 工具暴露(第一轮的失败与修复)

第一轮 E2E 中 agent 明确报告 `rewind_list` 不存在于其工具列表。
排查:官方 `dsh-tool-web` 直接调 `ctx.tools.register`(JSDoc:注册 API 自带 effect-scoped 语义),
而本插件包了 `ctx.effect(fn,label)` → 在 0.1.6-alpha.2 上静默未执行。
第二轮起改直调后,又暴露 `export const inject` 缺失
(`cannot get property "tools" without inject`)。两项修复后,六个工具全部出现并可用。

### C3 revert 真实恢复(磁盘核对)

任务:write story.txt(3 行)→ bash `sed -i line2→line2-BROKEN` + 创建 junk-temp.txt
→ rewind_list → rewind_restore(mode=revert,apply=true)。

- 工具返回:`已恢复(revert → cp-mubg8hu4-):应用 2 个路径;保护快照 rescue-…`
- 磁盘独立核对:`cat story.txt` = line1/line2/line3;`ls` = story.txt(junk 已消失)
- ledger:rescue 记录 + restore 记录(`rescueId` 相互链住),stderr error 计数 0

### C4 回滚本身可回滚(undo/redo 切换)

任务:追加 `broken-after-restore` + 创建 extra.txt → revert 恢复 → rewind_undo(apply=true)。

- 磁盘独立核对:undo 后 `story.txt` 重新包含 `broken-after-restore`,`extra.txt` 回归
- 即:恢复被整体撤销,回到"刚破坏完"的状态;再执行一次 revert 即 redo
- stderr error 计数 0

### C5 语义纠偏记录

第三轮 E2E 中 agent 对"撤销刚才的改动"选择了 `asof` + 破坏记录本身(= no-op)。
行为正确、引导有歧义 → 重写 system prompt 段:`revert`=撤销某条记录的改动,
`asof`=回到时间点。第五轮起 agent 一次选中正确模式。

## D. 覆盖外的场景(如实记录)

- 未测:并发双会话同时写同一工作区的归因精度(单会话已验;跨会话由锁 + cwd 过滤保护)。
- 未测:Windows 原生 pwsh 路径(harness 在本机以 WSL 运行;`pwsh` 工具名在捕获集内,机制与 bash 相同)。
- WebUI 客户端(会话消息旁的恢复按钮)规划为 v0.2,需要 client bundle 构建链。
