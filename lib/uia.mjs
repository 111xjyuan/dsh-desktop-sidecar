// UIA（UI Automation）桥：用系统自带的 UIAutomationClient 读控件树 / 触发控件动作。
// 为什么走 PowerShell：UIA 是 COM，Node 侧直连要手写 IDispatch，脚本化更稳且短生命周期不阻塞 spawn。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UIA_PS1 = fileURLToPath(new URL('./uia.ps1', import.meta.url));
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function run(args) {
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_PS1, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  const text = (r.stdout || '').trim();
  if (!text) throw new Error('uia: empty output ' + (r.stderr || '').slice(0, 300));
  const start = text.indexOf('{');
  if (start < 0) throw new Error('uia: no json in output');
  return JSON.parse(text.slice(start));
}

export function uiaTree(hwnd, { depth = 3, max = 80, match = '' } = {}) {
  const args = ['-Hwnd', String(hwnd), '-Depth', String(depth), '-Max', String(max)];
  if (match) args.push('-Match', String(match));
  const res = run(args);
  if (!res.ok && !res.action) throw new Error(res.error || 'uia failed');
  return res;
}

export function uiaAct(hwnd, { match, action = 'invoke', depth = 6, matchMode = 'auto', role = '' } = {}) {
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
