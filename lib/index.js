// dsh-desktop-sidecar — 原生 Windows 桌面控制工具（窗口枚举 / 截图 / OCR / 点击 / 输入 / 按键）
//
// 设计原则（都是踩坑换来的）：
//  - 截图走 in-process GDI BitBlt（8ms），不用驱动截图（会返回旧帧），也不起子进程
//  - 点击前必须先把窗口带到前台：发一次裸 ALT 解锁 Windows 前台锁，再 SetForegroundWindow
//  - 点击后必须用截图比对验证，没变化就重点一次，仍无变化就如实返回失败
//  - 文字输入走剪贴板 + 真实 Ctrl+V，绕开中文 IME
//  - OCR 复用 Windows.Media.Ocr（PowerShell 脚本，短生命周期，不阻塞 spawn）
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import * as win32 from './win32.mjs';
import { grabPng } from './capture.mjs';
import { decodePng, crop } from './png.mjs';
import { ocrBuffer, findLine } from './ocr.mjs';
import { uiaTree, uiaAct } from './uia.mjs';
import { courseTick } from './course.mjs';

export const inject = ['tools'];
export const name = 'dsh-desktop-sidecar';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 截图临时目录：启动清理 1 小时前的旧文件，避免长期占盘 */
const SHOT_DIR = join(tmpdir(), 'dsh-sidecar');
try {
  mkdirSync(SHOT_DIR, { recursive: true });
  const now = Date.now();
  for (const f of readdirSync(SHOT_DIR)) {
    const p = join(SHOT_DIR, f);
    try { if (now - statSync(p).mtimeMs > 3600_000) unlinkSync(p); } catch {}
  }
} catch {}

/** 输出必须是 lossless JSON：BigInt/undefined 都会让宿主校验失败 */
function plain(value) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? Number(v) : v === undefined ? null : v)));
}

