// 端到端自检：不只是“工具返回 ok”，而是真的去屏幕上核对结果。
// 每一条都必须能失败——所以里面的反例（负控）和正例一样重要。
import * as m from '../lib/index.js';
import { writeSteer, readSteer, pollSteer, _resetSteer } from '../lib/steer.mjs';

const tools = new Map();
m.apply({
  tools: { register: (d) => { tools.set(d.name, d); return d; } },
  attachments: { saveImage: async () => ({ attachmentId: 'test-' + Date.now() }) },
});
const call = async (n, a) => {
  try { return await tools.get(n).execute(a || {}); }
  catch (e) { return { ok: false, threw: String((e && e.message) || e) }; }
};

let pass = 0, fail = 0, skip = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push('PASS ' + name); }
  else { fail++; results.push('FAIL ' + name + ' ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 220)); }
}
function skipped(name, why) { skip++; results.push('SKIP ' + name + ' (' + why + ')'); }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 刚解锁/刚登录的几秒里，合成输入会被系统吞掉（测试会假红）。
// 先等桌面真的能用：锁屏解除 + 目标窗口稳定。
const waitDesktopReady = async () => {
  const { lockState } = await import('../lib/guard.mjs');
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    let st = null;
    try { st = lockState(); } catch {}
    if (st && st.locked === false) break;
    await delay(1500);
  }
  await delay(1200);
};
await waitDesktopReady();

// ---------- 1. 注册表与自检 ----------
check('registry-23-tools', tools.size === 23, { size: tools.size });
const shapeless = [...tools.values()].filter((t) => !t.description || !t.parameters);
check('registry-every-tool-documented', shapeless.length === 0, shapeless.map((t) => t.name));
const doc = await call('desktop_doctor', {});
const failing = (doc.checks || []).filter((c) => c.ok === false);
const transient = new Set(['ocr', 'foreground', 'capture']);
const hardFail = failing.filter((c) => !transient.has(c.id));
check('doctor-runs-and-mostly-green', (doc.checks || []).length >= 10 && hardFail.length === 0, { failing: failing.map((c) => c.id) });

// ---------- 2. 窗口枚举要有 z 序 ----------
const ws = await call('desktop_windows', {});
const withZ = (ws.windows || []).filter((w) => typeof w.z === 'number');
check('windows-have-z-order', withZ.length > 0 && withZ.length === (ws.windows || []).length, { n: (ws.windows || []).length });

