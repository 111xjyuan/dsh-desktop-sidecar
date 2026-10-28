// DPI 感知 + 多屏枚举
//
// 为什么必须做：进程若不是 DPI-aware，Windows 在 125%/150% 缩放下会把
// 逻辑坐标「说谎」给 GDI（例如 2560x1600 报成 1707x1067），所有点击按比例偏。
// SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) 必须在任何窗口/截图调用之前执行。
//
// 注意：宿主进程可能已经设过 DPI 感知，这时再调 Set 会返回 FALSE / E_ACCESSDENIED（0x80070005），
// 但那不代表「没有 DPI 感知」。所以 setter 的结果只作为参考，最终状态一律以 queryAwareness() 为准。
import koffi from 'koffi';

let state = null;
let lastError = null;
let _fns = null;

export function dpiLastError() { return lastError; }

const AWARENESS_NAME = ['unaware', 'system', 'per-monitor'];
const AWARENESS_ZH = {
  unaware: '未启用 DPI 感知（缩放屏幕上坐标会偏）',
  system: '系统级 DPI 感知（多屏不同缩放时可能偏）',
  'per-monitor': '按显示器 DPI 感知（正常）',
};

function fns() {
  if (_fns) return _fns;
  const u32 = koffi.load('user32.dll');
  const k32 = koffi.load('kernel32.dll');
  let shcore = null;
  try { shcore = koffi.load('shcore.dll'); } catch {}
  _fns = { u32, k32, shcore };
  return _fns;
}

/** 读进程当前真实的 DPI 感知级别：0=unaware 1=system 2=per-monitor */
export function queryAwareness() {
  const attempts = [];
  try {
    const { k32, shcore } = fns();
    if (shcore) {
      const getCurrentProcess = k32.func('__stdcall', 'GetCurrentProcess', 'intptr_t', []);
      const getProcessDpiAwareness = shcore.func('__stdcall', 'GetProcessDpiAwareness', 'int', ['intptr_t', 'void *']);
      const buf = Buffer.alloc(4);
      const hr = getProcessDpiAwareness(getCurrentProcess(), buf);
      if (hr === 0) {
        const value = buf.readInt32LE(0);
        return { value, source: 'GetProcessDpiAwareness', hr, attempts };
      }
      attempts.push('GetProcessDpiAwareness hr=0x' + (hr >>> 0).toString(16));
    }
  } catch (e) {
    attempts.push('GetProcessDpiAwareness: ' + String((e && e.message) || e));
  }
  try {
    const { u32 } = fns();
    const getThreadDpiAwarenessContext = u32.func('__stdcall', 'GetThreadDpiAwarenessContext', 'intptr_t', []);
    const getAwarenessFromDpiAwarenessContext = u32.func('__stdcall', 'GetAwarenessFromDpiAwarenessContext', 'int', ['intptr_t']);
    const ctx = getThreadDpiAwarenessContext();
    if (ctx) {
      const value = getAwarenessFromDpiAwarenessContext(ctx);
      if (value >= 0) return { value, source: 'GetThreadDpiAwarenessContext', context: ctx, attempts };
      attempts.push('GetAwarenessFromDpiAwarenessContext returned ' + value);
    }
  } catch (e) {
    attempts.push('GetThreadDpiAwarenessContext: ' + String((e && e.message) || e));
  }
  return { value: null, source: 'none', attempts };
}

function finish(setter, setterResult) {
  const q = queryAwareness();
  const value = q.value;
  const kind = value === null ? 'unknown' : (AWARENESS_NAME[value] || ('level-' + value));
  const ok = value === null ? !!setterResult.ok : value > 0;
  state = {
    ok,
    mode: kind,
    detail: value === null ? (setter + ' (状态查询失败)') : (AWARENESS_ZH[kind] || kind),
    source: q.source,
    level: value,
    setter,
    setterOk: !!setterResult.ok,
    setterInfo: setterResult.info,
    error: ok ? undefined : (setterResult.info || lastError || undefined),
    attempts: q.attempts,
  };
  return state;
}

