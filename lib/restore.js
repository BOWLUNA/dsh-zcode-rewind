import { promises as fsp } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashOf } from './store.js';
import { unifiedDiff } from './diffline.js';
import { safeRel, fmtTime, shortId } from './util.js';

/**
 * 恢复语义(两种模式,都是「计划 -> 预览 -> 应用」三段):
 *
 *  asof <recordId>  把工作区回到「该记录完成那一刻」的状态:
 *                   沿 ledger 顺序折叠出该时点每个路径的内容 hash,再对当前状态求差。
 *  revert <recordId> 只抵消该记录自身的增量(op=M 写回 prev;A 删除;D 还原)。
 *
 * 任何应用动作之前,先把受影响路径的「当前状态」整体存成 rescue 记录——
 * 所以恢复本身永远可撤销(rewind_undo = asof 恢复到 rescue 记录),
 * 这是对计划验收标准第 2 条「回滚本身可回滚」的直接实现。
 */

export function targetRecord(records, target) {
  if (target === 'last') {
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.k === 'mutation' || r.k === 'manual' || r.k === 'baseline') return r;
    }
    return null;
  }
  return records.find((r) => r.id === target || r.id.startsWith(target)) ?? null;
}

/**
 * 折叠出 asOf 记录时点的状态。
 * 返回 { state: Map<path, hash|null>, unknown: Set<path> }:
 *   state  —— target 时点每个路径的内容 hash;null 表示「target 时不存在(可删除)」
 *   unknown —— 内容未知(密钥/超限/未捕获就消失)的路径。这些路径既不能写也不能删:
 *              把 h:null 折叠成「不存在」会让恢复计划误删现存的 .env,是数据安全事故。
 */
export function stateAsOf(records, asofId) {
  const idx = records.findIndex((r) => r.id === asofId);
  if (idx < 0) return null;
  const state = new Map();
  const unknown = new Set();

  // 任何记录里标记过 secret/tooBig 的路径,内容永远视为未知
  for (const r of records) {
    for (const [p, c] of Object.entries(r.changes ?? {})) {
      if (c.secret || c.tooBig) unknown.add(p);
    }
  }

  // ≤ target:正常折叠(target 时点状态)
  for (let i = 0; i <= idx; i++) {
    for (const [p, c] of Object.entries(records[i].changes ?? {})) {
      if (unknown.has(p)) continue;
      if (c.h === null && c.op !== 'D') continue; // 内容未知,不能当「不存在」
      state.set(p, c.h ?? null);
    }
  }

  // > target:只有「target 后首次出现即新建」的路径能推出「target 时不存在」;
  // 首次出现是 M/D 说明它更早就存在,只是内容未捕获 → unknown。
  for (let i = idx + 1; i < records.length; i++) {
    for (const [p, c] of Object.entries(records[i].changes ?? {})) {
      if (state.has(p) || unknown.has(p)) continue;
      if (c.op === 'A' && c.h !== null) state.set(p, null);
      else unknown.add(p);
    }
  }
  return { state, unknown };
}

/** paths 过滤:精确路径,或以 '/' 结尾的目录前缀。 */
export function pathFilter(paths) {
  if (!paths || paths.length === 0) return () => true;
  const exact = new Set(paths.filter((p) => !p.endsWith('/')));
  const prefixes = paths.filter((p) => p.endsWith('/'));
  return (rel) => {
    if (exact.has(rel)) return true;
    for (const pre of prefixes) if (rel.startsWith(pre)) return true;
    return false;
  };
}

async function readIfRegular(abs) {
  const st = await lstat(abs).catch(() => null);
  if (!st) return { present: false };
  if (st.isSymbolicLink()) return { present: true, symlink: true };
  if (!st.isFile()) return { present: true, notFile: true };
  const buf = await fsp.readFile(abs).catch(() => null);
  return { present: true, buf, size: st.size };
}

/**
 * 生成恢复计划(纯只读,不落盘)。
 * 返回 { ok, target, mode, actions:[{rel, op, reason?}], diffs, stats, warnings }
 */
