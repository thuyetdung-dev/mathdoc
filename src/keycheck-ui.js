// "Kiểm tra khoá" dialog: test many Gemini keys, keep the working ones.
import { checkMany, maskKey } from './keycheck-core.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function initKeyCheck(ctx) {
  const dlg = $('#keyDialog');
  let results = [];      // [{key, res}]
  let abort = null;

  const split = t => [...new Set(t.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean))];

  function open() {
    const school = ctx.mode() === 'school';
    $('#kcPersonal').hidden = school;
    $('#kcSchool').hidden = !school;
    if (!school) $('#kcInput').value = ctx.getKeys().join('\n');
    results = [];
    renderTable(); renderSummary();
    dlg.showModal();
    if (!school) $('#kcInput').focus();
  }

  function badge(r) {
    if (!r) return '<span class="kc-badge wait">Đang kiểm tra…</span>';
    const cls = r.code === 'busy' ? 'warn' : r.ok ? 'ok' : (/quota_min|server|network/.test(r.code) ? 'warn' : 'bad');
    return `<span class="kc-badge ${cls}">${esc(r.label)}</span>`;
  }

  function renderTable() {
    const tb = $('#kcTable tbody');
    if (!results.length) { tb.innerHTML = '<tr><td colspan="5" class="kc-empty">Chưa có kết quả.</td></tr>'; return; }
    tb.innerHTML = results.map((x, i) => `<tr>
      <td>${i + 1}</td>
      <td class="kc-key">${esc(x.masked)}</td>
      <td>${badge(x.res)}</td>
      <td class="kc-detail">${x.res ? esc(x.res.detail) + (x.res.models ? ` <span class="kc-dim">· ${x.res.models} mô hình</span>` : '') : ''}</td>
      <td class="kc-ms">${x.res ? (x.res.ms / 1000).toFixed(1) + ' s' : ''}</td></tr>`).join('');
  }

  function renderSummary() {
    const done = results.filter(x => x.res);
    const good = done.filter(x => x.res.ok);
    $('#kcSummary').textContent = !results.length ? ''
      : done.length < results.length ? `Đã kiểm tra ${done.length}/${results.length} khoá…`
      : `${good.length}/${results.length} khoá dùng được.`;
    const canApply = !ctx.mode().startsWith('school') && done.length === results.length && results.length > 0;
    $('#kcApply').disabled = !(canApply && good.length);
    $('#kcCopy').disabled = !(canApply && good.length);
    $('#kcRemoveBad').disabled = !(canApply && good.length < results.length);
  }

  async function runPersonal() {
    const keys = split($('#kcInput').value);
    if (!keys.length) return ctx.toast('Dán ít nhất một khoá để kiểm tra.');
    if (keys.length > 50) return ctx.toast('Mỗi lần kiểm tra tối đa 50 khoá.');
    results = keys.map(k => ({ key: k, masked: maskKey(k), res: null }));
    renderTable(); renderSummary();
    abort = new AbortController();
    $('#kcRun').disabled = true; $('#kcStop').hidden = false;
    try {
      await checkMany(keys, { model: ctx.model(), parallel: 3, signal: abort.signal }, (i, r) => {
        results[i].res = r; renderTable(); renderSummary();
      });
      const good = results.filter(x => x.res?.ok).length;
      ctx.log(`Kiểm tra khoá: ${good}/${keys.length} khoá dùng được.`, good ? 'ok' : 'err');
    } catch (e) {
      if (e.name !== 'AbortError') ctx.log('Kiểm tra khoá lỗi: ' + e.message, 'err');
    } finally { $('#kcRun').disabled = false; $('#kcStop').hidden = true; abort = null; }
  }

  async function runSchool() {
    const code = ctx.code();
    if (!code) return ctx.toast('Nhập mã truy cập của tổ trước.');
    results = [{ key: '', masked: 'Đang hỏi máy chủ…', res: null }];
    renderTable(); renderSummary();
    $('#kcRunSchool').disabled = true;
    try {
      const m = ctx.model();
      const r = await fetch('/api/keycheck' + (m && m !== 'auto' ? `?model=${encodeURIComponent(m)}` : ''), { headers: { 'x-access-code': code } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
      results = j.results.map(x => ({ key: '', masked: x.key, res: x }));
      const good = results.filter(x => x.res.ok).length;
      ctx.log(`Khoá chung: ${good}/${results.length} khoá dùng được.`, good ? 'ok' : 'err');
    } catch (e) {
      results = [];
      ctx.toast(e.message);
      ctx.log('Kiểm tra khoá chung lỗi: ' + e.message, 'err');
    } finally { $('#kcRunSchool').disabled = false; renderTable(); renderSummary(); }
  }

  // Working keys first: "ok" sorted by speed; then temporary problems (per-minute quota) which may recover.
  function goodKeys() {
    return results.filter(x => x.res?.ok).sort((a, b) => ((a.res.code === 'busy') - (b.res.code === 'busy')) || (a.res.ms - b.res.ms)).map(x => x.key);
  }

  $('#btnKeyCheck').addEventListener('click', open);
  $('#btnKeyCheckSchool').addEventListener('click', () => { open(); runSchool(); });
  $('#kcRun').addEventListener('click', runPersonal);
  $('#kcRunSchool').addEventListener('click', runSchool);
  $('#kcStop').addEventListener('click', () => abort?.abort());
  $('#kcClose').addEventListener('click', () => { abort?.abort(); dlg.close(); });
  dlg.addEventListener('close', () => abort?.abort());
  $('#kcApply').addEventListener('click', () => {
    const g = goodKeys();
    ctx.setKeys(g);
    ctx.toast(`Đã dùng ${g.length} khoá tốt: khoá nhanh nhất làm khoá chính, còn lại làm dự phòng.`);
    ctx.log(`Đã sắp xếp lại khoá: ${g.map(maskKey).join(', ')}`, 'ok');
    dlg.close();
  });
  $('#kcRemoveBad').addEventListener('click', () => {
    const keepTemp = results.filter(x => x.res && (x.res.ok || x.res.code === 'quota_min')).sort((a, b) => (b.res.ok - a.res.ok) || (a.res.ms - b.res.ms)).map(x => x.key);
    $('#kcInput').value = keepTemp.join('\n');
    results = results.filter(x => keepTemp.includes(x.key));
    renderTable(); renderSummary();
    ctx.toast('Đã bỏ các khoá hỏng khỏi danh sách (giữ khoá chỉ tạm hết lượt/phút).');
  });
  $('#kcCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(goodKeys().join('\n')); ctx.toast('Đã sao chép các khoá dùng được'); }
    catch { ctx.toast('Trình duyệt chặn sao chép'); }
  });
}