// ---------- 3. 找一个干净的记事本（不碰用户文档） ----------
let np = (ws.windows || []).find((w) => /notepad/i.test(w.app) && /^(无标题|Untitled)/i.test(String(w.title || '')));
if (!np) {
  const l = await call('desktop_launch', { target: 'notepad.exe', timeoutMs: 8000 });
  if (l && l.hwnd) np = { hwnd: l.hwnd, title: l.window && l.window.title };
}
if (!np || !np.hwnd) { skipped('notepad-suite', 'no clean notepad window'); }
else {
  const W = String(np.hwnd);
  const fresh = await call('desktop_windows', {});
  const me = (fresh.windows || []).find((w) => String(w.hwnd) === W);
  if (me && me.minimized) {
    const rs = await call('desktop_window', { window: W, action: 'restore' });
    if (!rs || rs.ok === false) skipped('notepad-suite', 'notepad could not be restored');
    await delay(250);
    // 还原≠到前台：有的窗口还原后仍在别的窗口后面，先激活再打，模拟真人“点开它”。
    await call('desktop_window', { window: W, action: 'activate' });
    await delay(200);
  }
  // 先清空，保证起点干净
  await call('desktop_key', { window: W, key: 'ctrl+a', yieldToUser: false });
  await call('desktop_key', { window: W, key: 'delete', yieldToUser: false });

  const t1 = await call('desktop_type', { window: W, text: 'ABC123', expect: 'ABC123', yieldToUser: false });
  // 输入本身必须成功；校验要么“确认到了”，要么“老实说读不回来”（warn），
  // 不允许的是“明明没到却说到了”。真正的证据是下面第 57 行：整窗文字里有没有这串字。
  const typeChecked = t1.ok === true && ((t1.verify && t1.verify.ok) || !!t1.warn);
  check('type-lands-on-screen', typeChecked, { verify: t1.verify, warn: !!t1.warn, readBack: t1.readBack });

  const rd = await call('desktop_text', { window: W, limit: 4000 });
  check('uia-readback', String(rd.text || '').includes('ABC123'), { source: rd.source, len: String(rd.text || '').length });

  const neg = await call('desktop_click', { window: W, x: 200, y: 120, expect: '屏幕上绝对没有这句话QQQ', yieldToUser: false });
  check('negative-control-fails', neg.ok === false && neg.verifyFailed === true, { reason: neg.verify && neg.verify.reason, ok: neg.ok, err: neg.error, minimized: neg.minimized });

  const reg = await call('desktop_click', { window: W, x: 200, y: 120, expect: 'ABC123', expectRegion: { x: 0, y: 0, w: 60, h: 40 }, yieldToUser: false });
  check('region-verification-filters', reg.ok === false && reg.verifyFailed === true, { region: reg.verify && reg.verify.region, ok: reg.ok, err: reg.error });

  const clear = await call('desktop_key', { window: W, key: 'ctrl+a', yieldToUser: false });
  const del = await call('desktop_key', { window: W, key: 'delete', yieldToUser: false });
  const rd2 = await call('desktop_text', { window: W, limit: 2000 });
  check('keys-actually-work', clear.ok && del.ok && !String(rd2.text || '').includes('ABC123'), { after: String(rd2.text || '').slice(0, 40), clearOk: clear.ok, delOk: del.ok, err: clear.error || del.error });

  // 选项题：给标签就点整行中心（真实考试里模型以前只能猜像素，结果点进两行之间的空白）
  const opts = 'A、苹果\nB、香蕉\nC、橘子\nD、葡萄';
  await call('desktop_window', { window: W, action: 'activate' });
  await delay(150);
  const ot = await call('desktop_type', { window: W, text: opts, yieldToUser: false });
  const pickDry = await call('desktop_pick', { window: W, labels: ['B'], dryRun: true, yieldToUser: false });
  const seen = (pickDry.rowsSeen || []).map((r) => r.label);
  check('pick-finds-option-rows', ot.ok === true && ['A', 'B', 'C', 'D'].every((l) => seen.includes(l)), { seen, err: pickDry.error, saw: pickDry.saw, typeOk: ot.ok, typed: ot.typed, typeErr: ot.error, blocked: ot.blocked, readBack: ot.readBack });
  const pickB = await call('desktop_pick', { window: W, labels: ['B'], yieldToUser: false });
  const pickAt = pickB.picks && pickB.picks[0] && pickB.picks[0].at;
  check('pick-clicks-row-centre', pickB.ok === true && !!pickAt && pickAt.y > 0, { picks: pickB.picks && pickB.picks.length, at: pickAt, err: pickB.error });
  const pickBad = await call('desktop_pick', { window: W, labels: ['E'], yieldToUser: false });
  check('pick-rejects-label-not-in-choices', pickBad.ok === false && /not in choices/i.test(String(pickBad.error || '')), { error: pickBad.error });
  await call('desktop_key', { window: W, key: 'ctrl+a', yieldToUser: false });
  await call('desktop_key', { window: W, key: 'delete', yieldToUser: false });
  const seqSettle = await call('desktop_sequence', { window: W, yieldToUser: false, steps: [{ action: 'click', x: 120, y: 80, settle: true, settleTimeout: 900 }] });
  check('sequence-settle-waits-for-stable-area', seqSettle.ok === true && !!(seqSettle.log && seqSettle.log[0] && seqSettle.log[0].settled === true), { log: seqSettle.log && seqSettle.log[0], err: seqSettle.error });

  const lk = await call('desktop_look', { window: W, max: 12 });
  check('look-reads-controls', lk.ok === true && Array.isArray(lk.controls), { n: lk.controlCount, ok: lk.ok, err: lk.error });

  const cap = await call('desktop_capture', { window: W, image: false, path: 'C:/Users/xjy/AppData/Local/Temp/e2e-np.png' });
  check('capture-has-scale-and-rect', !!(cap.rect && cap.scale && cap.width > 0), { w: cap.width, scale: cap.scale, ok: cap.ok, err: cap.error, minimized: cap.minimized });

  // 最小化后不许偷偷把窗口还原，也不许截一张黑图糊弄
  await call('desktop_window', { window: W, action: 'minimize' });
  const capMin = await call('desktop_capture', { window: W, image: false });
  check('minimized-capture-refuses', capMin.ok === false && /minimized/i.test(String(capMin.error || capMin.threw || '')), capMin.error || capMin.threw);
  const clickMin = await call('desktop_click', { window: W, x: 50, y: 60, yieldToUser: false });
  check('minimized-click-refuses', clickMin.ok === false && clickMin.minimized === true, clickMin.error);
  await call('desktop_window', { window: W, action: 'restore' });
  const st = await call('desktop_window', { window: W, action: 'activate' });
  check('window-restore-works', st.ok === true && st.state && st.state.minimized === false, st.state);
}

