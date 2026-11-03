// 环境体检 + 自我适配。
//
// 目的：别人的电脑跟开发机不一样（缩放、PowerShell 版本、OCR 语言包、权限、多屏），
// 插件要自己先量一遍，并把参数调到“在这台机器上更稳”的那一档，而不是全用一套写死的值。
//
// 原则：
//   - 探测失败绝不抛错、绝不阻塞主流程（每项都 try/catch，超时给默认值）。
//   - 结果缓存到 %LOCALAPPDATA%\dsh-sidecar\env.json，一天内复用，避免每次启动都慢。
//   - 只调“安全参数”（等多久、读几带、试几次），不改变任何用户可见的行为。
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { powershellPath, powershellVersion } from './ps.mjs';
import { monitors, virtualScreen, queryAwareness } from './dpi.mjs';
import * as win32 from './win32.mjs';

const DIR = join(process.env.LOCALAPPDATA || join(os.homedir(), 'AppData', 'Local'), 'dsh-sidecar');
const FILE = join(DIR, 'env.json');
const STALE_MS = 24 * 3600 * 1000;

const DEFAULTS = {
  dpiScale: 1,
  ocr: { bands: 4, scale: 2.6, slow: false },
  focus: { settleMs: 220 },
  click: { attempts: 2 },
  uia: { preferUia: true },
};

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  try {
    fs.mkdirSync(join(p, '..'), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v, null, 2));
  } catch {}
}

function psRun(script, timeout = 4000) {
  try {
    const out = execFileSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(out || '').trim();
  } catch {
    return '';
  }
}

// OCR 语言包：只问系统有哪些识别语言，不做任何识别，600ms 左右。
function detectOcrLanguages() {
  const raw = psRun("[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag } | Sort-Object", 6000);
  const langs = raw ? raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  const zh = langs.some((l) => /^zh/i.test(l));
  return { available: langs.length > 0, langs, zh };
}

export function buildTuning(env) {
  const t = JSON.parse(JSON.stringify(DEFAULTS));
  // 超高缩放时，同样一带能塞下更多字，缩放倍率降一点更快。
  const scale = Number(env.dpi && env.dpi.scale) || 1;
  if (scale >= 1.75) t.ocr.scale = 2.2;
  if (scale >= 2.25) t.ocr.scale = 2.0;
  // 没有中文识别语言：OCR 只会给乱码，把 OCR 降级成“兜底中的兜底”，并把带数减到 2。
  if (env.ocr && env.ocr.zh === false && env.ocr.available !== false) {
    t.ocr.bands = 2;
    t.ocr.slow = true;
    t.uia.preferUia = true;
  }
  // PowerShell 起不来 → 控件树这条路不通，重心放看图。
  if (env.ps && env.ps.ok === false) t.uia.preferUia = false;
  // 用着用着学到的真实耗时：OCR 太慢就少切几刀，快就多用几刀（更准）。
  const learned = env.learned || {};
  const ocrMs = Number(learned.ocrMs) || 0;
  if (ocrMs > 2600) { t.ocr.bands = 2; t.ocr.slow = true; }
  else if (ocrMs > 0 && ocrMs < 1200 && t.ocr.bands < 4) t.ocr.bands = 4;
  // 焦点就位快说明这机器响应好，可以少等；慢就多给点时间，别丢字。
  const focusMs = Number(learned.focusMs) || 0;
  if (focusMs > 0) t.focus.settleMs = focusMs > 520 ? 340 : (focusMs < 180 ? 180 : 240);
  return t;
}

/**
 * 收集环境信息。不会抛错：每项失败都记进 notes。
 */
