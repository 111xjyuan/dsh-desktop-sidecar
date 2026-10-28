// 按键写法解析：enter / ctrl+shift+s / f5 / 单个符号键（+ - * / 等）
//
// 坑：'a+b'.split('+') 对加号本身没法表达。单独一个 '+' 要能当加号键，
// 'ctrl++' 也要表示 Ctrl+加号（很多应用的放大快捷键）。这里的规则：
//   1. 长度为 1 的输入＝单个键（含 '+'）；
//   2. 否则按 '+' 拆分，空段丢弃，最后一段是主键；若以 '+' 结尾则主键就是加号。
const MAP = {
  enter: 0x0d, return: 0x0d, esc: 0x1b, escape: 0x1b, tab: 0x09, space: 0x20,
  backspace: 0x08, bksp: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, slash: 0xbf,
  backslash: 0xdc, semicolon: 0xba, quote: 0xde, backquote: 0xc0, equals: 0xbb,
};

const SYMBOL_VK = { '+': 0xbb, '-': 0xbd, '*': 0x6a, '/': 0xbf, '=': 0xbb, '.': 0xbe, ',': 0xbc, ';': 0xba, '`': 0xc0, '\\': 0xdc };

// 美式/中文键盘上 '+' 是 Shift+'='，只按 0xbb 会打出 '='。这些键要自动补 Shift。
const NEEDS_SHIFT = new Set(['+', 'plus']);

function vkOf(name) {
  const low = String(name).toLowerCase();
  if (MAP[low] !== undefined) return MAP[low];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(low)) return 0x6f + Number(low.slice(1));
  if (/^[a-z]$/.test(low)) return low.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(low)) return low.charCodeAt(0);
  if (SYMBOL_VK[low] !== undefined) return SYMBOL_VK[low];
  return 0;
}

export function parseKeyChord(rawKey) {
  const raw = String(rawKey ?? '').trim();
  if (!raw) throw new Error('empty key');

  if (raw.length === 1) {
    const vk = vkOf(raw);
    if (!vk) throw new Error('unknown key: ' + raw);
    const mods = NEEDS_SHIFT.has(raw.toLowerCase()) ? ['shift'] : [];
    return { vk, mods, key: raw };
  }

  const mainIsPlus = raw.length > 1 && raw.endsWith('++');
  const body = mainIsPlus ? raw.slice(0, -2) : raw;
  const parts = body.split('+').map((x) => x.trim()).filter((x) => x !== '');
  let main = mainIsPlus ? '+' : parts.pop();
  if (main === undefined) {
    if (!raw.endsWith('+')) throw new Error('unknown key: ' + raw);
    main = '+';
  }
  const mods = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'ctrl' || low === 'control') mods.push('ctrl');
    else if (low === 'shift') mods.push('shift');
    else if (low === 'alt') mods.push('alt');
    else if (low === 'win' || low === 'meta' || low === 'cmd') mods.push('win');
    else throw new Error('unknown modifier: ' + p + ' in ' + raw);
  }
  const vk = vkOf(main);
  if (!vk) throw new Error('unknown key: ' + main);
  if (NEEDS_SHIFT.has(String(main).toLowerCase()) && !mods.includes('shift')) mods.push('shift');
  return { vk, mods, key: main };
}
