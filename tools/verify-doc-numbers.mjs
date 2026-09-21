#!/usr/bin/env node
/**
 * 文档里的数字是主张,必须与真实运行一致。
 *
 * **为什么有它**:文档不被执行,所以写错的数字没有任何测试能看见。
 * 本工作区的参考仓(dsh-custom-mode)见过一次同一遍里三处漂移:
 * `test/README.md` 还写着 8 个套件、`README.md` 写 588 检查、
 * `CONTRIBUTING.md` 写 588——全部与实际不符。
 *
 * 做法:
 *   1. 跑 `node test/run.mjs`,读真实总数(套件数 = `结果:` 行数,检查数 = 通过+失败之和);
 *   2. 从英文文档里抽出计数主张逐条比对(中文侧比 `N 个套件` / `N 项检查`);
 *   3. 断言声明的 dsh 区间出现在 `README.md` 里,且 `SECURITY.md` 支持表首行是当前版本;
 *   4. 断言 README 安装示例里钉的版本就是当前版本(参考仓真的出现过停在旧版本号)。
 *
 * 用法: node tools/verify-doc-numbers.mjs
 * 退出: 一致为 0,否则 1 并打印 file:line 与两个值。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = []

/** 跑测试套件,拿真实总数。 */
function measure() {
  // stderr 吞掉:套件里有故意失败的演示(压力测试的"注入缺陷"一节),不是这里的问题。
  const output = execFileSync(process.execPath, [join(REPO, 'test', 'run.mjs')], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let checks = 0
  const suites = []
  for (const line of output.split('\n')) {
    const match = /^结果: (\d+) 通过, (\d+) 失败/.exec(line)
    if (match !== null) {
      checks += Number(match[1]) + Number(match[2])
      suites.push(match[0])
    }
  }
  const files = readdirSync(join(REPO, 'test')).filter((name) => name.endsWith('.test.mjs'))
  return { checks, suiteRuns: suites.length, suiteFiles: files.length }
}

/**
 * 在文件里查计数主张。
 *
 * @param {string} rel - 仓库相对路径。
 * @param {RegExp} pattern - 必须把数字捕到第 1 组。
 * @param {string} what - 失败信息里的名字。
 * @param {number} expected - 真实值。
 */
function checkCount(rel, pattern, what, expected) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  text.split('\n').forEach((line, index) => {
    const match = pattern.exec(line)
    if (match === null) return
    if (Number(match[1]) !== expected) {
      problems.push(`${rel}:${String(index + 1)} 说 ${what} 是 ${match[1]},实际是 ${String(expected)}\n    ${line.trim()}`)
    }
  })
}

const real = measure()
if (real.suiteFiles !== real.suiteRuns) {
  problems.push(`test/ 下有 ${String(real.suiteFiles)} 个套件文件,但 run.mjs 只跑了 ${String(real.suiteRuns)} 个 —— 某个套件没被登记`)
}
console.log(`实际:${String(real.suiteRuns)} 个套件,${String(real.checks)} 项检查`)

// 1) 套件数与检查数
for (const rel of ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'test/README.md']) {
  checkCount(rel, /(\d+) suites?\b/, '套件数（suites）', real.suiteRuns)
  checkCount(rel, /(\d+) checks?\b/, '检查数（checks）', real.checks)
}
checkCount('README.zh.md', /(\d+) 个套件/, '套件数', real.suiteRuns)
checkCount('README.zh.md', /(\d+) 项检查/, '检查数', real.checks)

// 2) 声明的 dsh 区间必须出现在 README 里
const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const range = manifest.engines.dsh
for (const rel of ['README.md', 'README.zh.md']) {
  if (readFileSync(join(REPO, rel), 'utf8').includes(range) === false) {
    problems.push(`${rel} 里没有出现声明的 dsh 范围 ${range}`)
  }
}

// 3) 安装示例钉的版本必须就是当前版本
for (const rel of ['README.md', 'README.zh.md']) {
  const text = readFileSync(join(REPO, rel), 'utf8')
  const pinned = [...text.matchAll(/dsh-zcode-rewind@(\d+\.\d+\.\d+)/g)].map((match) => match[1])
  for (const version of new Set(pinned)) {
    if (version !== manifest.version) {
      problems.push(`${rel} 的安装示例钉的是 @${version},而包版本是 ${manifest.version}`)
    }
  }
}

// 4) SECURITY 支持表首行必须写当前版本
const security = readFileSync(join(REPO, 'SECURITY.md'), 'utf8')
const firstRow = security.split('\n').find((line) => line.startsWith('| `') && line.includes('Supported'))
if (firstRow === undefined) {
  problems.push('SECURITY.md 的支持表里找不到第一行')
} else if (firstRow.includes(`\`${manifest.version}\``) === false) {
  problems.push(`SECURITY.md 支持表的第一行不是当前版本 ${manifest.version}\n    ${firstRow.trim()}`)
}

if (problems.length > 0) {
  console.error('')
  for (const problem of problems) console.error(`✗ ${problem}`)
  console.error('')
  console.error(`文档数字与实际不一致:${String(problems.length)} 处。改文档,不要改检查(检查读的是真实运行结果)。`)
  process.exit(1)
}
console.log(`✓ 文档里的数字与实际一致(${String(real.suiteRuns)} 套件 / ${String(real.checks)} 项 / dsh ${range} / 版本 ${manifest.version})`)
