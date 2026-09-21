#!/usr/bin/env node
/**
 * 双语配对一致性校验（一份文件都不用手工登记：自己去找 `*.i18n.yaml`）。
 *
 * 与本工作区的 dsh-custom-mode 同款实现（同一套三段式守卫约定），此处按本仓路径直接沿用。
 *
 * 三层检查，少一层都会漏掉真实的失败模式：
 *   1. **哈希**：两侧内容是否与"上次确认一致"时相同 —— 能发现"只改了一侧"；
 *   2. **语言入口**：每一侧是否都有指向另一侧的链接 —— 能发现"忘了加语言切换行"；
 *   3. **结构对等**：标题层级、代码围栏、表格行、引用行、列表项逐项比较 —— 能发现"一侧少了整节"，
 *      而这是哈希**永远**查不出来的（两侧都改了、哈希一致，但内容不对称）。
 *
 * 用法:
 *   node tools/verify-translation-pairing.mjs           # 校验，不一致则退出 1
 *   node tools/verify-translation-pairing.mjs --write   # 把当前哈希重新记录进 *.i18n.yaml
 *
 * 不依赖 git 命令行：git 的 blob 哈希就是 sha1("blob <字节数>\0" + 内容)，自己算即可。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github'])

/** 递归找出所有 `*.i18n.yaml`。 */
function findRecords(dir = REPO, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) findRecords(full, out)
    else if (entry.endsWith('.i18n.yaml')) out.push(full)
  }
  return out.sort()
}

/** git 的 blob 哈希：sha1("blob <len>\0" + content)。 */
function blobHash(text) {
  const body = Buffer.from(text, 'utf8')
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`, 'utf8'), body])).digest('hex')
}

/** 从 i18n.yaml 里读出 `文件: 哈希` 记录（只认这两种行，其余当注释）。 */
function readRecord(path) {
  const out = {}
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([^\s#][^:]*):\s*([0-9a-f]{40})\s*$/.exec(line)
    if (match !== null) out[match[1].trim()] = match[2]
  }
  return out
}

const RECORD_HEADER = [
  '# 双语配对一致性记录：两侧在「上次确认一致」时的 git blob 哈希。',
  '# 两份文档权威相同——改完任意一侧，请把另一侧也改掉，然后重新记录：',
  '#   node tools/verify-translation-pairing.mjs --write',
].join('\n')

/** 结构形状：跳过代码围栏，逐项计数（围栏里的 # 注释不是标题）。 */
function shape(text) {
  const heads = []
  let fence = 0
  let inFence = false
  let tables = 0
  let quotes = 0
  let items = 0
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      fence += 1
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (line.startsWith('#')) heads.push(line.length - line.trimStart().length)
    else if (line.startsWith('|')) tables += 1
    else if (line.startsWith('>')) quotes += 1
    else if (/^\s*(-|\*|\d+\.)\s/.test(line)) items += 1
  }
  return { heads, fence, tables, quotes, items }
}

/**
 * 长片段语言检查：英文那一份里不该躺着整段中文，中文那一份里不该出现整句英文。
 *
 * 为什么需要它：哈希与结构都对的两份文档，仍可能"英文文件里放了一整段中文" —— 实测发生过
 * （`MEASUREMENTS.md` 的 §16–§18 整段是中文），而读者只读自己语言那一份，看到的就是混排。
 *
 * 判据故意宽松，避免误报：
 *  - 跳过代码围栏与行内代码（原始输出、命令、标识符本来就不该翻译）；
 *  - 跳过引号内（`"…"` 与 `「…」`）—— 引用上游原文或界面文案是合法的；
 *  - 只有连续 ≥12 个汉字（英文侧）或 ≥10 个连续英文词（中文侧）才算可疑。
 *
 * @param {string} full - absolute path of one side.
 * @param {string} rel - repository-relative path, used to pick the expected language.
 * @returns {string[]} problems (empty when the file is clean).
 */
function languagePurity(full, rel) {
  const englishSide = !/\.zh\.md$/.test(rel)
  const problems = []
  let inFence = false
  let scanned = 0
  const lines = readFileSync(full, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    scanned += 1
    const target = line
      .replace(/`[^`]*`/g, ' ')
      .replace(/"[^"]*"/g, ' ')
      .replace(/「[^」]*」/g, ' ')
    const hit = englishSide
      ? /[\u4e00-\u9fff]{12,}/.exec(target)
      : /(?:[A-Za-z][A-Za-z'-]*\s+){9,}[A-Za-z][A-Za-z'-]*/.exec(target)
    if (hit !== null) {
      problems.push(
        `${rel}:${String(index + 1)} ${englishSide ? '英文文档里出现整段中文' : '中文文档里出现整句英文'} → ${hit[0].slice(0, 40)}`,
      )
    }
  }
  // 防"空集假通过"：一份 md 不可能连 5 行正文都没有，扫不到就说明检查本身失效了。
  if (scanned < 5) problems.push(`${rel}: 只扫到 ${String(scanned)} 行正文，语言检查本身可能失效`)
  return problems
}

