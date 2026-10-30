// dsh-desktop-sidecar — 原生 Windows 桌面控制工具（窗口枚举 / 截图 / OCR / 点击 / 输入 / 按键）
//
// 设计原则（都是踩坑换来的）：
//  - 截图走 in-process GDI BitBlt（8ms），不用驱动截图（会返回旧帧），也不起子进程
//  - 点击前必须先把窗口带到前台：发一次裸 ALT 解锁 Windows 前台锁，再 SetForegroundWindow
//  - 点击后必须用截图比对验证，没变化就重点一次，仍无变化就如实返回失败
//  - 文字输入走剪贴板 + 真实 Ctrl+V，绕开中文 IME
//  - OCR 复用 Windows.Media.Ocr（PowerShell 脚本，短生命周期，不阻塞 spawn）
import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import * as win32 from './win32.mjs';
import { grabPng, grabScreen, downscale as downscaleImg } from './capture.mjs';
import { decodePng, crop, encodePng } from './png.mjs';
import { ocrBuffer, findLine, sweepOcrTemps } from './ocr.mjs';
import { uiaTree, uiaAct, findControl, uiaText, uiaSetValue } from './uia.mjs';
import { parseKeyChord } from './keys.mjs';
import { courseTick } from './course.mjs';
import { initDpi, dpiForWindow, virtualScreen, monitors } from './dpi.mjs';
import { drawRuler } from './ruler.mjs';
import { annotate } from './marks.mjs';
import { runSequence } from './sequence.mjs';
import { pulse, settle, hideNow, consumeEsc, escPending } from './activity.mjs';
import { logTool } from './activity.mjs';
import { refusalFor, secureDesktop } from './guard.mjs';
import { readLog, clearLog } from './actions-log.mjs';

export const inject = ['tools', 'attachments'];
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

/** 没给 window 时用前台窗口（对新手最常用的"就操作我现在看到的"） */
function resolveWindowDefault(spec) {
  if (spec !== undefined && spec !== null && spec !== '') return resolveWindow(spec);
  const fg = win32.foregroundWindow();
  const ws = win32.listWindows();
  const w = ws.find((x) => Number(x.hwnd) === Number(fg));
  if (w) return w;
  const big = ws.filter((x) => x.visible && x.bounds.width > 400 && x.bounds.height > 300)
    .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
  if (big) return big;
  throw new Error('no window to operate on: pass window (hwnd or a title substring)');
}

let LAST_AMBIG = null;

// 中文习惯叫法和窗口真实标题经常对不上（记事本 → Notepad），按这张小表兜一下
const WINDOW_ALIASES = [
  ['记事本', 'notepad'],
  ['计算器', 'calculator', 'calc'],
  ['画图', 'mspaint', 'paint'],
  ['资源管理器', 'explorer', '文件资源管理器'],
  ['任务管理器', 'taskmgr'],
  ['设置', 'settings'],
  ['终端', 'terminal', 'windowsterminal', 'powershell', 'cmd'],
  ['命令提示符', 'cmd', '命令提示符'],
  ['微信', 'wechat', 'weixin'],
  ['浏览器', 'msedge', 'chrome', 'firefox', 'edge'],
  ['解压', 'winrar', '7zfm', 'bandizip'],
  ['录屏', 'obs'],
];
function aliasNeedles(spec) {
  const q = String(spec).toLowerCase();
  const out = [];
  for (const row of WINDOW_ALIASES) {
    if (row.some((t) => t.toLowerCase() === q || String(spec).includes(t))) {
      for (const t of row) if (!out.includes(t.toLowerCase())) out.push(t.toLowerCase());
    }
  }
  return out.filter((x) => x !== q);
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
  const matchBy = (n) => ws.filter((w) => ((w.title || '').toLowerCase().includes(n) || String(w.app || '').toLowerCase().includes(n)) && w.bounds.width > 0);
  let hit = matchBy(needle);
  let usedAlias = null;
  if (!hit.length) {
    for (const alt of aliasNeedles(spec)) {
      const got = matchBy(alt);
      if (got.length) { hit = got; usedAlias = alt; break; }
    }
  }
  if (!hit.length) {
    // 把当前可见窗口标题回给模型，便于它改用正确名字重试（而不是让用户猜）
    const hint = ws
      .filter((w) => w.title && w.bounds.width > 200 && w.bounds.height > 120)
      .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
      .slice(0, 8)
      .map((w) => '  - ' + w.title)
      .join('\n');
    throw new Error('no window matching "' + spec + '". Visible windows:\n' + (hint || '  (none)'));
  }
  // 优先可见、面积大的窗口
  hit.sort((a, b) => (b.visible === a.visible ? b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height : b.visible ? 1 : -1));
  if (usedAlias) hit[0] = { ...hit[0], matchedByAlias: usedAlias };
  // 只把「真正看得见」的窗口当作歧义来源：后台隐藏窗口（很多应用会留一堆）不该淹没提示
  const seen = hit.filter((w) => w.visible);
  if (seen.length > 1) {
    // 同一个名字命中多个可见窗口：仍然按最靠前的用，但把这件事告诉调用方，避免默默操作错窗口
    LAST_AMBIG = {
      spec: String(spec),
      count: seen.length,
      used: { hwnd: hit[0].hwnd, title: hit[0].title },
      candidates: seen.slice(0, 6).map((w) => ({ hwnd: w.hwnd, title: String(w.title || '').slice(0, 60) })),
    };
  }
  return hit[0];
}

