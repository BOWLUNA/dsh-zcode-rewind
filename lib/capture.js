import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { fingerprint, diffFingerprints, joinAbs } from './fingerprint.js';
import { hashOf, newId } from './store.js';
import { isSecretPath, fmtBytes } from './util.js';

/**
 * 捕获引擎:围绕每次工具调用做「工作区指纹差分」。
 *
 * 与逐文件备份(rewind-plugin 只盯 write/edit 的 args.file_path)和整仓 shadow-git
 * commit(Cline,官方自认大仓库慢)不同,这里每 capture 只做一次 O(files) 的
 * stat 遍历 + 只对差分命中的文件读内容——bash/pwsh/MCP/子代理造成的任意文件
 * 变更都会被看到,而成本与仓库大小只差一次 stat 遍历。
 *
 * 会话内维护滚动状态:lastKnown(指纹)与 stateHashes(内容 hash),
 * prev 哈希来自滚动状态;所以首次 capture 默认先打 baseline(全量入库,
 * 跨会话按内容寻址去重,第二次会话基本只花哈希时间)。
 */
export class CaptureEngine {
  constructor({ store, cfg, log }) {
    this.store = store;          // 全局 Store;记录里带 cwd,恢复按 cwd 过滤
    this.cfg = cfg;
    this.log = log ?? (() => {});
    this.bySession = new WeakMap(); // session -> {sid, cwd, lastKnown:Map, stateHashes:Map, pending:Map, baselined}
    this.lastGc = 0;
    this._capLock = Promise.resolve(); // 捕获串行化:防止钩子捕获与手动检查点并发时对同一 lastKnown 双重差分
  }

  stateFor(session) {
    let s = this.bySession.get(session);
    if (!s) {
      s = { sid: session?.id ?? 'anon', cwd: session?.header?.cwd ?? null, lastKnown: null, stateHashes: new Map(), pending: new Map(), baselined: false };
      this.bySession.set(session, s);
    }
    if (!s.cwd && session?.header?.cwd) s.cwd = session.header.cwd;
    return s;
  }

  isReadOnly(tool) {
    return this.cfg.readOnlyTools.includes(tool) || tool.startsWith('rewind_');
  }

  shouldCapture(exec, session) {
    if (this.cfg.capture === 'off') return false;
    const mode = this.cfg.capture;
    if (mode === 'fileTools') return exec.name === 'write' || exec.name === 'edit';
    return !this.isReadOnly(exec.name);
  }

  isSubagent(session) {
    const h = session?.header;
    return h?.origin === 'subagent' || (h?.delegationDepth ?? 0) > 0;
  }

