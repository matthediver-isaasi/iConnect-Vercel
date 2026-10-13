import { getSessionMember } from './session.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from './tenantContext.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function accessError(status, message) {
  return Object.assign(new Error(message), { status });
}

export async function historicalInvoiceAccess(req, dependencies = {}) {
  const [member, context] = await Promise.all([
    (dependencies.getSessionMember || getSessionMember)(req),
    (dependencies.getTenantContext || getTenantContext)(req),
  ]);
  if (!member && !context?.isAuthenticated) throw accessError(401, 'Authentication required');
  const memberTenant = member?.tenant_id || member?.organization?.tenant_id;
  if (context?.tenantMismatch || (memberTenant && context?.tenantId && memberTenant !== context.tenantId)) {
    throw accessError(409, 'Tenant context mismatch');
  }
  const tenantId = memberTenant || context?.tenantId;
  if (!tenantId) throw accessError(403, 'Tenant context required');
  const adminContext = member && !context?.tenantUserId
    ? { ...context, isAuthenticated: true, tenantId, memberId: member.id, roleId: member.role_id || null }
    : context;
  const isAdmin = await (dependencies.hasAdminAccess || hasAdminAccess)(adminContext);
  let canAccessInvoices = isAdmin;
  if (!isAdmin) {
    const check = dependencies.hasFeatureAccess || hasFeatureAccess;
    if (!member?.role_id || !await check(member.role_id, 'commerce.history', member.member_excluded_features)) {
      throw accessError(403, 'Membership history access permission required');
    }
    canAccessInvoices = await check(member.role_id, 'commerce.history.access-invoices', member.member_excluded_features);
  }
  return { tenantId, memberId: member?.id, isAdmin, canAccessInvoices };
}
