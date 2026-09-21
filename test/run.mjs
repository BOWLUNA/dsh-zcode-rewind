#!/usr/bin/env node
/**
 * 测试入口:按文件名顺序跑 `test/` 下的每个 `*.test.mjs`,任一失败则整体退出 1。
 *
 * 每个套件自己打印一行 `结果: N 通过, M 失败` —— `tools/verify-doc-numbers.mjs`
 * 就是按这行统计「套件数 / 检查数」的,所以这行的格式是**对外契约**,不要改。
 *
 * 不依赖 DSH 宿主:全部套件都是离线可跑的(lib/ 是纯 Node 模块)。
 * 需要临时工作区的套件默认写到系统临时目录,并且**自己清理**;
 * 想指定位置就设 `REWIND_STRESS_DIR`(旧名 `PROBE06_STRESS_DIR` 仍兼容)。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const suites = readdirSync(HERE).filter((name) => name.endsWith('.test.mjs')).sort()

if (suites.length === 0) {
  console.error('✗ test/ 下没有任何 *.test.mjs')
  process.exit(1)
}

console.log(`测试套件: ${suites.length} 个（${suites.join('、')}）\n`)

let failed = 0
for (const suite of suites) {
  console.log(`──────── ${suite} ────────`)
  const result = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit', env: process.env })
  if (result.status !== 0) failed += 1
  console.log('')
}

if (failed > 0) {
  console.error(`${failed} / ${suites.length} 个测试套件失败`)
  process.exit(1)
}
console.log(`${suites.length} 个套件全部通过`)
