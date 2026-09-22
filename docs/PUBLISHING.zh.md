# 发布

[English](./PUBLISHING.md) | [简体中文](./PUBLISHING.zh.md)

> 完整发布链,包含三步最容易跳过的发布后核对。

## 发布清单

```bash
node test/run.mjs
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
node tools/boot-check.mjs --port 31860        # 需要 pnpm 与一份 harness 安装

# 升版本号:package.json、两份 README、SECURITY.md、两份 CHANGELOG,
# 然后重跑第 2、3 道守卫——数字守卫会逐条点名漂移的位置。
git add -A && git commit -m "fix(x.y.z): …"
git tag -a vx.y.z -m "vx.y.z" && git push origin vx.y.z
gh run list --repo BOWLUNA/dsh-zcode-rewind --limit 6
gh release view vx.y.z --json tagName,assets     # Releases 面板必须真的动了
```

## 工作流报 success 之后

- publish job 绿**不代表**包到了 npm:用 `npm view <pkg> version` 核对,并给它几分钟传播时间。
- 确认 **Releases 面板动了**。工作流会建出 Release 并附上预构建 tarball;面板没变就说明只跑了
  npm。`gh release create` 那一步是刻意写成 `if: always()` 的,所以 npm 跳过或失败都不该挡住它。
- 把发出去的 tarball 拆开,确认本轮的特征串在里面——CI 绿只说明「有个包上去了」。
- 写发布记录:版本、commit、tag、工作流 run id、传播耗时、tarball 特征串、遗留项。

## 市场条目

| 市场 | 怎么投 | 门槛 |
| --- | --- | --- |
| awesome-dsh-plugin(dshmarket.com,Harness 内市场) | 开 PR 改 `data/plugins/BOWLUNA__dsh-zcode-rewind.yml` | 描述必须与代码相符;一个 PR 只改自己那一条 |
| dsh-market/dsh-market | 自动,读仓库 description | 无 |
| 2BingLing/dsh.market | 自动,读 description 与 topics | 无 |

## 必须提醒使用者的两点

- pnpm 有 24 小时发布冷却期,刚发完就裸装会静默解析到上一版——要立刻拿到新版就钉 `@x.y.z`。
- 在已经服务会话的机器上,升级 profile 由用户决定,不是迭代的副作用。
