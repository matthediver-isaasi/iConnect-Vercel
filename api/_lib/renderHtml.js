import fs from 'node:fs';
import path from 'node:path';
import { resolveTenantFromRequest, getHostFromRequest } from './tenantResolver.js';
import { resolveEntityMeta } from './entityMeta.js';
import { supabase } from './database.js';
import { resolveMicrositeByPrefix, micrositeBrandingValue } from './microsites.js';

let cachedTemplate = null;

const DEFAULTS = {
  title: 'iConn — Membership platform for organisations',
  description: 'iConn is a multi-tenant membership platform for events, communities, fundraising, and member engagement.',
  ogImage: 'https://iconn.app/og-image.png',
  favicon32: '/favicon-32.png',
  favicon192: '/favicon-192.png',
  siteName: 'iConn',
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function loadTemplate() {
  if (cachedTemplate) return cachedTemplate;
  const candidates = [
    path.resolve(process.cwd(), 'dist/public/index.html'),
    path.resolve(process.cwd(), 'public/index.html'),
    path.resolve(process.cwd(), 'client/index.html'),
  ];
  for (const p of candidates) {
    try {
      cachedTemplate = fs.readFileSync(p, 'utf-8');
      return cachedTemplate;
    } catch {}
  }
  throw new Error('renderHtml: could not locate index.html template');
}

function getRequestPathname(req) {
  // On Vercel the rewrite to /api/render rewrites req.url. Prefer the original
  // request URI so we see the page the user actually visited.
  const original =
    req.headers['x-original-uri'] ||
    req.headers['x-vercel-original-pathname'] ||
    req.headers['x-forwarded-uri'] ||
    null;
  let pathPart = original || req.url || '/';
  // Defensive: if Vercel left req.url pointing at the function path, drop it.
  if (!original && /^\/api\/render(\?|$)/i.test(pathPart)) {
    pathPart = '/';
  }
  return pathPart.split('?')[0];
}

function buildOgUrl(req) {
  const host = getHostFromRequest(req) || 'iconn.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}${getRequestPathname(req)}`;
}

// Task #2525: for microsite pages (/{prefix}/{slug}) the microsite's
// branding overrides (social_image_url, tagline, description, logo_url)
// replace the tenant defaults in link previews. Returns the microsite row
// or null when the path isn't a microsite page.
async function resolveMicrositeForRequest(req, tenant) {
  if (!tenant?.id || !supabase) return null;
  const pathname = getRequestPathname(req);
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\/?$/);
  if (!m) return null;
  try {
    const prefix = decodeURIComponent(m[1]).toLowerCase();
    return await resolveMicrositeByPrefix(supabase, tenant.id, prefix);
  } catch {
    return null;
  }
}

function makeAbsolute(url, req) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const host = getHostFromRequest(req) || 'iconn.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (url.startsWith('/')) return `${proto}://${host}${url}`;
  return `${proto}://${host}/${url}`;
}

// task-710: og:image URLs that live on vault.iconn.app or any *.supabase.co
// host get served behind Cloudflare bot management (__cf_bm Set-Cookie +
// x-robots-tag: none). Many social unfurl bots refuse to follow that
// challenge and report "image not found" even when the bytes are
// reachable. Rewrite those URLs to a same-origin /api/og-image proxy so
// unfurlers always see a clean, indexable response.
const PROXY_HOSTS = new Set(['vault.iconn.app']);
const PROXY_HOST_SUFFIXES = ['.supabase.co'];

function shouldProxyOgImage(absoluteUrl) {
  if (!absoluteUrl) return false;
  try {
    const u = new URL(absoluteUrl);
    if (PROXY_HOSTS.has(u.hostname)) return true;
    return PROXY_HOST_SUFFIXES.some((s) => u.hostname.endsWith(s));
  } catch {
    return false;
  }
}

function proxyOgImage(absoluteUrl, req) {
  const host = getHostFromRequest(req) || 'iconn.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/og-image?url=${encodeURIComponent(absoluteUrl)}`;
}

// Fetch the tenant's active typography styles so the SSR layer can seed the
// client query before first paint. Mirrors the column set / filters of
// api/public/typography-styles.js so the injected list is identical to what
// the client would otherwise fetch. Returns [] on any failure (the client
// then falls back to its normal fetch).
async function fetchTypographyStylesForTenant(tenantId) {
  if (!supabase || !tenantId) return [];
  try {
    const { data, error } = await supabase
      .from('typography_style')
      .select(`
        id,
        name,
        style_type,
        font_family,
        font_size,
        font_size_tablet,
        font_size_mobile,
        font_weight,
        line_height,
        line_height_tablet,
        line_height_mobile,
        letter_spacing,
        letter_spacing_tablet,
        letter_spacing_mobile,
        text_transform,
        color,
        margin_bottom,
        margin_bottom_tablet,
        margin_bottom_mobile,
        is_default,
        is_active
      `)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) {
      console.error('[renderHtml] typography styles query error:', error.message);
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[renderHtml] typography styles fetch failed:', err?.message);
    return [];
  }
}

