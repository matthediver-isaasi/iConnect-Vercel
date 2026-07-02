// task-710: same-origin image proxy for og:image URLs that sit behind
// Cloudflare bot management on vault.iconn.app / *.supabase.co. Many
// unfurl bots (Slack, LinkedIn, socialsharepreview's checker) refuse to
// follow Set-Cookie challenges or x-robots-tag: none, so they report
// "image not found" even though the bytes are reachable. We fetch the
// image server-side (no cookies, no challenges) and re-serve it with
// clean cache headers.
//
// Strict allow-list to prevent SSRF: only public Supabase storage hosts
// are accepted. Anything else returns 400.

const ALLOWED_HOSTS = new Set([
  'vault.iconn.app',
]);
const ALLOWED_HOST_SUFFIXES = ['.supabase.co'];

const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

const MAX_BYTES = 5 * 1024 * 1024;

function isHostAllowed(hostname) {
  if (!hostname) return false;
  if (ALLOWED_HOSTS.has(hostname)) return true;
  for (const suffix of ALLOWED_HOST_SUFFIXES) {
    if (hostname.endsWith(suffix)) return true;
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const raw = req.query?.url || (req.url ? new URL(req.url, 'http://x').searchParams.get('url') : null);
  if (!raw || typeof raw !== 'string') {
    res.status(400).json({ error: 'Missing url parameter' });
    return;
  }

  let target;
  try {
    target = new URL(raw);
  } catch {
    res.status(400).json({ error: 'Invalid url' });
    return;
  }
  if (target.protocol !== 'https:') {
    res.status(400).json({ error: 'Invalid protocol' });
    return;
  }
  if (!isHostAllowed(target.hostname)) {
    res.status(400).json({ error: 'Host not allowed' });
    return;
  }
  // Self-proxy guard: never let the proxy fetch itself (defense against loops
  // and accidental re-proxying of an already-proxied URL).
  if (target.pathname === '/api/og-image') {
    res.status(400).json({ error: 'Refusing to proxy a proxy URL' });
    return;
  }

  // Manual redirect handling: validate every hop against the host allow-list
  // so an allow-listed host cannot redirect us to an arbitrary internal/
  // external target (SSRF defence in depth).
  const MAX_HOPS = 5;
  let current = target.toString();
  let upstream;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      upstream = await fetch(current, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': 'iConnSocialImageProxy/1.0 (+https://iconn.app)',
          Accept: 'image/*',
        },
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        const loc = upstream.headers.get('location');
        if (!loc) break;
        let next;
        try {
          next = new URL(loc, current);
        } catch {
          res.status(502).json({ error: 'Invalid redirect target' });
          return;
        }
        if (next.protocol !== 'https:' || !isHostAllowed(next.hostname) || next.pathname === '/api/og-image') {
          res.status(400).json({ error: 'Redirect to disallowed host' });
          return;
        }
        current = next.toString();
        continue;
      }
      break;
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      res.status(502).json({ error: 'Too many redirects' });
      return;
    }
  } catch (err) {
    console.error('[og-image] upstream fetch failed:', err?.message);
    res.status(502).json({ error: 'Upstream fetch failed' });
    return;
  }

  if (!upstream.ok) {
    res.status(upstream.status === 404 ? 404 : 502).json({ error: 'Upstream returned non-OK', status: upstream.status });
    return;
  }

  const ct = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(ct)) {
    res.status(415).json({ error: 'Unsupported content-type', contentType: ct });
    return;
  }

  const lenHeader = upstream.headers.get('content-length');
  const len = lenHeader ? parseInt(lenHeader, 10) : null;
  if (Number.isFinite(len) && len > MAX_BYTES) {
    res.status(413).json({ error: 'Image too large' });
    return;
  }

  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Explicitly do NOT pass through Set-Cookie / x-robots-tag from upstream.

  if (req.method === 'HEAD') {
    if (Number.isFinite(len)) res.setHeader('Content-Length', String(len));
    res.status(200).end();
    return;
  }

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    res.status(413).json({ error: 'Image too large' });
    return;
  }
  res.setHeader('Content-Length', String(buffer.byteLength));
  res.status(200).end(buffer);
}
