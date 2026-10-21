// png.mjs — minimal PNG decode/encode (8-bit RGB/RGBA, non-interlaced) + crop/scale.
// Used to turn one fast desktop capture into many small window shots.
import { inflateSync, deflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0, height = 0, colorType = 6, bitDepth = 8;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced png unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported png format');
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]; rp += 1;
    const row = raw.subarray(rp, rp + stride); rp += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function crop(img, x, y, w, h) {
  const ch = img.channels;
  const x0 = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(img.width - x0, Math.round(w)));
  const chh = Math.max(1, Math.min(img.height - y0, Math.round(h)));
  const out = Buffer.alloc(cw * chh * 3);
  for (let yy = 0; yy < chh; yy += 1) {
    for (let xx = 0; xx < cw; xx += 1) {
      const s = ((y0 + yy) * img.width + (x0 + xx)) * ch;
      const d = (yy * cw + xx) * 3;
      out[d] = img.data[s];
      out[d + 1] = img.data[s + 1];
      out[d + 2] = img.data[s + 2];
    }
  }
  return { width: cw, height: chh, rgb: out };
}

export function downscale(img, maxDim) {
  const { width, height, rgb } = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  if (scale >= 1) return img;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const ch = img.channels ?? 4;
  const src = img.data ?? img.rgb;
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const s = (sy * width + sx) * 3;
      const d = (y * w + x) * 3;
      out[d] = rgb[s];
      out[d + 1] = rgb[s + 1];
      out[d + 2] = rgb[s + 2];
    }
  }
  return { width: w, height: h, rgb: out };
}

/** 最近邻放大（用于给小字 OCR 前提高分辨率）；支持小数倍率，实际尺寸四舍五入 */
export function scaleNear(img, factor) {
  const f = Math.max(1, Number(factor) || 1);
  const w = Math.max(1, Math.round(img.width * f));
  const h = Math.max(1, Math.round(img.height * f));
  const ch = img.channels ?? 4;
  const src = img.data ?? img.rgb;
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const si = (sy * img.width + sx) * ch, di = (y * w + x) * 3;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2];
    }
  }
  return { width: w, height: h, rgb: out };
}
/** 灰度 + 直方图拉伸（提升浅色小字在深色背景上的 OCR 命中率） */
export function contrastGray(img) {
  const ch = img.channels ?? 4;
  const src = img.data ?? img.rgb;
  const n = img.width * img.height;
  const g = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) {
    const si = i * ch;
    const v = Math.round(0.299 * src[si] + 0.587 * src[si + 1] + 0.114 * src[si + 2]);
    g[i] = v; hist[v]++;
  }
  let lo = 0, hi = 255, acc = 0;
  const p2 = n * 0.02, p98 = n * 0.98;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p2) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n - p98) { hi = v; break; } }
  if (hi <= lo) { hi = 255; lo = 0; }
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Math.min(255, Math.round(((g[i] - lo) * 255) / (hi - lo))));
    out[i * 3] = v; out[i * 3 + 1] = v; out[i * 3 + 2] = v;
  }
  return { width: img.width, height: img.height, rgb: out, channels: 3 };
}