export function initDpi() {
  if (state) return state;
  // 1) per-monitor v2
  try {
    const u = koffi.load('user32.dll');
    const set = u.func('__stdcall', 'SetProcessDpiAwarenessContext', 'bool', ['intptr_t']);
    // -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    const ok = set(-4);
    const err = ok ? undefined : 'SetProcessDpiAwarenessContext returned false (常见于宿主已经设过)';
    return finish('SetProcessDpiAwarenessContext', { ok: !!ok, info: err });
  } catch (e1) {
    lastError = String((e1 && e1.message) || e1);
  }
  // 2) shcore per-monitor
  try {
    const sh = koffi.load('shcore.dll');
    const set = sh.func('__stdcall', 'SetProcessDpiAwareness', 'int', ['int']);
    const hr = set(2); // PROCESS_PER_MONITOR_DPI_AWARE
    return finish('SetProcessDpiAwareness', { ok: hr === 0, info: hr === 0 ? undefined : 'hr=0x' + (hr >>> 0).toString(16) });
  } catch (e2) {
    lastError = String((e2 && e2.message) || e2);
  }
  // 3) legacy system aware
  try {
    const u = koffi.load('user32.dll');
    const set = u.func('__stdcall', 'SetProcessDPIAware', 'bool', []);
    const ok = set();
    return finish('SetProcessDPIAware', { ok: !!ok, info: ok ? undefined : 'SetProcessDPIAware returned false' });
  } catch (e3) {
    lastError = String((e3 && e3.message) || e3);
    return finish('none', { ok: false, info: lastError });
  }
}

let _u32 = null;
function u32() {
  if (!_u32) _u32 = koffi.load('user32.dll');
  return _u32;
}

export function dpiForWindow(hwnd) {
  try {
    const f = u32().func('__stdcall', 'GetDpiForWindow', 'uint32', ['intptr_t']);
    return Number(f(Number(hwnd))) || 96;
  } catch {
    return 96;
  }
}

export function virtualScreen() {
  try {
    const g = u32().func('__stdcall', 'GetSystemMetrics', 'int', ['int']);
    // SM_XVIRTUALSCREEN=76, SM_YVIRTUALSCREEN=77, SM_CXVIRTUALSCREEN=78, SM_CYVIRTUALSCREEN=79
    return { x: Number(g(76)), y: Number(g(77)), w: Number(g(78)), h: Number(g(79)) };
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
}

/**
 * 枚举显示器：每次调用都重新枚举（热插拔 / 分辨率变化后仍然正确）。
 * 返回 [{ index, primary, rect, work }]，坐标是屏幕物理像素。
 * 用 40 字节原始缓冲读 MONITORINFO（koffi 对嵌套 struct 的 marshal-back 不可靠）。
 */
export function monitors() {
  const out = [];
  try {
    const u = u32();
    const tag = 'ME' + (Date.now() % 100000) + '_' + Math.floor(Math.random() * 1000);
    const GetMonitorInfoW = u.func('__stdcall', 'GetMonitorInfoW', 'bool', ['intptr_t', 'void *']);
    const PROTO = koffi.proto('bool ' + tag + '(intptr_t, intptr_t, void *, intptr_t)');
    const EnumDisplayMonitors = u.func('__stdcall', 'EnumDisplayMonitors', 'bool', ['intptr_t', 'intptr_t', koffi.pointer(PROTO), 'intptr_t']);
    const cb = koffi.register((hmon) => {
      try {
        const buf = Buffer.alloc(40);
        buf.writeUInt32LE(40, 0); // cbSize
        if (GetMonitorInfoW(hmon, buf)) {
          const rcM = { x: buf.readInt32LE(4), y: buf.readInt32LE(8), w: buf.readInt32LE(12) - buf.readInt32LE(4), h: buf.readInt32LE(16) - buf.readInt32LE(8) };
          const rcW = { x: buf.readInt32LE(20), y: buf.readInt32LE(24), w: buf.readInt32LE(28) - buf.readInt32LE(20), h: buf.readInt32LE(32) - buf.readInt32LE(24) };
          const flags = buf.readUInt32LE(36);
          out.push({ index: out.length, primary: (flags & 1) === 1, rect: rcM, work: rcW });
        } else {
          lastError = lastError || 'GetMonitorInfoW returned false';
        }
      } catch (e) { lastError = String((e && e.message) || e); }
      return true;
    }, koffi.pointer(PROTO));
    const ok = EnumDisplayMonitors(0, 0, cb, 0);
    if (!ok) lastError = lastError || 'EnumDisplayMonitors returned false';
    try { koffi.unregister(cb); } catch {}
    if (!out.length) {
      const vs = virtualScreen();
      out.push({ index: 0, primary: true, rect: vs, work: vs, fallback: true });
    }
  } catch (e) {
    lastError = String((e && e.message) || e);
    const vs = virtualScreen();
    if (!out.length) out.push({ index: 0, primary: true, rect: vs, work: vs, fallback: true });
  }
  return out;
}
