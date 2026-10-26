// 本地烟测：用假的 ctx 加载插件，验证工具注册 + 运行时（不需要重启 DSH）
import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL('C:/Users/xjy/.dsh/profiles/desktop/node_modules/dsh-desktop-sidecar/lib/index.js').href);
const tools = new Map();
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return def; } },
  attachments: {
    saveImage: async ({ data, mediaType, name }) => ({ attachmentId: 'att_' + name, mediaType, bytes: data.length, width: 100, height: 100 }),
  },
};
mod.apply(ctx);
console.log('tools:', [...tools.keys()].join(', '));

const call = async (name, args) => {
  const t = tools.get(name);
  const t0 = Date.now();
  const v = await t.execute(args, {});
  const out = t.output.render(args, v);
  console.log('\n==', name, (Date.now() - t0) + 'ms', 'parts=' + out.map((p) => p.type).join('+'));
  return { v, out };
};

const win = await call('desktop_windows', { limit: 5 });
console.log(JSON.stringify(win.v.windows.slice(0, 3)));

const cap = await call('desktop_capture', { window: 'Notepad', maxDim: 900 });
console.log('capture:', JSON.stringify({ w: cap.v.width, h: cap.v.height, rect: cap.v.rect, scale: cap.v.scale, dpi: cap.v.dpi, unchanged: cap.v.unchanged, image: !!cap.v.image }));

const cap2 = await call('desktop_capture', { window: 'Notepad', maxDim: 900 });
console.log('second capture unchanged =', cap2.v.unchanged, 'image =', !!cap2.v.image);

const tree = await call('desktop_tree', { window: 'Notepad', max: 12 });
console.log('tree:', JSON.stringify({ controlTotal: tree.v.controlTotal, returned: tree.v.returned, filteredOut: tree.v.filteredOut }));
console.log('first elements:', tree.v.elements.slice(0, 3).map((e) => e.index + ':' + e.role + ':' + e.name).join(' | '));

const dry = await call('desktop_sequence', { window: 'Notepad', dryRun: true, steps: [{ action: 'focus' }, { action: 'click', text: 'File' }, { action: 'type', text: 'hello', submit: true }] });
console.log('sequence dryRun:', JSON.stringify(dry.v.log.map((l) => l.would)));

const doc = await call('desktop_doctor', {});
console.log('doctor ok=', doc.v.ok, doc.v.checks.map((c) => c.id + '=' + c.ok).join(' '));