/** 把作者 DSL 编译成原始 JSON Schema（宿主 register 需要的就是这个形状） */
function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, prop] of Object.entries(spec)) {
    if (prop?.required === true) required.push(key);
    const node = {};
    if (typeof prop?.type === 'string') node.type = prop.type;
    if (typeof prop?.description === 'string') node.description = prop.description;
    properties[key] = node;
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** 按 hwnd / 标题子串解析目标窗口 */
function resolveWindow(spec) {
  const ws = win32.listWindows({ onScreenOnly: false });
  if (spec === undefined || spec === null || spec === '') return null;
  if (typeof spec === 'number' || /^\d+$/.test(String(spec))) {
    const h = Number(spec);
    return ws.find((w) => Number(w.hwnd) === h) || { window: h, pid: 0, title: '' };
  }
  const needle = String(spec).toLowerCase();
  const hit = ws.filter((w) => (w.title || '').toLowerCase().includes(needle) && w.bounds.width > 0);
  if (!hit.length) throw new Error('no window matching "' + spec + '"');
  // 优先可见、面积大的窗口
  hit.sort((a, b) => (b.visible === a.visible ? b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height : b.visible ? 1 : -1));
  return hit[0];
}

function ensureForeground(hwnd) {
  win32.showWindow(hwnd, 9);
  for (let i = 0; i < 6; i++) {
    win32.focusWindowForce(hwnd);
    if (win32.foregroundWindow() === hwnd) return true;
  }
  return win32.foregroundWindow() === hwnd;
}

function windowClientRect(w) {
  const info = win32.clientInfo(w.hwnd);
  return { x: info.clientOrigin.x, y: info.clientOrigin.y, w: info.client.width, h: info.client.height };
}

const hash = (buf) => { let s = 0; for (let i = 0; i < buf.length; i += 37) s = (s * 31 + buf[i]) >>> 0; return s + ':' + buf.length; };

function captureWindow(w, maxDim) {
  const r = windowClientRect(w);
  if (r.w <= 0 || r.h <= 0) throw new Error('window has no client area (minimized?)');
  const out = grabPng(r.x, r.y, r.w, r.h, maxDim);
  return { ...out, rect: r };
}

function targetFile(path, ext = '.png') {
  if (path && isAbsolute(path)) return path;
  const dir = join(tmpdir(), 'dsh-sidecar');
  mkdirSync(dir, { recursive: true });
  return join(dir, (path ? String(path).replace(/[^\w.-]+/g, '_') : 'shot-' + Date.now()) + (path && path.endsWith(ext) ? '' : ext));
}

export function apply(ctx) {
  const outSchema = { type: 'object', additionalProperties: true };
  const textOutput = {
    schema: outSchema,
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
  const reg = (t) => ctx.tools.register({ ...t, parameters: compileParameters(t.parameters || {}), output: t.output || textOutput, execute: async (...args) => plain(await t.execute(...args)) });

  reg({
    name: 'desktop_windows',
    description: 'List top-level Windows desktop windows with hwnd, pid, title, bounds and visibility. Use it to discover the exact window to capture, read, click or type into. Filter by title substring and/or restrict to on-screen windows.',
    parameters: {
      filter: { type: 'string', description: 'Only windows whose title contains this text (case-insensitive).' },
      onScreenOnly: { type: 'boolean', description: 'Only windows currently on screen (default false).' },
      minWidth: { type: 'number', description: 'Only windows at least this wide (default 0).' },
      limit: { type: 'number', description: 'Maximum rows to return (default 40).' },
    },
    async execute({ filter, onScreenOnly, minWidth, limit }) {
      const all = win32.listWindows({ onScreenOnly: !!onScreenOnly });
      const f = filter ? String(filter).toLowerCase() : '';
      const seen = new Set();
      const SHELL = /^(TextInputHost|LockApp|NVIDIA Overlay|SearchHost|StartMenuExperienceHost|ShellExperienceHost|explorer)\.exe$/i;
      const rows = all
        .filter((w) => (!f || (w.title || '').toLowerCase().includes(f)) && w.bounds.width >= Math.max(minWidth || 0, 40) && w.bounds.height >= 40 && !SHELL.test(w.app || '') && !seen.has(w.hwnd) && seen.add(w.hwnd))
        .sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
        .slice(0, limit || 40)
        .map((w) => ({ hwnd: w.hwnd, pid: w.pid, app: w.app, title: w.title, bounds: w.bounds, visible: w.visible }));
      return { count: rows.length, windows: rows };
    },
  });

  reg({
    name: 'desktop_capture',
    description: 'Capture a window (or a screen region) to a PNG file using in-process GDI BitBlt and return its path and size. Prefer this over OS-level screenshot tools: it is fast (~10ms), never returns a stale frame, and captures exactly the target window client area.',
    parameters: {
      window: { type: 'string', description: 'Target window: hwnd (number as string) or a title substring. Omit to capture the whole screen region given by x/y/width/height.' },
      path: { type: 'string', description: 'Absolute PNG output path. Defaults to a temp file.' },
      maxDim: { type: 'number', description: 'Downscale so the longest side is at most this many pixels (optional).' },
      x: { type: 'number', description: 'Region left in screen pixels (only when window is omitted).' },
      y: { type: 'number', description: 'Region top in screen pixels.' },
      width: { type: 'number', description: 'Region width in pixels.' },
      height: { type: 'number', description: 'Region height in pixels.' },
    },
    async execute({ window, path, maxDim, x, y, width, height }) {
      let png, width2, height2, rect;
      if (window === undefined || window === null || window === '') {
        const w = Number(width || 0), h = Number(height || 0);
        if (!w || !h) throw new Error('desktop_capture needs a window, or width and height for a region');
        const out = grabPng(Number(x || 0), Number(y || 0), w, h, maxDim);
        png = out.png; width2 = out.width; height2 = out.height;
        rect = { x: Number(x || 0), y: Number(y || 0), w, h };
      } else {
        const w = resolveWindow(window);
        if (!w) throw new Error('window not found: ' + window);
        const out = captureWindow(w, maxDim);
        png = out.png; width2 = out.width; height2 = out.height; rect = out.rect;
      }
      const file = targetFile(path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
      return { path: file, bytes: png.length, width: width2, height: height2, rect };
    },
  });

  reg({
    name: 'desktop_read',
    description: 'Read the text of a window via Windows built-in OCR (Windows.Media.Ocr, offline) and return lines with their boxes. Optionally pass query to also return the best matching line — matching tolerates OCR confusions (形近字/繁体/漏字). Use the returned x/y/w/h with desktop_click to click precisely.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      query: { type: 'string', description: 'Optional text to locate inside the OCR result; the response then includes match.' },
      maxDim: { type: 'number', description: 'Downscale before OCR to speed it up (default 1400).' },
      limit: { type: 'number', description: 'Maximum lines returned (default 80).' },
    },
    async execute({ window, query, maxDim, limit }) {
      const w = resolveWindow(window);
      if (!w) throw new Error('window not found: ' + window);
      if (!ensureForeground(w.hwnd)) throw new Error('cannot bring window to foreground: ' + (w.title || w.hwnd));
      await sleep(120);
      const cap = captureWindow(w, maxDim || 0);
      const t0 = Date.now();
      const res = ocrBuffer(cap.png, { scale: 1.2, prep: true });
      // OCR 坐标在 cap.png 像素空间；capture 可能因 maxDim 缩小过，换算回客户区像素再返回
      const kx = cap.width ? cap.rect.w / cap.width : 1;
      const ky = cap.height ? cap.rect.h / cap.height : 1;
      const toClient = (l) => ({ text: l.text, x: Math.round(l.x * kx), y: Math.round(l.y * ky), w: Math.round(l.w * kx), h: Math.round(l.h * ky) });
      const lines = (res.lines || []).slice(0, limit || 80).map(toClient);
      const out = { window: w.hwnd, title: w.title, rect: cap.rect, count: lines.length, ocrMs: Date.now() - t0, lines };
      if (query) {
        const hit = findLine(res, query);
        out.match = hit ? toClient(hit) : null;
      }
      return out;
    },
  });

  reg({
    name: 'desktop_click',
    description: 'Click inside a window. Target either by text (OCR locates it — recommended, resilient to layout shifts) or by pixel/fractional coordinates. The window is focused first, a bare ALT unlocks the Windows foreground lock, and the click is verified by screenshot comparison (retried once). Returns changed=false with a hint when the UI did not react.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      text: { type: 'string', description: 'Text to locate via OCR and click its centre.' },
      x: { type: 'number', description: 'Client-area x in pixels (alternative to text).' },
      y: { type: 'number', description: 'Client-area y in pixels.' },
      fx: { type: 'number', description: 'Fractional x in 0..1 of the client area (alternative to x).' },
      fy: { type: 'number', description: 'Fractional y in 0..1.' },
      force: { type: 'boolean', description: 'Return ok even when no visual change was detected.' },
    },
    async execute({ window, text, x, y, fx, fy, force }) {
      const w = resolveWindow(window);
      if (!w) throw new Error('window not found: ' + window);
      const fgOk = ensureForeground(w.hwnd);
      await sleep(120);
      const cap = captureWindow(w, 1400);
      const rect = cap.rect;
      let cx, cy, hitText = null;
      if (text) {
        const res = ocrBuffer(cap.png, { scale: 1.5, prep: true });
        const hit = findLine(res, text);
        if (!hit) {
          const uia = (() => { try { const t = uiaTree(w.hwnd, { depth: 5, max: 60 }); return (t.elements || []).filter((e) => e.pats && e.pats.length && e.name); } catch { return []; } })();
          return { ok: false, error: 'text not found', tried: text, lines: (res.lines || []).slice(0, 14).map((l) => l.text), uiaCandidates: uia.slice(0, 10).map((e) => e.role + ':' + e.name), hint: uia.length ? 'OCR 没找到这段文字，但这个窗口有 UIA 控件：改用 desktop_invoke（更准）或从 uiaCandidates 里挑名字' : 'OCR 与 UIA 都没找到，先用 desktop_read 看窗口里到底有什么' };
        }
        // OCR 坐标在 cap.png 像素空间；换算回客户区（rect）再换成屏幕坐标
        const kx = cap.width ? rect.w / cap.width : 1;
        const ky = cap.height ? rect.h / cap.height : 1;
        cx = rect.x + Math.round((hit.x + hit.w / 2) * kx);
        cy = rect.y + Math.round((hit.y + hit.h / 2) * ky);
        hitText = hit.text;
      } else if (fx !== undefined || fy !== undefined) {
        cx = rect.x + Math.round((fx ?? 0.5) * rect.w);
        cy = rect.y + Math.round((fy ?? 0.5) * rect.h);
      } else if (x !== undefined && y !== undefined) {
        cx = rect.x + Number(x);
        cy = rect.y + Number(y);
      } else {
        throw new Error('desktop_click needs text, fx/fy, or x/y');
      }
      if (!fgOk) {
        const sx = cx, sy = cy;
        const posted = win32.postClick(sx, sy);
        await sleep(350);
        return { ok: posted, window: w.hwnd, title: w.title, text: hitText, at: { x: sx, y: sy }, changed: null, retried: false, via: 'postmessage', hint: '窗口抢不到前台：已用后台消息点击（菜单类可能无效；可先手动激活窗口或加 force）' };
      }
      const probe = { x: Math.max(0, cx - 60), y: Math.max(0, cy - 40), w: Math.min(520, rect.x + rect.w - cx + 60), h: Math.min(420, rect.y + rect.h - cy + 40) };
      const before = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
      win32.screenClick(cx, cy);
      await sleep(450);
      let after = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
      let retried = false;
      if (before === after) {
        win32.screenClick(cx, cy);
        await sleep(550);
        after = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
        retried = true;
      }
      const changed = before !== after;
      const inClient = cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
      return { ok: changed || force === true || (inClient && retried), window: w.hwnd, title: w.title, text: hitText, at: { x: cx, y: cy }, changed, retried, inClient, hint: changed ? undefined : (inClient ? '界面无变化：坐标在窗口内，通常是文本区点击（光标已移动即视为成功）；若是按钮/菜单请改用 desktop_key 或加 force' : '坐标落在窗口外或被遮挡，检查 window 与坐标') };
    },
  });

  reg({
    name: 'desktop_type',
    description: 'Type text into a window by putting it on the clipboard and sending a real Ctrl+V (works with Chinese and any IME). The window is focused first. Use desktop_click to place the caret before typing when the field is not already focused.',
    parameters: {
      window: { type: 'string', description: 'Target window: hwnd or title substring. Omit to type into whatever is focused.' },
      text: { type: 'string', required: true, description: 'Text to paste.' },
      submit: { type: 'boolean', description: 'Press Enter after pasting (default false).' },
    },
    async execute({ window, text, submit }) {
      let hwnd = null, rect = null;
      if (window) {
        const w = resolveWindow(window);
        if (!w) throw new Error('window not found: ' + window);
        hwnd = w.hwnd;
        if (!ensureForeground(hwnd)) {
          const ed0 = win32.findEditableChild(hwnd);
          if (ed0) { win32.setClipboardText(String(text)); await sleep(350); win32.sendPaste(ed0.hwnd); await sleep(200); if (submit) { win32.pressCombo(0x0d, false, false, false); } return { ok: true, typed: String(text).length, hwnd, submit: !!submit, changed: null, via: 'wm_paste-bg:' + ed0.cls, hint: '窗口未能抢到前台，已用后台消息直接粘贴（部分应用可能无效）' }; }
          throw new Error('cannot bring window to foreground (前台锁/权限) and no editable child found');
        }
        await sleep(120);
        rect = windowClientRect(w);
      }
      // 剪贴板写入后必须留足时间再发 Ctrl+V：实测 80ms 时 Notepad 的 RichEdit 会静默粘不上，350~500ms 稳定
      const before = rect && rect.w > 0 ? hash(grabPng(rect.x, rect.y, rect.w, rect.h, 1200).png) : null;
      win32.setClipboardText(String(text));
      await sleep(450);
      let via = 'key';
      try { const ed = win32.findEditableChild(hwnd || win32.foregroundWindow()); if (ed) { win32.sendPaste(ed.hwnd); via = 'wm_paste:' + ed.cls; } else { win32.pressCombo(0x56, true, false, false); } } catch { win32.pressCombo(0x56, true, false, false); }
      await sleep(220);
      if (via.startsWith('wm_paste') === false) { }
      await sleep(260);
      if (submit) { win32.pressCombo(0x0d, false, false, false); await sleep(150); }
      let changed = null;
      if (before !== null) changed = hash(grabPng(rect.x, rect.y, rect.w, rect.h, 1200).png) !== before;
      return {
        ok: true, typed: String(text).length, hwnd, submit: !!submit, changed, via,
        hint: changed === false ? '粘贴后画面无变化：焦点可能不在输入框，先 desktop_click 定位，再用 desktop_key ctrl+v' : undefined,
      };
    },
  });

  reg({
    name: 'desktop_key',
    description: 'Press a key or key chord in a window (e.g. enter, tab, esc, ctrl+a, ctrl+shift+s, f5). The window is focused first. Useful for menus, dialogs and shortcuts that cannot be clicked reliably.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key or chord, e.g. "enter", "esc", "ctrl+a", "alt+f4".' },
      window: { type: 'string', description: 'Target window: hwnd or title substring. Omit to send to the focused window.' },
      repeat: { type: 'number', description: 'How many times to press (default 1).' },
    },
    async execute({ key, window, repeat }) {
      if (window) {
        const w = resolveWindow(window);
        if (!w) throw new Error('window not found: ' + window);
        if (!ensureForeground(w.hwnd)) throw new Error('cannot bring window to foreground');
        await sleep(120);
      }
      const map = { enter: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, insert: 0x2d };
      const parts = String(key).toLowerCase().split('+');
      const main = parts.pop();
      const mods = new Set(parts);
      const vk = map[main] ?? (/^f\d{1,2}$/.test(main) ? 0x6f + Number(main.slice(1)) : main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0);
      if (!vk) throw new Error('unknown key: ' + key);
      const n = Math.max(1, Math.min(20, Number(repeat || 1)));
      for (let i = 0; i < n; i++) {
        win32.pressCombo(vk, mods.has('ctrl') || mods.has('control'), mods.has('shift'), mods.has('alt'));
        await sleep(80);
      }
      return { ok: true, key, mods: [...mods], repeat: n };
    },
  });
  reg({
    name: 'desktop_tree',
    description: 'Read the UI Automation (UIA) control tree of a window: role, name, screen rectangle and supported patterns (Invoke/Toggle/SelectionItem/ExpandCollapse/Value/Text). Prefer this over OCR for native Win32/WPF/UWP apps — it is exact, fast and works even when the window is partly covered. Returns [] for apps with no UIA provider (Electron/Qt draw their own UI) — fall back to desktop_read (OCR) there.',
    output: textOutput,
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or title substring.' },
      depth: { type: 'number', description: 'Max depth (default 3, max 12).' },
      max: { type: 'number', description: 'Max elements (default 80).' },
      query: { type: 'string', description: 'Only return elements whose name contains this text.' },
    },
    async execute({ window, depth, max, query }) {
      const w = resolveWindow(window);
      if (!w) throw new Error('window not found: ' + window);
      const t0 = Date.now();
      const res = uiaTree(w.hwnd, { depth: depth ?? 3, max: max ?? 80 });
      let els = res.elements || [];
      const q = String(query || '').toLowerCase();
      if (q) els = els.filter((e) => String(e.name || '').toLowerCase().includes(q));
      const out = { ok: true, window: w.hwnd, title: res.title || w.title, count: els.length, ms: Date.now() - t0, elements: els };
      const ACT = new Set(['Button', 'MenuItem', 'CheckBox', 'RadioButton', 'Edit', 'ComboBox', 'TabItem', 'ListItem', 'TreeItem', 'Hyperlink', 'SplitButton', 'Slider', 'Spinner']);
      const actionable = els.filter((e) => ACT.has(e.role) || (e.name && e.pats && e.pats.length > 1)).length;
      if (!actionable && !q) {
        // Electron / Qt 等自绘界面没有 UIA provider：直接给一次 OCR 摘要，省掉模型自己再试一轮
        try {
          const cap = captureWindow(w, 1200);
          const r = ocrBuffer(cap.png, { scale: 1.2, prep: true });
          out.uia = 'empty';
          out.fallback = 'ocr';
          out.ocrSample = (r.lines || []).slice(0, 12).map((l) => l.text);
          out.hint = '此窗口没有 UIA 控件树（Electron/Qt/自绘界面）。改用 desktop_read 读全文，或用 desktop_click 的 text 参数按 OCR 文字点击。';
        } catch (e) {
          out.hint = '此窗口没有 UIA 控件树，且 OCR 采样失败：' + (e && e.message);
        }
      }
      return plain(out);
    },
  });

  reg({
    name: 'desktop_invoke',
    description: 'Trigger a UIA control by its name — Invoke a button/menu item, Toggle a checkbox, Select a tab/list item, Expand a menu, or Focus an input. This is the most reliable way to press a control: it does not move the mouse or need the window in front. Use desktop_tree first to see which names and patterns exist.',
    output: textOutput,
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or title substring.' },
      text: { type: 'string', required: true, description: 'Visible name of the control (case-insensitive substring).' },
      action: { type: 'string', description: 'invoke | toggle | select | expand | focus (default invoke).' },
      depth: { type: 'number', description: 'Search depth (default 6).' },
    },
    async execute({ window, text, action, depth }) {
      const w = resolveWindow(window);
      if (!w) throw new Error('window not found: ' + window);
      const t0 = Date.now();
      const res = uiaAct(w.hwnd, { match: text, action: action || 'invoke', depth: depth ?? 6 });
      return plain({ ok: !!(res.ok && res.done), window: w.hwnd, title: w.title, matched: res.matched, action: res.action, patterns: res.patterns, done: !!res.done, error: res.error, ms: Date.now() - t0 });
    },
  });

  reg({
    name: 'desktop_doctor',
    description: '诊断本机是否具备桌面控制条件：平台 / OCR 引擎与语言 / 前台锁 / 可见窗口数 / 可编辑控件。首次使用前先跑一次，失败项会给出修复建议。',
    parameters: {},
    async execute() {
      const checks = [];
      const add = (id, ok, detail, hint) => checks.push({ id, ok, detail, hint: ok ? undefined : hint });
      add('platform', process.platform === 'win32', process.platform, '本插件只支持 Windows');
      try {
        const cands = win32.listWindows({ onScreenOnly: true }).filter((x) => x.bounds.width > 400 && x.bounds.height > 200);
        const w = cands.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
        if (!w) throw new Error('no visible window');
        const cap = captureWindow(w, 0);
        const r = ocrBuffer(cap.png, { scale: 1.3, prep: true });
        add('ocr', (r.lines || []).length > 0, `${(r.lines || []).length} 行 / ${r.ocrMs ?? 0}ms / ${r.language || '?'}`, '确认系统已安装「中文(简体)」OCR 语言包（设置 → 时间和语言 → 语言）');
      } catch (e) { add('ocr', false, String(e && e.message || e), '同上；若报 OCR 脚本缺失，重装插件'); }
      try {
        const cands = win32.listWindows({ onScreenOnly: true }).filter((x) => x.bounds.width > 400 && x.bounds.height > 200);
        const w = cands.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
        const own = Number(win32.foregroundWindow());
        const cands2 = win32.listWindows({ onScreenOnly: true }).filter((x) => x.bounds.width > 400 && x.bounds.height > 200 && (x.title || '').trim() && !/^(TextInputHost|LockApp|NVIDIA Overlay|SearchHost|StartMenuExperienceHost|ShellExperienceHost)\.exe$/i.test(x.app || ''));
        const wf = (cands2.find((x) => Number(x.hwnd) === own) || cands2[0] || w);
        const f = ensureForeground(wf.hwnd);
        add('foreground', !!f, f ? '可抢前台' : '被系统拒绝', '用管理员运行 DSH，或关闭 UAC 安全桌面/全屏独占程序');
      } catch (e) { add('foreground', false, String(e && e.message || e), '同上'); }
      try {
        const ws = win32.listWindows({ onScreenOnly: true }).slice(0, 10);
        let found = null;
        for (const w of ws) { const ed = win32.findEditableChild(w.hwnd); if (ed) { found = { ...ed, title: w.title }; break; } }
        add('editable-child', true, found ? `${found.cls} 在「${found.title}」` : '当前没有带输入框的窗口（本次不用输入即可）', null);
      } catch (e) { add('editable-child', true, '跳过: ' + String(e && e.message || e), null); }
      const okAll = checks.every((c) => c.ok);
      return { ok: okAll, checks, windows: win32.listWindows({ onScreenOnly: true }).length, note: okAll ? '可以直接使用' : '按 hint 修复后重跑 desktop_doctor' };
    },
  });

  reg({
    name: 'desktop_course',
    description: '平台无关的网课盯课：帧差判断是否在播放、自动点播放恢复、按词表切下一节、遇到弹题按 onQuiz 处理（ask=返回题目交给人决定 / auto=自行作答 / skip=关闭弹窗 / pause=暂停等人）。只作用于用户已打开的课程页，不登录、不猜题。',
    parameters: {
      window: { type: 'string', description: '课程窗口标题片段；省略则取当前前台窗口。' },
      rounds: { type: 'number', description: '本轮盯课轮数，默认 5。' },
      interval: { type: 'number', description: '轮询间隔毫秒，默认 4000。' },
      onQuiz: { type: 'string', description: 'ask | auto | skip | pause，默认 ask。' },
      nextWords: { type: 'array', items: { type: 'string' }, description: '自定义「下一节」按钮文字，覆盖内置词表。' },
      dryRun: { type: 'boolean', description: '只观察不点击。' },
    },
    async execute({ window, rounds, interval, onQuiz, nextWords, dryRun }) {
      const ws = win32.listWindows({ onScreenOnly: true });
      let w = null;
      if (window) w = resolveWindow(window);
      if (!w) w = ws.find((x) => Number(x.hwnd) === Number(win32.foregroundWindow())) || ws.filter((x) => x.bounds.width * x.bounds.height > 200000).sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] || ws[0];
      if (!w) throw new Error('no visible window found');
      const res = await courseTick({
        hwnd: w.hwnd,
        rounds: Number(rounds) || 5,
        interval: Number(interval) || 4000,
        onQuiz: onQuiz || 'ask',
        nextWords,
        dryRun: !!dryRun,
      });
      return { ...res, window: { hwnd: w.hwnd, title: w.title } };
    },
  });
}
