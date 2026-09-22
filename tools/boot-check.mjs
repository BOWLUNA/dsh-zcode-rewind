#!/usr/bin/env node
/**
 * tools/boot-check.mjs —— 守卫 6：插件必须真的**装得上、起得来**。
 *
 * 本文件是 R2 规范「一规范、五实现」的 rewind 实现。规范要点与它们各自的实测依据：
 *
 *  · **Node 而不是 bash** —— 只有 Node 能覆盖 Windows 腿。bash 实现在 Git Bash 下会把
 *    传给原生 node 的 POSIX 路径改写成 `D:\d\a\repo`，只能靠 `if:` 绕开。
 *  · **断言 B 直接读文件** —— `--dump-config` 对「行名能否解析」**零信号**：
 *    行 name 正确与错误两种情况下，dump 都是 exit 0 / stderr 0 字节 / 照样列出该行，
 *    两份输出**差异为零**。所以不能靠 dump 断言，必须直接比对两个文件里的字符串。
 *  · **断言 C 落在「端口应答」而不是「打印了监听 URL」** —— 前者不依赖 stdout 格式。
 *    （本仓库实测：dsh 0.1.5-rc.2 与 0.1.6-alpha.2 在 node 22/24 上都会打印 URL；
 *      但把断言绑在输出格式上仍然是脆的，端口应答是同一件事的更强形式。）
 *  · **断言 D 用 SIGTERM 停止** —— SIGKILL 会让它起的 MCP 子进程 stdout 断裂、往 stderr
 *    吐 traceback，于是「stderr 是否为空」这条断言会随机变红。
 *  · **退出码 2 与 1 分开** —— 「守卫跑不了（环境缺件）」绝不能被报成「插件坏了」。
 *
 * 为什么这道守卫必须存在：本包 1.0.0 装得上、73 项单测全绿、`--dump-config` 干净，
 * 然后启动时把整个 profile 打下来 —— 因为 `cordis.patch.yml` 的行 `name` 还写着改名前的
 * 旧包名 `dsh-workspace-rewind`，而加载器把它当模块说明符**从 profile 目录**解析：
 *
 *   Cannot find package 'dsh-workspace-rewind' imported from …/profiles/web/
 *
 * 用法：
 *   node tools/boot-check.mjs --port 31860
 *   node tools/boot-check.mjs --port 31860 --dsh-bin C:/BL/AI/dsh-harness/node_modules/@deepseek-ai/dsh/lib/bin.js
 *   node tools/boot-check.mjs --port 31860 --keep
 *
 * 退出码：0 全部通过 · 1 有断言失败（会打印是 A/B/C/D 哪一条）· 2 环境缺件，与插件无关。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect } from 'node:net'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = 'web'

// ── 参数 ──────────────────────────────────────────────────────────
function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const PORT = Number(argOf('port', '31860'))
const TIMEOUT_MS = Number(argOf('timeout', '60000'))
const KEEP = process.argv.includes('--keep')

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  process.stderr.write(`boot-check: 需要 --port <1-65535>（端口必须固定：断言 C 靠它探测应答）\n`)
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bytes = (s) => Buffer.byteLength(s)

function failAssert(which, message, extra = '') {
  process.stderr.write(`boot-check: 断言 ${which} 失败 — ${message}\n`)
  if (extra) process.stderr.write(extra.endsWith('\n') ? extra : `${extra}\n`)
  process.exit(1)
}
function failEnv(message, hint) {
  process.stderr.write(`boot-check: 环境缺件（与插件无关）— ${message}\n`)
  if (hint) process.stderr.write(`${hint}\n`)
  process.exit(2)
}

// ── harness 发现顺序（R3 第 D 项的规范顺序）──────────────────────
//   1) --dsh-bin <path>                       显式参数
//   2) $DSH_INSTALL                           环境变量（换 harness 位置时用它）
//   3) <repo>/node_modules/@deepseek-ai/dsh   本地安装（CI 就是这一路）
//   4) PATH 上的 dsh                          机器级安装
//   5) 都没有 ⇒ exit 2 + 可复制的提示
//
// ⚠️ 不探测 %APPDATA%\dsh-desktop —— 那条路径 2026-09-21 已进回收站。
const INSTALL_HINT = `
按顺序试过四条路都不行。装一个，或显式指定：

  # 本机（Windows 桌面版 harness，2026-09-21 起的新位置）
  export DSH_HOME="C:/BL/AI/dsh-harness/harness"
  export PATH="C:/BL/AI/dsh-harness/harness/.desktop-bin:$PATH"
  export DSH_INSTALL="C:/BL/AI/dsh-harness"
  node tools/boot-check.mjs --port ${String(PORT)}

  # CI / 任意机器
  npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2
  npm install -g pnpm@12
  node tools/boot-check.mjs --port ${String(PORT)}
`

function dshEntryIn(pkgDir) {
  const manifest = join(pkgDir, 'package.json')
  if (!existsSync(manifest)) return null
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    return null
  }
  const bin = parsed.bin
  const rel = typeof bin === 'string' ? bin : bin?.dsh
  const entry = rel ? join(pkgDir, rel) : join(pkgDir, 'lib', 'bin.js')
  return existsSync(entry) ? entry : null
}

function resolveDshBin() {
  const tried = []

  const explicit = argOf('dsh-bin', null)
  if (explicit) {
    const p = resolve(explicit)
    if (existsSync(p)) return { entry: p, via: '--dsh-bin' }
    failEnv(`--dsh-bin 指向的路径不存在：${p}`)
  }
  tried.push('--dsh-bin（未给）')

  const install = process.env.DSH_INSTALL
  if (install) {
    // DSH_INSTALL 语义 = harness 安装根（其下有 node_modules/@deepseek-ai/dsh）；
    // 也兼容它直接指向包目录的写法。
    for (const candidate of [
      join(install, 'node_modules', '@deepseek-ai', 'dsh'),
      install,
    ]) {
      const entry = dshEntryIn(candidate)
      if (entry) return { entry, via: `$DSH_INSTALL (${install})` }
    }
    tried.push(`$DSH_INSTALL = ${install}（其下找不到 @deepseek-ai/dsh）`)
  } else {
    tried.push('$DSH_INSTALL（未设）')
  }

  const local = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh')
  {
    const entry = dshEntryIn(local)
    if (entry) return { entry, via: `<repo>/node_modules（${local}）` }
    tried.push(`<repo>/node_modules/@deepseek-ai/dsh（${local} 下没有入口）`)
  }

  // PATH 上的 dsh：从可执行文件位置反推常见布局
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  const found = String(which.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
  if (found) {
    const dir = dirname(found)
    const guesses = [
      resolve(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
      resolve(dir, '..', '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    ]
    // WSL 的 node 全局布局：~/.local/share/nodejs/node-v*/lib/node_modules/...
    try {
      for (const base of [resolve(dir, '..', 'share', 'nodejs')]) {
        if (!existsSync(base)) continue
        for (const d of readdirSync(base)) {
          guesses.push(join(base, d, 'lib', 'node_modules', '@deepseek-ai', 'dsh'))
        }
      }
    } catch {
      /* 读不到就算了，继续试已知猜测 */
    }
    for (const g of guesses) {
      const entry = dshEntryIn(g)
      if (entry) return { entry, via: `PATH 上的 dsh（${found}）` }
    }
    tried.push(`PATH 上的 dsh（${found}）→ 反推不出 @deepseek-ai/dsh`)
  } else {
    tried.push('PATH 上的 dsh（没有）')
  }

  failEnv(`找不到可用的 harness。逐条结果：\n    - ${tried.join('\n    - ')}`, INSTALL_HINT)
  return null
}

