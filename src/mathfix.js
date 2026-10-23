// Fixes around LaTeX → MathML (temml) → OMML (mathml2omml) so Word shows math like a typed equation.
// mathml2omml has no m:d (stretchy delimiters) and only emits m:acc when MathML marks the accent,
// so we (1) add \left \right where needed, (2) mark fences/accents in the MathML,
// (3) rebuild m:d from the markers in the OMML.

const TALL = /\\(?:d|t)?frac|\\binom|\\sum|\\prod|\\int|\\begin\{/;
const SIZE_CMD = /\\(?:left|right|middle|[bB]igg?[lrm]?)\s*$/;

/** Wrap ( … ), [ … ], [ … ), ( … ] in \left \right when the inside holds a fraction/sum/matrix. */
export function autoFence(tex) {
  const stack = [];
  const pairs = [];
  let depth = 0;
  for (let k = 0; k < tex.length; k++) {
    const ch = tex[k];
    if (ch === '\\') {                                   // skip a command name or an escaped char
      const m = /^\\([a-zA-Z]+|.)/.exec(tex.slice(k));
      if (m) {
        // \sqrt[n] and \\[2pt]: the bracket is an optional argument, not a delimiter
        if ((m[1] === 'sqrt' || m[1] === '\\') && tex[k + m[0].length] === '[') {
          const close = tex.indexOf(']', k + m[0].length);
          if (close > 0) { k = close; continue; }
        }
        k += m[0].length - 1;
      }
      continue;
    }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; continue; }
    if (ch === '(' || ch === '[') {
      if (SIZE_CMD.test(tex.slice(0, k))) continue;
      stack.push({ pos: k, depth });
    } else if (ch === ')' || ch === ']') {
      if (SIZE_CMD.test(tex.slice(0, k))) continue;
      if (!stack.length || stack[stack.length - 1].depth !== depth) continue;
      const open = stack.pop();
      if (TALL.test(tex.slice(open.pos + 1, k))) pairs.push([open.pos, k]);
    }
  }
  if (!pairs.length) return tex;
  const edits = pairs.flatMap(([a, b]) => [{ at: a, s: '\\left' }, { at: b, s: '\\right' }]).sort((x, y) => y.at - x.at);
  let out = tex;
  for (const e of edits) out = out.slice(0, e.at) + e.s + out.slice(e.at);
  return out;
}

// Private-use markers that survive mathml2omml as plain text.
const [OPEN, CLOSE, EMPTY, SPACE] = [0xE000, 0xE001, 0xE002, 0xE003].map(c => String.fromCharCode(c));
const NBSP = String.fromCharCode(0xA0);
const MARKERS = new RegExp('[' + OPEN + CLOSE + EMPTY + ']', 'g');
const ARROWS = new Set(['→', '⟶', '⃗']);
const HATS = new Set(['ˆ', '^', '̂']);

/** Index of the end of the element that opens at `start` (handles nesting of the same tag). */
function matchEnd(s, start, tag) {
  const openRe = new RegExp(`<${tag}(?=[\\s>/])`, 'g');
  const closeTag = `</${tag}>`;
  let depth = 0, k = start;
  for (;;) {
    openRe.lastIndex = k;
    const o = openRe.exec(s);
    const c = s.indexOf(closeTag, k);
    if (c < 0) return -1;
    if (o && o.index < c) {
      const selfClose = s.slice(o.index, s.indexOf('>', o.index) + 1).endsWith('/>');
      if (!selfClose) depth++;
      k = o.index + 1;
    } else {
      depth--;
      k = c + closeTag.length;
      if (depth === 0) return k;
    }
  }
}

