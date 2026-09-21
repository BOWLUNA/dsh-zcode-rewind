import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fmtBytes } from './util.js';

/**
 * 存储布局(全部在 DSH_HOME 内、workspace 之外,绝不污染 git 状态):
 *
 *   <root>/                                  root = <DSH_HOME>/workspace-rewind/<sha256(cwd)[:16]>
 *   ├── blobs/<h[0:2]>/<sha256>              内容寻址,跨记录去重
 *   └── ledger.jsonl                         追加式记录(每行一个 JSON,崩溃安全:尾部半行被忽略)
 *
 * 记录 k: baseline | manual | mutation | restore
 *   { k, id, ts, sid, tool, callId, partial,
 *     changes: { <relPath>: { op:'A'|'M'|'D', h, s, m, prev } } }
 *     h    = 该记录完成后文件内容的 sha256(null=文件此时不存在)
 *     prev = 该记录之前文件内容的 sha256(null=之前不存在/未知)
 * restore 记录额外有: target(被恢复到的记录 id), rescueId(恢复前状态记录 id), paths
 */

export function hashOf(buf) { return createHash('sha256').update(buf).digest('hex'); }

export class Store {
  constructor(root, opts = {}) {
    this.root = root;
    this.blobDir = join(root, 'blobs');
    this.ledgerPath = join(root, 'ledger.jsonl');
    this.maxTotalBytes = opts.maxTotalBytes ?? 512 * 1024 * 1024;
    this.keepRecords = opts.keepRecords ?? 500;
    this._records = null;     // 惰性加载
    this._lock = Promise.resolve();
  }

  async ensureDirs() {
    await fsp.mkdir(this.blobDir, { recursive: true });
  }

  blobPath(h) { return join(this.blobDir, h.slice(0, 2), h); }

