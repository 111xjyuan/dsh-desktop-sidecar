// 给截图叠「编号框」（set-of-marks）：细框 + 左上角数字标签。
// 纯 JS 画像素，不依赖字体——数字用内置 3x5 点阵放大绘制。
const GLYPH = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
};

function ensureRgb(img) {
  if (img.rgb) return img;
  const ch = img.channels ?? 4;
  const src = img.data;
  const out = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    out[i * 3] = src[i * ch]; out[i * 3 + 1] = src[i * ch + 1]; out[i * 3 + 2] = src[i * ch + 2];
  }
  return { width: img.width, height: img.height, rgb: out };
}

function put(img, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 3;
  img.rgb[i] = r; img.rgb[i + 1] = g; img.rgb[i + 2] = b;
}

function fillRect(img, x, y, w, h, r, g, b) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(img, xx, yy, r, g, b);
}

function strokeRect(img, x, y, w, h, r, g, b, t = 2) {
  fillRect(img, x, y, w, t, r, g, b);
  fillRect(img, x, y + h - t, w, t, r, g, b);
  fillRect(img, x, y, t, h, r, g, b);
  fillRect(img, x + w - t, y, t, h, r, g, b);
}

/**
 * @param {{width:number,height:number,rgb:Buffer}} img
 * @param {{rect:{x:number,y:number,w:number,h:number}, label:string|number}[]} items
 * @param {{color?:[number,number,number], scale?:number}} opts
 */
export function annotate(img, items, opts = {}) {
  const out = { width: img.width, height: img.height, rgb: Buffer.from(ensureRgb(img).rgb) };
  const [r, g, b] = opts.color || [34, 211, 238];
  const scale = Math.max(1, Math.min(6, Math.round(opts.scale || 2)));
  const pad = 2;
  const cw = 3 * scale + pad * 2;
  const ch = 5 * scale + pad * 2;
  const placed = [];
  for (const it of items) {
    const x = Math.round(it.rect.x), y = Math.round(it.rect.y), w = Math.round(it.rect.w), h = Math.round(it.rect.h);
    if (w < 3 || h < 3) continue;
    strokeRect(out, x, y, w, h, r, g, b, 2);
    if (w < 10 || h < 8) continue;
    const label = String(it.label);
    const lw = cw * label.length;
    const lx = Math.max(0, Math.min(out.width - lw - 1, x));
    let ly = Math.max(0, y - ch - 1);
    // 标签互相压住时往上叠，读起来才不糊
    for (let guard = 0; guard < 6; guard++) {
      const clash = placed.find((q) => Math.abs(q.x - lx) < lw && Math.abs(q.y - ly) < ch);
      if (!clash) break;
      ly = Math.max(0, ly - ch - 1);
    }
    placed.push({ x: lx, y: ly });
    fillRect(out, lx, ly, lw, ch, 6, 12, 22);
    strokeRect(out, lx, ly, lw, ch, r, g, b, 1);
    for (let i = 0; i < label.length; i++) {
      const glyph = GLYPH[label[i]];
      if (!glyph) continue;
      const ox = lx + pad + i * (3 * scale + pad * 2);
      const oy = ly + pad;
      for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          if (glyph[gy][gx] === '1') fillRect(out, ox + gx * scale, oy + gy * scale, scale, scale, 255, 255, 255);
        }
      }
    }
  }
  return out;
}
