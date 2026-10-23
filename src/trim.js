// Tìm khung chứa hình trong vùng cắt, bỏ những dòng chữ của đề bị "dính" vào mép vùng cắt.
// Dấu hiệu của chữ thừa: một dải mực sát mép, mỏng cỡ một dòng chữ, cách phần hình bằng một khoảng trắng,
// và bị mép vùng cắt cắt ngang (dòng chữ của đề luôn dài hơn hình nên chạm biên trái/phải của vùng cắt).

/**
 * d: RGBA của vùng cắt (sw × sh). refW: bề rộng trang (px) để quy đổi kích thước.
 * Trả về {x0, y0, x1, y1} (bao gồm cả hai đầu) hoặc null nếu vùng trống.
 */
export function figureBounds(d, sw, sh, refW) {
  const ink = new Uint8Array(sw * sh);
  let total = 0;
  for (let k = 0, o = 0; k < sw * sh; k++, o += 4) {
    if (d[o] * 0.2126 + d[o + 1] * 0.7152 + d[o + 2] * 0.0722 < 235) { ink[k] = 1; total++; }
  }
  if (!total) return null;

  const minGap = Math.max(3, Math.round(refW * 0.002));     // khoảng trắng tách dòng chữ khỏi hình
  const lineH = Math.round(refW * 0.032);                  // cao tối đa của một dòng chữ
  const wordW = Math.round(refW * 0.06);                   // rộng tối đa của mẩu chữ ở mép trái/phải
  let x0 = 0, y0 = 0, x1 = sw - 1, y1 = sh - 1;

  const rowCount = y => { let n = 0; for (let x = x0, o = y * sw + x0; x <= x1; x++, o++) n += ink[o]; return n; };
  const colCount = x => { let n = 0; for (let y = y0, o = y0 * sw + x; y <= y1; y++, o += sw) n += ink[o]; return n; };
  const tight = () => {
    while (y0 <= y1 && !rowCount(y0)) y0++;
    while (y1 >= y0 && !rowCount(y1)) y1--;
    while (x0 <= x1 && !colCount(x0)) x0++;
    while (x1 >= x0 && !colCount(x1)) x1--;
    return x0 <= x1 && y0 <= y1;
  };
  // các dải liên tiếp có mực (khoảng trắng < minGap coi như liền)
  const bands = (lo, hi, count) => {
    const out = [];
    let s = -1, lastInk = -1;
    for (let i = lo; i <= hi; i++) {
      if (count(i) > 1) {
        if (s < 0) s = i;
        else if (i - lastInk > minGap) { out.push([s, lastInk]); s = i; }
        lastInk = i;
      }
    }
    if (s >= 0) out.push([s, lastInk]);
    return out;
  };
  const touchesX = (ya, yb, xEdge) => { for (let y = ya; y <= yb; y++) for (let x = Math.max(0, xEdge - 1); x <= Math.min(sw - 1, xEdge + 1); x++) if (ink[y * sw + x]) return true; return false; };

  if (!tight()) return null;
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    const rb = bands(y0, y1, rowCount);
    if (rb.length > 1) {
      const [ta, tb] = rb[0], [ba, bb] = rb[rb.length - 1];
      // dòng chữ thừa: mỏng cỡ một dòng, và bị mép vùng cắt cắt ngang — chạm biên trái/phải,
      // hoặc chạm biên trên/dưới mà trải rộng quá nửa bề ngang (dòng chữ bị cắt mất nửa)
      const inkWidth = (a, b) => { let l = sw, r = -1; for (let y = a; y <= b; y++) for (let x = x0; x <= x1; x++) if (ink[y * sw + x]) { if (x < l) l = x; if (x > r) r = x; } return r - l + 1; };
      const strayRow = (a, b, yEdge) => b - a + 1 <= lineH &&
        (touchesX(a, b, 0) || touchesX(a, b, sw - 1) || (Math.abs(yEdge === 0 ? a : sh - 1 - b) <= 1 && inkWidth(a, b) >= 0.5 * (x1 - x0 + 1)));
      if (strayRow(ta, tb, 0)) { y0 = rb[1][0]; changed = true; }
      else if (strayRow(ba, bb, sh - 1)) { y1 = rb[rb.length - 2][1]; changed = true; }
    }
    if (!changed) {
      const cb = bands(x0, x1, colCount);
      if (cb.length > 1) {
        const [la, lb] = cb[0], [ra, rbb] = cb[cb.length - 1];
        if (lb - la + 1 <= wordW && touchesX(y0, y1, 0) && la <= 1) { x0 = cb[1][0]; changed = true; }
        else if (rbb - ra + 1 <= wordW && rbb >= sw - 2) { x1 = cb[cb.length - 2][1]; changed = true; }
      }
    }
    if (!changed) break;
    if (!tight()) return null;
  }
  return { x0, y0, x1, y1 };
}
