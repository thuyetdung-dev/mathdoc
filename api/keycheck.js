// Check the school keys stored in GEMINI_API_KEY. Returns masked keys only – never the keys themselves.
import { checkAccess, serverKeys } from './_shared.js';
import { checkMany, maskKey } from '../src/keycheck-core.js';

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!checkAccess(req, res)) return;
  const keys = serverKeys();
  const model = typeof req.query?.model === 'string' && /^[\w.\-]+$/.test(req.query.model) ? req.query.model : undefined;
  const results = await checkMany(keys, { model, parallel: 3 });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    results: results.map((r, i) => ({ index: i + 1, key: maskKey(keys[i]), ...r })),
  });
}
