// 冒烟测试：用假的 host 启动插件，检查工具注册、schema、以及几个「只读」工具真能跑通。
// 不会点击、不会打字、不会把任何窗口抢到前台。用法：node tests/smoke.mjs
import assert from 'node:assert/strict';

const mod = await import(new URL('../lib/index.js', import.meta.url).href);
const tools = new Map();
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return d; } },
  attachments: { saveImage: async ({ name }) => ({ attachmentId: 'att_' + name, mediaType: 'image/png', bytes: 1 }) },
};

const t0 = Date.now();
mod.apply(ctx);
const applyMs = Date.now() - t0;

assert.ok(tools.size >= 19, 'expected at least 19 tools, got ' + tools.size);
const expect = [
  'desktop_windows', 'desktop_look', 'desktop_capture', 'desktop_click', 'desktop_type', 'desktop_key',
  'desktop_read', 'desktop_text', 'desktop_wait', 'desktop_launch', 'desktop_tree', 'desktop_invoke',
  'desktop_scroll', 'desktop_drag', 'desktop_window', 'desktop_sequence', 'desktop_doctor',
  'desktop_log', 'desktop_course',
];
for (const n of expect) assert.ok(tools.has(n), 'missing tool ' + n);

for (const [name, t] of tools) {
  assert.equal(t.parameters && t.parameters.type, 'object', name + ': bad parameters schema');
  assert.ok(t.parameters.properties, name + ': no properties');
  assert.ok(t.output && t.output.schema && typeof t.output.render === 'function', name + ': bad output contract');
  assert.ok(typeof t.description === 'string' && t.description.length > 20, name + ': thin description');
  assert.equal(typeof t.execute, 'function', name + ': no execute');
}

const run = (name, args = {}) => tools.get(name).execute(args, {});
const t1 = Date.now();
const win = await run('desktop_windows', { onScreenOnly: true });
const windowsMs = Date.now() - t1;
assert.ok(Array.isArray(win.windows), 'windows list missing');
for (const w of win.windows) {
  assert.equal(typeof w.hwnd, 'number');
  assert.ok(w.bounds && typeof w.bounds.width === 'number');
}
tools.get('desktop_windows').output.render({}, win);

const doc = await run('desktop_doctor', {});
assert.ok(typeof doc.ok === 'boolean', 'doctor missing ok');
tools.get('desktop_doctor').output.render({}, doc);

const log = await run('desktop_log', { limit: 5 });
assert.ok(Array.isArray(log.entries), 'log entries missing');
tools.get('desktop_log').output.render({}, log);

// 每个工具都必须把结果渲染成至少一个 part（否则模型那边会是空回复）
const sample = { ok: true, error: 'sample', hint: 'sample' };
for (const [name, t] of tools) {
  const parts = t.output.render({}, sample);
  assert.ok(Array.isArray(parts) && parts.length > 0, name + ': render returned nothing');
  for (const p of parts) assert.ok(p && typeof p.type === 'string', name + ': bad part');
}

console.log(
  'smoke ok: ' + tools.size + ' tools, apply ' + applyMs + 'ms, windows ' + windowsMs + 'ms, doctor ' + doc.ok,
);
