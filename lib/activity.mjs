// activity.mjs — 把「正在操作电脑」这件事显性化：
//   1) 真的动鼠标/键盘时，屏幕底部出现状态条（hud.mjs），1.4s 没有新动作就自动收起。
//   2) 期间按 Esc 记成一次性取消信号，长任务（sequence / course）据此停下。
//   3) 同时写一条操作日志（actions-log.mjs）。
// 三条都不能影响主流程：任何异常都被吞掉，工具照常执行。
import { hud } from './hud.mjs';
import { logAction } from './actions-log.mjs';

const TITLE = 'DSH 正在操作这台电脑';
const short = (v) => { const t = String(v == null ? '' : v); return t.length > 30 ? t.slice(0, 29) + '…' : t; };
const AUTO_HIDE_MS = 1400;
// 状态条只闪 1.4 秒，但“这次任务正在操作电脑”这件事要留得久一点：
// 指挥台（侧栏）就靠它决定开不开。之前都按 1.5 秒算，两次工具调用之间读一次就变成空闲，
// 面板于是闪一下就收，用户干脆看不到。
const SESSION_MS = 45000;

let lastPulseAt = 0;
let activeSince = 0;
let lastLabel = '';
let hideTimer = null;
let escHit = false;
let escWired = false;

function wireEsc() {
  if (escWired) return;
  try {
    const h = hud();
    if (!h) return;
    h.setEscHandler(() => { escHit = true; });
    escWired = true;
  } catch {}
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    try { const h = hud(); if (h) h.hide(); } catch {}
  }, AUTO_HIDE_MS);
  if (hideTimer.unref) hideTimer.unref();
}

/**
 * 一次工具调用开始：状态条立刻亮起来，并一直亮到这次调用结束。
 * 以前只有 pulse()（具体动作那一刻才亮 1.4 秒），读屏、看窗口这类慢动作中间是黑的，
 * 用户就以为“状态条根本不显示”。beginWork/endWork 是配对的。
 * @param {string} label 例如「正在看屏幕」
 */
export function beginWork(label) {
  try {
    markWork(label);
    wireEsc();
    const h = hud();
    if (h) {
      clearTimeout(hideTimer);
      h.show({ text: TITLE, sub: label == null ? '' : short(label), tone: 'run', progress: null });
    }
  } catch {}
}

/** 一次工具调用结束：交给 AUTO_HIDE_MS 收尾（不是立刻收，免得闪一下）。 */
export function endWork() {
  try { scheduleHide(); } catch {}
}

/**
 * 亮一下状态条。每次真的动手前调用一次即可，不需要配对。
 * @param {string} label 第二行文案，例如「点击「发送」」
 * @param {{progress?: {done:number,total:number}, tone?: 'run'|'done'|'stop', reset?: boolean}} opts
 */
export function pulse(label, opts = {}) {
  try {
    if (opts.reset) escHit = false;
    wireEsc();
    const h = hud();
    if (h) {
      h.show({
        text: TITLE,
        sub: label == null ? '' : short(label),
        tone: opts.tone || 'run',
        progress: opts.progress || null,
      });
    }
    lastPulseAt = Date.now();
    if (!activeSince) activeSince = lastPulseAt;
    lastLabel = label == null ? '' : short(label);
    scheduleHide();
  } catch {}
}

/**
 * 现在是不是“正在操作电脑”。桌面控制类工具每动一下都会 pulse 一次；
 * 1.5 秒没有新动作就算停了（和状态条自动收起的节奏一致）。
 */
export function isActive(windowMs = 1500) {
  return lastPulseAt !== 0 && Date.now() - lastPulseAt < windowMs;
}

/**
 * 只记“这一轮在操作电脑”，不点亮状态条。
 * 读屏、看窗口这类动作不该让提示条一直闪，但它们同样属于“在用这台电脑”，
 * 指挥台要靠这个信号才会自动出现。
 */
export function markWork(label) {
  try {
    lastPulseAt = Date.now();
    if (!activeSince) activeSince = lastPulseAt;
    if (typeof label === 'string' && label) lastLabel = label;
  } catch {}
}

export function activeInfo() {
  const now = Date.now();
  return {
    // active 给“指挥台该不该开”用，窗口比状态条长得多
    active: lastPulseAt !== 0 && now - lastPulseAt < SESSION_MS,
    visible: isActive(),
    since: activeSince || null,
    label: lastLabel || '',
    idleMs: lastPulseAt ? now - lastPulseAt : null,
  };
}

/** 收尾：把状态条切成成功/失败色，再让它自然消失。 */
export function settle(ok, label) {
  try {
    const h = hud();
    if (!h) return;
    h.update({ tone: ok ? 'done' : 'stop', sub: label == null ? undefined : String(label) });
    scheduleHide();
  } catch {}
}

/** 立刻收起。 */
export function hideNow() {
  lastPulseAt = 0;
  activeSince = 0;
  clearTimeout(hideTimer);
  try { const h = hud(); if (h) h.hide(); } catch {}
}

/** 取出并清空「按过 Esc」的标记。 */
export function consumeEsc() {
  const v = escHit;
  escHit = false;
  return v;
}

/** 只看不清。 */
export function escPending() {
  return escHit;
}

// 一次工具调用里，各分支（点击、打字、失败说明……）都想记一笔。
// 以前直接写盘，于是同一次点击会留下 2~3 条记录，看日志的人以为点了好几次。
// 现在调用期间先攒起来，endCall 时合成一条（分支明细放在 steps 里）。
// 用 AsyncLocalStorage 而不是一个模块级变量：宿主可能同时发两个工具调用，
// 共享一个缓冲会把 A 的明细记到 B 那一条里。
let callStore = null;
try {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  callStore = new AsyncLocalStorage();
} catch { callStore = null; }
let fallbackBuf = null;

function currentBuf() {
  if (callStore) return callStore.getStore() || null;
  return fallbackBuf;
}

/** 一次工具调用开始：这之后的 logTool 先攒着，不落盘。 */
export function beginCall(tool) {
  const buf = { tool, steps: [] };
  if (callStore) callStore.enterWith(buf);
  else fallbackBuf = buf;
  return buf;
}

/** 记一条操作日志（失败静默）。调用进行中就先缓存，等 endCall 合并。 */
export function logTool(tool, payload) {
  const buf = currentBuf();
  // 只收“同一次调用”的明细：名字对不上就说明是另一次调用（或组合工具里的子动作），直接落盘。
  if (buf && tool === buf.tool) {
    try {
      const step = (payload && typeof payload === 'object') ? { ...payload } : { value: payload };
      if (tool !== buf.tool) step.tool = tool;
      buf.steps.push(step);
    } catch {}
    return { ok: true, buffered: true };
  }
  try { return logAction(tool, payload); } catch { return null; }
}

/**
 * 一次工具调用结束：把这次调用写成一条记录（含分支明细）。
 * 返回写入结果；写失败时带 logged:false 与原因，由调用方写进工具结果。
 */
export function endCall(primary) {
  const buf = currentBuf();
  if (callStore) callStore.enterWith(undefined);
  else fallbackBuf = null;
  const head = (primary && typeof primary === 'object') ? { ...primary } : {};
  const tool = head.tool || (buf && buf.tool) || 'unknown';
  delete head.tool;
  const merged = { ...head };
  if (buf && buf.steps.length) {
    merged.steps = buf.steps.slice(0, 12);
    if (buf.steps.length > 12) merged.stepsTruncated = buf.steps.length - 12;
  }
  try { return logAction(tool, merged); } catch { return null; }
}
