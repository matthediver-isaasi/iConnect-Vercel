import { useEffect, useState } from 'react';

// Custom social-icon SVGs are stored as cross-origin URLs (vault.iconn.app /
// supabase storage). Two things make referencing them directly unreliable:
//
//  1. A cross-origin URL used directly in a CSS `mask-image` is frequently
//     refused by the browser, leaving the element painted as a solid coloured
//     square (or invisible).
//  2. vault.iconn.app sits behind Cloudflare bot management, so a plain
//     browser `fetch()` of the SVG can be challenged/blocked (or returns an
//     HTML challenge page instead of the SVG) — so inlining fails too.
//
// To make the recolour-via-mask path reliable we fetch each SVG once and inline
// it as a same-origin base64 `data:` URI, which masks correctly in every
// browser. Cross-origin URLs on the known asset hosts are fetched through the
// same-origin `/api/og-image` proxy (the server fetches the bytes cleanly,
// without Cloudflare challenges or CORS) before inlining. Results are cached at
// module scope so the work happens at most once per URL across the whole app
// (header + footer share the cache).

const cache = new Map(); // url -> data URI (string) | null (fetch failed)
const inflight = new Map(); // url -> Promise<string|null>

// Hosts the same-origin /api/og-image proxy is allow-listed to serve.
const PROXYABLE_HOST_SUFFIXES = ['.supabase.co'];
const PROXYABLE_HOSTS = new Set(['vault.iconn.app']);

function isProxyableHost(hostname) {
  if (!hostname) return false;
  if (PROXYABLE_HOSTS.has(hostname)) return true;
  return PROXYABLE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

// Returns the ordered list of URLs to try when fetching the SVG bytes.
function fetchCandidates(url) {
  if (typeof window === 'undefined') return [url];
  let parsed;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return [url];
  }
  if (parsed.origin === window.location.origin) return [url];
  const proxied = `/api/og-image?url=${encodeURIComponent(url)}`;
  // For known asset hosts the proxy is the reliable path (Cloudflare/CORS),
  // with a direct fetch as a last resort. For anything else, try direct first.
  return isProxyableHost(parsed.hostname) ? [proxied, url] : [url, proxied];
}

function toBase64DataUri(svgText) {
  // Strip any XML/doctype prologue and leading whitespace so the data URI is
  // a clean <svg> document, then base64-encode for the most cross-browser-safe
  // mask source.
  const cleaned = String(svgText)
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<!DOCTYPE[\s\S]*?>/i, '')
    .trim();
  if (!/^<svg[\s>]/i.test(cleaned)) return null;
  try {
    const base64 = btoa(unescape(encodeURIComponent(cleaned)));
    return `data:image/svg+xml;base64,${base64}`;
  } catch {
    // Fallback to percent-encoded form if btoa chokes on the content.
    return `data:image/svg+xml,${encodeURIComponent(cleaned)}`;
  }
}

async function fetchSvgText(url) {
  for (const candidate of fetchCandidates(url)) {
    try {
      const res = await fetch(candidate, { credentials: 'omit' });
      if (!res.ok) continue;
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !type.includes('svg') && !type.includes('xml')) continue;
      const text = await res.text();
      if (/^[\s]*(<\?xml|<!DOCTYPE|<svg[\s>])/i.test(text)) return text;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function resolveOne(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);

  const p = fetchSvgText(url)
    .then((text) => {
      const dataUri = text ? toBase64DataUri(text) : null;
      cache.set(url, dataUri);
      return dataUri;
    })
    .catch(() => {
      cache.set(url, null);
      return null;
    })
    .finally(() => {
      inflight.delete(url);
    });

  inflight.set(url, p);
  return p;
}

// Given a map of { platform: url }, returns { platform: dataUri } containing
// only successfully-resolved entries. While a URL is loading (or if it fails)
// the platform is absent, so callers fall back to the built-in icon instead of
// rendering a broken mask.
export function useResolvedSocialIcons(svgMap) {
  const [resolved, setResolved] = useState(() => {
    const seed = {};
    if (svgMap) {
      for (const [platform, url] of Object.entries(svgMap)) {
        if (url && cache.get(url)) seed[platform] = cache.get(url);
      }
    }
    return seed;
  });

  const key = svgMap ? JSON.stringify(svgMap) : '';

  useEffect(() => {
    let cancelled = false;
    if (!svgMap) {
      setResolved({});
      return undefined;
    }
    const entries = Object.entries(svgMap).filter(([, url]) => !!url);
    Promise.all(
      entries.map(([platform, url]) =>
        resolveOne(url).then((dataUri) => [platform, dataUri])
      )
    ).then((pairs) => {
      if (cancelled) return;
      const next = {};
      for (const [platform, dataUri] of pairs) {
        if (dataUri) next[platform] = dataUri;
      }
      setResolved(next);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return resolved;
}