// ---------- 4. 参数与安全边界（都应该“人话报错”） ----------
const badExe = Date.now();
const e1 = await call('desktop_launch', { target: 'C:/nope/gone.exe' });
check('missing-exe-fast-and-clear', e1.ok === false && Date.now() - badExe < 2500, { ms: Date.now() - badExe, error: e1.error });

const e2 = await call('desktop_wait', { window: '不存在XYZ', kind: 'nonsense', timeoutMs: 200 });
check('wait-validates-kind', e2.ok === false && /kind must be/i.test(String(e2.error || e2.threw || '')), e2.error || e2.threw);

const e3 = await call('desktop_window', { action: 'explode' });
check('window-action-whitelist', e3.ok === false || !!e3.threw, { error: e3.error || e3.threw });

const e4 = await call('desktop_drag', { fromX: -5000, fromY: -5000, toX: -4900, toY: -4900 });
check('drag-offscreen-rejected', e4.ok === false, { error: e4.error });

const e5 = await call('desktop_type', { window: '329374', text: '' });
check('empty-type-rejected', e5.ok === false, { error: e5.error || e5.threw });

// 用户正在打字的 DSH 窗口：既不能关，也不能最小化（以前模型为了腾地方把它最小化，窗口直接消失）
const allWins = (await call('desktop_windows', {})).windows || [];
const hostWin = allWins.find((w) => /deepseek harness/i.test(String(w.title || '') + ' ' + String(w.app || '')));
const hostMin = hostWin ? await call('desktop_window', { window: String(hostWin.hwnd), action: 'minimize' }) : null;
check('host-window-cannot-be-minimized', !hostWin || (!!hostMin && hostMin.ok === false && hostMin.refused === true), { title: hostWin && hostWin.title, res: hostMin && (hostMin.error || hostMin.ok) });
const hostClose = hostWin ? await call('desktop_window', { window: String(hostWin.hwnd), action: 'close' }) : null;
check('host-window-cannot-be-closed', !hostWin || (!!hostClose && hostClose.ok === false && hostClose.refused === true), { res: hostClose && (hostClose.error || hostClose.ok) });

// 默认值要“有耐心”：用户犹豫一下不算打扰，而且打字时要能识别出来
const clickProps = ((tools.get('desktop_click').parameters || {}).properties) || {};
check('yield-defaults-are-patient', /1500/.test(String((clickProps.quietMs || {}).description || '')), clickProps.quietMs);
const pickProps = ((tools.get('desktop_pick').parameters || {}).properties) || {};
check('pick-is-an-input-tool', !!pickProps.labels && /label/i.test(String(pickProps.labels.description || '')), Object.keys(pickProps));

const seq = await call('desktop_sequence', { steps: [{ action: 'fly' }], dryRun: true });
check('sequence-rejects-unknown-action', seq.ok === false, { executed: seq.executed });

// ---------- 5. 指挥台通道（不依赖宿主） ----------
try {
  _resetSteer();
  writeSteer('测试指令：第 3 题漏了');
  // 文件刚写完的一瞬间读，偶尔会读到空（写盘与读之间的调度问题），重试几次再判失败。
  let fresh = null;
  for (let i = 0; i < 6 && !(fresh && fresh.command); i += 1) {
    if (i) { writeSteer('测试指令：第 3 题漏了'); await new Promise((r) => setTimeout(r, 120)); }
    fresh = pollSteer({ stableMs: 0 });
  }
  check('steer-poll-sees-command', !!(fresh && String(fresh.command).includes('漏了')), fresh && fresh.command);
  const got = readSteer();
  check('steer-roundtrip', String(got.command || '').includes('第 3 题漏了'), got);
  writeSteer('');
  _resetSteer();
} catch (e) { check('steer-roundtrip', false, String(e && e.message)); }

