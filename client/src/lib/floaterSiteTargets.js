/**
 * Floater site-targeting is deliberately nullable:
 * - no saved value is a legacy floater and appears on every public site
 * - a saved value explicitly controls the main site and microsite IDs
 */
export function normalizeFloaterSiteTargets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const micrositeIds = Array.isArray(value.microsite_ids)
    ? [...new Set(value.microsite_ids.filter((id) => typeof id === 'string' && id.trim()))]
    : [];

  return {
    main_site: value.main_site === true,
    microsite_ids: micrositeIds,
  };
}

export function buildFloaterSiteTargets(selectedTargetIds) {
  const selected = new Set(Array.isArray(selectedTargetIds) ? selectedTargetIds : []);
  return {
    main_site: selected.has('main-site'),
    microsite_ids: [...selected].filter((id) => id !== 'main-site'),
  };
}

export function serializeFloaterSiteTargets(selectedTargetIds, preserveLegacyAllSites = false) {
  return preserveLegacyAllSites ? null : buildFloaterSiteTargets(selectedTargetIds);
}

export function selectedFloaterTargetIds(siteTargets, activeMicrosites = []) {
  const targets = normalizeFloaterSiteTargets(siteTargets);
  if (!targets) {
    return [
      'main-site',
      ...activeMicrosites
        .map((microsite) => microsite?.id)
        .filter((id) => typeof id === 'string' && id),
    ];
  }

  return [
    ...(targets.main_site ? ['main-site'] : []),
    ...targets.microsite_ids,
  ];
}

export function isFloaterVisibleOnPublicSite(floater, activeMicrositeId = null) {
  const targets = normalizeFloaterSiteTargets(floater?.site_targets);

  // Existing floaters have no target configuration and intentionally retain
  // their historical "every public site" behavior.
  if (!targets) return true;

  if (activeMicrositeId) {
    return targets.microsite_ids.includes(activeMicrositeId);
  }

  return targets.main_site;
}

export function filterFloatersForPublicSite(floaters, activeMicrositeId = null) {
  return (Array.isArray(floaters) ? floaters : [])
    .filter((floater) => isFloaterVisibleOnPublicSite(floater, activeMicrositeId));
}

export function resolveDisplayedFloaters({
  floaters,
  location = 'portal',
  activeMicrositeId = null,
  publicSiteContextReady = true,
}) {
  const rows = Array.isArray(floaters) ? floaters : [];
  if (location !== 'public') return rows;
  if (!publicSiteContextReady) return [];
  return filterFloatersForPublicSite(rows, activeMicrositeId);
}