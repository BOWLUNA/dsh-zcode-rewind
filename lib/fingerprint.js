import { promises as fsp } from 'node:fs';
import { join, sep } from 'node:path';
import { makeExcluder } from './util.js';

/**
 * 工作区指纹:relPath -> {s: size, m: mtimeMs, t: 'f'|'d'}
 * 只 stat 不读内容,这是本插件能扛住「每次工具调用都抓一次」的成本关键。
 * 对照:Cline 在每次工具调用后对整仓做 shadow-git commit,官方文档自认
 * 大仓库 "significant storage and slowdown";本实现只做一次 O(files) 的 stat 遍历,
 * 内容读取仅发生在差分命中的文件上。
 */
export async function fingerprint(root, opts = {}) {
  const { excludes = [], maxFiles = 20000, walkBudgetMs = 4000, signal } = opts;
  const skip = makeExcluder(excludes);
  const map = new Map();
  const deadline = Date.now() + walkBudgetMs;
  let truncated = false;
  let skippedLinks = 0;

  const walk = async (absDir, relPrefix) => {
    if (signal?.aborted) throw new Error('aborted');
    if (map.size >= maxFiles || Date.now() > deadline) { truncated = true; return; }
    let entries;
    try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
    catch { return; } // 无权限/已消失:按空目录处理
    for (const ent of entries) {
      if (map.size >= maxFiles || Date.now() > deadline) { truncated = true; return; }
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (skip(rel)) continue;
      const abs = join(absDir, ent.name);
      if (ent.isSymbolicLink()) { skippedLinks++; continue; } // 不追踪符号链接(rewind/turn-rewind 同款决策)
      if (ent.isDirectory()) {
        map.set(rel, { t: 'd', s: 0, m: 0 });
        await walk(abs, rel);
      } else if (ent.isFile()) {
        try {
          const st = await fsp.stat(abs);
          map.set(rel, { t: 'f', s: st.size, m: Math.floor(st.mtimeMs) });
        } catch { /* 竞态:文件刚消失 */ }
      }
    }
  };

  await walk(root, '');
  return { map, truncated, skippedLinks, count: map.size };
}

/**
 * 差分:from -> to 的变更集。
 * 返回 {path: {op:'A'|'M'|'D'}}(不含目录条目;目录变化由其下文件变化表达)。
 */
export function diffFingerprints(from, to) {
  const out = new Map();
  for (const [p, b] of to) {
    if (b.t !== 'f') continue;
    const a = from.get(p);
    if (!a) out.set(p, { op: 'A' });
    else if (a.t !== 'f' || a.s !== b.s || a.m !== b.m) out.set(p, { op: 'M' });
  }
  for (const [p, a] of from) {
    if (a.t !== 'f') continue;
    if (!to.get(p)) out.set(p, { op: 'D' });
  }
  return out;
}

export function joinAbs(root, rel) {
  return join(root, ...rel.split('/'));
}

export function toRel(root, abs) {
  const r = root.endsWith(sep) ? root : root + sep;
  const p = abs.startsWith(r) ? abs.slice(r.length) : null;
  return p ? p.split(sep).join('/') : null;
}