const write = process.argv.includes('--write')
const records = findRecords()
let failures = 0

if (records.length === 0) {
  console.error('✗ 没找到任何 *.i18n.yaml —— 双语文件旁边应当有一份配对记录。')
  process.exit(1)
}

for (const recordPath of records) {
  const rel = relative(REPO, recordPath)
  const files = Object.keys(readRecord(recordPath))
  if (files.length !== 2) {
    console.error(`✗ ${rel}: 记录里应当正好有两个文件，实际 ${files.length} 个。`)
    failures += 1
    continue
  }

  if (write) {
    const lines = [RECORD_HEADER]
    for (const file of files) lines.push(`${file}: ${blobHash(readFileSync(join(REPO, file), 'utf8'))}`)
    writeFileSync(recordPath, lines.join('\n') + '\n')
    console.log(`✓ ${rel} 已重新记录`)
    continue
  }

  const recorded = readRecord(recordPath)
  const actual = {}
  let missing = false
  for (const file of files) {
    const full = join(REPO, file)
    if (!existsSync(full)) {
      console.error(`✗ ${rel}: 记录里的 ${file} 不存在`)
      missing = true
      continue
    }
    actual[file] = blobHash(readFileSync(full, 'utf8'))
  }
  if (missing) {
    failures += 1
    continue
  }

  // 三层一起报，而不是撞到第一层就返回：改一次就能看全，不用"改一次、跑一次"。
  const problems = []

  const drifted = files.filter((file) => recorded[file] !== actual[file])
  if (drifted.length > 0) {
    problems.push(
      `这些文件在上次记录之后被改过 → ${drifted.join('、')}\n` +
      '    两份文档权威相同：请确认另一侧也跟上了，然后执行 node tools/verify-translation-pairing.mjs --write',
    )
  }

  // 语言入口：每一侧都要能点到另一侧。
  const missingLink = files.filter((file) => {
    const partner = files.find((other) => other !== file)
    return !readFileSync(join(REPO, file), 'utf8').includes(partner.split('/').pop())
  })
  if (missingLink.length > 0) {
    problems.push(
      `这些文件里找不到指向对方语言的链接 → ${missingLink.join('、')}\n` +
      '    每一侧都应有一行 `English | [中文](X.zh.md)` / `[English](X.md) | 中文`。',
    )
  }

  // 语言纯度：两侧语言不能混排（长片段级，宽松阈值）。
  const purity = files.flatMap((file) => languagePurity(join(REPO, file), file))
  if (purity.length > 0) {
    problems.push(`语言混排 →\n${purity.map((line) => `    ${line}`).join('\n')}`)
  }

  // 结构对等：哈希一致只说明"两侧都没再改过"，不说明它们长得一样。
  const [a, b] = files.map((file) => shape(readFileSync(join(REPO, file), 'utf8')))
  const labels = ['标题层级', '代码围栏', '表格行', '引用行', '列表项']
  const keys = ['heads', 'fence', 'tables', 'quotes', 'items']
  const mismatch = keys
    .map((key, i) => (JSON.stringify(a[key]) === JSON.stringify(b[key]) ? null : `${labels[i]}: ${files[0]}=${JSON.stringify(a[key])} ${files[1]}=${JSON.stringify(b[key])}`))
    .filter(Boolean)
  if (mismatch.length > 0) {
    problems.push(`两侧结构不对等 —— ${mismatch.join('；')}\n    通常是只在一侧加/删了一节。`)
  }

  if (problems.length > 0) {
    console.error(`✗ ${rel}:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    failures += 1
  } else {
    console.log(`✓ ${rel} 两侧一致（哈希 + 语言入口 + 结构对等）`)
  }
}

console.log(failures === 0 ? '双语配对: OK' : `双语配对: ${failures} 组有问题`)
process.exit(failures === 0 ? 0 : 1)
