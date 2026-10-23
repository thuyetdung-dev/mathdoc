// Build a .docx (Word Equation / OMML) from parsed blocks. No server needed.
import JSZip from 'jszip';
import temml from 'temml';
import { mml2omml } from 'mathml2omml';
import { parseBlocks } from './md.js';
import { autoFence, prepMathml, fixOmml } from './mathfix.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const esc = s => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CONTENT_W_TW = 9638;          // 17 cm in twips
const CONTENT_W_EMU = 6120000;      // 17 cm in EMU

// mathml2omml does not escape "<", ">" and "&" inside text/attributes → Word refuses the file.
const escText = t => t.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const M_NS = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function wellFormed(xml) {
  if (typeof DOMParser === 'undefined') return true;
  const doc = new DOMParser().parseFromString(`<r ${M_NS}>${xml}</r>`, 'application/xml');
  return !doc.getElementsByTagName('parsererror').length;
}

export function texToOmml(tex) {
  const mml = prepMathml(temml.renderToString(autoFence(tex), { xml: true, throwOnError: true, displayMode: false }));
  let o = mml2omml(mml);
  o = o.replace(/ xmlns:m="[^"]*"/g, '').replace(/ xmlns:w="[^"]*"/g, '')
    .replace(/<m:argPr><m:scrLvl m:val="0"\/><\/m:argPr>/g, '')
    .replace(/(<m:t(?: [^>]*)?>)([\s\S]*?)(<\/m:t>)/g, (_, a, t, b) => a + escText(t) + b)
    .replace(/(m:val=")([^"]*)(")/g, (_, a, v, b) => a + escText(v) + b)
    .replace(/<m:e\/>/g, '<m:e><m:r><m:t></m:t></m:r></m:e>')
    // schema fixes for Word: no empty w:rPr, m:rPr must come before w:rPr, no "undefined" enum values
    .replace(/<w:rPr\/>/g, '')
    .replace(/(<w:rPr>[\s\S]*?<\/w:rPr>)(<m:rPr>[\s\S]*?<\/m:rPr>)/g, '$2$1')
    .replace(/<m:sty m:val="(?!(p|b|i|bi)")[^"]*"\/>/g, '<m:sty m:val="p"/>')
    .replace(/<m:(\w+) m:val="(undefined|null|NaN|)"\/>/g, '')
    .replace(/<m:chr m:val="([^"]*)" m:pos="([^"]*)"\/>/g, '<m:chr m:val="$1"/><m:pos m:val="$2"/>')   // pos is an element, not an attribute
    .replace(/<m:rPr>([\s\S]*?)<\/m:rPr>/g, (all, inner) => /<m:nor\/>/.test(inner) ? `<m:rPr>${inner.replace(/<m:sty [^>]*\/>|<m:scr [^>]*\/>/g, '')}</m:rPr>` : all);
  o = fixOmml(o);
  if (!wellFormed(o)) throw new Error('OMML không hợp lệ');
  return o;
}

function runXml(text, { b, i, color, size } = {}) {
  if (!text) return '';
  const pr = (b ? '<w:b/>' : '') + (i ? '<w:i/>' : '') + (color ? `<w:color w:val="${color}"/>` : '') + (size ? `<w:sz w:val="${size}"/>` : '');
  return text.split('\t').map((part, idx) =>
    (idx ? '<w:r><w:tab/></w:r>' : '') + (part ? `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(part)}</w:t></w:r>` : '')
  ).join('');
}

function inlineXml(tokens, stats, opts = {}) {
  let x = '';
  for (const tk of tokens) {
    if (tk.t === 'text') x += runXml(tk.s, { b: tk.b || opts.b, i: tk.i, size: opts.size });
    else {
      try { x += texToOmml(tk.tex); stats.formulas++; }
      catch (e) { x += runXml(`$${tk.tex}$`, { color: 'C00000' }); stats.mathErrors.push(tk.tex); }
    }
  }
  return x;
}

function pXml(inner, { align, spacingAfter = 60, keepNext, pageBreakBefore, tabs } = {}) {
  // thứ tự phần tử trong w:pPr phải đúng chuẩn: keepNext → pageBreakBefore → tabs → spacing → jc
  const ppr = (keepNext ? '<w:keepNext/>' : '') + (pageBreakBefore ? '<w:pageBreakBefore/>' : '') +
    (tabs && tabs.length ? `<w:tabs>${tabs.map(t => `<w:tab w:val="left" w:pos="${Math.round(t)}"/>`).join('')}</w:tabs>` : '') +
    `<w:spacing w:after="${spacingAfter}" w:line="276" w:lineRule="auto"/>` + (align ? `<w:jc w:val="${align}"/>` : '');
  return `<w:p><w:pPr>${ppr}</w:pPr>${inner}</w:p>`;
}

// ---- phương án A. B. C. D. ngăn cách bằng TAB: tự dàn 4 / 2 / 1 phương án mỗi dòng ----
const OPTION_RE = /^\s*(?:[A-D]\.|[a-d]\))/;
const TAB_RUN = '<w:r><w:tab/></w:r>';

function splitTabs(inl) {
  const segs = [[]];
  for (const tk of inl) {
    if (tk.t !== 'text' || !tk.s.includes('\t')) { segs[segs.length - 1].push(tk); continue; }
    tk.s.split('\t').forEach((part, i) => {
      if (i) segs.push([]);
      if (part) segs[segs.length - 1].push({ ...tk, s: part });
    });
  }
  return segs.filter(sg => sg.some(t => t.t !== 'text' || t.s.trim()));
}

