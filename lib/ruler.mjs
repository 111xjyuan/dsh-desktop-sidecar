// 在截图上叠加坐标尺：顶部标 x（客户区像素），左侧标 y。
// 目的：模型看到图就能直接读坐标，不必自己按缩放换算；图片被压缩/缩放后仍然可用。
const FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

function px(img, x, y, r, g, b, alpha = 1) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 3;
  if (alpha >= 1) { img.rgb[i] = r; img.rgb[i + 1] = g; img.rgb[i + 2] = b; return; }
  img.rgb[i] = Math.round(img.rgb[i] * (1 - alpha) + r * alpha);
  img.rgb[i + 1] = Math.round(img.rgb[i + 1] * (1 - alpha) + g * alpha);
  img.rgb[i + 2] = Math.round(img.rgb[i + 2] * (1 - alpha) + b * alpha);
}

function hline(img, x0, x1, y, r, g, b) { for (let x = x0; x <= x1; x++) px(img, x, y, r, g, b); }
function vline(img, x, y0, y1, r, g, b) { for (let y = y0; y <= y1; y++) px(img, x, y, r, g, b); }
function rect(img, x, y, w, h, r, g, b) {
  hline(img, x, x + w - 1, y, r, g, b); hline(img, x, x + w - 1, y + h - 1, r, g, b);
  vline(img, x, y, y + h - 1, r, g, b); vline(img, x + w - 1, y, y + h - 1, r, g, b);
}

function drawText(img, str, x0, y0, scale, r, g, b) {
  let cx = x0;
  for (const ch of String(str)) {
    const g5 = FONT[ch];
    if (!g5) { cx += 4 * scale; continue; }
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (g5[row][col] === '1') {
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px(img, cx + col * scale + dx, y0 + row * scale + dy, r, g, b);
        }
      }
    }
    cx += 4 * scale;
  }
  return cx;
}

/**
 * @param {{width:number,height:number,rgb:Buffer}} img 待叠加的图像（会原地修改）
 * @param {{scaleX:number, scaleY:number, step?:number, labelEvery?:number}} opt
 *        scaleX/scaleY = 客户区像素 / 图像像素（图像被 downscale 时 > 1）
 */
export function drawRuler(img, { scaleX = 1, scaleY = 1, step = 100, labelEvery = 200 } = {}) {
  const S = 2; // 字号倍数
  const labelW = 26, labelH = 12;
  const dark = [18, 22, 30], light = [255, 214, 102], tick = [255, 214, 102];
  // 顶部刻度
  for (let x = 0; x < img.width; x += step) {
    const major = x % labelEvery === 0;
    vline(img, x, 0, major ? 14 : 7, ...tick);
  }
  // 左侧刻度
  for (let y = 0; y < img.height; y += step) {
    const major = y % labelEvery === 0;
    hline(img, 0, major ? 14 : 7, y, ...tick);
  }
  // 顶部数值（客户区坐标）
  for (let x = labelEvery; x < img.width; x += labelEvery) {
    const label = String(Math.round(x * scaleX));
    const w = label.length * 4 * S + 4;
    rect(img, x - 1, 1, w, labelH, ...dark);
    drawText(img, label, x + 1, 3, S, ...light);
  }
  // 左侧数值
  for (let y = labelEvery; y < img.height; y += labelEvery) {
    const label = String(Math.round(y * scaleY));
    rect(img, 1, y - 1, labelW, labelH, ...dark);
    drawText(img, label, 3, y + 1, S, ...light);
  }
  // 左上角底块，避免刻度与内容混淆
  rect(img, 0, 0, labelW, labelH, ...dark);
  return img;
}
