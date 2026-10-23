// Giải đề: câu lệnh gửi Gemini, đọc kết quả có đánh dấu, rồi ghép vào Markdown của đề
// theo một trong ba cách: cuối đề / sau mỗi câu / chỉ bảng đáp án.

export const SOL_START = '<!-- LOI GIAI: BAT DAU -->';
const LG_OPEN = '<!-- LG -->';
const LG_CLOSE = '<!-- /LG -->';

/** Bỏ lời giải đã chèn ở lần giải trước, trả lại đúng nội dung đề. */
export function stripSolutions(md) {
  let s = md;
  const k = s.indexOf(SOL_START);
  if (k >= 0) s = s.slice(0, k).replace(/\s+$/, '\n');
  return s.replace(new RegExp(`\\n?${LG_OPEN}[\\s\\S]*?${LG_CLOSE}\\n?`, 'g'), '\n').replace(/\n{3,}/g, '\n\n');
}

export function solvePrompt({ detail, keyOnly }) {
  const style = keyOnly
    ? 'Chỉ cần đáp án, KHÔNG viết lời giải (sau dòng @@CAU không viết gì).'
    : detail === 'short'
      ? 'Lời giải NGẮN GỌN: chỉ các bước chính, phép tính then chốt, 2–6 dòng mỗi câu.'
      : 'Lời giải CHI TIẾT theo từng bước như giáo viên trình bày cho học sinh lớp 12: nêu kiến thức dùng, biến đổi rõ ràng, kết luận.';
  return `Bạn là giáo viên Toán THPT giỏi ở Việt Nam. Dưới đây là một đề Toán (dạng Markdown + LaTeX, kèm file gốc nếu có để xem hình vẽ, bảng biến thiên). Hãy GIẢI TOÀN BỘ đề.

YÊU CẦU
1. Giải đúng, cẩn thận; tự kiểm tra lại kết quả (thay số, xét điều kiện, đối chiếu phương án) trước khi chốt đáp án.
2. Với mỗi câu, viết đúng một dòng đánh dấu rồi đến lời giải:
   @@CAU|P|C|DA
   - P: số thứ tự PHẦN như trong đề (PHẦN I → 1, PHẦN II → 2, PHẦN III → 3, …); đề không chia phần thì P = 1.
   - C: số câu đúng như trong đề (đánh số lại từ 1 ở mỗi phần nếu đề làm vậy).
   - DA: đáp án ngắn gọn:
     • câu nhiều phương án: một chữ cái A, B, C hoặc D;
     • câu đúng/sai có các ý a), b), c), d): chuỗi Đ/S theo thứ tự các ý, ví dụ ĐSSĐ;
     • câu trả lời ngắn: con số cuối cùng đã làm tròn theo yêu cầu của đề, dùng dấu phẩy thập phân (ví dụ 7,15; -2; 0,5);
     • câu tự luận: để trống.
3. ${style}
4. Câu đúng/sai: giải lần lượt từng ý, mỗi ý bắt đầu bằng "a) **Đúng**." hoặc "a) **Sai**." rồi giải thích.
5. Câu nhiều phương án: dòng cuối lời giải là "Chọn **X**."
6. Mọi biểu thức toán viết bằng LaTeX: trong dòng dùng $...$, công thức riêng dòng dùng $$...$$. Dùng \\dfrac, \\overrightarrow{AB}, \\begin{cases}...\\end{cases}. Không dùng \\( \\) hay \\[ \\]. Không chép lại đề bài. Không dùng tiêu đề #, không bọc kết quả trong \`\`\`.
7. Giải đủ mọi câu theo đúng thứ tự trong đề. Ngoài các dòng @@CAU và lời giải, không viết gì khác.`;
}

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 };
const ROMAN_OF = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const PART_RE = /^\s*[*_]*\s*PH[ẦA]N\s+([IVX]+|\d+)\b/i;
const Q_RE = /^\s*[*_]*\s*Câu\s+(\d+)\s*[*_]*\s*[.:]/i;

/** Đọc kết quả Gemini → [{p, c, ans, body}] */
export function parseSolution(text) {
  const out = [];
  const t = text.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const re = /^\s*@@CAU\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|([^\n]*)$/gm;
  const marks = [...t.matchAll(re)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : t.length;
    out.push({ p: +m[1], c: +m[2], ans: m[3].trim().replace(/\s+/g, ' '), body: t.slice(m.index + m[0].length, end).trim() });
  });
  return out;
}

const isMC = a => /^[A-D]$/.test(a);
const isTF = a => /^[ĐDS]{2,6}$/i.test(a.replace(/[\s,;-]/g, ''));
const tf = a => a.replace(/[\s,;-]/g, '').toUpperCase().replace(/D/g, 'Đ').split('');

