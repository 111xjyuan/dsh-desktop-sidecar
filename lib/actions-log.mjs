// actions-log.mjs — 每次真的动了鼠标/键盘都记一条，方便事后复盘「它到底做了什么」。
// 存在 %LOCALAPPDATA%\dsh-sidecar\actions.jsonl（写不进去才退回 %TEMP%，只留最近 N 行）。
//
// 为什么不是 TEMP：实测宿主进程（Electron 里的 DSH）往 %TEMP%\dsh-sidecar 写会失败，
// 而同一个进程写 %LOCALAPPDATA%\dsh-sidecar 是好的 —— 之前日志一条都读不到就是这个原因。
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_LINES = 500;

function baseDir() {
  const local = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  return local ? join(local, 'dsh-sidecar') : join(tmpdir(), 'dsh-sidecar');
}

let resolved = null;
let lastError = null;

/**
 * 选一个真的写得进去的目录。第一次调用时探一次，之后记住。
 * 探测会真写一个小文件 —— 只判断目录存在不算数（之前就是这么误判的）。
 */
function logDir() {
  if (resolved) return resolved;
  const candidates = [baseDir(), join(tmpdir(), 'dsh-sidecar')];
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      const probe = join(dir, '.probe');
      appendFileSync(probe, 'ok', 'utf8');
      resolved = dir;
      lastError = null;
      return resolved;
    } catch (e) {
      lastError = { dir, error: String((e && e.message) || e) };
    }
  }
  resolved = candidates[candidates.length - 1];
  return resolved;
}

export function logFile() {
  return join(logDir(), 'actions.jsonl');
}

export function logDirPath() {
  return logDir();
}

/** 上一次写失败的原因（成功时为 null），给 doctor / desktop_log 用。 */
export function logStatus() {
  const dir = logDir();
  return {
    dir,
    file: join(dir, 'actions.jsonl'),
    writable: !lastError,
    lastError: lastError ? lastError.error : null,
  };
}

const seen = new Map(); // 去重：同一工具、同样内容 500ms 内只记一条

/** 记一条操作。payload 里的 long 字段（截图 base64 之类）请自己先删掉。 */
export function logAction(tool, payload = {}) {
  const dir = logDir();
  const file = join(dir, 'actions.jsonl');
  const entry = {
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    tool,
    ...payload,
  };
  let line;
  try { line = JSON.stringify(entry); } catch { line = JSON.stringify({ ts: entry.ts, tool, note: 'unserializable' }); }
  // 各分支自己也会 logTool，加上统一入口后同一次点击会写两条 —— 去重掉。
  const key = tool + '|' + line.replace(/"ts":"[^"]*",?/, '');
  const now = Date.now();
  const prevAt = seen.get(key);
  if (prevAt && now - prevAt < 500) return { ...entry, deduped: true, file };
  seen.set(key, now);
  if (seen.size > 200) seen.clear();
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, line + '\n', 'utf8');
    lastError = null;
    // 超过上限时只保留最后 MAX_LINES 行（低频操作，代价可忽略）
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(file, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8');
    }
  } catch (e) {
    lastError = { dir, error: String((e && e.message) || e) };
    // 日志失败绝不能影响主流程，但要能被查出来
    return { ...entry, file, logged: false, logError: lastError.error };
  }
  return { ...entry, file, logged: true };
}

/** 读最近的条目，新的在前。 */
export function readLog(limit = 30) {
  const n = Math.max(1, Math.min(Number(limit) || 30, 500));
  const file = logFile();
  if (!existsSync(file)) return { file, total: 0, entries: [] };
  let raw = '';
  try { raw = readFileSync(file, 'utf8'); } catch { return { file, total: 0, entries: [] }; }
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < n; i--) {
    try { entries.push(JSON.parse(lines[i])); } catch {}
  }
  return { file, total: lines.length, entries };
}

/** 清空日志（归档成 .1 再开新文件，方便找回）。 */
export function clearLog() {
  const file = logFile();
  if (!existsSync(file)) return { cleared: true, file, total: 0 };
  try {
    let total = 0;
    try { total = readFileSync(file, 'utf8').split('\n').filter(Boolean).length; } catch {}
    try { renameSync(file, file + '.1'); } catch {}
    writeFileSync(file, '', 'utf8');
    return { cleared: true, file, archived: file + '.1', total };
  } catch (e) {
    return { cleared: false, file, error: String(e && e.message || e) };
  }
}
