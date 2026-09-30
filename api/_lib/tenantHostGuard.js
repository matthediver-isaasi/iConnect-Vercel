/**
 * Wildcard-subdomain tenant host guard (Task #3390).
 *
 * *.iconn.app (and *.dev.iconn.app etc.) is wildcard DNS, so any typo'd
 * subdomain serves the app. Task #3387 made the browser client treat the
 * host slug as authoritative over the ?tenant= query param; this module is
 * the server-side counterpart used by api/_lib/tenantResolver.js.
 *
 * Rule: when the request arrives on an {slug}.iconn.app or
 * {slug}.{env}.iconn.app host, the HOST slug wins — an explicit ?tenant= /
 * ?domain= override is refused unless it matches the host slug.
 * localhost, *.replit.dev, custom domains, and non-tenant iconn.app hosts
 * (www.iconn.app, dev.iconn.app, …) keep the param behaviour so embeds and
 * local testing continue to work.
 *
 * Host-shape parsing mirrors api/_lib/publicBaseUrl.js
 * (ICONN_ENV_LABELS) and the resolveTenantFromHost logic in
 * api/_lib/tenantResolver.js — keep the three in sync.
 */

const ICONN_ROOT = '.iconn.app';
const ENVIRONMENT_INDICATORS = ['dev', 'testing', 'preview', 'staging'];
const NON_TENANT_SUBDOMAINS = ['www', 'iconn', 'api', 'app', 'admin', 'staging', 'dev', 'testing', 'preview'];

/**
 * Extract the tenant slug from a wildcard iconn.app hostname.
 * Returns the lowercase slug for {slug}.iconn.app or {slug}.{env}.iconn.app
 * hosts, or null for anything else (localhost, replit dev, custom domains,
 * bare iconn.app, www/env-only subdomains, unexpected nesting).
 * @param {string} hostname - raw Host / X-Forwarded-Host value (may include port)
 * @returns {string|null}
 */
export function getIconnHostSlug(hostname) {
  if (!hostname) return null;
  const host = String(hostname).toLowerCase().split(':')[0].trim();
  if (!host.endsWith(ICONN_ROOT)) return null;

  const labels = host.slice(0, -ICONN_ROOT.length).split('.').filter(Boolean);
  if (labels.length === 1) {
    // {slug}.iconn.app — but not www/api/env-only subdomains
    if (NON_TENANT_SUBDOMAINS.includes(labels[0])) return null;
    return labels[0];
  }
  if (labels.length === 2 && ENVIRONMENT_INDICATORS.includes(labels[1])) {
    // {slug}.{env}.iconn.app
    if (NON_TENANT_SUBDOMAINS.includes(labels[0])) return null;
    return labels[0];
  }
  return null;
}

/**
 * Decide whether an explicit tenant/domain override param may be honoured
 * for a request arriving on `hostname`.
 *
 * @param {string} hostname
 * @param {string|null|undefined} tenantParam - value of ?tenant= / ?slug= / body.tenant
 * @returns {{ hostSlug: string|null, allowOverride: boolean }}
 *  - hostSlug null → not a wildcard tenant host; params behave as before.
 *  - hostSlug set + allowOverride true → param matches the host slug.
 *  - hostSlug set + allowOverride false → mismatched/absent-host override;
 *    caller must resolve from the host and ignore the params.
 */
export function evaluateTenantOverride(hostname, tenantParam) {
  const hostSlug = getIconnHostSlug(hostname);
  if (!hostSlug) return { hostSlug: null, allowOverride: true };
  const param = String(tenantParam || '').trim().toLowerCase();
  return { hostSlug, allowOverride: !!param && param === hostSlug };
}