/** 记住一条操作的摘要（不含大字段），写进 actions.jsonl。 */
function brief(o) {
  if (!o || typeof o !== 'object') return o;
  const keys = ['window', 'title', 'text', 'matched', 'at', 'via', 'changed', 'retried', 'key', 'typed', 'ok', 'error', 'steps', 'executed', 'failed', 'ambiguous', 'name', 'control'];
  const out = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
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

// 最近一次 desktop_look 的控件表：让 desktop_click{ref:'e7'} 免掉又一次树读取。
const LAST_LOOK = { hwnd: null, at: 0, controls: [] };
function rememberLook(hwnd, controls) {
  LAST_LOOK.hwnd = hwnd;
  LAST_LOOK.at = Date.now();
  LAST_LOOK.controls = controls.map((c) => ({ ref: c.ref, n: c.n, role: c.role, name: c.name, rect: c.rect, pats: c.pats }));
}
function lookupRef(hwnd, ref) {
  const id = String(ref || '').trim().toLowerCase();
  if (!id) return null;
  if (!LAST_LOOK.controls.length) return { error: 'no refs yet: run desktop_look first, then click by the ref it printed' };
  if (LAST_LOOK.hwnd && hwnd && LAST_LOOK.hwnd !== hwnd) {
    return { error: 'those refs belong to another window; run desktop_look on this window again' };
  }
  const hit = LAST_LOOK.controls.find((c) => c.ref === id || String(c.n) === id);
  if (!hit) return { error: 'ref ' + ref + ' is not in the last desktop_look result (it listed ' + LAST_LOOK.controls.length + ' controls)' };
  return { hit };
}
const BROWSER_RX = /^(msedge|chrome|brave|firefox|opera|vivaldi|360se|qqbrowser|sogouexplorer|librewolf)/i;
function isBrowserApp(app) { return BROWSER_RX.test(String(app || '')); }

/** 等一个新窗口的控件树稳定下来：刚出现的窗口常常先给半棵树，过 200~600ms 才补齐。 */
async function waitTreeReady(hwnd, { timeoutMs = 1600, need = 6 } = {}) {
  const t0 = Date.now();
  let prev = -1;
  while (Date.now() - t0 < timeoutMs) {
    let n = 0;
    try { n = (uiaTree(hwnd, { depth: 4, max: 200 }).elements || []).length; } catch { n = 0; }
    if (n >= need && n === prev) return { ready: true, count: n, ms: Date.now() - t0 };
    prev = n;
    await sleep(140);
  }
  return { ready: false, count: prev > 0 ? prev : 0, ms: Date.now() - t0 };
}

function treeSignature(hwnd) {
  try {
    const t = uiaTree(hwnd, { depth: 4, max: 400 });
    const els = t.elements || [];
    let h = 5381;
    for (const e of els) {
      const line = e.role + '|' + (e.name || '') + '|' + e.x + ',' + e.y + ',' + e.w + ',' + e.h;
      for (let i = 0; i < line.length; i++) h = ((h * 33) ^ line.charCodeAt(i)) >>> 0;
    }
    return els.length + ':' + h.toString(16);
  } catch { return null; }
}

function targetFile(path, ext = '.png') {
  if (path && isAbsolute(path)) return path;
  const dir = join(tmpdir(), 'dsh-sidecar');
  mkdirSync(dir, { recursive: true });
  return join(dir, (path ? String(path).replace(/[^\w.-]+/g, '_') : 'shot-' + Date.now()) + (path && path.endsWith(ext) ? '' : ext));
}

const BUSY = { kind: null, since: 0 };

/** 同一时间只让一个桌面动作跑，避免两个对话抢鼠标键盘。 */
async function withBusy(kind, fn) {
  if (BUSY.kind) {
    return {
      ok: false, blocked: 'busy', busyWith: BUSY.kind, busyMs: Date.now() - BUSY.since,
      hint: 'Another desktop action is already running. Wait for it to finish, or ask the user to press Esc to stop it.',
    };
  }
  BUSY.kind = kind; BUSY.since = Date.now();
  try { return await fn(); } finally { BUSY.kind = null; BUSY.since = 0; }
}

export function apply(ctx) {
  const outSchema = { type: 'object', additionalProperties: true };
  const textOutput = {
    schema: outSchema,
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  };
  const LITE = String(process.env.DSH_SIDECAR_TOOLS || '').toLowerCase();
  const LITE_ALLOW = new Set(['desktop_windows', 'desktop_look', 'desktop_capture', 'desktop_click', 'desktop_type', 'desktop_key', 'desktop_read', 'desktop_wait', 'desktop_launch', 'desktop_doctor', 'desktop_log']);
  const reg = (t) => {
    if (LITE === 'lite' && !LITE_ALLOW.has(t.name)) return null;
    return ctx.tools.register({
      ...t,
      parameters: compileParameters(t.parameters || {}),
      output: t.output || textOutput,
      execute: async (...args) => {
        LAST_AMBIG = null;
        const value = await (t.lock ? withBusy(t.name, () => t.execute(...args)) : t.execute(...args));
        const out = plain(value);
        if (LAST_AMBIG && out && typeof out === 'object' && out.ok !== false) {
          out.windowAmbiguous = LAST_AMBIG.candidates;
          out.windowUsed = LAST_AMBIG.used;
          const note = LAST_AMBIG.count + ' windows match "' + LAST_AMBIG.spec + '"; used hwnd ' + LAST_AMBIG.used.hwnd + ' (' + LAST_AMBIG.used.title + '). Pass an exact hwnd to target another one.';
          out.hint = out.hint ? out.hint + ' | ' + note : note;
          LAST_AMBIG = null;
        }
        return out;
      },
    });
  };

  // DPI 感知必须在任何截图 / 坐标计算之前执行，否则 125%/150% 缩放下坐标全偏
  const dpiState = initDpi();
  // 启动时清掉旧版本泄漏的 OCR 临时目录（issue #2），只删 1 小时前的
  try { sweepOcrTemps(3600_000); } catch {}

  /** 把 PNG 交给宿主 attachments：render 里用 { type:'image', attachment } 让模型直接看到图，省一次 read_image */
  const attach = async (png, name) => {
    try {
      if (!ctx.attachments || typeof ctx.attachments.saveImage !== 'function') return null;
      const ref = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: name || 'desktop-' + Date.now() + '.png' });
      return { attachmentId: ref.attachmentId, mediaType: ref.mediaType || 'image/png', bytes: ref.bytes, width: ref.width, height: ref.height };
    } catch { return null; }
  };
  const imageOutput = {
    schema: outSchema,
    render: (_a, v) => {
      const parts = [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }];
      if (v && v.image) parts.push({ type: 'image', attachment: v.image });
      return parts;
    },
  };
  /** 上一帧哈希：同一窗口画面没变就不重复发图，省 token */
  const lastFrame = new Map();

  reg({
    name: 'desktop_windows',
    description: 'List top-level Windows desktop windows with hwnd, pid, title, bounds and visibility. Use it to discover the exact window to capture, read, click or type into. Filter by title substring and/or restrict to on-screen windows.',
    parameters: {
      filter: { type: 'string', description: 'Only windows whose title contains this text (case-insensitive).' },
      onScreenOnly: { type: 'boolean', description: 'Only windows that are both on screen and visible (default: list every window that sits on a monitor, which is what you can actually act on).' },
      minWidth: { type: 'number', description: 'Only windows at least this wide (default 0).' },
      limit: { type: 'number', description: 'Maximum rows to return (default 40).' },
    },
    async execute({ filter, onScreenOnly, minWidth, limit }) {
      const all = win32.listWindows({ minW: Math.max(minWidth || 0, 60) });
      const vs = virtualScreen();
      const onScreen = (w) => w.bounds.x < vs.w && w.bounds.x + w.bounds.width > 0 && w.bounds.y < vs.h && w.bounds.y + w.bounds.height > 0;
      const f = filter ? String(filter).toLowerCase() : '';
      const seen = new Set();
      const SHELL = /^(TextInputHost|LockApp|NVIDIA Overlay|SearchHost|StartMenuExperienceHost|ShellExperienceHost|explorer|TabTip|ArmouryCrate\.UserSessionHelper)\.exe$/i;
      // 各家硬件/输入法留下的隐形辅助窗口，标题里常带这些词
      const NOISE_TITLE = /(hidden window|shell handwriting|gpu mode|msctfime|default ime|IME|SysShadow|Program Manager$)/i;
      const rows = all
        .filter((w) => (!f || (w.title || '').toLowerCase().includes(f)) && String(w.title || '').trim() !== '' && w.bounds.width >= Math.max(minWidth || 0, 60) && w.bounds.height >= 40 && !SHELL.test(w.app || '') && !NOISE_TITLE.test(w.title || '') && onScreen(w) && (onScreenOnly === true ? w.visible : true) && w.visible && !seen.has(w.hwnd) && seen.add(w.hwnd))
        .sort((a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)
        .slice(0, limit || 40)
        .map((w) => ({ hwnd: w.hwnd, pid: w.pid, app: w.app, title: w.title, bounds: w.bounds, visible: w.visible }));
      const browsers = rows.filter((w) => isBrowserApp(w.app)).map((w) => ({ hwnd: w.hwnd, app: w.app, title: w.title }));
      const out = { count: rows.length, windows: rows };
      if (browsers.length) {
        out.browsers = browsers;
        out.browserHint = 'Browsers are open. For web pages use the built-in browser tools (dsh_browser_*) instead of clicking pixels: they read the page structure, keep working while the window is in the background, and do not steal the mouse. Drive the browser UI itself with desktop_* only when the built-in tools cannot (download dialogs, extensions, bookmarks).';
      }
      return out;
    },
  });

  reg({
    name: 'desktop_capture',
    description: 'Capture a window (or a screen region) with in-process GDI BitBlt and RETURN THE PICTURE ITSELF as an image block, with a coordinate ruler drawn on it (top edge = x, left edge = y, in CLIENT pixels) — read coordinates straight off the picture. Also returns the client rect and the image-to-client scale (and a file path only when you ask for one). A repeated capture of an unchanged window returns unchanged=true and skips the image to save tokens.',
    output: imageOutput,
    parameters: {
      window: { type: 'string', description: 'Target window: hwnd (number as string) or a title substring. Omit to capture the whole desktop (all monitors) or the region given by x/y/width/height. Region parameters apply only when no window is named.' },
      desktop: { type: 'boolean', description: 'Capture the whole desktop (all monitors). This is the default when window is omitted and width/height are not given.' },
      path: { type: 'string', description: 'Optional absolute PNG output path. Nothing is written unless you pass path or saveFile:true.' },
      saveFile: { type: 'boolean', description: 'Write the PNG into the temp folder and return its path (default false).' },
      maxDim: { type: 'number', description: 'Downscale so the longest side is at most this many pixels (default 1400; pass 0 for full resolution).' },
      ruler: { type: 'boolean', description: 'Draw the coordinate ruler (default true).' },
      image: { type: 'boolean', description: 'Attach the picture to the reply (default true).' },
      force: { type: 'boolean', description: 'Return the image even when the frame is identical to the previous capture of this window.' },
      x: { type: 'number', description: 'Region left in screen pixels. Only used for a region capture: ignored when window is given or desktop=true.' },
      y: { type: 'number', description: 'Region top in screen pixels. Ignored when window is given or desktop=true.' },
      width: { type: 'number', description: 'Region width in screen pixels. Ignored when window is given or desktop=true — a window capture always covers the whole window client area.' },
      height: { type: 'number', description: 'Region height in screen pixels. Ignored when window is given; use maxDim/desktop cropping on your side for a sub-region.' },
    },
    async execute({ window, desktop, path, saveFile, maxDim, ruler, image, force, x, y, width, height }) {
      let img, rect, key, hwndW = 0;
      if (window === undefined || window === null || window === '') {
        const w = Number(width || 0), h = Number(height || 0);
        if (desktop === true || (!w && !h)) {
          // 整块桌面（多屏虚拟屏）——最常见的“不开窗先看一眼”用法，不应报错
          const vs = virtualScreen();
          if (!vs.w || !vs.h) throw new Error('desktop_capture: could not read the virtual screen size');
          img = grabScreen(vs.x, vs.y, vs.w, vs.h);
          rect = { x: vs.x, y: vs.y, w: vs.w, h: vs.h };
          key = 'screen:' + [vs.x, vs.y, vs.w, vs.h].join(',');
        } else {
          if (!w || !h) throw new Error('desktop_capture needs a window, or width and height for a region');
          img = grabScreen(Number(x || 0), Number(y || 0), w, h);
          rect = { x: Number(x || 0), y: Number(y || 0), w, h };
          key = 'region:' + [rect.x, rect.y, rect.w, rect.h].join(',');
        }
      } else {
        const w = resolveWindowDefault(window);
        if (!w) throw new Error('window not found: ' + window);
        hwndW = Number(w.hwnd);
        rect = windowClientRect(w);
        if (rect.w <= 0 || rect.h <= 0) throw new Error('window has no client area (minimized?)');
        img = grabScreen(rect.x, rect.y, rect.w, rect.h);
        key = 'hwnd:' + hwndW;
      }
      const cap = Number(maxDim === undefined ? 1400 : maxDim) || 0;
      let out = img;
      if (cap && Math.max(img.width, img.height) > cap) {
        const s = cap / Math.max(img.width, img.height);
        out = downscaleImg(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
      }
      const scaleX = out.width > 0 ? rect.w / out.width : 1;
      const scaleY = out.height > 0 ? rect.h / out.height : 1;
      if (ruler !== false) drawRuler(out, { scaleX, scaleY });
      const png = encodePng(out.width, out.height, out.rgb);
      const frameHash = hash(png);
      const same = !force && lastFrame.get(key) === frameHash;
      lastFrame.set(key, frameHash);
      // 只有明确要文件（path 或 saveFile:true）才落盘；否则一直往 %TEMP% 堆 png，用久了会占满盘
      let file = null;
      if (path || saveFile === true) {
        file = targetFile(path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, png);
      }
      const res = {
        ...(file ? { path: file } : {}), bytes: png.length, width: out.width, height: out.height,
        rect, scale: { x: Number(scaleX.toFixed(4)), y: Number(scaleY.toFixed(4)) },
        frameHash, unchanged: same,
        dpi: hwndW ? dpiForWindow(hwndW) : 96,
        note: 'Ruler numbers are CLIENT pixels. Screen point = rect.x + clientX, rect.y + clientY.',
      };
      if (image !== false && !same) {
        const ref = await attach(png, 'desktop-' + Date.now() + '.png');
        if (ref) res.image = ref;
      }
      if (same) res.hint = 'Frame identical to the previous capture (unchanged=true) so the image was skipped; pass force:true to see it again.';
      return res;
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
      const w = resolveWindowDefault(window);
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
    description: 'Click inside a window. Target by ref (the number desktop_look printed — cheapest and least error-prone), by name (exact accessibility name, re-located live), by control=N (index from desktop_tree), by text (OCR locates it), or by pixel/fractional coordinates. The window is focused first, a bare ALT unlocks the Windows foreground lock, and the click is verified by screenshot comparison (retried once). Returns changed=false with a hint when the UI did not react.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      control: { type: 'number', description: 'Index from desktop_tree. Fast but goes stale when the tree changes; prefer ref or name.' },
      ref: { type: 'string', description: 'Control ref printed by the last desktop_look (e.g. "e7"). Cheapest and newest-aware: no extra tree read.' },
      name: { type: 'string', description: 'Exact UIA control name to click (case-insensitive). The control is located again at click time, so it does not go stale like control=N.' },
      role: { type: 'string', description: 'Optional control type filter for name, e.g. "Button", "MenuItem", "ListItem".' },
      match: { type: 'string', description: 'Name matching for name: exact (default) | substring.' },
      expect: { type: 'object', description: 'Optional identity guard for control: {role, name}. The click is refused when the control at that index no longer matches.' },
      text: { type: 'string', description: 'Text to locate via OCR and click its centre.' },
      x: { type: 'number', description: 'Client-area x in pixels (alternative to text).' },
      y: { type: 'number', description: 'Client-area y in pixels.' },
      fx: { type: 'number', description: 'Fractional x in 0..1 of the client area (alternative to x).' },
      fy: { type: 'number', description: 'Fractional y in 0..1.' },
      force: { type: 'boolean', description: 'Return ok even when no visual change was detected (and skip the covered-point check).' },
      restore: { type: 'boolean', description: 'Put the mouse cursor back where it was and give the foreground back to the window you were using, after clicking (default true).' },
    },
    lock: true,
    async execute({ window, control, ref, name, role, match, expect, text, x, y, fx, fy, force, restore }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_click');
      if (refused) return refused;
      const prevCursor = win32.cursorPos();
      const prevFg = win32.foregroundWindow();
      pulse('定位目标', { reset: true });
      const fgOk = ensureForeground(w.hwnd);
      await sleep(120);
      const cap = captureWindow(w, 1400);
      const rect = cap.rect;
      let cx, cy, hitText = null, via = 'coords', uiaInfo = null;

      if (ref !== undefined && ref !== null && ref !== '') {
        const got = lookupRef(w.hwnd, ref);
        if (!got || got.error) {
          return { ok: false, error: (got && got.error) || 'ref not found', hint: 'Call desktop_look for this window, then click the ref it prints (e.g. "e7").' };
        }
        const r = got.hit.rect;
        if (!(r && r.w > 0 && r.h > 0)) return { ok: false, error: 'that control has no clickable rect', ref: got.hit.ref };
        cx = Math.round(r.x + r.w / 2);
        cy = Math.round(r.y + r.h / 2);
        hitText = got.hit.name;
        uiaInfo = { role: got.hit.role, ref: got.hit.ref };
        via = 'uia-ref';
      } else if (control !== undefined && control !== null) {
        const tree = uiaTree(w.hwnd, { depth: 6, max: 600 });
        const els = (tree.elements || []).map((e, i) => ({ index: i, role: e.role, name: e.name, rect: { x: e.x, y: e.y, w: e.w, h: e.h } }));
        const el = els[Number(control)];
        if (!el) return { ok: false, error: 'control index out of range', controlCount: els.length, hint: 'Run desktop_tree again for fresh indices.' };
        if (expect) {
          const wantName = typeof expect === 'string' ? expect : String(expect.name || '');
          const wantRole = typeof expect === 'object' && expect ? String(expect.role || '') : '';
          const nameOk = !wantName || String(el.name || '').toLowerCase().includes(wantName.toLowerCase());
          const roleOk = !wantRole || String(el.role || '') === wantRole;
          if (!nameOk || !roleOk) {
            return { ok: false, error: 'control identity mismatch', expected: (wantRole || '?') + ' "' + wantName + '"', actual: el.role + ' "' + el.name + '"', controlCount: els.length, hint: 'The layout changed since desktop_tree: re-read the tree, then click the new index.' };
          }
        }
        if (!(el.rect.w > 0 && el.rect.h > 0)) return { ok: false, error: 'control has no clickable rect', control: el };
        hitText = el.name;
        uiaInfo = { role: el.role, index: Number(control) };
        via = 'uia-index';
        cx = Math.round(el.rect.x + el.rect.w / 2);
        cy = Math.round(el.rect.y + el.rect.h / 2);
      } else if (name) {
        const found = findControl(w.hwnd, { name, role: role || '', matchMode: match || 'exact' });
        if (!found.ok || !found.rect) {
          return {
            ok: false,
            error: found.error || 'control not found',
            suggestions: found.suggestions,
            candidates: found.candidates,
            hint: 'Names come from desktop_tree{query}. Pass an exact name, or match:"substring" together with role to disambiguate.',
          };
        }
        const r = found.rect;
        if (!(r.w > 0 && r.h > 0)) return { ok: false, error: 'control has no clickable rect', control: found };
        cx = Math.round(r.x + r.w / 2);
        cy = Math.round(r.y + r.h / 2);
        hitText = found.matched;
        uiaInfo = { role: found.matchedRole, name: found.matched, matchKind: found.matchKind };
        via = 'uia-name';
      } else if (text) {
        const res = ocrBuffer(cap.png, { scale: 1.5, prep: true });
        const hit = findLine(res, text);
        if (!hit) {
          const uia = (() => { try { const t = uiaTree(w.hwnd, { depth: 5, max: 80 }); return (t.elements || []).filter((e) => e.pats && e.pats.length && e.name).map((e, i) => i + ':' + e.role + ':' + e.name); } catch { return []; } })();
          return { ok: false, error: 'text not found', tried: text, lines: (res.lines || []).slice(0, 14).map((l) => l.text), uiaCandidates: uia.slice(0, 12), hint: uia.length ? 'OCR missed it, but this window exposes UIA controls: use desktop_tree + desktop_click{control,expect} instead.' : 'Neither OCR nor UIA found it: run desktop_read to see what the window actually shows.' };
        }
        const kx = cap.width ? rect.w / cap.width : 1;
        const ky = cap.height ? rect.h / cap.height : 1;
        cx = rect.x + Math.round((hit.x + hit.w / 2) * kx);
        cy = rect.y + Math.round((hit.y + hit.h / 2) * ky);
        hitText = hit.text;
        via = 'ocr';
      } else if (fx !== undefined || fy !== undefined) {
        cx = rect.x + Math.round((fx ?? 0.5) * rect.w);
        cy = rect.y + Math.round((fy ?? 0.5) * rect.h);
      } else if (x !== undefined && y !== undefined) {
        cx = rect.x + Number(x);
        cy = rect.y + Number(y);
      } else {
        throw new Error('desktop_click needs control, name, text, fx/fy, or x/y');
      }

      // 控件滚出可视区时坐标为负或落在窗口外：这种点击会点到别处，先拒绝
      if (rect && rect.w > 0 && rect.h > 0) {
        const insideX = cx >= rect.x - 2 && cx <= rect.x + rect.w + 2;
        const insideY = cy >= rect.y - 2 && cy <= rect.y + rect.h + 2;
        if (!insideX || !insideY) {
          settle(false, '控件不在可视区');
          return {
            ok: false, error: 'target is scrolled out of view (or moved off-window)', window: w.hwnd, title: w.title,
            target: hitText, at: { x: cx, y: cy }, clientRect: rect, via,
            hint: 'The control exists but is outside the visible area. Scroll it into view (desktop_scroll) or trigger it without the mouse (desktop_invoke).',
          };
        }
      }

      // 落点被别的程序挡住时先别点（通知、弹窗、别的窗口盖上来最常出这种事）
      if (force !== true) {
        const owner = win32.pointOwner(cx, cy);
        if (owner.root && owner.root !== w.hwnd) {
          let samePid = false, covering = null;
          try {
            const all = win32.listWindows({ onScreenOnly: true });
            const hitWin = all.find((x) => x.hwnd === owner.root || x.hwnd === owner.hwnd);
            if (hitWin) { samePid = hitWin.pid === w.pid; covering = { hwnd: hitWin.hwnd, app: hitWin.app, title: hitWin.title }; }
          } catch {}
          if (!samePid) {
            settle(false, '落点被挡住');
            return {
              ok: false, blocked: 'POINT_COVERED', window: w.hwnd, title: w.title,
              at: { x: cx, y: cy }, covering, via,
              hint: 'Another program covers that point (a popup, notification or another window). Close it, or click by name instead of coordinates, or pass force:true to click anyway.',
            };
          }
        }
      }
      if (!fgOk) {
        const posted = win32.postClick(cx, cy);
        await sleep(350);
        return { ok: posted, window: w.hwnd, title: w.title, text: hitText, control: uiaInfo, at: { x: cx, y: cy }, changed: null, retried: false, via: 'postmessage', hint: 'Could not take the foreground: the click was posted to the window instead (menus may ignore it). Activate the window manually or add force.' };
      }
      pulse('点击 ' + (hitText ? '「' + hitText + '」' : '(' + cx + ', ' + cy + ')'));
      const probe = { x: Math.max(0, cx - 60), y: Math.max(0, cy - 40), w: Math.min(520, rect.x + rect.w - cx + 60), h: Math.min(420, rect.y + rect.h - cy + 40) };
      const before = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
      const sigBefore = treeSignature(w.hwnd);
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
      // 还不动 & 是按文字点的：界面可能刚挪过位置，重新 OCR 一次再点（而不是傻点老坐标）
      let relocated = false;
      if (before === after && text && via === 'ocr') {
        try {
          const cap2 = captureWindow(w, 1400);
          const res2 = ocrBuffer(cap2.png, { scale: 1.5, prep: true });
          const hit2 = findLine(res2, text);
          if (hit2) {
            const kx2 = cap2.width ? cap2.rect.w / cap2.width : 1;
            const ky2 = cap2.height ? cap2.rect.h / cap2.height : 1;
            const nx = cap2.rect.x + Math.round((hit2.x + hit2.w / 2) * kx2);
            const ny = cap2.rect.y + Math.round((hit2.y + hit2.h / 2) * ky2);
            if (Math.abs(nx - cx) > 3 || Math.abs(ny - cy) > 3) {
              pulse('位置变了，重新定位后点击');
              win32.screenClick(nx, ny);
              await sleep(520);
              after = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
              cx = nx; cy = ny; relocated = true;
            }
          }
        } catch {}
      }
      let changed = before !== after;
      let changedBy = changed ? 'pixels' : null;
      if (!changed) {
        const sigAfter = treeSignature(w.hwnd);
        if (sigAfter !== null && sigBefore !== null && sigAfter !== sigBefore) { changed = true; changedBy = 'uia-structure'; }
      }
      let restored = null;
      if (restore !== false) {
        restored = {};
        if (prevCursor && (Math.abs(prevCursor.x - cx) > 2 || Math.abs(prevCursor.y - cy) > 2)) {
          restored.cursor = win32.setCursor(prevCursor.x, prevCursor.y);
        }
        if (prevFg && prevFg !== w.hwnd) {
          restored.foreground = win32.restoreForeground(prevFg);
        }
      }
      const inClient = cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
      const ok = changed || force === true || (inClient && retried);
      const out = {
        ok, window: w.hwnd, title: w.title, text: hitText, control: uiaInfo,
        at: { x: cx, y: cy }, changed, changedBy, retried, relocated, inClient, via, restored,
        hint: changed ? undefined : (inClient
          ? 'Nothing changed: neither the pixels nor the accessibility structure moved. If this was a text area the caret may still have moved — check with desktop_text. Otherwise re-read with desktop_look and click by name.'
          : 'The coordinate fell outside the window or was covered - check window and coordinates.'),
      };
      if (!ok) out.error_kind = 'no_effect';
      settle(changed, changed ? '已点击' : '点完没反应');
      logTool('desktop_click', { hwnd: w.hwnd, at: { x: cx, y: cy }, changed, changedBy, retried, via });
      return out;
    },
  });

  reg({
    name: 'desktop_type',
    lock: true,
    description: 'Type text into a window. Default: clipboard + real Ctrl+V (works with Chinese and any IME, appends at the caret; the window is focused first). With replace:true it writes the whole value through the accessibility value pattern instead — one round trip, keeps the clipboard and does not steal focus — use that for filling a form field.',
    parameters: {
      window: { type: 'string', description: 'Target window: hwnd or title substring. Omit to type into whatever is focused.' },
      text: { type: 'string', required: true, description: 'Text to paste.' },
      submit: { type: 'boolean', description: 'Press Enter after pasting (default false).' },
      replace: { type: 'boolean', description: 'Write the whole field value via the accessibility value pattern instead of pasting (fast, no clipboard use, no focus needed). Falls back to pasting when the field has no value pattern.' },
      field: { type: 'string', description: 'With replace:true — the field name substring to write into (omit when the window has a single writable field).' },
    },
    async execute({ window, text, submit, replace, field }) {
      let hwnd = null, rect = null;
      const target = window ? resolveWindowDefault(window) : null;
      if (window && !target) throw new Error('window not found: ' + window);
      const refused = refusalFor(target, 'desktop_type');
      if (refused) return refused;
      pulse('准备输入文字', { reset: true });
      const prevFg = win32.foregroundWindow();
      const giveBack = () => { if (prevFg && hwnd && prevFg !== hwnd) { try { win32.restoreForeground(prevFg); } catch {} } };
      if (replace === true && target) {
        const t0 = Date.now();
        try {
          const r = uiaSetValue(target.hwnd, { match: field ? String(field) : '', value: String(text) });
          if (r && r.ok) {
            if (submit) win32.pressCombo(0x0d, false, false, false);
            const out = { ok: true, typed: String(text).length, hwnd: target.hwnd, submit: !!submit, changed: true, via: 'uia-value:' + (r.via || 'value'), control: r.name, readback: r.readback, ms: Date.now() - t0 };
            settle(true, '已填写');
            logTool('desktop_type', { ok: true, via: out.via, hwnd: target.hwnd, chars: out.typed });
            return out;
          }
          if (r && r.error) { /* 落到下面的粘贴路径 */ }
        } catch { /* 落到下面的粘贴路径 */ }
      }
      // 用户原来的剪贴板内容，打字结束后还回去（很多用户会拿剪贴板当草稿纸）
      const prevClip = win32.getClipboardText();
      const restoreClip = (delay = 700) => {
        if (prevClip == null || prevClip.length > 60000) return;
        setTimeout(() => { try { win32.setClipboardText(prevClip); } catch {} }, delay);
      };
      if (target) {
        const w = target;
        hwnd = w.hwnd;
        if (!ensureForeground(hwnd)) {
          const ed0 = win32.findEditableChild(hwnd);
          if (ed0) { win32.setClipboardText(String(text)); await sleep(350); win32.sendPaste(ed0.hwnd); await sleep(200); if (submit) { win32.pressCombo(0x0d, false, false, false); } restoreClip(500); return { ok: true, typed: String(text).length, hwnd, submit: !!submit, changed: null, via: 'wm_paste-bg:' + ed0.cls, hint: '窗口未能抢到前台，已用后台消息直接粘贴（部分应用可能无效）' }; }
          throw new Error('cannot bring window to foreground (前台锁/权限) and no editable child found');
        }
        await sleep(120);
        rect = windowClientRect(w);
      }
      // 剪贴板写入后必须留足时间再发 Ctrl+V：实测 80ms 时 Notepad 的 RichEdit 会静默粘不上，350~500ms 稳定
      pulse('输入 ' + String(text).slice(0, 24) + (String(text).length > 24 ? '…' : ''));
      const before = rect && rect.w > 0 ? hash(grabPng(rect.x, rect.y, rect.w, rect.h, 1200).png) : null;
      win32.setClipboardText(String(text));
      await sleep(450);
      let via = 'key';
      try { const ed = win32.findEditableChild(hwnd || win32.foregroundWindow()); if (ed) { win32.sendPaste(ed.hwnd); via = 'wm_paste:' + ed.cls; } else { win32.pressCombo(0x56, true, false, false); } } catch { win32.pressCombo(0x56, true, false, false); }
      await sleep(220);
      await sleep(260);
      if (submit) { win32.pressCombo(0x0d, false, false, false); await sleep(150); }
      restoreClip(250);
      let changed = null;
      if (before !== null) changed = hash(grabPng(rect.x, rect.y, rect.w, rect.h, 1200).png) !== before;
      giveBack();
      const out = {
        ok: true, typed: String(text).length, hwnd, submit: !!submit, changed, via,
        hint: changed === false ? '粘贴后画面无变化：焦点可能不在输入框，先 desktop_click 定位，再用 desktop_key ctrl+v' : undefined,
      };
      settle(true, '输入完成');
      logTool('desktop_type', { ok: true, typed: out.typed, hwnd, via, changed, submit: !!submit });
      return out;
    },
  });

  reg({
    name: 'desktop_key',
    lock: true,
    description: 'Press a key or key chord in a window (e.g. enter, tab, esc, ctrl+a, ctrl+shift+s, f5). The window is focused first. Useful for menus, dialogs and shortcuts that cannot be clicked reliably.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key or chord, e.g. "enter", "esc", "ctrl+a", "alt+f4".' },
      window: { type: 'string', description: 'Target window: hwnd or title substring. Omit to send to the focused window.' },
      repeat: { type: 'number', description: 'How many times to press (default 1).' },
    },
    async execute({ key, window, repeat }) {
      const target = window ? resolveWindowDefault(window) : null;
      if (window && !target) throw new Error('window not found: ' + window);
      const refusedKey = refusalFor(target, 'desktop_key');
      if (refusedKey) return refusedKey;
      pulse('按键 ' + key, { reset: true });
      if (target) {
        const w = target;
        if (!ensureForeground(w.hwnd)) throw new Error('cannot bring window to foreground');
        await sleep(120);
      }
      const chord = parseKeyChord(key);
      const ctrl = chord.mods.includes('ctrl') || chord.mods.includes('win');
      const shift = chord.mods.includes('shift');
      const alt = chord.mods.includes('alt');
      const n = Math.max(1, Math.min(20, Number(repeat || 1)));
      for (let i = 0; i < n; i++) {
        win32.pressCombo(chord.vk, ctrl, shift, alt);
        await sleep(80);
      }
      const out = { ok: true, key, main: chord.key, mods: chord.mods, repeat: n };
      settle(true, '按键完成');
      logTool('desktop_key', { ok: true, key, main: chord.key, mods: chord.mods, repeat: n });
      return out;
    },
  });
  reg({
    name: 'desktop_launch',
    description: 'Start an app, open a file or open a URL, then wait for its window to appear and return it (hwnd/title) so the next step can target it. Accepts an exe name or full path (notepad, calc, C:\\path\\app.exe), a URL (https://..., ms-settings:, file://...), or a document path. This is how you get an app on screen when nothing suitable is open yet.',
    parameters: {
      target: { type: 'string', required: true, description: 'Exe name or full path, URL/URI (https://..., ms-settings:..., file://...), or a document path to open with its default app.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments (exe targets only).' },
      cwd: { type: 'string', description: 'Working directory for an exe target.' },
      wait: { type: 'boolean', description: 'Wait for a new window to appear (default true).' },
      app: { type: 'string', description: 'Optional: require the new window to come from this process name (substring, e.g. "notepad").' },
      title: { type: 'string', description: 'Optional: require the new window title to contain this text (substring).' },
      timeoutMs: { type: 'number', description: 'How long to wait for the window (default 8000).' },
    },
    async execute({ target, args, cwd, wait, app, title, timeoutMs }) {
      const refused = refusalFor(null, 'desktop_launch');
      if (refused) return refused;
      const t = String(target || '').trim();
      if (!t) throw new Error('desktop_launch needs target (exe / URL / path)');
      pulse('启动 ' + t.slice(0, 40), { reset: true });
      const before = new Set(win32.listWindows({ visibleOnly: true }).map((w) => w.hwnd));
      const argList = Array.isArray(args) ? args.map(String) : [];
      const isUrl = /^(https?:|ms-[\w-]+:|file:|mailto:|shell:)/i.test(t);
      const isExe = /\.exe$/i.test(t) || (/[\\/]/.test(t) && !/\.[a-z0-9]{1,5}$/i.test(t));
      let how = '';
      let pid = null;
      try {
        if (isUrl) {
          how = 'explorer-url';
          const c = spawnProcess('explorer.exe', [t], { detached: true, stdio: 'ignore' }); c.unref(); pid = c.pid;
        } else if (isExe) {
          how = 'spawn-exe';
          const c = spawnProcess(t, argList, { detached: true, stdio: 'ignore', cwd: cwd || undefined }); c.unref(); pid = c.pid;
        } else {
          how = 'shell-start';
          // cmd 的 start 第一个带引号的参数会被当成窗口标题，所以固定先给一个空标题；
          // 路径里有空格/中文必须整体加引号，否则会被 cmd 拆开
          const doc = /\s/.test(t) ? '"' + t + '"' : t;
          const c = spawnProcess('cmd.exe', ['/c', 'start', '', doc, ...argList], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref(); pid = c.pid;
        }
      } catch (e) {
        return { ok: false, error: 'launch failed: ' + (e && e.message), target: t, how };
      }
      const out = { ok: true, launched: t, how, pid, waited: false, window: null };
      if (wait === false) { settle(true, '已启动'); logTool('desktop_launch', { target: t, how, waited: false }); return out; }
      const limit = Number(timeoutMs ?? 8000);
      const t0 = Date.now();
      const wantApp = String(app || (how === 'spawn-exe' ? t.split(/[\\/]/).pop().replace(/\.exe$/i, '') : '')).toLowerCase();
      const wantTitle = String(title || '').toLowerCase();
      while (Date.now() - t0 < limit) {
        await sleep(180);
        const fresh = win32.listWindows({ visibleOnly: true })
          .filter((w) => !before.has(w.hwnd) && String(w.title || '').trim());
        const hit = fresh.find((w) => {
          const a = String(w.app || '').toLowerCase(), ti = String(w.title || '').toLowerCase();
          if (wantApp && !a.includes(wantApp)) return false;
          if (wantTitle && !ti.includes(wantTitle)) return false;
          return true;
        }) || (!wantApp && !wantTitle ? fresh[0] : null);
        if (hit) {
          out.ok = true; out.waited = true; out.window = hit; out.ms = Date.now() - t0;
          // pid 是启动器的 pid，真正应用的 pid 以窗口为准（start notepad 时 pid 是 cmd 的）
          out.appPid = hit.pid;
          // 窗口出现 ≠ 能操作：等它的控件树补齐，后面 desktop_look 才不会只看到半棵树
          const ready = await waitTreeReady(hit.hwnd);
          out.controlCount = ready.count;
          out.treeReady = ready.ready;
          if (!ready.ready) out.hint = 'The window is up but its controls are still being built; if desktop_look shows almost nothing, look again in a moment.';
          settle(true, '已打开');
          logTool('desktop_launch', { target: t, how, hwnd: hit.hwnd, title: hit.title, ms: out.ms, controls: ready.count });
          return out;
        }
      }
      out.waited = true; out.ms = Date.now() - t0; out.ok = false;
      out.error = 'no new window appeared within ' + limit + 'ms';
      out.hint = 'The app may still be starting, or its window already existed — call desktop_windows to see what is on screen now.';
      settle(false, '没等到窗口');
      logTool('desktop_launch', { target: t, how, ok: false, ms: out.ms });
      return out;
    },
  });

  reg({
    name: 'desktop_wait',
    description: 'Wait until something becomes true instead of guessing with fixed sleeps. kind="window": a window matching app/title appears (state:"gone" waits for it to disappear). kind="text": some text becomes visible in a window (via OCR). kind="change": the window content changes from now. kind="idle": the content stops changing for quietMs. Returns ok/matched/ms (and the window for kind=window).',
    parameters: {
      kind: { type: 'string', required: true, description: 'window | text | change | idle' },
      window: { type: 'string', description: 'Target window (kind text/change/idle): hwnd or title substring.' },
      text: { type: 'string', description: 'kind="text": the text to wait for (tolerates OCR confusions).' },
      app: { type: 'string', description: 'kind="window": process name substring, e.g. "notepad".' },
      title: { type: 'string', description: 'kind="window": window title substring.' },
      state: { type: 'string', description: 'kind="window": present (default) | gone.' },
      timeoutMs: { type: 'number', description: 'Default 10000.' },
      intervalMs: { type: 'number', description: 'Poll interval (default 250; text uses 600).' },
      quietMs: { type: 'number', description: 'kind="idle": how long the content must stay unchanged (default 500).' },
    },
    async execute({ kind, window, text, app, title, state, timeoutMs, intervalMs, quietMs }) {
      const k = String(kind || '').toLowerCase();
      const limit = Number(timeoutMs ?? 10000);
      const t0 = Date.now();
      const done = (ok, extra) => ({ ok, kind: k, ms: Date.now() - t0, ...(extra || {}) });

      if (k === 'window') {
        const wantGone = state === 'gone';
        const a = String(app || '').toLowerCase();
        const ti = String(title || '').toLowerCase();
        const match = (w) => (!a || String(w.app || '').toLowerCase().includes(a)) && (!ti || String(w.title || '').toLowerCase().includes(ti));
        while (Date.now() - t0 < limit) {
          const hits = win32.listWindows({ visibleOnly: true }).filter(match);
          if (wantGone ? hits.length === 0 : hits.length > 0) return done(true, { window: wantGone ? null : hits[0], count: hits.length });
          await sleep(Number(intervalMs || 200));
        }
        return done(false, { error: 'timeout waiting for window', app, title, state: state || 'present' });
      }

      const w = window ? resolveWindowDefault(window) : null;
      if (!w) throw new Error('desktop_wait kind=' + k + ' needs window');

      if (k === 'text') {
        if (!text) throw new Error('desktop_wait kind=text needs text');
        const want = String(text);
        while (Date.now() - t0 < limit) {
          // 先问无障碍树（准、快、不怕窗口被挡）；读不到再 OCR
          try {
            const ux = uiaText(w.hwnd, { match: '' });
            if (ux && ux.ok && String(ux.text || '').includes(want)) {
              return done(true, { text: want, via: 'uia-text', source: ux.via });
            }
          } catch {}
          try {
            ensureForeground(w.hwnd);
            const cap = captureWindow(w, 1400);
            const res = ocrBuffer(cap.png, { scale: 1.2, prep: true });
            const hit = findLine(res, want);
            if (hit) {
              const kx = cap.width ? cap.rect.w / cap.width : 1;
              const ky = cap.height ? cap.rect.h / cap.height : 1;
              return done(true, { text: hit.text, via: 'ocr', box: { x: Math.round(hit.x * kx), y: Math.round(hit.y * ky), w: Math.round(hit.w * kx), h: Math.round(hit.h * ky) } });
            }
          } catch {}
          await sleep(Number(intervalMs || 600));
        }
        return done(false, { error: 'text never appeared', text: want, hint: 'Neither the accessibility text nor OCR found it. If the app is a game/canvas, give it more time; if the text differs (typo, hidden tab), check with desktop_text first.' });
      }

      const snap = () => {
        const rect = windowClientRect(w);
        if (!rect || !(rect.w > 0)) return null;
        return hash(grabPng(rect.x, rect.y, rect.w, rect.h, 900).png);
      };

      if (k === 'change') {
        const base = snap();
        while (Date.now() - t0 < limit) {
          await sleep(Number(intervalMs || 220));
          const now = snap();
          if (now !== null && base !== null && now !== base) return done(true, { changed: true });
        }
        return done(false, { changed: false, error: 'content did not change' });
      }

      if (k === 'idle') {
        const quiet = Number(quietMs || 500);
        let last = snap();
        let lastAt = Date.now();
        while (Date.now() - t0 < limit) {
          await sleep(Number(intervalMs || 150));
          const now = snap();
          if (now !== last) { last = now; lastAt = Date.now(); }
          else if (Date.now() - lastAt >= quiet) return done(true, { quietMs: Date.now() - lastAt });
        }
        return done(false, { error: 'never settled' });
      }

      throw new Error('unknown kind: ' + kind + ' (window | text | change | idle)');
    },
  });

  reg({
    name: 'desktop_text',
    description: 'Read the text of a window or of one control exactly (no OCR guessing): uses the accessibility text/value of the document or edit box, and falls back to OCR only when the app exposes no text. Use this instead of desktop_read whenever you need the real characters (an editor, a chat log, a form field, an error dialog). Returns text plus source so you know how much to trust it.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or title substring.' },
      match: { type: 'string', description: 'Optional control name substring: read that control instead of the whole document.' },
      limit: { type: 'number', description: 'Max characters returned (default 4000).' },
      fallbackOcr: { type: 'boolean', description: 'When the app exposes no text, run OCR on the window (default true).' },
    },
    async execute({ window, match, limit, fallbackOcr }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_text');
      if (refused) return refused;
      const max = Math.max(200, Math.min(20000, Number(limit ?? 4000)));
      const t0 = Date.now();
      let res = null;
      try { res = uiaText(w.hwnd, { match: match || '' }); } catch (e) { res = { ok: false, error: e && e.message }; }
      if (res && res.ok && !res.error) {
        const full = String(res.text == null ? '' : res.text);
        const out = {
          ok: true, window: w.hwnd, title: w.title, source: 'uia-' + (res.via || 'text'),
          role: res.role, control: res.name || undefined,
          length: full.length, truncated: full.length > max,
          text: full.slice(0, max), ms: Date.now() - t0,
        };
        if (!full.length) out.hint = 'The control reported an empty text — the document or field really is empty.';
        logTool('desktop_text', { ok: true, source: out.source, length: out.length });
        return out;
      }
      if (fallbackOcr === false) {
        return { ok: false, window: w.hwnd, title: w.title, error: (res && res.error) || 'app exposes no text', source: 'none', hint: 'Try desktop_read (OCR) for this window.' };
      }
      ensureForeground(w.hwnd);
      await sleep(80);
      const cap = captureWindow(w, 1400);
      const ocr = ocrBuffer(cap.png, { scale: 1.2, prep: true });
      const lines = (ocr.lines || []).map((l) => l.text);
      const text = lines.join('\n');
      const out = {
        ok: !!text, window: w.hwnd, title: w.title, source: 'ocr',
        length: text.length, truncated: text.length > max, text: text.slice(0, max),
        warn: 'read by OCR: characters may be wrong, especially small CJK text',
        ms: Date.now() - t0,
      };
      logTool('desktop_text', { ok: out.ok, source: 'ocr', length: out.length });
      return out;
    },
  });

  reg({
    name: 'desktop_look',
    description: 'One call to see what is on screen right now: the foreground window, the short list of other windows, the clickable controls of the target window (numbered, with stable names and rects), optional OCR text, and optional screenshot with the same numbers drawn on it. Use this first, then act with desktop_click{name}, desktop_invoke, desktop_type. It replaces calling desktop_windows + desktop_tree (+ desktop_read) one after another.',
    output: imageOutput,
    parameters: {
      window: { type: 'string', description: 'Window to inspect: hwnd or title substring. Default: the foreground window.' },
      ocr: { type: 'boolean', description: 'Also read the window text with OCR (adds ~300-600ms; skip when the app exposes text via desktop_text).' },
      image: { type: 'boolean', description: 'Also attach a screenshot with the control numbers drawn on it (set-of-marks). Best for vision models.' },
      marks: { type: 'boolean', description: 'Draw numbers on the image (default true when image=true).' },
      max: { type: 'number', description: 'Max controls listed (default 80, cap 200).' },
      maxDim: { type: 'number', description: 'Image long side (default 1280).' },
      windowList: { type: 'number', description: 'How many other windows to list by title (default 8).' },
    },
    async execute({ window, ocr, image, marks, max, maxDim, windowList }) {
      const t0 = Date.now();
      const fg = win32.foregroundWindow();
      const w = window ? resolveWindowDefault(window) : resolveWindowDefault(fg) || resolveWindowDefault('');
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_look');
      if (refused) return refused;
      pulse('看一眼屏幕', { reset: true });

      const limit = Math.max(10, Math.min(200, Number(max ?? 80)));
      const all = win32.listWindows({ visibleOnly: true });
      const others = all.filter((x) => x.hwnd !== w.hwnd).slice(0, Math.max(0, Number(windowList ?? 8)))
        .map((x) => ({ hwnd: x.hwnd, app: x.app, title: String(x.title || '').slice(0, 60) }));

      let elements = [];
      let treeError = null;
      try {
        const tree = uiaTree(w.hwnd, { depth: 6, max: 600 });
        elements = (tree.elements || []).slice(0, limit).map((e, i) => ({
          n: i + 1, ref: 'e' + (i + 1), role: e.role, name: String(e.name || '').slice(0, 80),
          rect: { x: e.x, y: e.y, w: e.w, h: e.h }, pats: e.pats || [],
        }));
        rememberLook(w.hwnd, elements);
      } catch (e) { treeError = e && e.message; }

      // 控件树很稀（Chromium/Electron、游戏画面）时，顺手把能读到的文字带上——这一步不额外花调用
      let autoText = null;
      if (elements.length <= 8) {
        try {
          const ux = uiaText(w.hwnd, { match: '' });
          if (ux && ux.ok && String(ux.text || '').trim().length > 0) {
            autoText = { source: 'uia-' + (ux.via || 'text'), length: String(ux.text).length, text: String(ux.text).slice(0, 1200) };
          }
        } catch {}
      }

      const out = {
        ok: true,
        foreground: fg ? (all.find((x) => x.hwnd === fg) || { hwnd: fg }).title : null,
        window: { hwnd: w.hwnd, app: w.app, title: w.title, rect: w.bounds },
        others,
        controlCount: elements.length,
        controls: elements,
        ...(autoText ? { text: autoText } : {}),
        ...(elements.length <= 8 && !autoText ? { sparseHint: 'This window exposes almost no controls (typical for Chromium/Electron apps and canvas UIs). For web pages use the built-in browser tools; to read the screen use desktop_text or desktop_read; to click something you can see, use desktop_click{text} or coordinates from an OCR result.' } : {}),
        ms: Date.now() - t0,
      };
      if (treeError) out.treeError = treeError;
      if (elements.length <= 8) {
        out.hint = 'This app exposes few accessibility controls (Chromium/Electron apps usually do). Prefer, in order: (1) the built-in browser tools for web pages, (2) desktop_text to read the text, (3) image:true + desktop_click{text} to hit things by OCR.';
        out.sparseTree = true;
      }
      if (isBrowserApp(w.app)) {
        out.browserHint = 'This is a browser window. For web pages prefer the built-in browser tools (dsh_browser_*) — they read the page structure and do not move the mouse. Use desktop_* here only when you must drive the browser UI itself.';
      }

      if (ocr) {
        try {
          ensureForeground(w.hwnd);
          const cap = captureWindow(w, 1400);
          const r = ocrBuffer(cap.png, { scale: 1.2, prep: true });
          const kx = cap.width ? cap.rect.w / cap.width : 1;
          const ky = cap.height ? cap.rect.h / cap.height : 1;
          out.ocr = (r.lines || []).slice(0, 60).map((l) => ({
            text: l.text, x: Math.round(l.x * kx), y: Math.round(l.y * ky), w: Math.round(l.w * kx), h: Math.round(l.h * ky),
          }));
          out.ocrMs = Date.now() - t0;
        } catch (e) { out.ocrError = e && e.message; }
      }

      if (image) {
        try {
          const rect = windowClientRect(w);
          if (rect.w <= 0 || rect.h <= 0) throw new Error('window has no client area (minimized?)');
          let img = grabScreen(rect.x, rect.y, rect.w, rect.h);
          const capDim = Number(maxDim ?? 1280) || 0;
          if (capDim && Math.max(img.width, img.height) > capDim) {
            const k = capDim / Math.max(img.width, img.height);
            img = downscaleImg(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
          }
          if (marks !== false && elements.length) {
            const sx = rect.w ? img.width / rect.w : 1;
            const sy = rect.h ? img.height / rect.h : 1;
            const clickable = elements.filter((e) => e.name && (e.pats || []).length && e.rect.w >= 18 && e.rect.h >= 14);
            const items = clickable.slice(0, 25).map((e) => ({
              rect: { x: e.rect.x * sx, y: e.rect.y * sy, w: e.rect.w * sx, h: e.rect.h * sy },
              label: e.n,
            }));
            img = annotate(img, items, { scale: 3 });
          }
          const png = encodePng(img.width, img.height, img.rgb);
          const ref = await attach(png, 'desktop-look-' + Date.now() + '.png');
          if (ref) out.image = ref;
          out.imageSize = { width: img.width, height: img.height };
        } catch (e) { out.imageError = e && e.message; }
      }

      out.ms = Date.now() - t0;
      settle(true, '已就绪');
      logTool('desktop_look', { hwnd: w.hwnd, controls: elements.length, ocr: !!ocr, image: !!image });
      return out;
    },
  });

  reg({
    name: 'desktop_tree',
    description: 'Read the UI Automation (UIA) control tree of a window as a NUMBERED list: index, role, name, screen rect, patterns. Pass an index to desktop_click(control=N, expect={role,name}) to press it exactly, with an identity check that refuses to click a control that moved. meaningfulOnly (default true) drops decorative containers and reports how many were filtered, which cuts the payload from ~700 elements to dozens. Returns [] for apps with no UIA provider (Electron/Qt draw their own UI) — fall back to desktop_read there.',
    output: textOutput,
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      depth: { type: 'number', description: 'Max depth (default 4, max 12).' },
      max: { type: 'number', description: 'Max elements to return after filtering (default 80).' },
      query: { type: 'string', description: 'Only return elements whose name contains this text.' },
      meaningfulOnly: { type: 'boolean', description: 'Drop decorative containers (default true). Set false to see every element.' },
    },
    async execute({ window, depth, max, query, meaningfulOnly }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const t0 = Date.now();
      const want = Math.max(1, Math.min(Number(max) || 80, 400));
      const res = uiaTree(w.hwnd, { depth: depth ?? 4, max: Math.min(600, want * 6) });
      const all = (res.elements || []).map((e, i) => ({
        index: i, role: e.role, name: e.name,
        rect: { x: e.x, y: e.y, w: e.w, h: e.h },
        pats: e.pats, depth: e.depth,
      }));
      const controlTotal = all.length;
      const INTERACTIVE = new Set(['Button', 'MenuItem', 'CheckBox', 'RadioButton', 'Edit', 'ComboBox', 'TabItem', 'ListItem', 'TreeItem', 'Hyperlink', 'SplitButton', 'Slider', 'Spinner', 'ToolBar', 'Menu', 'Text']);
      const keep = meaningfulOnly === false ? () => true : (e) => {
        const named = !!(e.name && String(e.name).trim());
        if (INTERACTIVE.has(e.role)) return true;
        if (e.role === 'Pane' && named) return true;          // #32770 对话框等
        if (e.role === 'Window' && named) return true;
        if (named && e.pats && e.pats.length > 0) return true;
        return false;
      };
      let els = all.filter(keep);
      const q = String(query || '').toLowerCase();
      if (q) els = els.filter((e) => String(e.name || '').toLowerCase().includes(q));
      const filteredOut = controlTotal - els.length;
      const shown = els.slice(0, want);
      const out = {
        ok: true, window: w.hwnd, title: res.title || w.title,
        controlTotal, returned: shown.length, filteredOut, ms: Date.now() - t0,
        elements: shown,
        hint: 'Press one with desktop_click{control:N, expect:{role,name}} — it re-reads the tree and refuses if the control changed.',
      };
      const actionable = shown.filter((e) => INTERACTIVE.has(e.role) || (e.pats && e.pats.length > 1)).length;
      if (!actionable && !q) {
        try {
          const cap = captureWindow(w, 1200);
          const r = ocrBuffer(cap.png, { scale: 1.2, prep: true });
          out.uia = 'empty';
          out.fallback = 'ocr';
          out.ocrSample = (r.lines || []).slice(0, 12).map((l) => l.text);
          out.hint = 'No UIA controls here (Electron/Qt/canvas UI). Use desktop_read for the text, or desktop_click{text} to click by OCR text.';
        } catch (e) {
          out.hint = 'No UIA controls, and the OCR fallback failed: ' + (e && e.message);
        }
      }
      return plain(out);
    },
  });

  reg({
    name: 'desktop_invoke',
    lock: true,
    description: 'Trigger a UIA control by its name — Invoke a button/menu item, Toggle a checkbox, Select a tab/list item, Expand a menu, or Focus an input. This is the most reliable way to press a control: it does not move the mouse or need the window in front. Use desktop_tree first to see which names and patterns exist.',
    output: textOutput,
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or title substring.' },
      text: { type: 'string', required: true, description: 'Visible name of the control (alias: name). Matched case-insensitively: an exact name wins, otherwise the unique substring. If several controls match, nothing is invoked and the candidates are returned.' },
      name: { type: 'string', description: 'Alias of text.' },
      action: { type: 'string', description: 'invoke | toggle | select | expand | focus (default invoke).' },
      match: { type: 'string', description: 'Name matching: auto (default: exact first, then unique substring) | exact | substring.' },
      role: { type: 'string', description: 'Optional control type filter, e.g. "Button", "MenuItem".' },
      depth: { type: 'number', description: 'Search depth (default 6).' },
    },
    async execute({ window, text, name, action, match, role, depth }) {
      const label = text || name;
      // 兼容：有人把控件名写进 match（match 只在 auto/exact/substring 时才是匹配模式）
      const matchIsMode = match === undefined || ['auto', 'exact', 'substring'].includes(match);
      const ctrlName = label || (matchIsMode ? '' : match);
      const matchMode = matchIsMode ? (match || 'auto') : 'auto';
      if (!ctrlName) throw new Error('desktop_invoke needs the control name: pass text (or name), e.g. {window:"记事本", text:"保存"}');
      const text2 = ctrlName;
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_invoke');
      if (refused) return refused;
      pulse('触发「' + text2 + '」', { reset: true });
      const t0 = Date.now();
      const res = uiaAct(w.hwnd, { match: text2, action: action || 'invoke', depth: depth ?? 6, matchMode, role: role || '' });
      const out = plain({
        ok: !!(res.ok && res.done),
        window: w.hwnd,
        title: w.title,
        matched: res.matched,
        matchedRole: res.matchedRole,
        matchKind: res.matchKind,
        rect: res.rect,
        action: res.action,
        patterns: res.patterns,
        done: !!res.done,
        ambiguous: !!res.ambiguous,
        candidates: res.candidates,
        suggestions: res.suggestions,
        error: res.error,
        ms: Date.now() - t0,
      });
      settle(out.ok, out.ok ? '已触发' : '未触发');
      logTool('desktop_invoke', { ok: out.ok, matched: out.matched, matchedRole: out.matchedRole, ambiguous: out.ambiguous, error: out.error });
      return out;
    },
  });

  reg({
    name: 'desktop_sequence',
    lock: true,
    description: 'Run several desktop actions in ONE call: focus, click (control/text/x,y), type, key, scroll, wait, read, screenshot. Each step is an object {action, ...}. dryRun returns the plan without touching anything; stopOnError (default true) halts on the first failure; a step limit (maxSteps, 24) bounds runaway loops; the user can abort at any moment by holding Esc. Prefer this for any multi-step task: it replaces N round trips with one.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      steps: { type: 'array', items: { type: 'object' }, description: 'Steps: {action:"click",ref|name|control|text|x,y|fx,fy} | {action:"type",text,submit} | {action:"key",key} | {action:"scroll",clicks,direction} | {action:"wait",ms} | {action:"focus"} | {action:"read"} | {action:"screenshot"}.' },
      dryRun: { type: 'boolean', description: 'Only validate and describe the steps, do not execute them.' },
      stopOnError: { type: 'boolean', description: 'Stop at the first failing step (default true).' },
      maxSteps: { type: 'number', description: 'Hard limit on step count (default and max 24).' },
    },
    async execute({ window, steps, dryRun, stopOnError, maxSteps }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_sequence');
      if (refused) return refused;
      const planned = Array.isArray(steps) ? steps.length : 0;
      pulse('准备执行 ' + planned + ' 步', { reset: true });
      const rect0 = windowClientRect(w);
      const keyMap = { enter: 0x0d, esc: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, delete: 0x2e, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22 };
      let stepNo = 0;
      const primitives = {
        cancelled: () => { const stop = escPending() || win32.escapePressed(); if (stop) consumeEsc(); return stop; },
        sleep: (ms) => sleep(Math.max(0, Math.min(Number(ms) || 0, 15000))),
        exec: async (action, step) => {
          stepNo++;
          pulse('第 ' + stepNo + ' 步 · ' + String(action), { progress: planned ? { done: stepNo - 1, total: planned } : null });
          if (action === 'focus') return { ok: ensureForeground(w.hwnd) };
          if (action === 'wait') { await sleep(step.ms ?? 300); return { ok: true }; }
          if (action === 'read') {
            if (!ensureForeground(w.hwnd)) return { ok: false, error: 'cannot focus' };
            await sleep(100);
            const cap = captureWindow(w, 1400);
            const r = ocrBuffer(cap.png, { scale: 1.2, prep: true });
            return { ok: true, lines: (r.lines || []).slice(0, step.limit || 40).map((l) => l.text) };
          }
          if (action === 'screenshot') {
            const ref = await attach(grabPng(rect0.x, rect0.y, rect0.w, rect0.h, 1400).png, 'seq-' + Date.now() + '.png');
            return { ok: true, image: ref || undefined, path: ref ? undefined : 'attachments service unavailable' };
          }
          if (action === 'key') {
            if (!ensureForeground(w.hwnd)) return { ok: false, error: 'cannot focus' };
            let chord;
            try { chord = parseKeyChord(step.key); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
            const n = Math.max(1, Math.min(20, Number(step.repeat || 1)));
            for (let i = 0; i < n; i++) { win32.pressCombo(chord.vk, chord.mods.includes('ctrl') || chord.mods.includes('win'), chord.mods.includes('shift'), chord.mods.includes('alt')); await sleep(70); }
            return { ok: true, key: chord.key, mods: chord.mods };
          }
          if (action === 'scroll') {
            const n = Math.max(1, Math.min(20, Number(step.clicks || step.amount || 3)));
            const down = String(step.direction || 'down').toLowerCase() !== 'up';
            const vk = down ? 0x22 : 0x21;
            if (!ensureForeground(w.hwnd)) return { ok: false, error: 'cannot focus' };
            for (let i = 0; i < n; i++) { win32.pressCombo(vk, false, false, false); await sleep(90); }
            return { ok: true };
          }
          if (action === 'type') {
            if (!ensureForeground(w.hwnd)) return { ok: false, error: 'cannot focus' };
            win32.setClipboardText(String(step.text ?? ''));
            await sleep(400);
            try { const ed = win32.findEditableChild(w.hwnd); if (ed) win32.sendPaste(ed.hwnd); else win32.pressCombo(0x56, true, false, false); }
            catch { win32.pressCombo(0x56, true, false, false); }
            await sleep(220);
            if (step.submit) { win32.pressCombo(0x0d, false, false, false); await sleep(150); }
            return { ok: true, text: String(step.text ?? '').slice(0, 40) };
          }
          if (action === 'click') {
            if (!ensureForeground(w.hwnd)) return { ok: false, error: 'cannot focus' };
            await sleep(100);
            let cx, cy, label = '';
            if (step.ref) {
              const got = lookupRef(w.hwnd, step.ref);
              if (!got || got.error) return { ok: false, error: (got && got.error) || 'ref not found', ref: step.ref };
              const r = got.hit.rect;
              if (!(r && r.w > 0 && r.h > 0)) return { ok: false, error: 'that control has no clickable rect', ref: step.ref };
              cx = Math.round(r.x + r.w / 2); cy = Math.round(r.y + r.h / 2); label = got.hit.name;
            } else if (step.control !== undefined && step.control !== null) {
              const tree = uiaTree(w.hwnd, { depth: 6, max: 600 });
              const el = (tree.elements || [])[Number(step.control)];
              if (!el) return { ok: false, error: 'control index out of range' };
              const want = step.expect;
              if (want) {
                const wn = typeof want === 'string' ? want : String(want.name || '');
                const wr = typeof want === 'object' ? String(want.role || '') : '';
                if ((wn && !String(el.name || '').toLowerCase().includes(wn.toLowerCase())) || (wr && String(el.role) !== wr)) {
                  return { ok: false, error: 'control identity mismatch', actual: el.role + ' "' + el.name + '"' };
                }
              }
              cx = Math.round(el.x + el.w / 2); cy = Math.round(el.y + el.h / 2); label = el.name;
            } else if (step.name) {
              const found = findControl(w.hwnd, { name: step.name, role: step.role || '', matchMode: step.match || 'exact' });
              if (!found.ok || !found.rect) return { ok: false, error: found.error || 'control not found', suggestions: found.suggestions, candidates: found.candidates };
              const r = found.rect;
              cx = Math.round(r.x + r.w / 2); cy = Math.round(r.y + r.h / 2); label = found.matched;
            } else if (step.text) {
              const cap = captureWindow(w, 1400);
              const res = ocrBuffer(cap.png, { scale: 1.5, prep: true });
              const hit = findLine(res, step.text);
              if (!hit) return { ok: false, error: 'text not found: ' + step.text };
              const kx = cap.width ? cap.rect.w / cap.width : 1, ky = cap.height ? cap.rect.h / cap.height : 1;
              cx = cap.rect.x + Math.round((hit.x + hit.w / 2) * kx);
              cy = cap.rect.y + Math.round((hit.y + hit.h / 2) * ky);
              label = hit.text;
            } else if (step.x !== undefined && step.y !== undefined) {
              const r = windowClientRect(w);
              cx = r.x + Number(step.x); cy = r.y + Number(step.y);
            } else if (step.fx !== undefined || step.fy !== undefined) {
              const r = windowClientRect(w);
              cx = r.x + Math.round((step.fx ?? 0.5) * r.w); cy = r.y + Math.round((step.fy ?? 0.5) * r.h);
            } else {
              return { ok: false, error: 'click step needs control, text, x/y or fx/fy' };
            }
            pulse('点击 ' + (label ? '「' + label + '」' : '(' + cx + ', ' + cy + ')'), { progress: planned ? { done: stepNo - 1, total: planned } : null });
            win32.screenClick(cx, cy);
            await sleep(step.settle ?? 350);
            return { ok: true, at: { x: cx, y: cy }, text: label };
          }
          return { ok: false, error: 'unknown action: ' + action };
        },
      };
      const res = await runSequence({ steps, dryRun: !!dryRun, stopOnError: stopOnError !== false, maxSteps, primitives });
      consumeEsc();
      const out = plain({ ...res, window: { hwnd: w.hwnd, title: w.title } });
      settle(out.ok !== false && !out.cancelled, out.cancelled ? '已按 Esc 停止' : (out.ok !== false ? '执行完成' : '中途停止'));
      logTool('desktop_sequence', { ok: out.ok !== false, executed: out.executed, failed: out.failed, cancelled: out.cancelled, window: w.hwnd, title: w.title });
      return out;
    },
  });

  reg({
    name: 'desktop_scroll',
    description: 'Scroll inside a window with the real mouse wheel (no focus needed: the wheel goes to whatever is under the pointer). Give client coordinates or fractions to pick the spot to scroll over; defaults to the window centre. Returns whether the pixels actually changed, so you can tell "scrolled to the end" from "this list does not scroll".',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      amount: { type: 'number', description: 'Wheel clicks (default 3). Larger scrolls further.' },
      direction: { type: 'string', description: 'up | down | left | right (default down).' },
      x: { type: 'number', description: 'Client-area x to scroll over (default: window centre).' },
      y: { type: 'number', description: 'Client-area y to scroll over.' },
      fx: { type: 'number', description: 'Fractional x 0..1 of the client area.' },
      fy: { type: 'number', description: 'Fractional y 0..1 of the client area.' },
      restore: { type: 'boolean', description: 'Put the mouse cursor back afterwards (default true).' },
    },
    lock: true,
    async execute({ window, amount, direction, x, y, fx, fy, restore }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_scroll');
      if (refused) return refused;
      const rect = windowClientRect(w);
      const px = rect.x + Math.round(x !== undefined ? Number(x) : (fx !== undefined ? fx * rect.w : rect.w / 2));
      const py = rect.y + Math.round(y !== undefined ? Number(y) : (fy !== undefined ? fy * rect.h : rect.h / 2));
      const dir = String(direction || 'down').toLowerCase();
      const n = Math.max(1, Math.abs(Number(amount) || 3));
      const vertical = dir === 'up' || dir === 'down';
      const sign = dir === 'up' || dir === 'left' ? 1 : -1;
      const step = 120 * sign;
      const probe = { x: Math.max(0, px - 200), y: Math.max(0, py - 160), w: Math.min(400, rect.w), h: Math.min(320, rect.h) };
      const before = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
      const prevCursor = win32.cursorPos();
      pulse('滚动 ' + (vertical ? '上下' : '左右'));
      for (let i = 0; i < n; i++) {
        win32.scrollAt(px, py, { delta: step, horizontal: !vertical });
        await sleep(60);
      }
      await sleep(220);
      const after = hash(grabPng(probe.x, probe.y, probe.w, probe.h).png);
      if (restore !== false && prevCursor) win32.setCursor(prevCursor.x, prevCursor.y);
      const changed = before !== after;
      settle(changed, changed ? '已滚动' : '滚不动了');
      logTool('desktop_scroll', { hwnd: w.hwnd, at: { x: px, y: py }, amount: n, direction: dir, changed });
      return {
        ok: true, window: w.hwnd, title: w.title, at: { x: px, y: py }, amount: n, direction: dir, changed,
        hint: changed ? undefined : 'The area did not move: either it is already at the end, or this content does not scroll by wheel (use the scrollbar, or a control that scrolls).',
      };
    },
  });

  reg({
    name: 'desktop_drag',
    description: 'Drag with the real mouse from one point to another inside a window (client coordinates or fractions): press, move in small steps, release. Use it for sliders, selecting text, moving files or resizing by handle. The window is focused first.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      fromX: { type: 'number', description: 'Client x where the drag starts.' },
      fromY: { type: 'number', description: 'Client y where the drag starts.' },
      toX: { type: 'number', description: 'Client x where the drag ends.' },
      toY: { type: 'number', description: 'Client y where the drag ends.' },
      fromFx: { type: 'number', description: 'Fractional start x 0..1 (alternative to fromX).' },
      fromFy: { type: 'number', description: 'Fractional start y 0..1.' },
      toFx: { type: 'number', description: 'Fractional end x 0..1 (alternative to toX).' },
      toFy: { type: 'number', description: 'Fractional end y 0..1.' },
      steps: { type: 'number', description: 'Intermediate mouse moves (default 12). More steps help apps that need a real drag gesture.' },
    },
    lock: true,
    async execute({ window, fromX, fromY, toX, toY, fromFx, fromFy, toFx, toFy, steps }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_drag');
      if (refused) return refused;
      ensureForeground(w.hwnd);
      await sleep(120);
      const rect = windowClientRect(w);
      const ax = rect.x + Math.round(fromX !== undefined ? Number(fromX) : (fromFx ?? 0.5) * rect.w);
      const ay = rect.y + Math.round(fromY !== undefined ? Number(fromY) : (fromFy ?? 0.5) * rect.h);
      const bx = rect.x + Math.round(toX !== undefined ? Number(toX) : (toFx ?? 0.5) * rect.w);
      const by = rect.y + Math.round(toY !== undefined ? Number(toY) : (toFy ?? 0.5) * rect.h);
      const before = hash(grabPng(rect.x, rect.y, rect.w, rect.h).png);
      pulse('拖拽');
      win32.dragFromTo(ax, ay, bx, by, { steps: Number(steps) || 12 });
      await sleep(320);
      const after = hash(grabPng(rect.x, rect.y, rect.w, rect.h).png);
      const changed = before !== after;
      settle(changed, changed ? '已拖拽' : '拖完没变化');
      logTool('desktop_drag', { hwnd: w.hwnd, at: { x: ax, y: ay }, to: { x: bx, y: by }, changed });
      return { ok: true, window: w.hwnd, title: w.title, from: { x: ax, y: ay }, to: { x: bx, y: by }, changed };
    },
  });

  reg({
    name: 'desktop_window',
    description: 'Manage one window without touching the mouse: activate (bring to front), minimize, maximize, restore, move/resize, or close it. Use it instead of clicking the title-bar buttons.',
    parameters: {
      window: { type: 'string', required: true, description: 'Target window: hwnd or a title substring.' },
      action: { type: 'string', required: true, description: 'activate | minimize | maximize | restore | move | close' },
      x: { type: 'number', description: 'With action=move: new screen x.' },
      y: { type: 'number', description: 'With action=move: new screen y.' },
      width: { type: 'number', description: 'With action=move: new width.' },
      height: { type: 'number', description: 'With action=move: new height.' },
    },
    lock: true,
    async execute({ window, action, x, y, width, height }) {
      const w = resolveWindowDefault(window);
      if (!w) throw new Error('window not found: ' + window);
      const refused = refusalFor(w, 'desktop_window');
      if (refused) return refused;
      const act = String(action || '').toLowerCase();
      let ok = false;
      if (act === 'activate') ok = ensureForeground(w.hwnd);
      else if (act === 'close') ok = Boolean(win32.closeWindow(w.hwnd));
      else if (act === 'move') {
        const b = w.bounds || {};
        const target = { x: x !== undefined ? Number(x) : b.x || 0, y: y !== undefined ? Number(y) : b.y || 0, w: width !== undefined ? Number(width) : b.width || 600, h: height !== undefined ? Number(height) : b.height || 400 };
        ok = win32.windowAction(w.hwnd, 'move', target);
      } else ok = win32.windowAction(w.hwnd, act);
      await sleep(160);
      const state = win32.windowState(w.hwnd);
      logTool('desktop_window', { hwnd: w.hwnd, at: act, ok });
      return { ok, window: w.hwnd, title: w.title, action: act, state, hint: ok ? undefined : 'The window did not accept that action (it may be hung or owned by another session).' };
    },
  });

  reg({
    name: 'desktop_doctor',
    description: '诊断本机是否具备桌面控制条件：平台 / OCR 引擎与语言 / 前台锁 / 可见窗口数 / 可编辑控件。首次使用前先跑一次，失败项会给出修复建议。',
    parameters: {},
    async execute() {
      const checks = [];
      const add = (id, ok, detail, hint) => checks.push({ id, ok, detail, hint: ok ? undefined : hint });
      const sd = secureDesktop(null);
      const locked = !!(sd && sd.active);
      add('platform', process.platform === 'win32', process.platform, 'This plugin supports Windows only');
      {
        const lv = dpiState.level;
        let detail = dpiState.mode + (lv === undefined || lv === null ? ' (来源 ' + dpiState.source + ')' : ' (level ' + lv + ', ' + dpiState.source + ')');
        if (dpiState.ok && dpiState.setterOk === false) {
          detail += ' · ' + dpiState.setter + ' 返回失败，但进程本身已具备 DPI 感知（宿主预设），属正常';
        } else if (!dpiState.ok) {
          detail += ' · ' + (dpiState.error || dpiState.setterInfo || '未知');
        }
        add('dpi', !!dpiState.ok, detail, '进程没有 DPI 感知：在 125%/150% 缩放下所有点击都会按比例偏。请用正常的用户会话启动，并确认没有外部工具重置 DPI 上下文。');
      }
      try {
        const ms = monitors();
        const vs = virtualScreen();
        add('monitors', ms.length > 0, ms.length + ' monitor(s), virtual screen ' + vs.w + 'x' + vs.h + ' @ ' + vs.x + ',' + vs.y, 'Monitor enumeration returned nothing: check the display driver; coordinates fall back to the primary screen.');
      } catch (e) { add('monitors', false, String(e && e.message || e), 'Monitor enumeration failed.'); }
      if (locked) { add('ocr', true, '锁屏中，跳过（解锁后重跑可验证）；不影响点击与输入本身', null); }
      try {
        if (locked) throw { skip: true };
        const cands = win32.listWindows({ onScreenOnly: true }).filter((x) => x.bounds.width > 400 && x.bounds.height > 200);
        const w = cands.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
        if (!w) throw new Error('no visible window');
        const cap = captureWindow(w, 0);
        const r = ocrBuffer(cap.png, { scale: 1.3, prep: true });
        add('ocr', (r.lines || []).length > 0, `${(r.lines || []).length} 行 / ${r.ocrMs ?? 0}ms / ${r.language || '?'}`, '确认系统已安装「中文(简体)」OCR 语言包（设置 → 时间和语言 → 语言）');
      } catch (e) { if (!(e && e.skip)) add('ocr', false, String(e && e.message || e), '同上；若报 OCR 脚本缺失，重装插件'); }
      if (locked) { add('foreground', true, '锁屏中，跳过（解锁后重跑可验证前台锁）', null); }
      try {
        if (locked) throw { skip: true };
        const cands = win32.listWindows({ onScreenOnly: true }).filter((x) => x.bounds.width > 400 && x.bounds.height > 200);
        const w = cands.sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0];
        const own = Number(win32.foregroundWindow());
        const cands2 = win32.listWindows({ onScreenOnly: true }).filter((x) => x.bounds.width > 400 && x.bounds.height > 200 && (x.title || '').trim() && !/^(TextInputHost|LockApp|NVIDIA Overlay|SearchHost|StartMenuExperienceHost|ShellExperienceHost)\.exe$/i.test(x.app || ''));
        const wf = (cands2.find((x) => Number(x.hwnd) === own) || cands2[0] || w);
        const f = ensureForeground(wf.hwnd);
        add('foreground', !!f, f ? '可抢前台' : '被系统拒绝', '用管理员运行 DSH，或关闭 UAC 安全桌面/全屏独占程序');
      } catch (e) { if (!(e && e.skip)) add('foreground', false, String(e && e.message || e), '同上'); }
      try {
        const ws = win32.listWindows({ onScreenOnly: true }).slice(0, 10);
        let found = null;
        for (const w of ws) { const ed = win32.findEditableChild(w.hwnd); if (ed) { found = { ...ed, title: w.title }; break; } }
        add('editable-child', true, found ? `${found.cls} 在「${found.title}」` : '当前没有带输入框的窗口（本次不用输入即可）', null);
      } catch (e) { add('editable-child', true, '跳过: ' + String(e && e.message || e), null); }
      try {
        const { hud } = await import('./hud.mjs');
        const h = hud();
        if (!h) throw new Error('状态条创建失败（不影响点击/输入，只是没有屏幕提示）');
        add('hud', true, '屏幕底部提示条可用' + (h.hwnd ? ' (hwnd ' + h.hwnd + ')' : ''), null);
      } catch (e) { add('hud', true, '状态条不可用：' + String(e && e.message || e) + '（不影响主功能）', null); }
      try {
        const lg = readLog(1);
        add('action-log', true, lg.total ? (lg.total + ' 条记录 · ' + lg.file) : ('等待第一次操作 · ' + lg.file), null);
      } catch (e) { add('action-log', true, '日志不可用：' + String(e && e.message || e), null); }
      add('secure-desktop', true, locked ? ('当前是锁屏 / 安全界面（' + (sd.app || '?') + '），模拟输入会被拒绝；解锁后即可正常操作') : '可正常操作（不在锁屏或安全桌面上）', null);
      const okAll = checks.every((c) => c.ok);
      return { ok: okAll, checks, windows: win32.listWindows({ onScreenOnly: true }).length, note: okAll ? '可以直接使用' : '按 hint 修复后重跑 desktop_doctor' };
    },
  });

  reg({
    name: 'desktop_log',
    description: '查看桌面操作日志：每一次真的点击 / 输入 / 按键 / 序列都会记一条（时间、工具、窗口、坐标、结果、是否重试），存在临时目录的 actions.jsonl。新的在前。clear:true 会把当前日志归档成 .1 后清空。',
    output: textOutput,
    parameters: {
      limit: { type: 'number', description: '返回多少条，默认 30，最多 500。' },
      clear: { type: 'boolean', description: '归档并清空现有日志（默认 false）。' },
    },
    async execute({ limit, clear }) {
      if (clear) {
        const c = clearLog();
        return plain({ ok: !!c.cleared, cleared: !!c.cleared, archived: c.archived, file: c.file, previousEntries: c.total, error: c.error });
      }
      const r = readLog(limit ?? 30);
      return plain({
        ok: true,
        file: r.file,
        total: r.total,
        returned: r.entries.length,
        entries: r.entries,
        hint: r.total ? undefined : '还没有记录：执行一次 desktop_click / desktop_type / desktop_sequence 之后再看。',
      });
    },
  });

  reg({
    name: 'desktop_course',
    lock: true,
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
      const refused = refusalFor(w, 'desktop_course');
      if (refused) return refused;
      consumeEsc();
      const total = Number(rounds) || 5;
      const res = await courseTick({
        hwnd: w.hwnd,
        rounds: total,
        interval: Number(interval) || 4000,
        onQuiz: onQuiz || 'ask',
        nextWords,
        dryRun: !!dryRun,
        cancelled: () => escPending(),
        onRound: (i) => pulse('盯课 ' + i + '/' + total, { progress: { done: i - 1, total } }),
      });
      consumeEsc();
      settle(!res.stoppedByUser, res.stoppedByUser ? '已按 Esc 停止' : '本轮盯课结束');
      logTool('desktop_course', { ok: true, rounds: res.executedRounds, stoppedByUser: res.stoppedByUser, onQuiz });
      return { ...res, window: { hwnd: w.hwnd, title: w.title } };
    },
  });
}
