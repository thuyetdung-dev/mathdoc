// Load PDF/images into page canvases; crop figures.
import * as pdfjsLib from 'pdfjs-dist';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs';
import { figureBounds } from './trim.js';

let workerReady = false;
function ensureWorker() {
  if (workerReady) return;
  // Run the PDF parser on the main thread: works both from file:// and from a web host.
  globalThis.pdfjsWorker = pdfjsWorker;
  workerReady = true;
}

export async function openPdf(file) {
  ensureWorker();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjsLib.getDocument({ data }).promise;
  return doc;
}

export async function renderPdfPage(doc, n, targetWidth = 2000) {
  const page = await doc.getPage(n);
  const vp0 = page.getViewport({ scale: 1 });
  const scale = targetWidth / vp0.width;
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  return c;
}

export function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error('Không đọc được ' + file.name));
    r.readAsDataURL(file);
  });
}

export function imageFileToCanvas(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      res(c);
    };
    img.onerror = () => rej(new Error('Không mở được ảnh ' + file.name));
    img.src = url;
  });
}

export function canvasToJpeg(c, maxSide = 1400, q = 0.85) {
  const s = Math.min(1, maxSide / Math.max(c.width, c.height));
  if (s >= 1) return c.toDataURL('image/jpeg', q);
  const d = document.createElement('canvas');
  d.width = Math.round(c.width * s); d.height = Math.round(c.height * s);
  const ctx = d.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, d.width, d.height);
  return d.toDataURL('image/jpeg', q);
}

/** box: [ymin,xmin,ymax,xmax] in 0..1000. Returns {dataUrl,w,h,frac} or null. */
export function cropBox(page, box, pad = 0.015) {
  let [y0, x0, y1, x1] = box.map(v => Math.min(1000, Math.max(0, v)) / 1000);
  if (y1 < y0) [y0, y1] = [y1, y0];
  if (x1 < x0) [x0, x1] = [x1, x0];
  y0 = Math.max(0, y0 - pad); x0 = Math.max(0, x0 - pad); y1 = Math.min(1, y1 + pad); x1 = Math.min(1, x1 + pad);
  const W = page.width, H = page.height;
  let sx = Math.round(x0 * W), sy = Math.round(y0 * H), sw = Math.round((x1 - x0) * W), sh = Math.round((y1 - y0) * H);
  if (sw < 16 || sh < 16) return null;
  // bỏ lề trắng và những dòng chữ của đề dính vào mép vùng cắt
  const ctx = page.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(sx, sy, sw, sh).data;
  let ink = 0;
  for (let o = 0; o < d.length; o += 4) if (d[o] * 0.2126 + d[o + 1] * 0.7152 + d[o + 2] * 0.0722 < 235) ink++;
  if (ink / (sw * sh) < 0.0007) return null;
  const fb = figureBounds(d, sw, sh, W);
  if (!fb) return null;
  const minX = fb.x0, minY = fb.y0, maxX = fb.x1, maxY = fb.y1;
  // chừa lề trắng bằng cách vẽ hình lên nền trắng (không lấy lại phần trang quanh hình, tránh dính lại chữ thừa)
  const m = Math.round(Math.max(W, H) * 0.006);
  const iw = maxX - minX + 1, ih = maxY - minY + 1;
  const tw = iw + 2 * m, th = ih + 2 * m;
  const out = document.createElement('canvas');
  out.width = tw; out.height = th;
  const octx = out.getContext('2d', { alpha: false });
  octx.fillStyle = '#fff'; octx.fillRect(0, 0, tw, th);
  octx.drawImage(page, sx + minX, sy + minY, iw, ih, m, m, iw, ih);
  return { dataUrl: out.toDataURL('image/png'), w: tw, h: th, frac: tw / W };
}
