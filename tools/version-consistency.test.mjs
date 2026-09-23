#!/usr/bin/env node
/**
 * tools/version-consistency.test.mjs —— `verify-version-consistency.mjs` 的自检用例。
 *
 * 为什么需要它：那道守卫的职责是「断言『本包支持 dsh X』这句话是真的」。
 * 一个**会说谎的守卫**比没有守卫更糟 —— 它给虚假声明盖了章，而 CI 会一直绿。
 * 本生态里这个缺陷出现过两次：一次在 `dsh-custom-mode`（提交 7a76920），
 * 一次在 `dsh-zcode-farm`（2026-09-23 发现）。
 *
 * 所以这里断言两件事：
 *   A. **真值一致性** —— 对每个用例，本脚本算出的判定必须等于 `node-semver` 的判定。
 *      不是「拿本脚本跟本脚本比」，而是**跟 semver 这个第三方实现比**。
 *   B. **必须存在应当为 ✗ 的用例** —— 否则这个套件只是装饰。
 *
 * 用法：node tools/version-consistency.test.mjs
 * 退出：0 全部一致 · 1 有不一致（会打印是哪个用例）
 *
 * ⚠️ 关于 `semver`：它是可选的。装不到时**不是静默跳过** —— 会打印明确说明并以 2 退出，
 *    因为「自检没跑」与「自检通过」必须能被区分开。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'tools', 'verify-version-consistency.mjs')

// ── 取一个真实的 semver 实现（第三方真值）─────────────────────────
const require_ = createRequire(import.meta.url)
let semver = null
for (const candidate of ['semver', join(ROOT, 'node_modules', 'semver')]) {
  try { semver = require_(candidate); break } catch { /* 试下一个 */ }
}
if (semver === null) {
  process.stderr.write(
    'version-consistency.test: 找不到 `semver` 包 —— 本自检需要它作为第三方真值。\n' +
      '  装：npm install --no-save --no-audit --no-fund semver\n' +
      '  （不静默跳过：「自检没跑」与「自检通过」必须能区分开。）\n',
  )
  process.exit(2)
}

// ── 用例表 ────────────────────────────────────────────────────────
// 每一条都是「声明区间 + 被测版本 + 期望判定」。**期望判定不写死** ——
// 由 semver 现算，见下面 expectFromSemver()。写死的期望值会跟着实现一起漂。
const CASES = [
  // 预发布门：这是本缺陷的核心。0.1.7-alpha.2 与 0.1.5/0.1.6 是不同元组，
  // 所以只有 0.1.5 / 0.1.6 两条线的声明 **匹配不上** 它。
  { name: '预发布门：异元组的预发布不被接受（本仓 2026-09-22 之前的声明）', range: '>=0.1.5-alpha.1 || >=0.1.6-alpha.1', version: '0.1.7-alpha.2' },
  { name: '预发布门：同元组的预发布被接受', range: '>=0.1.5-alpha.1 || >=0.1.6-alpha.1', version: '0.1.6-alpha.2' },
  { name: '预发布门：同元组但更低的预发布', range: '>=0.1.5-alpha.1 || >=0.1.6-alpha.1', version: '0.1.5-alpha.2' },
  // 上界：没有 `<0.2.0-0` 时，**正式版**会被默默认领（正式版不是预发布，任意 >= 下界都满足它）
  { name: '无上界 ⇒ 默默认领未来的正式版 0.2.0（假声明）', range: '>=0.1.5-alpha.1 || >=0.1.6-alpha.1', version: '0.2.0' },
  { name: '无上界 ⇒ 默默认领 1.0.0（假声明）', range: '>=0.1.5-alpha.1 || >=0.1.6-alpha.1', version: '1.0.0' },
  { name: '加上界后 0.2.0 被排除', range: '>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0', version: '0.2.0' },
  { name: '加上界后 1.0.0 被排除', range: '>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0', version: '1.0.0' },
  { name: '加上界后三条线各自接受自己的预发布', range: '>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0', version: '0.1.7-alpha.2' },
  { name: '加上界后 0.1.4 仍被排除', range: '>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0', version: '0.1.4' },
  { name: '正式版 0.1.5 落在第一线内', range: '>=0.1.5-alpha.1 <0.2.0-0 || >=0.1.6-alpha.1 <0.2.0-0 || >=0.1.7-alpha.1 <0.2.0-0', version: '0.1.5' },
  // 多比较符 + 上界
  { name: '上界排除下一个次版本', range: '>=0.1.5-rc.2 <0.2.0-0', version: '0.1.7-alpha.2' },
  { name: '上界内的正式版', range: '>=0.1.5-rc.2 <0.2.0-0', version: '0.1.5' },
  { name: '下界之下的版本', range: '>=0.1.5-rc.2 <0.2.0-0', version: '0.1.4' },
  // || 备选分支
  { name: '|| 第一支命中', range: '>=0.1.5-alpha.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0', version: '0.1.5-alpha.2' },
  { name: '|| 第二支命中', range: '>=0.1.5-alpha.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0', version: '0.1.6-alpha.2' },
  { name: '|| 两支都不命中（预发布门）', range: '>=0.1.5-alpha.1 <0.1.6-0 || >=0.1.6-alpha.1 <0.2.0-0', version: '0.1.7-alpha.2' },
  // 正式版与预发布的优先级：0.1.5 > 0.1.5-rc.2
  { name: '正式版高于同元组的预发布', range: '>=0.1.5-rc.2', version: '0.1.5' },
  { name: '预发布低于同元组正式版 ⇒ 不被 >=0.1.5 接受', range: '>=0.1.5', version: '0.1.5-rc.2' },
  // 预发布序号比较：rc.2 < rc.3
  { name: '同线预发布序号递增', range: '>=0.1.5-rc.2', version: '0.1.5-rc.3' },
  { name: '同线预发布序号递减', range: '>=0.1.5-rc.3', version: '0.1.5-rc.2' },
  // npm 上 alpha 标签的当前版本
  { name: 'npm 上 alpha 标签的当前版本', range: '>=0.1.5-alpha.1 || >=0.1.6-alpha.1', version: '0.1.7-alpha.2' },
]

