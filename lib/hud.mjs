// hud.mjs — 屏幕底部的「正在操作」提示条。
// 进程内自绘：koffi 直调 user32/gdi32，32 位 DIB + UpdateLayeredWindow 逐像素 alpha。
// 设计约束：
//  1) 不能抢焦点、不能挡住鼠标 —— WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | TOPMOST。
//  2) 不起子进程 —— 本机有一条已知限制：shell 派生的长寿 GUI 循环会让后续 spawn 全部 EPERM。
//  3) 不能用 DrawText 之外的控件 —— 只要 GDI，不依赖任何外部运行时或资源文件。
//  4) koffi 的 proto/struct 名必须每次求值唯一 —— 插件在宿主里可能被热重载二次求值，
//     重复注册同名类型会抛 "Duplicate type name"。
import koffi from 'koffi';

const SUF = '_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const WNDPROC = koffi.proto('intptr_t SidecarWndProc' + SUF + '(intptr_t hwnd, uint32_t msg, uintptr_t wp, intptr_t lp)');
const WNDCLASS = koffi.struct('SidecarWndClass' + SUF, {
  style: 'uint32_t', lpfnWndProc: koffi.pointer(WNDPROC), cbClsExtra: 'int', cbWndExtra: 'int',
  hInstance: 'intptr_t', hIcon: 'intptr_t', hCursor: 'intptr_t', hbrBackground: 'intptr_t',
  lpszMenuName: 'void *', lpszClassName: 'str16',
});
const POINT = koffi.struct('SidecarPoint' + SUF, { x: 'int32_t', y: 'int32_t' });
const SIZE = koffi.struct('SidecarSize' + SUF, { cx: 'int32_t', cy: 'int32_t' });
const RECT = koffi.struct('SidecarRect' + SUF, { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
const BLEND = koffi.struct('SidecarBlend' + SUF, { BlendOp: 'uint8_t', BlendFlags: 'uint8_t', SourceConstantAlpha: 'uint8_t', AlphaFormat: 'uint8_t' });
const BMIH = koffi.struct('SidecarBmi' + SUF, {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t', biBitCount: 'uint16_t',
  biCompression: 'uint32_t', biSizeImage: 'uint32_t', biXPelsPerMeter: 'int32_t', biYPixelsPerMeter: 'int32_t',
  biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
});

const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'bool', ['intptr_t']);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'bool', ['intptr_t', 'void *']);
const GetWindowLongW = user32.func('__stdcall', 'GetWindowLongW', 'int32_t', ['intptr_t', 'int']);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', []);
const RegisterClassW = user32.func('__stdcall', 'RegisterClassW', 'uint16_t', [koffi.pointer(WNDCLASS)]);
const CreateWindowExW = user32.func('__stdcall', 'CreateWindowExW', 'intptr_t',
  ['uint32_t', 'str16', 'str16', 'uint32_t', 'int', 'int', 'int', 'int', 'intptr_t', 'intptr_t', 'intptr_t', 'void *']);
const DefWindowProcW = user32.func('__stdcall', 'DefWindowProcW', 'intptr_t', ['intptr_t', 'uint32_t', 'uintptr_t', 'intptr_t']);
const ShowWindow = user32.func('__stdcall', 'ShowWindow', 'bool', ['intptr_t', 'int']);
const SetWindowPos = user32.func('__stdcall', 'SetWindowPos', 'bool', ['intptr_t', 'intptr_t', 'int', 'int', 'int', 'int', 'uint32_t']);
const DestroyWindow = user32.func('__stdcall', 'DestroyWindow', 'bool', ['intptr_t']);
const GetDC = user32.func('__stdcall', 'GetDC', 'intptr_t', ['intptr_t']);
const ReleaseDC = user32.func('__stdcall', 'ReleaseDC', 'int', ['intptr_t', 'intptr_t']);
const UpdateLayeredWindow = user32.func('__stdcall', 'UpdateLayeredWindow', 'bool',
  ['intptr_t', 'intptr_t', koffi.pointer(POINT), koffi.pointer(SIZE), 'intptr_t', koffi.pointer(POINT), 'uint32_t', koffi.pointer(BLEND), 'uint32_t']);
