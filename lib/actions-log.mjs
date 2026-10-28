// actions-log.mjs — 每次真的动了鼠标/键盘都记一条，方便事后复盘「它到底做了什么」。
// 存在 %TEMP%\dsh-sidecar\actions.jsonl（只留最近 N 行，不无限长）。
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = join(tmpdir(), 'dsh-sidecar');
const FILE = join(DIR, 'actions.jsonl');
const MAX_LINES = 500;

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
}

/** 记一条操作。payload 里的 long 字段（截图 base64 之类）请自己先删掉。 */
export function logAction(tool, payload = {}) {
  ensureDir();
  const entry = {
    ts: new Date().toISOString().replace('T', ' ').slice(0, 19),
    tool,
    ...payload,
  };
  let line;
  try { line = JSON.stringify(entry); } catch { line = JSON.stringify({ ts: entry.ts, tool, note: 'unserializable' }); }
  try {
    appendFileSync(FILE, line + '\n', 'utf8');
    // 超过上限时只保留最后 MAX_LINES 行（低频操作，代价可忽略）
    const raw = readFileSync(FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(FILE, lines.slice(-MAX_LINES).join('\n') + '\n', 'utf8');
    }
  } catch {
    // 日志失败绝不能影响主流程
  }
  return entry;
}

/** 读最近的条目，新的在前。 */
export function readLog(limit = 30) {
  const n = Math.max(1, Math.min(Number(limit) || 30, 500));
  if (!existsSync(FILE)) return { file: FILE, total: 0, entries: [] };
  let raw = '';
  try { raw = readFileSync(FILE, 'utf8'); } catch { return { file: FILE, total: 0, entries: [] }; }
  const lines = raw.split('\n').filter(Boolean);
  const entries = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < n; i--) {
    try { entries.push(JSON.parse(lines[i])); } catch {}
  }
  return { file: FILE, total: lines.length, entries };
}

/** 清空日志（归档成 .1 再开新文件，方便找回）。 */
export function clearLog() {
  if (!existsSync(FILE)) return { cleared: true, file: FILE, total: 0 };
  try {
    let total = 0;
    try { total = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).length; } catch {}
    try { renameSync(FILE, FILE + '.1'); } catch {}
    writeFileSync(FILE, '', 'utf8');
    return { cleared: true, file: FILE, archived: FILE + '.1', total };
  } catch (e) {
    return { cleared: false, file: FILE, error: String(e && e.message || e) };
  }
}