const DSH = resolveDshBin()

// pnpm：dsh 的 `plugin add` 转调它，dsh 不自带（缺了直接 127）
// ⚠️ 不要写 spawnSync('pnpm', ['--version'], { shell: true }) —— 那会触发 DEP0190
//    （shell:true 且带 args）。整条命令交给 shell、不传 args 就没有这个问题。
// ⚠️ 也不要写 spawnSync('pnpm', ['--version'])（shell:false）：在 Git Bash 下 PATH 是
//    POSIX 风格（/c/Users/...），Windows 原生进程按它找不到 pnpm.cmd。
//    实测：shell:false 时 pnpm 探测必然失败，守卫会误报 exit 2。
function pnpmVersion() {
  const r = spawnSync('pnpm --version', { encoding: 'utf8', shell: true })
  if (r.status === 0) return String(r.stdout).trim()
  return null
}
const PNPM = pnpmVersion()
if (PNPM === null) {
  failEnv(
    'pnpm 不在 PATH 上，而 `dsh plugin add` 会转调它（没有它 dsh 退出 127）。',
    '  先装：npm install -g pnpm@12',
  )
}

// ── 一次性 DSH_HOME（第一件事就是断言它不是真实的那一个）────────
const HOME = mkdtempSync(join(tmpdir(), 'dsh-rewind-boot-'))
{
  const real = resolve(join(homedir(), '.dsh'))
  const mine = resolve(HOME)
  if (mine === real || mine.startsWith(real + sep)) {
    process.stderr.write(`boot-check: 拒绝执行 — 一次性 DSH_HOME 落在了真实的 ${real} 里\n`)
    process.exit(2)
  }
}
const ENV = { ...process.env, DSH_HOME: HOME, NO_COLOR: '1', FORCE_COLOR: '0' }