// ---------- 6. 网页通道（慢、可能没网，失败算 SKIP 不算错） ----------
const webOpen = await call('desktop_web', { action: 'open', url: 'https://example.com', mode: 'internal' });
if (webOpen && webOpen.ok) {
  const snap = await call('desktop_web', { action: 'snapshot', maxText: 300 });
  const snapText = String((snap && (snap.title || '') + ' ' + (snap.text || '')) || '');
  check('web-snapshot-reads-page', /Example Domain/i.test(snapText), { title: snap && snap.title });
  await call('desktop_web', { action: 'close' });
} else {
  skipped('web-channel', (webOpen && (webOpen.error || webOpen.blocked)) || 'open failed');
}


// 收尾：把这次骗来的记事本窗口还原（最小化状态是会跨轮次传染的）
try { await call('desktop_window', { window: String((np && np.hwnd) || ''), action: 'restore' }); } catch {}

// ---------- 5c. 坐标口径：click 的 x/y 是「客户区像素」，不是「窗口像素」 ----------
// 反馈里三次实测都是“传进去的点 = 屏幕点 - 8”，因为浏览器标题栏+标签栏被算了进去。
// 这条测试锁住它：dryRun 报出来的落点必须正好是 clientOriginScreen + 传入值。
{
  const ws2 = await call('desktop_windows', {});
  const cand = (ws2.windows || []).find((w) => !w.minimized && w.bounds && w.bounds.width > 320 && w.bounds.height > 240);
  if (!cand) skipped('client-coordinates', 'no suitable window');
  else {
    const W = String(cand.hwnd);
    const p1 = await call('desktop_click', { window: W, x: 10, y: 12, dryRun: true, yieldToUser: false });
    const origin = p1 && p1.clientOriginScreen;
    check('click-point-uses-client-origin',
      !!(p1 && p1.ok && p1.dryRun && origin && p1.at && p1.at.x === origin.x + 10 && p1.at.y === origin.y + 12),
      { at: p1 && p1.at, origin, title: cand.title });

    const p2 = await call('desktop_click', { window: W, fx: 0.5, fy: 0.5, dryRun: true, yieldToUser: false });
    const size = p2 && p2.clientSize;
    check('click-fraction-uses-client-size',
      !!(p2 && p2.ok && size && p2.at && p2.at.x === origin.x + Math.round(0.5 * size.w) && p2.at.y === origin.y + Math.round(0.5 * size.h)),
      { at: p2 && p2.at, size });

    // 越界必须直接拒绝，而不是悄悄点到一个不相干的像素上
    const bad = await call('desktop_click', { window: W, x: (size && size.w ? size.w : 99999) + 40, y: 5, dryRun: true, yieldToUser: false });
    check('click-outside-client-refused', !!(bad && bad.ok === false && /outside the client area/.test(String(bad.error || ''))), { error: bad && bad.error });

    // 同一套口径也要在截图/读字的结果里说清楚，否则又得靠猜
    const cap2 = await call('desktop_capture', { window: W, image: false });
    check('capture-says-whose-pixels',
      !!(cap2 && cap2.rectKind && /rectKind|WINDOW pixels|CLIENT pixels|SCREEN pixels/.test(String(cap2.note || '')))
      && (cap2.rectKind !== 'window' || !!(cap2.clientOriginScreen && cap2.clientOffsetInRect)),
      { rectKind: cap2 && cap2.rectKind, hasOffset: !!(cap2 && cap2.clientOffsetInRect) });

    const rd2 = await call('desktop_read', { window: W, limit: 3 });
    check('ocr-read-maps-to-screen',
      !!(rd2 && rd2.coordinates && rd2.coordinates.rect && /screenX = rect\.x \+ line\.x/.test(String(rd2.coordinates.formula || ''))),
      { coords: rd2 && rd2.coordinates && { kind: rd2.coordinates.rectKind, scale: rd2.coordinates.scale } });
  }
  // 浏览器里“焦点不可用就拒打”的老毛病：参数上必须留一个明确的逃生口
  const props = (n) => ((tools.get(n).parameters || {}).properties || {});
  check('type-has-force-escape', !!props('desktop_type').force, Object.keys(props('desktop_type')).length);
  check('click-has-dry-run', !!props('desktop_click').dryRun, null);
}

