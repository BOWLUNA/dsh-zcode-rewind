#!/usr/bin/env node
/**
 * 离线冒烟测试:不依赖 DSH 宿主,直接驱动 lib/ 的捕获-存储-恢复-撤销全链路。
 * 任何一条断言失败都非零退出。CI 与 prepublishOnly 共用。
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fingerprint, diffFingerprints } from '../lib/fingerprint.js';
import { Store } from '../lib/store.js';
import { CaptureEngine } from '../lib/capture.js';
import { planRestore, applyRestore, stateAsOf } from '../lib/restore.js';
import { unifiedDiff, alignLines } from '../lib/diffline.js';
import { DEFAULTS } from '../lib/util.js';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
let pass = 0, fail = 0;
const ok = (cond, label) => { if (cond) { pass++; console.log(`  ok  ${label}`); } else { fail++; console.error(`FAIL  ${label}`); } };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);

const root = await mkdtemp(join(tmpdir(), 'wsr-smoke-'));
const storeRoot = join(root, 'store');
const ws = join(root, 'ws');
await fsp.mkdir(join(ws, 'src'), { recursive: true });
await fsp.writeFile(join(ws, 'src', 'a.txt'), 'line1\nline2\nline3\n');
await fsp.writeFile(join(ws, 'b.txt'), 'hello\n');
await fsp.writeFile(join(ws, '.env'), 'SECRET=1\n');
await fsp.mkdir(join(ws, 'node_modules', 'x'), { recursive: true });
await fsp.writeFile(join(ws, 'node_modules', 'x', 'y.js'), 'ignored\n');

const store = new Store(storeRoot, { maxTotalBytes: 64 * 1024 * 1024, keepRecords: 500 });
const cfg = { ...DEFAULTS, baseline: 'first' };
const logs = [];
const engine = new CaptureEngine({ store, cfg, log: (m) => logs.push(m) });

const session = { id: 's1', header: { cwd: ws } };
const mkExec = (name, callId, args = {}) => ({ name, callId, arguments: args, agent: { id: 'a1', session }, signal: null });

console.log('\n[1] 基线捕获(bash 调用触发,走 before/after 全链路)');
await engine.before(mkExec('bash', 'c1', { command: 'echo hi' }), session);
ok(engine.stateFor(session).pending.has('a1:c1'), 'before: pending 已登记');
await engine.after(mkExec('bash', 'c1', { command: 'echo hi' }), session);
const recsAll1 = await store.records();
const baseRec = recsAll1.find((r) => r.k === 'baseline');
const c1Rec = recsAll1[recsAll1.length - 1];
ok(!!baseRec, 'baseline 记录已生成');
ok(c1Rec !== baseRec && c1Rec.k === 'mutation' && Object.keys(c1Rec.changes).length === 0, 'echo hi 无文件变更 → 空 mutation 记录(时间线锚点)');
eq(Object.keys(baseRec.changes).length, 3, 'baseline 只含 3 个被跟踪文件(node_modules 已排除)');
ok(baseRec.changes['.env']?.secret === true, '.env 标记 secret,不入内容');
ok(baseRec.changes['.env']?.h === null, '.env 无内容哈希');
ok(baseRec.changes['src/a.txt']?.op === 'A', 'src/a.txt 记为 A');
ok(baseRec.changes['b.txt']?.h, 'b.txt 有内容哈希');
ok(!engine.stateFor(session).pending.has('a1:c1'), 'after: pending 已清理');

console.log('\n[2] bash 副作用被捕获(rm + 覆写 + 新建)');
await fsp.rm(join(ws, 'b.txt'));
await fsp.writeFile(join(ws, 'src', 'a.txt'), 'line1\nCHANGED\nline3\n');
await fsp.writeFile(join(ws, 'new.txt'), 'brand new\n');
await engine.before(mkExec('bash', 'c2', { command: 'rm b.txt; sed -i s/line2/CHANGED/; touch new.txt' }), session);
await engine.after(mkExec('bash', 'c2', { command: 'rm b.txt; sed -i s/line2/CHANGED/; touch new.txt' }), session);
const recsAll2 = await store.records();
const mutRec = recsAll2[recsAll2.length - 1];
ok(mutRec.k === 'mutation', 'mutation 记录已生成');
ok(mutRec.changes['b.txt']?.op === 'D', '删除被看见(b.txt D)');
ok(mutRec.changes['b.txt']?.prev, '删除文件带 prev 哈希(可还原)');
ok(mutRec.changes['new.txt']?.op === 'A', '新建被看见(new.txt A)');
ok(mutRec.changes['src/a.txt']?.op === 'M', '修改被看见(src/a.txt M)');
ok(mutRec.changes['src/a.txt']?.prev === baseRec.changes['src/a.txt'].h, '修改的 prev 来自基线哈希');
ok(mutRec.changes['node_modules/x/y.js'] === undefined, 'node_modules 不进差分');

console.log('\n[3] asof 恢复计划 + 行级 diff');
const recs = await store.records();
const plan = await planRestore({ store, root: ws, records: recs, target: baseRec.id, mode: 'asof', paths: [], diffOpts: { context: 3, maxBytes: DEFAULTS.diffMaxBytes } });
ok(plan.ok, '计划生成成功');
eq(plan.create, 1, '计划:还原 1 个被删文件');
eq(plan.remove, 1, '计划:删除 1 个新增文件');
eq(plan.write, 1, '计划:覆写 1 个修改文件');
ok(plan.diff.includes('-CHANGED'), '行级 diff 含 -CHANGED');
ok(plan.diff.includes('+line2'), '行级 diff 含 +line2');
ok(!plan.diff.includes('.env'), '计划不触碰 .env(内容未知,已剔除)');

console.log('\n[4] 应用恢复 → 工作区回到基线状态');
const r1 = await applyRestore({ store, root: ws, plan, sid: 's1', note: 'test' });
eq(r1.applied.length, 3, '恢复应用了 3 个路径');
eq((await fsp.readFile(join(ws, 'src', 'a.txt'))).toString(), 'line1\nline2\nline3\n', 'a.txt 内容已还原');
let exists = true; try { await fsp.access(join(ws, 'new.txt')); } catch { exists = false; }
ok(!exists, 'new.txt 已被删除');
eq((await fsp.readFile(join(ws, 'b.txt'))).toString(), 'hello\n', 'b.txt 已还原');

console.log('\n[5] 恢复本身可撤销(undo → 回到被搞坏的状态)');
const recs2 = await store.records();
const lastRestore = [...recs2].reverse().find((r) => r.k === 'restore' && r.rescueId);
ok(lastRestore, 'restore 记录带 rescueId');
const undoPlan = await planRestore({ store, root: ws, records: recs2, target: lastRestore.rescueId, mode: 'asof', paths: [], diffOpts: { context: 3, maxBytes: DEFAULTS.diffMaxBytes } });
ok(undoPlan.ok, '撤销计划生成成功');
const r2 = await applyRestore({ store, root: ws, plan: undoPlan, sid: 's1', note: 'undo' });
eq(r2.applied.length, 3, '撤销应用了 3 个路径');
eq((await fsp.readFile(join(ws, 'src', 'a.txt'))).toString(), 'line1\nCHANGED\nline3\n', 'a.txt 回到修改后的状态');
exists = true; try { await fsp.access(join(ws, 'new.txt')); } catch { exists = false; }
ok(exists, 'new.txt 回来了');

console.log('\n[6] revert 模式(只抵消一条记录的增量)');
const recs3 = await store.records();
const target = recs3.find((r) => r.id === mutRec.id);
const revPlan = await planRestore({ store, root: ws, records: recs3, target: target.id, mode: 'revert', paths: ['src/'], diffOpts: { context: 3, maxBytes: DEFAULTS.diffMaxBytes } });
ok(revPlan.ok, 'revert 计划生成成功');
eq(revPlan.write, 1, 'paths 过滤生效:只还原 src/ 下 1 个文件');
eq(revPlan.remove, 0, 'paths 过滤:new.txt 不在范围内');

console.log('\n[7] 状态折叠的安全边界');
const folded7 = stateAsOf(recs3, baseRec.id);
ok(folded7.state.get('.env') === undefined && folded7.unknown.has('.env'), 'secret 路径进 unknown,不会被折叠成「不存在」');
ok(folded7.state.get('new.txt') === null, 'target 后新建的路径 → target 时点不存在(可删除)');

console.log('\n[8] 行级 diff 单元(插入/删除/混合/二进制/空文件)');
eq(alignLines([], []).length, 0, '空-空');
let al = alignLines(['a'], []);
ok(al.length === 1 && al[0][0] === 0 && al[0][1] === null, '纯删除');
al = alignLines([], ['x']);
ok(al.length === 1 && al[0][0] === null && al[0][1] === 0, '纯插入');
al = alignLines(['a', 'b', 'c'], ['a', 'X', 'c']);
// Myers 只保证等价行配对;b≠X 永远不可能配对,必须一删一插
ok(al.filter((p) => p[0] === null).length === 1 && al.filter((p) => p[1] === null).length === 1, 'b/X 一删一插(最短编辑脚本)');
const d1 = unifiedDiff({ relPath: 'f.txt', before: Buffer.from('a\nb\nc\n'), after: Buffer.from('a\nX\nc\n'), context: 1 });
ok(d1.includes('-b') && d1.includes('+X'), '修改 diff 正确');
ok(d1.includes('@@ -1,3 +1,3 @@'), 'hunk 头含上下文范围(context=1 → 两文件各 3 行)');
const d2 = unifiedDiff({ relPath: 'f.txt', before: Buffer.from('a\n'), after: Buffer.from('a\nb\nc\n') });
ok(d2.includes('+b') && d2.includes('+c'), '插入 diff 正确');
const d3 = unifiedDiff({ relPath: 'f.txt', before: Buffer.from('a\nb\n'), after: null });
ok(d3.includes('文件已删除'), '删除文件占位');
const d4 = unifiedDiff({ relPath: 'f.bin', before: Buffer.from([0x00, 0x01, 0x02]), after: Buffer.from([0x00, 0x01, 0x03]) });
ok(d4.includes('二进制'), 'NUL 字节识别为二进制');
const d5 = unifiedDiff({ relPath: 'f.txt', before: Buffer.from('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n'), after: Buffer.from('a\nb\nc\nd\ne\nf\ng\nh\nX\nj\nk\nl\n'), context: 2 });
ok(d5.includes('-i') && d5.includes('+X') && d5.split('@@').length === 3, '多 hunk 分组正确');

console.log('\n[9] blob 去重与配额 GC');
const dup = await store.putBlob(Buffer.from('dedup-me'));
const dup2 = await store.putBlob(Buffer.from('dedup-me'));
eq(dup, dup2, '同内容同哈希');
const st1 = await store.stats();
ok(st1.blobCount >= 3, 'blob 库非空');
const gc = await store.gc();
ok(gc.removed === 0, '全部 blob 都被记录引用,GC 不误删');

console.log('\n[10] 排除规则与符号链接');
await fsp.mkdir(join(ws, '.git'), { recursive: true });
await fsp.writeFile(join(ws, '.git', 'HEAD'), 'ref: x\n');
const fp2 = await fingerprint(ws, { excludes: DEFAULTS.excludes, maxFiles: 1000, walkBudgetMs: 2000 });
ok(!fp2.map.has('.git/HEAD'), '.git 被排除');
ok(fp2.map.has('new.txt'), '普通文件在指纹里');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
await rm(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
