// Admin/CRM organisation list helpers.
//
// The Organization list endpoint applies public-directory filters
// (org_directory_excluded_orgs + org_directory_allowed_application_statuses)
// to any non-tenant-admin session unless the request passes
// skipDirectoryFilters=true. Directory hiding is front-of-house only, so
// admin/CRM surfaces must always request the unfiltered list via these
// helpers. The server only honours the flag for tenant admins or roles with
// cross-org (CRM) access, so it is safe to pass unconditionally from admin
// pages — plain members remain filtered.
import { base44 } from '@/api/base44Client';

function withSkipDirectoryFilters(options = {}) {
  // Normalise the legacy string-sort form ('name' / '-name'), since the
  // string path in base44Client.list() cannot carry extra query params.
  let opts = options;
  if (typeof options === 'string') {
    const ascending = !options.startsWith('-');
    const field = options.replace(/^-/, '');
    opts = { sort: { [field]: ascending ? 'asc' : 'desc' } };
  }
  return {
    ...opts,
    queryParams: { ...(opts.queryParams || {}), skipDirectoryFilters: 'true' },
  };
}

export function listOrganizationsForAdmin(options = {}) {
  return base44.entities.Organization.list(withSkipDirectoryFilters(options));
}

export function listAllOrganizationsForAdmin(options = {}) {
  return base44.entities.Organization.listAll(withSkipDirectoryFilters(options));
}
