import { sanitizeHostname } from '../../_lib/publicBaseUrl.js';

const ICONN_ENV_LABELS = new Set(['dev', 'testing', 'preview', 'staging']);

export function isAdminMembership(membership) {
  return Boolean(
    membership
    && membership.status === 'active'
    && (
      membership.role === 'owner'
      || membership.role === 'admin'
      || membership.membership_type === 'owner'
    )
  );
}

export function selectAdminMembership(memberships, targetTenantId = null) {
  const adminMemberships = (memberships || []).filter(isAdminMembership);

  if (targetTenantId) {
    return adminMemberships.find(
      (membership) => membership.tenant_id === targetTenantId
    ) || null;
  }

  return adminMemberships[0] || null;
}

function requestHostname(req) {
  const forwarded = String(req?.headers?.['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const direct = String(req?.headers?.host || '').trim();
  return sanitizeHostname((forwarded || direct).split(':')[0]);
}

export function getAdminResetBaseUrl(req, tenant) {
  const slug = String(tenant?.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(slug)) {
    return 'https://iconn.app';
  }

  const host = requestHostname(req);
  const customDomain = sanitizeHostname(tenant?.domain);

  if (host && customDomain && host === customDomain) {
    return `https://${customDomain}`;
  }

  if (host === `${slug}.iconn.app`) {
    return `https://${host}`;
  }

  const iconnMatch = host?.match(/^([a-z0-9-]+)\.iconn\.app$/);
  if (iconnMatch && ICONN_ENV_LABELS.has(iconnMatch[1])) {
    return `https://${slug}.${iconnMatch[1]}.iconn.app`;
  }

  const tenantEnvMatch = host?.match(
    new RegExp(`^${slug}\\.(dev|testing|preview|staging)\\.iconn\\.app$`)
  );
  if (tenantEnvMatch) {
    return `https://${host}`;
  }

  const configuredDomain = sanitizeHostname(process.env.APP_DOMAIN) || 'iconn.app';
  return `https://${slug}.${configuredDomain}`;
}