  async putBlob(buf) {
    const h = hashOf(buf);
    const p = this.blobPath(h);
    try { await fsp.access(p); return h; } catch { /* 不存在,写入 */ }
    await fsp.mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, p); // 原子落盘,避免半写 blob
    return h;
  }

  async getBlob(h) {
    if (!h) return null;
    try { return await fsp.readFile(this.blobPath(h)); } catch { return null; }
  }

  async hasBlob(h) {
    if (!h) return false;
    try { await fsp.access(this.blobPath(h)); return true; } catch { return false; }
  }

  /** 追加一条记录(串行化,防止并发交错写坏 JSONL)。 */
  async append(record) {
    this._lock = this._lock.then(async () => {
      await this.ensureDirs();
      await fsp.appendFile(this.ledgerPath, JSON.stringify(record) + '\n', 'utf8');
      if (this._records) this._records.push(record);
    });
    await this._lock;
    return record;
  }

  async records() {
    if (this._records) return this._records;
    let text = '';
    try { text = await fsp.readFile(this.ledgerPath, 'utf8'); } catch { this._records = []; return this._records; }
    const recs = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { recs.push(JSON.parse(t)); } catch { /* 尾部半行(崩溃残留)忽略 */ }
    }
    this._records = recs;
    return recs;
  }

  /** 所有记录引用到的 blob 集合(h + prev + rescue 链)。 */
  async referencedHashes() {
    const recs = await this.records();
    const refs = new Set();
    for (const r of recs) {
      for (const c of Object.values(r.changes ?? {})) {
        if (c.h) refs.add(c.h);
        if (c.prev) refs.add(c.prev);
      }
    }
    return refs;
  }

  /** 枚举全部 blob(供 GC / 统计使用)。 */
  async listBlobs() {
    const out = [];
    let dirs = [];
    try { dirs = await fsp.readdir(this.blobDir, { withFileTypes: true }); } catch { return out; }
    for (const d of dirs) {
      if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
      const dir = join(this.blobDir, d.name);
      for (const f of await fsp.readdir(dir).catch(() => [])) {
        if (!/^[0-9a-f]{64}$/.test(f)) continue;
        const p = join(dir, f);
        const st = await fsp.stat(p).catch(() => null);
        if (st) out.push({ p, h: f, size: st.size, m: st.mtimeMs });
      }
    }
    return out;
  }

  /**
   * 配额 GC。策略(按严重程度递进):
   *   1. 库总量 ≤ 配额 → 只清「未被任何记录引用」的孤儿 blob;
   *   2. 仍超配额 → 按最旧优先淘汰**非保护记录**(保护 = restore/rescue,
   *      它们是「回滚本身可回滚」的依据),同步从 ledger 移除;
   *   3. 只剩保护记录还超配额 → 如实报告,不删保护记录。
   * 1.0.0 修复:旧实现把配额算在「未引用字节」上,当所有 blob 都被引用时
   * 配额被完全绕过(实测 64KB 配额下库长到 932KB)。
   */
  async gc() {
    const all = await this.listBlobs();
    const quota = this.maxTotalBytes;
    let used = all.reduce((n, f) => n + f.size, 0);
    let removed = 0, freed = 0;

    // 1) 孤儿 blob(任何记录都不引用)
    let refs = await this.referencedHashes();
    const orphans = all.filter((f) => !refs.has(f.h)).sort((a, b) => a.m - b.m);
    for (const f of orphans) {
      if (used <= quota) break;
      await fsp.rm(f.p, { force: true });
      used -= f.size; removed++; freed += f.size;
    }

    // 2) 仍超配额:按最旧优先淘汰非保护记录
    let droppedRecords = 0;
    if (used > quota) {
      const recs = await this.records();
      const sizeByHash = new Map(all.map((f) => [f.h, f.size]));
      const recordBytes = (r) => {
        let n = 0;
        for (const c of Object.values(r.changes ?? {})) {
          if (c.h && sizeByHash.has(c.h)) { n += sizeByHash.get(c.h); }
          if (c.prev && sizeByHash.has(c.prev)) { n += sizeByHash.get(c.prev); }
        }
        return n;
      };
      const keep = [];
      let kept = 0; // 已保留记录的字节(粗算,重叠引用会高估 → 偏保守,安全)
      const PROTECTED = new Set(['restore']); // restore/rescue 不可淘汰
      for (let i = recs.length - 1; i >= 0; i--) {
        const r = recs[i];
        const b = recordBytes(r);
        const isProtected = PROTECTED.has(r.k) || PROTECTED.has(r.target ? 'restore' : '');
        const wouldExceed = kept + b > quota;
        if (!isProtected && wouldExceed && keep.length > 0) { droppedRecords++; continue; }
        keep.unshift(r); kept += b;
      }
      if (droppedRecords > 0) {
        const tmp = `${this.ledgerPath}.tmp-${Date.now()}`;
        await fsp.writeFile(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8');
        await fsp.rename(tmp, this.ledgerPath);
        this._records = keep;
        refs = await this.referencedHashes();
        for (const f of all) {
          if (used <= quota) break;
          if (refs.has(f.h)) continue;
          if (!(await fsp.access(f.p).then(() => true).catch(() => false))) continue;
          await fsp.rm(f.p, { force: true });
          used -= f.size; removed++; freed += f.size;
        }
      }
    }

    // 3) 纯条数上限(与配额无关的老行为,保留)
    const recs = await this.records();
    if (recs.length > this.keepRecords * 1.25) {
      const kept = recs.slice(-this.keepRecords);
      const tmp = `${this.ledgerPath}.tmp-${Date.now()}`;
      await fsp.writeFile(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      await fsp.rename(tmp, this.ledgerPath);
      this._records = kept;
    }
    return { removed, freed, droppedRecords, usedAfter: used, quota, overQuota: used > quota };
  }

  async stats() {
    const recs = await this.records();
    const refs = await this.referencedHashes();
    let blobBytes = 0, blobCount = 0;
    try {
      for (const d of await fsp.readdir(this.blobDir, { withFileTypes: true }).catch(() => [])) {
        if (!d.isDirectory()) continue;
        for (const f of await fsp.readdir(join(this.blobDir, d.name)).catch(() => [])) {
          const st = await fsp.stat(join(this.blobDir, d.name, f)).catch(() => null);
          if (st) { blobCount++; blobBytes += st.size; }
        }
      }
    } catch { /* 空 store */ }
    const byKind = {};
    for (const r of recs) byKind[r.k] = (byKind[r.k] ?? 0) + 1;
    return { root: this.root, records: recs.length, byKind, blobCount, blobBytes, blobBytesFmt: fmtBytes(blobBytes), quota: this.maxTotalBytes, quotaFmt: fmtBytes(this.maxTotalBytes), referenced: refs.size };
  }
}

export function newId(kind) {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${kind}-${t}-${r}`;
}
