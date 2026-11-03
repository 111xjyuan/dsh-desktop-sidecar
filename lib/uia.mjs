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

// 熔断：PowerShell 被安全软件拦掉、或进程根本起不来时，每次调用都 spawn 会又慢又烦，
// 还会反复触发杀软的“脚本行为”告警。连续硬失败后停一会儿，期间直接报人话，不再起进程。
const BREAKER = { fails: 0, until: 0, lastError: '', reasons: [] };

export function uiaHealth() {
  return {
    ok: BREAKER.fails === 0 && Date.now() >= BREAKER.until,
    fails: BREAKER.fails,
    openForMs: BREAKER.until > Date.now() ? BREAKER.until - Date.now() : 0,
    lastError: BREAKER.lastError,
    powershell: PS,
  };
}
export function _resetUiaHealth() { BREAKER.fails = 0; BREAKER.until = 0; BREAKER.lastError = ''; BREAKER.reasons.length = 0; }

function trip(e, context) {
  BREAKER.fails += 1;
  BREAKER.lastError = String((e && e.message) || e).slice(0, 300);
  BREAKER.reasons.push({ at: Date.now(), context, error: BREAKER.lastError });
  if (BREAKER.reasons.length > 8) BREAKER.reasons.shift();
  if (BREAKER.fails >= 3) BREAKER.until = Date.now() + 60000;
}

function guard() {
  if (BREAKER.until > Date.now()) {
    const left = Math.ceil((BREAKER.until - Date.now()) / 1000);
    throw new Error('uia: 这台机器上 PowerShell 调不通，读控件的路暂时不可用（约 ' + left + ' 秒后重试）。截图、点击、打字仍然可用。' +
      '常见原因：安全软件拦截脚本、执行策略被锁、精简系统没有 PowerShell。跑 desktop_doctor{report:true} 可生成可发出的体检报告。上一次错误：' + BREAKER.lastError);
  }
}

function run(args) {
  guard();
  let r;
  try {
    r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UIA_PS1, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) { trip(e, 'spawn'); throw e; }
  if (r && r.error) { trip(r.error, 'spawnSync'); throw new Error('uia: PowerShell 启动失败（' + String(r.error.message || r.error) + '）'); }
  const text = (r.stdout || '').trim();
  if (!text) {
    const err = String(r.stderr || '').trim();
    const pc = uiaParseCheck();
    if (pc && pc.ok === false) {
      trip(new Error(String(pc.detail).slice(0, 200)), 'parse');
      throw new Error('uia.ps1 cannot be parsed on this machine, so the control tree cannot be read: ' + String(pc.detail).slice(0, 400) + ' (PowerShell: ' + PS + ')');
    }
    trip(new Error(err || 'empty output'), 'empty');
    throw new Error('uia: empty output ' + err.slice(0, 300));
  }
  const st = text.indexOf('{');
  if (st < 0) { trip(new Error('no json'), 'json'); throw new Error('uia: no json in output'); }
  const parsed = JSON.parse(text.slice(st));
  if (BREAKER.fails || BREAKER.until) { BREAKER.fails = 0; BREAKER.until = 0; }
  return parsed;
}

// 同一步操作里经常连着读同一个窗口（先看得见什么、再确认点没点中），
// 250ms 内同样的参数直接复用结果：省一次 PowerShell 启动（约 200~400ms），也少一次杀软眼里的“脚本行为”。
const TREE_CACHE = new Map();
const TREE_TTL = 900;
// 记住哪些窗口的控件树天生就稀疏（Chromium 自绘、Qt），下次不再白等懒加载。
const SPARSE_MEMO = new Map();
export function _invalidateTreeCache() { TREE_CACHE.clear(); }

export function uiaTree(hwnd, { depth = 3, max = 80, match = '' } = {}) {
  const key = String(hwnd) + '|' + depth + '|' + max + '|' + match;
  const hit = TREE_CACHE.get(key);
  if (hit && Date.now() - hit.at < TREE_TTL) { hit.hits = (hit.hits || 0) + 1; return { ...hit.value, cached: true }; }
  const args = ['-Hwnd', String(hwnd), '-Depth', String(depth), '-Max', String(max)];
  if (match) args.push('-Match', String(match));
  const res = run(args);
  try {
    if (TREE_CACHE.size > 24) TREE_CACHE.clear();
    TREE_CACHE.set(key, { at: Date.now(), value: res });
  } catch {}
  if (!res.ok && !res.action) throw new Error(res.error || 'uia failed');
  // Chromium（Edge/Chrome）的无障碍树是懒加载的：第一次问通常只回窗口框架，
  // 隔一会儿再问才把标签栏/地址栏/工具条吐出来。只在“明显太空”时补一次。
  const n = (res.elements || []).length;
  if (!match && n <= 12) {
    // 同一个窗口刚确认过“它就是稀疏的”，就不要每次都再等 0.9 秒——那是最贵的浪费。
    const memo = SPARSE_MEMO.get(String(hwnd));
    const known = memo && Date.now() - memo.at < 60000;
    if (known && memo.n >= n && res.force !== true) {
      return { ...res, sparseKnown: true };
    }
    try {
      const t0 = Date.now();
      while (Date.now() - t0 < 900) { /* 等 Chromium 把无障碍子树建起来 */ }
      const again = run(args);
      const n2 = (again.elements || []).length;
      SPARSE_MEMO.set(String(hwnd), { at: Date.now(), n: Math.max(n, n2) });
      if (TREE_CACHE.size > 24) TREE_CACHE.clear();
      try { TREE_CACHE.set(key, { at: Date.now(), value: again }); } catch {}
      if (n2 > n) return again;
    } catch {}
  } else if (n > 12) {
    SPARSE_MEMO.delete(String(hwnd));
  }
  return res;
}

export function uiaAct(hwnd, { match, action = 'invoke', depth = 6, matchMode = 'auto', role = '' } = {}) {
  TREE_CACHE.clear(); // 动作之后控件树一定变了，缓存不能再用
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
  TREE_CACHE.clear();
  const args = ['-Hwnd', String(hwnd), '-Action', 'setvalue', '-Value', String(value), '-Depth', String(depth)];
  if (match) args.push('-Match', String(match));
  return run(args);
}

export function focusInfo(hwnd) {
  const r = run(['-Hwnd', String(hwnd), '-FocusInfo', '-Depth', '3']);
  return r || {};
}
