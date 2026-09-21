# 参与贡献

[English](./CONTRIBUTING.md) | [简体中文](./CONTRIBUTING.zh.md)

> 先读 `AGENTS.md`——里面列着本仓库不会拿来交换的不变量。

## 快速开始

```bash
git clone https://github.com/BOWLUNA/dsh-zcode-rewind
cd dsh-zcode-rewind
node test/run.mjs          # 2 个套件,73 项检查——不需要 DSH
```

## 三道守卫

```bash
node test/run.mjs
node tools/verify-translation-pairing.mjs --write
node tools/verify-doc-numbers.mjs
bash -n install.sh && bash -n uninstall.sh
node tools/verify-version-consistency.mjs --dsh 0.1.6-alpha.2
```

改动没跑绿全部守卫就不算完成;而且要先用一份注入已知缺陷的副本确认对应的守卫**真的会红**。

## 文档规则

- 双语对两侧权威相同:两边都改,然后重录哈希。
- 文档里的数字是主张;守卫会拿它跟真实运行比对。
- 因为你的改动而变成假话的东西——计数、区间、版本、限制——都算这次改动的一部分。

## 提 PR

- 一个 PR 只做一件事,描述里给出复现命令。
- 新行为要配断言,不能只改代码。
- 写清你测了什么:命令 + 原始输出。
- 如果动了 `lib/index.js` 或 `cordis.patch.yml`,先真启动一次再来说成功。

## 报告缺陷

- 用 issue 模板,它会问我们要的版本信息与快照库状态。
- 绝不粘贴凭据——引用 `DEEPSEEK_API_KEY` 只写变量名,不写值。
