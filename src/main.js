import temml from 'temml';
import { parseBlocks } from './md.js';
import { buildDocx } from './docx.js';
import { listModels, generate, relocate, pickAuto, fallbackChain } from './gemini.js';
import { initKeyCheck } from './keycheck-ui.js';
import { openPdf, renderPdfPage, fileToDataUrl, imageFileToCanvas, canvasToJpeg, cropBox } from './pages.js';

const $ = s => document.querySelector(s);
const LS = {
  get(k, d = '') { try { return localStorage.getItem('mathdoc_' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mathdoc_' + k, v); } catch {} },
  del(k) { try { localStorage.removeItem('mathdoc_' + k); } catch {} },
};

const PROMPT_PDF = `Bạn là chuyên gia số hoá đề thi, tài liệu Toán THPT Việt Nam. Hãy OCR toàn bộ tài liệu thành MỘT văn bản Markdown để xuất sang Word.

QUY TẮC BẮT BUỘC
1. Đọc lần lượt từng trang. Đầu mỗi trang ghi một dòng riêng: <!-- Trang N --> (N bắt đầu từ 1).
2. Chép NGUYÊN VĂN: tiêu đề, đoạn văn, số câu, phương án A. B. C. D., ý a) b) c) d). Không giải bài, không sửa đề, không thêm lời bình. Giữ đúng chính tả tiếng Việt.
3. Mỗi phương án/ý nằm trên một dòng riêng nếu trong đề chúng xuống dòng; nếu nhiều phương án trên cùng một dòng thì ngăn cách bằng ký tự TAB.
4. Mọi biểu thức toán (kể cả số đơn lẻ có dấu, toạ độ, vectơ, đơn vị kèm số mũ) viết bằng LaTeX: trong dòng dùng $...$, công thức đứng riêng dòng dùng $$...$$. Dùng \\dfrac cho phân số lớn, \\overrightarrow{AB} cho vectơ, \\widehat{ABC} cho góc, \\begin{cases}...\\end{cases} cho hệ, \\left[\\begin{array}{l}...\\end{array}\\right. cho tuyển. Không dùng \\( \\) hay \\[ \\].
5. Bảng (kể cả bảng số liệu, bảng biến thiên đơn giản dạng lưới) viết bằng bảng Markdown có dấu |, giữ đủ hàng, cột, ô trống; nội dung xuống dòng trong ô dùng <br>. Không dùng HTML table.
6. Hình vẽ, đồ thị, biểu đồ, bảng biến thiên có mũi tên, sơ đồ: đặt trên MỘT DÒNG RIÊNG đúng vị trí của nó trong đề:
   [[HINH:trang,ymin,xmin,ymax,xmax|mô tả ngắn]]
   trong đó toạ độ là số nguyên thang 0..1000 tính trên TOÀN trang (góc trên-trái (0,0), góc dưới-phải (1000,1000)), thứ tự y trước x. Hộp phải bao trọn hình và nhãn trong hình. Không đánh dấu logo, chữ ký, watermark, số trang, khung trang trí.
7. In đậm bằng **...** cho những chữ in đậm trong đề (ví dụ **Câu 1.**, **PHẦN I.**).
8. OCR đủ mọi trang được yêu cầu, không bỏ trang, không viết "..." thay cho nội dung. Không bọc kết quả trong \`\`\`. Chỉ trả về Markdown.`;

const PROMPT_IMG_EXTRA = `Các ảnh được gửi theo thứ tự trang (ảnh thứ k là trang k). Toạ độ hình tính trên chính ảnh trang đó.`;

const state = {
  files: [], kind: null, pdfDoc: null, pageCanvases: new Map(),
  images: new Map(), markdown: '', busy: false, abort: null, t0: 0, models: [],
};

// ---------------- UI helpers ----------------
function log(msg, cls = '') {
  const el = document.createElement('div');
  el.className = 'log-line ' + cls;
  el.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`;
  $('#log').prepend(el);
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function setBusy(b, label) {
  state.busy = b;
  $('#btnRun').disabled = b; $('#btnStop').hidden = !b;
  $('#progress').hidden = !b;
  if (label) $('#progressLabel').textContent = label;
}
function keyMode() { return document.querySelector('input[name="keyMode"]:checked').value; }
function keys() {
  return [$('#key1').value, ...$('#keysBackup').value.split(/[\s,;]+/)].map(x => x.trim()).filter(Boolean);
}
/** Connection for gemini.js, or null (with a toast) when nothing has been entered. */
function connection() {
  if (keyMode() === 'school') {
    const code = $('#accessCode').value.trim();
    if (!code) { toast('Nhập mã truy cập của tổ.'); return null; }
    return { mode: 'school', code };
  }
  const ks = keys();
  if (!ks.length) { toast('Hãy dán khoá API Gemini, hoặc chọn “Khoá chung của tổ”.'); return null; }
  return { mode: 'personal', keys: ks };
}
/** Model ids to try: the chosen one, or an automatic chain. */
function modelChain() {
  const v = $('#modelSel').value;
  const first = v && v !== 'auto' ? v : (state.models.length ? pickAuto(state.models) : null);
  return fallbackChain(first, state.models);
}
function setKeyStatus(stateName, text) {
  const el = $('#keyStatus'); el.dataset.state = stateName; el.querySelector('.txt').textContent = text;
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const fmtSize = n => n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

// ---------------- settings ----------------
function initSettings() {
  const mem = { get: k => { try { return sessionStorage.getItem('mathdoc_' + k) || ''; } catch { return ''; } },
                set: (k, v) => { try { v ? sessionStorage.setItem('mathdoc_' + k, v) : sessionStorage.removeItem('mathdoc_' + k); } catch {} } };
  $('#remember').checked = LS.get('remember', '0') === '1';
  const src = $('#remember').checked ? LS.get : mem.get;
  $('#key1').value = src('key1'); $('#keysBackup').value = src('keysBackup');
  $('#accessCode').value = mem.get('code') || LS.get('code');
  const mode = LS.get('keyMode', 'personal');
  document.querySelector(`input[name="keyMode"][value="${mode}"]`).checked = true;
  $('#fontName').value = LS.get('font', 'Times New Roman');
  $('#fontSize').value = LS.get('fsize', '12');
  const savedModel = LS.get('model', 'auto');
  if (savedModel !== 'auto') $('#modelSel').insertAdjacentHTML('beforeend', `<option value="${savedModel}">${savedModel}</option>`);
  $('#modelSel').value = savedModel;

  const updateBackupCount = () => {
    const n = $('#keysBackup').value.split(/[\s,;]+/).filter(Boolean).length;
    $('#backupCount').textContent = n ? `(${n})` : '';
  };
  const save = () => {
    const remember = $('#remember').checked;
    LS.set('remember', remember ? '1' : '0');
    for (const k of ['key1', 'keysBackup']) {
      if (remember) { LS.set(k, $('#' + k).value); mem.set(k, ''); }
      else { LS.del(k); mem.set(k, $('#' + k).value); }
    }
    mem.set('code', $('#accessCode').value);
    LS.set('model', $('#modelSel').value);
    LS.set('font', $('#fontName').value); LS.set('fsize', $('#fontSize').value);
    updateBackupCount();
  };
  ['#key1', '#keysBackup', '#remember', '#accessCode', '#modelSel', '#fontName', '#fontSize'].forEach(sel => $(sel).addEventListener('change', save));
  $('#key1').addEventListener('input', () => setKeyStatus('idle', 'Chưa kiểm tra kết nối — bấm “Dò”'));
  updateBackupCount();

  const applyMode = () => {
    const m = keyMode();
    $('#personalBox').hidden = m !== 'personal';
    $('#schoolBox').hidden = m !== 'school';
    $('#privacyNote').textContent = m === 'school'
      ? 'Tài liệu được gửi qua máy chủ Vercel của tổ rồi tới Google. Máy chủ không lưu tài liệu.'
      : 'Khoá chỉ giữ trong phiên làm việc này (trừ khi bật “Ghi nhớ”) và được gửi thẳng tới Google; không đi qua máy chủ nào khác.';
    if (m === 'school') $('#refImages').checked = false;
    LS.set('keyMode', m);
    state.models = []; resetModelList();
    setKeyStatus('idle', 'Chưa kiểm tra kết nối — bấm “Dò”');
  };
  document.querySelectorAll('input[name="keyMode"]').forEach(r => r.addEventListener('change', applyMode));
  applyMode();

  const toggle = (inp, btn, what) => () => {
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Ẩn' : 'Hiện';
    btn.setAttribute('aria-label', `${show ? 'Ẩn' : 'Hiện'} ${what}`);
  };
  $('#showKey1').addEventListener('click', toggle($('#key1'), $('#showKey1'), 'khoá API'));
  $('#showCode').addEventListener('click', toggle($('#accessCode'), $('#showCode'), 'mã truy cập'));
  $('#clearKey1').addEventListener('click', () => {
    $('#key1').value = ''; $('#key1').type = 'password'; $('#showKey1').textContent = 'Hiện';
    save(); state.models = []; resetModelList();
    setKeyStatus('idle', 'Đã xoá khoá khỏi phiên này');
    toast('Đã xoá khoá Gemini khỏi phiên này');
  });
  $('#btnScan').addEventListener('click', scanModels);
  initKeyCheck({
    mode: keyMode, code: () => $('#accessCode').value.trim(), model: () => $('#modelSel').value,
    getKeys: keys, log, toast,
    setKeys: list => {
      $('#key1').value = list[0] || ''; $('#keysBackup').value = list.slice(1).join('\n');
      save(); setKeyStatus('ok', `${list.length} khoá dùng được · khoá chính ${list[0] ? list[0].slice(0, 6) + '…' + list[0].slice(-4) : '—'}`);
    },
  });
}

function resetModelList() {
  const keep = $('#modelSel').value;
  $('#modelSel').innerHTML = '<option value="auto">Tự động chọn mô hình</option>' +
    state.models.map(m => `<option value="${m.id}">${m.label}${m.label !== m.id ? ' · ' + m.id : ''}</option>`).join('');
  $('#modelSel').value = [...$('#modelSel').options].some(o => o.value === keep) ? keep : 'auto';
}

async function scanModels() {
  const conn = connection();
  if (!conn) return;
  setKeyStatus('busy', 'Đang kiểm tra…');
  $('#btnScan').disabled = true;
  try {
    state.models = await listModels(conn);
    resetModelList();
    const auto = pickAuto(state.models);
    setKeyStatus('ok', `Đã kết nối ${state.models.length} mô hình · tự động dùng ${auto || '—'}`);
    log(`Kết nối thành công (${conn.mode === 'school' ? 'khoá chung' : 'khoá cá nhân'}): ${state.models.length} mô hình.`, 'ok');
  } catch (e) {
    state.models = []; resetModelList();
    const msg = /401|UNAUTHENTICATED/.test(e.message) ? 'Mã truy cập không đúng'
      : /API key|API_KEY|400|403/.test(e.message) ? 'Khoá không hợp lệ hoặc chưa bật Gemini API'
      : /NOT_CONFIGURED|503/.test(e.message) ? 'Máy chủ chưa cấu hình khoá chung'
      : 'Không kết nối được';
    setKeyStatus('err', msg);
    log('Kiểm tra kết nối lỗi: ' + e.message, 'err');
  } finally { $('#btnScan').disabled = false; }
}

// ---------------- file input ----------------
function setFiles(list) {
  const arr = [...list].filter(f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name) || /^image\//.test(f.type));
  if (!arr.length) return toast('Chỉ nhận PDF hoặc ảnh PNG/JPG/WebP.');
  const pdfs = arr.filter(f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (pdfs.length) { state.files = [pdfs[0]]; state.kind = 'pdf'; if (pdfs.length > 1 || arr.length > 1) toast('Chỉ dùng 1 file PDF mỗi lần.'); }
  else { state.files = arr.slice(0, 30); state.kind = 'img'; if (arr.length > 30) toast('Tối đa 30 ảnh, đã lấy 30 ảnh đầu.'); }
  state.pdfDoc = null; state.pageCanvases.clear();
  const name = state.files[0].name.replace(/\.[^.]+$/, '');
  if (!$('#outName').dataset.touched) $('#outName').value = name;
  renderFileList();
}
function renderFileList() {
  const el = $('#fileList');
  if (!state.files.length) { el.innerHTML = ''; return; }
  el.innerHTML = state.files.map((f, i) => `<li><span class="ficon">${state.kind === 'pdf' ? 'PDF' : 'IMG'}</span><span class="fname">${i + 1}. ${f.name}</span><span class="fsize">${fmtSize(f.size)}</span></li>`).join('') +
    `<li class="fclear"><button type="button" id="btnClear" class="link">Xoá danh sách</button></li>`;
  $('#btnClear').onclick = () => { state.files = []; state.kind = null; renderFileList(); };
}
function initDrop() {
  const dz = $('#drop'), inp = $('#fileInput');
  dz.addEventListener('click', () => inp.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
  inp.addEventListener('change', () => { setFiles(inp.files); inp.value = ''; });
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => setFiles(e.dataTransfer.files));
  window.addEventListener('paste', e => {
    if (e.target.closest('textarea, input')) return;
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); setFiles(state.kind === 'img' ? [...state.files, ...fs] : fs); toast('Đã dán ảnh từ clipboard'); }
  });
  $('#outName').addEventListener('input', () => { $('#outName').dataset.touched = '1'; });
}

// ---------------- page canvases ----------------
async function getPageCanvas(n) {
  if (state.pageCanvases.has(n)) return state.pageCanvases.get(n);
  let c = null;
  if (state.kind === 'pdf') {
    if (!state.pdfDoc) state.pdfDoc = await openPdf(state.files[0]);
    if (n >= 1 && n <= state.pdfDoc.numPages) c = await renderPdfPage(state.pdfDoc, n, 2200);
  } else {
    const f = state.files[n - 1];
    if (f) c = await imageFileToCanvas(f);
  }
  state.pageCanvases.set(n, c);
  return c;
}

// ---------------- main pipeline ----------------
async function run() {
  if (!state.files.length) return toast('Chưa chọn file PDF hoặc ảnh.');
  const conn = connection();
  if (!conn) return;
  const chain = modelChain();
  let model = chain[0];
  const maxPages = Math.max(1, +$('#maxPages').value || 30);
  state.images.clear(); state.markdown = '';
  state.abort = new AbortController();
  state.t0 = performance.now();
  setBusy(true, 'Đang chuẩn bị dữ liệu…');
  $('#editor').value = ''; renderPreview(); updateStats();
  try {
    const parts = [];
    let nPages;
    if (state.kind === 'pdf') {
      const f = state.files[0];
      if (f.size > 19 * 1048576) throw new Error(`File PDF ${fmtSize(f.size)} quá lớn (giới hạn khoảng 19 MB). Hãy tách nhỏ file.`);
      state.pdfDoc = await openPdf(f);
      nPages = Math.min(state.pdfDoc.numPages, maxPages);
      parts.push({ inline_data: { mime_type: 'application/pdf', data: (await fileToDataUrl(f)).split(',')[1] } });
      if ($('#refImages').checked) {
        setBusy(true, 'Đang tạo ảnh tham chiếu các trang…');
        const lim = Math.min(nPages, 20);
        for (let p = 1; p <= lim; p++) {
          const c = await getPageCanvas(p);
          parts.push({ text: `Ảnh tham chiếu trang ${p} (dùng để xác định toạ độ hình):` });
          parts.push({ inline_data: { mime_type: 'image/jpeg', data: canvasToJpeg(c, 1200, 0.8).split(',')[1] } });
        }
      }
      log(`PDF ${state.pdfDoc.numPages} trang, OCR ${nPages} trang đầu.`);
    } else {
      nPages = Math.min(state.files.length, maxPages);
      for (let p = 1; p <= nPages; p++) {
        const c = await getPageCanvas(p);
        parts.push({ text: `Trang ${p}:` });
        parts.push({ inline_data: { mime_type: 'image/jpeg', data: canvasToJpeg(c, 2000, 0.9).split(',')[1] } });
      }
      log(`${nPages} ảnh trang.`);
    }
    const extra = $('#customPrompt').value.trim();
    parts.push({ text: [PROMPT_PDF, state.kind === 'img' ? PROMPT_IMG_EXTRA : '', `Chỉ OCR ${nPages} trang đầu.`, extra ? `YÊU CẦU BỔ SUNG CỦA GIÁO VIÊN:\n${extra}` : ''].filter(Boolean).join('\n\n') });
    const approx = JSON.stringify(parts).length;
    if (approx > 19.5 * 1048576) throw new Error('Dữ liệu gửi đi vượt ~20 MB. Hãy giảm số trang hoặc bỏ chọn “Gửi kèm ảnh tham chiếu”.');
    if (conn.mode === 'school' && approx > 4.2 * 1048576) throw new Error(`Dữ liệu ${fmtSize(approx)} vượt giới hạn ~4 MB của khoá chung. Hãy giảm số trang, bỏ “Gửi kèm ảnh tham chiếu”, hoặc dùng khoá cá nhân.`);

    setBusy(true, `Gemini (${model}) đang đọc tài liệu…`);
    let lastPaint = 0;
    const res = await generate({
      conn, models: chain, parts, signal: state.abort.signal,
      onLog: msg => { log(msg, 'warn'); if (msg.startsWith('→')) $('#progressLabel').textContent = msg.slice(2); },
      onText: t => {
        const now = performance.now();
        if (now - lastPaint > 250) { lastPaint = now; $('#editor').value = t; $('#editor').scrollTop = $('#editor').scrollHeight; $('#progressLabel').textContent = `Đang nhận kết quả… ${t.length.toLocaleString('vi-VN')} ký tự`; }
      },
    });
    let md = res.text.replace(/^```(?:markdown|md)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    model = res.model;
    log(`Gemini (${res.model}) trả về ${md.length.toLocaleString('vi-VN')} ký tự (${conn.mode === 'school' ? 'khoá chung' : 'khoá #' + (res.keyIndex + 1)}, finishReason ${res.finishReason || '—'}).`, 'ok');
    if (res.finishReason === 'MAX_TOKENS') log('Kết quả bị cắt do vượt giới hạn độ dài. Hãy giảm số trang mỗi lần.', 'err');

    md = await processFigures(md, conn, model);
    state.markdown = md;
    $('#editor').value = md;
    renderPreview(); updateStats();
    const secs = ((performance.now() - state.t0) / 1000).toFixed(0);
    log(`Hoàn tất sau ${secs} giây.`, 'ok');
    toast('Xong! Kiểm tra lại rồi bấm “Xuất Word”.');
  } catch (e) {
    if (e.name === 'AbortError') log('Đã dừng theo yêu cầu.', 'warn');
    else { log('Lỗi: ' + e.message, 'err'); toast('Có lỗi – xem nhật ký bên dưới.'); }
  } finally { setBusy(false); }
}

const FIG_RE = /\[\[\s*(?:HINH|HÌNH|IMAGE)\s*:\s*(\d+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:\|([^\]]*))?\]\]/gi;

async function processFigures(md, conn, model) {
  const figs = [];
  md.replace(FIG_RE, (all, p, a, b, c, d, alt) => { figs.push({ all, page: +p, box: [+a, +b, +c, +d], alt: (alt || '').trim() }); return all; });
  if (!figs.length) return md;
  if (!$('#cropFigures').checked) {
    return md.replace(FIG_RE, (all, p, a, b, c, d, alt) => `*[Hình: ${(alt || 'hình vẽ').trim()}]*`);
  }
  figs.forEach((f, i) => { f.id = i + 1; });
  // normalise if the model used 0..100 scale
  for (const f of figs) if (f.box.every(v => v <= 100)) f.box = f.box.map(v => v * 10);
  const byPage = new Map();
  figs.forEach(f => { if (!byPage.has(f.page)) byPage.set(f.page, []); byPage.get(f.page).push(f); });
  let k = 0;
  for (const [page, list] of byPage) {
    k++;
    setBusy(true, `Đang cắt hình trang ${page} (${k}/${byPage.size})…`);
    const c = await getPageCanvas(page);
    if (!c) { log(`Không có trang ${page} để cắt hình.`, 'warn'); continue; }
    if ($('#relocate').checked) {
      try {
        const fixed = await relocate({ conn, model, pageDataUrl: canvasToJpeg(c, 1600, 0.85), figures: list.map(f => ({ id: f.id, alt: f.alt, box: f.box })), signal: state.abort.signal });
        for (const r of fixed) { const f = list.find(x => x.id === r.id); if (f) f.box = r.box; }
        if (fixed.length) log(`Định vị lại ${fixed.length} hình ở trang ${page}.`);
      } catch (e) { if (e.name === 'AbortError') throw e; log(`Định vị lại trang ${page} lỗi, dùng toạ độ ban đầu: ${e.message}`, 'warn'); }
    }
    for (const f of list) {
      const img = cropBox(c, f.box);
      if (img) state.images.set(f.id, { ...img, alt: f.alt, page });
      else log(`Hình #${f.id} (trang ${page}) cắt ra vùng trống – giữ chỗ trống để bạn chèn tay.`, 'warn');
    }
  }
  let i = 0;
  return md.replace(FIG_RE, (all, p, a, b, c, d, alt) => { i++; return `![${(alt || 'Hình').trim().replace(/[\[\]]/g, '')}](img:${i})`; });
}

// ---------------- preview ----------------
function mathHtml(tex, display) {
  try { return temml.renderToString(tex, { displayMode: display, throwOnError: true }); }
  catch { return `<span class="math-err" title="Công thức lỗi">$${escapeHtml(tex)}$</span>`; }
}
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inlineHtml(tokens) {
  return tokens.map(t => {
    if (t.t === 'math') return mathHtml(t.tex, false);
    let h = escapeHtml(t.s).replace(/\t/g, '<span class="tab"></span>');
    if (t.b) h = `<strong>${h}</strong>`;
    if (t.i) h = `<em>${h}</em>`;
    return h;
  }).join('');
}
function renderPreview() {
  const md = $('#editor').value;
  const out = [];
  for (const b of parseBlocks(md)) {
    if (b.type === 'page') out.push(`<div class="page-mark">Trang ${b.n}</div>`);
    else if (b.type === 'heading') out.push(`<h${Math.min(b.level + 1, 4)}>${inlineHtml(b.inl)}</h${Math.min(b.level + 1, 4)}>`);
    else if (b.type === 'para') out.push(`<p>${inlineHtml(b.inl)}</p>`);
    else if (b.type === 'math') out.push(`<div class="dmath">${mathHtml(b.tex, true)}</div>`);
    else if (b.type === 'hr') out.push('<hr>');
    else if (b.type === 'image') {
      const img = state.images.get(b.id);
      out.push(img ? `<figure><img src="${img.dataUrl}" alt="${escapeHtml(b.alt)}"><figcaption>Hình ${b.id}: ${escapeHtml(b.alt)}</figcaption></figure>`
        : `<div class="img-missing">Hình ${b.id}: ${escapeHtml(b.alt)} – chưa có ảnh</div>`);
    } else if (b.type === 'table') {
      out.push('<div class="tbl-wrap"><table>' + b.rows.map((r, ri) => '<tr>' + r.map(c => `<${ri ? 'td' : 'th'}>${c.map(inlineHtml).join('<br>')}</${ri ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table></div>');
    }
  }
  $('#preview').innerHTML = out.join('') || '<div class="empty">Kết quả nhận dạng (chữ, công thức, bảng và hình đã cắt) sẽ hiện ở đây.</div>';
  renderGallery();
}
function renderGallery() {
  const g = $('#gallery');
  if (!state.images.size) { g.innerHTML = ''; g.hidden = true; return; }
  g.hidden = false;
  g.innerHTML = '<div class="gal-title">Hình đã cắt</div><div class="gal-grid">' + [...state.images.entries()].map(([id, im]) =>
    `<div class="gal-item"><img src="${im.dataUrl}" alt=""><div class="gal-meta">#${id} · trang ${im.page}</div><button class="link" data-dl="${id}">Tải PNG</button></div>`).join('') + '</div>';
  g.querySelectorAll('[data-dl]').forEach(b => b.onclick = async () => {
    const im = state.images.get(+b.dataset.dl); const blob = await (await fetch(im.dataUrl)).blob();
    download(blob, `hinh-${b.dataset.dl}.png`);
  });
}
function updateStats() {
  const md = $('#editor').value;
  const pages = (md.match(/<!--\s*Trang\s+\d+\s*-->/gi) || []).length;
  let formulas = 0;
  for (const b of parseBlocks(md)) {
    if (b.type === 'math') formulas++;
    const inl = b.inl || (b.rows ? b.rows.flat(2) : []);
    if (b.inl) formulas += b.inl.filter(t => t.t === 'math').length;
    if (b.rows) b.rows.forEach(r => r.forEach(c => c.forEach(x => formulas += x.filter(t => t.t === 'math').length)));
  }
  $('#stPages').textContent = pages; $('#stMath').textContent = formulas;
  $('#stImg').textContent = state.images.size; $('#stChars').textContent = md.length.toLocaleString('vi-VN');
}

// ---------------- export ----------------
async function exportWord() {
  const md = $('#editor').value;
  if (!md.trim()) return toast('Chưa có nội dung để xuất.');
  try {
    const { blob, stats } = await buildDocx(md, state.images, {
      fontName: $('#fontName').value, fontSize: +$('#fontSize').value || 12,
      pageBreaks: $('#pageBreaks').checked, boldHeader: true,
    });
    download(blob, ($('#outName').value.trim() || 'tai-lieu') + '.docx');
    log(`Đã xuất Word: ${stats.formulas} công thức, ${stats.images} hình, ${stats.tables} bảng.`, 'ok');
    if (stats.mathErrors.length) {
      log(`${stats.mathErrors.length} công thức lỗi cú pháp được giữ nguyên dạng chữ đỏ: ${stats.mathErrors.slice(0, 5).map(t => '$' + t + '$').join('  ')}`, 'warn');
      toast(`Đã xuất – có ${stats.mathErrors.length} công thức cần sửa tay (chữ đỏ)`);
    } else toast('Đã tải file Word');
  } catch (e) { log('Xuất Word lỗi: ' + e.message, 'err'); }
}

// ---------------- view tabs ----------------
function setView(v) {
  document.body.dataset.view = v;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v));
  LS.set('view', v);
}

function init() {
  initSettings(); initDrop();
  $('#btnRun').addEventListener('click', run);
  $('#btnStop').addEventListener('click', () => state.abort?.abort());
  $('#btnWord').addEventListener('click', exportWord);
  $('#btnMd').addEventListener('click', () => download(new Blob([$('#editor').value], { type: 'text/markdown' }), ($('#outName').value.trim() || 'tai-lieu') + '.md'));
  $('#btnCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#editor').value); toast('Đã sao chép Markdown'); } catch { toast('Trình duyệt chặn sao chép'); } });
  let t;
  $('#editor').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { renderPreview(); updateStats(); }, 300); });
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.v)));
  setView(LS.get('view', 'split'));
  $('#btnDemo').addEventListener('click', () => {
    $('#editor').value = DEMO; renderPreview(); updateStats(); toast('Đã nạp nội dung mẫu – thử bấm “Xuất Word”');
  });
  renderPreview();
}

