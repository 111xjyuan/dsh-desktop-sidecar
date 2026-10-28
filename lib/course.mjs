// lib/course.mjs — 平台无关的网课引擎：帧差判播 + 词表切节 + 弹题四档
import { createHash } from 'node:crypto';
import { grabWindowPng, grabPng } from './capture.mjs';
import { decodePng, crop } from './png.mjs';
import { ocrBuffer, findLine } from './ocr.mjs';
import { listWindows, clientInfo, screenClick, focusWindow } from './win32.mjs';

const NEXT_DEFAULT = ['下一节', '下一集', '下一个', '下一课', '下一章', '下一讲', '继续学习', '下一部分'];
const QUIZ_WORDS = ['单选题', '多选题', '判断题', '随堂练习', '提交答案', '课堂练习', '测验'];
const DONE_WORDS = ['已完成', '播放结束', '重新播放', '已学完'];

function capWindow(hwnd, maxDim) {
  const pw = grabWindowPng(hwnd, maxDim);
  if (pw) return pw;
  try { const inf = clientInfo(hwnd); return grabPng(inf.clientOrigin.x, inf.clientOrigin.y, inf.client.width, inf.client.height, maxDim); } catch { return null; }
}

function hashRegion(hwnd, info) {
  const cap = capWindow(hwnd, 0);
  if (!cap) return { hash: null, reason: 'capture failed' };
  const img = decodePng(cap.png);
  const x = Math.round(img.width * 0.24), y = Math.round(img.height * 0.10);
  const w = Math.round(img.width * 0.48), h = Math.round(img.height * 0.32);
  const part = crop(img, x, y, w, h);
  const h2 = createHash('sha1').update(part.rgb || part.data || Buffer.alloc(0)).digest('hex').slice(0, 16);
  return { hash: h2, w: img.width, h: img.height };
}

export async function courseTick(opts) {
  const { hwnd, rounds = 5, interval = 4000, onQuiz = 'ask', nextWords, dryRun = false, onRound, cancelled } = opts || {};
  if (!hwnd) throw new Error('courseTick requires hwnd');
  const words = Array.isArray(nextWords) && nextWords.length ? nextWords : NEXT_DEFAULT;
  const log = [];
  let prev = null;
  let lastText = null;
  let stoppedByUser = false;
  for (let i = 0; i < rounds; i++) {
    if (cancelled && cancelled()) { stoppedByUser = true; break; }
    if (onRound) { try { onRound(i + 1, rounds); } catch {} }
    const h = hashRegion(hwnd);
    const playing = prev && h.hash && h.hash !== prev;
    prev = h.hash;
    const cap = capWindow(hwnd, 1400);
    let quiz = null, next = null, done = null;
    if (cap) {
      const r = ocrBuffer(cap.png, { scale: 1.3, prep: true });
      const lines = r.lines || r.words || [];
      lastText = lines.slice(0, 40).map((l) => l.text).join('\n');
      quiz = lines.find((l) => QUIZ_WORDS.some((w) => l.text.includes(w))) || null;
      for (const w of words) { const hit = findLine(r, w, { minSim: 0.62 }); if (hit) { next = hit; break; } }
      done = lines.find((l) => DONE_WORDS.some((w) => l.text.includes(w))) || null;
    }
    const entry = { round: i + 1, playing: !!playing, hash: h.hash };
    if (quiz) { entry.quiz = { text: quiz.text, onQuiz }; }
    if (done) entry.done = done.text;
    if (next && !quiz) entry.next = next.text;
    log.push(entry);
    if (dryRun) continue;
    if (quiz && onQuiz === 'skip') { const inf = clientInfo(hwnd); screenClick(inf.clientOrigin.x + Math.round(inf.client.width * 0.78), inf.clientOrigin.y + Math.round(inf.client.height * 0.22)); entry.action = 'quiz-closed'; }
    else if (quiz && onQuiz === 'pause') { entry.action = 'paused-for-user'; break; }
    else if (!playing && !quiz) { const inf = clientInfo(hwnd); focusWindow(hwnd); screenClick(inf.clientOrigin.x + Math.round(inf.client.width * 0.45), inf.clientOrigin.y + Math.round(inf.client.height * 0.26)); entry.action = 'resume-click'; }
    else if (next && playing === false) { entry.action = 'next-click'; const inf = clientInfo(hwnd); screenClick(Math.round(inf.clientOrigin.x + next.x), Math.round(inf.clientOrigin.y + next.y)); }
    if (i < rounds - 1) await new Promise((r) => setTimeout(r, interval));
  }
  return { ok: true, rounds, executedRounds: log.length, stoppedByUser, onQuiz, log, tailText: lastText };
}
