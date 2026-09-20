import { getHostFromRequest, resolveTenantFromHost, resolveTenantFromRequest } from './tenantResolver.js';

// Page routing is not an embedded API: real host ownership is authoritative.
// Do not fall back to query hints when a real custom/wildcard host is unknown.
export function createPageTenantResolver({
  resolveHost = resolveTenantFromHost,
  resolveRequest = resolveTenantFromRequest,
} = {}) {
  return async function resolvePageTenant(req) {
    const rawHost = String(getHostFromRequest(req) || '').trim().toLowerCase();
    const host = rawHost.replace(/:\d+$/, '');
    const developmentHost = host === 'localhost' || host === '127.0.0.1'
      || host === '[::1]' || host.endsWith('.replit.dev') || host.endsWith('.repl.co');
    if (developmentHost) return resolveRequest(req);
    if (!host || /[,\s/\\]/.test(host)) return null;
    return resolveHost(rawHost);
  };
}

export const resolvePageTenant = createPageTenantResolver();