// ---------- 5e. 线上 issue 的回归（#6 公式方向 / #7 屏幕点 / #8 raw 与小图提示 / #9 中断回执 / #10 OCR 坐标） ----------
{
  const props = (n) => ((tools.get(n).parameters || {}).properties || {});
  // #7：不属于任何窗口的点（任务栏、托盘）必须能点，而且要先给个 dryRun 让人核对
  const sp = await call('desktop_click', { screenX: 200, screenY: 200, dryRun: true, yieldToUser: false });
  check('click-screen-point-dryrun',
    !!(sp && sp.ok && sp.dryRun && sp.via === 'screen' && sp.at && sp.at.x === 200 && sp.at.y === 200),
    { via: sp && sp.via, at: sp && sp.at, error: sp && sp.error });
  check('click-screen-point-schema', !!(props('desktop_click').screenX && props('desktop_click').screenY), Object.keys(props('desktop_click')).length);

  // #6：capture 的 note 必须说乘法（scale = 窗口像素/图像像素），写反就必然点偏
  const capN = await call('desktop_capture', { image: false });
  check('capture-note-multiplies-scale',
    !!(capN && /imageX \* scale\.x/.test(String(capN.note || '')) && !/imageX\/scale\.x/.test(String(capN.note || ''))),
    { note: String((capN && capN.note) || '').slice(0, 120) });

  // #8a：raw:true 返回干净图（标尺不画进去）
  const capRaw = await call('desktop_capture', { raw: true, image: false });
  check('capture-has-raw-switch', !!(props('desktop_capture').raw && capRaw && capRaw.ok !== false), { ok: capRaw && capRaw.ok });

  // #10：OCR 行坐标不能再被二次归一化 —— 行高要是“真实文字高度”，不是 /scale 之后的值
  const ws3 = await call('desktop_windows', {});
  const cand3 = (ws3.windows || []).find((w) => !w.minimized && w.bounds && w.bounds.width > 320 && w.bounds.height > 240);
  if (cand3) {
    const rd3 = await call('desktop_read', { window: String(cand3.hwnd), limit: 40 });
    const lines3 = (rd3 && rd3.lines) || [];
    const maxH = lines3.reduce((a, l) => Math.max(a, Number(l.h) || 0), 0);
    const rect3 = (rd3 && rd3.rect) || {};
    const maxRight = lines3.reduce((a, l) => Math.max(a, (Number(l.x) || 0) + (Number(l.w) || 0)), 0);
    check('ocr-line-height-is-real',
      lines3.length > 0 && maxH >= 10 && maxRight <= (rect3.w || 1e9) + 2,
      { maxH, maxRight, rectW: rect3.w, n: lines3.length });
    // #8b：小图读字要主动提示分辨率不足，而不是直接给错字
    const rdSmall = await call('desktop_read', { window: String(cand3.hwnd), maxDim: 400, limit: 3 });
    check('ocr-small-image-warns',
      !!(rdSmall && (rdSmall.warning || (rdSmall.imageWidth && rdSmall.imageWidth >= 1000))),
      { warning: rdSmall && rdSmall.warning, imageWidth: rdSmall && rdSmall.imageWidth });
  } else {
    skipped('ocr-line-height-is-real', 'no suitable window');
    skipped('ocr-small-image-warns', 'no suitable window');
  }

  // #9：被指挥台打断时，回执要写、steer.txt 要清 —— 否则面板永远显示“还躺着”
  const steerMod = await import('../lib/steer.mjs');
  steerMod.writeSteer('第 7 题漏了，先补上');
  await delay(150);
  const seq = await call('desktop_sequence', { steps: [{ action: 'wait', ms: 60 }], yieldToUser: false });
  check('steer-interrupt-returns-command',
    !!(seq && seq.steer && seq.steer.command),
    { interrupted: seq && seq.interrupted, steer: seq && seq.steer, err: seq && seq.error });
  const rec = steerMod.readConsumed();
  check('steer-interrupt-writes-receipt',
    !!(rec && /第 7 题/.test(String(rec.command || '')) && Number(rec.at) > 0),
    { consumed: rec });
  const left = steerMod.readSteer();
  check('steer-interrupt-clears-file', !(left && left.command), { left: left && left.command });
}

