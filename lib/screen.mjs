/**
 * 屏幕结果的"可核查化"：只回变化的部分，并把"没法验证"和"没变化"分开说。
 *
 * 灵感来自 dsh-Go（GitHub 上的手机端 DSH 客户端）的做法：元素编号按阅读顺序发，
 * 所以同一窗口元素顺序不变时编号仍是上次的编号，于是可以只回变化的行；而当根本
 * 读不到东西时，必须说"无法验证"，而不是"界面没变化"——后者会让模型重试一个其
 * 实已经成功的动作，或者放弃一个还没到底的列表。
 *
 * 这里是独立实现，不包含任何第三方代码。
 */

/** 一个控件在前后两次快照里是否"算同一个"的指纹。 */
export function observationKey(el) {
  const n = el && typeof el === 'object' ? el : {};
  const role = String(n.role || '');
  const name = String(n.name || '');
  const r = n.rect || {};
  const pats = Array.isArray(n.pats) ? n.pats.join(',') : '';
  return role + '|' + name + '|' + (r.x | 0) + ',' + (r.y | 0) + ',' + (r.w | 0) + ',' + (r.h | 0) + '|' + pats;
}

/** 最多等多久还算"同一现场"（毫秒）。 */
export const DIGEST_TTL = 5 * 60 * 1000;

/**
 * 比较两次同一窗口的快照。
 * @returns {{mode:'full'|'same'|'diff', changed:number[], sameCount:number, note:string|null, reason:string}}
 */
export function screenDigest(prev, cur, opts = {}) {
  const prevId = opts.prevId || 'last';
  const curId = opts.curId || 'now';
  const limit = Number(opts.maxRatio ?? 3); // 变化超过 1/limit 就整份重发
  const before = Array.isArray(prev) ? prev : null;
  const now = Array.isArray(cur) ? cur : [];
  if (!before || !before.length || !now.length) {
    return { mode: 'full', changed: [], sameCount: 0, note: null, reason: 'no-baseline' };
  }
  if (before.length !== now.length) {
    return { mode: 'full', changed: [], sameCount: 0, note: null, reason: 'count-changed' };
  }
  const kb = before.map(observationKey);
  const kn = now.map(observationKey);
  const changed = [];
  for (let i = 0; i < kn.length; i++) if (kb[i] !== kn[i]) changed.push(i + 1);
  const sameCount = kn.length - changed.length;
  if (!changed.length) {
    return {
      mode: 'same',
      changed: [],
      sameCount,
      reason: 'identical',
      note: '界面与上次（' + prevId + '）完全一致，控件编号不变。如果刚做完一个动作，说明这一步已经生效但界面没有变化。',
    };
  }
  // 变化太多就不省了：宁可多发，也不能让模型去猜编号。
  if (changed.length * limit > kn.length) {
    return { mode: 'full', changed, sameCount, note: null, reason: 'too-many-changes' };
  }
  return {
    mode: 'diff',
    changed,
    sameCount,
    reason: 'few-changes',
    note: '只列变化：其余 ' + sameCount + ' 项与 ' + prevId + ' 相同、编号不变（' + curId + '）。',
  };
}

/**
 * 动作之后到底该怎么描述结果。
 * comparable=false 表示"没有足够依据判断"，这时绝不能断言"没变化"。
 * @returns {{comparable:boolean, changed:boolean, note:string|null}}
 */
export function verdict(flags = {}) {
  const comparable = flags.comparable !== false;
  const changed = flags.changed === true;
  const scrolled = flags.scrolled === true;
  const keyboard = flags.keyboard === 'shown' || flags.keyboard === 'hidden' ? flags.keyboard : null;
  if (!comparable) {
    return {
      comparable: false,
      changed: false,
      note: '（动作已提交，但无法验证结果：这个窗口读不到足够的可读内容，可能被保护、最小化或还没画完。）',
    };
  }
  if (changed) {
    return { comparable: true, changed: true, note: keyboard === 'shown' ? '界面已响应，键盘弹出来了。' : keyboard === 'hidden' ? '界面已响应，键盘收起来了。' : null };
  }
  if (scrolled) {
    return { comparable: true, changed: false, note: '内容没有变化，可能已经到头了。' };
  }
  return { comparable: true, changed: false, note: '界面没有明显变化。' };
}

/** 控件树太稀时的提示（少于这么多可读文本节点，看图比读树可靠）。 */
export const POOR_TREE = 5;

export function poorTree(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const named = list.filter((e) => String((e && e.name) || '').trim().length > 0).length;
  return { poor: list.length < POOR_TREE || named < POOR_TREE, named, total: list.length };
}

/**
 * 长列表按预算截断：保留头部与底部（导航通常在底部），中间压成一行。
 * @returns {{kept:number[], hidden:number, note:string|null}}
 */
export function fitBudget(elements, budget = 40) {
  const list = Array.isArray(elements) ? elements : [];
  const max = Math.max(4, Number(budget) || 40);
  if (list.length <= max) return { kept: list.map((_, i) => i + 1), hidden: 0, note: null };
  const head = Math.max(2, Math.floor(max * 0.6));
  const tail = max - head;
  const kept = [];
  for (let i = 1; i <= head; i++) kept.push(i);
  for (let i = list.length - tail + 1; i <= list.length; i++) if (i > 0) kept.push(i);
  const hidden = list.length - kept.length;
  return { kept, hidden, note: '为省长度省略了中间 ' + hidden + ' 项（' + (head + 1) + '–' + (list.length - tail) + '），需要的话传 full:true。' };
}

export function _reset() {}
