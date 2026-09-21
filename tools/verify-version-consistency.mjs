#!/usr/bin/env node
/**
 * 断言「本包支持 dsh X」这句话是真的。
 *
 * 两条不变量:
 *   1. **版本号必须是裸 `x.y.z`** —— 多个目录与市场拒绝自动安装带预发布标签的版本
 *      (它们解析 npm `latest` 并要求 `prerelease(value) === null`)。
 *      所以「支持哪些 dsh」不再写进版本号,而是写在 `engines.dsh` 与 peer 区间里。
 *   2. **CI 实际安装并测试的那条 dsh 版本必须落在这些区间内** —— 这是真正的不变量:
 *      区间覆盖不到实测版本就是**虚假声明**,而除此之外没有任何东西把两者联系起来。
 *
 * 两种模式:
 *   node tools/verify-version-consistency.mjs              # CI:workflow 里钉的 dsh 版本必须满足区间
 *   node tools/verify-version-consistency.mjs --dsh <ver>  # 本机这条 dsh 是否在声明区间内
 *
 * ⚠️ **裸跑会去找 `.github/workflows/test.yml` 里 `@deepseek-ai/dsh@<version>` 的字面量**;
 *    本仓的 test.yml 用的是 `matrix.dsh`,所以裸跑**永久 exit 1 是预期行为**——
 *    CI 里传的是 `--dsh ${{ matrix.dsh }}`。
 *
 * 注意 node-semver 的预发布语义:一个带 prerelease 的版本,只有当区间里存在**同一个
 * major.minor.patch 元组**的比较符时才可能被满足。所以 `>=0.1.2-alpha.1` **匹配不上**
 * `0.1.6-alpha.1`;必须写成 `>=0.1.6-alpha.1`。本脚本按同一规则实现,以避免"看起来宽松、
 * 实际匹配不上"的假声明。
 *
 * 退出:一致为 0,否则 1。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const workflowPath = join(REPO, '.github', 'workflows', 'test.yml')

const fail = (lines) => {
  for (const line of lines) console.error(line)
  process.exit(1)
}

/** `1.2.3-rc.4` → `{ tuple: [1,2,3], prerelease: ['rc','4'] }`;不是版本则 null。 */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return {
    tuple: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** semver 优先级:先比元组,再比「预发布低于正式」。 */
function compare(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] < b.tuple[i] ? -1 : 1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const len = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < len; i += 1) {
    const x = a.prerelease[i]
    const y = b.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 单个比较符 `>=1.2.3-x` / `<2.0.0` / `^4.0.1` 是否接受某个版本。 */
function satisfiesComparator(version, comparator) {
  const match = /^(>=|<=|>|<|\^|~)?\s*(.+)$/.exec(comparator.trim())
  if (match === null) return false
  const op = match[1] ?? '='
  let bound = parseVersion(match[2])
  if (bound === null && op === '^') bound = parseVersion(match[2].replace(/^(\d+)$/, '$1.0.0'))
  if (bound === null) return false
  // 预发布规则:版本带 prerelease 时,必须有一个同元组且带 prerelease 的比较符
  const cmp = compare(version, bound)
  if (op === '>=') return cmp >= 0
  if (op === '<=') return cmp <= 0
  if (op === '>') return cmp > 0
  if (op === '<') return cmp < 0
  if (op === '=') return cmp === 0
  const upper = { tuple: [bound.tuple[0], bound.tuple[1] + 1, 0], prerelease: [] }
  if (op === '^') {
    const cap = bound.tuple[0] === 0 ? { tuple: [0, bound.tuple[1] + 1, 0], prerelease: [] } : { tuple: [bound.tuple[0] + 1, 0, 0], prerelease: [] }
    return cmp >= 0 && compare(version, cap) < 0
  }
  if (op === '~') return cmp >= 0 && compare(version, upper) < 0
  return false
}

/** 区间(可能带 `||` 备选)是否接受某个版本。 */
function satisfiesRange(version, range) {
  const parsed = parseVersion(version)
  if (parsed === null) return { ok: false, reason: `"${version}" 不是一个版本号` }
  const alternatives = String(range).split('||').map((part) => part.trim()).filter(Boolean)
  for (const alternative of alternatives) {
    const comparators = alternative.split(/\s+/).filter(Boolean)
    const all = comparators.every((comparator) => satisfiesComparator(parsed, comparator))
    if (!all) continue
    if (parsed.prerelease.length > 0) {
      const sameTuple = comparators.some((comparator) => {
        const bound = parseVersion(/^(?:>=|<=|>|<|\^|~)?\s*(.+)$/.exec(comparator.trim())?.[1] ?? '')
        return bound !== null && bound.prerelease.length > 0
          && bound.tuple[0] === parsed.tuple[0] && bound.tuple[1] === parsed.tuple[1] && bound.tuple[2] === parsed.tuple[2]
      })
      if (!sameTuple) continue
    }
    return { ok: true }
  }
  return { ok: false, reason: `${version} 不落在 ${range} 内(预发布需同元组比较符)` }
}

// 只比对「与 dsh 版本同一条线」的声明:
//   engines.dsh 与 peerDependencies['@deepseek-ai/dsh']。
// 其它 peer(cordis / schemastery / dsh-tools…)有各自的版本线,与 dsh 版本**无关**,
// 拿 dsh 版本去比对它们会得出毫无意义的结论。
const DSP_PEER = '@deepseek-ai/dsh'
const ranges = [
  ['engines.dsh', pkg.engines?.dsh],
  [`peer ${DSP_PEER}`, pkg.peerDependencies?.[DSP_PEER]],
].filter(([, range]) => typeof range === 'string' && range !== '')

// 版本号必须是裸 x.y.z
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  fail([
    `版本一致性: package.json 的 version 是 ${pkg.version},必须是裸 x.y.z。`,
    '  带预发布标签的版本会被部分目录/市场拒绝自动安装(它们要求 prerelease === null)。',
  ])
}

