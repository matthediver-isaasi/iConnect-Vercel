import { allAffiliationRows } from './formAffiliationReview.js';
import { popupQuery } from './cmsPopupService.js';
import { buildRoleAccessOverlay, isResourceExcluded } from './roleVisibility.js';
import { LEGACY_TO_NEW_MAPPING } from './roleAccessHierarchy.generated.js';

// Unlike background navigation caches, popup delivery needs positive current
// evidence. Failure to load either the role or hierarchy must stop delivery.
export async function popupPortalAccess(db, context, feature) {
  const [role, hierarchy] = await Promise.all([
    popupQuery(db.from('role').select('id,excluded_features').eq('tenant_id', context.tenantId)
      .eq('id', context.roleId).maybeSingle()),
    allAffiliationRows(() => db.from('role_access_item')
      .select('id,item_type,item_key,parent_id,is_active', { count: 'exact' })),
  ]);
  if (!role || !Array.isArray(role.excluded_features)) throw new Error('Portal role unavailable');
  const normalize = key => LEGACY_TO_NEW_MAPPING[key] || key;
  const excluded = [...role.excluded_features, ...(context.memberExcludedFeatures || [])].map(normalize);
  const key = normalize(feature);
  if (isResourceExcluded(excluded, key)) return false;
  const overlay = buildRoleAccessOverlay(hierarchy);
  return !excluded.includes(overlay?.featureToPage.get(key))
    && !excluded.includes(overlay?.resourceToModule.get(key));
}
