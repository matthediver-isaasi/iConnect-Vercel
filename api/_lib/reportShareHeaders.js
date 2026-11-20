export function isSharedReportPage(req) {
  const headers = req.headers || {};
  const path = headers['x-original-uri'] || headers['x-vercel-original-pathname']
    || headers['x-forwarded-uri'] || req.originalUrl || req.url || '';
  return /^\/shared-reports(?:\/|$)/i.test(path.split('?')[0]);
}
export function privateReportHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}
