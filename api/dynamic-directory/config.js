import { getTenantContext } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { projectOrganisationCoreValues } from '../../shared/organisationDirectoryCore.js';
import { canReadOrganisationDirectory, revalidateOrganisationPublication } from '../_lib/organisationDirectoryPublication.js';
import { readCompleteOrganisationDirectoryPages } from '../_lib/organisationDirectoryFilters.js';
import {
  isVisibleInDirectory,
  enrichField,
  sortFieldsForDirectory,
  fetchRoles,
  fetchMemberDisplaySettings,
  fetchMemberFields,
  fetchOrgDisplaySettings,
  applyCoreFieldVisibility,
  isOrgCoreItemVisible,
  publicDirectoryBackOrder,
} from '../_lib/directoryConfig.js';

/**
 * Public directory config endpoint.
 *
 * Returns everything the Dynamic Directory view needs to render for a guest
 * (logged-out) visitor: the directory config plus display settings, roles,
 * custom fields, and — for organisation directories — the org list and org
 * preference values. Members and member preference values are served by the
 * sibling /members and /member-preferences endpoints.
 *
 * Tenant is resolved from the request host (same as /members), so this works
 * for unauthenticated visitors on tenant subdomains. Inactive/missing
 * directories return 404 exactly like the authenticated path.
 */
export default async function handler(req, res, dependencies = {}) {
  const db = dependencies.supabase || supabase;
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tenantContext = await (dependencies.getTenantContext || getTenantContext)(req);
  if (tenantContext.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
  if (!tenantContext.tenantId) {
    return res.status(401).json({ error: 'Unauthorized - tenant required' });
  }
  const { tenantId } = tenantContext;

  const { slug } = req.query;
  if (!slug) {
    return res.status(400).json({ error: 'slug is required' });
  }

  try {
    const { data: directories, error: dirError } = await db
      .from('dynamic_directory')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('slug', slug)
      .eq('is_active', true)
      .limit(1);

    if (dirError) {
      console.error('[DynamicDirectory Config] Directory lookup error:', dirError);
      return res.status(500).json({ error: 'Failed to look up directory' });
    }

    const directory = directories?.[0];
    if (!directory) {
      return res.status(404).json({ error: 'Directory not found' });
    }
    if (!tenantContext.isAuthenticated) directory.back_field_order = publicDirectoryBackOrder(directory.back_field_order);

    const dirId = directory.id;

    // Roles (needed for RoleBadge / reverse-card grouping)
    const roles = await fetchRoles(db, tenantId);

    // Filter field label
    let filterField = null;
    if (directory.filter_field_id) {
      const { data: ff } = await db
        .from('preference_field')
        .select('id, label')
        .eq('id', directory.filter_field_id)
        .limit(1);
      filterField = ff?.[0] || null;
    }

    if (directory.entity_type === 'member') {
      return await buildMemberConfig({ res, tenantId, directory, dirId, roles, filterField });
    }
    if (directory.entity_type === 'organization') {
      if (!canReadOrganisationDirectory(directory, tenantContext, tenantId)) {
        return res.status(403).json({ error: 'Directory access denied' });
      }
      return await buildOrgConfig({ res, tenantId, directory, dirId, roles, filterField, context: tenantContext, supabase: db });
    }
    return res.status(400).json({ error: `Directory entity type '${directory.entity_type}' is not supported.` });
  } catch (err) {
    console.error('[DynamicDirectory Config] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch directory config' });
  }
}

// --- member directory config ------------------------------------------------

async function buildMemberConfig({ res, tenantId, directory, dirId, roles, filterField }) {
  // Layer this directory's core-field visibility overrides over the global
  // settings so guests resolve visibility exactly like logged-in members.
  const displaySettings = applyCoreFieldVisibility(
    await fetchMemberDisplaySettings(supabase, tenantId),
    directory.core_field_visibility
  );

  const { data: allOrgRows } = await supabase
    .from('organization')
    .select('id, name')
    .eq('tenant_id', tenantId);
  const allOrganizations = allOrgRows || [];

  const { memberCustomFields, directoryCustomFields } = await fetchMemberFields(supabase, tenantId, dirId);

  return res.json({
    directory,
    filterField,
    roles,
    displaySettings,
    allOrganizations,
    memberCustomFields,
    directoryCustomFields,
  });
}

