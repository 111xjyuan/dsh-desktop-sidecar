// UIA（UI Automation）桥：用系统自带的 UIAutomationClient 读控件树 / 触发控件动作。
// 为什么走 PowerShell：UIA 是 COM，Node 侧直连要手写 IDispatch，脚本化更稳且短生命周期不阻塞 spawn。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { powershellPath } from './ps.mjs';

const UIA_PS1 = fileURLToPath(new URL('./uia.ps1', import.meta.url));
const PS = powershellPath();

// 自检：先把 uia.ps1 交给 PowerShell 的语法分析器过一遍。
// 真实事故：脚本用 UTF-8 无 BOM 存盘时，Windows PowerShell 5.1 会按本地代码页解码，
// 脚本里的中文注释被读成乱码，整份脚本报“语法错误”，于是控件树永远读不到。
// 现在一旦出现这种情况，报错要能直接指到行号，Doctor 也能查出来。
let PARSE_CACHE = null;
export function uiaParseCheck() {
  if (PARSE_CACHE) return PARSE_CACHE;
  try {
    const cmd = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + UIA_PS1.replace(/'/g, "''") + "',[ref]$null,[ref]$e); " +
      "if($e.Count -gt 0){ $e | Select-Object -First 5 | ForEach-Object { $_.Extent.StartLineNumber.ToString() + ': ' + $_.Message } } else { 'OK' }";
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const out = String(r.stdout || '').trim();
    if (out === 'OK') PARSE_CACHE = { ok: true };
    else PARSE_CACHE = { ok: false, detail: out || String(r.stderr || '').trim().slice(0, 400) };
  } catch (e) {
    PARSE_CACHE = { ok: false, detail: String((e && e.message) || e) };
  }
  return PARSE_CACHE;
}

function run(args) {
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_PS1, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = (r.stdout || '').trim();
  if (!text) {
    // 空输出最常见的原因不是“读不到控件”，而是脚本本身在对方机器上解析失败。
    // 把语法错误连同行号一起抛出来，比“empty output”有用一百倍。
    const err = String(r.stderr || '').trim();
    const pc = uiaParseCheck();
    if (pc && pc.ok === false) {
      throw new Error('uia.ps1 cannot be parsed on this machine, so the control tree cannot be read: ' + String(pc.detail).slice(0, 400) + ' (PowerShell: ' + PS + ')');
    }
    throw new Error('uia: empty output ' + err.slice(0, 300));
  }
  const start = text.indexOf('{');
  if (start < 0) throw new Error('uia: no json in output');
  return JSON.parse(text.slice(start));
}

export function uiaTree(hwnd, { depth = 3, max = 80, match = '' } = {}) {
  const args = ['-Hwnd', String(hwnd), '-Depth', String(depth), '-Max', String(max)];
  if (match) args.push('-Match', String(match));
  const res = run(args);
  if (!res.ok && !res.action) throw new Error(res.error || 'uia failed');
  // Chromium（Edge/Chrome）的无障碍树是懒加载的：第一次问通常只回窗口框架，
  // 隔一会儿再问才把标签栏/地址栏/工具条吐出来。只在“明显太空”时补一次。
  const n = (res.elements || []).length;
  if (!match && n <= 12) {
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 900) { /* 等 Chromium 把无障碍子树建起来 */ }
      const again = run(args);
      if ((again.elements || []).length > n) return again;
    } catch {}
  }
  return res;
}

export function uiaAct(hwnd, { match, action = 'invoke', depth = 6, matchMode = 'auto', role = '' } = {}) {
  // focusfirst 不需要（也不该要求）指定控件名：它自己找窗口里第一个可编辑的控件
  if (action === 'focusfirst') {
    return run(['-Hwnd', String(hwnd), '-Depth', String(depth), '-Max', '400', '-Action', 'focusfirst']);
  }
  if (!match) throw new Error('uiaAct needs match');
  const args = ['-Hwnd', String(hwnd), '-Depth', String(depth), '-Max', '400', '-Match', String(match), '-Action', String(action), '-MatchMode', String(matchMode)];
  if (role) args.push('-Role', String(role));
  return run(args);
}

// findControl: 只定位不动作，返回 name / role / 屏幕矩形，供“按名字点击”使用。
export function findControl(hwnd, { name, role = '', matchMode = 'exact', depth = 8 } = {}) {
  if (!name) throw new Error('findControl needs name');
  const args = ['-Hwnd', String(hwnd), '-Depth', String(depth), '-Max', '400', '-Match', String(name), '-MatchMode', String(matchMode), '-Find'];
  if (role) args.push('-Role', String(role));
  return run(args);
}

export function uiaText(hwnd, { match = '', depth = 6 } = {}) {
  const args = ['-Hwnd', String(hwnd), '-Text', '-Depth', String(depth)];
  if (match) args.push('-Match', String(match));
  return run(args);
}

export function uiaSetValue(hwnd, { match = '', value = '', depth = 6 } = {}) {
  const args = ['-Hwnd', String(hwnd), '-Action', 'setvalue', '-Value', String(value), '-Depth', String(depth)];
  if (match) args.push('-Match', String(match));
  return run(args);
}

export function focusInfo(hwnd) {
  const r = run(['-Hwnd', String(hwnd), '-FocusInfo', '-Depth', '3']);
  return r || {};
}