/** Bảng đáp án dạng Markdown cho từng phần. */
export function keyTables(sols) {
  const parts = [...new Set(sols.map(s => s.p))].sort((a, b) => a - b);
  const multi = parts.length > 1;
  let md = '';
  for (const p of parts) {
    const list = sols.filter(s => s.p === p && s.ans);
    if (!list.length) continue;
    if (multi) md += `**PHẦN ${ROMAN_OF[p] || p}.**\n`;
    if (list.every(s => isTF(s.ans))) {
      const n = Math.max(...list.map(s => tf(s.ans).length));
      md += `| Câu | ${list.map(s => s.c).join(' | ')} |\n|${'---|'.repeat(list.length + 1)}\n`;
      for (let k = 0; k < n; k++) md += `| ${'abcdef'[k]}) | ${list.map(s => tf(s.ans)[k] || '').join(' | ')} |\n`;
    } else {
      const per = list.every(s => isMC(s.ans)) ? 12 : 6;
      for (let k = 0; k < list.length; k += per) {
        const chunk = list.slice(k, k + per);
        md += `| Câu | ${chunk.map(s => s.c).join(' | ')} |\n|${'---|'.repeat(chunk.length + 1)}\n| Đáp án | ${chunk.map(s => s.ans).join(' | ')} |\n\n`;
      }
    }
    md += '\n';
  }
  return md.trim();
}

function answerLine(s) {
  if (!s.ans) return '';
  if (isMC(s.ans)) return `Chọn **${s.ans}**.`;
  if (isTF(s.ans)) return 'Đáp án: ' + tf(s.ans).map((v, k) => `${'abcdef'[k]}) ${v === 'Đ' ? 'Đúng' : 'Sai'}`).join('; ') + '.';
  return `Đáp án: **${s.ans}**.`;
}

/** Lời giải đã có câu "Chọn X." thì không lặp lại. */
const hasChoice = s => /Chọn\s+\**[A-D]\**\.?\s*$/.test(s.body);

/** Cách 1 & 3: đáp án (và lời giải) ở cuối đề. */
export function composeEnd(md, sols, { keyOnly }) {
  let out = md.replace(/\s+$/, '') + '\n\n' + SOL_START + '\n';
  out += '**ĐÁP ÁN' + (keyOnly ? '' : ' VÀ LỜI GIẢI') + '**\n\n' + keyTables(sols) + '\n';
  if (!keyOnly) {
    out += '\n**LỜI GIẢI CHI TIẾT**\n';
    let lastP = 0;
    const multi = new Set(sols.map(s => s.p)).size > 1;
    for (const s of sols) {
      if (multi && s.p !== lastP) { out += `\n**PHẦN ${ROMAN_OF[s.p] || s.p}.**\n`; lastP = s.p; }
      out += `\n**Câu ${s.c}.** ${s.body ? '' : answerLine(s)}\n`;
      if (s.body) out += s.body + (hasChoice(s) || isTF(s.ans) || !s.ans ? '' : '\n' + answerLine(s)) + '\n';
    }
  }
  return out;
}

/** Cách 2: chèn lời giải ngay sau mỗi câu; câu không khớp được đưa xuống cuối đề. */
export function composeInline(md, sols) {
  const lines = md.split('\n');
  const starts = [];            // {line, p, c}
  let p = 1, sawPart = false;
  lines.forEach((l, i) => {
    const pm = l.match(PART_RE);
    if (pm) { p = ROMAN[pm[1].toUpperCase()] || +pm[1] || p; sawPart = true; starts.push({ line: i, part: true }); }
    const qm = l.match(Q_RE);
    if (qm) starts.push({ line: i, p: sawPart ? p : 1, c: +qm[1] });
  });
  const block = s => [LG_OPEN, `**Lời giải.** ${s.body ? '' : answerLine(s)}`.trim(), s.body, s.body && !hasChoice(s) && !isTF(s.ans) ? answerLine(s) : '', LG_CLOSE].filter(Boolean).join('\n');
  const inserts = new Map();   // line index → text to insert before it
  const used = new Set();
  starts.forEach((st, k) => {
    if (st.part) return;
    const s = sols.find(x => x.p === st.p && x.c === st.c && !used.has(x));
    if (!s) return;
    used.add(s);
    let end = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    while (end - 1 > st.line && (!lines[end - 1].trim() || /^<!--\s*Trang/i.test(lines[end - 1].trim()))) end--;
    inserts.set(end, (inserts.get(end) || '') + block(s) + '\n');
  });
  const out = [];
  for (let i = 0; i <= lines.length; i++) {
    if (inserts.has(i)) out.push(inserts.get(i).replace(/\n$/, ''));
    if (i < lines.length) out.push(lines[i]);
  }
  const rest = sols.filter(s => !used.has(s));
  let md2 = out.join('\n');
  if (rest.length) md2 = composeEnd(md2, rest, { keyOnly: false });
  return { md: md2, unmatched: rest.length };
}

/**
 * Tách nội dung khung Markdown thành 2 file: đề sạch và đáp án.
 * - Lời giải chèn sau mỗi câu → file đáp án là bản đề kèm lời giải (bản giáo viên).
 * - Đáp án/lời giải cuối đề → file đáp án chỉ gồm phần đáp án, lời giải.
 * answer = null khi chưa có lời giải.
 */
export function splitExamAnswer(md) {
  const exam = stripSolutions(md);
  const hasInline = md.includes(LG_OPEN);
  const k = md.indexOf(SOL_START);
  if (!hasInline && k < 0) return { exam: md, answer: null };
  const answer = hasInline ? '**BẢN ĐỀ CÓ LỜI GIẢI**\n\n' + md : md.slice(k);
  return { exam, answer };
}