/** Prepare temml's MathML for mathml2omml. */
export function prepMathml(mml) {
  // \vec, \overrightarrow, \widehat → accents (m:acc); m:acc with U+20D7 is what Word itself uses for vectors
  let out = '';
  let k = 0;
  const re = /<mover(?=[\s>])[^>]*>/g;
  let m;
  while ((m = re.exec(mml))) {
    const end = matchEnd(mml, m.index, 'mover');
    if (end < 0) break;
    const inner = mml.slice(m.index + m[0].length, end - '</mover>'.length);
    const acc = /<mo(?:\s[^>]*)?>([^<]*)<\/mo>$/.exec(inner);
    if (acc && (ARROWS.has(acc[1]) || HATS.has(acc[1])) && !/accent=/.test(m[0])) {
      const chr = ARROWS.has(acc[1]) ? '→' : '^';
      out += mml.slice(k, m.index) + '<mover accent="true">' + inner.slice(0, acc.index) + `<mo>${chr}</mo>`;
      k = m.index + m[0].length + inner.length;            // continue scanning inside (nested accents)
      re.lastIndex = k;
      continue;
    }
  }
  mml = out + mml.slice(k);

  // \left X … \right Y (temml always emits them as a balanced pair) → marker-wrapped menclose (becomes m:borderBox, rebuilt into m:d later)
  mml = mml
    .replace(/<mo fence="true" form="prefix" stretchy="true"[^>]*>([^<]*)<\/mo>/g, (_, c) => `<menclose notation="mathdocfence"><mrow><mo>${OPEN}${c || EMPTY}</mo>`)
    .replace(/<mo fence="true" form="postfix" stretchy="true"[^>]*>([^<]*)<\/mo>/g, (_, c) => `<mo>${c || EMPTY}${CLOSE}</mo></mrow></menclose>`);

  // empty <mspace> (temml puts one after \Delta etc.) becomes a stray space run
  mml = mml.replace(/<mspace\s*><\/mspace>|<mspace\s*\/>/g, '');
  // mathml2omml trims spaces inside \text{…}; keep them as a marker (a no-break space later) and always
  // separate a number from a unit: 343\text{ m}, 6\text{cm}
  mml = mml.replace(/(<\/mn>(?:<\/mrow>)?)<mtext>\s*(?=[A-Za-zµΩ])/g, `$1<mtext>${SPACE}`)
    .replace(/<mtext>\s+/g, `<mtext>${SPACE}`)
    .replace(/\s+<\/mtext>/g, `${SPACE}</mtext>`);
  return mml;
}

const escAttr = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Rebuild m:d from the fence markers; tidy runs. */
export function fixOmml(o) {
  // innermost first: always take the last <m:borderBox> that still contains a marker
  for (let guard = 0; guard < 200; guard++) {
    let start = -1, from = o.length;
    while (from > 0) {
      const s = o.lastIndexOf('<m:borderBox>', from - 1);
      if (s < 0) break;
      const e = matchEnd(o, s, 'm:borderBox');
      if (e > 0 && o.slice(s, e).includes(OPEN)) { start = s; break; }
      from = s;
    }
    if (start < 0) break;
    const end = matchEnd(o, start, 'm:borderBox');
    const box = o.slice(start, end);
    const eStart = box.indexOf('<m:e>');
    let inner = box.slice(eStart + 5, box.length - '</m:e></m:borderBox>'.length);
    const oi = inner.indexOf(OPEN);
    const ci = inner.lastIndexOf(CLOSE);
    if (oi < 0 || ci < 0) { o = o.slice(0, start) + box.replace(OPEN, '') + o.slice(end); continue; }
    const beg = inner[oi + 1];
    const fin = inner[ci - 1];
    inner = inner.slice(0, ci - 1) + inner.slice(ci + 1);
    inner = inner.slice(0, oi) + inner.slice(oi + 2);
    inner = inner.replace(/<m:r>(?:<m:rPr>(?:(?!<\/m:rPr>).)*<\/m:rPr>)?(?:<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?<m:t(?: [^>]*)?><\/m:t><\/m:r>/g, '');
    if (!inner) inner = '<m:r><m:t></m:t></m:r>';
    // hệ { … và tuyển [ … : căn trái các dòng như cách viết trong đề
    if (fin === EMPTY && inner.startsWith('<m:m>')) inner = inner.replace(/<m:mcJc m:val="center"\/>/g, '<m:mcJc m:val="left"/>');
    const chr = c => (c === EMPTY ? '' : c);
    const d = `<m:d><m:dPr><m:begChr m:val="${escAttr(chr(beg))}"/><m:endChr m:val="${escAttr(chr(fin))}"/><m:ctrlPr/></m:dPr><m:e>${inner}</m:e></m:d>`;
    o = o.slice(0, start) + d + o.slice(end);
  }
  o = o.split(SPACE).join(NBSP).replace(MARKERS, '');
  // upright Greek capitals (\Delta, \Omega…) as a math run, not a "normal text" run
  o = o.replace(/<m:r><m:rPr><m:nor\/><\/m:rPr>(<w:rPr>(?:(?!<\/w:rPr>).)*<\/w:rPr>)?(<m:t(?: [^>]*)?>)([\u0391-\u03A9])<\/m:t><\/m:r>/g,
    (_, w = '', t, g) => `<m:r><m:rPr><m:sty m:val="p"/></m:rPr>${w}${t}${g}</m:t></m:r>`);
  return o;
}
