import { fileURLToPath } from 'node:url';
// OCR 封装：直接复用 dsh-screenshot-xn 自带的 Windows.Media.Ocr 脚本（零下载、离线、支持中文）。
// 输出统一成 { text, lines: [{ text, x, y, w, h }] }，坐标是输入图片的像素坐标。
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { decodePng, encodePng, scaleNear, contrastGray } from './png.mjs';

const OCR_PS1 = fileURLToPath(new URL('./ocr.ps1', import.meta.url));
const PS_CANDIDATES = [process.env.SystemRoot && ((process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')), 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'];
let PS = null;
function resolvePs() {
  if (PS) return PS;
  for (const c of PS_CANDIDATES) { if (c && existsSync(c)) { PS = c; return PS; } }
  const probe = spawnSync('where', ['powershell.exe'], { encoding: 'utf8' });
  PS = (probe.stdout || '').split(/\\r?\\n/)[0].trim() || 'powershell.exe';
  return PS;
}

/** CJK 词之间不要空格 */
export function joinWords(words) {
  return words.reduce((acc, w) => {
    const t = String(w.text ?? '');
    if (!t) return acc;
    const prev = acc.slice(-1);
    const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
    if (prev && cjk.test(prev) && cjk.test(t[0])) return acc + t;
    if (!prev) return t;
    return acc + ' ' + t;
  }, '');
}

export function ocrFile(path, { language = 'zh-Hans', timeout = 20000, scale = 1, prep = true } = {}) {
  // 总是 decode → 放大(可选) → 重编码到 %TEMP% 再 OCR：
  //  ① WinRT BitmapDecoder 对某些目录下的原图会报 "image could not be decoded"（实测 D:\ 工作区），
  //     统一走 TEMP 可绕开；② 坐标反算比例必须用"实际"放大比（整数取整/四舍五入后与 scale 不同）。
  const img = decodePng(readFileSync(path));
  const s = Number(scale) > 1 ? Number(scale) : 1;
  const up = scaleNear(img, s);
  const dir = mkdtempSync(join(tmpdir(), 'cue-ocr-up-'));
  try {
    const src = join(dir, 'up.png');
    writeFileSync(src, encodePng(up.width, up.height, up.rgb));
    const kx = img.width / up.width;
    const ky = img.height / up.height;
    const res = ocrFileRaw(src, { language, timeout });
    for (const l of res.lines) { l.x *= kx; l.y *= ky; l.w *= kx; l.h *= ky; }
    res.ocrImage = { width: up.width, height: up.height };
    res.image = { width: img.width, height: img.height };
    return res;
  } finally {
    // 立即删除：临时目录里是整屏截图，留着既有磁盘泄漏也有隐私风险（issue #2）
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function ocrFileRaw(path, { language = 'zh-Hans', timeout = 20000 } = {}) {
  const started = Date.now();
  const r = spawnSync(resolvePs(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-Path', path, '-Language', language], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  const out = String(r.stdout ?? '');
  const m = out.match(/---JSON-BEGIN---([\s\S]*?)---JSON-END---/);
  if (!m) throw new Error('ocr failed: ' + (r.stderr || out).slice(0, 300));
  const j = JSON.parse(m[1]);
  if (!j.ok) {
    // 语言包缺失时自动回退到本机已安装的语言，避免"换台电脑就不能用"
    const miss = String(j.error || '').match(/no OCR language pack for '([^']+)'; installed: ([^,\n]+)/);
    if (miss) {
      const installed = miss[2].trim();
      if (installed && installed.toLowerCase() !== String(language).toLowerCase()) {
        return ocrFileRaw(path, { language: installed, timeout });
      }
    }
    throw new Error('ocr not ok: ' + (j.error || 'unknown'));
  }
  const lines = (j.lines ?? []).map((ln) => {
    const words = ln.words ?? [];
    const x = Math.min(...words.map((w) => w.x), Infinity);
    const y = Math.min(...words.map((w) => w.y), Infinity);
    const x2 = Math.max(...words.map((w) => w.x + w.width), -Infinity);
    const y2 = Math.max(...words.map((w) => w.y + w.height), -Infinity);
    return { text: joinWords(words), x, y, w: x2 - x, h: y2 - y };
  }).filter((l) => l.text.trim());
  return {
    text: lines.map((l) => l.text).join('\n'),
    lines,
    language: j.language,
    image: { width: j.image_width, height: j.image_height },
    ocrMs: j.elapsed_ms,
    totalMs: Date.now() - started,
  };
}

export function ocrBuffer(png, opts) {
  const dir = mkdtempSync(join(tmpdir(), 'cue-ocr-'));
  try {
    const f = join(dir, 'shot.png');
    writeFileSync(f, png);
    return ocrFile(f, opts);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 清理历史遗留的 OCR 临时目录（旧版本泄漏的 cue-ocr-* / cue-ocr-up-*）。
 * 只删超过 maxAgeMs 的，避免误删别的进程正在用的目录。
 */
export function sweepOcrTemps(maxAgeMs = 3600_000) {
  let removed = 0;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith('cue-ocr-')) continue;
      const p = join(tmpdir(), name);
      try {
        const st = statSync(p);
        if (!st.isDirectory()) continue;
        if (Date.now() - st.mtimeMs < maxAgeMs) continue;
        rmSync(p, { recursive: true, force: true });
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
}

/** 在结果里找包含 needle 的行（不区分大小写，允许去空格匹配） */
export function normConf(s) {
  const CONF = { '额': '数', '額': '数', '貊': '据', '袤': '表', '榈': '树', '笥': '结', '枥': '构', '甙': '式', '丌': '开', '仝': '全', '囗': '口', '菘': '随', '隨': '随', '〇': '0', 'О': '0', 'Ｏ': '0', 'ｌ': '1', '丨': '1', '數': '数', '據': '据', '結': '结', '構': '构', '掏': '构', '統': '统', '訊': '讯', '隨': '随', '學': '学', '點': '点', '規': '规', '則': '则' };
  const m = String(s).toLowerCase().replace(/\s+/g, '');
  let out = '';
  for (const ch of m) out += CONF[ch] ?? ch;
  return out;
}

export function findLine(result, needle, opts = {}) {
  const want = normConf(needle);
  if (!want) return null;
  const cands = result.lines.map((l) => ({ l, k: normConf(l.text) }));
  const exact = cands.find((c) => c.k === want);
  if (exact) return exact.l;
  const part = cands.filter((c) => c.k.includes(want) || want.includes(c.k)).sort((x, y) => (x.k.length - want.length) - (y.k.length - want.length) || x.l.y - y.l.y)[0];
  if (part) return part.l;
  const sim = (a, b) => { const A = new Set(a), B = new Set(b); let h = 0; for (const x of A) if (B.has(x)) h++; return h / Math.max(A.size, B.size || 1); };
  const best = cands.map((c) => ({ c, s: sim(c.k, want), d: Math.abs(c.k.length - want.length) })).sort((x, y) => y.s - x.s || x.d - y.d)[0];
  if (best && best.s >= (opts.minSim ?? 0.6)) return best.c.l;
  return null;
}

const isCli = !!process.argv[1] && import.meta.url.toLowerCase().endsWith(process.argv[1].replace(/\\/g, "/").toLowerCase());
if (isCli && process.argv[2]) {
  const res = ocrFile(process.argv[2]);
  console.log(JSON.stringify({ text: res.text, count: res.lines.length, ocrMs: res.ocrMs, totalMs: res.totalMs, lines: res.lines.slice(0, 20) }, null, 1));
}