function cleanup() {
  if (KEEP) {
    process.stdout.write(`boot-check: 保留 ${HOME}（--keep）\n`)
    return
  }
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* 见下面的一致性复查 */
  }
  // 静默失败会让临时目录一直堆积，而且它可能被下一次运行继承 —— 明说。
  if (existsSync(HOME)) {
    process.stdout.write(`boot-check: 注意 — 一次性 DSH_HOME 没能删干净，请手工清：${HOME}\n`)
  }
}

process.stdout.write(`boot-check: node ${process.versions.node} · dsh ${DSH.entry}（来自 ${DSH.via}）· pnpm ${PNPM}\n`)
process.stdout.write(`boot-check: 一次性 DSH_HOME ${HOME}\n`)

// ── 断言 A：插件装得上 ───────────────────────────────────────────
const install = spawnSync(process.execPath, [DSH.entry, 'plugin', '--profile', PROFILE, 'add', ROOT], {
  cwd: ROOT, env: ENV, encoding: 'utf8',
})
if (install.status !== 0) {
  cleanup()
  process.stderr.write(`${install.stdout ?? ''}${install.stderr ?? ''}`)
  failAssert('A', `\`dsh plugin --profile ${PROFILE} add <repo>\` 退出 ${install.status} —— 插件装不上。`)
}
process.stdout.write('boot-check: 断言 A 通过（plugin add 返回 0）\n')

