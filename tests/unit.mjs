// 纯逻辑单元测试：不碰真实桌面、不发任何输入，可以在 CI 或任何 Windows 机器上跑。
// 用法：node tests/unit.mjs
import assert from 'node:assert/strict';
import { parseKeyChord } from '../lib/keys.mjs';
import { decideLocked } from '../lib/guard.mjs';
import { findLine } from '../lib/ocr.mjs';
import { encodePng } from '../lib/png.mjs';

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
  assert.equal(decideLocked(1, { logonui: true, lockapp: false }).locked, false);
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

for (const p of pending) await p;

// ---- 结果 ---------------------------------------------------------------
if (fails.length) {
  console.error('FAILED ' + fails.length + ' / ' + (passed + fails.length));
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log('unit ok: ' + passed + ' tests');
