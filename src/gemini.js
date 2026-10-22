// Gemini REST calls (browser fetch) with streaming + key rotation.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function listModels(key) {
  const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini/i.test(m.name) && !/embedding|tts|image|live|audio/i.test(m.name))
    .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name, out: m.outputTokenLimit }))
    .sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true }));
}

const RETRY_KEY = /429|RESOURCE_EXHAUSTED|quota|rate|API key|API_KEY|PERMISSION_DENIED|403|401/i;

/**
 * parts: Gemini content parts. onText(fullText) called while streaming.
 * Returns {text, finishReason, keyIndex}.
 */
export async function generate({ keys, model, parts, maxOutputTokens, onText, onLog, signal }) {
  let lastErr;
  for (let k = 0; k < keys.length; k++) {
    const key = keys[k];
    try {
      const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.1, ...(maxOutputTokens ? { maxOutputTokens } : {}) },
      };
      const r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { const j = await r.json(); msg = `${r.status} ${j.error?.status || ''}: ${j.error?.message || ''}`; } catch {}
        throw new Error(msg);
      }
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
          if (j.error) throw new Error(j.error.message);
          const c = j.candidates?.[0];
          const t = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
          if (t) { text += t; onText?.(text); }
          if (c?.finishReason) finish = c.finishReason;
          if (j.promptFeedback?.blockReason) throw new Error('Nội dung bị chặn: ' + j.promptFeedback.blockReason);
        }
      }
      if (!text.trim()) throw new Error(`Gemini không trả về nội dung (finishReason: ${finish || 'không rõ'}).`);
      return { text, finishReason: finish, keyIndex: k };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      onLog?.(`Key #${k + 1} lỗi: ${e.message}`);
      if (!(RETRY_KEY.test(e.message) && k < keys.length - 1)) break;
      onLog?.(`→ Chuyển sang key #${k + 2}`);
    }
  }
  throw lastErr || new Error('Không gọi được Gemini.');
}

/** Ask Gemini to re-locate figures on one page image; returns [{id, ymin,xmin,ymax,xmax}] */
export async function relocate({ keys, model, pageDataUrl, figures, signal }) {
  const prompt = `Đây là ảnh MỘT trang tài liệu. Hãy xác định hộp bao chính xác của từng hình vẽ/biểu đồ/bảng biến thiên được mô tả dưới đây.
Trả về DUY NHẤT một mảng JSON dạng [{"id":1,"box_2d":[ymin,xmin,ymax,xmax]}], toạ độ là số nguyên thang 0..1000 trên toàn trang. Hộp phải bao trọn hình (cả nhãn, chú thích chữ trong hình) nhưng không lấn sang đoạn văn bản xung quanh.
Danh sách hình:
${figures.map(f => `- id ${f.id}: ${f.alt || 'hình'} (vị trí gợi ý ${f.box.join(',')})`).join('\n')}`;
  const { text } = await generate({
    keys, model, signal,
    parts: [{ inline_data: { mime_type: 'image/jpeg', data: pageDataUrl.split(',')[1] } }, { text: prompt }],
  });
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    return JSON.parse(m[0]).filter(o => Array.isArray(o.box_2d) && o.box_2d.length === 4).map(o => ({ id: +o.id, box: o.box_2d.map(Number) }));
  } catch { return []; }
}
