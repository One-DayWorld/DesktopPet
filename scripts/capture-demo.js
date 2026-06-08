// 离屏渲染 VF-1 → 逐帧抓取 → 纯 JS 编码 GIF。一次性资产生成工具, 不进 App 主流程。
// 用法:  npm install --no-save gifenc  &&  ./node_modules/.bin/electron scripts/capture-demo.js
// 产物:  docs/demo.gif
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const W = 480, H = 380;
const FRAMES = 48;          // 帧数
const DELAY_MS = 70;        // 每帧间隔 (~14fps, 48*70≈3.4s 循环)
const OUT = path.join(__dirname, '..', 'docs', 'demo.gif');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.disableHardwareAcceleration; // no-op safety; offscreen 仍走 GPU

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: W, height: H,
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true }
  });
  win.webContents.setFrameRate(30);
  await win.loadFile(path.join(__dirname, 'demo.html'));

  // 等模型加载完成 (demo.html 里 window.__ready)
  try {
    await win.webContents.executeJavaScript('window.__ready.then(() => true)');
  } catch (e) {
    console.error('[GIF] 模型加载失败:', e.message);
    app.exit(1); return;
  }

  console.log(`[GIF] 开始抓取 ${FRAMES} 帧 @ ${W}x${H} ...`);
  const gif = GIFEncoder();
  let format = null;

  for (let i = 0; i < FRAMES; i++) {
    const t = i / FRAMES;
    await win.webContents.executeJavaScript(`window.__render(${t})`);
    await sleep(60);                       // 给 offscreen 合成留时间
    const img = await win.webContents.capturePage();
    const { width: cw, height: ch } = img.getSize();   // Retina 下通常是 2x
    const bgra = img.toBitmap();                       // Electron: BGRA 原始像素
    // BGRA → RGBA (不透明)
    const full = new Uint8Array(cw * ch * 4);
    for (let p = 0; p < full.length; p += 4) {
      full[p]     = bgra[p + 2];
      full[p + 1] = bgra[p + 1];
      full[p + 2] = bgra[p];
      full[p + 3] = 255;
    }
    // 降采样到目标宽度 (整数倍 box 平均), 控制 GIF 体积
    const f = Math.max(1, Math.round(cw / W));
    const dw = Math.floor(cw / f), dh = Math.floor(ch / f);
    let rgba, width, height;
    if (f > 1) {
      rgba = new Uint8Array(dw * dh * 4); width = dw; height = dh;
      for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
        let r = 0, g = 0, b = 0;
        for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) {
          const sp = ((y * f + yy) * cw + (x * f + xx)) * 4;
          r += full[sp]; g += full[sp + 1]; b += full[sp + 2];
        }
        const n = f * f, dp = (y * dw + x) * 4;
        rgba[dp] = r / n; rgba[dp + 1] = g / n; rgba[dp + 2] = b / n; rgba[dp + 3] = 255;
      }
    } else { rgba = full; width = cw; height = ch; }
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, width, height, { palette, delay: DELAY_MS });
    if (!format) format = `${width}x${height}`;
    if (i % 8 === 0) console.log(`[GIF]   ${i + 1}/${FRAMES}`);
  }

  gif.finish();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, gif.bytes());
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`[GIF] ✓ 写出 ${OUT}  (${format}, ${FRAMES} 帧, ${kb} KB)`);
  app.exit(0);
});
