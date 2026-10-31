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

const GetAncestor = user32.func('__stdcall', 'GetAncestor', 'intptr_t', ['intptr_t', 'uint32_t']);

/** 判断某进程是否以更高权限（管理员）运行：普通权限下 QUERY_INFORMATION 会被拒。 */
export function isElevated(pid) {
  try {
    const k32 = koffi.load('kernel32.dll');
    const OpenProcess = k32.func('__stdcall', 'OpenProcess', 'void *', ['uint32_t', 'bool', 'uint32_t']);
    const CloseHandle = k32.func('__stdcall', 'CloseHandle', 'bool', ['void *']);
    const full = OpenProcess(0x0400 /* QUERY_INFORMATION */, false, Number(pid));
    const limited = OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, Number(pid));
    if (limited) CloseHandle(limited);
    if (full) { CloseHandle(full); return false; }
    return Boolean(limited);
  } catch { return false; }
}

const GetWindowPlacement = user32.func('__stdcall', 'GetWindowPlacement', 'bool', ['intptr_t', 'void *']);
const SetWindowPlacement = user32.func('__stdcall', 'SetWindowPlacement', 'bool', ['intptr_t', 'void *']);

// UWP / 应用框架窗（ApplicationFrameWindow）自己标题是空的，真正的中文标题挂在子窗
// “Windows.UI.Core.CoreWindow” 上。Windows 11 的「打开方式」就是这种结构，
// 不把子窗标题借过来，按标题找窗口就永远找不到这个对话框。
const CHILD_PROC = 'DSHChildProc_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const ChildProc = koffi.proto('bool ' + CHILD_PROC + '(intptr_t h, intptr_t l)');
const EnumChildWindowsAll = user32.func('bool EnumChildWindows(intptr_t parent, ' + CHILD_PROC + '* cb, intptr_t l)');
export function listChildWindows(hwnd) {
  const out = [];
  const cb = koffi.register((h) => {
    try {
      out.push({ hwnd: Number(h), title: winText(h), cls: winClass(h), visible: IsWindowVisible(h) });
    } catch {}
    return true;
  }, koffi.pointer(ChildProc));
  try { EnumChildWindowsAll(Number(hwnd), cb, 0); } finally { koffi.unregister(cb); }
  return out;
}

