import { projectMemberOnlyGuest } from "../../../shared/canvasMemberOnly.js";

let dynamicPageRequestScopeSequence = 0;

/**
 * React Query caches outlive component instances. A mount-scoped transport key
 * prevents a newly mounted page from adopting a raw response created under an
 * earlier cookie session, while remaining stable for this mount's refetches.
 */
export function createDynamicPageRequestScope() {
  dynamicPageRequestScopeSequence += 1;
  return `dynamic-page-mount-${dynamicPageRequestScopeSequence}`;
}

export function isRelevantAccountStorageTransition(event) {
  if (event?.key !== null && event?.key !== 'agcas_member') return false;
  if (event.key === 'agcas_member' && event.oldValue && event.newValue) {
    try {
      const previous = JSON.parse(event.oldValue);
      const next = JSON.parse(event.newValue);
      if (
        previous.id === next.id
        && previous.tenant_id === next.tenant_id
        && previous.organization_id === next.organization_id
      ) return false;
    } catch {
      // Malformed account storage is security-relevant and must invalidate.
    }
  }
  return true;
}

/**
 * Resolve the public transport directly from the URL whenever possible.
 * Two-segment microsite routes do not need to wait for the microsite catalogue;
 * the public endpoint validates the prefix and tenant itself. A bare-prefix
 * home switches to its scoped slug only after that route metadata is known.
 */
export function getEarlyPublicPageRequest({
  slug,
  routeMicrositePrefix,
  micrositeHome,
}) {
  if (!slug) return null;
  if (routeMicrositePrefix) {
    return {
      slug,
      micrositePrefix: routeMicrositePrefix.toLowerCase(),
    };
  }
  if (micrositeHome?.home_slug && micrositeHome?.path_prefix) {
    return {
      slug: micrositeHome.home_slug,
      micrositePrefix: micrositeHome.path_prefix,
    };
  }
  return { slug, micrositePrefix: null };
}

/**
 * The early response may have been produced while auth was still checking.
 * Re-project it for a resolved guest rather than trusting that a cached payload
 * cannot contain member-only Canvas content.
 */
export function projectPublicPageDataForAudience(data, allowMemberOnlyContent) {
  if (!data) return { page: null, elements: [] };
  if (allowMemberOnlyContent) {
    return {
      page: data.page,
      elements: data.elements || [],
      symbols: data.symbols,
    };
  }
  return {
    page: projectMemberOnlyGuest(data.page),
    elements: data.elements || [],
    symbols: Array.isArray(data.symbols)
      ? data.symbols.map((symbol) => projectMemberOnlyGuest(symbol))
      : data.symbols,
  };
}