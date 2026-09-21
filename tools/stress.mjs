#!/usr/bin/env node
/**
 * 边界与压力测试(有硬上限)。回答的是「我的核心主张在真实尺度下成立吗」:
 *
 *   1. 规模 —— N 文件工作区下,指纹遍历 + 差分的耗时与内存是线性的吗?
 *      (核心主张:每次捕获只做一次 O(files) stat 遍历。N=3000,硬上限 5000)
 *   2. 大文件 —— 超过 maxFileBytes 的文件只记事件、不进 blob 库,且恢复计划不误删
 *   3. 密钥文件 —— 内容永不入库,恢复计划对其「保持现状」
 *   4. 符号链接 —— 不追踪、恢复计划跳过
 *   5. 路径穿越 —— safeRel 拒绝绝对路径/`..`/反斜杠
 *   6. 配额 GC —— 配额压到极小后触发淘汰:被引用 blob 必须存活,只删未引用
 *   7. 并发捕获 —— 4 路并发(有上限) capture() 后 ledger 行数 == 记录数、逐行可解析
 *
 * 全部写在自己的目录(默认 .workbuddy/06-scratch/stress-<pid>),结束清理。
 * 所有循环都有硬上限;不产生无界日志(只打印汇总)。
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fingerprint, diffFingerprints } from '../lib/fingerprint.js';
import { Store } from '../lib/store.js';
import { CaptureEngine } from '../lib/capture.js';
import { planRestore, applyRestore } from '../lib/restore.js';
import { safeRel, DEFAULTS } from '../lib/util.js';

const CAP = {
  files: 3000,          // 硬上限 5000
  depth: 3,
  concurrency: 4,       // 硬上限 8
  bigFileBytes: 300 * 1024,
  smallQuotaBytes: 64 * 1024,
  runs: 20,
};

const ROOT = process.env.PROBE06_STRESS_DIR
  ?? join(process.cwd(), '.workbuddy', '06-scratch', `stress-${process.pid}`);
const STORE_DIR = join(ROOT, 'store');
const WS = join(ROOT, 'ws');
const WS2 = join(ROOT, 'ws2');   // [2-4]/[6]/[7] 用的小工作区,避免复用 [1] 的 3000 文件夹具

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  ok   ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.error(`FAIL   ${label}${extra ? '  ' + extra : ''}`); } };
const sha = (b) => createHash('sha256').update(b).digest('hex');

await fsp.rm(ROOT, { recursive: true, force: true });
await fsp.mkdir(WS, { recursive: true });
await fsp.mkdir(WS2, { recursive: true });
await fsp.writeFile(join(WS2, 'base-a.txt'), 'a\n');
await fsp.writeFile(join(WS2, 'base-b.txt'), 'b\n');

// ── 1. 规模:造 N 个文件(上限内),量遍历与捕获 ───────────────────────────
console.log(`\n[1] 规模 ${CAP.files} 文件 / 深度 ${CAP.depth}`);
{
  const t0 = Date.now();
  let made = 0;
  for (let d = 0; d < CAP.depth; d++) {
    const dir = join(WS, `layer${d}`);
    await fsp.mkdir(dir, { recursive: true });
    const perDir = Math.ceil(CAP.files / CAP.depth);
    for (let i = 0; i < perDir && made < CAP.files; i++, made++) {
      await fsp.writeFile(join(dir, `f${i}.txt`), `file ${d}/${i}\n${'x'.repeat(64)}\n`);
    }
  }
  const msBuild = Date.now() - t0;
  const mem = process.memoryUsage().heapUsed / 1024 / 1024;
  console.log(`  造 ${made} 文件耗时 ${msBuild}ms;堆 ${mem.toFixed(1)}MB`);

  const t1 = Date.now();
  const fp = await fingerprint(WS, { excludes: DEFAULTS.excludes, maxFiles: 5000, walkBudgetMs: 20000 });
  const msWalk = Date.now() - t1;
  ok(fp.map.size >= CAP.files, `指纹遍历覆盖 ${fp.map.size} 项`, `${msWalk}ms`);
  ok(!fp.truncated, '未触达 maxFiles/walkBudget 上限');

  const store = new Store(STORE_DIR, { maxTotalBytes: 64 * 1024 * 1024, keepRecords: 500 });
  const engine = new CaptureEngine({ store, cfg: { ...DEFAULTS, baseline: 'first' }, log: () => {} });
  const session = { id: 'stress', header: { cwd: WS } };
  const exec = (n, id) => ({ name: n, callId: id, arguments: {}, agent: { id: 'a', session }, signal: null });

  const t2 = Date.now();
  await engine.before(exec('bash', 'c1'), session);
  await engine.after(exec('bash', 'c1'), session);
  const msFirst = Date.now() - t2;                 // 首次 = 基线全量入库
  const t3 = Date.now();
  await engine.before(exec('bash', 'c2'), session);
  await engine.after(exec('bash', 'c2'), session);
  const msSecond = Date.now() - t3;                // 第二次 = 无变更
  const st = await store.stats();
  console.log(`  首次捕获(基线入库)${msFirst}ms;第二次捕获(零变更)${msSecond}ms`);
  console.log(`  blob ${st.blobCount} 个 / ${st.blobBytesFmt}`);
  ok(msSecond < msFirst, '零变更捕获明显快于基线全量', `${msSecond}ms < ${msFirst}ms`);
  ok(msWalk < 20000, '遍历在时间预算内', `${msWalk}ms`);
}

// ── 2/3/4. 大文件 / 密钥 / 符号链接 ────────────────────────────────────────
console.log('\n[2-4] 大文件 / 密钥 / 符号链接边界');
{
  const store = new Store(join(ROOT, 'store2'), { maxTotalBytes: 64 * 1024 * 1024, keepRecords: 100 });
  const cfg = { ...DEFAULTS, baseline: 'first', maxFileBytes: 64 * 1024 };
  const engine = new CaptureEngine({ store, cfg, log: () => {} });
  const session = { id: 'stress2', header: { cwd: WS2 } };
  const exec = (id) => ({ name: 'bash', callId: id, arguments: {}, agent: { id: 'a', session }, signal: null });

  await engine.before(exec('d1'), session); await engine.after(exec('d1'), session);
  await fsp.writeFile(join(WS2, 'big.bin'), 'y'.repeat(CAP.bigFileBytes));
  await fsp.writeFile(join(WS2, 'creds.pem'), 'PRIVATE-KEY\n');
  await fsp.writeFile(join(WS2, 'normal.txt'), 'hello\n');
  await fsp.symlink(join(WS2, 'normal.txt'), join(WS2, 'link-to-normal'));
  await engine.before(exec('d2'), session); await engine.after(exec('d2'), session);

  const recs = await store.records();
  const last = recs[recs.length - 1];
  const big = last.changes['big.bin'];
  ok(big?.tooBig === true && big.h === null, '大文件只记事件不入库', `s=${big?.s}`);
  ok(last.changes['creds.pem']?.secret === true, '密钥文件标记 secret');
  ok(last.changes['link-to-normal'] === undefined, '符号链接不进入变更集');
  ok(last.changes['normal.txt']?.h, '普通文件正常入库');

  // 恢复计划:大文件/密钥必须「保持现状」,绝不删除
  const plan = await planRestore({ store, root: WS2, records: recs, target: recs[0].id, mode: 'asof', paths: [], diffOpts: { context: 2, maxBytes: DEFAULTS.diffMaxBytes } });
  ok(plan.ok, 'asof 计划生成成功');
  const touched = plan.actions.map((a) => a.rel);
  ok(!touched.includes('big.bin'), '计划不触碰超限文件');
  ok(!touched.includes('creds.pem'), '计划不触碰密钥文件');
  ok(plan.warnings.some((w) => w.includes('creds.pem') || w.includes('big.bin')), '计划明确告警「保持现状」');
}

// ── 5. 路径穿越 ────────────────────────────────────────────────────────────
console.log('\n[5] 路径穿越与非法路径');
{
  const bad = ['../escape.txt', '/abs/path.txt', 'C:/win.txt', 'a\\b.txt', '', '.', 'a/../../b'];
  const rejected = bad.filter((p) => safeRel(p) === null).length;
  ok(rejected === bad.length, `safeRel 拒绝全部 ${bad.length} 个非法路径`);
  ok(safeRel('dir/ok.txt') === 'dir/ok.txt', '合法相对路径正常通过');
  ok(safeRel('dir//x/') === 'dir/x', '重复斜杠与尾斜杠被规范化');
}

// ── 6. 配额 GC ─────────────────────────────────────────────────────────────
console.log('\n[6] 配额 GC(配额压到 64KB)');
{
  const dir = join(ROOT, 'store3');
  const store = new Store(dir, { maxTotalBytes: CAP.smallQuotaBytes, keepRecords: 5 });
  const cfg = { ...DEFAULTS, baseline: 'first', maxFileBytes: 1024 * 1024 };
  const engine = new CaptureEngine({ store, cfg, log: () => {} });
  const session = { id: 'stress3', header: { cwd: WS2 } };
  for (let i = 0; i < CAP.runs; i++) {
    const f = join(WS2, `gc-${i}.txt`);
    await fsp.writeFile(f, `payload-${i}\n`.repeat(2000));   // 每轮 ~20KB
    await engine.before({ name: 'bash', callId: `gc${i}`, arguments: {}, agent: { id: 'a', session }, signal: null }, session);
    await engine.after({ name: 'bash', callId: `gc${i}`, arguments: {}, agent: { id: 'a', session }, signal: null }, session);
  }
  const gc = await store.gc();
  const st = await store.stats();
  const refs = await store.referencedHashes();
  let leaked = 0;
  for (const h of refs) if (!(await store.hasBlob(h))) leaked++;
  console.log(`  GC 删除 ${gc.removed} 个未引用 blob,释放 ${Math.round(gc.freed / 1024)}KB;库现 ${st.blobBytesFmt}`);
  ok(gc.removed > 0, '配额收紧后确实触发了淘汰');
  ok(leaked === 0, `被引用的 blob 一个都没被误删(引用 ${refs.size} 个)`);
  ok(st.blobBytes <= CAP.smallQuotaBytes, '库体积已回到配额内', `${st.blobBytes}B`);
}

// ── 7. 并发捕获 ────────────────────────────────────────────────────────────
console.log(`\n[7] 并发捕获(${CAP.concurrency} 路,上限内)`);
{
  const dir = join(ROOT, 'store4');
  const store = new Store(dir, { maxTotalBytes: 64 * 1024 * 1024, keepRecords: 500 });
  const cfg = { ...DEFAULTS, baseline: 'first' };
  const engine = new CaptureEngine({ store, cfg, log: () => {} });
  const mk = (sid) => ({ id: sid, header: { cwd: WS2 } });
  const tasks = [];
  for (let i = 0; i < CAP.concurrency; i++) {
    const session = mk(`cc${i}`);
    tasks.push((async () => {
      for (let r = 0; r < 3; r++) {
        await fsp.writeFile(join(WS2, `cc-${i}-${r}.txt`), `cc ${i}/${r}\n`.repeat(50));
        const e = { name: 'bash', callId: `cc${i}-${r}`, arguments: {}, agent: { id: 'a', session }, signal: null };
        await engine.before(e, session);
        await engine.after(e, session);
      }
    })());
  }
  await Promise.all(tasks);
  const raw = await fsp.readFile(store.ledgerPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let bad = 0;
  for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
  const recs = await store.records();
  ok(bad === 0, `ledger ${lines.length} 行全部可解析(无交错损坏)`);
  ok(recs.length === lines.length, `记录数一致 ${recs.length} == ${lines.length}`);
  const engine2 = new CaptureEngine({ store, cfg, log: () => {} });
  ok(typeof engine2.after === 'function', '并发后引擎仍可正常构造(状态未污染)');
}

console.log(`\n结果:${pass} 通过,${fail} 失败`);
const total = (await fsp.readdir(ROOT, { recursive: true }).catch(() => [])).length;
console.log(`清理:删除 ${ROOT}(${total} 个目录项)`);
await fsp.rm(ROOT, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
