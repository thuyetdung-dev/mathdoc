// Gemini calls. Two connection modes:
//  - personal: browser → Google directly with the teacher's own key(s), rotating on quota errors
//  - school:   browser → /api/gemini on our Vercel project (key kept in env vars, guarded by an access code)
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export const AUTO_CHAIN = ['gemini-2.5-flash', 'gemini-2.0-flash'];

function filterModels(list) {
  return (list || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/embedding|tts|image|live|audio|robotics/i.test(m.name))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, ''), out: m.outputTokenLimit }))
    .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
}

async function readError(r) {
  let msg = `HTTP ${r.status}`;
  try { const j = await r.json(); msg = `${r.status} ${j.error?.status || ''}: ${j.error?.message || j.message || ''}`; } catch {}
  return new Error(msg);
}

export async function listModels(conn) {
  if (conn.mode === 'school') {
    const r = await fetch('/api/models', { headers: { 'x-access-code': conn.code } });
    if (!r.ok) throw await readError(r);
    return filterModels((await r.json()).models);
  }
  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': conn.keys[0] } });
  if (!r.ok) throw await readError(r);
  return filterModels((await r.json()).models);
}

/** Pick a sensible default from a scanned list: newest stable "flash" (not lite), else first. */
export function pickAuto(models) {
  const stable = models.filter(m => /^gemini-\d+(\.\d+)?-flash$/.test(m.id));
  if (stable.length) return stable[0].id;
  const flash = models.find(m => /flash/.test(m.id) && !/lite|preview|exp/.test(m.id));
  return (flash || models[0])?.id;
}

const RETRY_KEY = /429|RESOURCE_EXHAUSTED|quota|rate|API key|API_KEY|PERMISSION_DENIED|403|401/i;
const MODEL_MISSING = /404|NOT_FOUND|not found|is not supported|no longer available/i;

async function streamOnce({ conn, key, model, body, onText, signal }) {
  const r = conn.mode === 'school'
    ? await fetch('/api/gemini', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-access-code': conn.code },
        body: JSON.stringify({ model, body }),
      })
    : await fetch(`${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
  if (!r.ok) throw await readError(r);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', finish = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      if (j.error) throw new Error(`${j.error.code || ''} ${j.error.status || ''}: ${j.error.message}`);
      const c = j.candidates?.[0];
      const t = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (t) { text += t; onText?.(text); }
      if (c?.finishReason) finish = c.finishReason;
      if (j.promptFeedback?.blockReason) throw new Error('Nội dung bị chặn: ' + j.promptFeedback.blockReason);
    }
  }
  if (!text.trim()) throw new Error(`Gemini không trả về nội dung (finishReason: ${finish || 'không rõ'}).`);
  return { text, finishReason: finish };
}

/**
 * models: list of model ids to try in order (auto mode passes a chain).
 * Returns {text, finishReason, keyIndex, model}.
 */
export async function generate({ conn, models, parts, maxOutputTokens, onText, onLog, signal }) {
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.1, ...(maxOutputTokens ? { maxOutputTokens } : {}) },
  };
  const keys = conn.mode === 'school' ? [null] : conn.keys;
  let lastErr;
  for (const model of models) {
    for (let k = 0; k < keys.length; k++) {
      try {
        const res = await streamOnce({ conn, key: keys[k], model, body, onText, signal });
        return { ...res, keyIndex: k, model };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        const who = conn.mode === 'school' ? 'Khoá chung' : `Khoá #${k + 1}`;
        onLog?.(`${who} · ${model}: ${e.message}`);
        if (MODEL_MISSING.test(e.message)) break;               // try next model
        if (RETRY_KEY.test(e.message) && k < keys.length - 1) { onLog?.(`→ Chuyển sang khoá dự phòng #${k + 2}`); continue; }
        throw e;
      }
    }
    if (models.length > 1) onLog?.(`→ Thử mô hình khác`);
  }
  throw lastErr || new Error('Không gọi được Gemini.');
}

/** Ask Gemini to re-locate figures on one page image; returns [{id, box}] */
export async function relocate({ conn, model, pageDataUrl, figures, signal }) {
  const prompt = `Đây là ảnh MỘT trang tài liệu. Hãy xác định hộp bao chính xác của từng hình vẽ/biểu đồ/bảng biến thiên được mô tả dưới đây.
Trả về DUY NHẤT một mảng JSON dạng [{"id":1,"box_2d":[ymin,xmin,ymax,xmax]}], toạ độ là số nguyên thang 0..1000 trên toàn trang. Hộp phải bao trọn hình (cả nhãn, chú thích chữ trong hình) nhưng không lấn sang đoạn văn bản xung quanh.
Danh sách hình:
${figures.map(f => `- id ${f.id}: ${f.alt || 'hình'} (vị trí gợi ý ${f.box.join(',')})`).join('\n')}`;
  const { text } = await generate({
    conn, models: [model], signal,
    parts: [{ inline_data: { mime_type: 'image/jpeg', data: pageDataUrl.split(',')[1] } }, { text: prompt }],
  });
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).filter(o => Array.isArray(o.box_2d) && o.box_2d.length === 4).map(o => ({ id: +o.id, box: o.box_2d.map(Number) }));
  } catch { return []; }
}