const SystemParametersInfoW = user32.func('__stdcall', 'SystemParametersInfoW', 'bool', ['uint32_t', 'uint32_t', koffi.pointer(RECT), 'uint32_t']);
const GetAsyncKeyState = user32.func('__stdcall', 'GetAsyncKeyState', 'short', ['int']);
const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int', ['int']);
// MSG 结构体各版本大小不一，用 64 字节不透明缓冲更安全（只要够大就不会越界写）
const PeekMessageW = user32.func('__stdcall', 'PeekMessageW', 'bool', ['void *', 'intptr_t', 'uint32_t', 'uint32_t', 'uint32_t']);
const TranslateMessage = user32.func('__stdcall', 'TranslateMessage', 'bool', ['void *']);
const DispatchMessageW = user32.func('__stdcall', 'DispatchMessageW', 'intptr_t', ['void *']);
const GetModuleHandleW = kernel32.func('__stdcall', 'GetModuleHandleW', 'intptr_t', ['str16']);
const CopyMemory = kernel32.func('__stdcall', 'RtlMoveMemory', 'void', ['void *', 'void *', 'size_t']);
const CreateCompatibleDC = gdi32.func('__stdcall', 'CreateCompatibleDC', 'intptr_t', ['intptr_t']);
const CreateDIBSection = gdi32.func('__stdcall', 'CreateDIBSection', 'intptr_t', ['intptr_t', koffi.pointer(BMIH), 'uint32_t', koffi.out(koffi.pointer('void *')), 'intptr_t', 'uint32_t']);
const SelectObject = gdi32.func('__stdcall', 'SelectObject', 'intptr_t', ['intptr_t', 'intptr_t']);
const CreateSolidBrush = gdi32.func('__stdcall', 'CreateSolidBrush', 'intptr_t', ['uint32_t']);
const FillRect = user32.func('__stdcall', 'FillRect', 'int', ['intptr_t', koffi.pointer(RECT), 'intptr_t']);
const CreateFontW = gdi32.func('__stdcall', 'CreateFontW', 'intptr_t',
  ['int', 'int', 'int', 'int', 'int', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'str16']);
const SetTextColor = gdi32.func('__stdcall', 'SetTextColor', 'uint32_t', ['intptr_t', 'uint32_t']);
const SetBkMode = gdi32.func('__stdcall', 'SetBkMode', 'int', ['intptr_t', 'int']);
const DrawTextW = user32.func('__stdcall', 'DrawTextW', 'int', ['intptr_t', 'str16', 'int', koffi.pointer(RECT), 'uint32_t']);
const Ellipse = gdi32.func('__stdcall', 'Ellipse', 'bool', ['intptr_t', 'int', 'int', 'int', 'int']);
const DeleteObject = gdi32.func('__stdcall', 'DeleteObject', 'bool', ['intptr_t']);

const WS_POPUP = 0x80000000;
const WS_EX = 0x00080000 | 0x00000008 | 0x00000080 | 0x08000000 | 0x00000020;
//          LAYERED       TOPMOST       TOOLWINDOW    NOACTIVATE     TRANSPARENT(鼠标穿透)
const ULW_ALPHA = 0x00000002;
const VK_ESCAPE = 0x1b;
const bgr = (r, g, b) => (b << 16) | (g << 8) | r;

const COLORS = {
  run: bgr(34, 211, 238),      // 青色：正在操作
  done: bgr(52, 211, 153),
  stop: bgr(248, 113, 113),
};

/**
 * 创建一个置顶、免打扰的状态条。失败时抛异常，调用方应自行降级（不影响主功能）。
 */
