import { createHash } from 'node:crypto';

export const name = 'workspace-rewind';

/**
 * 捕获模式:
 *  - 'all'       所有未列入 readOnlyTools 的工具调用前后都做指纹差分(含 bash/pwsh 副作用)
 *  - 'fileTools' 只盯参数里带文件路径的写类工具(write/edit)
 *  - 'off'       关闭自动捕获,只保留手动 checkpoint
 */
export const CAPTURE_MODES = ['all', 'fileTools', 'off'];

/** base 层已核实的只读工具名(2026-09-21,见 docs/DESIGN.md 附录A)。 */
export const DEFAULT_READ_ONLY = [
  'read', 'read_image', 'glob', 'grep', 'web_fetch', 'web_search',
  'job_list', 'job_output', 'get_goal', 'create_goal', 'update_goal', 'todo_write',
];

export const DEFAULT_EXCLUDES = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build',
  'target', '.next', '.cache', '.dsh-recall-snapshots', 'rewind-snapshots',
  '.workbuddy', '.pnpm-store', 'coverage', '.idea', '.vscode-server',
];

/** 命中这些名字的文件只记事件、不存内容(防密钥进快照库)。 */
export const DEFAULT_SECRET_NAMES = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '.credentials.yaml', '*.p12', '*.pfx'];

export const DEFAULTS = {
  capture: 'all',
  readOnlyTools: DEFAULT_READ_ONLY,
  excludes: DEFAULT_EXCLUDES,
  secretNames: DEFAULT_SECRET_NAMES,
  /** 单文件内容上限,超过只记事件不存内容 */
  maxFileBytes: 8 * 1024 * 1024,
  /** 单次指纹遍历的文件数上限,超过标记 partial */
  maxFiles: 20000,
  /** 遍历时间预算(ms),超过标记 partial */
  walkBudgetMs: 4000,
  /** 快照库总字节配额,超出按最旧未引用 blob 淘汰 */
  maxTotalBytes: 512 * 1024 * 1024,
  /** ledger 保留记录数 */
  keepRecords: 500,
  /** 行级 diff 的单文件上限 */
  diffMaxBytes: 512 * 1024,
  /** diff 上下文行数 */
  diffContext: 3,
  /** 列表默认返回条数 */
  listLimit: 20,
};

const DIR_SUFFIX = /\//;

/** 排除规则:目录段名('node_modules')或通配后缀('*.log')。 */
export function makeExcluder(excludes) {
  const segs = new Set();
  const pats = [];
  for (const raw of excludes ?? []) {
    const e = String(raw).trim().replace(/^\/+|\/+$/g, '');
    if (!e) continue;
    if (e.includes('*') || e.includes('?')) pats.push(globToRegex(e));
    else segs.add(e.toLowerCase());
  }
  return (relPath) => {
    const parts = relPath.split('/');
    for (let i = 0; i < parts.length - 1; i++) if (segs.has(parts[i].toLowerCase())) return true;
    const base = parts[parts.length - 1].toLowerCase();
    if (segs.has(base)) return true;
    for (const re of pats) if (re.test(base)) return true;
    return false;
  };
}

function globToRegex(g) {
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`, 'i');
}

const SECRET_CACHE = new Map();
export function isSecretPath(relPath, secretNames) {
  let m = SECRET_CACHE.get(secretNames);
  if (!m) { m = secretNames.map(globToRegex); SECRET_CACHE.set(secretNames, m); }
  const base = relPath.split('/').pop();
  return m.some((re) => re.test(base));
}

export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function shortId(id) { return String(id ?? '').slice(0, 12); }

/**
 * 相对路径安全校验:拒绝绝对路径、.. 穿越、反斜杠、盘符。
 * 返回规范化(正斜杠、去尾部斜杠)的相对路径,非法返回 null。
 */
export function safeRel(p) {
  if (typeof p !== 'string' || p === '') return null;
  if (p.includes('\\') || p.includes('\0')) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const norm = p.replace(/\/+/g, '/').replace(/\/+$/, '');
  if (norm === '' || norm === '.') return null;
  for (const seg of norm.split('/')) if (seg === '..' || seg === '') return null;
  return norm;
}
