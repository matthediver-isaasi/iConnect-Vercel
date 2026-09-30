import { renderTenantHtml } from './_lib/renderHtml.js';

function pickAttr(html, regex) {
  const m = html.match(regex);
  return m ? m[1] : null;
}

function decodeEntities(str) {
  if (!str) return str;
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseMeta(html) {
  const title = decodeEntities(
    pickAttr(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/i) ||
    pickAttr(html, /<title>([^<]*)<\/title>/i) ||
    ''
  );
  const description = decodeEntities(
    pickAttr(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']*)["']/i) ||
    pickAttr(html, /<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i) ||
    ''
  );
  const image = decodeEntities(
    pickAttr(html, /<meta\s+property=["']og:image["']\s+content=["']([^"']*)["']/i) || ''
  );
  const url = decodeEntities(
    pickAttr(html, /<meta\s+property=["']og:url["']\s+content=["']([^"']*)["']/i) || ''
  );
  const siteName = decodeEntities(
    pickAttr(html, /<meta\s+property=["']og:site_name["']\s+content=["']([^"']*)["']/i) || ''
  );
  return { title, description, image, url, siteName };
}

export default async function handler(req, res) {
  try {
    const rawPath = typeof req.query?.path === 'string' ? req.query.path : '/';
    let safePath = rawPath || '/';
    if (!safePath.startsWith('/')) safePath = `/${safePath}`;
    // Strip query/hash for safety; only the path is used to resolve entity meta.
    safePath = safePath.split('#')[0];

    // Spoof the original request URI so renderHtml builds og:url and resolves
    // entity meta as if the bot visited that path on the same tenant host.
    const previewReq = {
      ...req,
      url: safePath,
      headers: {
        ...req.headers,
        'x-original-uri': safePath,
        'x-vercel-original-pathname': safePath.split('?')[0],
      },
    };

    const html = await renderTenantHtml(previewReq);
    const meta = parseMeta(html);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    return res.status(200).json(meta);
  } catch (err) {
    console.error('[api/unfurl-preview] failed:', err);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).json({ title: '', description: '', image: '', url: '', siteName: '' });
  }
}
