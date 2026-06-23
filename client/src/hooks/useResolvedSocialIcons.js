import { useEffect, useState } from 'react';

// Custom social-icon SVGs are stored as cross-origin URLs (vault.iconn.app /
// supabase storage). Referencing a cross-origin URL directly in a CSS
// `mask-image` is unreliable: the browser frequently refuses to apply the mask,
// which leaves the element painted as a solid coloured square (or invisible).
//
// To make the recolour-via-mask path reliable we fetch each SVG once and inline
// it as a same-origin `data:` URI, which masks correctly in every browser.
// Results are cached at module scope so the fetch happens at most once per URL
// across the whole app (header + footer share the cache).

const cache = new Map(); // url -> data URI (string) | null (fetch failed)
const inflight = new Map(); // url -> Promise<string|null>

function toDataUri(svgText) {
  // Strip any XML/doctype prologue and leading whitespace so the data URI is
  // a clean <svg> document, then percent-encode for safe inlining.
  const cleaned = String(svgText)
    .replace(/<\?xml[\s\S]*?\?>/i, '')
    .replace(/<!DOCTYPE[\s\S]*?>/i, '')
    .trim();
  if (!/^<svg[\s>]/i.test(cleaned)) return null;
  return `data:image/svg+xml;utf8,${encodeURIComponent(cleaned)}`;
}

function resolveOne(url) {
  if (cache.has(url)) return Promise.resolve(cache.get(url));
  if (inflight.has(url)) return inflight.get(url);

  const p = fetch(url, { credentials: 'omit' })
    .then((res) => {
      if (!res.ok) throw new Error(`status ${res.status}`);
      const type = (res.headers.get('content-type') || '').toLowerCase();
      if (type && !type.includes('svg') && !type.includes('xml')) {
        throw new Error(`unexpected content-type ${type}`);
      }
      return res.text();
    })
    .then((text) => {
      const dataUri = toDataUri(text);
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
