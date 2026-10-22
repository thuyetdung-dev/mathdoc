// Mini Markdown parser for OCR output: blocks + inline tokens (text, bold, italic, math).

export function normalize(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^```(?:markdown|md)?\s*\n/i, '')
    .replace(/\n```\s*$/i, '')
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `$$${m}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m}$`);
}

const IMG_RE = /^!\[([^\]]*)\]\(img:(\d+)\)\s*$/;
const PAGE_RE = /^<!--\s*Trang\s+(\d+)\s*-->\s*$/i;

export function parseBlocks(md) {
  const lines = normalize(md).split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { i++; continue; }
    let m;
    if ((m = line.match(PAGE_RE))) { blocks.push({ type: 'page', n: +m[1] }); i++; continue; }
    if (/^<!--.*-->$/.test(line)) { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue; }
    // display math $$ ... $$ (possibly multi-line)
    if (line.startsWith('$$')) {
      let buf = line.slice(2);
      if (buf.trim().endsWith('$$') && buf.trim().length > 2) {
        blocks.push({ type: 'math', tex: buf.trim().slice(0, -2).trim() }); i++; continue;
      }
      if (buf.trim() === '' || !buf.includes('$$')) {
        const acc = [buf];
        i++;
        while (i < lines.length && !lines[i].includes('$$')) { acc.push(lines[i]); i++; }
        if (i < lines.length) { acc.push(lines[i].slice(0, lines[i].indexOf('$$'))); i++; }
        blocks.push({ type: 'math', tex: acc.join('\n').trim() });
        continue;
      }
    }
    if ((m = line.match(IMG_RE))) { blocks.push({ type: 'image', alt: m[1], id: +m[2] }); i++; continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { blocks.push({ type: 'heading', level: m[1].length, inl: parseInline(m[2]) }); i++; continue; }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const r = lines[i].trim();
        if (!/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(r)) rows.push(splitRow(r));
        i++;
      }
      const ncol = Math.max(...rows.map(r => r.length));
      blocks.push({ type: 'table', rows: rows.map(r => { while (r.length < ncol) r.push(''); return r.map(c => c.split(/<br\s*\/?>/i).map(parseInline)); }) });
      continue;
    }
    blocks.push({ type: 'para', inl: parseInline(line.replace(/^\\([-+*])/, '$1')) });
    i++;
  }
  return blocks;
}

function splitRow(r) {
  let s = r.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // split on | not inside $...$ and not escaped
  const cells = []; let cur = ''; let inMath = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '$') inMath = !inMath;
    if (ch === '|' && !inMath) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// inline tokens: {t:'text', s, b, i} | {t:'math', tex, display}
export function parseInline(s) {
  const out = [];
  let k = 0, buf = '', bold = false, ital = false;
  const flush = () => { if (buf) { out.push({ t: 'text', s: buf, b: bold, i: ital }); buf = ''; } };
  while (k < s.length) {
    const ch = s[k];
    if (ch === '\\' && (s[k + 1] === '$' || s[k + 1] === '*' || s[k + 1] === '_')) { buf += s[k + 1]; k += 2; continue; }
    if (ch === '$') {
      const disp = s[k + 1] === '$';
      const open = disp ? 2 : 1;
      const close = s.indexOf(disp ? '$$' : '$', k + open);
      if (close > k + open - 1 && close !== -1) {
        const tex = s.slice(k + open, close).trim();
        if (tex) { flush(); out.push({ t: 'math', tex, display: disp }); k = close + open; continue; }
      }
    }
    if (ch === '*' && s[k + 1] === '*') { flush(); bold = !bold; k += 2; continue; }
    if (ch === '*' && s[k + 1] !== ' ' && (ital || s.indexOf('*', k + 1) > k + 1)) { flush(); ital = !ital; k += 1; continue; }
    buf += ch; k++;
  }
  flush();
  return out;
}
