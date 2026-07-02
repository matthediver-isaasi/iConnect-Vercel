// Server-side oEmbed proxy for the Canvas Builder video block.
//
// Supported providers: YouTube and Vimeo (both expose public oEmbed JSON
// endpoints). The proxy keeps third-party fetches off the browser (avoiding
// CORS issues with YouTube), normalises the response, and host-allow-lists
// the input URL so this endpoint can't be used as an open redirect/SSRF.

// Extract the 11-char YouTube video ID from any common share/embed/copy form
// (watch?v=, youtu.be/, /embed/, /v/, /shorts/). Returns null when no ID can
// be found so callers can fail clearly instead of forwarding a URL that 404s.
function youtubeVideoId(u) {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  }
  // youtube.com — try the ?v= query param first, then path forms.
  const v = u.searchParams.get('v');
  if (v && /^[\w-]{11}$/.test(v)) return v;
  const m = u.pathname.match(/\/(?:embed|v|shorts)\/([\w-]{11})/);
  return m ? m[1] : null;
}

const PROVIDERS = [
  {
    name: 'youtube',
    test: (u) => /(^|\.)youtube\.com$/i.test(u.hostname) || u.hostname.toLowerCase() === 'youtu.be',
    // Normalise to a canonical watch URL before oEmbed lookup. YouTube's oEmbed
    // endpoint only reliably resolves watch?v=ID / youtu.be/ID, and 404s on
    // /embed/... paths or URLs carrying tracking params like ?si=.
    normalize: (u) => {
      const id = youtubeVideoId(u);
      return id ? `https://www.youtube.com/watch?v=${id}` : null;
    },
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

  // Normalise the URL to the provider's canonical form (if it has one) so the
  // oEmbed endpoint receives a URL it can actually resolve.
  let lookupUrl = parsed.toString();
  if (provider.normalize) {
    const canonical = provider.normalize(parsed);
    if (!canonical) {
      return res.status(400).json({ error: 'Could not extract a video ID from the URL' });
    }
    lookupUrl = canonical;
  }

  try {
    const upstream = await fetch(provider.endpoint(lookupUrl), {
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
