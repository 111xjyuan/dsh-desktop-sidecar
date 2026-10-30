// lib/ps.mjs — 找到本机的 Windows PowerShell。
// 为什么需要：Windows 不一定装在 C: 盘（issue #1 就是路径写死），
// 所以先问 SystemRoot，再问 PATH，最后才退回默认路径。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

let cached = null;

/** 返回可用的 powershell.exe 路径（找不到时返回 'powershell.exe' 交给 PATH） */
export function powershellPath() {
  if (cached) return cached;
  const cands = [];
  const root = process.env.SystemRoot || process.env.windir;
  if (root) cands.push(path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  try {
    const probe = spawnSync('where', ['powershell.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) cands.push(first);
  } catch {}
  cands.push('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 'powershell.exe');
  for (const c of cands) {
    try {
      if (c === 'powershell.exe' || existsSync(c)) { cached = c; return c; }
    } catch {}
  }
  cached = 'powershell.exe';
  return cached;
}

/** PowerShell 版本（字符串），拿不到返回 null */
export function powershellVersion() {
  try {
    const r = spawnSync(powershellPath(), ['-NoProfile', '-NonInteractive', '-Command',
      '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    const v = String(r.stdout || '').trim();
    return v || null;
  } catch { return null; }
}
