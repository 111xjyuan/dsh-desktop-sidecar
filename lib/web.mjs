/**
 * 内置浏览器通道（CDP）。
 *
 * 思路借自 dsh-pilot 与 dsh-computer-use-win：不用截图喂模型，而是注入一段
 * 页面脚本，把可交互元素编号（ref），再返回结构化文本快照；模型用 ref 点击、
 * 输入，不依赖视觉模型，也不去抢用户的鼠标和前台。
 *
 * 我们自己的取舍：
 *  - 单实例单标签（ref 绑定当前页，多标签会毁掉 ref 模型）；
 *  - 只允许 http/https（`file:`、`javascript:` 一律拒绝）；
 *  - 复用系统已有的 Edge/Chrome，默认用固定 profile 记住登录，可选一次性临时 profile；
 *  - 零外部依赖：CDP 走 Node 自带 WebSocket。
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const MAX_TEXT = 6000;
const MAX_ELEMENTS = 120;
const NAV_TIMEOUT_MS = 20000;
const PROFILE_PREFIX = 'dsh-sidecar-web-';
const ELS = 'window.__dshSidecarEls';

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 固定 profile：登录、cookie、localStorage 都留在这里，下次接着用
const PROFILE_ROOT = process.env.DSH_SIDECAR_WEB_PROFILE
  || (process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'dsh-sidecar', 'web-profile')
    : join(homedir(), '.dsh', 'dsh-sidecar', 'web-profile'));
const PROFILE_STATE = join(PROFILE_ROOT, 'browser.json');

let liveProfile = null;

/** 上次那个浏览器还活着吗？活着就直接接管，登录态和标签都还在。 */
async function tryAttach(port) {
  if (!port) return null;
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return null;
    const v = await res.json();
    if (!String(v.webSocketDebuggerUrl || '').includes(':' + port + '/')) return null;
    return v;
  } catch {
    return null;
  }
}

function readProfileState() {
  try {
    const rec = JSON.parse(readFileSync(PROFILE_STATE, 'utf8'));
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;
  }
}

function writeProfileState(rec) {
  try {
    mkdirSync(PROFILE_ROOT, { recursive: true });
    writeFileSync(PROFILE_STATE, JSON.stringify(rec, null, 2));
  } catch {}
}

