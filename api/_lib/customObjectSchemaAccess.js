import { hasFeatureAccess as defaultFeatureAccess } from './tenantContext.js';
import { isResourceExcluded } from './roleVisibility.js';

export const VIEW_SCHEMA_FEATURE = 'admin.data-studio';
export const MANAGE_SCHEMA_FEATURE = 'data.custom-objects.manage-data-model';

/**
 * Resolve schema capabilities from the authenticated tenant context.
 *
 * This intentionally accepts no request/query values.  Tenant users are trusted
 * schema owners, while portal members must have the corresponding role feature
 * and may not have a member-level exclusion for that feature.
 */
export async function resolveTrustedSchemaCapabilities(
  context,
  {
    hasFeatureAccess = defaultFeatureAccess,
    enabled = true,
  } = {},
) {
  const tenantUser = Boolean(context?.tenantUserId);
  if (tenantUser) return { canViewSchema: true, canManageSchema: true };
  if (!enabled || !context?.roleId) {
    return { canViewSchema: false, canManageSchema: false };
  }

  const memberExclusions = Array.isArray(context.memberExcludedFeatures)
    ? context.memberExcludedFeatures
    : [];
  const canViewSchema = Boolean(await hasFeatureAccess(context.roleId, VIEW_SCHEMA_FEATURE))
    && !isResourceExcluded(memberExclusions, VIEW_SCHEMA_FEATURE);
  const canManageSchema = Boolean(await hasFeatureAccess(context.roleId, MANAGE_SCHEMA_FEATURE))
    && !isResourceExcluded(memberExclusions, MANAGE_SCHEMA_FEATURE);
  return { canViewSchema, canManageSchema };
}