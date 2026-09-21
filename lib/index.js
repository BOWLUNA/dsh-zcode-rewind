import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';
import { CaptureEngine } from './capture.js';
import { planRestore, applyRestore, targetRecord } from './restore.js';
import { DEFAULTS, fmtBytes, fmtTime, shortId } from './util.js';

export const name = 'workspace-rewind';
/** Cordis 注入契约:缺了它,任何 ctx.<service> 访问都会被加载器拒绝
 *  (实测报错:cannot get property "tools" without inject)。 */
export const inject = ['tools', 'systemPrompt'];

/**
 * peer 依赖解析(多锚点,任一成功即止):
 *  1) 插件自身位置 —— 正常经 `dsh plugin add` 装进 profile 时,peer 已 hoist 到
 *     profile node_modules,向上解析即可命中;
 *  2) DSH_ROOT 环境变量 —— junction/link 挂载源码目录时手动指到 dsh 安装根;
 *  3) process.execPath 推导 —— dsh 以全局 npm 包装在 <prefix>/lib/node_modules 时,
 *     从 node 二进制位置反推(dsh 官方发行布局)。
 * 全部失败时降级:捕获钩子照常工作,只跳过工具注册,绝不抛错炸掉插件树。
 */
function buildResolver() {
  const anchors = [createRequire(import.meta.url)];
  if (process.env.DSH_ROOT) {
    try { anchors.push(createRequire(join(process.env.DSH_ROOT, 'package.json'))); } catch { /* ignore */ }
  }
  try {
    const dshPkg = join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    anchors.push(createRequire(dshPkg));
  } catch { /* ignore */ }
  for (const req of anchors) {
    try { if (req.resolve('@deepseek-ai/dsh-tools')) return req; } catch { /* try next */ }
  }
  return null;
}

async function loadPeerFn(req, pkgName, exportName) {
  if (!req) return null;
  try {
    const mod = req(pkgName);
    const v = mod?.[exportName] ?? mod?.default?.[exportName];
    if (v) return v;
  } catch { /* fallthrough */ }
  try {
    const mod = await import(pathToFileURL(req.resolve(pkgName)).href);
    return mod?.[exportName] ?? mod?.default?.[exportName] ?? null;
  } catch { return null; }
}

async function loadPeers() {
  const req = buildResolver();
  const out = {
    defineTool: await loadPeerFn(req, '@deepseek-ai/dsh-tools', 'defineTool'),
    resolveDshHome: await loadPeerFn(req, '@deepseek-ai/dsh-home-paths', 'resolveDshHome'),
    z: null,
  };
  try { if (req) { const m = req('@deepseek-ai/schemastery'); out.z = m?.default ?? m; } } catch { out.z = null; }
  if (!out.defineTool) console.warn('[workspace-rewind] @deepseek-ai/dsh-tools 不可达:工具注册跳过(捕获钩子仍工作)。修复:用 `dsh plugin add` 安装,或设 DSH_ROOT 指向 dsh 安装根');
  if (!out.resolveDshHome) console.warn('[workspace-rewind] @deepseek-ai/dsh-home-paths 不可达:快照库退回 DSH_HOME/家目录推断');
  return out;
}

function resolveDshHomeFallback() {
  return process.env.DSH_HOME || process.env.DSH_LAB_HOME || join(homedir(), '.dsh');
}