/** 这个端口还能不能绑上——比 HTTP 探测可靠，避免接管别人的浏览器。 */
function canBind(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

export function browserPath() {
  const override = process.env.DSH_SIDECAR_BROWSER;
  if (override && existsSync(override)) return override;
  const found = CANDIDATES.find((p) => existsSync(p));
  if (found) return found;
  throw new Error('找不到 Edge/Chrome。装一个 Edge 即可，或用环境变量 DSH_SIDECAR_BROWSER 指定浏览器路径。');
}

export function assertWebUrl(url) {
  let t = String(url || '').trim();
  if (t === 'about:blank') return t;
  // 模型经常只写 example.com 或 localhost:3000，这里补全协议再判断
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(file|javascript|data|about|mailto|ftp|ws|wss):/i.test(t);
  if (!hasScheme) t = (local ? 'http://' : 'https://') + t;
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error('这个地址不完整：' + JSON.stringify(String(url)) + '（要带 http:// 或 https://）');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('内置浏览器只打开 http/https 网页，不接受 ' + u.protocol + '（本地文件请直接用编辑器/资源管理器打开）');
  }
  return u.href;
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error('CDP ' + msg.error.code + ' ' + msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method !== undefined) {
        for (const fn of this.events.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  async call(method, params = {}, timeoutMs = 15000) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时: ' + method));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 等一次事件；永不 reject，超时就返回 null，调用方不必 try/catch。 */
  once(method, timeoutMs = 10000) {
    return new Promise((resolve) => {
      const listener = (params) => {
        clearTimeout(timer);
        const list = this.events.get(method) || [];
        const at = list.indexOf(listener);
        if (at !== -1) list.splice(at, 1);
        resolve(params);
      };
      const timer = setTimeout(() => {
        const list = this.events.get(method) || [];
        const at = list.indexOf(listener);
        if (at !== -1) list.splice(at, 1);
        resolve(null);
      }, timeoutMs);
      const list = this.events.get(method) || [];
      list.push(listener);
      this.events.set(method, list);
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

export class WebBrowser {
  constructor(opts = {}) {
    this.status = 'stopped';
    this.child = null;
    this.cdp = null;
    this.port = 0;
    this.profileDir = null;
    this.url = '';
    this.title = '';
    this.headed = opts.headed === true;
    this.profile = opts.profile === 'temp' ? 'temp' : 'persistent';
    this.attached = false;
    this.stateFile = PROFILE_STATE;
    this.lastError = '';
    this.opLock = Promise.resolve();
  }

  withOp(fn) {
    const run = this.opLock.then(fn, fn);
    this.opLock = run.catch(() => {});
    return run;
  }

  state() {
    return {
      status: this.status,
      url: this.url,
      title: this.title,
      headed: this.headed,
      profile: this.profile,
      profileDir: this.profile === 'persistent' ? PROFILE_ROOT : this.profileDir,
      attached: this.attached,
      pid: this.child ? this.child.pid : null,
      port: this.port,
      error: this.lastError,
    };
  }

  async pickPort(base = 9222) {
    for (let p = base; p < base + 40; p++) if (await canBind(p)) return p;
    return null;
  }

  /** 连上已有的标签页（优先复用它，避免每接一次就多一个空白标签）。 */
  async connectTab(port) {
    let target = null;
    {
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const list = await res.json();
          const pages = (list || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          target = pages.find((t) => t.url && t.url !== 'about:blank') || pages[0] || null;
        }
      } catch {}
    }
    if (!target) target = await this.newTab(port, 'about:blank');
    this.cdp = new Cdp(target.webSocketDebuggerUrl);
    this.cdp.targetId = target.id || null;
    await this.cdp.call('Page.enable');
    await this.cdp.call('Runtime.enable');
    this.watchDialog();
    this.url = String(target.url || '');
    this.title = '';
  }

  /** 网页弹窗会卡住页面：先记下来，等调用方决定 accept/dismiss。 */
  watchDialog() {
    if (!this.cdp || this.dialogWatching) return;
    this.dialogWatching = true;
    try {
      const list = this.cdp.events.get('Page.javascriptDialogOpening') || [];
      list.push((p) => { this.dialog = { type: p.type, message: p.message, at: Date.now() }; });
      this.cdp.events.set('Page.javascriptDialogOpening', list);
      const closed = this.cdp.events.get('Page.javascriptDialogClosed') || [];
      closed.push(() => { this.dialog = null; });
      this.cdp.events.set('Page.javascriptDialogClosed', closed);
    } catch {}
  }

  /** 切到已存在的标签并重建 CDP 连接 */
  async attachTab(tabId) {
    const res = await fetch('http://127.0.0.1:' + this.port + '/json/list', { signal: AbortSignal.timeout(3000) });
    const list = await res.json();
    const t = (list || []).find((x) => x.id === tabId);
    if (!t || !t.webSocketDebuggerUrl) throw new Error('tab not found: ' + tabId);
    try { this.cdp && this.cdp.close(); } catch {}
    this.cdp = new Cdp(t.webSocketDebuggerUrl);
    this.cdp.targetId = t.id;
    this.dialogWatching = false;
    await this.cdp.call('Page.enable');
    await this.cdp.call('Runtime.enable');
    this.watchDialog();
    this.url = String(t.url || '');
  }

  async ensure() {
    if (this.status === 'ready' && this.cdp) return;
    if (this.status === 'starting') throw new Error('浏览器还在启动，请稍等再试');
    this.status = 'starting';
    try {
      const bin = browserPath();

      // 一、上次那个浏览器还活着（DSH 重启过、但浏览器没关）→ 直接接管，登录态不用重登
      if (this.profile === 'persistent') {
        const rec = readProfileState();
        if (rec && rec.port && (await tryAttach(rec.port))) {
          this.port = rec.port;
          this.profileDir = PROFILE_ROOT;
          this.attached = true;
          await this.connectTab(rec.port);
          this.status = 'ready';
          this.lastError = '';
          return;
        }
      }

      // 二、正常启动：持久模式用固定目录（记住登录），临时模式用完就删
      const port = await this.pickPort();
      if (port === null) throw new Error('9222-9262 都被占用，找不到空闲调试端口');
      this.port = port;
      this.attached = false;
      if (this.profile === 'persistent') {
        mkdirSync(PROFILE_ROOT, { recursive: true });
        this.profileDir = PROFILE_ROOT;
      } else {
        this.profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
        liveProfile = this.profileDir;
      }
      const argv = [
        '--remote-debugging-port=' + port,
        '--user-data-dir=' + this.profileDir,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--disable-features=Translate',
      ];
      if (this.headed) argv.push('--window-size=1280,860');
      else argv.push('--headless=new', '--disable-gpu');
      argv.push('about:blank');
      this.child = spawn(bin, argv, { stdio: 'ignore', windowsHide: !this.headed });
      this.child.once('exit', () => { this.child = null; this.cdp?.close(); this.cdp = null; this.status = 'stopped'; });
      this.child.once('error', (e) => { this.status = 'error'; this.lastError = String(e && e.message || e); });
      await this.waitForVersion(port);
      if (this.profile === 'persistent') writeProfileState({ port, pid: this.child ? this.child.pid : null, at: new Date().toISOString() });
      await this.connectTab(port);
      this.status = 'ready';
      this.lastError = '';
    } catch (e) {
      this.status = 'error';
      this.lastError = String(e && e.message || e);
      await this.stop();
      throw e;
    }
  }

  async waitForVersion(port) {
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const res = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1500) });
        if (!res.ok) continue;
        const v = await res.json();
        if (!String(v.webSocketDebuggerUrl || '').includes(':' + port + '/')) continue; // 别人的浏览器
        return v;
      } catch {}
    }
    throw new Error('浏览器没有在超时内暴露调试端口（可试 headed:true 看窗口报什么错）');
  }

  async newTab(port, url) {
    const res = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
    if (!res.ok) throw new Error('建标签页失败 (http ' + res.status + ')');
    return res.json();
  }

  async evaluate(expression, timeoutMs = 15000) {
    if (!this.cdp) await this.ensure(); // 没连上时先连（否则报 cdp 为 null，很难懂）
    const { result, exceptionDetails } = await this.cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (exceptionDetails) throw new Error(exceptionDetails.text || '页面脚本执行失败');
    return result.value;
  }

  async readTitle() {
    try { return String(await this.evaluate('document.title') || ''); } catch { return ''; }
  }

  async readUrl() {
    try { return String(await this.evaluate('location.href') || this.url); } catch { return this.url; }
  }

  /** 等加载事件；必须在触发动作之前调用（load 可能比监听器注册还快）。 */
  async waitForLoad(ms) {
    if (!this.cdp) return;
    await this.cdp.once('Page.loadEventFired', ms);
  }

  async goto(url) {
    await this.ensure();
    const target = assertWebUrl(url);
    const settled = this.waitForLoad(NAV_TIMEOUT_MS);
    await this.cdp.call('Page.navigate', { url: target }, NAV_TIMEOUT_MS);
    await settled;
    await sleep(250);
    this.url = await this.readUrl();
    this.title = await this.readTitle();
    return { ok: true, url: this.url, title: this.title };
  }

  async snapshot(opts = {}) {
    await this.ensure();
    const maxText = Math.min(20000, Math.max(200, Number(opts.maxText) || MAX_TEXT));
    const maxEls = Math.min(400, Math.max(5, Number(opts.maxElements) || MAX_ELEMENTS));
    const raw = await this.evaluate(`JSON.stringify((() => {
      const text = document.body ? document.body.innerText : '';
      const sel = 'a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="combobox"],[role="option"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
      const els = [];
      const seen = new Set();
      const roots = [document];
      for (const f of document.querySelectorAll('iframe')) {
        try { if (f.contentDocument && f.contentDocument.body) roots.push(f.contentDocument); } catch (e) {}
      }
      const labelOf = (el) => {
        const direct = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
        const inner = (el.innerText || '').trim();
        const val = (el.value || '').trim();
        const alt = el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '';
        return String(direct || inner || val || alt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      };
      for (const root of roots) {
        for (const el of root.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          const cs = getComputedStyle(el);
          if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) continue;
          const tag = el.tagName.toLowerCase();
          const item = {
            ref: els.length + 1,
            tag,
            type: el.getAttribute('type') || '',
            role: el.getAttribute('role') || '',
            label: labelOf(el),
            href: el.href || '',
          };
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) {
            const v = String(el.value == null ? '' : el.value);
            if (v) item.value = v.slice(0, 120);
            if (el.disabled) item.disabled = true;
            if (el.checked) item.checked = true;
          }
          els.push({ el, meta: item });
          if (els.length >= ${maxEls}) break;
        }
        if (els.length >= ${maxEls}) break;
      }
      ${ELS} = els.map((x) => Object.assign({ el: x.el }, x.meta));
      return {
        title: document.title,
        url: location.href,
        text: text.slice(0, ${maxText}),
        textLength: text.length,
        elements: els.map((x) => x.meta),
        frames: roots.length - 1,
        forms: document.querySelectorAll('input,textarea,select').length,
      };
    })())`, NAV_TIMEOUT_MS);
    const data = JSON.parse(raw);
    this.url = data.url;
    this.title = data.title;
    return {
      ok: true,
      url: data.url,
      title: data.title,
      text: data.text,
      textTruncated: data.textLength > data.text.length,
      elements: data.elements,
      frames: data.frames,
      hint: data.elements.length
        ? '用 ref 操作元素：action:"click" ref:N / action:"type" ref:N text:"..."。页面导航后 ref 会失效，重新 snapshot。'
        : '页面上没有可交互元素（可能是纯展示页或还没加载完），可 action:"wait" 后再快照。',
    };
  }

  resolveEl(target) {
    if (typeof target === 'number' && Number.isFinite(target)) {
      return `(${ELS} && ${ELS}[${target} - 1] && ${ELS}[${target} - 1].el) || null`;
    }
    return `document.querySelector(${JSON.stringify(String(target))})`;
  }

  async click(target) {
    await this.ensure();
    const settled = this.waitForLoad(2500);
    const before = this.url;
    const res = await this.evaluate(`(() => {
      const el = ${this.resolveEl(target)};
      if (!el) return { ok: false, error: '找不到这个元素（ref 可能已失效或选择器不匹配）——重新 snapshot 一次' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 80) };
    })()`);
    await settled;
    await sleep(250);
    const url = await this.readUrl();
    const title = await this.readTitle();
    if (res && res.ok) { this.url = url; this.title = title; }
    const changed = url !== before;
    return { ...res, url, title, changed };
  }

  async type(target, text, opts = {}) {
    await this.ensure();
    const value = String(text);
    const res = await this.evaluate(`(() => {
      const el = ${this.resolveEl(target)};
      if (!el) return { ok: false, error: '找不到要输入的元素——重新 snapshot' };
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const before = el.value;
      const next = ${opts.replace === false ? 'String(before == null ? "" : before) + ' + JSON.stringify(value) : JSON.stringify(value)};
      if (desc && desc.set) desc.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, tag: el.tagName.toLowerCase(), value: String(el.value).slice(0, 200) };
    })()`);
    return res;
  }

  /** 按用户看得见的字段名批量填表（借了 pilot 的打分匹配思路）。 */
  async fill(fields) {
    await this.ensure();
    const list = [];
    for (const f of Array.isArray(fields) ? fields.slice(0, 20) : []) {
      if (!f || typeof f.label !== 'string' || !f.label.trim() || typeof f.value !== 'string') continue;
      list.push({ label: f.label.trim().slice(0, 200), value: f.value.slice(0, 5000) });
    }
    if (!list.length) return { ok: false, error: 'fields 需要形如 [{label:"邮箱", value:"a@b.c"}]', filled: [], failed: [] };
    const raw = await this.evaluate(`JSON.stringify((() => {
      const wanted = ${JSON.stringify(list)};
      const norm = (v) => String(v || '').toLowerCase().replace(/\\s+/g, ' ').trim();
      const editable = (el) => {
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea' || tag === 'select') return !el.disabled && !el.readOnly;
        if (tag !== 'input') return false;
        const t = (el.type || 'text').toLowerCase();
        return !el.disabled && !el.readOnly && !['hidden','button','submit','reset','image','checkbox','radio','file'].includes(t);
      };
      const labelsOf = (el) => {
        const out = [el.getAttribute('aria-label'), el.placeholder, el.name, el.id];
        for (const l of Array.from(el.labels || [])) out.push(l.textContent);
        for (const id of String(el.getAttribute('aria-labelledby') || '').split(/\\s+/)) {
          if (id) out.push((document.getElementById(id) || {}).textContent);
        }
        return out.map(norm).filter(Boolean);
      };
      const controls = Array.from(document.querySelectorAll('input,textarea,select')).filter(editable);
      const filled = [];
      const failed = [];
      for (const field of wanted) {
        const want = norm(field.label);
        let best = null;
        let bestScore = 0;
        for (const el of controls) {
          for (const cand of labelsOf(el)) {
            const score = cand === want ? 3 : (cand.includes(want) || want.includes(cand) ? 1 : 0);
            if (score > bestScore) { best = el; bestScore = score; }
          }
        }
        if (!best) { failed.push({ label: field.label, error: '没有匹配的可编辑控件' }); continue; }
        best.focus();
        const isSelect = best.tagName.toLowerCase() === 'select';
        const proto = best instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : best instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(best, field.value); else best.value = field.value;
        best.dispatchEvent(new Event('input', { bubbles: true }));
        best.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push({ label: field.label, value: String(best.value).slice(0, 120), score: bestScore });
      }
      return { filled, failed };
    })())`);
    const data = JSON.parse(raw);
    return { ok: data.failed.length === 0, ...data };
  }

  async press(key) {
    await this.ensure();
    const settled = this.waitForLoad(2000);
    const map = { enter: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', space: 'Space', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown' };
    const parts = String(key || '').split('+').map((s) => s.trim()).filter(Boolean);
    const mainRaw = parts.length ? parts[parts.length - 1] : '';
    const main = map[mainRaw.toLowerCase()] || (mainRaw.length === 1 ? mainRaw : mainRaw);
    const mods = parts.slice(0, -1).reduce((acc, m) => {
      const v = m.toLowerCase();
      acc[v === 'ctrl' || v === 'control' ? 2 : v === 'alt' ? 1 : v === 'shift' ? 8 : v === 'meta' || v === 'win' || v === 'cmd' ? 4 : 0] = true;
      return acc;
    }, {});
    const modifiers = Object.keys(mods).reduce((n, k) => n + Number(k), 0);
    // 只发 key 有些页面（必应搜索框这类监听 keyCode 的）不理，补齐 code / keyCode / text
    const VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
    const CODE = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
    const vk = VK[main] || (main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0);
    const code = CODE[main] || (main.length === 1 ? 'Key' + main.toUpperCase() : main);
    const text = main.length === 1 ? main : main === 'Enter' ? String.fromCharCode(13) : undefined;
    const base = { key: main, code, modifiers, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (text) base.text = text;
    await this.cdp.call('Input.dispatchKeyEvent', text ? { type: 'keyDown', ...base } : { type: 'rawKeyDown', ...base });
    await this.cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await settled;
    await sleep(220);
    // Enter 经常触发提交/跳转，这里把最新地址也回给对方，省得它再猜
    try { this.url = await this.readUrl(); this.title = await this.readTitle(); } catch {}
    return { ok: true, key: main, modifiers, url: this.url, title: this.title };
  }

  async scroll(delta) {
    await this.ensure();
    const d = Math.max(-5000, Math.min(5000, Math.round(Number(delta) || 600)));
    const y = await this.evaluate('window.scrollY');
    await this.evaluate('window.scrollBy(0, ' + d + ')');
    await sleep(200);
    const after = await this.evaluate('window.scrollY');
    return { ok: true, from: y, to: after, moved: after !== y };
  }

  async waitFor(opts = {}) {
    await this.ensure();
    const text = typeof opts.text === 'string' && opts.text ? opts.text.slice(0, 2000) : null;
    const selector = typeof opts.selector === 'string' && opts.selector ? opts.selector.slice(0, 500) : null;
    const urlIncludes = typeof opts.urlIncludes === 'string' && opts.urlIncludes ? opts.urlIncludes.slice(0, 1000) : null;
    if (!text && !selector && !urlIncludes) return { ok: false, error: '至少给 text / selector / urlIncludes 之一' };
    const timeoutMs = Math.max(0, Math.min(60000, Math.round(Number(opts.timeoutMs) || 10000)));
    const started = Date.now();
    let last = null;
    while (true) {
      last = JSON.parse(await this.evaluate(`JSON.stringify({
        url: location.href,
        title: document.title,
        textMatched: ${text === null ? 'true' : `(document.body ? document.body.innerText : "").includes(${JSON.stringify(text)})`},
        selectorMatched: ${selector === null ? 'true' : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`},
        urlMatched: ${urlIncludes === null ? 'true' : `location.href.includes(${JSON.stringify(urlIncludes)})`}
      })`));
      this.url = last.url;
      this.title = last.title;
      if (last.textMatched && last.selectorMatched && last.urlMatched) return { ok: true, waited: Date.now() - started, ...last };
      if (Date.now() - started >= timeoutMs) return { ok: false, waited: Date.now() - started, error: '等待超时', ...last };
      await sleep(200);
    }
  }

  async screenshot(opts = {}) {
    await this.ensure();
    if (opts.fullPage === true) {
      const m = await this.cdp.call('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      if (cs) await this.cdp.call('Emulation.setDeviceMetricsOverride', { width: Math.ceil(cs.width), height: Math.ceil(cs.height), deviceScaleFactor: 1, mobile: false });
    }
    const shot = await this.cdp.call('Page.captureScreenshot', { format: 'png' }, 20000);
    if (opts.fullPage === true) await this.cdp.call('Emulation.clearDeviceMetricsOverride').catch(() => {});
    return Buffer.from(shot.data, 'base64');
  }


  /** 多标签：列出 / 新开 / 切到 / 关掉。用 DevTools 的 HTTP 端点，不依赖当前页的 CDP 连接。 */
  async tabs() {
    await this.ensure();
    const r = await fetch('http://127.0.0.1:' + this.port + '/json/list', { signal: AbortSignal.timeout(3000) });
    const list = await r.json();
    const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page');
    const cur = this.cdp && this.cdp.targetId ? this.cdp.targetId : null;
    return pages.map((t) => ({ id: t.id, title: t.title, url: t.url, current: cur ? t.id === cur : false }));
  }

  async newTab(url) {
    await this.ensure();
    const u = encodeURIComponent(url || 'about:blank');
    const r = await fetch('http://127.0.0.1:' + this.port + '/json/new?' + u, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    const t = await r.json();
    return { ok: true, id: t.id, url: t.url, note: '新标签已开；要操作它请 desktop_web{action:"switchtab", tabId:"…"}' };
  }

  async switchTab(tabId) {
    await this.ensure();
    const id = String(tabId || '');
    if (!id) throw new Error('switchtab needs tabId (see action:"tabs")');
    await fetch('http://127.0.0.1:' + this.port + '/json/activate/' + encodeURIComponent(id), { signal: AbortSignal.timeout(3000) });
    await this.attachTab(id);
    // 刚切过去的标签可能还在加载：给它一点时间，标题才有意义
    try { await this.waitForLoad(4000); } catch {}
    await sleep(150);
    this.url = await this.readUrl();
    this.title = await this.readTitle();
    return { ok: true, url: this.url, title: this.title };
  }

  async closeTab(tabId) {
    await this.ensure();
    const id = String(tabId || '');
    if (!id) throw new Error('closetab needs tabId');
    await fetch('http://127.0.0.1:' + this.port + '/json/close/' + encodeURIComponent(id), { signal: AbortSignal.timeout(3000) });
    return { ok: true };
  }

  /** 文件上传：把本机文件塞进 <input type=file>（浏览器不允许脚本直接设置，这是 CDP 官方通道） */
  async upload(selector, files) {
    await this.ensure();
    const sel = String(selector || '');
    const list = Array.isArray(files) ? files.filter(Boolean).map(String) : [];
    if (!sel) throw new Error('upload needs selector (e.g. input[type=file])');
    if (!list.length) throw new Error('upload needs files: an array of absolute paths');
    const doc = await this.cdp.call('DOM.getDocument', { depth: 2 });
    const q = await this.cdp.call('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    if (!q || !q.nodeId) throw new Error('no element matches ' + sel);
    const desc = await this.cdp.call('DOM.describeNode', { nodeId: q.nodeId });
    const tag = String((desc && desc.node && desc.node.nodeName) || '').toLowerCase();
    if (tag !== 'input') throw new Error('upload target is <' + tag + '>, not an <input type=file>');
    await this.cdp.call('DOM.setFileInputFiles', { nodeId: q.nodeId, files: list });
    return { ok: true, count: list.length };
  }

  /** 网页弹窗（alert/confirm/prompt）：浏览器默认会卡住页面，先看有没有，再决定同意还是取消。 */
  pendingDialog() {
    return this.dialog || null;
  }

  async answerDialog({ accept = true, promptText } = {}) {
    await this.ensure();
    const d = this.dialog;
    if (!d) return { ok: false, error: '现在没有待处理的网页弹窗（alert/confirm/prompt）' };
    await this.cdp.call('Page.handleJavaScriptDialog', { accept: accept === true, ...(promptText != null ? { promptText: String(promptText) } : {}) });
    this.dialog = null;
    return { ok: true, accepted: accept === true, type: d.type, message: d.message };
  }

  async back() {
    await this.ensure();
    const settled = this.waitForLoad(5000);
    await this.evaluate('history.back()');
    await settled;
    await sleep(250);
    this.url = await this.readUrl();
    this.title = await this.readTitle();
    return { ok: true, url: this.url, title: this.title };
  }

  async forward() {
    await this.ensure();
    const settled = this.waitForLoad(5000);
    await this.evaluate('history.forward()');
    await settled;
    await sleep(250);
    this.url = await this.readUrl();
    this.title = await this.readTitle();
    return { ok: true, url: this.url, title: this.title };
  }

  async reload() {
    await this.ensure();
    const settled = this.waitForLoad(8000);
    await this.cdp.call('Page.reload', {}, 15000);
    await settled;
    await sleep(250);
    this.url = await this.readUrl();
    this.title = await this.readTitle();
    return { ok: true, url: this.url, title: this.title };
  }

  async stop() {
    const child = this.child;
    this.child = null;
    // 先请求浏览器自己优雅退出（它才会把 cookie/登录态刷到磁盘），超时再强杀
    if (child && this.port) {
      try {
        const v = await fetch('http://127.0.0.1:' + this.port + '/json/version', { signal: AbortSignal.timeout(1200) });
        if (v.ok) {
          const info = await v.json();
          if (info && info.webSocketDebuggerUrl) {
            const cdp = new Cdp(info.webSocketDebuggerUrl);
            try { await cdp.call('Browser.close', {}, 1500); } catch {}
            cdp.close();
            for (let i = 0; i < 20; i++) {
              try { process.kill(child.pid, 0); await sleep(100); } catch { break; } // 进程已退出
            }
          }
        }
      } catch {}
    }
    try { this.cdp?.close(); } catch {}
    this.cdp = null;
    if (child && !child.killed) { try { child.kill(); } catch {} }
    this.status = 'stopped';
    await sleep(200);
    // 持久 profile 留着（登录态在里面）；只有临时 profile 才删
    if (this.profileDir && this.profile === 'temp') {
      for (let i = 0; i < 4; i++) {
        try { await rm(this.profileDir, { recursive: true, force: true }); break; } catch { await sleep(200 * (i + 1)); }
      }
      if (liveProfile === this.profileDir) liveProfile = null;
      this.profileDir = null;
    }
    if (this.profile === 'persistent') {
      // 只要我们确实关掉了自己启动的那个浏览器，就把“还记得的端口”清掉
      if (child) { try { rmSync(PROFILE_STATE, { force: true }); } catch {} }
      this.attached = false;
    }
  }

  /** 清空内置浏览器的登录态（下次等于全新） */
  async resetProfile() {
    await this.stop();
    if (this.profile === 'persistent') {
      for (let i = 0; i < 4; i++) {
        try { await rm(PROFILE_ROOT, { recursive: true, force: true }); break; } catch { await sleep(250 * (i + 1)); }
      }
      this.profileDir = null;
    }
    return { ok: true, reset: true, dir: PROFILE_ROOT };
  }
}

let inst = null;

export function webBrowser(opts = {}) {
  if (!inst) inst = new WebBrowser(opts);
  else if (opts.profile && inst.status !== 'ready' && inst.status !== 'starting') inst.profile = opts.profile === 'temp' ? 'temp' : 'persistent';
  return inst;
}

export function _resetWeb() {
  const old = inst;
  inst = null;
  return old ? old.stop() : Promise.resolve();
}

export function webProfileRoot() {
  return PROFILE_ROOT;
}

/** 进程退出时尽量不要把临时 profile 留在 %TEMP% 里。 */
process.on('exit', () => {
  if (liveProfile) { try { rmSync(liveProfile, { recursive: true, force: true }); } catch {} }
});

