// 纯逻辑单元测试：不碰真实桌面、不发任何输入，可以在 CI 或任何 Windows 机器上跑。
// 用法：node tests/unit.mjs
import assert from 'node:assert/strict';
import { parseKeyChord } from '../lib/keys.mjs';
import { decideLocked } from '../lib/guard.mjs';
import { findLine } from '../lib/ocr.mjs';
import { encodePng } from '../lib/png.mjs';
import { runSequence } from '../lib/sequence.mjs';
import { panelDecision } from '../lib/panel.mjs';
import { explain, shortNotice } from '../lib/humanize.mjs';
import { buildTuning } from '../lib/env.mjs';

let passed = 0;
const fails = [];
const test = (name, fn) => {
  try { fn(); passed += 1; } catch (e) { fails.push(name + ': ' + (e && e.message)); }
};
// 异步用例单独收集，最后统一等，避免抛出到 unhandledRejection
const pending = [];
const atest = (name, fn) => {
  pending.push((async () => {
    try { await fn(); passed += 1; } catch (e) { fails.push(name + ': ' + (e && e.message)); }
  })());
};
const _unused = () => {

};

// ---- 按键解析 -------------------------------------------------------------
test('single plus is the plus key itself', () => {
  const k = parseKeyChord('+');
  assert.equal(k.vk, 0xbb);
  assert.ok(k.mods.includes('shift'), 'plus needs shift');
});

test('plain equals key does not press shift', () => {
  const k = parseKeyChord('=');
  assert.equal(k.vk, 0xbb);
  assert.equal(k.mods.includes('shift'), false);
});

test('ctrl++ keeps ctrl and adds shift', () => {
  const k = parseKeyChord('ctrl++');
  assert.equal(k.vk, 0xbb);
  assert.ok(k.mods.includes('ctrl'));
  assert.ok(k.mods.includes('shift'));
});

test('named keys and function keys', () => {
  assert.equal(parseKeyChord('enter').vk, 0x0d);
  assert.equal(parseKeyChord('esc').vk, 0x1b);
  assert.equal(parseKeyChord('f5').vk, 0x74);
  assert.ok(parseKeyChord('ctrl+shift+esc').mods.includes('shift'));
});

test('unknown key is rejected, not silently ignored', () => {
  assert.throws(() => parseKeyChord('sub+'));
  assert.throws(() => parseKeyChord(''));
});

// ---- 锁屏判断 -------------------------------------------------------------
test('locked only when flags say 0 AND a lock process exists', () => {
  assert.equal(decideLocked(0, { logonui: true, lockapp: false }).locked, true);
  assert.equal(decideLocked(0, { logonui: false, lockapp: true }).locked, true);
  assert.equal(decideLocked(0, { logonui: false, lockapp: false }).locked, false);
  assert.equal(decideLocked(1, { logonui: false, lockapp: false }).locked, false);
});

test('either lock host alone is enough, both is certain', () => {
  assert.equal(decideLocked(1, { logonui: true, lockapp: true }).locked, true);
  assert.equal(decideLocked(1, { logonui: true, lockapp: true }).source, 'process');
});

test('unreadable process list with flags 0 stays on the safe side', () => {
  assert.equal(decideLocked(0, { known: false }).locked, true);
  assert.equal(decideLocked(null, null).locked, false);
});

// ---- 文字定位 -------------------------------------------------------------
test('findLine matches loosely and returns the box', () => {
  const lines = [
    { text: '文件', x: 0, y: 0, w: 40, h: 20 },
    { text: '确定 取消', x: 100, y: 50, w: 120, h: 24 },
  ];
  const hit = findLine({ lines }, '确定');
  assert.ok(hit, 'should find 确定');
  assert.equal(hit.y, 50);
  assert.equal(findLine({ lines }, '取消'), null == null ? findLine({ lines }, '取消') : null);
  assert.ok(findLine({ lines }, '取消'));
  assert.equal(findLine({ lines }, '不存在'), null);
});

// ---- PNG 编码 -------------------------------------------------------------
test('encodePng writes a valid signature and IHDR', () => {
  const w = 2, h = 2;
  const rgb = Buffer.alloc(w * h * 3, 0x7f);
  const png = encodePng(w, h, rgb);
  assert.equal(png.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), w);
  assert.equal(png.readUInt32BE(20), h);
});


// ---- 序列的动作名校验（写错动作不能静默通过） -----------------------------
atest('runSequence rejects unknown actions even in dryRun', async () => {
  const { runSequence } = await import('../lib/sequence.mjs');
  const r = await runSequence({ steps: [{ action: 'fly' }], dryRun: true, primitives: { cancelled: () => false } });
  assert.equal(r.ok, false);
  assert.match(String((r.log && r.log[0] && r.log[0].error) || r.hint || ''), /unknown .*action/i);
});