function resolveConfig(config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!['all', 'fileTools', 'off'].includes(cfg.capture)) cfg.capture = 'all';
  if (!Array.isArray(cfg.readOnlyTools) || cfg.readOnlyTools.length === 0) cfg.readOnlyTools = DEFAULTS.readOnlyTools;
  if (!Array.isArray(cfg.excludes) || cfg.excludes.length === 0) cfg.excludes = DEFAULTS.excludes;
  if (!Array.isArray(cfg.secretNames) || cfg.secretNames.length === 0) cfg.secretNames = DEFAULTS.secretNames;
  cfg.maxFileBytes = Number(cfg.maxFileBytes) || DEFAULTS.maxFileBytes;
  cfg.maxFiles = Number(cfg.maxFiles) || DEFAULTS.maxFiles;
  cfg.walkBudgetMs = Number(cfg.walkBudgetMs) || DEFAULTS.walkBudgetMs;
  cfg.maxTotalBytes = Number(cfg.maxTotalBytes) || DEFAULTS.maxTotalBytes;
  cfg.keepRecords = Number(cfg.keepRecords) || DEFAULTS.keepRecords;
  cfg.diffMaxBytes = Number(cfg.diffMaxBytes) || DEFAULTS.diffMaxBytes;
  cfg.diffContext = Number(cfg.diffContext) || DEFAULTS.diffContext;
  cfg.listLimit = Number(cfg.listLimit) || DEFAULTS.listLimit;
  return cfg;
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const SYSTEM_PROMPT_SECTION = `## Workspace rewind / checkpoints (workspace-rewind)
本插件把每次会改动工作区的工具调用(bash/pwsh/write/edit/MCP/子代理)前后的文件差异记录成检查点。两种恢复语义,别混:
- **mode=revert**:「撤销那条记录造成的改动」。用户说"撤销刚才的改动/这次搞砸了/把刚才那个 rm 撤回" → 找到**干坏事的那个操作**的记录,target=它的 id,mode=revert。这是最常用的。
- **mode=asof**:「回到那条记录完成时的整体状态」。用户说"回到 X 之前的状态/回到早上的版本" → target=想回到的那条记录。
流程:rewind_list 找记录 → rewind_diff 预览行级 diff → rewind_restore apply=true 执行(默认 dry_run,真正应用必须显式 apply=true)。
任何恢复前都会自动生成 rescue 保护快照;恢复错了用 rewind_undo 撤销(可反复,等价 undo/redo)。
大胆做事:破坏性操作(bash rm/mv、批量重构)之前不必请示——所有变更都可回退。但恢复动作要向用户复述计划再执行。
.env/*.pem 等密钥文件只记录"被改过"这一事实,内容不入库;超过大小上限的文件同样只记事件。`;