  async before(exec, session) {
    if (!session || this.isSubagent(session)) return;
    if (!this.shouldCapture(exec, session)) return;
    const s = this.stateFor(session);
    if (!s.cwd) return;
    if (!s.baselined) {
      try { await this.ensureBaseline(s); } catch (e) { this.log(`baseline failed: ${e?.message ?? e}`); }
    }
    const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`;
    let argsDigest = '';
    try { argsDigest = JSON.stringify(exec.arguments ?? {}).slice(0, 2000); } catch { argsDigest = '(unserializable)'; }
    s.pending.set(key, { tool: exec.name, callId: exec.callId, argsDigest, ts: Date.now() });
  }

  async after(exec, session) {
    if (!session || this.isSubagent(session)) return;
    const s = this.stateFor(session);
    const key = `${exec.agent?.id ?? 'anon'}:${exec.callId}`;
    const pending = s.pending.get(key);
    s.pending.delete(key);
    if (!pending || !s.cwd) return;
    try {
      const run = this._capLock.then(() => this.capture(s, pending));
      this._capLock = run.catch(() => {});
      await run;
    } catch (e) {
      this.log(`capture failed for ${pending.tool}: ${e?.message ?? e}`);
    }
  }

  aborted(exec, session) {
    if (!session) return;
    const s = this.stateFor(session);
    s.pending.delete(`${exec.agent?.id ?? 'anon'}:${exec.callId}`);
  }

  /** 手动检查点(rewind_now):把当前状态与滚动状态的差分记为 manual 记录。 */
  async checkpointNow(session, note) {
    const s = this.stateFor(session);
    if (!s?.cwd) throw new Error('当前会话没有工作区(cwd),无法建检查点');
    const run = this._capLock.then(() => this.capture(s, { tool: 'manual', callId: null, argsDigest: '', ts: Date.now() }, { kind: 'manual', note: note ?? '手动检查点' }));
    this._capLock = run.catch(() => {});
    return run;
  }

  async ensureBaseline(s) {
    if (s.baselined || this.cfg.baseline === 'off') return;
    s.baselined = true; // 先置位防重入:基线失败也不重试风暴,有日志可查
    const run = this._capLock.then(() => this.capture(s, { tool: 'baseline', callId: null, argsDigest: '', ts: Date.now() }, { kind: 'baseline', note: '会话首次捕获基线' }));
    this._capLock = run.catch(() => {});
    return run;
  }

  async capture(s, pending, { kind = 'mutation', note = null } = {}) {
    const { map, truncated, skippedLinks } = await fingerprint(s.cwd, {
      excludes: this.cfg.excludes, maxFiles: this.cfg.maxFiles, walkBudgetMs: this.cfg.walkBudgetMs,
    });
    const isFirst = !s.lastKnown;
    const diff = isFirst
      ? new Map([...map.entries()].filter(([, b]) => b.t === 'f').map(([p, b]) => [p, { op: 'A' }]))
      : diffFingerprints(s.lastKnown, map);

    const changes = {};
    let stored = 0, storedBytes = 0, secrets = 0, tooBig = 0;
    for (const [rel, d] of diff) {
      if (d.op === 'D') {
        changes[rel] = { op: 'D', h: null, s: null, m: null, prev: s.stateHashes.get(rel) ?? null };
        s.stateHashes.set(rel, null);
        continue;
      }
      const abs = joinAbs(s.cwd, rel);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (isSecretPath(rel, this.cfg.secretNames)) {
        secrets++;
        changes[rel] = { op: d.op === 'A' ? 'A' : 'M', h: null, s: st.size, m: st.mtimeMs, prev: null, secret: true };
        s.stateHashes.set(rel, null);
        continue;
      }
      if (st.size > this.cfg.maxFileBytes) {
        tooBig++;
        changes[rel] = { op: d.op === 'A' ? 'A' : 'M', h: null, s: st.size, m: st.mtimeMs, prev: null, tooBig: true };
        s.stateHashes.set(rel, null);
        continue;
      }
      const buf = await fsp.readFile(abs).catch(() => null);
      if (!buf) continue;
      const h = await this.store.putBlob(buf);
      changes[rel] = { op: d.op === 'A' ? 'A' : 'M', h, s: st.size, m: st.mtimeMs, prev: s.stateHashes.get(rel) ?? null };
      s.stateHashes.set(rel, h);
      stored++; storedBytes += buf.length;
    }

    const record = {
      k: kind, id: newId(kind === 'mutation' ? 'cp' : kind), ts: Date.now(), sid: s.sid,
      cwd: s.cwd,
      tool: pending.tool, callId: pending.callId, argsDigest: pending.argsDigest || null,
      partial: truncated, skippedLinks, note,
      changes,
      stats: { changed: Object.keys(changes).length, stored, storedBytes, secrets, tooBig, files: map.size },
    };
    await this.store.append(record);
    s.lastKnown = map;

    // GC 最多 5 分钟一次,且只在有新内容落库后
    if (storedBytes > 0 && Date.now() - this.lastGc > 5 * 60 * 1000) {
      this.lastGc = Date.now();
      this.store.gc().then((r) => { if (r.removed > 0) this.log(`gc: removed ${r.removed} blobs, freed ${fmtBytes(r.freed)}`); }).catch(() => {});
    }
    return record;
  }
}
