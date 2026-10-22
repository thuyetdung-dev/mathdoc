// Test whether a Gemini API key works right now. Pure fetch – used in the browser and in /api/keycheck.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function maskKey(k) {
  if (!k) return '';
  return k.length <= 12 ? k.slice(0, 4) + '…' : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

function parseError(status, j) {
  const e = j?.error || {};
  const msg = e.message || '';
  const details = e.details || [];
  const quota = details.find(d => /QuotaFailure/.test(d['@type'] || ''));
  const retry = details.find(d => /RetryInfo/.test(d['@type'] || ''));
  const reason = details.find(d => /ErrorInfo/.test(d['@type'] || ''))?.reason || '';
  const quotaIds = (quota?.violations || []).map(v => v.quotaId || v.quotaMetric || '').join(' ');
  const retrySec = retry?.retryDelay ? parseFloat(retry.retryDelay) : null;

  if (status === 429 || e.status === 'RESOURCE_EXHAUSTED') {
    if (/PerDay|per_day|daily/i.test(quotaIds + msg)) return { code: 'quota_day', label: 'Hết lượt trong ngày', detail: 'Hạn mức ngày đã dùng hết, thường hồi lại vào khoảng 14–15 giờ chiều (giờ Việt Nam).', retrySec };
    if (/PerMinute|per_minute|minute/i.test(quotaIds + msg)) return { code: 'quota_min', label: 'Tạm hết lượt/phút', detail: `Gọi quá nhanh${retrySec ? `, thử lại sau ${Math.ceil(retrySec)} giây` : ''}.`, retrySec };
    if (/limit: 0|limit:0/i.test(msg)) return { code: 'no_quota', label: 'Không có hạn mức', detail: 'Khoá này không được cấp lượt dùng cho mô hình đã chọn (thường do vùng hoặc dự án chưa bật thanh toán).' };
    return { code: 'quota', label: 'Hết lượt', detail: msg.slice(0, 160), retrySec };
  }
  if (reason === 'API_KEY_INVALID' || /API key not valid|API_KEY_INVALID/i.test(msg)) return { code: 'invalid', label: 'Khoá sai', detail: 'Khoá không tồn tại hoặc đã bị xoá.' };
  if (/expired/i.test(msg)) return { code: 'expired', label: 'Khoá hết hạn', detail: msg.slice(0, 160) };
  if (/leaked|reported as leaked/i.test(msg)) return { code: 'leaked', label: 'Khoá bị khoá', detail: 'Google đã khoá vì khoá bị lộ công khai. Hãy tạo khoá mới.' };
  if (reason === 'SERVICE_DISABLED' || /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) return { code: 'disabled', label: 'Chưa bật Gemini API', detail: 'Dự án chứa khoá chưa bật Generative Language API.' };
  if (/location is not supported|User location/i.test(msg)) return { code: 'region', label: 'Vùng không hỗ trợ', detail: msg.slice(0, 160) };
  if (status === 403 || e.status === 'PERMISSION_DENIED') return { code: 'denied', label: 'Bị từ chối', detail: msg.slice(0, 160) };
  if (status === 404) return { code: 'model', label: 'Mô hình không dùng được', detail: msg.slice(0, 160) };
  if (status >= 500) return { code: 'server', label: 'Google đang lỗi', detail: 'Lỗi phía Google, thử lại sau ít phút.' };
  return { code: 'error', label: `Lỗi ${status || ''}`.trim(), detail: msg.slice(0, 160) || 'Không rõ nguyên nhân.' };
}

function pickTestModel(ids) {
  const stable = ids.filter(id => /^gemini-\d+(\.\d+)?-flash$/.test(id)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return stable[0] || ids.find(id => /flash/.test(id) && !/preview|exp/.test(id)) || ids[0] || 'gemini-2.5-flash';
}

/**
 * Two steps: (1) list models – proves the key exists and the API is on;
 * (2) a tiny generateContent call – proves there is quota left right now.
 * Returns {ok, code, label, detail, models, testModel, ms}.
 */
export async function checkKey(key, { model, fetchImpl = fetch, signal } = {}) {
  const t0 = Date.now();
  let ids = [];
  try {
    const r = await fetchImpl(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key }, signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, ...parseError(r.status, j), models: 0, ms: Date.now() - t0 };
    ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name))
      .map(m => m.name.replace(/^models\//, ''));
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { ok: false, code: 'network', label: 'Lỗi mạng', detail: String(e.message || e), models: 0, ms: Date.now() - t0 };
  }
  const testModel = model && model !== 'auto' ? model : pickTestModel(ids);
  try {
    const r = await fetchImpl(`${BASE}/models/${encodeURIComponent(testModel)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Trả lời đúng một chữ: OK' }] }], generationConfig: { maxOutputTokens: 64, temperature: 0 } }),
    });
    const j = await r.json().catch(() => ({}));
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ...parseError(r.status, j), models: ids.length, testModel, ms };
    return { ok: true, code: 'ok', label: 'Dùng được', detail: `Gọi thử ${testModel} thành công.`, models: ids.length, testModel, ms };
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return { ok: false, code: 'network', label: 'Lỗi mạng', detail: String(e.message || e), models: ids.length, testModel, ms: Date.now() - t0 };
  }
}

/** Run checks with limited parallelism; onResult(index, result) as each finishes. */
export async function checkMany(keys, opts = {}, onResult) {
  const out = new Array(keys.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.parallel || 3, keys.length) }, async () => {
    while (next < keys.length) {
      const i = next++;
      out[i] = await checkKey(keys[i], opts);
      onResult?.(i, out[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