const dshFlagIndex = process.argv.indexOf('--dsh')
if (dshFlagIndex >= 0) {
  const value = process.argv[dshFlagIndex + 1]
  if (value === undefined) fail(['版本一致性: --dsh 后面要跟一个版本号,例如 --dsh 0.1.6-alpha.2'])
  const problems = []
  for (const [label, range] of ranges) {
    const result = satisfiesRange(value, range)
    if (!result.ok) problems.push(`  ✗ ${label} = ${range}\n      ${result.reason}`)
  }
  if (problems.length > 0) {
    fail([`版本一致性: dsh ${value} 不满足本包声明:`, ...problems, '', '要么放宽声明,要么明确本包不支持这条 dsh。不要留着假声明。'])
  }
  console.log(`✓ dsh ${value} 落在全部声明区间内(${String(ranges.length)} 条)`)
  process.exit(0)
}

// CI 模式:从 workflow 里取钉定的 dsh 版本
let workflow = ''
try {
  workflow = readFileSync(workflowPath, 'utf8')
} catch {
  fail([`版本一致性: 找不到 ${'.github/workflows/test.yml'}`, '  CI 模式需要它来取钉定的 dsh 版本;本机核对请用 --dsh <version>。'])
}
const pinned = /@deepseek-ai\/dsh@([0-9A-Za-z.\-+]+)/.exec(workflow)
if (pinned === null) {
  fail([
    '版本一致性: 无法在 CI workflow 里找到 @deepseek-ai/dsh@<version> 的钉定。',
    '  本仓 test.yml 使用 matrix.dsh,所以裸跑必然是这条 —— 这是预期行为。',
    '  请用: node tools/verify-version-consistency.mjs --dsh <你的 dsh 版本>',
  ])
}
const recorded = pinned[1]
const problems = []
for (const [label, range] of ranges) {
  const result = satisfiesRange(recorded, range)
  if (!result.ok) problems.push(`  ✗ ${label} = ${range}\n      ${result.reason}`)
}
if (problems.length > 0) {
  fail([`版本一致性: CI 钉的 dsh ${recorded} 不满足本包声明:`, ...problems])
}
console.log(`✓ 版本一致性: CI 钉的 dsh ${recorded} 落在全部声明区间内(包版本 ${pkg.version})`)