// ---------- 5d. 操作日志：一次调用写一条，且能读回来 ----------
{
  const before = await call('desktop_log', { limit: 1 });
  await call('desktop_windows', {});
  await delay(120);
  const after = await call('desktop_log', { limit: 5 });
  const delta = Number(after.total || 0) - Number(before.total || 0);
  const newest = (after.entries || [])[0];
  // 日志有 500 行上限，满了之后总数不再增长，所以既要 delta>=1 也要接受“已满但最新一条是刚写的”
  // 日志里的 ts 是本地时间串（“2026-11-21 05:50:42”），也兼容毫秒数
  const stamp = newest && (newest.ts || newest.at);
  let stampMs = NaN;
  if (typeof stamp === 'number') stampMs = stamp;
  else if (stamp) {
    const t = String(stamp);
    stampMs = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(' ', 'T') + 'Z');
  }
  const fresh = !(Number.isFinite(stampMs) && stampMs < Date.now() - 300000);
  check('action-log-records-every-call',
    !!(newest && newest.tool && fresh && (delta >= 1 || Number(after.total || 0) >= 500)),
    { before: before.total, after: after.total, delta, newest: newest && newest.tool, fresh });
  // 一次调用一行：两次调用最多多出两行（以前一次点击会写 2~3 行）
  check('action-log-one-line-per-call', delta <= 2, { delta });
  check('action-log-reports-writable', after.writable === true, { writable: after.writable, dir: after.dir, hint: after.hint });
}

// ---------- 5f. 点击精度：命中测试 / 空白识别 / 网页元素 ----------
{
  const props = (n) => ((tools.get(n).parameters || {}).properties || {});
    check('click-has-snap-switch', !!(props('desktop_click').snap && props('desktop_click').snap.type === 'string'), { has: !!(props('desktop_click').snap) });

  // 找一个记事本（本轮的点击精度检查都在它身上做，不碰用户的文档）
  const ws3 = await call('desktop_windows', {});
  const np3 = (ws3.windows || []).find((w) => /notepad/i.test(w.app || ''));
  if (!np3) {
    skipped('click-hit-reports-control', 'no notepad window');
    skipped('click-blank-point-warns', 'no notepad window');
    skipped('click-text-area-not-blank', 'no notepad window');
    skipped('page-lists-elements', 'no notepad window');
    skipped('page-click-refuses-unknown-name', 'no notepad window');
  } else {
    if (np3.minimized) { await call('desktop_window', { window: String(np3.hwnd), action: 'restore' }); await delay(250); }

    // 命中测试：窗口正中那一点到底是什么
    const hitMid = await call('desktop_click', { window: String(np3.hwnd), fx: 0.5, fy: 0.5, dryRun: true, snap: 'auto' });
    check('click-hit-reports-control',
      !!(hitMid.hit && hitMid.hit.role && typeof hitMid.hit.role === 'string'),
      { hit: hitMid.hit && hitMid.hit.role, err: hitMid.error });

    // 标题栏那条横带不是控件 → 必须明确说“这里是空白”
    const hitBlank = await call('desktop_click', { window: String(np3.hwnd), fx: 0.5, fy: 0.015, dryRun: true });
    check('click-blank-point-warns', hitBlank.blankPoint === true, { blank: hitBlank.blankPoint, hit: hitBlank.hit && hitBlank.hit.role });

    // 正文区域是有意义的输入区，不能被误判成空白
    const hitText2 = await call('desktop_click', { window: String(np3.hwnd), fx: 0.5, fy: 0.55, dryRun: true });
    check('click-text-area-not-blank', hitText2.blankPoint !== true, { blank: hitText2.blankPoint, hit: hitText2.hit && hitText2.hit.role });

    // 网页元素表：有页面就列，没暴露就给出两条替代路（两种都算通过，但必须给话）
    const page = await call('desktop_page', { window: String(np3.hwnd), max: 20 });
    check('page-lists-elements',
      !!(page.ok === true && Array.isArray(page.elements)) || (page.ok === false && /page-not-exposed|does not expose/.test(String(page.error || '') + String(page.hint || ''))),
      { ok: page.ok, n: (page.elements || []).length, err: page.error });

    const unknown = await call('desktop_page', { window: String(np3.hwnd), click: 'this-name-cannot-exist-xyz', dryRun: true });
    check('page-click-refuses-unknown-name', unknown.ok === false && !!unknown.error, { ok: unknown.ok, err: unknown.error });
  }
}

// ---------- 自检报告：给用户一个能直接复制发过来的东西 ----------
{
  const rep = await call('desktop_doctor', { report: true });
  const text = String(rep.report || '');
  check('doctor-report-has-version', /插件版本：\d+\.\d+\.\d+/.test(text), { head: text.slice(0, 60) });
  check('doctor-report-lists-checks', /检查项：/.test(text) && text.includes('platform'), { len: text.length });
  check('doctor-report-mentions-env', /环境：/.test(text), null);
}

// ---------- 输出 ----------
for (const line of results) console.log(line);
console.log('');
console.log('e2e: ' + pass + ' pass, ' + fail + ' fail, ' + skip + ' skip');
process.exit(fail === 0 ? 0 : 1);
