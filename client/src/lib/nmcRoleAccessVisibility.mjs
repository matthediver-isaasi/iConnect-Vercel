import { BNMS_TENANT_ID, isNmcReportDestination } from "./nmcMembershipReport.mjs";

// Presentation-only filtering. Never use these maps for authorization or for
// rewriting stored role exclusions; the canonical RBAC map remains complete.
export function isNmcRoleAccessItem(item) {
  return isNmcReportDestination({ value: item?.item_key || item?.id || item?.value });
}

export function filterNmcRoleAccessMap(map, tenantId) {
  if (tenantId === BNMS_TENANT_ID) return map;
  const filterNodes = nodes => (nodes || [])
    .filter(item => !isNmcRoleAccessItem(item))
    .map(item => ({
      ...item,
      ...(item.pages ? { pages: filterNodes(item.pages) } : {}),
      ...(item.features ? { features: filterNodes(item.features) } : {}),
    }));
  return filterNodes(map);
}

export function filterNmcRoleAccessItems(items, tenantId) {
  if (tenantId === BNMS_TENANT_ID) return items;
  const hiddenIds = new Set(items.filter(isNmcRoleAccessItem).map(item => item.id));
  // Hide descendants too if a tenant's custom configuration nests additional
  // nodes under this permission. Do not leave orphan suggestions in the editor.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (hiddenIds.has(item.parent_id) && !hiddenIds.has(item.id)) {
        hiddenIds.add(item.id);
        changed = true;
      }
    }
  }
  return items.filter(item => !hiddenIds.has(item.id));
}
