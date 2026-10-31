// guard.mjs — 安全桌面 / 锁屏拦截。
// 目的：绝不在「锁屏」「UAC 提权确认」「切换用户」这类系统安全界面上点击或打字。
//
// 判断（互为印证，任一强信号成立就拒绝）：
//  1) WTSQuerySessionInformation(WTSSessionInfoEx).SessionFlags —— 系统权威锁屏状态
//     （坑：0 = 已锁定，1 = 未锁定，与直觉相反）。
//  2) 进程 LogonUI.exe / LockApp.exe —— 锁屏界面的宿主进程，进程快照 2ms 就能查。
//  3) 输入桌面名不是 "Default"（UAC / 切换用户时是 "Winlogon"）。
//  4) 目标窗口本身是系统安全进程。
import koffi from 'koffi';
import * as win32 from './win32.mjs';

const user32 = koffi.load('user32.dll');
const wtsapi32 = koffi.load('wtsapi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const OpenInputDesktop = user32.func('__stdcall', 'OpenInputDesktop', 'intptr_t', ['uint32_t', 'bool', 'uint32_t']);
const CloseDesktop = user32.func('__stdcall', 'CloseDesktop', 'bool', ['intptr_t']);
const GetUserObjectInformationW = user32.func('__stdcall', 'GetUserObjectInformationW', 'bool', ['intptr_t', 'int', 'void *', 'uint32_t', 'void *']);

const WTSQuerySessionInformationW = wtsapi32.func('__stdcall', 'WTSQuerySessionInformationW', 'bool',
  ['intptr_t', 'uint32_t', 'int', 'void *', 'void *']);
const WTSFreeMemory = wtsapi32.func('__stdcall', 'WTSFreeMemory', 'void', ['void *']);

const CreateToolhelp32Snapshot = kernel32.func('__stdcall', 'CreateToolhelp32Snapshot', 'intptr_t', ['uint32_t', 'uint32_t']);
const Process32FirstW = kernel32.func('__stdcall', 'Process32FirstW', 'bool', ['intptr_t', 'void *']);
const Process32NextW = kernel32.func('__stdcall', 'Process32NextW', 'bool', ['intptr_t', 'void *']);
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['intptr_t']);
const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', []);

const SECURE_APP = /^(logonui|consent|credentialuibroker|useraccountcontrol|lockapp|swi_fc)\.exe$/i;
const SECURE_TITLE = /(用户账户控制|User Account Control|Windows 安全|安全桌面)/i;

/** 当前输入桌面名：通常 "Default"；UAC / 切换用户时 "Winlogon"。 */
export function inputDesktopName() {
  try {
    const h = OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
    if (!h) return null;
    try {
      const buf = Buffer.alloc(512);
      const need = Buffer.alloc(4);
      if (!GetUserObjectInformationW(h, 2 /* UOI_NAME */, buf, buf.length, need)) return null;
      const s = buf.toString('utf16le');
      const z = s.indexOf('\u0000');
      return z >= 0 ? s.slice(0, z) : s;
    } finally {
      try { CloseDesktop(h); } catch {}
    }
  } catch {
    return null;
  }
}

/** WTSINFOEXW 的 SessionFlags：0 = 锁定，1 = 未锁定；查询失败返回 null。 */
export function sessionFlags() {
  try {
    const pp = Buffer.alloc(8);
    const by = Buffer.alloc(4);
    if (!WTSQuerySessionInformationW(0, 0xFFFFFFFF /* WTS_CURRENT_SESSION */, 25 /* WTSSessionInfoEx */, pp, by)) return null;
    const ptr = pp.readBigUInt64LE(0);
    if (!ptr) return null;
    try {
      const raw = Buffer.from(koffi.decode(ptr, koffi.array('uint8_t', 24)));
      return raw.readInt32LE(12); // Level, SessionId, SessionState, SessionFlags
    } finally {
      try { WTSFreeMemory(ptr); } catch {}
    }
  } catch {
    return null;
  }
}

/** 当前是否有 LockonUI / LockApp 在跑（用来印证锁屏状态）。 */
export function lockHosts() {
  const found = { logonui: false, lockapp: false, known: true };
  try {
    const snap = CreateToolhelp32Snapshot(0x00000002 /* TH32CS_SNAPPROCESS */, 0);
    if (!snap || Number(snap) === -1) { found.known = false; return found; }
    try {
      const entry = Buffer.alloc(568);
      entry.writeUInt32LE(568, 0);
      let ok = Process32FirstW(snap, entry);
      while (ok) {
        const name = entry.toString('utf16le', 44, 44 + 520).split('\u0000')[0].toLowerCase();
        if (name === 'logonui.exe') found.logonui = true;
        if (name === 'lockapp.exe') found.lockapp = true;
        if (found.logonui && found.lockapp) break;
        entry.writeUInt32LE(568, 0);
        ok = Process32NextW(snap, entry);
      }
    } finally {
      try { CloseHandle(snap); } catch {}
    }
  } catch { found.known = false; }
  return found;
}