// --- organisation directory config ------------------------------------------

async function buildOrgConfig({ res, tenantId, directory, dirId, roles, filterField, context, supabase }) {
  const displaySettings = await fetchOrgDisplaySettings(supabase, tenantId);
  if (!context.isAuthenticated) displaySettings.backFieldOrder = publicDirectoryBackOrder(displaySettings.backFieldOrder);
  displaySettings.showMemberCount = isOrgCoreItemVisible(
    directory.core_field_visibility, 'org_member_count', displaySettings.showMemberCount
  );

  const orgRows = await readCompleteOrganisationDirectoryPages(() => supabase
    .from('organization')
    .select(`id, name, logo_url, website_url, phone, description${context.isAuthenticated ? ', invoicing_address' : ''}`)
    .eq('tenant_id', tenantId)
    .order('name', { ascending: true }).order('id', { ascending: true }), 'Organisation inventory');
  let organizations = orgRows || [];

  const { data: fieldRows } = await supabase
    .from('preference_field')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .eq('entity_scope', 'organization')
    .order('display_order', { ascending: true });
  const orgCustomFields = sortFieldsForDirectory(
    (fieldRows || [])
      .filter((f) => isVisibleInDirectory(f, dirId))
      .map((f) => enrichField(f, dirId))
  );

  // organization_preference_value has no tenant_id column; scope via org ids.
  const orgIds = organizations.map((o) => o.id);
  const allOrgPreferenceValues = await fetchOrgPreferenceValues(orgIds, supabase);
  if (directory.filter_field_id && directory.filter_value) {
    const matching = new Set(allOrgPreferenceValues.filter(value => {
      if (value.field_id !== directory.filter_field_id) return false;
      let raw = value.value;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch {}
      }
      return (Array.isArray(raw) ? raw : [raw]).some(v => String(v) === String(directory.filter_value));
    }).map(value => value.organization_id));
    organizations = organizations.filter(org => matching.has(org.id));
  }
  const allowedIds = new Set(organizations.map(org => org.id));
  const allowedFields = new Set([...orgCustomFields.map(field => field.id), directory.filter_field_id]);
  if (!await revalidateOrganisationPublication({ db: supabase, tenantId, directory, settings: displaySettings, context })) {
    return res.status(409).json({ error: 'Directory publication changed; retry' });
  }

  return res.json({
    directory,
    filterField,
    roles,
    displaySettings,
    organizations: organizations.map(org => ({
      id: org.id, name: org.name,
      ...(displaySettings.showLogo ? { logo_url: org.logo_url } : {}),
      ...(context.isAuthenticated && typeof org.invoicing_address === 'string' && org.invoicing_address.trim()
        ? { invoicing_address: org.invoicing_address } : {}),
      ...projectOrganisationCoreValues(org, displaySettings.corePublication, directory.core_field_visibility),
    })),
    orgCustomFields,
    allOrgPreferenceValues: allOrgPreferenceValues.filter(value => allowedIds.has(value.organization_id) && allowedFields.has(value.field_id)),
  });
}

async function fetchOrgPreferenceValues(orgIds, supabase) {
  if (!orgIds || orgIds.length === 0) return [];
  const results = [];
  const chunkSize = 200; // keep .in() lists reasonable
  for (let i = 0; i < orgIds.length; i += chunkSize) {
    const chunk = orgIds.slice(i, i + chunkSize);
    let offset = 0;
    const batchSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from('organization_preference_value')
        .select('organization_id, field_id, value')
        .in('organization_id', chunk)
        .range(offset, offset + batchSize - 1);
      if (error) throw new Error('Unable to load organisation directory values');
      if (!data || data.length === 0) break;
      results.push(...data);
      if (data.length < batchSize) break;
      offset += batchSize;
    }
  }
  return results;
}
