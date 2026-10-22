// Build a .docx (Word Equation / OMML) from parsed blocks. No server needed.
import JSZip from 'jszip';
import temml from 'temml';
import { mml2omml } from 'mathml2omml';
import { parseBlocks } from './md.js';

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CONTENT_W_TW = 9638;          // 17 cm in twips
const CONTENT_W_EMU = 6120000;      // 17 cm in EMU

export function texToOmml(tex) {
  const mml = temml.renderToString(tex, { xml: true, throwOnError: true, displayMode: false });
  let o = mml2omml(mml);
  // strip duplicated namespace declarations (declared on the root)
  o = o.replace(/ xmlns:m="[^"]*"/g, '').replace(/ xmlns:w="[^"]*"/g, '')
    .replace(/<m:argPr><m:scrLvl m:val="0"\/><\/m:argPr>/g, '');
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

function pXml(inner, { align, spacingAfter = 60, keepNext, pageBreakBefore } = {}) {
  const ppr = (pageBreakBefore ? '<w:pageBreakBefore/>' : '') + (keepNext ? '<w:keepNext/>' : '') +
    `<w:spacing w:after="${spacingAfter}" w:line="276" w:lineRule="auto"/>` + (align ? `<w:jc w:val="${align}"/>` : '');
  return `<w:p><w:pPr>${ppr}</w:pPr>${inner}</w:p>`;
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
    if (b.type === 'para') { body += pXml(inlineXml(b.inl, stats)); continue; }
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
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`);
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
