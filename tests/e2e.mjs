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

// ---------- 1. 注册表与自检 ----------
check('registry-21-tools', tools.size === 21, { size: tools.size });
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
  check('negative-control-fails', neg.ok === false && neg.verifyFailed === true, neg.verify && neg.verify.reason);

  const reg = await call('desktop_click', { window: W, x: 200, y: 120, expect: 'ABC123', expectRegion: { x: 0, y: 0, w: 60, h: 40 }, yieldToUser: false });
  check('region-verification-filters', reg.ok === false && reg.verifyFailed === true, reg.verify && reg.verify.region);

  const clear = await call('desktop_key', { window: W, key: 'ctrl+a', yieldToUser: false });
  const del = await call('desktop_key', { window: W, key: 'delete', yieldToUser: false });
  const rd2 = await call('desktop_text', { window: W, limit: 2000 });
  check('keys-actually-work', clear.ok && del.ok && !String(rd2.text || '').includes('ABC123'), { after: String(rd2.text || '').slice(0, 40) });

  const lk = await call('desktop_look', { window: W, max: 12 });
  check('look-reads-controls', lk.ok === true && Array.isArray(lk.controls), { n: lk.controlCount });

  const cap = await call('desktop_capture', { window: W, image: false, path: 'C:/Users/xjy/AppData/Local/Temp/e2e-np.png' });
  check('capture-has-scale-and-rect', !!(cap.rect && cap.scale && cap.width > 0), { w: cap.width, scale: cap.scale });

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

// ---------- 输出 ----------
for (const line of results) console.log(line);
console.log('');
console.log('e2e: ' + pass + ' pass, ' + fail + ' fail, ' + skip + ' skip');
process.exit(fail === 0 ? 0 : 1);
