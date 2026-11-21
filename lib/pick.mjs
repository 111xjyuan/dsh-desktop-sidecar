// 选项行识别：把「A、xxx」「B．xxx」「对、正确」这种行认成某个标签对应的整行。
// 单独放一个纯函数模块，是为了能直接写单元测试（OCR 的误配在这里一次说清楚）。
// 分隔符：选项标签和文字之间常见的标点/空格。
const SEP = /^[\s\u3000]*[、．.,，)）:：\]】\-—–]/;

export function normLabel(v) {
  return String(v == null ? '' : v).replace(/[\s\u3000]+/g, '');
}

/**
 * 这一行属于哪个标签？
 * @param {string} text  OCR 读到的行文字
 * @param {string[]} labels 这一页可能出现的标签（按顺序）
 * @param {{loose?: boolean}} [opts] loose=true 时也接受「B顺序存储」这种没有标点的写法
 */
export function matchLabel(text, labels, opts = {}) {
  const loose = opts.loose === true;
  const t = normLabel(text);
  if (!t) return null;
  let best = null;
  for (const raw of labels || []) {
    const lab = normLabel(raw);
    if (!lab) continue;
    if (t === lab) { if (!best || lab.length > best.length) best = lab; continue; }
    if (!t.startsWith(lab)) continue;
    const rest = t.slice(lab.length);
    if (SEP.test(rest)) { if (!best || lab.length > best.length) best = lab; continue; }
    // 「B顺序存储」：标签短、后面直接跟中文。只在 loose 模式接受，否则「B超检查」会被误认成选项 B。
    if (loose && lab.length <= 2 && /^[\u4e00-\u9fa5]/.test(rest)) { if (!best || lab.length > best.length) best = lab; }
  }
  return best;
}

/**
 * OCR 有时会把相邻的几行并成一行（「B、香蕉 C、橘子 D、葡萄」）。
 * 这时整块只有一个行框，但里面出现了好几个「标签+标点」，可以按个数把这块纵向等分，
 * 每一份就是一行 —— 比整块丢弃、或者让模型自己猜 y 都靠谱。
 * 返回 null 表示这行不是“并起来的”。
 */
export function splitMergedLine(line, labels) {
  if (!line) return null;
  const t = normLabel(line.text);
  if (!t) return null;
  const order = (labels || []).slice().sort((a, b) => normLabel(b).length - normLabel(a).length);
  const hits = [];
  let i = 0;
  while (i < t.length) {
    let matched = null;
    for (const raw of order) {
      const lab = normLabel(raw);
      if (!lab) continue;
      if (t.startsWith(lab, i)) {
        const rest = t.slice(i + lab.length);
        if (SEP.test(rest)) { matched = lab; break; }
      }
    }
    if (matched) { hits.push({ label: matched, at: i }); i += matched.length; }
    else i += 1;
  }
  if (hits.length < 2) return null;
  const top = Number(line.y) || 0;
  const h = Number(line.h) || 16;
  const slice = h / hits.length;
  return hits.map((hit, k) => ({
    label: hit.label,
    text: t.slice(hit.at, k + 1 < hits.length ? hits[k + 1].at : t.length),
    x: line.x,
    y: Math.round(top + slice * k),
    w: line.w,
    h: Math.round(slice),
    merged: true,
  }));
}

/**
 * 从 OCR 行里挑出「标签 → 行」。
 * 有标点的行更可信；只有严格匹配拿不到 2 行时，才用没有标点的宽松匹配补。
 */
export function rowsFromLines(lines, labels) {
  const strict = new Map();
  const loose = new Map();
  for (const line of lines || []) {
    if (!line) continue;
    const parts = splitMergedLine(line, labels);
    if (parts) {
      for (const part of parts) if (!strict.has(part.label)) strict.set(part.label, part);
      continue;
    }
    const text = String(line.text || '');
    const s = matchLabel(text, labels, { loose: false });
    if (s && !strict.has(s)) strict.set(s, line);
    const l = matchLabel(text, labels, { loose: true });
    if (l && !loose.has(l)) loose.set(l, line);
  }
  const rows = new Map(strict);
  if (rows.size < 2) for (const [k, v] of loose) if (!rows.has(k)) rows.set(k, v);
  return rows;
}

/**
 * OCR 漏掉某一行时，用已知行之间的间距把它补出来。
 * 卷子上选项是等距的，所以：
 *  - 夹在已知行中间的，直接线性插值；
 *  - 落在两端的（OCR 常把第一行的「A、」吞掉），只有**间距足够整齐**时才向外推一格，
 *    整齐度不够就宁可不猜 —— 点错一格比点不到更糟。
 */
export function interpolateRow(rows, labels) {
  const order = (labels || []).map(normLabel);
  const known = [];
  for (let i = 0; i < order.length; i++) {
    const line = rows && rows.get(order[i]);
    if (line && Number.isFinite(Number(line.y))) known.push({ i, line });
  }
  const out = new Map(rows || []);
  if (known.length < 2) return out;
  known.sort((a, b) => a.i - b.i);
  const first = known[0];
  const last = known[known.length - 1];
  // 相邻已知行的步长（每差一个标签对应多少像素）
  const gaps = [];
  for (let k = 1; k < known.length; k++) {
    const dLabel = known[k].i - known[k - 1].i;
    if (dLabel > 0) gaps.push((known[k].line.y - known[k - 1].line.y) / dLabel);
  }
  const sorted = gaps.slice().sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const tidy = sorted.length > 0 && median > 0 && sorted.every((g) => g > 0 && Math.abs(g - median) / median <= 0.35);
  const stepY = tidy ? median : 0;
  for (let i = 0; i < order.length; i++) {
    const label = order[i];
    if (out.has(label)) continue;
    let y = null;
    let how = '';
    if (i > first.i && i < last.i) {
      y = Math.round(first.line.y + ((last.line.y - first.line.y) * (i - first.i)) / (last.i - first.i));
      how = '(inferred from the rows above and below)';
    } else if (tidy && i < first.i && first.i - i <= 2) {
      y = Math.round(first.line.y - stepY * (first.i - i));
      how = '(inferred from the row spacing below it)';
    } else if (tidy && i > last.i && i - last.i <= 2) {
      y = Math.round(last.line.y + stepY * (i - last.i));
      how = '(inferred from the row spacing above it)';
    }
    if (y === null || y < 0) continue;
    const model = i < first.i ? first : last;
    out.set(label, { text: how, x: model.line.x, y, w: model.line.w, h: model.line.h, inferred: true });
  }
  return out;
}
