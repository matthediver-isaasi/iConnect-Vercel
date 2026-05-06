import fs from 'node:fs';
import path from 'node:path';
import { resolveTenantFromRequest, getHostFromRequest } from './tenantResolver.js';
import { resolveEntityMeta } from './entityMeta.js';

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

function buildOgUrl(req) {
  const host = getHostFromRequest(req) || 'iconn.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  // On Vercel the rewrite to /api/render rewrites req.url. Prefer the original
  // request URI so og:url reflects the page the user actually visited.
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
  pathPart = pathPart.split('?')[0];
  return `${proto}://${host}${pathPart}`;
}

function makeAbsolute(url, req) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const host = getHostFromRequest(req) || 'iconn.app';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  if (url.startsWith('/')) return `${proto}://${host}${url}`;
  return `${proto}://${host}/${url}`;
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
  if (tenant) {
    try {
      entity = await resolveEntityMeta(req, tenant);
    } catch (err) {
      console.error('[renderHtml] entity meta resolution failed:', err?.message);
    }
  }

  const tenantSiteName = tenant?.name || DEFAULTS.siteName;
  const tenantTitle = tenant?.name
    ? (tenant.tagline ? `${tenant.name} — ${tenant.tagline}` : tenant.name)
    : DEFAULTS.title;
  const tenantDescription = tenant?.description || tenant?.tagline || DEFAULTS.description;
  const tenantOgImage = makeAbsolute(tenant?.social_image_url || tenant?.logo_url, req) || DEFAULTS.ogImage;

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

  const values = {
    siteName: tenantSiteName,
    title: entityTitle || tenantTitle,
    description: entity?.description || tenantDescription,
    ogImage: makeAbsolute(entity?.image, req) || tenantOgImage,
    ogUrl,
    favicon32: tenant?.favicon_url || DEFAULTS.favicon32,
    favicon192: tenant?.favicon_url || DEFAULTS.favicon192,
  };

  return injectMeta(template, values);
}

export function clearTemplateCache() {
  cachedTemplate = null;
}
