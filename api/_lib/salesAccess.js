import { hasFeatureAccess } from './tenantContext.js';
import { isResourceExcluded } from './roleVisibility.js';
import { SALES_CAPABILITIES } from '../../shared/salesContracts.js';

export class SalesHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function salesActor(context) {
  if (context?.tenantUserId) return { actorId: context.tenantUserId, actorType: 'tenant_user' };
  if (context?.memberId) return { actorId: context.memberId, actorType: 'member' };
  throw new SalesHttpError(401, 'Authenticated Sales actor required');
}

export async function requireSalesContext(context, capability, dependencies = {}) {
  if (context?.tenantMismatch) throw new SalesHttpError(409, 'Tenant context mismatch');
  if (!context?.isAuthenticated) throw new SalesHttpError(401, 'Authentication required');
  if (!context?.tenantId) throw new SalesHttpError(400, 'Tenant context not found');

  // Dashboard tenant users are trusted tenant administrators. Portal users
  // must have both the Sales baseline and the independently requested action.
  if (!context.tenantUserId) {
    if (!context.roleId) throw new SalesHttpError(403, 'Sales access denied');
    const check = dependencies.hasFeatureAccess || hasFeatureAccess;
    const memberExclusions = context.memberExcludedFeatures || [];
    const baseline = !isResourceExcluded(memberExclusions, SALES_CAPABILITIES.VIEW)
      && await check(context.roleId, SALES_CAPABILITIES.VIEW);
    const action = capability === SALES_CAPABILITIES.VIEW || (
      !isResourceExcluded(memberExclusions, capability)
      && await check(context.roleId, capability)
    );
    if (!baseline || !action) throw new SalesHttpError(403, 'Sales capability denied');
  }
  return { tenantId: context.tenantId, ...salesActor(context) };
}