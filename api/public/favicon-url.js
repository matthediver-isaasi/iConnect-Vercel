export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Host, X-Forwarded-Host');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  // The image route resolves current host branding, not client/query hints.
  return res.json({ faviconUrl: '/favicon-192.png' });
}
