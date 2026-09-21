#!/usr/bin/env node
/**
 * 守卫 6 —— 插件必须真的**起得来**。
 *
 * 仓库里其余五道守卫跑的都是插件的纯逻辑或它的配置，**没有一道把插件真装进一个
 * 真实 harness 里跑一遍**。这个差别不是学术性的：2026-09-21 本包发布的 1.0.0
 * 装得上、73 项单测全绿、`--dump-config` 给出 exit 0 / stderr 0 字节 / 571 行的
 * 合成树 —— 然后在启动时把整个 profile 打下来：
 *
 *   Error: dsh: plugin tree failed to load: … failed to import loader entry
 *          workspace-rewind (dsh-workspace-rewind):
 *          Cannot find package 'dsh-workspace-rewind' imported from …/profiles/web/
 *
 * 起因是一个词。包从 `dsh-workspace-rewind` 改名为 `dsh-zcode-rewind` 时，
 * `cordis.patch.yml` 里那一行的 `name` 字段没跟着改。加载器把 `name` 当模块说明符、
 * **在 apply 插件树时从 profile 目录**解析它 —— 而 `--dump-config` 只**合成**配置、
 * 从不 apply 任何东西，所以它对一个根本起不来的 profile 报告了一棵干净的树。
 * （实测：行名是否解析得到，在 dump 里**不留任何痕迹** —— 没有 `packageDir`、
 * 没有 `__dshPluginOwner`，解析成功与失败输出逐字节相同。）
 *
 * 所以这道守卫做那件唯一能把缝补上的事：在一个隔离的 `DSH_HOME` 里建一个一次性
 * profile，按用户的方式把这个 checkout 装进去，然后启动它。**没走到打印监听 URL
 * 那一步，就什么都不算通过。**
 *
 * 三条断言，全部基于可观测输出：
 *   1. `dsh plugin … add` exit 0。
 *   2. 启动打印出 `dsh web: http://…` —— 即插件树 apply 成功、服务起来了。
 *      解析不到的模块永远走不到这一步。
 *   3. stderr **为空**，且 URL 出现后进程仍然活着。打印了 URL 然后立刻死掉的不算启动。
 *
 * `dsh plugin add` 转调 pnpm，而 dsh 不自带它 —— 没有 pnpm 时它 exit 127 并报
 * "pnpm was not found"。CI 会装；本地请确保 `pnpm` 在 PATH 上。
 *
 * 用法：
 *   node tools/verify-boot.mjs                      # 端口 31860，60 秒期限
 *   node tools/verify-boot.mjs --port 0             # 让 OS 选（避免撞端口）
 *   node tools/verify-boot.mjs --keep               # 保留那个一次性 DSH_HOME
 *   node tools/verify-boot.mjs --dsh-bin <路径>      # 指定某个 harness 安装
 *
 * 退出码：0 通过 · 1 插件没起来 · 2 环境根本没配好，这道守卫跑不了。
 * 这个区分是必要的：**"守卫跑不了"绝不能被报成"守卫通过"**。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = 'web'

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function argOf(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

// 本工作区给这个项目留的是 31860-31869；31860 是本仓库自己的启动记录取值的那条。
const PORT = argOf('port', '31860')
const TIMEOUT_MS = Number(argOf('timeout', '60000'))
const KEEP = process.argv.includes('--keep')

function fail(message, code = 1) {
  process.stderr.write(`verify-boot: FAIL — ${message}\n`)
  process.exit(code)
}

// ---------------------------------------------------------------------------
// 找到要启动的 harness
// ---------------------------------------------------------------------------

/**
 * 这个 checkout 旁边的 harness 可执行文件路径。
 *
 * CI 用 `npm install --no-save` 把 `@deepseek-ai/dsh` 装进仓库自己的 `node_modules`；
 * 那也正是 `link:` 装的插件解析宿主 peer 的地方，所以就该启动这一个。
 */
