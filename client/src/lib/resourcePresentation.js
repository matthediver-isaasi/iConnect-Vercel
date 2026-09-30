export const TENANT_FORM_RESOURCE_TYPE = 'tenant_form';

// This is intentionally the query-string FormView route rather than the
// catch-all pretty URL: it is the canonical standalone route used by existing
// form links and retains every established URL-parameter prefill behavior.
export function buildTenantFormResourceUrl(slug) {
  return `/FormView?slug=${encodeURIComponent(String(slug || '').trim())}`;
}

export function getResourceTypeLabel(type) {
  switch (type) {
    case 'download':
      return 'Download';
    case 'video':
      return 'Watch Video';
    case TENANT_FORM_RESOURCE_TYPE:
      return 'Open Form';
    case 'external_link':
      return 'Visit Site';
    default:
      return 'View Resource';
  }
}

export function getResourceTypeName(type) {
  switch (type) {
    case 'download':
      return 'Download';
    case 'video':
      return 'Video';
    case TENANT_FORM_RESOURCE_TYPE:
      return 'Tenant form';
    case 'external_link':
      return 'External link';
    default:
      return 'Resource';
  }
}

// Canvas has legacy block-level new-tab defaults for existing resources. Tenant
// forms are new and must preserve the choice saved on the resource itself.
export function resolveResourceNewTab(resource, surfaceDefault = true) {
  return resource?.resource_type === TENANT_FORM_RESOURCE_TYPE
    ? resource.open_in_new_tab !== false
    : surfaceDefault;
}