// 干净安装验证：只用打包出来的 lib + 独立安装的依赖，模拟真实用户
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const dir = process.argv[2];
const mod = await import(pathToFileURL(join(dir, 'lib/index.js')).href);

const tools = new Map();
let imageCalls = 0;
const ctx = {
  tools: { register: (d) => { tools.set(d.name, d); return d; } },
  attachments: {
    saveImage: async ({ data, mediaType, name }) => {
      imageCalls += 1;
      return { attachmentId: 'att_' + name, mediaType, bytes: data.length, width: 1600, height: 900 };
    },
  },
};

const t0 = Date.now();
mod.apply(ctx);
console.log('apply ok in', Date.now() - t0, 'ms →', tools.size, 'tools:', [...tools.keys()].join(','));

const run = async (name, args = {}) => {
  const t = tools.get(name);
  if (!t) throw new Error('missing tool ' + name);
  const started = Date.now();
  const v = await t.execute(args, {});
  const parts = t.output.render(args, v).map((p) => p.type);
  const ms = Date.now() - started;
  console.log(`  ${name}: ${ms}ms parts=${parts.join('+')}`);
  return v;
};

// 参数校验：每个工具都必须有合法 inputSchema 与 output schema
for (const [n, t] of tools) {
  const p = t.parameters;
  if (!p || p.type !== 'object' || !p.properties) throw new Error(n + ' bad parameters schema');
  if (!t.output || !t.output.schema || typeof t.output.render !== 'function') throw new Error(n + ' bad output contract');
  for (const [k, f] of Object.entries(p.properties)) {
    if (!f.type && !f.anyOf) throw new Error(n + '.' + k + ' missing type');
  }
}
console.log('schema check ok for all', tools.size, 'tools');

const win = await run('desktop_windows', { limit: 3 });
console.log('  windows sample:', win.windows.length ? win.windows[0].app + ' / ' + win.windows[0].title : 'none');

await run('desktop_capture', { desktop: true, maxDim: 640, ruler: false });
await run('desktop_doctor', {});
console.log('image attachments requested:', imageCalls);
console.log('CLEAN-INSTALL OK');