function resolveDshBin() {
  const explicit = argOf('dsh-bin', null)
  if (explicit) return resolve(explicit)

  const pkgDir = join(ROOT, 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = join(pkgDir, 'package.json')
  if (!existsSync(manifest)) return null

  const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  const bin = parsed.bin
  const rel = typeof bin === 'string' ? bin : bin?.dsh
  return rel ? join(pkgDir, rel) : join(pkgDir, 'lib', 'bin.js')
}

const DSH_BIN = resolveDshBin()
if (DSH_BIN === null || !existsSync(DSH_BIN)) {
  fail(
    `没找到 harness：${join(ROOT, 'node_modules', '@deepseek-ai', 'dsh')}\n` +
      '  先按 CI 的方式装它：\n' +
      '    npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2',
    2,
  )
}

const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' })
if (pnpm.status !== 0) {
  fail(
    'pnpm 不在 PATH 上，而 `dsh plugin add` 会转调它（没有它 dsh 退出 127）。\n' +
      '  先装：npm install -g pnpm@12.4.2',
    2,
  )
}
const PNPM_VERSION = String(pnpm.stdout).trim()

// ---------------------------------------------------------------------------
// 一次性 home：失败的守卫绝不该伤到任何真实 profile
// ---------------------------------------------------------------------------

const HOME = mkdtempSync(join(tmpdir(), 'dsh-rewind-boot-'))
const ENV = { ...process.env, DSH_HOME: HOME, NO_COLOR: '1', FORCE_COLOR: '0' }

function run(args, options = {}) {
  return spawnSync(process.execPath, [DSH_BIN, ...args], { cwd: ROOT, env: ENV, encoding: 'utf8', ...options })
}

function cleanup() {
  if (KEEP) {
    process.stdout.write(`verify-boot: 保留 ${HOME}（--keep）\n`)
    return
  }
  try {
    rmSync(HOME, { recursive: true, force: true })
  } catch {
    /* 一个留在临时目录里的残留，不值得让守卫失败 */
  }
}

process.stdout.write(`verify-boot: node ${process.versions.node} · dsh ${DSH_BIN} · pnpm ${PNPM_VERSION}\n`)
process.stdout.write(`verify-boot: 一次性 DSH_HOME ${HOME}\n`)

// ---------------------------------------------------------------------------
// 1. 把这个 checkout 装进一次性 profile
// ---------------------------------------------------------------------------

const install = run(['plugin', '--profile', PROFILE, 'add', ROOT])
if (install.status !== 0) {
  cleanup()
  process.stderr.write(`${install.stdout ?? ''}${install.stderr ?? ''}`)
  fail(`\`dsh plugin add\` 退出 ${install.status} —— 插件装不上。`, 1)
}
for (const line of String(install.stdout ?? '').split('\n')) {
  if (/dsh-zcode-rewind|link:/.test(line)) process.stdout.write(`verify-boot:   install → ${line.trim()}\n`)
}

// ---------------------------------------------------------------------------
// 2. 启动它，并要求它带着干净的 stderr 走到监听 URL
// ---------------------------------------------------------------------------

const child = spawn(process.execPath, [DSH_BIN, '--profile', PROFILE, '--port', PORT, '--no-open'], {
  cwd: ROOT,
  env: ENV,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
let listeningUrl = null
let exitedEarly = null

child.stdout.on('data', (chunk) => {
  stdout += chunk
  if (listeningUrl === null) {
    const match = stdout.match(/dsh web:\s*(http:\/\/\S+)/)
    if (match) listeningUrl = match[1]
  }
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})
child.on('exit', (code, signal) => {
  exitedEarly = { code, signal }
})

const deadline = Date.now() + TIMEOUT_MS
while (listeningUrl === null && exitedEarly === null && Date.now() < deadline) {
  // 同步睡眠：这个脚本刻意是线性的，子进程的流会在它自己的事件循环轮次里继续填充。
  await new Promise((r) => setTimeout(r, 100))
}

/** 停掉子进程，再给它一点时间把正在写的东西冲出来。 */
async function stop() {
  if (exitedEarly !== null) return
  child.kill('SIGKILL')
  for (let i = 0; i < 30 && exitedEarly === null; i += 1) await new Promise((r) => setTimeout(r, 100))
}

if (listeningUrl === null) {
  await stop()
  const where = exitedEarly === null ? `${TIMEOUT_MS} ms 内超时` : `以退出码 ${exitedEarly.code} 退出`
  cleanup()
  process.stderr.write(`verify-boot: --- stdout ---\n${stdout}`)
  process.stderr.write(`verify-boot: --- stderr ---\n${stderr}`)
  fail(`profile 始终没有打印监听 URL（${where}）—— 插件没起来。`, 1)
}

// URL 出现就是通过信号；但打印完立刻就死的进程并没有在服务，所以让子进程多活一拍再复查。
for (let i = 0; i < 15 && exitedEarly === null; i += 1) await new Promise((r) => setTimeout(r, 100))
const diedAfterUrl = exitedEarly !== null
const died = exitedEarly
await stop()

process.stdout.write(`verify-boot: boot exit      : ${diedAfterUrl ? `提前退出（code ${died.code}）` : '由本守卫在 URL 出现后杀掉'}\n`)
process.stdout.write(`verify-boot: stderr bytes   : ${Buffer.byteLength(stderr)}\n`)
process.stdout.write(`verify-boot: listening url  : ${listeningUrl}\n`)

if (diedAfterUrl) {
  cleanup()
  process.stderr.write(`verify-boot: --- stderr ---\n${stderr}`)
  fail(`进程在打印 URL 后立刻退出（code ${died.code}）—— 它压根没在服务。`, 1)
}

if (stderr.length > 0) {
  cleanup()
  process.stderr.write(`verify-boot: --- stderr ---\n${stderr}`)
  fail(`stderr 不为空（${Buffer.byteLength(stderr)} 字节）—— 会抱怨的启动不算干净的启动。`, 1)
}

cleanup()
process.stdout.write('verify-boot: PASS\n')
