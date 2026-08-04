/**
 * Shared public base-URL resolution (Task #3384).
 *
 * Problem: many API files built user-facing links (invite emails, signing
 * links, {{set_password_url}} placeholders, …) with a fallback to
 * process.env.VERCEL_URL. On Vercel that env var is ALWAYS the
 * deployment-specific URL (e.g. vite-migrate-replit-…​.vercel.app), never the
 * real public domain — so emailed links pointed at stale preview deployments.
 *
 * Rules:
 *  - getPublicBaseUrl(req): for anything a USER will see/click. Resolves, in
 *    order: request origin/host (ignoring *.vercel.app deployment hosts) →
 *    VITE_APP_URL / APP_URL → hardcoded production domain. NEVER returns the
 *    raw VERCEL_URL deployment URL.
 *  - getInternalApiBaseUrl(req): for server-to-self fetches only. Prefers the
 *    live request host, then configured app URL, and may fall back to
 *    VERCEL_URL as a last resort (an internal call to the deployment URL
 *    still works — it just shouldn't be anyone's first choice).
 */

const PRODUCTION_FALLBACK_URL = 'https://iconn.app';

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

// A *.vercel.app host is a deployment-specific URL, never a public domain we
// want to bake into user-facing links.
export function isVercelDeploymentHost(hostOrUrl) {
  if (!hostOrUrl) return false;
  const host = String(hostOrUrl)
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .split(':')[0]
    .toLowerCase();
  return host.endsWith('.vercel.app');
}

function requestProtocol(req) {
  return firstHeader(req?.headers?.['x-forwarded-proto']) || 'https';
}

function requestHost(req) {
  return firstHeader(req?.headers?.['x-forwarded-host']) || firstHeader(req?.headers?.host) || '';
}

function configuredAppUrl() {
  const url = process.env.VITE_APP_URL || process.env.APP_URL || process.env.SITE_URL || '';
  if (!url || isVercelDeploymentHost(url)) return '';
  return url.replace(/\/+$/, '');
}

/**
 * Base URL for USER-FACING links (emails, signing URLs, password links…).
 * Never returns the VERCEL_URL deployment domain.
 * @param {object} [req] - incoming request (optional; cron paths have none)
 * @returns {string} e.g. "https://members.example.org" (no trailing slash)
 */
export function getPublicBaseUrl(req) {
  // 1. Origin the caller is actually on (browser sends Origin on POSTs)
  const origin = firstHeader(req?.headers?.origin);
  if (origin && !isVercelDeploymentHost(origin)) {
    return origin.replace(/\/+$/, '');
  }
  // 2. Host the request arrived on
  const host = requestHost(req);
  if (host && !isVercelDeploymentHost(host)) {
    return `${requestProtocol(req)}://${host}`;
  }
  // 3. Configured app URL
  const envUrl = configuredAppUrl();
  if (envUrl) return envUrl;
  // 4. Safe hardcoded production domain — never the deployment URL
  return PRODUCTION_FALLBACK_URL;
}

// Environment-suffix labels used by preview/staging hosts:
// {tenant}.dev.iconn.app, {tenant}.testing.iconn.app, … Keep in sync with
// api/_lib/tenantResolver.js environmentIndicators.
const ICONN_ENV_LABELS = ['dev', 'testing', 'preview', 'staging'];
const ICONN_ROOT = '.iconn.app';

// Accepts only a bare DNS hostname (letters/digits/hyphens dot-separated,
// ≥2 labels). Anything with a scheme, userinfo (@), port, slash, or other
// URL syntax returns null. Leading www. is stripped first.
export function sanitizeHostname(domain) {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(d)) return null;
  return d;
}

function hostOf(url) {
  return String(url || '')
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    .split(':')[0]
    .toLowerCase();
}

/**
 * Trusted base URL for USER-FACING links when the tenant is known.
 *
 * Task #3387: *.iconn.app (and *.dev.iconn.app) is wildcard DNS, so a
 * mistyped subdomain like fgi.dev.iconn.app serves the app normally for a
 * logged-in gfi user — and getPublicBaseUrl faithfully echoes the typo'd
 * origin into emailed links. This wrapper cross-checks the resolved origin
 * against the tenant: when the host is an {slug}.iconn.app-style host whose
 * slug does not match the tenant, the link is rebuilt on the tenant's
 * canonical domain for that environment. Custom domains, localhost, and env
 * fallbacks pass through unchanged.
 *
 * @param {object} [req]
 * @param {{slug?: string, domain?: string}|null} [tenant]
 * @returns {string} base URL without trailing slash
 */
export function getTenantTrustedBaseUrl(req, tenant) {
  const base = getPublicBaseUrl(req);
  const slug = (tenant?.slug || '').trim().toLowerCase();
  if (!slug) return base;

  const host = hostOf(base);
  if (!host.endsWith(ICONN_ROOT)) {
    // Custom domain, localhost/replit dev, or configured/production
    // fallback — nothing to cross-check against the slug.
    return base;
  }

  const labels = host.slice(0, -ICONN_ROOT.length).split('.').filter(Boolean);
  let envLabel = null;
  let slugLabel = null;
  if (labels.length === 1) {
    if (ICONN_ENV_LABELS.includes(labels[0])) {
      envLabel = labels[0]; // bare dev.iconn.app etc — no tenant slug at all
    } else {
      slugLabel = labels[0];
    }
  } else if (labels.length === 2 && ICONN_ENV_LABELS.includes(labels[1])) {
    slugLabel = labels[0];
    envLabel = labels[1];
  } else {
    // Unexpected host shape (www.iconn.app, deeper nesting…) — leave as-is.
    return base;
  }

  if (slugLabel === slug) return base;

  // Mismatch (or missing slug): rebuild on the tenant's canonical host for
  // this environment. Production hosts prefer the tenant's custom domain —
  // but only when it parses as a plain hostname (no scheme/userinfo/port/
  // path syntax), so a malformed stored value can never become a redirect
  // or link to an arbitrary origin.
  if (!envLabel) {
    const customDomain = sanitizeHostname(tenant?.domain);
    if (customDomain) return `https://${customDomain}`;
    return `https://${slug}${ICONN_ROOT}`;
  }
  return `https://${slug}.${envLabel}${ICONN_ROOT}`;
}

/**
 * Convenience wrapper: look up the tenant's slug/domain by id, then apply
 * getTenantTrustedBaseUrl. Falls back to getPublicBaseUrl on any failure —
 * never throws.
 * @param {object} [req]
 * @param {object} supabase
 * @param {string|null} tenantId
 * @returns {Promise<string>}
 */
export async function getTrustedBaseUrlForTenant(req, supabase, tenantId) {
  if (!supabase || !tenantId) return getPublicBaseUrl(req);
  try {
    const { data } = await supabase
      .from('tenant')
      .select('slug, domain')
      .eq('id', tenantId)
      .maybeSingle();
    return getTenantTrustedBaseUrl(req, data);
  } catch (err) {
    console.warn('[publicBaseUrl] Tenant lookup for trusted base URL failed:', err?.message);
    return getPublicBaseUrl(req);
  }
}

/**
 * Base URL for INTERNAL server-to-self fetches. Prefers the live request
 * host so calls stay on the domain actually serving traffic; VERCEL_URL is
 * only a last resort.
 * @param {object} [req]
 * @returns {string} base URL without trailing slash ('' if nothing available)
 */
export function getInternalApiBaseUrl(req) {
  const host = requestHost(req);
  if (host) return `${requestProtocol(req)}://${host}`;
  const envUrl = configuredAppUrl();
  if (envUrl) return envUrl;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return '';
}
