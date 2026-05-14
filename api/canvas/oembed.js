// Server-side oEmbed proxy for the Canvas Builder video block.
//
// Supported providers: YouTube and Vimeo (both expose public oEmbed JSON
// endpoints). The proxy keeps third-party fetches off the browser (avoiding
// CORS issues with YouTube), normalises the response, and host-allow-lists
// the input URL so this endpoint can't be used as an open redirect/SSRF.

const PROVIDERS = [
  {
    name: 'youtube',
    test: (u) => /(^|\.)youtube\.com$/i.test(u.hostname) || u.hostname.toLowerCase() === 'youtu.be',
    endpoint: (url) => `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  },
  {
    name: 'vimeo',
    test: (u) => /(^|\.)vimeo\.com$/i.test(u.hostname),
    endpoint: (url) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`,
  },
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = (req.query && req.query.url) || '';
  if (!raw || typeof raw !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'Unsupported protocol' });
  }

  const provider = PROVIDERS.find((p) => p.test(parsed));
  if (!provider) {
    return res.status(400).json({ error: 'Unsupported video provider' });
  }

  try {
    const upstream = await fetch(provider.endpoint(parsed.toString()), {
      headers: { Accept: 'application/json' },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Provider error', status: upstream.status });
    }
    const data = await upstream.json();
    // Cache aggressively — oEmbed responses for a given URL are stable.
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).json({
      provider: provider.name,
      type: data.type || 'video',
      html: typeof data.html === 'string' ? data.html : '',
      width: data.width || null,
      height: data.height || null,
      thumbnail_url: data.thumbnail_url || null,
      title: data.title || null,
      author_name: data.author_name || null,
    });
  } catch (err) {
    return res.status(502).json({ error: 'oEmbed fetch failed', detail: String(err && err.message || err) });
  }
}