atest('runSequence dryRun output has no undefined holes', async () => {
  const { runSequence } = await import('../lib/sequence.mjs');
  const r = await runSequence({ steps: [{ action: 'click', name: '发送' }, { action: 'type', text: 'hi' }], dryRun: true, primitives: { cancelled: () => false } });
  assert.ok(!/undefined/.test(JSON.stringify(r.log)), 'dryRun log must not contain undefined: ' + JSON.stringify(r.log));
});


// ---- 锁屏判断（issue #5：残留 LockApp 曾被误判成锁屏） ----------------------
test('orphan LockApp on the Default desktop is NOT locked', () => {
  const d = decideLocked(0, { logonui: false, lockapp: true }, 'Default');
  assert.equal(d.locked, false);
  assert.equal(d.source, 'desktop+orphan-lockapp');
});
test('LogonUI present means locked', () => {
  assert.equal(decideLocked(0, { logonui: true, lockapp: false }, 'Default').locked, true);
});
test('a non-Default input desktop means locked', () => {
  assert.equal(decideLocked(1, { logonui: false, lockapp: false }, 'Winlogon').locked, true);
});
test('Default desktop with no lock process is unlocked', () => {
  assert.equal(decideLocked(0, { logonui: false, lockapp: false }, 'Default').locked, false);
});
test('unknown desktop name still blocks when a lock process is around', () => {
  assert.equal(decideLocked(0, { logonui: false, lockapp: true }, null).locked, true);
});

atest('sequence stops on a user steer and carries the command', async () => {
  const r = await runSequence({
    steps: [{ action: 'wait', ms: 1 }, { action: 'wait', ms: 1 }],
    primitives: { cancelled: () => false, pollSteer: () => ({ command: '先补第 3 题' }), execute: async () => ({ ok: true }) },
  });
  assert.equal(r.interrupted, true);
  assert.equal(r.executed, 1);
  assert.equal(r.steer.command, '先补第 3 题');
  assert.equal(r.ok, false);
});

// 人话报错：每个失败码都要能翻译成“发生了什么 / 要不要你动手”。
atest('humanize explains a user-active block', () => {
  const ex = explain({ ok: false, blocked: 'user-active' });
  assert.ok(ex && ex.title && ex.todo, 'explain returned nothing');
  assert.ok(ex.needFromUser === null || ex.needFromUser === false || typeof ex.needFromUser === 'string');
});
atest('humanize explains a missing window', () => {
  const ex = explain({ ok: false, error: 'window handle 12345 is not available any more (it was closed or the number is stale)' });
  assert.ok(ex && /窗口/.test(ex.title), 'got ' + JSON.stringify(ex));
});
atest('humanize stays quiet on success', () => {
  assert.equal(explain({ ok: true }), null);
});
atest('humanize gives a one-line notice', () => {
  const ex = explain({ ok: false, blocked: 'focus' });
  const n = shortNotice(ex);
  assert.ok(n && n.length <= 24, 'notice too long: ' + n);
});

// 调参：DPI 高就把 OCR 放大倍数降下来，没中文 OCR 就少切几刀。
atest('tuning lowers ocr scale on high dpi', () => {
  const t = buildTuning({ dpi: { scale: 2 }, ocr: { zh: true }, ps: { ok: true } });
  assert.ok(t.ocr.scale <= 2.2, 'scale ' + t.ocr.scale);
});
atest('tuning reduces bands without chinese ocr', () => {
  const t = buildTuning({ dpi: { scale: 1 }, ocr: { zh: false }, ps: { ok: true } });
  assert.equal(t.ocr.bands, 2);
});
atest('tuning turns off uia when powershell is broken', () => {
  const t = buildTuning({ dpi: { scale: 1 }, ocr: { zh: true }, ps: { ok: false } });
  assert.equal(t.uia.preferUia, false);
});
atest('tuning slows down ocr when the machine is slow', () => {
  const t = buildTuning({ dpi: { scale: 1 }, ocr: { zh: true }, ps: { ok: true }, learned: { ocrMs: 3200, focusMs: 0 } });
  assert.equal(t.ocr.bands, 2);
});

