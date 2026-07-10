// Proxy for the Google Fonts Developer API so admins can search the whole
// Google Fonts catalogue from the Installed Fonts add dialog. The API key is
// kept server-side (GOOGLE_FONTS_API_KEY); the browser never sees it.
//
// GET /api/public/google-fonts?q=<search>&limit=<n>&category=<style>
//   -> [{ name, category }, ...]
//
// `category` (optional) narrows results to a single Google Fonts style category
// (serif, sans-serif, display, handwriting, monospace).
//
// The full catalogue is fetched once from Google and cached in-memory (module
// scope) with a TTL, so repeated searches don't re-hit Google. When the key is
// missing or the upstream fetch fails, we respond 200 with an empty list and a
// `fallback` flag so the client can drop back to its curated offline list.

const GOOGLE_WEBFONTS_URL = 'https://www.googleapis.com/webfonts/v1/webfonts';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

// Module-scoped cache of the trimmed catalogue: [{ name, category }].
let _cache = null;
let _cacheAt = 0;
let _inflight = null;

async function fetchCatalogue(apiKey) {
  const url = `${GOOGLE_WEBFONTS_URL}?key=${encodeURIComponent(apiKey)}&sort=popularity`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Google Fonts API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((it) => it && typeof it.family === 'string')
    .map((it) => ({
      name: it.family,
      category: typeof it.category === 'string' ? it.category : 'sans-serif',
    }));
}

async function getCatalogue(apiKey) {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = fetchCatalogue(apiKey)
    .then((list) => {
      _cache = list;
      _cacheAt = Date.now();
      return list;
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GOOGLE_FONTS_API_KEY;
  if (!apiKey) {
    // Not configured: signal the client to use its offline curated fallback.
    return res.status(200).json({ items: [], fallback: true, reason: 'not_configured' });
  }

  const q = String(req.query?.q || '').trim().toLowerCase();
  const category = String(req.query?.category || '').trim().toLowerCase();
  let limit = parseInt(req.query?.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  try {
    const catalogue = await getCatalogue(apiKey);
    let matches = catalogue;
    if (category) {
      matches = matches.filter((f) => f.category === category);
    }
    if (q) {
      matches = matches.filter((f) => f.name.toLowerCase().includes(q));
      // Rank names that start with the query ahead of mid-string matches,
      // preserving Google's popularity order within each group.
      matches.sort((a, b) => {
        const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts;
      });
    }
    return res.status(200).json({ items: matches.slice(0, limit), fallback: false });
  } catch (error) {
    console.error('[Public GoogleFonts] Error:', error);
    // Upstream failure: let the client fall back to its curated list.
    return res.status(200).json({ items: [], fallback: true, reason: 'upstream_error' });
  }
}
