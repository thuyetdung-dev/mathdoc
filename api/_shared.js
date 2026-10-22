// Shared helpers for the "khoá chung của tổ" mode. Keys live only in Vercel env vars.
//   GEMINI_API_KEY       one key, or several separated by commas (rotated on quota errors)
//   MATHDOC_ACCESS_CODE  access code teachers must enter (required; the endpoint is closed without it)
export function serverKeys() {
  return (process.env.GEMINI_API_KEY || '').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
}

export function checkAccess(req, res) {
  const code = process.env.MATHDOC_ACCESS_CODE || '';
  if (!serverKeys().length) {
    res.status(503).json({ error: { status: 'NOT_CONFIGURED', message: 'Máy chủ chưa có khoá chung. Quản trị cần thêm biến môi trường GEMINI_API_KEY trên Vercel.' } });
    return false;
  }
  if (!code) {
    res.status(503).json({ error: { status: 'NOT_CONFIGURED', message: 'Chưa đặt mã truy cập. Quản trị cần thêm biến môi trường MATHDOC_ACCESS_CODE trên Vercel.' } });
    return false;
  }
  const given = String(req.headers['x-access-code'] || '');
  if (given.length !== code.length || !timingSafeEqual(given, code)) {
    res.status(401).json({ error: { status: 'UNAUTHENTICATED', message: 'Mã truy cập của tổ không đúng.' } });
    return false;
  }
  return true;
}

function timingSafeEqual(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