const DEMO = `<!-- Trang 1 -->
# ĐỀ MẪU – KIỂM TRA TOÁN 12
**PHẦN I. Câu trắc nghiệm nhiều phương án lựa chọn.**
**Câu 1.** Tiệm cận ngang của đồ thị hàm số $y=\\dfrac{2x+1}{x-1}$ là
A. $y=2$.	B. $y=1$.	C. $x=1$.	D. $y=-1$.
**Câu 2.** Giá trị của tích phân $\\displaystyle\\int_0^1 (3x^2+2x)\\,dx$ bằng
A. $1$.	B. $2$.	C. $3$.	D. $4$.
**PHẦN II. Câu trắc nghiệm đúng sai.**
**Câu 3.** Cho hàm số $f(x)=x^3-3x^2+2$.
a) $f'(x)=3x^2-6x$.
b) Hàm số nghịch biến trên khoảng $(0;2)$.
**Câu 4.** Bảng xét dấu:
| $x$ | $-\\infty$ | $0$ | $2$ | $+\\infty$ |
|---|---|---|---|---|
| $f'(x)$ | $+$ | $0$ | $-$ | $0$ |
**Câu 5.** Giải hệ phương trình
$$\\begin{cases} x+y=3\\\\ x-y=1 \\end{cases}$$
`;

init();
