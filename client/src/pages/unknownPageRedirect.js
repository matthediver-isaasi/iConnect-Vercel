import { getTenantSlugFromLocation } from "@/api/publicClient";

export function getRedirectTenantIdentity() {
  return `${window.location.host}|${getTenantSlugFromLocation() || ''}`;
}

export async function resolveUnknownPage(path, signal) {
  const params = new URLSearchParams({ path });
  const tenant = getTenantSlugFromLocation();
  if (tenant) params.set('tenant', tenant);
  const response = await fetch(`/api/redirects/resolve?${params}`, {
    credentials: 'include',
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('Unable to check page redirects.');
  const result = await response.json();
  if (typeof result?.found !== 'boolean') throw new Error('Invalid page redirect response.');
  return result;
}

export function getUnknownPageRedirectTarget(result, pathname) {
  if (!result?.found || result.route_outcome === 'existing' || result.route_outcome === 'restricted') return null;
  const target = result.target_url;
  if (typeof target !== 'string' || !target.trim()) return null;
  let url;
  try {
    url = new URL(target, window.location.origin);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  if (url.origin === window.location.origin && url.pathname.replace(/\/+$/, '') === pathname.replace(/\/+$/, '')) return null;
  return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
}