export function apply(ctx, config = {}) {
  const peers = _peers; // 模块顶层已解析(见文件底部)
  const cfg = resolveConfig(config);

  let home;
  try { home = peers.resolveDshHome ? peers.resolveDshHome() : resolveDshHomeFallback(); }
  catch { home = resolveDshHomeFallback(); }
  const store = new Store(join(home, 'workspace-rewind'), { maxTotalBytes: cfg.maxTotalBytes, keepRecords: cfg.keepRecords });
  const engine = new CaptureEngine({ store, cfg, log: (m) => ctx.logger.warn(`[workspace-rewind] ${m}`) });

  // 恢复动作全局串行,防止两个会话同时 restore 互相踩
  let restoreLock = Promise.resolve();
  const withLock = (fn) => {
    const run = restoreLock.then(fn, fn);
    restoreLock = run.catch(() => {});
    return run;
  };

  const recordsFor = async (cwd) => {
    const all = await store.records();
    return all.filter((r) => r.cwd === cwd);
  };

  const registered = new Set();
  const registerToolOnce = (tool) => {
    if (!peers.defineTool) return;
    if (registered.has(tool.name)) { ctx.logger.warn(`[workspace-rewind] 工具 ${tool.name} 重复注册,跳过`); return; }
    try {
      const dispose = ctx.tools.register(tool);
      registered.add(tool.name);
      return dispose ?? undefined;
    } catch (e) {
      if (/already registered/i.test(String(e?.message ?? e))) {
        ctx.logger.warn(`[workspace-rewind] 工具 ${tool.name} 已被注册(重复挂载),降级跳过`);
        registered.add(tool.name);
        return undefined;
      }
      throw e;
    }
  };

  // ── 捕获钩子(与 dsh-rewind 同款接线:fs 服务域上的 tools/* 事件) ──
  ctx.inject(['fs'], (scope) => {
    scope.on('tools/execute', async (exec, next) => {
      try { await engine.before(exec, exec.agent?.session); }
      catch (e) { ctx.logger.warn(`[workspace-rewind] before-capture 失败: ${e?.message ?? e}`); }
      return next();
    });
    scope.on('tools/post-execute', async (exec, result, next) => {
      try { await engine.after(exec, exec.agent?.session); }
      catch (e) { ctx.logger.warn(`[workspace-rewind] post-capture 失败: ${e?.message ?? e}`); }
      return next();
    });
    scope.on('tools/result', (exec) => {
      try { engine.aborted(exec, exec.agent?.session); } catch { /* ignore */ }
      return undefined;
    });
  });

  // ── 工具 ──
  {
    registerToolOnce(peers.defineTool({
      name: 'rewind_now',
      description: '立即为当前工作区创建一个检查点(记录与上次检查点的文件差异,含内容)。适合在「即将做危险操作」前手动打点。',
      parameters: { note: { type: 'string', description: '检查点备注(可选)' } },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 120_000,
      execute: async (args, exec) => {
        const rec = await engine.checkpointNow(exec.agent?.session, args?.note);
        const n = Object.keys(rec.changes).length;
        return `检查点 ${rec.id} 已创建:${n} 个路径入档,${rec.stats.stored} 个文件内容入库(${fmtBytes(rec.stats.storedBytes)})${rec.partial ? ';⚠️ 遍历超限,记录标记 partial' : ''}`;
      },
    }), 'rewind_now');
  }

  {
    registerToolOnce(peers.defineTool({
      name: 'rewind_list',
      description: '列出当前工作区最近的检查点/变更记录(新→旧),含每次变更加了/改了/删了哪些文件。用于选择回退目标。',
      parameters: { limit: { type: 'number', description: '返回条数(默认 20)' } },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const session = exec.agent?.session;
        const cwd = session?.header?.cwd;
        if (!cwd) return '当前会话没有工作区。';
        const recs = (await recordsFor(cwd)).slice().reverse().slice(0, Math.max(1, Math.min(100, Number(args?.limit) || cfg.listLimit)));
        if (recs.length === 0) return '还没有任何记录。做一次会改动文件的操作后再来。';
        const rows = recs.map((r) => {
          const c = Object.entries(r.changes ?? {});
          const a = c.filter(([, v]) => v.op === 'A').length, m = c.filter(([, v]) => v.op === 'M').length, d = c.filter(([, v]) => v.op === 'D').length;
          const files = c.slice(0, 4).map(([p]) => p).join(', ');
          const more = c.length > 4 ? ` 等${c.length}个` : '';
          const flag = r.partial ? ' [partial]' : '';
          return `${r.id}  ${fmtTime(r.ts)}  ${r.k}${r.tool ? `/${r.tool}` : ''}${flag}  +${a} ~${m} -${d}  ${files}${more}${r.note ? `  #${r.note}` : ''}`;
        });
        return `记录(新→旧,工作区 ${cwd}):\n${rows.join('\n')}`;
      },
    }), 'rewind_list');
  }

  {
    registerToolOnce(peers.defineTool({
      name: 'rewind_diff',
      description: '预览恢复计划与行级 diff(不改动任何文件):回到 target 记录时点的文件状态(asof)或只抵消该记录的增量(revert)。',
      parameters: {
        target: { type: 'string', required: true, description: 'rewind_list 里的记录 id,或 last(最近一条)' },
        mode: { type: 'string', description: 'asof(默认,回到该时点) | revert(只撤销该记录)' },
        paths: { type: 'array', items: { type: 'string' }, description: '只看这些路径(精确路径或以 / 结尾的目录前缀);缺省为全部' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const cwd = exec.agent?.session?.header?.cwd;
        if (!cwd) return '当前会话没有工作区。';
        const plan = await planRestore({
          store, root: cwd, records: await recordsFor(cwd),
          target: args.target, mode: args.mode === 'revert' ? 'revert' : 'asof',
          paths: Array.isArray(args.paths) ? args.paths : [],
          diffOpts: { context: cfg.diffContext, maxBytes: cfg.diffMaxBytes },
        });
        if (!plan.ok) return `无法生成计划:${plan.error}`;
        const head = `计划(mode=${plan.mode},目标 ${plan.targetShort} @ ${plan.when},来源 ${plan.tool}):新建 ${plan.create} / 覆写 ${plan.write} / 删除 ${plan.remove},共 ${fmtBytes(plan.bytesPlan)}`;
        const warn = plan.warnings.length ? `\n⚠️ ${plan.warnings.join('\n⚠️ ')}` : '';
        return `${head}\n${plan.diff || '(没有文件需要变更)'}${plan.actions.length ? '\n(以上为预览;确认无误后用 rewind_restore apply=true 执行)' : ''}${warn}`;
      },
    }), 'rewind_diff');
  }

  {
    registerToolOnce(peers.defineTool({
      name: 'rewind_restore',
      description: '把工作区恢复到某条检查点的状态。默认 dry_run 只返回计划与行级 diff;apply=true 才真正改文件。恢复前自动生成 rescue 保护快照,恢复本身可用 rewind_undo 撤销。',
      parameters: {
        target: { type: 'string', required: true, description: 'rewind_list 里的记录 id,或 last' },
        mode: { type: 'string', description: 'asof(默认) | revert' },
        paths: { type: 'array', items: { type: 'string' }, description: '只恢复这些路径(精确路径或以 / 结尾的目录前缀)' },
        apply: { type: 'boolean', description: 'true=真正执行;缺省 false 只出预览' },
        note: { type: 'string', description: '备注(可选)' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 300_000,
      execute: async (args, exec) => {
        const cwd = exec.agent?.session?.header?.cwd;
        if (!cwd) return '当前会话没有工作区。';
        const doPlan = async () => planRestore({
          store, root: cwd, records: await recordsFor(cwd),
          target: args.target, mode: args.mode === 'revert' ? 'revert' : 'asof',
          paths: Array.isArray(args.paths) ? args.paths : [],
          diffOpts: { context: cfg.diffContext, maxBytes: cfg.diffMaxBytes },
        });
        if (!args.apply) {
          const plan = await doPlan();
          if (!plan.ok) return `无法生成计划:${plan.error}`;
          return `[dry_run] ${plan.mode} → ${plan.targetShort}:新建 ${plan.create} / 覆写 ${plan.write} / 删除 ${plan.remove}\n${plan.diff || '(没有文件需要变更)'}\n确认后加 apply=true 执行。`;
        }
        return withLock(async () => {
          const plan = await doPlan();
          if (!plan.ok) return `无法生成计划:${plan.error}`;
          const r = await applyRestore({ store, root: cwd, plan, sid: exec.agent?.session?.id ?? 'anon', note: args.note });
          if (r.noop) return r.message;
          return `已恢复(${plan.mode} → ${plan.targetShort}):应用 ${r.applied.length} 个路径${r.skipped.length ? `;跳过 ${r.skipped.length}:${r.skipped.join('; ')}` : ''}\n保护快照:${r.rescueId}(恢复错了可用 rewind_undo 撤销)`;
        });
      },
    }), 'rewind_restore');
  }

  {
    registerToolOnce(peers.defineTool({
      name: 'rewind_undo',
      description: '撤销最近一次 rewind_restore(恢复到它执行前的保护快照)。可连续调用:每次撤销本身也被保护,等价于 undo/redo 来回切换。',
      parameters: {
        apply: { type: 'boolean', description: 'true=真正执行;缺省 false 只出预览' },
      },
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => false,
      timeoutMs: 300_000,
      execute: async (args, exec) => {
        const cwd = exec.agent?.session?.header?.cwd;
        if (!cwd) return '当前会话没有工作区。';
        const recs = await recordsFor(cwd);
        let last = null;
        for (let i = recs.length - 1; i >= 0; i--) if (recs[i].k === 'restore' && recs[i].rescueId) { last = recs[i]; break; }
        if (!last) return '还没有可撤销的恢复操作。';
        const plan = await planRestore({
          store, root: cwd, records: recs, target: last.rescueId, mode: 'asof', paths: [],
          diffOpts: { context: cfg.diffContext, maxBytes: cfg.diffMaxBytes },
        });
        if (!plan.ok) return `无法生成撤销计划:${plan.error}`;
        if (!args.apply) {
          return `[dry_run] 撤销恢复 ${shortId(last.id)}(回到其保护快照 ${shortId(last.rescueId)}):新建 ${plan.create} / 覆写 ${plan.write} / 删除 ${plan.remove}\n${plan.diff || '(没有文件需要变更)'}\n确认后加 apply=true 执行。`;
        }
        return withLock(async () => {
          const r = await applyRestore({ store, root: cwd, plan, sid: exec.agent?.session?.id ?? 'anon', note: `撤销恢复 ${shortId(last.id)}` });
          if (r.noop) return r.message;
          return `已撤销恢复 ${shortId(last.id)}:应用 ${r.applied.length} 个路径${r.skipped.length ? `;跳过:${r.skipped.join('; ')}` : ''}\n本次撤销的保护快照:${r.rescueId}(再执行 rewind_undo 可重做)`;
        });
      },
    }), 'rewind_undo');
  }

  {
    registerToolOnce(peers.defineTool({
      name: 'rewind_status',
      description: '查看快照库状态:记录数、blob 数与占用、配额、当前捕获配置。',
      parameters: {},
      output: TEXT_OUTPUT,
      isConcurrencySafe: () => true,
      execute: async () => {
        const s = await store.stats();
        return [
          `快照库:${s.root}`,
          `记录:${s.records}(${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(', ') || '空'})`,
          `blob:${s.blobCount} 个,占用 ${s.blobBytesFmt} / 配额 ${s.quotaFmt}(被引用 ${s.referenced} 个)`,
          `捕获:capture=${cfg.capture},maxFileBytes=${fmtBytes(cfg.maxFileBytes)},maxFiles=${cfg.maxFiles},excludes=${cfg.excludes.length} 条,secretNames=${cfg.secretNames.length} 条`,
        ].join('\n');
      },
    }), 'rewind_status');
  }

  // ── system prompt 指引 ──
  try { ctx.systemPrompt?.section?.({ name: 'workspace-rewind', order: 118, text: SYSTEM_PROMPT_SECTION }); }
  catch (e) { ctx.logger.warn(`[workspace-rewind] systemPrompt 注入失败(降级): ${e?.message ?? e}`); }

  ctx.logger.info?.(`[workspace-rewind] 已装配:capture=${cfg.capture},库=${store.root}`);
}

// ── 模块顶层:peer 解析一次,apply 保持同步(与 dsh-rewind / dsh-undo-savepoint 同款约束) ──
const _peers = await loadPeers();

/** 行内 config 校验(schema 可用才导出;不可用时按 cordis.patch.yml 配置原样透传)。 */
export function makeConfig(z) {
  if (!z || typeof z.object !== 'function') return undefined;
  try {
    return z.object({
      capture: z.string().default('all'),
      readOnlyTools: z.array(z.string()).default([...DEFAULTS.readOnlyTools]),
      excludes: z.array(z.string()).default([...DEFAULTS.excludes]),
      secretNames: z.array(z.string()).default([...DEFAULTS.secretNames]),
      maxFileBytes: z.number().default(DEFAULTS.maxFileBytes),
      maxFiles: z.number().default(DEFAULTS.maxFiles),
      walkBudgetMs: z.number().default(DEFAULTS.walkBudgetMs),
      maxTotalBytes: z.number().default(DEFAULTS.maxTotalBytes),
      keepRecords: z.number().default(DEFAULTS.keepRecords),
      diffMaxBytes: z.number().default(DEFAULTS.diffMaxBytes),
      diffContext: z.number().default(DEFAULTS.diffContext),
      listLimit: z.number().default(DEFAULTS.listLimit),
      baseline: z.string().default('first'),
    });
  } catch { return undefined; }
}
export const Config = makeConfig(_peers.z);
