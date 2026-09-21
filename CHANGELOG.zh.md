# 更新日志

[English](./CHANGELOG.md) | [简体中文](./CHANGELOG.zh.md)

> 格式:最新在上。每次发布都写清改了什么、为什么、怎么验证的。

## 1.0.0

首个公开发布版。0.1.x 是开发期的递增版本,保留在下方作为历史记录。

### 包含

- 逐工具调用的工作区检查点:一次工具调用前后发生的每一处文件改动都会被记录,包括由 shell 命令而非文件编辑工具造成的改动。
- 工作区之外的内容寻址存储;两种恢复模式(`revert` 撤销单条记录、`asof` 回到某个时间点);行级 diff 预览,默认 dry run。
- 每次恢复前先写 rescue 保护记录,配 `rewind_undo`,所以恢复本身可逆。
- 密钥样式与超限文件只记事件;恢复计划保持它们原样,不去猜它们的历史。

### 兼容性

- 在 dsh `0.1.5-rc.2`(Windows 桌面版 harness)与 `0.1.6-alpha.2`(WSL)上开发并验证过。
- 用到的宿主 API:`ctx.tools.register` 配 `defineTool`、`fs` 域的 `tools/execute` 与 `tools/post-execute` 事件、`ctx.systemPrompt.section`、`ctx.logger`、`resolveDshHome`。

## 0.1.1

- **修复**:配额 GC 只统计**未被引用**的 blob,于是「所有 blob 都被引用」的库完全无视
  `maxTotalBytes`——实测 64 KB 配额下涨到 932 KB。现在先淘汰孤儿 blob,再按最旧优先淘汰
  **非 restore 记录**并原子重写账本;restore 与 rescue 记录豁免,所以撤销链能活下来。
- **新增**:`test/stress.test.mjs`——有上限的边界套件(3000 文件、4 路并发),上面那个缺陷就是它抓的。
  复现:该文件第 `[6]` 节。
- **新增**:核心主张的实测数字——3000 文件指纹遍历 88 ms;零变更捕获 86 ms,而首次全量基线 2936 ms。

## 0.1.0

- 首个版本:逐工具调用捕获,建立在「只 stat 不读内容」的工作区指纹之上,所以**改动文件的 shell
  命令也看得见**,哪怕没有任何文件工具的参数提到那些路径。
- 内容寻址 blob 库 + 追加式 JSONL 账本,位于 `$DSH_HOME/workspace-rewind/`,在工作区之外、git 之外。
- 两种恢复语义——`revert`(撤销单条记录)与 `asof`(回到时间点)——带行级 unified diff 预览,
  且默认 dry run。
- 恢复前先写 rescue,配 `rewind_undo`,使恢复本身可逆。
- 密钥样式与超限文件只记事件;恢复计划保持它们原样,不去猜历史。
- 零运行时依赖;离线冒烟套件 52 项检查。
