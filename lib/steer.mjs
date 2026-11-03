// 用户中途“插话指挥”的通道。
//
// 做法：在磁盘上放一个普通文本文件（默认 %LOCALAPPDATA%\dsh-sidecar\steer.txt），
// 用户用记事本随时打字保存；插件在长时间操作的每一步之间读它，看到新指令就立刻停下，
// 把指令交还给模型——模型据此修正，然后继续原来的工作。
// 为什么不用聊天窗口：模型在一轮任务里看不到用户新发的消息，只有把指令写进磁盘才来得及。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HEADER = [
  '你可以在这里随时写指令，我下一步就会看到。',
  '写完直接按 Ctrl+S 保存（不用关窗口）。',
  '我会执行完后把这行下面清空，方便你写下一句。',
  '------------------------------------------------------------',
  '',
].join('\r\n');

export function steerPath() {
  const base = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '.', 'AppData', 'Local');
  return path.join(base, 'dsh-sidecar', 'steer.txt');
}

export function ensureSteerFile() {
  const p = steerPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, HEADER, 'utf8');
  return p;
}

function bodyOf(text) {
  const t = String(text || '');
  const marker = '------------------------------------------------------------';
  const i = t.indexOf(marker);
  return (i >= 0 ? t.slice(i + marker.length) : t).replace(/^\s+/, '').trim();
}

let lastSeen = null;
let candidate = null;   // 正在稳定中的内容
let candidateSince = 0;

/** 读当前指令（去掉说明文字）。 */
export function readSteer() {
  const p = ensureSteerFile();
  try { return { ok: true, path: p, command: bodyOf(fs.readFileSync(p, 'utf8')) }; }
  catch (e) { return { ok: false, path: p, error: String(e.message || e) }; }
}

/**
 * 看有没有“新指令”：内容非空、和上次消费的不同、而且已经稳定一段时间
 * （避免用户还在打字时被打断一半）。
 */
export function pollSteer({ stableMs = 700 } = {}) {
  const r = readSteer();
  if (!r.ok || !r.command) return null;
  if (r.command === lastSeen) return null;
  // 用文件修改时间判断“用户是不是还在打字”：写完停手 stableMs 之后才算定稿。
  let age = stableMs;
  try { age = Date.now() - fs.statSync(r.path).mtimeMs; } catch {}
  if (age < stableMs) return null;
  lastSeen = r.command;
  return { command: r.command, path: r.path, at: Date.now(), ageMs: age };
}


/** 把一句话写进通道（界面面板和记事本两条路共用这一个写入口）。 */
export function writeSteer(text) {
  const p = ensureSteerFile();
  const cmd = String(text == null ? '' : text)
    .split(String.fromCharCode(13)).join(' ')
    .split(String.fromCharCode(10)).join(' ')
    .trim();
  if (!cmd) return { ok: false, path: p, error: 'empty command' };
  try {
    fs.writeFileSync(p, HEADER + cmd + String.fromCharCode(13, 10), 'utf8');
    lastSeen = null;          // 让 pollSteer 立刻认出新指令
    return { ok: true, path: p, command: cmd };
  } catch (e) {
    return { ok: false, path: p, error: String(e.message || e) };
  }
}

/** 消费掉当前指令：把文件恢复成只有说明文字。 */
export function clearSteer() {
  const p = ensureSteerFile();
  try { fs.writeFileSync(p, HEADER, 'utf8'); } catch { return { ok: false, path: p }; }
  return { ok: true, path: p };
}

/**
 * 让用户去写：打开一个**小块**记事本（右下角 520x240），而不是最大化窗口。
 * 用户嫌记事本一开就满屏、还要自己拖，所以这里替他把位置和大小摆好。
 */
export async function openSteer() {
  const p = ensureSteerFile();
  let win32 = null;
  try { win32 = await import('./win32.mjs'); } catch {}
  const before = new Set((win32 ? win32.listWindows({ minW: 0, minH: 0 }) : []).map((w) => w.hwnd));
  try {
    const c = spawn('notepad.exe', [p], { detached: true, stdio: 'ignore', windowsHide: false });
    c.on('error', () => {});
    c.unref();
  } catch (e) {
    return { ok: false, path: p, opened: false, error: String(e.message || e), hint: '自己用记事本打开这个文件也可以。' };
  }
  let placed = false;
  if (win32) {
    const W = 520, H = 236;
    for (let i = 0; i < 25 && !placed; i++) {
      await new Promise((r) => setTimeout(r, 120));
      let hit = null;
      try {
        hit = win32.listWindows({ minW: 0, minH: 0 })
          .filter((w) => !before.has(w.hwnd) && /notepad/i.test(String(w.app)) && /steer\.txt/i.test(String(w.title)))
          .pop();
      } catch {}
      if (!hit) {
        // 新窗口没出现也没关系：可能是在已有的记事本窗口里换了标签
        try {
          hit = win32.listWindows({ minW: 0, minH: 0 })
            .filter((w) => /notepad/i.test(String(w.app)) && /steer[.]txt/i.test(String(w.title)))
            .pop() || null;
        } catch {}
      }
      if (!hit) continue;
      try {
        const mon = win32.monitors ? win32.monitors() : null;
        const work = (mon && mon[0] && mon[0].work) || { x: 0, y: 0, w: 1920, h: 1040 };
        const x = work.x + work.w - W - 24;
        const y = work.y + work.h - H - 132;
        win32.windowAction(hit.hwnd, 'move', { x, y, w: W, h: H });
        win32.focusWindowForce(hit.hwnd);
        placed = true;
        return { ok: true, path: p, opened: true, hwnd: hit.hwnd, placed: true, size: { w: W, h: H } };
      } catch {}
    }
  }
  return { ok: true, path: p, opened: true, placed };
}

export function _resetSteer() { lastSeen = null; candidate = null; candidateSince = 0; }
