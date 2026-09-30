// Safe extraction of a playable embed URL from a `video` resource's
// target_url. The Resource Management admin UI stores raw iframe embed code
// (YouTube/Vimeo) in target_url for video resources; resource views must
// never inject that markup. Instead we parse out the iframe src, validate it
// against a strict allowlist of embed hosts, and render our own <iframe>
// with that src. Anything unrecognised returns null so callers fall back to
// treating target_url as a plain link.

const ALLOWED_EMBED_HOSTS = new Set([
  'www.youtube.com',
  'youtube.com',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
  'player.vimeo.com',
]);

/** Validate a candidate embed URL; returns the normalised https URL or null. */
export function sanitizeVideoEmbedUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_EMBED_HOSTS.has(parsed.hostname)) return null;
  const path = parsed.pathname;
  const isYouTube = parsed.hostname.includes('youtube');
  if (isYouTube && !/^\/embed\/[A-Za-z0-9_-]{6,}$/.test(path)) return null;
  if (parsed.hostname === 'player.vimeo.com' && !/^\/video\/\d+$/.test(path)) return null;
  return parsed.toString();
}

/**
 * Given a video resource's target_url (raw iframe embed code, or sometimes a
 * plain URL), return a safe embed URL to render in our own iframe, or null
 * when nothing playable can be extracted.
 */
export function extractVideoEmbedSrc(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return null;
  const value = targetUrl.trim();
  // Plain URL case: a direct embed link pasted instead of iframe code.
  if (!value.includes('<')) {
    const direct = sanitizeVideoEmbedUrl(value);
    if (direct) return direct;
    // Plain watch/share URLs: convert well-known shapes to embed URLs.
    try {
      const u = new URL(value);
      if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.pathname === '/watch') {
        const id = u.searchParams.get('v');
        if (id && /^[A-Za-z0-9_-]{6,}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
      }
      if (u.hostname === 'youtu.be') {
        const id = u.pathname.slice(1);
        if (/^[A-Za-z0-9_-]{6,}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
      }
    } catch {
      /* not a URL */
    }
    return null;
  }
  // Iframe embed code: pull out the src attribute only — never render the markup.
  const m = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(value);
  if (!m) return null;
  return sanitizeVideoEmbedUrl(m[1]);
}
