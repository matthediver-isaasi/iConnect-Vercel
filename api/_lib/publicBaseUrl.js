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
