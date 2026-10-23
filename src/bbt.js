// Lưới an toàn: nếu Gemini vẫn chép bảng biến thiên / bảng xét dấu thành bảng Markdown,
// đổi bảng đó thành một hình cần định vị lại để cắt ảnh từ trang gốc (giữ lại bảng chữ phòng khi không cắt được).

const ARROW = /[↗↘↑↓➚➘⬈⬊]|\\(?:nearrow|searrow|uparrow|downarrow|nwarrow|swarrow)/;

/** Chuẩn hoá nội dung ô cột đầu: bỏ $, khoảng trắng, \prime, ^{\prime}, ’ … */
function head(cell) {
  return cell.replace(/\$/g, '').replace(/\\(?:mathrm|text)\{([^}]*)\}/g, '$1')
    .replace(/\^\{?\\prime\}?|\\prime|’|′/g, "'").replace(/\\left|\\right|\s/g, '').toLowerCase();
}
const IS_X = /^(x|t)$/;
const IS_DERIV = /^[a-z]'(\((x|t)\))?$|^[a-z]'$/;
const IS_FUNC = /^[a-z](\((x|t)\))?$/;

function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

/** true nếu các dòng bảng Markdown là bảng biến thiên / bảng xét dấu. */
export function isVariationTable(lines) {
  const rows = lines.filter(l => !/^\|?\s*:?-{2,}/.test(l.trim())).map(cells);
  if (rows.length < 2) return false;
  const firsts = rows.map(r => head(r[0] || ''));
  if (!IS_X.test(firsts[0])) return false;
  const hasDeriv = firsts.some(f => IS_DERIV.test(f));
  const hasFunc = firsts.slice(1).some(f => IS_FUNC.test(f));
  const hasArrow = rows.some(r => r.some(c => ARROW.test(c)));
  return hasArrow || (hasDeriv && (hasFunc || rows.length === 2));
}

/**
 * Thay mỗi bảng biến thiên dạng Markdown bằng [[HINH:trang,0,0,0,0|bảng biến thiên]].
 * Trả về {md, fallbacks}: fallbacks[k] là bảng chữ gốc của hình "chưa rõ vị trí" thứ k (theo thứ tự xuất hiện).
 */
export function tablesToFigures(md) {
  const lines = md.split('\n');
  const out = [];
  const fallbacks = [];
  let page = 1;
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/^\s*<!--\s*Trang\s+(\d+)\s*-->\s*$/i);
    if (pm) page = +pm[1];
    if (!lines[i].trim().startsWith('|')) { out.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && lines[j].trim().startsWith('|')) j++;
    const block = lines.slice(i, j);
    if (isVariationTable(block)) {
      const firsts = block.map(l => head(cells(l)[0] || ''));
      const kind = block.some(l => ARROW.test(l)) || firsts.slice(1).some(f => IS_FUNC.test(f)) ? 'bảng biến thiên' : 'bảng xét dấu';
      out.push(`[[HINH:${page},0,0,0,0|${kind}]]`);
      fallbacks.push({ text: block.join('\n'), hint: block.map(l => cells(l).filter(Boolean).join(' ')).filter(l => !/^-+/.test(l)).join(' / ').slice(0, 200) });
    } else out.push(...block);
    i = j - 1;
  }
  return { md: out.join('\n'), fallbacks };
}
