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

  /** 配额 GC:总字节超限时按 mtime 从旧到新删未引用 blob。返回删除数与释放字节。 */
  async gc() {
    const refs = await this.referencedHashes();
    let entries = [];
    try { entries = await fsp.readdir(this.blobDir, { withFileTypes: true }); } catch { return { removed: 0, freed: 0 }; }
    const files = [];
    for (const d of entries) {
      if (!d.isDirectory() || !/^[0-9a-f]{2}$/.test(d.name)) continue;
      const dir = join(this.blobDir, d.name);
      for (const f of await fsp.readdir(dir).catch(() => [])) {
        if (!/^[0-9a-f]{64}$/.test(f)) continue;
        if (refs.has(f)) continue;
        const p = join(dir, f);
        const st = await fsp.stat(p).catch(() => null);
        if (st) files.push({ p, size: st.size, m: st.mtimeMs });
      }
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    let used = total;
    let removed = 0, freed = 0;
    files.sort((a, b) => a.m - b.m);
    for (const f of files) {
      if (used <= this.maxTotalBytes) break;
      await fsp.rm(f.p, { force: true });
      used -= f.size; removed++; freed += f.size;
    }
    // ledger 裁剪:超过 keepRecords 时整体重写(保留尾部)
    const recs = await this.records();
    if (recs.length > this.keepRecords * 1.25) {
      const kept = recs.slice(-this.keepRecords);
      const keptRefs = new Set();
      for (const r of kept) for (const c of Object.values(r.changes ?? {})) { if (c.h) keptRefs.add(c.h); if (c.prev) keptRefs.add(c.prev); }
      const tmp = `${this.ledgerPath}.tmp-${Date.now()}`;
      await fsp.writeFile(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
      await fsp.rename(tmp, this.ledgerPath);
      this._records = kept;
    }
    return { removed, freed, usedAfter: used, quota: this.maxTotalBytes };
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
