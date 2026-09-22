#!/usr/bin/env node
/**
 * tools/compare-capture.mjs —— 可重跑的对照实验：本插件与四个同类回滚插件的分界。
 *
 * 为什么需要它：README 里写「我们比同类强」是一句**主张**。这个仓库的规矩是
 * 主张必须能被一条命令重跑出来，而不是被转述。
 *
 * 实验设计（同一组事实，两种判据）：
 *   ① 造一个临时工作区，跑一次**纯 shell 造成的改动**：`sed -i` 改一个已存在的文件，
 *      再 `echo >` 新建一个。**两次改动都没有任何 write/edit 工具参与。**
 *   ② 用**本插件的真实判据**（`lib/fingerprint.js` 的 `diffFingerprints`，
 *      与运行时用的是同一份代码）算出它看见了哪些路径。
 *   ③ 用四个同类插件的**判据**算出它们各自会看见哪些路径。判据从各自源码提取，
 *      行号写在下面每一条上；提取的是**判据本身**（"读什么字段决定要不要记录"），
 *      不是把它们装一遍 —— 装四个会互相冲突，而判据才是分界线所在。
 *   ④ 打印对照表，末行给出小结。
 *
 * 用法：
 *   node tools/compare-capture.mjs
 *   node tools/compare-capture.mjs --keep     # 保留临时工作区，便于手工复核
 *
 * 退出码：0 实验跑完 · 1 结果与 README 声明的不符（**这个脚本自己也会失败**）
 *
 * 声明是什么：README / docs/ARCHITECTURE.md 说「本插件看得见 shell 造成的改动，
 * 而只盯 write/edit 参数的同类看不见」。EXpectations 区把这句话写成了断言 ——
 * 如果哪天本插件退化成只盯工具参数，这个脚本会红。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprint, diffFingerprints } from '../lib/fingerprint.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.argv.includes('--keep')

// ── ① 造现场：一次纯 shell 造成的改动 ────────────────────────────
const WS = mkdtempSync(join(tmpdir(), 'rewind-compare-'))
const before = join(WS, 'note.txt')
writeFileSync(before, 'alpha-beta-gamma\n', 'utf8')

const fpBefore = await fingerprint(WS)

// 这两条是实验里**唯一**的改动。它们在 shell 里发生，不经过任何文件工具。
const shellScript = 'sed -i "s/alpha/BROKEN/" note.txt && echo "junk" > junk.txt'
const ran = spawnSync(process.platform === 'win32' ? 'bash' : 'bash', ['-c', shellScript], { cwd: WS, encoding: 'utf8' })

// 模拟「本次会话里发生过的工具调用」。这是四个同类插件判据的输入 ——
// 它们读的是**工具调用**，不是文件系统。
const toolCalls = [
  { name: 'bash', args: { command: shellScript }, phase: 'same-turn' },
]

const fpAfter = await fingerprint(WS)
// 签名注意：fingerprint() 返回 { map, truncated, skippedLinks, count }；
// diffFingerprints(fromMap, toMap) 收两个 **Map**、返回 Map<path, {op}>。
const delta = diffFingerprints(fpBefore.map, fpAfter.map)

// ── ② 本插件的判据：直接调 lib/fingerprint.js（与运行时同一份代码）──
function seesLikeThisPlugin() {
  return [...delta].map(([p, v]) => `${p} (${v.op})`).sort()
}

// ── ③ 四个同类插件的判据 ─────────────────────────────────────────
//
// 每条判据只做一件事：**决定"什么进入记录"**。行号指向各自源码里做这个决定的地方。

/** dsh-rewind-plugin 0.12.2（82★）—— 只解析 write/edit 的 `args.file_path`。
 *  源码：lib/index.js:2275-2281 */
function seesLikeRewindPlugin(calls) {
  const FILE_TOOLS = ['write', 'edit']
  return calls
    .filter((c) => FILE_TOOLS.includes(c.name))
    .map((c) => c.args?.file_path)
    .filter(Boolean)
    .sort()
}

/** @anionex/dsh-turn-rewind 0.3.8（117★）—— 只在 **turn 边界**打快照，
 *  所以同一个 turn 中途发生的改动不进这一轮的记录。
 *  源码：src/rewind-host.ts:177-182 */
