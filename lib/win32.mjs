// win32.mjs — small native helper (koffi) for the operations the Cua driver does
// slowly or not at all: fast window enumeration, focus without clicking, show/restore,
// and elevation probing.
import koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const ENUM_PROC = 'DSHEnumProc_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const EnumProc = koffi.proto('bool ' + ENUM_PROC + '(intptr_t h, intptr_t l)');
const EnumWindows = user32.func('bool EnumWindows(' + ENUM_PROC + '* cb, intptr_t l)');
const GetWindowTextW = user32.func('int GetWindowTextW(intptr_t h, void* buf, int n)');
const GetClassNameW = user32.func('int GetClassNameW(intptr_t h, void* buf, int n)');
const IsWindowVisible = user32.func('bool IsWindowVisible(intptr_t h)');
const IsWindowEnabled = user32.func('bool IsWindowEnabled(intptr_t h)');
const IsIconic = user32.func('bool IsIconic(intptr_t h)');
const ClientToScreen = user32.func('bool ClientToScreen(intptr_t h, void* p)');
const GetClientRect = user32.func('bool GetClientRect(intptr_t h, void* r)');
const GetWindowRect = user32.func('bool GetWindowRect(intptr_t h, void* rect)');
const GetWindowThreadProcessId = user32.func('uint32 GetWindowThreadProcessId(intptr_t h, void* pid)');
const SetForegroundWindow = user32.func('bool SetForegroundWindow(intptr_t h)');
const BringWindowToTop = user32.func('bool BringWindowToTop(intptr_t h)');
const ShowWindow = user32.func('bool ShowWindow(intptr_t h, int cmd)');
const ShowWindowAsync = user32.func('bool ShowWindowAsync(intptr_t h, int cmd)');
const SetWindowPos = user32.func('bool SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint flags)');
const GetForegroundWindow = user32.func('intptr_t GetForegroundWindow()');
const GetCurrentThreadId = kernel32.func('uint32 GetCurrentThreadId()');
const AttachThreadInput = user32.func('bool AttachThreadInput(uint32 a, uint32 b, bool attach)');
const OpenProcess = kernel32.func('intptr_t OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool CloseHandle(intptr_t h)');
const QueryFullProcessImageNameW = kernel32.func('bool QueryFullProcessImageNameW(intptr_t h, uint32 flags, void* buf, void* size)');

const SW_RESTORE = 9;
const SW_SHOW = 5;
const SW_SHOWNA = 8;

function text(h, fn) {
  const buf = Buffer.alloc(1024);
  const n = fn(h, buf, 1024);
  if (!n) return '';
  return buf.toString('utf16le', 0, n * 2);
}

const winText = (h) => text(h, GetWindowTextW);
const winClass = (h) => text(h, GetClassNameW);

function procName(pid) {
  const h = OpenProcess(0x1000, false, pid);
  if (!h) return '';
  try {
    const buf = Buffer.alloc(1024);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(1024);
    if (!QueryFullProcessImageNameW(h, 0, buf, size)) return '';
    const len = size.readUInt32LE();
    const full = buf.toString('utf16le', 0, len * 2);
    return full.split('\\').pop();
  } finally {
    CloseHandle(h);
  }
}

// 这些是 IME / 输入法 / 覆盖层留下的辅助窗口，枚举出来只是噪音
const NOISE_CLASSES = new Set([
  'IME', 'MSCTFIME UI', 'Default IME', 'GDI+ Window', 'SysShadow', 'Chrome_SystemMessageWindow',
  'NVIDIA Overlay', 'NvContainerWindowClass', 'ApplicationFrameWindow_Hidden',
]);

const dwmapi = koffi.load('dwmapi.dll');
const DwmGetWindowAttribute = dwmapi.func('__stdcall', 'DwmGetWindowAttribute', 'int', ['void *', 'uint32_t', 'void *', 'uint32_t']);
/** DWM 认为“罩住/不显示”的窗口（UWP 后台、壳层辅助窗口）——枚举时应该跳过 */
export function isCloaked(hwnd) {
  try {
    const buf = Buffer.alloc(4);
    const hr = DwmGetWindowAttribute(hwnd, 14 /* DWMWA_CLOAKED */, buf, 4);
    return hr === 0 && buf.readUInt32LE(0) !== 0;
  } catch { return false; }
}
/** 扩展窗口样式（取不到返回 0） */
export function exStyle(hwnd) { try { return GetWindowLongPtrW(hwnd, -20) >>> 0; } catch { return 0; } }
/** 基本窗口样式（取不到返回 0） */
export function style(hwnd) { try { return GetWindowLongPtrW(hwnd, -16) >>> 0; } catch { return 0; } }