/** 第三方真值。semver 的 `satisfies` 直接就是 npm 的判定。 */
function expectFromSemver(range, version) {
  return semver.satisfies(version, range, { includePrerelease: false })
}

// ── 把守卫当成一个可执行文件跑，读它的退出码 ──────────────────────
// 不 import 它的内部函数：那样测的是「函数」，而 CI 用的是「命令行」。
// 判据必须落在**同一条路径**上。
function guardVerdict(range, version) {
  const dir = mkdtempSync(join(tmpdir(), 'vct-'))
  try {
    // 造一个最小包：只有 package.json 的 engines.dsh 与 version
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'vct-probe', version: '1.0.0', engines: { dsh: range } }, null, 2),
      'utf8',
    )
    // 守卫用 import.meta.url 定位 REPO，所以要把脚本复制到 <dir>/tools/ 下
    const toolsDir = join(dir, 'tools')
    spawnSync(process.execPath, ['-e', `require('node:fs').mkdirSync(${JSON.stringify(toolsDir)},{recursive:true})`])
    writeFileSync(join(toolsDir, 'verify-version-consistency.mjs'), readFileSync(GUARD, 'utf8'), 'utf8')

    const r = spawnSync(process.execPath, [join(toolsDir, 'verify-version-consistency.mjs'), '--dsh', version], {
      encoding: 'utf8',
    })
    return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录残留不影响结论 */ }
  }
}

// ── 跑 ───────────────────────────────────────────────────────────
if (!existsSync(GUARD)) {
  process.stderr.write(`version-consistency.test: 找不到 ${GUARD}\n`)
  process.exit(2)
}

let failed = 0
let negatives = 0
console.log(`version-consistency 自检 · 真值来源 semver@${String(semver.SEMVER_SPEC_VERSION ?? '?')} · ${String(CASES.length)} 个用例`)
console.log('')

for (const c of CASES) {
  const want = expectFromSemver(c.range, c.version)
  const got = guardVerdict(c.range, c.version)
  if (want === false) negatives += 1
  const agree = want === got.ok
  if (!agree) failed += 1
  console.log(`  ${agree ? '✓' : '✗'} ${c.name}`)
  console.log(`      range=${c.range}`)
  console.log(`      version=${c.version}   semver=${want ? '✓' : '✗'}   guard=${got.ok ? '✓' : '✗'}${agree ? '' : '   ← 不一致'}`)
  if (!agree) console.log(got.out.split('\n').map((l) => `        ${l}`).join('\n'))
}

console.log('')
console.log(`小结：${String(CASES.length - failed)}/${String(CASES.length)} 与 semver 真值一致；其中应当为 ✗ 的用例 ${String(negatives)} 条。`)

if (negatives === 0) {
  console.error('✗ 一个「应当为 ✗」的用例都没有 —— 这个自检只是装饰，证不了守卫会失败。')
  process.exit(1)
}
if (failed > 0) {
  console.error(`✗ ${String(failed)} 个用例与 semver 真值不一致 —— 守卫在说谎。`)
  process.exit(1)
}
console.log('version-consistency 自检通过。')