export function createHud(opts = {}) {
  const W = opts.width ?? 460;
  const H = opts.height ?? 78;
  const PAD = 8; // 阴影留白
  let state = { text: 'DSH 正在操作这台电脑', sub: '按 Esc 随时停止', tone: 'run', progress: null };
  let visible = false;
  let pulse = 0;
  let lastEscDown = false;
  let onEsc = null;
  let timer = null;
  let lastDraw = null;

  const wndProc = koffi.register((hwnd, msg, wp, lp) => {
    if (msg === 0x0002 /* WM_DESTROY */) return 0;
    if (msg === 0x0084 /* WM_NCHITTEST */) return -1; // HTTRANSPARENT：鼠标穿透
    return DefWindowProcW(hwnd, msg, wp, lp);
  }, koffi.pointer(WNDPROC));

  const hInst = GetModuleHandleW(null);
  const cls = 'DSHSidecarHud' + SUF;
  RegisterClassW({
    style: 0x0020, lpfnWndProc: wndProc, cbClsExtra: 0, cbWndExtra: 0, hInstance: hInst,
    hIcon: 0, hCursor: 0, hbrBackground: 0, lpszMenuName: null, lpszClassName: cls,
  });
  const work = { left: 0, top: 0, right: 0, bottom: 0 };
  let x = 0, y = 0;
  try {
    if (SystemParametersInfoW(0x0030 /* SPI_GETWORKAREA */, 0, work, 0) && work.right > 0) {
      x = Math.round((work.right + work.left - W) / 2);
      y = Math.round(work.bottom - H - 40);
    }
  } catch {}
  if (!x || !y) {
    const sw = GetSystemMetrics(0 /* SM_CXSCREEN */), sh = GetSystemMetrics(1 /* SM_CYSCREEN */);
    x = Math.round((sw - W) / 2);
    y = Math.max(0, sh - H - 80);
  }

  const hwnd = CreateWindowExW(WS_EX, cls, 'DSH sidecar indicator', WS_POPUP, x, y, W, H, 0, 0, hInst, null);
  if (!hwnd) throw new Error('CreateWindowExW failed');

  const screenDc = GetDC(0);
  const memDc = CreateCompatibleDC(screenDc);
  const bmi = {
    biSize: 40, biWidth: W, biHeight: -H, biPlanes: 1, biBitCount: 32,
    biCompression: 0, biSizeImage: W * H * 4, biXPelsPerMeter: 0, biYPixelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
  };
  const bitsOut = [null];
  const bmp = CreateDIBSection(memDc, bmi, 0, bitsOut, 0, 0);
  if (!bmp || !bitsOut[0]) throw new Error('CreateDIBSection failed');
  const bits = bitsOut[0];
  SelectObject(memDc, bmp);

  function drawFrame() {
    const n = W * H * 4;
    CopyMemory(bits, Buffer.alloc(n), n);

    // 卡片底
    const bg = CreateSolidBrush(bgr(11, 18, 32));
    FillRect(memDc, { left: PAD, top: PAD, right: W - PAD, bottom: H - PAD }, bg);
    DeleteObject(bg);

    // 顶部一条细高光，让卡片有质感
    const line = CreateSolidBrush(bgr(30, 41, 59));
    FillRect(memDc, { left: PAD + 14, top: PAD, right: W - PAD - 14, bottom: PAD + 1 }, line);
    DeleteObject(line);

    // 左侧状态点（呼吸）
    const accent = COLORS[state.tone] ?? COLORS.run;
    const r = 4 + Math.round(2 * (0.5 + 0.5 * Math.sin(pulse)));
    const cx = PAD + 26, cy = PAD + 25;
    const dotOn = CreateSolidBrush(accent);
    const oldBrush = SelectObject(memDc, dotOn);
    Ellipse(memDc, cx - r, cy - r, cx + r, cy + r);
    SelectObject(memDc, oldBrush);
    DeleteObject(dotOn);

    SetBkMode(memDc, 1 /* TRANSPARENT */);
    const fTitle = CreateFontW(-16, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 5, 0, 'Microsoft YaHei UI');
    const fSub = CreateFontW(-12, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, 'Microsoft YaHei UI');
    const fMono = CreateFontW(-12, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 5, 0, 'Consolas');

    SelectObject(memDc, fTitle);
    SetTextColor(memDc, bgr(238, 244, 255));
    DrawTextW(memDc, state.text, -1, { left: PAD + 44, top: PAD + 13, right: W - PAD - 96, bottom: PAD + 35 }, 0x8020);

    SelectObject(memDc, fSub);
    SetTextColor(memDc, bgr(148, 163, 184));
    DrawTextW(memDc, state.sub, -1, { left: PAD + 44, top: PAD + 36, right: W - PAD - 14, bottom: PAD + 52 }, 0x8020);

    if (state.progress) {
      SelectObject(memDc, fMono);
      SetTextColor(memDc, accent);
      const label = `${state.progress.done}/${state.progress.total}`;
      DrawTextW(memDc, label, -1, { left: W - PAD - 88, top: PAD + 16, right: W - PAD - 16, bottom: PAD + 36 }, 0x02 /* RIGHT */ | 0x20);
      // 进度条
      const ratio = Math.max(0, Math.min(1, state.progress.done / Math.max(1, state.progress.total)));
      const full = W - PAD * 2 - 20;
      const base = CreateSolidBrush(bgr(30, 41, 59));
      FillRect(memDc, { left: PAD + 10, top: H - PAD - 7, right: PAD + 10 + full, bottom: H - PAD - 4 }, base);
      DeleteObject(base);
      const bar = CreateSolidBrush(accent);
      FillRect(memDc, { left: PAD + 10, top: H - PAD - 7, right: PAD + 10 + Math.round(full * ratio), bottom: H - PAD - 4 }, bar);
      DeleteObject(bar);
    }

    DeleteObject(fTitle); DeleteObject(fSub); DeleteObject(fMono);

    // 逐像素 alpha：圆角 + 外阴影
    const raw = Buffer.alloc(n);
    CopyMemory(raw, bits, n);
    const rad = 12, cx0 = PAD, cy0 = PAD, cx1 = W - PAD - 1, cy1 = H - PAD - 1, sh = 8;
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        let a = 0;
        const dx = px < cx0 + rad ? cx0 + rad - px : (px > cx1 - rad ? px - (cx1 - rad) : 0);
        const dy = py < cy0 + rad ? cy0 + rad - py : (py > cy1 - rad ? py - (cy1 - rad) : 0);
        const inside = px >= cx0 && px <= cx1 && py >= cy0 && py <= cy1 && (dx === 0 || dy === 0 || dx * dx + dy * dy <= rad * rad);
        if (inside) a = 255;
        else if (px >= cx0 - sh && px <= cx1 + sh && py >= cy0 - sh && py <= cy1 + sh) {
          const ox = Math.max(cx0 - px, 0, px - cx1), oy = Math.max(cy0 - py, 0, py - cy1);
          const d = Math.hypot(ox, oy);
          if (d > 0 && d < sh) a = Math.round(70 * (1 - d / sh));
        }
        const i = (py * W + px) * 4;
        if (a < 255) {
          // UpdateLayeredWindow 要求预乘 alpha：不乘的话圆角与阴影边缘会泛白边
          const f = a / 255;
          raw[i] = Math.round(raw[i] * f);
          raw[i + 1] = Math.round(raw[i + 1] * f);
          raw[i + 2] = Math.round(raw[i + 2] * f);
        }
        raw[i + 3] = a;
      }
    }
    CopyMemory(bits, raw, n);
    const ulw = UpdateLayeredWindow(hwnd, screenDc, { x, y }, { cx: W, cy: H }, memDc, { x: 0, y: 0 }, 0,
      { BlendOp: 0, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: 1 }, ULW_ALPHA);
    lastDraw = { ok: !!ulw, err: ulw ? 0 : GetLastError() };
  }

  const msgBuf = Buffer.alloc(64);
  function pump() {
    let guard = 0;
    while (guard++ < 40 && PeekMessageW(msgBuf, 0, 0, 0, 1 /* PM_REMOVE */)) {
      TranslateMessage(msgBuf);
      DispatchMessageW(msgBuf);
    }
  }

  function escEdge() {
    const down = (Number(GetAsyncKeyState(VK_ESCAPE)) & 0x8000) !== 0;
    const pressed = down && !lastEscDown;
    lastEscDown = down;
    return pressed;
  }

  function tick() {
    pump();
    pulse += 0.45;
    if (visible) {
      if (onEsc && escEdge()) {
        try { onEsc(); } catch {}
      }
      drawFrame();
    }
  }

  function startTimer() {
    if (timer) return;
    timer = setInterval(tick, 90);
    if (timer.unref) timer.unref();
  }
  function stopTimer() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function show(next = {}) {
    state = { ...state, ...next };
    if (!visible) {
      ShowWindow(hwnd, 5 /* SW_SHOW */);
      SetWindowPos(hwnd, -1 /* TOPMOST */, x, y, W, H, 0x0010 /* NOACTIVATE */);
      visible = true;
      lastEscDown = (Number(GetAsyncKeyState(VK_ESCAPE)) & 0x8000) !== 0;
      startTimer();
    }
    drawFrame();
  }

  function hide() {
    if (visible) {
      ShowWindow(hwnd, 0 /* SW_HIDE */);
      visible = false;
    }
    stopTimer();
  }

  function update(patch) {
    state = { ...state, ...patch };
    if (visible) drawFrame();
  }

  function dispose() {
    hide();
    try { DestroyWindow(hwnd); } catch {}
    try { ReleaseDC(0, screenDc); } catch {}
    try { koffi.unregister(wndProc); } catch {}
  }

  function _snapshot() {
    const n = W * H * 4;
    const raw = Buffer.alloc(n);
    CopyMemory(raw, bits, n);
    const rgb = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = raw[i + 3] / 255;
        // 棋盘格底色，便于看清透明边缘
        const checker = ((x >> 4) + (y >> 4)) % 2 ? 90 : 60;
        for (let c = 0; c < 3; c++) {
          const src = raw[i + (2 - c)]; // BGRA -> RGB
          rgb[(y * W + x) * 3 + c] = Math.round(src * a + checker * (1 - a));
        }
      }
    }
    return { width: W, height: H, rgb };
  }

  drawFrame();
  return {
    hwnd,
    get visible() { return visible; },
    show, hide, update, dispose,
    setEscHandler(fn) { onEsc = fn; },
    // 测试用：手动渲染一帧
    _draw: drawFrame,
    // 测试用：把位图导成 PNG（透明处铺棋盘格），用于无屏幕环境下检查排版
    _snapshot,
    // 原始 BGRA 位图（带 alpha），用于把状态条合成到截图/文档里
    _raw() {
      const n = W * H * 4;
      const raw = Buffer.alloc(n);
      CopyMemory(raw, bits, n);
      return { width: W, height: H, bgra: Buffer.from(raw) };
    },
    _size: { width: W, height: H },
    _diag() {
      const r = Buffer.alloc(16);
      GetWindowRect(hwnd, r);
      return {
        hwnd, visible,
        isVisible: !!IsWindowVisible(hwnd),
        rect: { x: r.readInt32LE(0), y: r.readInt32LE(4), w: r.readInt32LE(8) - r.readInt32LE(0), h: r.readInt32LE(12) - r.readInt32LE(4) },
        exStyle: '0x' + (GetWindowLongW(hwnd, -20) >>> 0).toString(16),
        style: '0x' + (GetWindowLongW(hwnd, -16) >>> 0).toString(16),
        lastDraw,
      };
    },
  };
}

let singleton = null;
let broken = false;

/** 进程内单例；拿不到就返回 null（所有调用点都要能接受 null）。 */
export function hud() {
  if (broken) return null;
  if (singleton) return singleton;
  if (process.platform !== 'win32') { broken = true; return null; }
  try {
    // 热重载时先把上一份窗口收掉，避免残留
    const prev = globalThis.__dshSidecarHud;
    if (prev && typeof prev.dispose === 'function') { try { prev.dispose(); } catch {} }
    singleton = createHud();
    globalThis.__dshSidecarHud = singleton;
    return singleton;
  } catch {
    broken = true;
    return null;
  }
}

/** 测试用：强制重建。 */
export function _resetHud() {
  try { singleton?.dispose(); } catch {}
  singleton = null;
  broken = false;
  delete globalThis.__dshSidecarHud;
}
