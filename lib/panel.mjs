// 指挥台该开还是该收——纯函数，方便单测，也方便客户端直接拿去用。
//
// 之前的问题：状态条只在“真正动手”的 1.4 秒内算活跃，两次工具调用之间的思考时间它就读成“空闲”，
// 于是指挥台开一下、关一下，看起来一直在闪。这里加了三个缓冲：
//   1) 刚打开后至少留 minOpenMs，不许马上收；
//   2) 要连续 absentPolls 次都读不到活跃才收（防抖）；
//   3) 空闲时间要超过 closeAfterMs 才收，不只是当前这一次读。
export const PANEL_DEFAULTS = {
  minOpenMs: 12000,
  closeAfterMs: 20000,
  absentPolls: 3,
};

/**
 * @param {{open: boolean, active: boolean, idleMs: number, openedAt?: number, now?: number, absentPolls?: number, minOpenMs?: number, closeAfterMs?: number, requiredPolls?: number}} s
 * @returns {{action: 'open'|'close'|'keep', reason: string}}
 */
export function panelDecision(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const minOpenMs = Number.isFinite(s.minOpenMs) ? s.minOpenMs : PANEL_DEFAULTS.minOpenMs;
  const closeAfterMs = Number.isFinite(s.closeAfterMs) ? s.closeAfterMs : PANEL_DEFAULTS.closeAfterMs;
  const requiredPolls = Number.isFinite(s.requiredPolls) ? s.requiredPolls : PANEL_DEFAULTS.absentPolls;
  const absent = Number.isFinite(s.absentPolls) ? s.absentPolls : 0;

  if (!s.open) {
    return s.active ? { action: 'open', reason: 'working' } : { action: 'keep', reason: 'idle' };
  }
  const age = now - (Number.isFinite(s.openedAt) ? s.openedAt : now);
  if (s.active) return { action: 'keep', reason: 'working' };
  if (age < minOpenMs) return { action: 'keep', reason: 'just-opened' };
  if (Number.isFinite(s.idleMs) && s.idleMs >= 0 && s.idleMs < closeAfterMs) {
    return { action: 'keep', reason: 'short-gap' };
  }
  if (absent < requiredPolls) return { action: 'keep', reason: 'debounce' };
  return { action: 'close', reason: 'idle' };
}
