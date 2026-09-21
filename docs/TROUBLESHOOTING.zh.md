# 排错

[English](./TROUBLESHOOTING.md) | [简体中文](./TROUBLESHOOTING.zh.md)

> 按顺序逐条过;每条都给出能确认或排除它的命令。

## 会话里看不到工具

- 先确认那一行进了合成树:`dsh --profile web --dump-config | grep workspace-rewind`。
- 重启 dsh:bundle 插件在启动装配期绑定,不是运行中随时生效。
- 找 `@deepseek-ai/dsh-tools` 的降级警告;出现它就说明 peer 解析失败了。
- 若副本是 `link:` 挂在另一个盘上,把 `DSH_ROOT` 设成 dsh 安装根再试。

## 某个路径显示「保持现状」

- 该路径是密钥样式命名,或大于 `maxFileBytes`,所以它的内容从未入库。
- 插件不会去猜它的历史,也不会删它;这是有意的数据安全决策。
- 在你真正在意的改动**之前**调大 `maxFileBytes`,然后重新打一个检查点。

## 快照库一直在变大

- 跑 `rewind_status` 看 `blobBytes / quota`。
- 超配额时,GC 先淘汰未引用的 blob,再淘汰最旧的**非 restore** 记录。
- 想立刻回收空间就清空快照库目录——先确认里面没有还需要保留的检查点。

## 恢复之后事情更糟了

- 跑 `rewind_undo apply=true`:每次恢复前都写了 rescue 记录,所以恢复本身可逆。
- `rewind_undo` 可以反复执行,于是在两个状态之间来回切,等价于 undo/redo。
- 如果应用前就觉得计划不对,那正是 `rewind_diff` 的用途——永远先预览。

## 卸载之后记录还在

- 这是设计如此:`uninstall.sh` 会保留快照库,因为它可能是你唯一的回滚依据。
- 确认不需要之后,用 `./uninstall.sh --purge --yes` 显式删除。
