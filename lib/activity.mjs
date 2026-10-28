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
    scheduleHide();
  } catch {}
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

/** 记一条操作日志（失败静默）。 */
export function logTool(tool, payload) {
  try { return logAction(tool, payload); } catch { return null; }
}
