import { checkAccess, serverKeys } from './_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!checkAccess(req, res)) return;
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
    headers: { 'x-goog-api-key': serverKeys()[0] },
  });
  const j = await r.json().catch(() => ({}));
  res.status(r.status).json(r.ok ? { models: j.models || [] } : j);
}
