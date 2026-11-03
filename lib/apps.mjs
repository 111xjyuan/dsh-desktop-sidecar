// 启动程序时"别靠猜"：把口语名（微信/QQ/计算器）或裸 exe 名解析成真实路径。
//
// 为什么需要：Windows 上同一个软件装在哪都有可能 —— 这台机器的微信在
//   D:\微信\Weixin\Weixin.exe
// 而不是 Program Files。以前直接 spawn "WeChat.exe"，系统找不到就静默失败，
// 调用方只能等满超时（实测白等 20 秒）。这里先把名字解析成路径，解析不到就
// 立刻把候选还给调用方，让模型一次就能改对。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 口语名 → 真实的 exe 名 + 线索（用来判断哪个目录像它）。 */
export const APP_HINTS = {
  '微信': { exe: ['Weixin.exe', 'WeChat.exe'], dirs: /微信|weixin|wechat/i },
  'weixin': { exe: ['Weixin.exe', 'WeChat.exe'], dirs: /微信|weixin|wechat/i },
  'wechat': { exe: ['Weixin.exe', 'WeChat.exe'], dirs: /微信|weixin|wechat/i },
  'qq': { exe: ['QQ.exe', 'QQScLauncher.exe'], dirs: /^(qq|腾讯|tencent)/i },
  'tim': { exe: ['TIM.exe'], dirs: /^(tim|腾讯|tencent)/i },
  '钉钉': { exe: ['DingTalk.exe'], dirs: /钉钉|dingtalk/i },
  'dingtalk': { exe: ['DingTalk.exe'], dirs: /钉钉|dingtalk/i },
  '飞书': { exe: ['Feishu.exe', 'Lark.exe'], dirs: /飞书|feishu|lark/i },
  'feishu': { exe: ['Feishu.exe', 'Lark.exe'], dirs: /飞书|feishu|lark/i },
  '企业微信': { exe: ['WXWork.exe'], dirs: /企业微信|wxwork|wecom/i },
  '网易云音乐': { exe: ['cloudmusic.exe'], dirs: /网易云|cloudmusic/i },
  'steam': { exe: ['steam.exe'], dirs: /^steam$/i },
  'obs': { exe: ['obs64.exe', 'obs32.exe'], dirs: /^obs/i },
  'vscode': { exe: ['Code.exe'], dirs: /^(microsoft )?vs ?code|vscode/i },
  'code': { exe: ['Code.exe'], dirs: /^(microsoft )?vs ?code|vscode/i },
  'word': { exe: ['WINWORD.EXE'], dirs: /microsoft office/i },
  'excel': { exe: ['EXCEL.EXE'], dirs: /microsoft office/i },
  'ppt': { exe: ['POWERPNT.EXE'], dirs: /microsoft office/i },
  'wps': { exe: ['wps.exe'], dirs: /wps/i },
};

const SKIP_DIR = /^(windows|winsxs|system32|syswow64|driverstore|servicing|assembly|installer|temp|tmp|node_modules|\.git|appdata|default|programdata)$/i;

function whereExe(name) {
  try {
    const out = execFileSync('where.exe', [name], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).find((s) => /\.exe$/i.test(s));
    if (first && fs.existsSync(first)) return first;
  } catch { /* 不在 PATH 里 */ }
  return null;
}

function roots() {
  const env = process.env;
  const out = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs') : null,
    env.ProgramData,
  ].filter(Boolean);
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    const p = drive + String.fromCharCode(92);
    try { if (fs.existsSync(p)) out.push(p); } catch { /* 光驱等 */ }
  }
  return Array.from(new Set(out));
}

/** 在候选目录里找目标 exe；只往下两层，并限制访问的目录数，避免拖慢启动。 */
function scanForExe(exeNames, dirHint, budgetMs = 1200) {
  const want = exeNames.map((s) => s.toLowerCase());
  const t0 = Date.now();
  let visited = 0;
  const hits = [];
  const seenDir = new Set();

  const listDirs = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch { return []; }
  };

  const look = (dir, depth) => {
    if (Date.now() - t0 > budgetMs || visited > 900) return;
    if (seenDir.has(dir)) return;
    seenDir.add(dir);
    visited++;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile()) {
        if (want.includes(e.name.toLowerCase())) hits.push(path.join(dir, e.name));
      }
    }
    if (depth <= 0) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIR.test(e.name)) continue;
      // 一层：可能是「微信」这种装了一层的；二层：微信\Weixin\Weixin.exe
      if (dirHint && depth === 2 && !dirHint.test(e.name)) continue;
      look(path.join(dir, e.name), depth - 1);
    }
  };

  for (const root of roots()) look(root, 2);
  return hits;
}

/**
 * 把用户写的启动名解析成真实 exe 路径。
 * @returns {{path?: string, candidates?: string[], how?: string, bare?: string}}
 */
export function resolveAppTarget(spec, { budgetMs = 1200 } = {}) {
  const raw = String(spec || '').trim();
  if (!raw) return {};
  const key = raw.toLowerCase().replace(/\.exe$/i, '');
  const hint = APP_HINTS[raw] || APP_HINTS[key] || null;
  const exeNames = hint ? hint.exe : [raw.toLowerCase().endsWith('.exe') ? raw : raw + '.exe'];

  // 1) PATH / App Paths —— notepad、calc 这类系统自带的一条命令就够
  for (const name of exeNames) {
    const hit = whereExe(name);
    if (hit) return { path: hit, how: 'where' };
  }

  // 2) 扫盘（有线索才扫，免得为了一个不存在的名字翻遍所有磁盘）
  if (hint) {
    const hits = scanForExe(exeNames, hint.dirs || hint.dir, budgetMs);
    if (hits.length) {
      // 优先非升级/备份目录里的那份
      const good = hits.find((p) => !/installer|uninstall|backup|old|update/i.test(p)) || hits[0];
      return { path: good, how: 'scan', candidates: hits.slice(0, 6) };
    }
  }

  // 3) 找不到：把"看起来像它"的目录列出来，比一句 not found 有用
  const candidates = [];
  const t0 = Date.now();
  try {
    const guess = exeNames[0].replace(/\.exe$/i, '').slice(0, 4);
    for (const root of roots()) {
      if (Date.now() - t0 > 900) break;
      for (const d of listDirsSafe(root)) {
        if (guess.length >= 3 && !new RegExp(guess.replace(/[^\w一-龥]/g, ''), 'i').test(d)) continue;
        candidates.push(path.join(root, d));
        if (candidates.length >= 6) break;
      }
    }
  } catch { /* 只是提示，失败无所谓 */ }
  return { candidates, bare: raw };
}

function listDirsSafe(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
}
