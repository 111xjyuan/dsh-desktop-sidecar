// lib/capture.mjs — 用 GDI BitBlt 抓屏并（可选）裁剪，返回 PNG Buffer
import koffi from 'koffi';
import { encodePng } from './png.mjs';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');

const GetDC = user32.func('__stdcall', 'GetDC', 'void *', ['void *']);
const ReleaseDC = user32.func('__stdcall', 'ReleaseDC', 'int', ['void *', 'void *']);
const CreateCompatibleDC = gdi32.func('__stdcall', 'CreateCompatibleDC', 'void *', ['void *']);
const CreateCompatibleBitmap = gdi32.func('__stdcall', 'CreateCompatibleBitmap', 'void *', ['void *', 'int', 'int']);
const SelectObject = gdi32.func('__stdcall', 'SelectObject', 'void *', ['void *', 'void *']);
const BitBlt = gdi32.func('__stdcall', 'BitBlt', 'int', ['void *', 'int', 'int', 'int', 'int', 'void *', 'int', 'int', 'uint32_t']);
const GetDIBits = gdi32.func('__stdcall', 'GetDIBits', 'int', ['void *', 'void *', 'uint32_t', 'uint32_t', 'void *', koffi.pointer('void *'), 'uint32_t']);
const DeleteObject = gdi32.func('__stdcall', 'DeleteObject', 'int', ['void *']);
const DeleteDC = gdi32.func('__stdcall', 'DeleteDC', 'int', ['void *']);

const SUF = '_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
const BITMAPINFOHEADER = koffi.struct('DSHBIH' + SUF, {
  biSize: 'uint32_t', biWidth: 'int32_t', biHeight: 'int32_t', biPlanes: 'uint16_t',
  biBitCount: 'uint16_t', biCompression: 'uint32_t', biSizeImage: 'uint32_t',
  biXPelsPerMeter: 'int32_t', biYPelsPerMeter: 'int32_t', biClrUsed: 'uint32_t', biClrImportant: 'uint32_t',
});
const BITMAPINFO = koffi.struct('DSHBMI' + SUF, { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32_t', 1) });

/** 抓取屏幕矩形区域，返回 { width, height, rgb }（24 位 RGB，行序自上而下） */
export function grabScreen(x, y, w, h) {
  const hwndDc = GetDC(null);
  if (!hwndDc) throw new Error('GetDC failed');
  const memDc = CreateCompatibleDC(hwndDc);
  const bmp = CreateCompatibleBitmap(hwndDc, w, h);
  const old = SelectObject(memDc, bmp);
  try {
    if (!BitBlt(memDc, 0, 0, w, h, hwndDc, x, y, 0x00CC0020)) throw new Error('BitBlt failed');
    const bih = { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
    const bmi = { bmiHeader: bih, bmiColors: [0] };
    const buf = Buffer.alloc(w * h * 4);
    const got = GetDIBits(memDc, bmp, 0, h, buf, koffi.as(bmi, koffi.pointer(BITMAPINFO)), 0);
    if (!got) throw new Error('GetDIBits failed');
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0, j = 0; i < buf.length; i += 4, j += 3) {
      rgb[j] = buf[i + 2]; rgb[j + 1] = buf[i + 1]; rgb[j + 2] = buf[i];
    }
    return { width: w, height: h, rgb };
  } finally {
    SelectObject(memDc, old);
    DeleteObject(bmp);
    DeleteDC(memDc);
    ReleaseDC(null, hwndDc);
  }
}

export function grabPng(x, y, w, h, maxDim) {
  let img = grabScreen(x, y, w, h);
  if (maxDim && Math.max(img.width, img.height) > maxDim) {
    const s = maxDim / Math.max(img.width, img.height);
    img = downscale(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
  }
  return { png: encodePng(img.width, img.height, img.rgb), width: img.width, height: img.height };
}

export function downscale(img, w, h) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w));
      const si = (sy * img.width + sx) * 3, di = (y * w + x) * 3;
      rgb[di] = img.rgb[si]; rgb[di + 1] = img.rgb[si + 1]; rgb[di + 2] = img.rgb[si + 2];
    }
  }
  return { width: w, height: h, rgb };
}

const PrintWindow = user32.func('__stdcall', 'PrintWindow', 'int', ['void *', 'void *', 'uint32_t']);
const GetWindowRectX = user32.func('__stdcall', 'GetWindowRect', 'int', ['void *', koffi.pointer('void *')]);

/** 用 PrintWindow 抓窗口本身（即使被其它窗口挡住），失败返回 null */
export function grabWindowPng(hwnd, maxDim) {
  const r = Buffer.alloc(16);
  if (!GetWindowRectX(hwnd, koffi.as(r, koffi.pointer('void *')))) return null;
  const left = r.readInt32LE(0), top = r.readInt32LE(4);
  const w = r.readInt32LE(8) - left, h = r.readInt32LE(12) - top;
  if (w <= 0 || h <= 0) return null;
  const screenDc = GetDC(null);
  const memDc = CreateCompatibleDC(screenDc);
  const bmp = CreateCompatibleBitmap(screenDc, w, h);
  const old = SelectObject(memDc, bmp);
  try {
    const ok = PrintWindow(hwnd, memDc, 0x00000002);
    if (!ok) return null;
    const bih = { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 };
    const bmi = { bmiHeader: bih, bmiColors: [0] };
    const buf = Buffer.alloc(w * h * 4);
    if (!GetDIBits(memDc, bmp, 0, h, buf, koffi.as(bmi, koffi.pointer(BITMAPINFO)), 0)) return null;
    let blank = true;
    for (let i = 0; i < buf.length; i += 4) { if (buf[i] || buf[i + 1] || buf[i + 2]) { blank = false; break; } }
    if (blank) return null;
    const rgb = Buffer.alloc(w * h * 3);
    for (let i = 0, j = 0; i < buf.length; i += 4, j += 3) { rgb[j] = buf[i + 2]; rgb[j + 1] = buf[i + 1]; rgb[j + 2] = buf[i]; }
    let img = { width: w, height: h, rgb };
    if (maxDim && Math.max(w, h) > maxDim) {
      const s = maxDim / Math.max(w, h);
      img = downscale(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
    }
    return { png: encodePng(img.width, img.height, img.rgb), width: img.width, height: img.height };
  } finally {
    SelectObject(memDc, old);
    DeleteObject(bmp);
    DeleteDC(memDc);
    ReleaseDC(null, screenDc);
  }
}