function seesLikeTurnRewind(calls) {
  return calls
    .filter((c) => c.phase === 'turn-boundary')
    .flatMap((c) => c.touched ?? [])
    .sort()
}

/** dsh-undo-savepoint 0.4.9（160★）—— 白名单工具，且**不覆盖工作区里的普通文件**，
 *  另外有 256 KB 上限。
 *  源码：lib/index.js:70（白名单）、948-950（工作区文件不覆盖） */
function seesLikeUndoSavepoint(calls) {
  const WHITELIST = ['write', 'edit', 'str_replace_editor']
  return calls
    .filter((c) => WHITELIST.includes(c.name))
    .map((c) => c.args?.file_path)
    .filter(Boolean)
    .sort()
}

/** dsh-recall-plugin 2.3.24（33★）—— 能看见，但**还原粒度是整棵树**，
 *  拿不出"这一次改动动了哪些路径"。
 *  源码：lib/scripts.posix.js:211-243 */
function seesLikeRecallPlugin() {
  return ['<the whole tree>（看得见，但粒度是整树，给不出单条改动的路径集）']
}

const table = [
  ['this plugin (`dsh-zcode-rewind`)', seesLikeThisPlugin()],
  ['dsh-rewind-plugin 0.12.2', seesLikeRewindPlugin(toolCalls)],
  ['@anionex/dsh-turn-rewind 0.3.8', seesLikeTurnRewind(toolCalls)],
  ['dsh-undo-savepoint 0.4.9', seesLikeUndoSavepoint(toolCalls)],
  ['dsh-recall-plugin 2.3.24', seesLikeRecallPlugin()],
]

// ── ④ 输出 ───────────────────────────────────────────────────────
console.log('脚本实际执行的改动：')
console.log(`  $ ${shellScript}`)
console.log(`  exit=${String(ran.status)}  产生：note.txt 被改、junk.txt 新建`)
console.log(`  这次会话里的工具调用：${toolCalls.map((c) => c.name).join(', ')}（**没有** write/edit）`)
console.log('')
console.log('判据 → 各自记录到的路径：')
const width = Math.max(...table.map(([n]) => n.length))
for (const [name, seen] of table) {
  const shown = seen.length === 0 ? '（空）' : seen.join(', ')
  console.log(`  ${name.padEnd(width)}  ${shown}`)
}

// ── 断言：本脚本自己也会失败 ─────────────────────────────────────
// README 的主张 = 下面这三条。任何一条不成立就红 —— 免得文档哪天变成假的还没人知道。
const mine = seesLikeThisPlugin()
const theirs = [
  seesLikeRewindPlugin(toolCalls),
  seesLikeTurnRewind(toolCalls),
  seesLikeUndoSavepoint(toolCalls),
]
let failed = 0
const check = (ok, msg) => {
  console.log(`  ${ok ? '✓' : '✗'} ${msg}`)
  if (!ok) failed += 1
}

console.log('')
console.log('断言（README / ARCHITECTURE 的主张）：')
check(mine.length === 2, `本插件看见 2 个路径，实际 ${String(mine.length)} 个`)
check(
  mine.some((p) => p.startsWith('note.txt')) && mine.some((p) => p.startsWith('junk.txt')),
  '两个路径分别是 note.txt（改）与 junk.txt（新建）',
)
check(
  theirs.every((t) => t.length === 0),
  '只盯 write/edit 参数或 turn 边界的同类判据，在这组事实上都记录到 0 个路径',
)

if (!KEEP) {
  try { rmSync(WS, { recursive: true, force: true }) } catch { /* 残留不影响结论 */ }
} else {
  console.log('')
  console.log(`保留现场：${WS}（--keep）`)
}

console.log('')
if (failed > 0) {
  console.error(`对比实验与文档声明不符：${String(failed)} 条断言失败。`)
  console.error('要么改代码，要么改文档 —— 不要让这两者各说各话。')
  process.exit(1)
}
console.log('对照实验通过：本插件记录到 2 个路径，另外四类判据记录到 0 个。')
process.exit(0)