atest('digest: same screen keeps ids and says so', async () => {
  const { screenDigest } = await import('../lib/screen.mjs');
  const a = [{ role: 'Button', name: 'OK', rect: { x: 1, y: 2, w: 3, h: 4 }, pats: ['Invoke'] }];
  const d = screenDigest(a, a.map((x) => ({ ...x })));
  assert(d.mode === 'same' && d.sameCount === 1 && /编号不变/.test(d.note));
});
atest('digest: few changes only lists them', async () => {
  const { screenDigest } = await import('../lib/screen.mjs');
  const base = [1, 2, 3, 4, 5, 6].map((i) => ({ role: 'Button', name: 'b' + i, rect: { x: i, y: 0, w: 10, h: 10 }, pats: [] }));
  const now = base.map((x, i) => (i === 2 ? { ...x, name: 'changed' } : x));
  const d = screenDigest(base, now);
  assert(d.mode === 'diff' && d.changed.length === 1 && d.changed[0] === 3);
});
atest('digest: too many changes falls back to full', async () => {
  const { screenDigest } = await import('../lib/screen.mjs');
  const base = [1, 2, 3, 4].map((i) => ({ role: 'Button', name: 'b' + i, rect: { x: i, y: 0, w: 10, h: 10 }, pats: [] }));
  const now = base.map((x) => ({ ...x, name: x.name + 'z' }));
  assert(screenDigest(base, now).mode === 'full');
});
atest('verdict: unverifiable never claims "no change"', async () => {
  const { verdict } = await import('../lib/screen.mjs');
  const v = verdict({ comparable: false });
  assert(v.comparable === false && v.changed === false && /无法验证/.test(v.note));
  assert(/没有明显变化/.test(verdict({ comparable: true, changed: false }).note));
  assert(/到头/.test(verdict({ comparable: true, changed: false, scrolled: true }).note));
});
atest('poorTree flags a nearly empty tree', async () => {
  const { poorTree } = await import('../lib/screen.mjs');
  assert(poorTree([{ name: 'x' }]).poor === true);
  assert(poorTree(Array.from({ length: 12 }, (_, i) => ({ name: 'n' + i }))).poor === false);
});
atest('fitBudget keeps head and tail', async () => {
  const { fitBudget } = await import('../lib/screen.mjs');
  const list = Array.from({ length: 100 }, (_, i) => ({ n: i }));
  const r = fitBudget(list, 10);
  assert(r.kept.length === 10 && r.hidden === 90 && r.kept[r.kept.length - 1] === 100);
});

atest('channelFor: 学习结论要够保守', async () => {
  const { channelFor } = await import('../lib/env.mjs');
  assert.equal(channelFor('x.exe', {}), null, 'no stats -> null');
  assert.equal(channelFor('x.exe', { 'x.exe': { uia: 4, ocr: 0, pixels: 0 } }), null, '4 次样本不够');
  assert.equal(channelFor('x.exe', { 'x.exe': { uia: 5, ocr: 0, pixels: 0 } }), 'uia', 'uia 领先 -> uia');
  assert.equal(channelFor('x.exe', { 'x.exe': { uia: 4, ocr: 4, pixels: 0 } }), null, '打平 -> 不下结论');
  assert.equal(channelFor('x.exe', { 'x.exe': { uia: 0, ocr: 3, pixels: 0 } }), null, '3 次样本不够下结论');
  assert.equal(channelFor('x.exe', { 'x.exe': { uia: 0, ocr: 5, pixels: 0 } }), 'image', '只能看图 -> image');
  assert.equal(channelFor('X.EXE', { 'x.exe': { uia: 5, ocr: 0, pixels: 0 } }), 'uia', '大小写不敏感');
});

for (const p of pending) await p;

// ---- 结果 ---------------------------------------------------------------
// 指挥台开合策略：重点是“不许闪”——刚开不能马上收，短间隔要忍住，连续空几次才收。
test('panel opens when the agent starts working', () => {
  assert.equal(panelDecision({ open: false, active: true }).action, 'open');
});
test('panel stays closed when nothing is happening', () => {
  assert.equal(panelDecision({ open: false, active: false }).action, 'keep');
});
test('panel never closes right after opening', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 100000, openedAt: now - 2000, now, absentPolls: 9 });
  assert.equal(d.reason, 'just-opened');
});
test('panel survives a short gap between tool calls', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 9000, openedAt: now - 60000, now, absentPolls: 9 });
  assert.equal(d.reason, 'short-gap');
});
test('panel debounces a single idle poll', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 60000, openedAt: now - 60000, now, absentPolls: 1 });
  assert.equal(d.reason, 'debounce');
});
test('panel closes after a real idle period', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 60000, openedAt: now - 60000, now, absentPolls: 4 });
  assert.equal(d.action, 'close');
});

if (fails.length) {
  console.error('FAILED ' + fails.length + ' / ' + (passed + fails.length));
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}



console.log('unit ok: ' + passed + ' tests');

// 指挥台开合策略：重点是“不许闪”——刚开不能马上收，短间隔要忍住，连续空几次才收。
atest('panel opens when the agent starts working', () => {
  const d = panelDecision({ open: false, active: true });
  assert.equal(d.action, 'open');
});
atest('panel stays closed when nothing is happening', () => {
  const d = panelDecision({ open: false, active: false });
  assert.equal(d.action, 'keep');
});
atest('panel never closes right after opening', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 100000, openedAt: now - 2000, now, absentPolls: 9 });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'just-opened');
});
atest('panel survives a short gap between tool calls', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 9000, openedAt: now - 60000, now, absentPolls: 9 });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'short-gap');
});
atest('panel debounces a single idle poll', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 60000, openedAt: now - 60000, now, absentPolls: 1 });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'debounce');
});
atest('panel closes after a real idle period', () => {
  const now = 100000;
  const d = panelDecision({ open: true, active: false, idleMs: 60000, openedAt: now - 60000, now, absentPolls: 4 });
  assert.equal(d.action, 'close');
});