/** Số ký tự hiển thị (ước lượng) của một công thức LaTeX. */
function mathChars(tex) {
  let s = tex;
  for (let k = 0; k < 4; k++) s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a, b) => (a.length >= b.length ? a : b));
  s = s.replace(/\\(?:left|right|displaystyle|limits|mathrm|text|operatorname|,|;|!)/g, '')
    .replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}^_\s]/g, '');
  return s.length;
}
const segChars = seg => seg.reduce((n, t) => n + (t.t === 'text' ? t.s.trim().length + 1 : mathChars(t.tex)), 0);

function tabbedXml(segs, stats, fontPt) {
  const isOption = segs.length > 1 && segs.every(sg => sg[0] && sg[0].t === 'text' && OPTION_RE.test(sg[0].s));
  const line = (group, per) => pXml(group.map(sg => inlineXml(sg, stats)).join(TAB_RUN),
    { tabs: Array.from({ length: per - 1 }, (_, j) => (j + 1) * CONTENT_W_TW / per) });
  if (!isOption) return line(segs, 4);
  const n = segs.length;
  const widest = Math.max(...segs.map(segChars)) * fontPt * 9 + 150;       // twip, ~0,45 em mỗi ký tự
  const per = [Math.min(n, 4), 2, 1].find(k => k <= n && widest <= CONTENT_W_TW / k) || 1;
  let x = '';
  for (let k = 0; k < n; k += per) x += line(segs.slice(k, k + per), per);
  return x;
}

function imageXml(rid, idn, cx, cy, name) {
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${idn}" name="${esc(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="${idn}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function dataUrlToBytes(u) {
  const b64 = u.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
  return arr;
}

/**
 * images: Map<id, {dataUrl, w, h, frac}>  (frac = crop width / page width)
 * opts: {fontName, fontSize, pageBreaks}
 */
export async function buildDocx(markdown, images, opts = {}) {
  const fontName = opts.fontName || 'Times New Roman';
  const fontSize = Math.round((opts.fontSize || 12) * 2);
  const blocks = parseBlocks(markdown);
  const stats = { formulas: 0, images: 0, tables: 0, mathErrors: [] };
  const zip = new JSZip();
  const rels = [];
  let body = '';
  let picId = 1;
  let firstPage = true;

  for (const b of blocks) {
    if (b.type === 'page') {
      if (opts.pageBreaks && !firstPage) body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      firstPage = false;
      continue;
    }
    if (b.type === 'hr') { body += pXml(''); continue; }
    if (b.type === 'heading') {
      body += `<w:p><w:pPr><w:pStyle w:val="Heading${Math.min(b.level, 3)}"/></w:pPr>${inlineXml(b.inl, stats)}</w:p>`;
      continue;
    }
    if (b.type === 'para') {
      const segs = splitTabs(b.inl);
      body += segs.length > 1 ? tabbedXml(segs, stats, fontSize / 2) : pXml(inlineXml(b.inl, stats));
      continue;
    }
    if (b.type === 'math') {
      let inner;
      try { inner = `<m:oMathPara>${texToOmml(b.tex)}</m:oMathPara>`; stats.formulas++; }
      catch (e) { inner = runXml(`$$${b.tex}$$`, { color: 'C00000' }); stats.mathErrors.push(b.tex); }
      body += pXml(inner, { align: 'center' });
      continue;
    }
    if (b.type === 'image') {
      const img = images.get(b.id);
      if (!img) { body += pXml(runXml(`[Hình: ${b.alt || 'chưa cắt được'}]`, { i: true, color: '7F7F7F' }), { align: 'center' }); continue; }
      const rid = `rIdImg${picId}`;
      zip.file(`word/media/image${picId}.png`, dataUrlToBytes(img.dataUrl));
      rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${picId}.png"/>`);
      const cx = Math.round(Math.min(1, Math.max(0.15, img.frac || 0.5)) * CONTENT_W_EMU);
      const cy = Math.round(cx * img.h / img.w);
      body += pXml(imageXml(rid, picId, cx, cy, `Hinh ${picId}`), { align: 'center' });
      picId++; stats.images++;
      continue;
    }
    if (b.type === 'table') {
      stats.tables++;
      const ncol = b.rows[0].length;
      const cw = Math.floor(CONTENT_W_TW / ncol);
      let t = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/><w:tblBorders>' +
        ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('') +
        '</w:tblBorders><w:tblLayout w:type="autofit"/><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>' +
        `<w:gridCol w:w="${cw}"/>`.repeat(ncol) + '</w:tblGrid>';
      b.rows.forEach((row, ri) => {
        t += '<w:tr>';
        for (const cell of row) {
          t += `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/><w:vAlign w:val="center"/></w:tcPr>`;
          t += cell.map(inl => pXml(inlineXml(inl, stats, { b: ri === 0 && opts.boldHeader }), { spacingAfter: 0, align: 'center' })).join('') || '<w:p/>';
          t += '</w:tc>';
        }
        t += '</w:tr>';
      });
      t += '</w:tbl>';
      body += t + pXml('', { spacingAfter: 0 });
    }
  }

  const sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>';
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`;
  if (typeof DOMParser !== 'undefined') {
    const chk = new DOMParser().parseFromString(docXml, 'application/xml');
    const pe = chk.getElementsByTagName('parsererror')[0];
    if (pe) throw new Error('File Word tạo ra bị lỗi cấu trúc XML: ' + pe.textContent.slice(0, 200));
  }
  zip.file('word/document.xml', docXml);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.join('')}</Relationships>`);
  zip.file('word/styles.xml', stylesXml(fontName, fontSize));
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  const blob = await zip.generateAsync({ type: opts.nodeBuffer ? 'nodebuffer' : 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  return { blob, stats };
}

function stylesXml(font, sz) {
  const h = (n, size) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/><w:lang w:val="vi-VN"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
    h(1, sz + 8) + h(2, sz + 4) + h(3, sz + 2) + `</w:styles>`;
}
