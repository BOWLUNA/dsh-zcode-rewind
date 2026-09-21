/**
 * 零依赖行级 diff(Myers 最短编辑脚本 + 统一 diff 输出)。
 * 为什么不用 `diff` 包:本插件是恢复数据的最后一道防线,零运行时依赖是硬指标;
 * 且 dsh-file-review 已依赖 `diff`,重复引入没有收益。
 * 正确性优先于性能:超过行数上限直接返回占位说明,不做有风险的裁剪优化。
 */

const MAX_LINES = 6000;

function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 标准 Myers(O(ND))带 trace 回溯。
 * 返回对齐序列 [{a: idx|null, b: idx|null}],a=before 行号,b=after 行号(null 表示删/增)。
 */
export function alignLines(A, B) {
  const N = A.length, M = B.length;
  if (N === 0 && M === 0) return [];
  if (N > MAX_LINES || M > MAX_LINES) return null;

  const V = new Map();
  const trace = [];
  let found = false;
  for (let d = 0; d <= N + M && !found; d++) {
    trace.push(new Map(V));
    for (let k = -d; k <= d; k += 2) {
      let x;
      const down = k === -d || (k !== d && (V.get(k - 1) ?? -1) < (V.get(k + 1) ?? -1));
      if (down) x = V.get(k + 1) ?? 0;
      else x = (V.get(k - 1) ?? -1) + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      V.set(k, x);
      if (x >= N && y >= M) { found = true; break; }
    }
  }
  if (!found) return null;

  // 回溯:从 (N,M) 走回 (0,0);path 元素 [aIdx|null, bIdx|null]
  const path = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK;
    const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
    if (down) prevK = k + 1; else prevK = k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { path.push([x - 1, y - 1]); x--; y--; }
    if (d > 0) {
      if (x === prevX) { path.push([null, y - 1]); y -= 1; } // 插入
      else { path.push([x - 1, null]); x -= 1; }             // 删除
    }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { path.push([x - 1, y - 1]); x--; y--; }
  path.reverse();
  return path;
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function unifiedDiff({ relPath, before, after, context = 3, maxBytes = 512 * 1024 }) {
  const head = `--- a/${relPath}\n+++ b/${relPath}\n`;
  if (before === null && after === null) return `${head}(无内容)\n`;
  if (before === null) return `${head}@@ 新增文件(当前 ${after.length} 字节)\n`;
  if (after === null) return `${head}@@ 文件已删除(快照时 ${before.length} 字节)\n`;
  if (isProbablyBinary(before) || isProbablyBinary(after)) return `${head}@@ 二进制文件,不显示行级差异\n`;
  if (before.length > maxBytes || after.length > maxBytes) {
    return `${head}@@ 文件超过 ${Math.round(maxBytes / 1024)}KB,跳过行级差异\n`;
  }
  const A = splitLines(before.toString('utf8'));
  const B = splitLines(after.toString('utf8'));
  const align = alignLines(A, B);
  if (align === null) return `${head}@@ 文件过大(>${MAX_LINES} 行),跳过行级差异\n`;

  // 每个 op 都带 la(A 中行号)与 lb(B 中行号):' '/'-' 推进 la,' '/'+' 推进 lb,
  // 另一侧保持当前计数——这样纯插入/纯删除的 hunk 头也有确定行号。
  const ops = [];
  let la = 1, lb = 1;
  for (const [pa, pb] of align) {
    if (pa !== null && pb !== null) ops.push({ t: ' ', x: A[pa], la: la++, lb: lb++ });
    else if (pa !== null) ops.push({ t: '-', x: A[pa], la: la++, lb });
    else ops.push({ t: '+', x: B[pb], la, lb: lb++ });
  }
  if (!ops.some((o) => o.t !== ' ')) return `${head}(无行级差异)\n`;

  // hunk 分组:变更点向两侧扩 context;相邻变更间隔 ≤ 2*context 时并入同一 hunk
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === ' ') { i++; continue; }
    const s = i;
    while (i < ops.length && ops[i].t !== ' ') i++;
    let gap = 0;
    while (i < ops.length && ops[i].t === ' ' && gap < context * 2) { i++; gap++; }
    hunks.push([s, i]);
  }
  let out = head;
  for (const [s, e] of hunks) {
    const from = Math.max(0, s - context);
    const to = Math.min(ops.length, e + context);
    const aStart = ops[from].la;
    const bStart = ops[from].lb;
    let aCount = 0, bCount = 0;
    const body = [];
    for (let j = from; j < to; j++) {
      const o = ops[j];
      if (o.t === ' ') { aCount++; bCount++; body.push(' ' + o.x); }
      else if (o.t === '-') { aCount++; body.push('-' + o.x); }
      else { bCount++; body.push('+' + o.x); }
    }
    out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n` + body.join('\n') + '\n';
  }
  return out;
}