export function listWindows(opts = {}) {
  // onScreenOnly / visibleOnly 是同一个意思（不同调用方两种写法都出现过）
  const visibleOnly = opts.onScreenOnly !== undefined ? !!opts.onScreenOnly : opts.visibleOnly !== false;
  const { minW = 60, minH = 30, all = false } = opts;
  const out = [];
  const cb = koffi.register((h) => {
    if (visibleOnly && !IsWindowVisible(h)) return true;
    const title = winText(h);
    const cls = winClass(h);
    if (!title && !cls) return true;
    if (!all && NOISE_CLASSES.has(cls)) return true;
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    const rectBuf = Buffer.alloc(16);
    GetWindowRect(h, rectBuf);
    const x = rectBuf.readInt32LE(0), y = rectBuf.readInt32LE(4);
    const w = rectBuf.readInt32LE(8) - x, hh = rectBuf.readInt32LE(12) - y;
    if (!all && (w < minW || hh < minH)) return true;
    if (!all) {
      const ex = exStyle(h), st = style(h);
      if (cls.startsWith('DSHSidecarHud')) return true;         // 自己的状态条
      if (isCloaked(h)) return true;                             // DWM 隐形的（UWP 后台）
      if (ex & 0x00000080) return true;                          // 工具窗（没有任务栏入口，多是后台辅助）
      if ((st & 0x00C00000) !== 0x00C00000) return true;         // 没有标题栏的弹出层
      if (w < 120 || hh < 60) return true;
    }
    out.push({
      hwnd: Number(h),
      pid,
      title,
      cls,
      bounds: { x, y, width: w, height: hh },
      visible: IsWindowVisible(h),
      iconic: IsIconic(h),
      enabled: IsWindowEnabled(h),
      app: procName(pid),
    });
    return true;
  }, koffi.pointer(EnumProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  return out;
}

export function focusWindow(hwnd) {
  const h = Number(hwnd);
  if (!h) return false;
  if (IsIconic(h)) ShowWindowAsync(h, SW_RESTORE);
  SetForegroundWindow(h);
  BringWindowToTop(h);
  SetWindowPos(h, 0, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040); // NOSIZE|NOMOVE|SHOWWINDOW
  return Number(GetForegroundWindow()) === h;
}

function rectOf(h) {
  const b = Buffer.alloc(16);
  GetWindowRect(Number(h), b);
  return { left: b.readInt32LE(0), top: b.readInt32LE(4), right: b.readInt32LE(8), bottom: b.readInt32LE(12) };
}

export function focusWindowForce(hwnd) {
  const h = Number(hwnd);
  if (!h) return false;
  if (IsIconic(h)) ShowWindowAsync(h, SW_RESTORE);
  const fg = Number(GetForegroundWindow());
  const fgThreadBuf = Buffer.alloc(4);
  if (fg) GetWindowThreadProcessId(fg, fgThreadBuf);
  const fgThread = fgThreadBuf.readUInt32LE(0);
  const myThread = Number(GetCurrentThreadId());
  if (fgThread && fgThread !== myThread) AttachThreadInput(myThread, fgThread, true);
  ShowWindowAsync(h, SW_SHOW);
  try { pressCombo(0x12, false, false, false); } catch {}
  const ok = SetForegroundWindow(h);
  BringWindowToTop(h);
  if (!ok) {
    // 前台锁兜底：把目标抬到 z 序顶部（不激活），屏幕坐标点击仍然落在它身上
    try {
      SetWindowPos(h, -1 /* HWND_TOPMOST */, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
      SetWindowPos(h, -2 /* HWND_NOTOPMOST */, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    } catch {}
  }
  if (fgThread && fgThread !== myThread) AttachThreadInput(myThread, fgThread, false);
  if (Boolean(ok) || Number(GetForegroundWindow()) === h) return true;
  // 兜底校验：抬到顶后，窗口中心点命中的顶层窗口是否就是它（或其子窗口）
  try {
    const r = rectOf(h);
    const cx = Math.round(r.left + (r.right - r.left) / 2);
    const cy = Math.round(r.top + (r.bottom - r.top) / 2 - 4);
    const hit = Number(WindowFromPointX(BigInt(cx) | (BigInt(cy) << 32n))) || 0;
    const root = hit ? Number(GetAncestor_(hit, 2 /* GA_ROOT */)) : 0;
    return root === h;
  } catch { return false; }
}

export function showWindow(hwnd, cmd = SW_SHOW) {
  return ShowWindowAsync(Number(hwnd), cmd);
}

export function foregroundHwnd() {
  return Number(GetForegroundWindow());
}

export function isWindow(hwnd) {
  return Boolean(Number(hwnd));
}

export function clientInfo(hwnd) {
  const h = Number(hwnd);
  const wr = Buffer.alloc(16), cr = Buffer.alloc(16), p = Buffer.alloc(8);
  GetWindowRect(h, wr);
  GetClientRect(h, cr);
  ClientToScreen(h, p);
  return {
    window: { x: wr.readInt32LE(0), y: wr.readInt32LE(4), width: wr.readInt32LE(8) - wr.readInt32LE(0), height: wr.readInt32LE(12) - wr.readInt32LE(4) },
    client: { width: cr.readInt32LE(8), height: cr.readInt32LE(12) },
    clientOrigin: { x: p.readInt32LE(0), y: p.readInt32LE(4) },
    offset: { x: p.readInt32LE(0) - wr.readInt32LE(0), y: p.readInt32LE(4) - wr.readInt32LE(4) },
  };
}
export function setWindowRect(hwnd, x, y, w, h) {
  return SetWindowPos(Number(hwnd), 0, Number(x), Number(y), Number(w), Number(h), 0x0040 | 0x0004);
}
const keybd_event = user32.func('void keybd_event(uint8 vk, uint8 scan, uint32 flags, intptr_t extra)');
const VkKeyScanW = user32.func('short VkKeyScanW(uint16 ch)');

export function keyDown(vk) { keybd_event(vk, 0, 0, 0); }
export function keyUp(vk) { keybd_event(vk, 0, 2, 0); }
export function pressCombo(vk, ctrl = false, shift = false, alt = false) {
  if (ctrl) keyDown(0x11);
  if (shift) keyDown(0x10);
  if (alt) keyDown(0x12);
  keyDown(vk);
  keyUp(vk);
  if (alt) keyUp(0x12);
  if (shift) keyUp(0x10);
  if (ctrl) keyUp(0x11);
}

export function typeAscii(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const vk = VkKeyScanW(code);
    if (vk === -1) continue;
    const v = vk & 0xff;
    const shift = (vk & 0x100) !== 0;
    pressCombo(v, false, shift, false);
  }
  return text.length;
}
const SendInput = user32.func('uint32_t SendInput(uint32_t n, void *inputs, int cbSize)');

/**
 * 直接输入 Unicode 字符（SendInput + KEYEVENTF_UNICODE）。
 * 优点：完全不碰剪贴板（不覆盖用户的复制内容、不进入 Win+V 历史），
 *       中文/日文/emoji 都能打，被别的程序占用剪贴板时也能工作。
 * 返回真正发出的字符数。
 */
export function sendUnicode(text) {
  const str = String(text);
  const units = [];
  for (let i = 0; i < str.length; i++) units.push(str.charCodeAt(i));
  // 每个字符两个 INPUT（按下 + 抬起），INPUT 在 x64 上是 40 字节
  const SIZE = 40;
  const buf = Buffer.alloc(SIZE * units.length * 2);
  let n = 0;
  const put = (code, flags) => {
    const off = n * SIZE;
    buf.writeUInt32LE(1, off);              // INPUT_KEYBOARD
    buf.writeUInt16LE(0, off + 8);          // wVk = 0
    buf.writeUInt16LE(code, off + 10);      // wScan = 字符编码
    buf.writeUInt32LE(flags, off + 12);     // dwFlags
    n++;
  };
  for (const u of units) {
    // 换行/回车/制表用真实按键，某些控件不吃 
    if (u === 13 || u === 10) { put(0x0d, 0); put(0x0d, 2); continue; }
    if (u === 9) { put(0x09, 0); put(0x09, 2); continue; }
    put(u, 4);      // KEYEVENTF_UNICODE
    put(u, 4 | 2);  // + KEYEVENTF_KEYUP
  }
  if (!n) return 0;
  const sent = SendInput(n, buf, SIZE);
  return Math.floor(sent / 2);
}

const IsHungAppWindow = user32.func('bool IsHungAppWindow(intptr_t h)');
const SendMessageTimeoutW = user32.func('intptr_t SendMessageTimeoutW(intptr_t h, uint32 msg, intptr_t w, intptr_t l, uint32 flags, uint32 timeout, void* result)');

export function health(hwnd) {
  const h = Number(hwnd);
  const out = Buffer.alloc(8);
  const t0 = Date.now();
  const ok = SendMessageTimeoutW(h, 0, 0, 0, 0x0002, 800, out);
  return { hung: IsHungAppWindow(h), responds: Boolean(ok), ms: Date.now() - t0 };
}
const SetCursorPos = user32.func('bool SetCursorPos(int x, int y)');
const mouse_event = user32.func('void mouse_event(uint32 flags, uint32 dx, uint32 dy, uint32 data, intptr_t extra)');
const WindowFromPoint = user32.func('intptr_t WindowFromPoint(intptr_t pt)');

export function screenClick(x, y, { double = false } = {}) {
  SetCursorPos(Math.round(x), Math.round(y));
  // tiny move to make sure the app sees a real cursor motion
  SetCursorPos(Math.round(x) + 1, Math.round(y));
  SetCursorPos(Math.round(x), Math.round(y));
  const seq = [[0x0002, 0], [0x0004, 0]];
  if (double) seq.unshift([0x0002, 0], [0x0004, 0]);
  for (const [f] of seq) {
    mouse_event(f, 0, 0, 0, 0);
  }
  return true;
}

export const VK = { ctrl: 0x11, shift: 0x10, alt: 0x12, v: 0x56, a: 0x41, c: 0x43,
  enter: 0x0d, esc: 0x1b, tab: 0x09, backspace: 0x08, delete: 0x2e };
const PostMessageW = user32.func('bool PostMessageW(intptr_t h, uint32 msg, intptr_t w, intptr_t l)');
export function closeWindow(hwnd) { return PostMessageW(Number(hwnd), 0x0010, 0, 0); }
export function setTopmost(hwnd) {
  // HWND_TOPMOST=-1, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE
  return SetWindowPos(Number(hwnd), -1, 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010);
}
const user32b = koffi.load('user32.dll');
const GetWindowLongPtrW = user32b.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int']);
const SetWindowLongPtrW = user32b.func('__stdcall', 'SetWindowLongPtrW', 'intptr_t', ['intptr_t', 'int', 'intptr_t']);

export function stripFrame(hwnd) {
  const h = Number(hwnd);
  const style = GetWindowLongPtrW(h, -16);
  const ex = GetWindowLongPtrW(h, -20);
  SetWindowLongPtrW(h, -16, (style & ~0x00C00000) | 0x80000000);
  SetWindowLongPtrW(h, -20, ex | 0x00000080 | 0x08000000);
  return SetWindowPos(h, -1, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0020 | 0x0010);
}
export function setClipboardText(text) {
  const open = user32b.func('__stdcall', 'OpenClipboard', 'bool', ['intptr_t']);
  const empty = user32b.func('__stdcall', 'EmptyClipboard', 'bool', []);
  const close = user32b.func('__stdcall', 'CloseClipboard', 'bool', []);
  const setData = user32b.func('__stdcall', 'SetClipboardData', 'intptr_t', ['uint32_t', 'intptr_t']);
  const kernel32b = koffi.load('kernel32.dll');
  const GlobalAlloc = kernel32b.func('__stdcall', 'GlobalAlloc', 'intptr_t', ['uint32_t', 'intptr_t']);
  const GlobalLock = kernel32b.func('__stdcall', 'GlobalLock', 'void *', ['intptr_t']);
  const GlobalUnlock = kernel32b.func('__stdcall', 'GlobalUnlock', 'bool', ['intptr_t']);
  const buf = Buffer.from(String(text) + '\u0000', 'utf16le');
  open(0); empty();
  const h = GlobalAlloc(0x0042, buf.length);
  const p = GlobalLock(h);
  koffi.encode(p, 'uint8_t', Array.from(buf), buf.length);
  GlobalUnlock(h);
  setData(13, h);
  close();
  return true;
}

// ---- 读剪贴板（配合 desktop_type 用完恢复用户原来的剪贴板）----
const user32e = koffi.load('user32.dll');
const kernel32e = koffi.load('kernel32.dll');
const OpenClipboardE = user32e.func('__stdcall', 'OpenClipboard', 'bool', ['intptr_t']);
const CloseClipboardE = user32e.func('__stdcall', 'CloseClipboard', 'bool', []);
const GetClipboardDataE = user32e.func('__stdcall', 'GetClipboardData', 'intptr_t', ['uint32_t']);
const IsClipFmtE = user32e.func('__stdcall', 'IsClipboardFormatAvailable', 'bool', ['uint32_t']);
const GlobalLockE = kernel32e.func('__stdcall', 'GlobalLock', 'void *', ['intptr_t']);
const GlobalUnlockE = kernel32e.func('__stdcall', 'GlobalUnlock', 'bool', ['intptr_t']);
const GlobalSizeE = kernel32e.func('__stdcall', 'GlobalSize', 'intptr_t', ['intptr_t']);

export function getClipboardText() {
  try {
    if (!IsClipFmtE(13)) return null;
    let opened = false;
    for (let i = 0; i < 6 && !opened; i++) {
      opened = !!OpenClipboardE(0);
      // 剪贴板可能被别的进程短暂占用：同步小睡 25ms 再试
      if (!opened) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    if (!opened) return null;
    let out = null;
    try {
      const h = GetClipboardDataE(13);
      if (h) {
        const size = Number(GlobalSizeE(h)) || 0;
        const p = size > 0 ? GlobalLockE(h) : null;
        if (p && size > 1) {
          const raw = Buffer.from(koffi.decode(p, 'uint8_t', size));
          let end = raw.length;
          while (end >= 2 && raw[end - 1] === 0 && raw[end - 2] === 0) end -= 2;
          out = raw.subarray(0, end).toString('utf16le');
          GlobalUnlockE(h);
        }
      }
    } finally { CloseClipboardE(); }
    return out;
  } catch (e) { if (process.env.SIDECAR_DEBUG_CB) console.error('[cb]', e && e.message); return null; }
}

export function foregroundWindow() {
  const fg = user32b.func('__stdcall', 'GetForegroundWindow', 'intptr_t', []);
  return Number(fg());
}
export function moveTo(x, y) { return SetCursorPos(Number(x), Number(y)); }

// ---- 子窗口查找 + 直接发 WM_PASTE（绕开前台焦点问题）----
const SUF = '_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const user32c = koffi.load('user32.dll');
const ENUMCB = koffi.proto('bool EnumChildProc' + SUF + '(intptr_t hwnd, intptr_t lParam)');
const EnumChildWindows = user32c.func('__stdcall', 'EnumChildWindows', 'bool', ['intptr_t', koffi.pointer(ENUMCB), 'intptr_t']);
const GetClassNameW2 = user32c.func('__stdcall', 'GetClassNameW', 'int', ['intptr_t', 'void *', 'int']);
const SendMessageW2 = user32c.func('__stdcall', 'SendMessageW', 'intptr_t', ['intptr_t', 'uint32_t', 'uintptr_t', 'intptr_t']);

export function findEditableChild(hwnd) {
  const out = [];
  const cb = koffi.register((child) => {
    try {
      const buf = Buffer.alloc(256 * 2);
      const n = GetClassNameW2(Number(child), koffi.as(buf, 'void *'), 128);
      const cls = n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
      if (/^(Edit|RichEdit|RichEdit20W|RichEdit50W|RichEditD2DPT|Scintilla|TEdit|TextBox)$/i.test(cls) || /edit/i.test(cls)) out.push({ hwnd: Number(child), cls });
    } catch {}
    return true;
  }, koffi.pointer(ENUMCB));
  try { EnumChildWindows(Number(hwnd), cb, 0); } finally { koffi.unregister(cb); }
  return out[0] || null;
}

export function sendPaste(targetHwnd) {
  return Number(SendMessageW2(Number(targetHwnd), 0x0302, 0, 0));
}
const PostMessageW3 = user32c.func('__stdcall', 'PostMessageW', 'bool', ['intptr_t', 'uint32_t', 'uintptr_t', 'intptr_t']);
const WindowFromPointX = user32c.func('__stdcall', 'WindowFromPoint', 'intptr_t', ['int64_t']);

const GetAncestor_ = user32c.func('__stdcall', 'GetAncestor', 'intptr_t', ['intptr_t', 'uint32_t']);

export function postClick(screenX, screenY) {
  const x = Math.round(screenX), y = Math.round(screenY);
  const pt = (BigInt(x & 0xffff) | (BigInt(y & 0xffff) << 16n));
  const target = Number(WindowFromPointX(BigInt(x) | (BigInt(y) << 32n))) || 0;
  if (!target) return false;
  const lp = Number((BigInt(x & 0xffff)) | (BigInt(y & 0xffff) << 16n));
  PostMessageW3(target, 0x0200, 0, lp);           // WM_MOUSEMOVE
  PostMessageW3(target, 0x0201, 1, lp);           // WM_LBUTTONDOWN
  PostMessageW3(target, 0x0202, 0, lp);           // WM_LBUTTONUP
  return true;
}
const GetAsyncKeyState_ = user32c.func('__stdcall', 'GetAsyncKeyState', 'short', ['int']);

/** 用户是否按住了 Esc（用于批量动作中途取消）。 */
export function escapePressed() {
  try { return (Number(GetAsyncKeyState_(0x1b)) & 0x8000) !== 0; } catch { return false; }
}

// ---- 落点遮挡检查 / 光标与前台还原 / 滚轮与拖拽 / 窗口状态 ----
const GetCursorPos_ = user32c.func('__stdcall', 'GetCursorPos', 'bool', ['void *']);
const IsIconic_ = user32c.func('__stdcall', 'IsIconic', 'bool', ['intptr_t']);
const IsZoomed_ = user32c.func('__stdcall', 'IsZoomed', 'bool', ['intptr_t']);
const SetWindowPos_ = user32c.func('__stdcall', 'SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32_t']);
const ShowWindowAsync_ = user32c.func('__stdcall', 'ShowWindowAsync', 'bool', ['intptr_t', 'int']);

/** 屏幕上这个坐标点当前属于哪个顶层窗口（含被别的窗口挡住的情况）。 */
export function pointOwner(x, y) {
  try {
    const hit = Number(WindowFromPointX(BigInt(Math.round(x)) | (BigInt(Math.round(y)) << 32n))) || 0;
    if (!hit) return { hwnd: 0, root: 0 };
    return { hwnd: hit, root: Number(GetAncestor_(hit, 2 /* GA_ROOT */)) || hit };
  } catch { return { hwnd: 0, root: 0 }; }
}

export function cursorPos() {
  try {
    const buf = Buffer.alloc(8);
    if (!GetCursorPos_(buf)) return null;
    return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
  } catch { return null; }
}

export function setCursor(x, y) {
  try { return Boolean(SetCursorPos(Math.round(x), Math.round(y))); } catch { return false; }
}

/** 把前台还给原来那个窗口（不激活、不弹到最前）。 */
export function restoreForeground(hwnd) {
  const h = Number(hwnd) || 0;
  if (!h) return false;
  try { return focusWindowForce(h) === true || foregroundWindow() === h; } catch { return false; }
}

export function scrollAt(x, y, { delta = -120, horizontal = false } = {}) {
  try {
    if (x !== undefined && y !== undefined) SetCursorPos(Math.round(x), Math.round(y));
    const flag = horizontal ? 0x01000 : 0x0800; // MOUSEEVENTF_HWHEEL | MOUSEEVENTF_WHEEL
    mouse_event(flag, 0, 0, Math.round(delta), 0);
    return true;
  } catch { return false; }
}

export function dragFromTo(x1, y1, x2, y2, { steps = 12, hold = 80 } = {}) {
  try {
    SetCursorPos(Math.round(x1), Math.round(y1));
    mouse_event(0x0002, 0, 0, 0, 0); // LEFTDOWN
    const n = Math.max(2, steps);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      SetCursorPos(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t));
    }
    if (hold) { const t0 = Date.now(); while (Date.now() - t0 < hold) {} }
    mouse_event(0x0004, 0, 0, 0, 0); // LEFTUP
    return true;
  } catch { return false; }
}

export function windowState(hwnd) {
  const h = Number(hwnd);
  let minimized = false, maximized = false;
  try { minimized = Boolean(IsIconic_(h)); } catch {}
  try { maximized = Boolean(IsZoomed_(h)); } catch {}
  return { minimized, maximized };
}

/** swift: minimize | maximize | restore | move */
export function windowAction(hwnd, swift, rect) {
  const h = Number(hwnd);
  try {
    if (swift === 'minimize') return Boolean(ShowWindowAsync_(h, 6 /* SW_MINIMIZE */));
    if (swift === 'maximize') return Boolean(ShowWindowAsync_(h, 3 /* SW_MAXIMIZE */));
    if (swift === 'restore') return Boolean(ShowWindowAsync_(h, 9 /* SW_RESTORE */));
    if (swift === 'move' && rect) {
      return Boolean(SetWindowPos_(h, 0, Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h), 0x0004 /* NOZORDER */));
    }
    return false;
  } catch { return false; }
}