export function detectEnv() {
  const notes = [];
  const env = { at: Date.now(), notes };

  try {
    env.os = {
      platform: process.platform,
      release: os.release(),
      version: os.version ? os.version() : '',
      arch: process.arch,
      build: (() => { const m = /^10\.0\.(\d+)/.exec(os.release() || ''); return m ? Number(m[1]) : null; })(),
      node: process.version,
    };
  } catch (e) { notes.push('os: ' + (e && e.message)); }

  try {
    env.ps = { path: powershellPath(), version: powershellVersion(), ok: true };
    const probe = psRun('$PSVersionTable.PSVersion.ToString()', 3000);
    if (!probe) {
      env.ps.ok = false;
      notes.push('PowerShell 起不来（可能被组策略/杀毒软件拦截），读控件文字会不可用');
    }
  } catch (e) {
    env.ps = { ok: false };
    notes.push('powershell: ' + (e && e.message));
  }

  try {
    const mons = monitors() || [];
    const vs = virtualScreen();
    env.monitors = mons.map((m) => ({ index: m.index, primary: !!m.primary, x: m.rect.x, y: m.rect.y, w: m.rect.w, h: m.rect.h }));
    env.virtualScreen = vs;
    env.dpi = { scale: mons.length ? Number((mons[0].rect.w && mons[0].work ? 1 : 1)) : 1, awareness: queryAwareness() };
    const raw = psRun('(Get-ItemProperty "HKCU:\\Control Panel\\Desktop\\WindowMetrics" -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI', 2500);
    const dpi = Number(String(raw).trim());
    if (dpi > 0) env.dpi.scale = Math.round((dpi / 96) * 100) / 100;
    if (mons.length > 1) notes.push('检测到 ' + mons.length + ' 块屏幕，坐标换算已按虚拟屏处理');
  } catch (e) { notes.push('dpi: ' + (e && e.message)); }

  try { env.elevated = !!win32.isElevated(process.pid); } catch { env.elevated = null; }

  try { env.ocr = detectOcrLanguages(); if (!env.ocr.zh) notes.push('没有装中文识别语言包（截图识字会不准；Windows 设置 → 时间和语言 → 语言 → 添加中文并勾选“光学字符识别”）'); } catch (e) { env.ocr = { available: null, langs: [], zh: null }; }

  env.tuning = buildTuning(env);
  env.summary = [
    (env.os && env.os.release) || '?',
    '缩放 ' + Math.round(((env.dpi && env.dpi.scale) || 1) * 100) + '%',
    (env.monitors && env.monitors.length) + ' 屏',
    'PowerShell ' + ((env.ps && env.ps.version) || '未检测到'),
    env.ocr && env.ocr.zh ? '中文 OCR 可用' : '中文 OCR 缺失',
    env.elevated ? '管理员权限' : '普通权限',
  ].join(' · ');

  return env;
}

/**
 * 拿到可用的环境画像：优先读缓存（24 小时内），否则现探一次并存盘。
 * force=true 强制重探。
 */
export function envProfile({ force = false } = {}) {
  if (!force) {
    const cached = readJson(FILE);
    if (cached && cached.at && Date.now() - cached.at < STALE_MS && cached.tuning) return cached;
  }
  const env = detectEnv();
  writeJson(FILE, env);
  return env;
}

/** 学习：把实测耗时喂回来，自动调整参数。返回值是调整后的 tuning。 */
export function learn(kind, value, extra = {}) {
  const env = envProfile();
  const t = env.tuning || JSON.parse(JSON.stringify(DEFAULTS));
  try {
    if (kind === 'ocrMs') {
      const ms = Number(value) || 0;
      env.ocrMsEma = env.ocrMsEma ? Math.round(env.ocrMsEma * 0.7 + ms * 0.3) : ms;
      if (env.ocrMsEma > 2600 && t.ocr.bands > 2) t.ocr.bands = 2;          // 太慢就少读几带
      if (env.ocrMsEma < 1200 && t.ocr.bands < 4 && (env.ocr || {}).zh) t.ocr.bands = 4; // 够快就多读几带更准
    } else if (kind === 'focusMs') {
      const ms = Number(value) || 0;
      env.focusMsEma = env.focusMsEma ? Math.round(env.focusMsEma * 0.7 + ms * 0.3) : ms;
      t.focus.settleMs = env.focusMsEma > 500 ? 340 : env.focusMsEma > 260 ? 240 : 180;
    } else if (kind === 'app') {
      const app = String(extra.app || '').toLowerCase();
      if (app) {
        const a = (env.apps || (env.apps = {}))[app] || (env.apps[app] = { uia: 0, ocr: 0, pixels: 0, ok: 0, fail: 0 });
        const ch = String(extra.channel || '').toLowerCase();
        if (ch in a) a[ch] += 1;
        if (extra.ok) a.ok += 1; else a.fail += 1;
      }
    }
    env.tuning = t;
    env.learnedAt = Date.now();
    writeJson(FILE, env);
    return t;
  } catch {
    return t;
  }
}

/** 只读当前调参，不触发探测（没跑过探测就给默认值）。 */
export function tuning() {
  const cached = readJson(FILE);
  return (cached && cached.tuning) || JSON.parse(JSON.stringify(DEFAULTS));
}

export function envPath() { return FILE; }
export function _resetEnv() { try { fs.unlinkSync(FILE); } catch {} }