export async function planRestore({ store, root, records, target, mode, paths, diffOpts }) {
  const rec = targetRecord(records, target);
  if (!rec) return { ok: false, error: `找不到目标记录 ${target}(用 rewind_list 查看可用记录)` };

  const warnings = [];
  const want = new Map(); // rel -> hash|null
  if (mode === 'revert') {
    for (const [p, c] of Object.entries(rec.changes ?? {})) {
      // 密钥/超限文件没有存旧内容,不能按「prev=null ⇒ 删除」处理
      if (c.secret || c.tooBig) continue;
      want.set(p, c.prev ?? null);
    }
  } else {
    const folded = stateAsOf(records, rec.id);
    if (!folded) return { ok: false, error: 'ledger 里找不到该记录(可能已被裁剪)' };
    for (const [p, h] of folded.state) want.set(p, h);
    for (const p of folded.unknown) {
      // 内容未知:既不能写也不能删,只能保持现状并说明原因
      const cur0 = await readIfRegular(join(root, ...p.split('/'))).catch(() => null);
      if (cur0 && cur0.present && !cur0.symlink && !cur0.notFile) warnings.push(`保持现状(内容未捕获,无法回到该时点):${p}`);
    }
  }

  const keep = pathFilter(paths);
  const actions = [];
  const diffs = [];
  let bytesPlan = 0;

  for (const [rel, h] of want) {
    const clean = safeRel(rel);
    if (!clean) { warnings.push(`跳过非法路径:${rel}`); continue; }
    if (!keep(clean)) continue;
    const abs = join(root, ...clean.split('/'));
    const cur = await readIfRegular(abs);
    if (cur.symlink) { warnings.push(`跳过符号链接:${clean}`); continue; }
    if (cur.notFile) { warnings.push(`跳过非普通文件:${clean}`); continue; }

    if (h === null) {
      if (!cur.present) continue;
      actions.push({ rel: clean, op: 'delete' });
      diffs.push({ rel: clean, before: cur.buf ?? null, after: null });
      continue;
    }
    const wantBuf = await store.getBlob(h);
    if (!wantBuf) { warnings.push(`内容缺失(blob 被淘汰或未捕获):${clean}(该路径将保持现状)`); continue; }
    if (cur.present && cur.buf && hashOf(cur.buf) === h) continue; // 已是目标状态
    if (cur.present && cur.buf && wantBuf.equals(cur.buf)) continue;
    actions.push({ rel: clean, op: cur.present ? 'write' : 'create', hash: h });
    bytesPlan += wantBuf.length;
    diffs.push({ rel: clean, before: cur.present ? cur.buf : null, after: wantBuf });
  }

  const diffTexts = [];
  let diffChars = 0;
  const MAX_DIFF_CHARS = 60000;
  for (const d of diffs) {
    const t = unifiedDiff({ relPath: d.rel, before: d.before, after: d.after, ...diffOpts });
    if (diffChars < MAX_DIFF_CHARS) { diffTexts.push(t); diffChars += t.length; }
    else { diffTexts.push(`(还有 ${diffs.length - diffTexts.length} 个文件的差异未显示,用 paths 参数缩小范围)`); break; }
  }

  return {
    ok: true,
    target: rec.id,
    targetShort: shortId(rec.id),
    mode,
    when: fmtTime(rec.ts),
    tool: rec.tool ?? rec.k,
    actions,
    create: actions.filter((a) => a.op === 'create').length,
    write: actions.filter((a) => a.op === 'write').length,
    remove: actions.filter((a) => a.op === 'delete').length,
    bytesPlan,
    warnings,
    diff: diffTexts.join('\n'),
  };
}

/**
 * 应用恢复。先落 rescue 记录(受影响路径的当前状态),再执行,再落 restore 记录。
 */
export async function applyRestore({ store, root, plan, sid, note }) {
  if (!plan.ok) throw new Error(plan.error);
  if (plan.actions.length === 0) return { ok: true, noop: true, message: '工作区已处于目标状态,无需变更' };

  // 1) rescue:把受影响路径的当前内容(或不存在)记录成可恢复状态
  const rescueChanges = {};
  let rescueMissing = 0;
  for (const a of plan.actions) {
    const abs = join(root, ...a.rel.split('/'));
    const cur = await readIfRegular(abs);
    if (cur.symlink || cur.notFile) { rescueMissing++; continue; }
    if (!cur.present) { rescueChanges[a.rel] = { op: 'D', h: null, prev: null }; continue; }
    const h = await store.putBlob(cur.buf);
    rescueChanges[a.rel] = { op: cur.present && a.op === 'delete' ? 'A' : 'M', h, s: cur.size, m: Date.now(), prev: null };
  }
  const rescue = {
    k: 'restore', id: `rescue-${plan.targetShort}-${Date.now().toString(36)}`,
    ts: Date.now(), sid, cwd: root, tool: 'workspace-rewind', callId: null,
    target: `rescue-of:${plan.target}`, mode: plan.mode,
    changes: rescueChanges, note: note ?? `恢复前的自动保护快照(target=${plan.targetShort})`,
  };
  await store.append(rescue);

  // 2) 执行
  const applied = []; const skipped = [];
  for (const a of plan.actions) {
    const abs = join(root, ...a.rel.split('/'));
    try {
      if (a.op === 'delete') {
        const st = await lstat(abs).catch(() => null);
        if (st && st.isFile()) await fsp.rm(abs, { force: true });
        else if (st) { skipped.push(`${a.rel}: 现在不是普通文件,未删除`); continue; }
      } else {
        const buf = await store.getBlob(a.hash);
        if (!buf) { skipped.push(`${a.rel}: blob 缺失`); continue; }
        await fsp.mkdir(dirname(abs), { recursive: true });
        await fsp.writeFile(abs, buf);
        const check = await fsp.readFile(abs);
        if (hashOf(check) !== a.hash) { skipped.push(`${a.rel}: 写入后校验失败`); continue; }
      }
      applied.push(a.rel);
    } catch (e) {
      skipped.push(`${a.rel}: ${e?.message ?? e}`);
    }
  }

  // 3) restore 记录(记录这次恢复动了什么;它的 rescueId 指向上面的保护快照)
  const changes = {};
  for (const a of plan.actions) {
    const isDelete = a.op === 'delete';
    changes[a.rel] = { op: isDelete ? 'D' : 'M', h: isDelete ? null : a.hash, s: null, m: Date.now(), prev: null };
  }
  const rec = {
    k: 'restore', id: `restore-${plan.targetShort}-${Date.now().toString(36)}`,
    ts: Date.now(), sid, cwd: root, tool: 'workspace-rewind', callId: null,
    target: plan.target, mode: plan.mode, rescueId: rescue.id,
    changes, note: note ?? null,
    applied: applied.length, skipped,
  };
  await store.append(rec);
  return { ok: true, applied, skipped, rescueId: rescue.id, id: rec.id, rescueMissing };
}