// ── 断言 B：行 name === package.json name（直接读文件）───────────
{
  const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
  const patchPath = join(ROOT, 'cordis.patch.yml')
  if (!existsSync(patchPath)) failAssert('B', `找不到 ${patchPath}`)

  const names = []
  for (const line of readFileSync(patchPath, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue // 注释不算
    const m = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (m) names.push(m[1].replace(/^['"]|['"]$/g, ''))
  }

  const bad = names.filter((n) => n !== pkgName)
  if (bad.length > 0 || names.length === 0) {
    cleanup()
    failAssert(
      'B',
      `cordis.patch.yml 的行 name 与 package.json 的 name 不一致。\n` +
        `  package.json  name = ${pkgName}\n` +
        `  cordis.patch  name = ${names.length ? names.join(', ') : '(一个都没找到)'}\n` +
        `  加载器把行 name 当模块说明符、从 profile 目录解析 —— 对不上就会在启动时报\n` +
        `  Cannot find package '${bad[0] ?? '<name>'}'，而 --dump-config 对此**零信号**。`,
    )
  }
  process.stdout.write(`boot-check: 断言 B 通过（行 name = ${names.join(', ')} 与 package.json 一致）\n`)
}

// ── 断言 C：端口必须真的应答 ─────────────────────────────────────
async function portAnswers() {
  return new Promise((res) => {
    const sock = connect({ host: '127.0.0.1', port: PORT })
    const done = (v) => { sock.destroy(); res(v) }
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
    sock.setTimeout(1500, () => done(false))
  })
}

// 端口必须**预先空闲**。否则「端口应答」可能来自别的进程 —— 断言 C 会**误判通过**，
// 而那是守卫自己能犯的最坏一种错：看着尽责，其实什么都没验。
// （实测踩到过：同一个端口上一轮起的服务没释放干净时，一个坏掉的插件照样“通过”。）
if (await portAnswers()) {
  failEnv(
    `端口 ${String(PORT)} 在本机已被占用。`,
    `  断言 C 靠「端口是否应答」判断插件起没起 —— 端口本来就有主的话它判不了。\n` +
      `  换一个空闲端口再跑，或先找占用者：netstat -ano | grep ${String(PORT)}`,
  )
}

const child = spawn(process.execPath, [DSH.entry, '--profile', PROFILE, '--port', String(PORT), '--no-open'], {
  cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let exited = null
child.stdout.on('data', (c) => { stdout += c })
child.stderr.on('data', (c) => { stderr += c })
child.on('exit', (code, signal) => { exited = { code, signal } })

const deadline = Date.now() + TIMEOUT_MS
let answered = false
while (Date.now() < deadline) {
  if (exited !== null) break
  if (await portAnswers()) { answered = true; break }
  await sleep(200)
}

// 断言 D 的采样点：**端口应答的那一刻**
const stderrAtPort = stderr

// ⚠️ 「端口应答」本身**不足以**证明插件起来了 —— 应答的可能是**别的进程**：
//    CI 矩阵四条腿并行跑同一个端口、上一轮的服务没释放干净、本机其它服务……
//    所以判据必须再加一条：**本守卫起的那个进程必须仍然活着**。
//    实测踩到过：给 lib/index.js 注入一个顶层 throw 把插件打死之后，端口照样有应答，
//    守卫报了 PASS —— 那是守卫自己能犯的最坏的错：看着尽责，其实什么都没验。
if (!answered || exited !== null) {
  const why = exited !== null
    ? `端口 ${String(PORT)} 有应答，但本守卫起的进程**已经退出**（code ${String(exited.code)}）—— 应答的不是它`
    : `${String(TIMEOUT_MS)} ms 内端口 ${String(PORT)} 始终不应答`
  if (exited === null) child.kill('SIGTERM')
  await sleep(500)
  cleanup()
  process.stderr.write(`boot-check: --- stdout ---\n${stdout}\n`)
  process.stderr.write(`boot-check: --- stderr ---\n${stderr}\n`)
  failAssert('C', `${why} —— 插件没起来。`)
}
process.stdout.write(`boot-check: 断言 C 通过（端口 ${String(PORT)} 应答，且本守卫起的进程仍存活）\n`)
// 调试用：把子进程的输出原样吐出来，用来确认「应答端口的到底是不是它」。
if (process.env.BOOT_CHECK_DUMP === '1') {
  process.stdout.write(`boot-check: --- stdout ---\n${stdout === '' ? '(空)\n' : stdout}`)
  process.stdout.write(`boot-check: --- stderr ---\n${stderr === '' ? '(空)\n' : stderr}`)
}

// 断言 D：那一刻 stderr 必须为空。用 SIGTERM，不用 SIGKILL。
child.kill('SIGTERM')
for (let i = 0; i < 40 && exited === null; i += 1) await sleep(100)
if (exited === null) child.kill('SIGKILL')

process.stdout.write(`boot-check: stderr bytes @端口应答 = ${String(bytes(stderrAtPort))}\n`)
if (bytes(stderrAtPort) > 0) {
  cleanup()
  process.stderr.write(`boot-check: --- stderr ---\n${stderrAtPort}\n`)
  failAssert('D', `端口应答时 stderr 不为空（${String(bytes(stderrAtPort))} 字节）—— 会抱怨的启动不算干净的启动。`)
}
process.stdout.write('boot-check: 断言 D 通过（stderr 为空）\n')

cleanup()
process.stdout.write('boot-check: PASS（A/B/C/D 四条断言全过）\n')
