import { checkAccess, serverKeys } from './_shared.js';

export const config = { maxDuration: 300 };

const RETRY = /429|RESOURCE_EXHAUSTED|quota|rate/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!checkAccess(req, res)) return;
  const { model, body } = req.body || {};
  if (!model || !/^[\w.\-]+$/.test(model) || !body?.contents) {
    return res.status(400).json({ error: { status: 'INVALID_ARGUMENT', message: 'Thiếu model hoặc nội dung.' } });
  }
  const keys = serverKeys();
  let last = null;
  for (let k = 0; k < keys.length; k++) {
    const up = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys[k] },
      body: JSON.stringify(body),
    });
    if (!up.ok) {
      last = { status: up.status, text: await up.text() };
      if (RETRY.test(last.text) && k < keys.length - 1) continue;
      res.status(last.status).setHeader('Content-Type', 'application/json');
      return res.end(last.text);
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    for await (const chunk of up.body) res.write(chunk);
    return res.end();
  }
  res.status(last?.status || 500).end(last?.text || '');
}
