# Troubleshooting

## 工具没有出现在会话里

1. 确认装配:`dsh --profile web --dump-config | grep workspace-rewind`,应有一行 `- id: workspace-rewind`。
2. 确认真启动过:bundle 插件只在装配期生效,改完 profile 要重启 dsh。
3. 看日志里的降级警告:`@deepseek-ai/dsh-tools 不可达`。
   `link:` 跨盘挂载源码时 peer 解析够不到 profile 的 node_modules,
   设 `DSH_ROOT` 指向 dsh 安装根(全局 npm 布局下,`<prefix>/lib/node_modules/@deepseek-ai/dsh`)。
4. 正常安装(npm)`dsh plugin add` 不需要第 3 步。

## 恢复计划里某文件显示「保持现状(内容未捕获)」

该文件是密钥样式命名(`secretNames`)或超过 `maxFileBytes`,内容从未入库。
插件拒绝猜测它的历史状态,也不会把它删掉——这是有意的数据安全决策。

## 快照库太大

`rewind_status` 看 `blobBytes / quota`。超配额时 GC 自动按最旧未引用 blob 淘汰;
要立即回收可临时调小 `maxTotalBytes` 后跑一次 `rewind_status`,或手动清空
`$DSH_HOME/workspace-rewind/`(会失去全部历史,先确认没有需要保留的检查点)。

## 恢复把工作区弄得更乱了

`rewind_undo apply=true`。每次恢复前都自动存了 rescue 快照,undo 可以反复执行
(等价 undo/redo 来回切);rescue 自身也在账本里,不会因为 undo 而丢失。
