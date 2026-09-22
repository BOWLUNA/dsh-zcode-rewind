## 改了什么

<!-- 一句话。如果修的是缺陷，给出复现命令。 -->

## 三道守卫

- [ ] `node test/run.mjs` 绿
- [ ] `node tools/verify-translation-pairing.mjs` 绿（改了任一语言文件 → 已 `--write` 重录）
- [ ] `node tools/verify-doc-numbers.mjs` 绿（改了文档里的数字 → 三道重跑）
- [ ] `node tools/verify-version-consistency.mjs --dsh <版本>` 绿
- [ ] `bash -n install.sh && bash -n uninstall.sh`
- [ ] `node tools/boot-check.mjs --port 31860` 绿（真装真启动；需要 pnpm 与一份 harness 安装）

## 自检

- [ ] 没把任何凭证写进仓库 / 日志 / 测试夹具
- [ ] 没有 `push --force` / `reset --hard` / 全局 config 写入
- [ ] 新增行为配了断言（而不是只改了代码）
- [ ] 真跑过（一次性 `DSH_HOME` 或本机 profile），不是只过单测