// Serialize a value for safe embedding inside an inline <script>. Escaping
// `<` (and the line/paragraph separators) prevents a `</script>` sequence in
// the data from breaking out of the script element.
function serializeForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Inject the tenant's typography styles as a global the client reads
// synchronously on first paint (window.__TENANT_TYPOGRAPHY_STYLES__). Only
// emitted when the tenant resolved server-side, so localhost / *.replit.dev /
// editor hosts (no tenant) keep the legacy client-fetch path with no flash.
function injectTypographyStyles(html, styles) {
  if (!Array.isArray(styles)) return html;
  const tag = `<script>window.__TENANT_TYPOGRAPHY_STYLES__=${serializeForScript(styles)}</script>`;
  return html.replace('</head>', `    ${tag}\n  </head>`);
}

function replaceOrInsert(html, regex, tag) {
  if (regex.test(html)) return html.replace(regex, tag);
  return html.replace('</head>', `    ${tag}\n  </head>`);
}

function injectMeta(html, values) {
  let out = html;

  // Replace or insert <title>
  out = replaceOrInsert(out, /<title>[^<]*<\/title>/i, `<title>${escapeHtml(values.title)}</title>`);

  // Replace or insert meta description
  out = replaceOrInsert(
    out,
    /<meta\s+name=["']description["'][^>]*>/i,
    `<meta name="description" content="${escapeAttr(values.description)}" />`
  );

  // Ensure twitter:card is present (defaults to summary_large_image)
  if (!/twitter:card/i.test(out)) {
    out = out.replace('</head>', `    <meta name="twitter:card" content="summary_large_image" />\n  </head>`);
  }

  // Ensure apple-touch-icon and manifest are present
  if (!/apple-touch-icon/i.test(out)) {
    out = out.replace('</head>', `    <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />\n  </head>`);
  }
  if (!/rel=["']manifest["']/i.test(out)) {
    out = out.replace('</head>', `    <link rel="manifest" href="/site.webmanifest" />\n  </head>`);
  }

  // Replace OG tags
  const ogReplacements = {
    'og:site_name': values.siteName,
    'og:type': values.ogType || 'website',
    'og:title': values.title,
    'og:description': values.description,
    'og:image': values.ogImage,
    'og:url': values.ogUrl,
  };
  for (const [prop, val] of Object.entries(ogReplacements)) {
    const re = new RegExp(`<meta\\s+property=["']${prop}["'][^>]*>`, 'i');
    const tag = `<meta property="${prop}" content="${escapeAttr(val ?? '')}" />`;
    out = re.test(out) ? out.replace(re, tag) : out.replace('</head>', `    ${tag}\n  </head>`);
  }

  // article:author — one tag per ordered contributor (primary author first).
  // Strip any from the template first so a stale list never lingers, then
  // re-emit for article pages that resolved an author list.
  out = out.replace(/\s*<meta\s+property=["']article:author["'][^>]*>/gi, '');
  if (Array.isArray(values.authors) && values.authors.length > 0) {
    const authorTags = values.authors
      .map((name) => `    <meta property="article:author" content="${escapeAttr(name)}" />`)
      .join('\n');
    out = out.replace('</head>', `${authorTags}\n  </head>`);
  }

  // Replace Twitter tags
  const twReplacements = {
    'twitter:title': values.title,
    'twitter:description': values.description,
    'twitter:image': values.ogImage,
  };
  for (const [name, val] of Object.entries(twReplacements)) {
    const re = new RegExp(`<meta\\s+name=["']${name}["'][^>]*>`, 'i');
    const tag = `<meta name="${name}" content="${escapeAttr(val ?? '')}" />`;
    out = re.test(out) ? out.replace(re, tag) : out.replace('</head>', `    ${tag}\n  </head>`);
  }

  // Replace favicon link tags (32 + 192). If neither sized variant exists,
  // fall back to replacing the legacy unsized #dynamic-favicon link.
  if (values.favicon32) {
    out = replaceOrInsert(
      out,
      /<link\s+rel=["']icon["'][^>]*sizes=["']32x32["'][^>]*>/i,
      `<link rel="icon" type="image/png" sizes="32x32" href="${escapeAttr(values.favicon32)}" />`
    );
  }
  if (values.favicon192) {
    if (/sizes=["']192x192["']/i.test(out)) {
      out = out.replace(
        /<link\s+rel=["']icon["'][^>]*sizes=["']192x192["'][^>]*>/i,
        `<link rel="icon" type="image/png" sizes="192x192" href="${escapeAttr(values.favicon192)}" id="dynamic-favicon" />`
      );
    } else if (/id=["']dynamic-favicon["']/i.test(out)) {
      out = out.replace(
        /<link[^>]*id=["']dynamic-favicon["'][^>]*>/i,
        `<link rel="icon" type="image/png" sizes="192x192" href="${escapeAttr(values.favicon192)}" id="dynamic-favicon" />`
      );
    } else {
      out = out.replace('</head>', `    <link rel="icon" type="image/png" sizes="192x192" href="${escapeAttr(values.favicon192)}" id="dynamic-favicon" />\n  </head>`);
    }
  }

  return out;
}

export async function renderTenantHtml(req) {
  const template = loadTemplate();
  let tenant = null;
  try {
    tenant = await resolveTenantFromRequest(req);
  } catch (err) {
    console.error('[renderHtml] tenant resolution failed:', err?.message);
  }

  let ogUrl = buildOgUrl(req);

  let entity = null;
  let typographyStyles = null;
  let microsite = null;
  if (tenant) {
    const [entityResult, stylesResult, micrositeResult] = await Promise.allSettled([
      resolveEntityMeta(req, tenant),
      fetchTypographyStylesForTenant(tenant.id),
      resolveMicrositeForRequest(req, tenant),
    ]);
    if (entityResult.status === 'fulfilled') {
      entity = entityResult.value;
    } else {
      console.error('[renderHtml] entity meta resolution failed:', entityResult.reason?.message);
    }
    typographyStyles = stylesResult.status === 'fulfilled' ? stylesResult.value : [];
    microsite = micrositeResult.status === 'fulfilled' ? micrositeResult.value : null;
  }

  // Task #2525: microsite branding overrides replace tenant defaults on
  // microsite pages. Keys the microsite leaves unset fall back to tenant.
  const msTagline = micrositeBrandingValue(microsite, 'tagline');
  const msDescription = micrositeBrandingValue(microsite, 'description');
  const msSocialImage = micrositeBrandingValue(microsite, 'social_image_url');
  const msLogo = micrositeBrandingValue(microsite, 'logo_url') || microsite?.logo_url || null;

  const tenantSiteName = tenant?.name || DEFAULTS.siteName;
  const effectiveTagline = msTagline || tenant?.tagline || null;
  const tenantTitle = tenant?.name
    ? (effectiveTagline ? `${tenant.name} — ${effectiveTagline}` : tenant.name)
    : DEFAULTS.title;
  // Description inherits independently: microsite description override first,
  // then the tenant description. The tagline (microsite override or tenant)
  // is only the last-resort fallback when no description exists at all —
  // overriding the tagline must NOT displace an existing tenant description.
  const tenantDescription = msDescription || tenant?.description
    || effectiveTagline || DEFAULTS.description;
  const tenantOgImage = makeAbsolute(
    msSocialImage || (microsite ? msLogo : null) || tenant?.social_image_url || tenant?.logo_url,
    req
  ) || DEFAULTS.ogImage;

  // If we resolved an entity, override the canonical og:url so unfurl bots
  // see a stable URL even when visiting alternate routes (e.g. /EventDetails?id=…).
  if (entity?.canonicalPath) {
    const host = getHostFromRequest(req) || 'iconn.app';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    ogUrl = `${proto}://${host}${entity.canonicalPath}`;
  }

  const entityTitle = entity?.title
    ? (tenant?.name ? `${entity.title} — ${tenant.name}` : entity.title)
    : null;

  let ogImage = makeAbsolute(entity?.image, req) || tenantOgImage;
  if (shouldProxyOgImage(ogImage)) ogImage = proxyOgImage(ogImage, req);

  const values = {
    siteName: tenantSiteName,
    title: entityTitle || tenantTitle,
    description: entity?.description || tenantDescription,
    ogImage,
    ogUrl,
    ogType: entity?.ogType || 'website',
    authors: Array.isArray(entity?.authors) ? entity.authors : null,
    favicon32: tenant?.favicon_url || DEFAULTS.favicon32,
    favicon192: tenant?.favicon_url || DEFAULTS.favicon192,
  };

  let out = injectMeta(template, values);
  // Seed typography styles only when a tenant resolved server-side. On hosts
  // the resolver can't map to a tenant the global is absent and the client
  // keeps its legacy fetch-then-fallback path (no flash either way).
  if (tenant && Array.isArray(typographyStyles)) {
    out = injectTypographyStyles(out, typographyStyles);
  }
  return out;
}

export function clearTemplateCache() {
  cachedTemplate = null;
}