function childTitleOf(hwnd) {
  for (const c of listChildWindows(hwnd)) {
    if (c.title && c.visible) return c.title;
  }
  for (const c of listChildWindows(hwnd)) {
    if (c.title) return c.title;
  }
  return '';
}
export function listWindows(opts = {}) {
  // onScreenOnly / visibleOnly 是同一个意思（不同调用方两种写法都出现过）
  const visibleOnly = opts.onScreenOnly !== undefined ? !!opts.onScreenOnly : opts.visibleOnly !== false;
  const { minW = 60, minH = 30, all = false } = opts;
  const out = [];
  const cb = koffi.register((h) => {
    if (visibleOnly && !IsWindowVisible(h)) return true;
    let title = winText(h);
    const cls = winClass(h);
    if (!title && cls) title = childTitleOf(h);
    // 高完整性/受保护窗口（例如 UIPI 挡住的 OpenWith.exe）GetWindowTextW/GetClassNameW 都失败，
    // 以前这里直接丢掉，于是「打开方式」这种系统对话框永远进不了列表。改成占位保留，
    // 由调用方用 OCR / 按进程名来操作它。
    const protectedWin = !title && !cls;
    if (protectedWin && !all) { if (!IsWindowVisible(h)) return true; }
    if (!all && NOISE_CLASSES.has(cls)) return true;
    const pidBuf = Buffer.alloc(4);
    GetWindowThreadProcessId(h, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    const rectBuf = Buffer.alloc(16);
    GetWindowRect(h, rectBuf);
    let x = rectBuf.readInt32LE(0), y = rectBuf.readInt32LE(4);
    let w = rectBuf.readInt32LE(8) - x, hh = rectBuf.readInt32LE(12) - y;
    const iconic = IsIconic(h);
    try {
      const root = GetAncestor(h, 2 /* GA_ROOT */);
      if (String(root) !== String(h)) return true; // 子窗（如 UWP CoreWindow）不单列，交给它的顶层框架窗代表
    } catch {}
    // 最小化窗口的窗口矩形是 (-32000,-32000,160x28)，按它过滤等于把「还开着的程序」全丢掉，
    // 用户说「把微信窗口打开」时就永远找不到它。这里换成它还原后的位置。
    if (iconic) {
      try {
        const wp = Buffer.alloc(44);
        if (GetWindowPlacement(h, wp)) {
          const rx = wp.readInt32LE(28), ry = wp.readInt32LE(32);
          const rw = wp.readInt32LE(36) - rx, rh = wp.readInt32LE(40) - ry;
          if (rw > 0 && rh > 0) { x = rx; y = ry; w = rw; hh = rh; }
        }
      } catch {}
    }
    if (!all && !iconic && (w < minW || hh < minH)) return true;
    if (!all && !iconic) {
      if (protectedWin) {
        const ex0 = exStyle(h);
        if (w < 200 || hh < 120) return true;
        if (!(ex0 & 0x00000008)) return true;   // 只收置顶的受保护弹窗
      }
      const ex = exStyle(h), st = style(h);
      if (cls.startsWith('DSHSidecarHud')) return true;         // 自己的状态条
      if (isCloaked(h)) return true;                             // DWM 隐形的（UWP 后台）
      // 以前 TOOLWINDOW / 无标题栏的窗口一律当噪音丢掉，结果 Windows 的「打开方式」
      // （OpenWith.exe，topmost + TOOLWINDOW + 无标题栏）连看都看不到，更别说点。
      // 现在放行「置顶 + 够大」的工具窗和「够大」的无标题栏弹窗，小的菜单/提示仍然过滤。
      if (ex & 0x00000080) {
        const topmost = (ex & 0x00000008) !== 0;
        if (!(topmost && w >= 200 && hh >= 120)) return true;
      }
      if ((st & 0x00C00000) !== 0x00C00000) {         // 没有标题栏的弹出层
        if (w < 240 || hh < 140) return true;
      }
      if (w < 120 || hh < 60) return true;
    }
    out.push({
      protectedWin,
      hwnd: Number(h),
      pid,
      title,
      cls,
      bounds: { x, y, width: w, height: hh },
      visible: IsWindowVisible(h),
      iconic,
      enabled: IsWindowEnabled(h),
      app: procName(pid),
    });
    return true;
  }, koffi.pointer(EnumProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  // 有些窗口（实测 Windows 11 的「打开方式」= OpenWith.exe）既进不了 EnumWindows，
  // 也不在 UIA 根节点里，但 WindowFromPoint 能点到。这里做一次粗网格扫描把它们补进来，
  // 否则这类系统对话框对上层工具完全不可见，用户只能自己手动点。
  if (opts.scan) {
    const seenH = new Set(out.map((x) => x.hwnd));
    const seenRoot = new Set();
    for (let py = 40; py < (opts.screenH || 1080); py += 60) {
      for (let px = 40; px < (opts.screenW || 1920); px += 80) {
        let o;
        try { o = pointOwner(px, py); } catch { continue; }
        const r = o && o.root;
        if (!r || seenH.has(r) || seenRoot.has(r)) continue;
        seenRoot.add(r);
        try {
          if (!IsWindowVisible(r)) continue;
          const rb = Buffer.alloc(16);
          if (!GetWindowRect(r, rb)) continue;
          const rx = rb.readInt32LE(0), ry = rb.readInt32LE(4);
          const rw = rb.readInt32LE(8) - rx, rh = rb.readInt32LE(12) - ry;
          if (rw < 200 || rh < 120) continue;
          const pb = Buffer.alloc(4);
          GetWindowThreadProcessId(r, pb);
          const st = winText(r);
          const sc = winClass(r);
          out.push({
            hwnd: Number(r), pid: pb.readUInt32LE(0), title: st, cls: sc,
            bounds: { x: rx, y: ry, width: rw, height: rh }, visible: true, iconic: false,
            enabled: true, app: procName(pb.readUInt32LE(0)), protectedWin: !st, scanned: true,
          });
        } catch {}
      }
    }
  }
  return out;
}

const GetGUIThreadInfo = user32.func('__stdcall', 'GetGUIThreadInfo', 'bool', ['uint32_t', 'void *']);

/**
 * 等目标窗口真正接管键盘焦点再发按键。
 * 刚 SetForegroundWindow 完马上发字符，前几个字符会被系统丢掉（Notepad 实测丢过前两个）。
 * 返回 true 表示已就绪（或等超时后尽力而为）。
 */
export function waitFocusReady(hwnd, timeoutMs = 600) {
  const h = Number(hwnd);
  if (!h) return false;
  const pidBuf = Buffer.alloc(4);
  const tid = Number(GetWindowThreadProcessId(h, pidBuf));
  if (!tid) return false;
  const buf = Buffer.alloc(72);
  buf.writeUInt32LE(72, 0);
  const t0 = Date.now();
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    buf.writeUInt32LE(72, 0);
    const ok = GetGUIThreadInfo(tid, buf);
    if (ok) {
      const active = Number(buf.readBigUInt64LE(8));
      const focus = Number(buf.readBigUInt64LE(16));
      const sameWindow = !active || active === h || Number(GetAncestor_(active, 2)) === h; // GA_ROOT
      if (focus && sameWindow) {
        stable += 1;
        if (stable >= 2) return true;   // 连续两次看到焦点就位，说明不是瞬间状态
      } else {
        stable = 0;
      }
    }
    const t = Date.now() + 40; while (Date.now() < t) {}
  }
  return false;
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

// 用 SendInput 发真实按键。keybd_event 在新版 Windows 上会被静默丢弃
// （实测：SendInput 能打出字符，keybd_event 的 'x'/Ctrl+A 完全没反应），所以统一走 SendInput。
function sendVk(vk, up = false) {
  const SIZE = 40;
  const buf = Buffer.alloc(SIZE);
  buf.writeUInt32LE(1, 0);                 // INPUT_KEYBOARD
  buf.writeUInt16LE(Number(vk), 8);        // wVk
  buf.writeUInt16LE(0, 10);                // wScan
  buf.writeUInt32LE(up ? 2 : 0, 12);       // KEYEVENTF_KEYUP
  return SendInput(1, buf, SIZE);
}
export function keyDown(vk) { sendVk(vk, false); }
export function keyUp(vk) { sendVk(vk, true); }
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

// 鼠标也统一走 SendInput：mouse_event 是废弃 API，新版窗口（如系统「打开方式」）
// 对「移动后立刻按下」和「按下抬起无间隔」都不理，实测要 3 次才生效。
const MOUSE_INPUT_SIZE = 40; // x64 的 INPUT：type + padding + MOUSEINPUT
function mouseSend(flags, data = 0) {
  const buf = Buffer.alloc(MOUSE_INPUT_SIZE);
  buf.writeUInt32LE(0, 0);              // type = INPUT_MOUSE
  buf.writeInt32LE(0, 8);               // dx
  buf.writeInt32LE(0, 12);              // dy
  buf.writeUInt32LE(data, 16);          // mouseData（滚轮是 120 的倍数）
  buf.writeUInt32LE(flags, 20);         // dwFlags
  return SendInput(1, buf, MOUSE_INPUT_SIZE);
}

export function mouseDown() { return mouseSend(0x0002); }
export function mouseUp() { return mouseSend(0x0004); }

export function screenClick(x, y, { double = false, settle = 55 } = {}) {
  SetCursorPos(Math.round(x), Math.round(y));
  // 轻轻动一下，让窗口先看到真实的鼠标移动（悬停态亮起来）
  SetCursorPos(Math.round(x) + 1, Math.round(y) + 1);
  sleepSync(12);
  SetCursorPos(Math.round(x), Math.round(y));
  sleepSync(settle);
  if (double) {
    mouseSend(0x0002);
    sleepSync(35);
    mouseSend(0x0004);
    sleepSync(70);
  }
  mouseSend(0x0002);
  sleepSync(40);
  mouseSend(0x0004);
  sleepSync(25);
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
function sleepSync(ms) { const t = Date.now() + ms; while (Date.now() < t) { /* 忙等：只需要几十毫秒 */ } }

export function windowAction(hwnd, swift, rect) {
  const h = Number(hwnd);
  try {
    // 注意：ShowWindow* 的返回值是“窗口原来是否可见”，不是成功与否。
    // 所以这里发完就同步确认状态，返回值代表“真的达成目标”。
    if (swift === 'minimize') {
      ShowWindow(h, 6 /* SW_MINIMIZE */);
      for (let i = 0; i < 12 && !IsIconic(h); i++) sleepSync(25);
      return IsIconic(h);
    }
    if (swift === 'maximize') {
      ShowWindow(h, 3 /* SW_MAXIMIZE */);
      return Boolean(IsZoomed_(h));
    }
    if (swift === 'restore') {
      ShowWindow(h, 9 /* SW_RESTORE */);
      for (let i = 0; i < 24 && IsIconic(h); i++) sleepSync(25);
      if (IsIconic(h)) { ShowWindow(h, 5 /* SW_SHOW */); for (let i = 0; i < 16 && IsIconic(h); i++) sleepSync(25); }
      if (IsIconic(h)) {
        try {
          const wp = Buffer.alloc(44);
          wp.writeUInt32LE(44, 0);      // length
          wp.writeUInt32LE(0, 4);       // flags
          wp.writeUInt32LE(1, 8);       // showCmd = SW_SHOWNORMAL
          SetWindowPlacement(h, wp);
          for (let i = 0; i < 16 && IsIconic(h); i++) sleepSync(25);
        } catch {}
      }
      return !IsIconic(h);
    }
    if (swift === 'move' && rect) {
      return Boolean(SetWindowPos_(h, 0, Math.round(rect.x), Math.round(rect.y), Math.round(rect.w), Math.round(rect.h), 0x0004 /* NOZORDER */));
    }
    return false;
  } catch { return false; }
}