/**
 * 纯判断函数（可单测）：把「WTS 标志」和「锁屏进程」两个信号合成一个结论。
 * 为什么不直接用 flags：WTSINFOEX 的 SessionFlags 在微软文档里是 0=锁定/1=未锁，
 * 但历史上有机器实测相反。因此只把 flags===0 当「可疑」，必须再有锁屏进程印证才判定锁定；
 * 反过来两个锁屏进程同时在跑，即使 flags 说未锁也判锁定。宁可多问一句，不可误按。
 */
/**
 * 纯判断函数（可单测）：把「输入桌面名」「WTS 标志」「锁屏进程」三个信号合成结论。
 * 背景（issue #5）：会话里可能残留一个没有窗口的 LockApp.exe，此时桌面其实是 Default、系统已解锁，
 * 只凭 lockapp 进程就判锁屏会把所有输入工具全拒掉。所以：
 *  - 输入桌面不是 Default（UAC / 切换用户）= 绝对不碰；
 *  - LogonUI 在跑 = 真锁屏（Win11 锁屏时它照样在）；
 *  - 桌面是 Default 且没有 LogonUI = 已解锁，残留的 LockApp 不算数；
 *  - 读不到桌面名时退回旧逻辑（flags===0 且无进程信息 → 保守判锁定）。
 */
export function decideLocked(flags, hosts, desktopName) {
  const h = hosts || {};
  const name = desktopName == null ? null : String(desktopName);
  const onDefault = name != null && name.toLowerCase() === 'default';
  const bothHosts = !!(h.logonui && h.lockapp);
  if (name != null && !onDefault) return { locked: true, source: 'desktop:' + name };
  if (h.logonui) return { locked: true, source: bothHosts ? 'process' : 'logonui' };
  if (onDefault) {
    return { locked: false, source: h.lockapp ? 'desktop+orphan-lockapp' : 'desktop' };
  }
  if (flags === 0) {
    if (h.known === false) return { locked: true, source: 'WTS+no-proc-info' };
    if (h.lockapp) return { locked: true, source: 'WTS' };
  }
  return { locked: false, source: flags === null ? 'none' : 'WTS' };
}

/** 会话锁定状态。{ locked, source, flags, logonui, lockapp, desktop } */
export function lockState(desktopName) {
  const flags = sessionFlags();
  const hosts = lockHosts();
  const name = desktopName === undefined ? inputDesktopName() : desktopName;
  const d = decideLocked(flags, hosts, name);
  return { locked: d.locked, source: d.source, flags, ...hosts, desktop: name };
}

/** 当前是否处在不能操作的状态（锁屏 / UAC / 切换用户 / 安全窗口）。 */
export function secureDesktop(win) {
  const st = lockState();
  if (st.locked) {
    return {
      active: true, locked: true, app: 'LockScreen',
      detail: st.source === 'WTS' ? 'Windows 会话处于锁屏状态' : '检测到锁屏界面进程（LogonUI / LockApp）',
      state: st,
    };
  }
  const name = inputDesktopName();
  if (name && name.toLowerCase() !== 'default') {
    return { active: true, desktop: name, app: 'Winlogon', detail: '输入桌面是 ' + name + '（UAC 提权确认 / 切换用户）', state: st };
  }
  try {
    if (win) {
      const app = String(win.app || '');
      const title = String(win.title || '');
      if (SECURE_APP.test(app)) return { active: true, app, title, desktop: name, state: st };
      if (SECURE_TITLE.test(title)) return { active: true, app, title, desktop: name, state: st };
    }
    const fg = Number(win32.foregroundWindow());
    if (fg) {
      const hit = win32.listWindows({ onScreenOnly: true }).find((w) => Number(w.hwnd) === fg && SECURE_APP.test(String(w.app || '')));
      if (hit) return { active: true, app: hit.app, title: hit.title, desktop: name, state: st };
    }
  } catch {}
  return { active: false, desktop: name, state: st };
}

/** 统一的拒绝结果；不需要拦截时返回 null。 */
export function refusalFor(win, tool) {
  const s = secureDesktop(win);
  if (!s.active) return null;
  return {
    ok: false,
    refused: true,
    error: 'refused: secure desktop',
    detail: (s.detail || ((s.app || 'system') + ' 正在显示系统安全界面')) + '。这类界面上不会做任何模拟输入。',
    app: s.app,
    title: s.title,
    desktop: s.desktop,
    hint: '请先解锁屏幕或在电脑上手动完成提权确认，然后重试；' + (tool ? tool + ' 没有执行任何操作。' : '没有执行任何操作。'),
  };
}
