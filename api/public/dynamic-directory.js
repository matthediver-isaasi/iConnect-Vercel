import { createClient } from '@supabase/supabase-js';
import { createHmac } from 'node:crypto';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import {
  makeFeatureAccessChecker,
  resolveMemberExclusions,
} from '../_lib/memberFeatureAccess.js';
import { normalizeOrganizationPreferenceValues } from '../_lib/organizationEligibility.js';
import {
  fetchRoles,
  fetchMemberDisplaySettings,
  fetchMemberFields,
  fetchOrgDisplaySettings,
  applyCoreFieldVisibility,
  isOrgCoreItemVisible,
  publicDirectoryBackOrder,
} from '../_lib/directoryConfig.js';

// Columns fetched for the public directory row. Must include
// back_field_order (per-directory back-of-card order override) and
// show_members_on_card_back so guest/Canvas consumers can resolve the
// unified back-of-card order exactly like the portal does.
export const PUBLIC_DIRECTORY_SELECT =
  'id, slug, name, entity_type, filter_field_id, filter_value, is_active, allowed_role_ids, back_field_order, show_members_on_card_back, core_field_visibility, custom_fields_label';

// Carousel responses are deliberately much smaller than the existing directory
// response.  The upper bound is part of the API contract: callers cannot turn
// this endpoint into an organisation export by asking for a large limit.
export const MAX_CAROUSEL_PAGE_SIZE = 50;
const CAROUSEL_QUERY_BATCH_SIZE = 1000;
const MAX_CAROUSEL_CANDIDATES = 100000;
const DEFAULT_CAROUSEL_SEED = 'alpha';
const CAROUSEL_POLICY_SETTING_KEYS = [
  'org_directory_show_logo',
  'org_directory_show_title',
  'org_directory_show_domains',
  'org_directory_excluded_orgs',
  'org_directory_allowed_application_statuses',
  'org_directory_visible_org_types',
];
const CAROUSEL_ELIGIBILITY_FIELD_NAMES = [
  'application_status',
  'org_type',
  'organisation_type',
  'organization_type',
];

const CAROUSEL_ORGANIZATION_SELECT = 'id, name, logo_url';

// Public shape of the directory row returned to embeds.
export function buildPublicDirectoryPayload(directory) {
  if (!directory) return null;
  return {
    id: directory.id,
    slug: directory.slug,
    name: directory.name,
    entity_type: directory.entity_type,
    back_field_order: publicDirectoryBackOrder(directory.back_field_order),
    show_members_on_card_back: directory.show_members_on_card_back !== false,
    core_field_visibility: (directory.core_field_visibility && typeof directory.core_field_visibility === 'object' && !Array.isArray(directory.core_field_visibility))
      ? directory.core_field_visibility
      : null,
    custom_fields_label: (typeof directory.custom_fields_label === 'string' && directory.custom_fields_label.trim())
      ? directory.custom_fields_label.trim()
      : null,
  };
}

export async function dynamicDirectoryHandler(req, res, dependencies = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (req.query?.mode === 'carousel' && typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  }

  let supabase = dependencies.supabase;
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !supabaseServiceKey) {
      return res.status(503).json({ error: 'Supabase not configured' });
    }
    supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  const {
    mode,
    slug,
    page = '1',
    limit = '12',
    seed,
    sort = 'name-asc',
    search,
    filters,
  } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug is required' });

  const resolveTenant = dependencies.resolveTenant || resolveTenantFromRequest;
  // `resolveTenantFromRequest` normally accepts `?slug=` as a legacy tenant
  // alias.  Here slug is the directory identifier, so allowing it to become
  // the tenant selector would let a directory slug override the host tenant.
  // Explicit ?tenant= remains supported for embedded contexts; otherwise the
  // resolver uses the request host.
  const tenantRequest = mode === 'carousel'
    ? { ...req, query: { ...req.query, slug: undefined } }
    : req;
  let tenant;
  try {
    tenant = await resolveTenant(tenantRequest);
  } catch (err) {
    if (mode === 'carousel') {
      console.error('[PublicDynamicDirectory] Carousel tenant resolution error:', err);
      return res.status(500).json({ error: 'Failed to resolve tenant context' });
    }
    throw err;
  }
  if (!tenant) return res.status(400).json({ error: 'Invalid tenant context' });
  const tenantId = tenant.id;

  // Carousel has a deliberately narrow contract and never falls through to
  // the legacy member/organisation renderer.  In particular, this keeps
  // legacy fields such as slug, city, and custom values out of carousel
  // responses.
  if (mode === 'carousel') {
    try {
      return await renderOrganizationCarousel({
        supabase,
        tenantId,
        req: tenantRequest,
        slug,
        page,
        limit,
        seed,
        resolveTenantContext: dependencies.getTenantContext || getTenantContext,
        featureCheck: dependencies.hasFeatureAccess || hasFeatureAccess,
        exclusionsResolver: dependencies.resolveMemberExclusions || resolveMemberExclusions,
        res,
      });
    } catch (err) {
      console.error('[PublicDynamicDirectory] Carousel error:', err);
      return res.status(500).json({ error: 'Failed to fetch directory records' });
    }
  }

  let customFilters = {};
  if (filters) {
    try { const parsed = JSON.parse(filters); if (parsed && typeof parsed === 'object') customFilters = parsed; }
    catch { return res.status(400).json({ error: 'Invalid filters JSON' }); }
  }

  try {
    const { data: directories, error: dirError } = await supabase
      .from('dynamic_directory')
      .select(PUBLIC_DIRECTORY_SELECT)
      .eq('tenant_id', tenantId)
      .eq('slug', slug)
      .eq('is_active', true)
      .limit(1);

    if (dirError) {
      console.error('[PublicDynamicDirectory] Directory lookup error:', dirError);
      return res.status(500).json({ error: 'Failed to look up directory' });
    }
    const directory = directories?.[0];
    if (!directory) return res.status(404).json({ error: 'Directory not found' });

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(limit, 10) || 12));
    const offset = (pageNum - 1) * pageSize;

    if (directory.entity_type === 'member') {
      return await renderMembers({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res });
    }
    if (directory.entity_type === 'organization') {
      return await renderOrganizations({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res });
    }
    return res.status(400).json({ error: `Directory entity type '${directory.entity_type}' is not supported in public embeds yet.` });
  } catch (err) {
    console.error('[PublicDynamicDirectory] Error:', err);
    return res.status(500).json({ error: 'Failed to fetch directory records' });
  }
}

export default function handler(req, res) {
  return dynamicDirectoryHandler(req, res);
}

/**
 * Normalize a directory's role policy without treating malformed persisted
 * data as an unrestricted directory.  The selected carousel directory still
 * requires an authenticated member when the normalized list is empty.
 */
export function parseCarouselAllowedRoleIds(value) {
  if (value === null || value === undefined || value === '') {
    return { valid: true, ids: [] };
  }

  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { valid: false, ids: [] };
    }
  }
  if (!Array.isArray(parsed)) return { valid: false, ids: [] };

  const ids = [];
  const seen = new Set();
  for (const id of parsed) {
    if (typeof id !== 'string' || !id.trim()) return { valid: false, ids: [] };
    const normalized = id.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
  }
  return { valid: true, ids };
}

/**
 * Synchronous policy decision after the authoritative feature/exclusion
 * snapshot has been resolved.  An empty allowed_role_ids list means all
 * authenticated member roles, not an anonymous/public directory.
 */
export function authorizeCarouselDirectory({
  context,
  tenantId,
  allowedRoleIds,
  featureAllowed = false,
}) {
  const contextTenantId = context?.tenantId || context?.tenantFromHost?.id || null;
  if (!context || context.tenantMismatch || !contextTenantId || contextTenantId !== tenantId) {
    return { allowed: false, reason: 'tenant-mismatch' };
  }
  if (!context.isAuthenticated && !context.tenantUserId) {
    return { allowed: false, reason: 'authentication-required' };
  }
  if (context.tenantUserId) return { allowed: true, reason: 'tenant-user' };
  if (!context.roleId) return { allowed: false, reason: 'role-required' };
  if (!featureAllowed) return { allowed: false, reason: 'feature-denied' };
  if (allowedRoleIds.length === 0) {
    return { allowed: true, reason: 'all-member-roles' };
  }
  return allowedRoleIds.includes(String(context.roleId).trim())
    ? { allowed: true, reason: 'allowed-role' }
    : { allowed: false, reason: 'role-denied' };
}

async function resolveCarouselAuthority({
  context,
  tenantId,
  allowedRoleIds,
  db,
  featureCheck,
  exclusionsResolver,
}) {
  const contextTenantId = context?.tenantId || context?.tenantFromHost?.id || null;
  if (!context || context.tenantMismatch || !contextTenantId || contextTenantId !== tenantId) {
    return { allowed: false, reason: 'tenant-mismatch' };
  }
  if (!context.isAuthenticated && !context.tenantUserId) {
    return { allowed: false, reason: 'authentication-required' };
  }
  if (context.tenantUserId) {
    return authorizeCarouselDirectory({
      context, tenantId, allowedRoleIds, featureAllowed: true,
    });
  }
  if (!context.roleId) {
    return { allowed: false, reason: 'role-required' };
  }
  const featureAllowed = await featureCheck(
    context.roleId,
    'membership.organisation-directory',
    context.memberExcludedFeatures,
  );
  if (!featureAllowed) {
    return { allowed: false, reason: 'feature-denied' };
  }
  const exclusions = await exclusionsResolver({
    roleId: context.roleId,
    memberExcludedFeatures: context.memberExcludedFeatures,
  }, db);
  const hierarchyAllowsFeature = makeFeatureAccessChecker(exclusions)
    .canAccessFeature('membership.organisation-directory');
  return authorizeCarouselDirectory({
    context,
    tenantId,
    allowedRoleIds,
    featureAllowed: hierarchyAllowsFeature,
  });
}

function parseCarouselPagination(page, limit) {
  const parsePositive = (raw, fallback) => {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === null || value === '') return fallback;
    const text = String(value);
    if (!/^\d+$/.test(text)) return fallback;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  const pageNum = parsePositive(page, 1);
  const pageSize = Math.min(
    MAX_CAROUSEL_PAGE_SIZE,
    parsePositive(limit, 12),
  );
  return { pageNum, pageSize };
}

export function normalizeCarouselSeed(seed) {
  const value = Array.isArray(seed) ? seed[0] : seed;
  if (value === undefined || value === null || value === '') return DEFAULT_CAROUSEL_SEED;
  const normalized = String(value);
  // A bounded seed avoids oversized hashing work and gives callers a clear
  // contract rather than silently truncating their ordering key.
  if (normalized.length > 128) return null;
  return normalized;
}

/**
 * Stable, globally seeded ordering.  The hash is calculated over the whole
 * eligible set before slicing a page; the final ID comparison is a unique
 * deterministic tie-breaker for hash collisions.
 */
export function seededOrganizationOrder(organizations, seed = DEFAULT_CAROUSEL_SEED) {
  const effectiveSeed = normalizeCarouselSeed(seed);
  if (effectiveSeed === null) return null;

  // The default/no-seed contract is the ordinary directory order.  Keep the
  // explicit "alpha" seed equivalent to the omitted seed so clients can
  // persist the returned seed without changing the order.
  if (effectiveSeed === DEFAULT_CAROUSEL_SEED) {
    return [...(organizations || [])].sort((left, right) =>
      String(left?.name ?? '').localeCompare(String(right?.name ?? ''), undefined, {
        sensitivity: 'base',
      }) || String(left?.id ?? '').localeCompare(String(right?.id ?? '')));
  }

  const ranked = (organizations || []).map((organization, index) => ({
    organization,
    index,
    rank: createHmac('sha256', effectiveSeed)
      .update(String(organization?.id ?? ''))
      .digest('hex'),
  }));

  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    const aId = String(a.organization?.id ?? '');
    const bId = String(b.organization?.id ?? '');
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return a.index - b.index;
  });
  return ranked.map(({ organization }) => organization);
}

function projectCarouselOrganization(organization, displaySettings = {}) {
  // Keep this allow-list literal.  Do not spread an organization row: it may
  // contain internal notes, account/balance fields, group IDs, or other
  // tenant-private columns.
  return {
    id: organization?.id ?? null,
    name: displaySettings.showTitle === false ? null : (organization?.name ?? null),
    logo_url: displaySettings.showLogo === false ? null : (organization?.logo_url ?? null),
    // Core organization.description and organization.website_url are not
    // directory-authorized fields.  The latter is populated only from the
    // active verified_domains preference projection below.
    description: null,
    website_url: displaySettings.showDomains === false
      ? null : safeVerifiedDomainUrl(organization?.verified_website_url),
  };
}

export function buildCarouselResponse(organizations, {
  page = 1,
  pageSize = 12,
  seed = DEFAULT_CAROUSEL_SEED,
  displaySettings = {},
} = {}) {
  const ordered = seededOrganizationOrder(organizations, seed);
  if (!ordered) return null;
  const offset = (page - 1) * pageSize;
  return {
    entityType: 'organization',
    records: ordered.slice(offset, offset + pageSize)
      .map((organization) => projectCarouselOrganization(organization, displaySettings)),
    total: ordered.length,
    page,
    pageSize,
    seed: normalizeCarouselSeed(seed),
  };
}

async function renderOrganizationCarousel({
  supabase,
  tenantId,
  req,
  slug,
  page,
  limit,
  seed,
  resolveTenantContext,
  featureCheck,
  exclusionsResolver,
  res,
}) {
  const { pageNum, pageSize } = parseCarouselPagination(page, limit);
  const effectiveSeed = normalizeCarouselSeed(seed);
  if (!effectiveSeed) return res.status(400).json({ error: 'seed is too long' });

  const context = await resolveTenantContext(req);
  if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });
  if (!context?.isAuthenticated && !context?.tenantUserId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const referer = String(req.headers?.referer || req.headers?.referrer || '');
  if (req.query?.embed === 'true' || req.headers?.['x-embed-context'] === 'true'
      || /\/embed(?:\/|[?#]|$)/i.test(referer)) {
    return res.status(403).json({ error: 'Embed access denied' });
  }

  const directory = await fetchCarouselDirectory({ supabase, tenantId, slug });
  if (!directory) return res.status(404).json({ error: 'Directory not found' });
  if (directory.entity_type !== 'organization') {
    return res.status(400).json({ error: 'Carousel mode requires an organization directory' });
  }

  const rolePolicy = parseCarouselAllowedRoleIds(directory.allowed_role_ids);
  if (!rolePolicy.valid) {
    // A malformed policy must never broaden a private directory to public.
    return res.status(403).json({ error: 'Directory access denied' });
  }
  const access = await resolveCarouselAuthority({
    context,
    tenantId,
    allowedRoleIds: rolePolicy.ids,
    db: supabase,
    featureCheck,
    exclusionsResolver,
  });
  if (!access.allowed) return carouselAccessResponse(res, access);

  const displaySettings = await loadCarouselDirectorySettings(supabase, tenantId);
  const filterAuthority = await loadCarouselFilterAuthority({
    supabase,
    tenantId,
    fieldId: directory.filter_field_id,
    filterValue: directory.filter_value,
  });
  const verifiedDomainAuthority = await loadCarouselVerifiedDomainAuthority({
    supabase,
    tenantId,
  });
  const eligibilityAuthority = await loadCarouselEligibilityAuthority({
    supabase,
    tenantId,
  });
  const initialAuthorityFingerprint = carouselAuthorityFingerprint({
    tenantId,
    context,
    directory,
    rolePolicy,
    displaySettings,
    filterAuthority,
    verifiedDomainAuthority,
    eligibilityAuthority,
  });
  const organizations = await fetchCarouselOrganizations({
    supabase,
    tenantId,
    filterAuthority,
    verifiedDomainAuthority,
    eligibilityAuthority,
    requesterOrganizationId: context.organizationId,
    displaySettings,
  });

  // Organisation scans can take several paged queries. Re-read the
  // authenticated context and selected directory policy before returning the
  // result so a role/feature revocation during the scan cannot publish a
  // stale snapshot.
  const refreshedContext = await resolveTenantContext(req);
  if (refreshedContext?.tenantMismatch) {
    return res.status(409).json({ error: 'Tenant context mismatch' });
  }
  const refreshedDirectory = await fetchCarouselDirectory({
    supabase, tenantId, slug,
  });
  if (!refreshedDirectory) return res.status(404).json({ error: 'Directory not found' });
  if (refreshedDirectory.entity_type !== 'organization') {
    return res.status(400).json({ error: 'Carousel mode requires an organization directory' });
  }
  const refreshedPolicy = parseCarouselAllowedRoleIds(refreshedDirectory.allowed_role_ids);
  if (!refreshedPolicy.valid) return res.status(403).json({ error: 'Directory access denied' });
  const refreshedDisplaySettings = await loadCarouselDirectorySettings(supabase, tenantId);
  const refreshedFilterAuthority = await loadCarouselFilterAuthority({
    supabase,
    tenantId,
    fieldId: refreshedDirectory.filter_field_id,
    filterValue: refreshedDirectory.filter_value,
  });
  const refreshedVerifiedDomainAuthority = await loadCarouselVerifiedDomainAuthority({
    supabase,
    tenantId,
  });
  const refreshedEligibilityAuthority = await loadCarouselEligibilityAuthority({
    supabase,
    tenantId,
  });
  const refreshedAuthorityFingerprint = carouselAuthorityFingerprint({
    tenantId,
    context: refreshedContext,
    directory: refreshedDirectory,
    rolePolicy: refreshedPolicy,
    displaySettings: refreshedDisplaySettings,
    filterAuthority: refreshedFilterAuthority,
    verifiedDomainAuthority: refreshedVerifiedDomainAuthority,
    eligibilityAuthority: refreshedEligibilityAuthority,
  });
  if (refreshedAuthorityFingerprint !== initialAuthorityFingerprint) {
    return res.status(409).json({ error: 'Directory authority changed; retry' });
  }
  const refreshedAccess = await resolveCarouselAuthority({
    context: refreshedContext,
    tenantId,
    allowedRoleIds: refreshedPolicy.ids,
    db: supabase,
    featureCheck,
    exclusionsResolver,
  });
  if (!refreshedAccess.allowed) return carouselAccessResponse(res, refreshedAccess);

  const response = buildCarouselResponse(organizations, {
    page: pageNum,
    pageSize,
    seed: effectiveSeed,
    displaySettings: refreshedDisplaySettings,
  });
  return res.json(response);
}

async function fetchCarouselDirectory({ supabase, tenantId, slug }) {
  const { data: directories, error: directoryError } = await supabase
    .from('dynamic_directory')
    .select(PUBLIC_DIRECTORY_SELECT)
    .eq('tenant_id', tenantId)
    .eq('slug', slug)
    .eq('is_active', true)
    .limit(1);
  if (directoryError) {
    console.error('[PublicDynamicDirectory] Carousel directory lookup error:', directoryError);
    throw new Error('Failed to look up carousel directory');
  }
  const directory = directories?.[0];
  return directory || null;
}

function stableAuthorityValue(value) {
  if (Array.isArray(value)) return value.map(stableAuthorityValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key, stableAuthorityValue(value[key]),
    ]));
  }
  return value;
}

function carouselAuthorityFingerprint({
  tenantId,
  context,
  directory,
  rolePolicy,
  displaySettings,
  filterAuthority,
  verifiedDomainAuthority,
  eligibilityAuthority,
}) {
  return JSON.stringify(stableAuthorityValue({
    tenantId,
    context: {
      tenantId: context?.tenantId || context?.tenantFromHost?.id || null,
      roleId: context?.roleId || null,
      tenantUserId: context?.tenantUserId || null,
      memberId: context?.memberId || null,
      memberExcludedFeatures: (Array.isArray(context?.memberExcludedFeatures)
        ? context.memberExcludedFeatures : []).slice().sort(),
      organizationId: context?.organizationId || null,
    },
    directory: {
      id: directory?.id || null,
      entityType: directory?.entity_type || null,
      isActive: directory?.is_active === true,
      allowedRoleIds: [...(rolePolicy?.ids || [])].sort(),
      filterFieldId: directory?.filter_field_id || null,
      filterValue: directory?.filter_value ?? null,
    },
    display: {
      showLogo: displaySettings?.showLogo === true,
      showTitle: displaySettings?.showTitle === true,
      showDomains: displaySettings?.showDomains === true,
      excludedOrgIds: [...(displaySettings?.excludedOrgIds || [])].sort(),
      allowedApplicationStatuses: [...(displaySettings?.allowedApplicationStatuses || [])].sort(),
      visibleOrgTypes: [...(displaySettings?.visibleOrgTypes || [])].sort(),
    },
    filterAuthority: {
      applied: filterAuthority?.applied === true,
      valid: filterAuthority?.valid === true,
      field: filterAuthority?.field ? {
        id: filterAuthority.field.id,
        tenantId: filterAuthority.field.tenant_id,
        entityScope: filterAuthority.field.entity_scope,
        isActive: filterAuthority.field.is_active === true,
      } : null,
      value: filterAuthority?.value ?? null,
    },
    verifiedDomainAuthority: (verifiedDomainAuthority || []).map((field) => ({
      id: field.id,
      tenantId: field.tenant_id,
      entityScope: field.entity_scope,
      name: field.name,
      isActive: field.is_active === true,
    })),
    eligibilityAuthority: (eligibilityAuthority || []).map((field) => ({
      id: field.id,
      tenantId: field.tenant_id,
      entityScope: field.entity_scope,
      name: field.name,
      isActive: field.is_active === true,
    })),
  }));
}

function carouselAccessResponse(res, access) {
  if (access.reason === 'tenant-mismatch') {
    return res.status(409).json({ error: 'Tenant context mismatch' });
  }
  if (access.reason === 'authentication-required') {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.status(403).json({ error: 'Directory access denied' });
}

function parseCarouselSettingArray(value, settingKey) {
  if (value === undefined || value === null || value === '') return [];
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`Malformed ${settingKey} setting`);
    }
  }
  if (!Array.isArray(parsed)
      || parsed.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Malformed ${settingKey} setting`);
  }
  return [...new Set(parsed.map((item) => item.trim()))];
}

async function loadCarouselDirectorySettings(supabase, tenantId) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('setting_key, setting_value')
    .eq('tenant_id', tenantId)
    .in('setting_key', CAROUSEL_POLICY_SETTING_KEYS);
  if (error) throw new Error('Failed to load organisation directory settings');

  const rows = data || [];
  const byKey = new Map();
  for (const row of rows) {
    if (!CAROUSEL_POLICY_SETTING_KEYS.includes(row.setting_key)) continue;
    if (byKey.has(row.setting_key)) {
      throw new Error(`Duplicate ${row.setting_key} setting`);
    }
    byKey.set(row.setting_key, row.setting_value);
  }
  const allowedApplicationStatuses = new Set(parseCarouselSettingArray(
    byKey.get('org_directory_allowed_application_statuses'),
    'org_directory_allowed_application_statuses',
  ));
  const visibleOrgTypes = new Set(parseCarouselSettingArray(
    byKey.get('org_directory_visible_org_types'),
    'org_directory_visible_org_types',
  ));

  return {
    showLogo: byKey.get('org_directory_show_logo') !== 'false',
    showTitle: byKey.get('org_directory_show_title') !== 'false',
    showDomains: byKey.get('org_directory_show_domains') !== 'false',
    excludedOrgIds: new Set(parseCarouselSettingArray(
      byKey.get('org_directory_excluded_orgs'),
      'org_directory_excluded_orgs',
    )),
    allowedApplicationStatuses,
    visibleOrgTypes,
  };
}

async function loadCarouselFilterAuthority({
  supabase,
  tenantId,
  fieldId,
  filterValue,
}) {
  if (!fieldId || filterValue === undefined || filterValue === null || filterValue === '') {
    return {
      applied: false,
      valid: true,
      field: null,
      value: null,
    };
  }

  // Do not query preference values until the field is proven to belong to this
  // tenant and to be an active organisation field.  The old public helper
  // accepted arbitrary IDs and also turned query failures into an empty
  // result, which could accidentally make a stale directory unrestricted.
  const { data: fields, error: fieldError } = await supabase
    .from('preference_field')
    .select('id, tenant_id, entity_scope, is_active')
    .eq('id', fieldId)
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('is_active', true)
    .limit(2);
  if (fieldError) throw new Error('Failed to verify carousel filter field');
  if (!fields?.length || fields.length > 1) {
    return {
      applied: true,
      valid: false,
      field: null,
      value: filterValue,
    };
  }
  return {
    applied: true,
    valid: true,
    field: fields[0],
    value: filterValue,
  };
}

async function resolveCarouselFilterOrganizationIds({
  supabase,
  filterAuthority,
  organizationIds,
}) {
  if (!filterAuthority?.applied) return null;
  if (!filterAuthority.valid || !filterAuthority.field) return new Set();
  const ids = new Set();
  let scanned = 0;
  for (let organizationOffset = 0;
    organizationOffset < organizationIds.length;
    organizationOffset += CAROUSEL_QUERY_BATCH_SIZE) {
    const organizationBatch = organizationIds.slice(
      organizationOffset,
      organizationOffset + CAROUSEL_QUERY_BATCH_SIZE,
    );
    for (let offset = 0; ; offset += CAROUSEL_QUERY_BATCH_SIZE) {
      const { data, error } = await supabase
        .from('organization_preference_value')
        .select('organization_id, value')
        .eq('field_id', filterAuthority.field.id)
        .in('organization_id', organizationBatch)
        .order('organization_id', { ascending: true })
        .range(offset, offset + CAROUSEL_QUERY_BATCH_SIZE - 1);
      if (error) throw new Error('Failed to load carousel filter values');
      const batch = data || [];
      scanned += batch.length;
      if (scanned > MAX_CAROUSEL_CANDIDATES) {
        throw new Error('Carousel filter inventory exceeds supported size');
      }
      for (const row of batch) {
        if (matchesValue(row.value, filterAuthority.value) && row.organization_id) {
          ids.add(String(row.organization_id));
        }
      }
      if (batch.length < CAROUSEL_QUERY_BATCH_SIZE) break;
    }
  }
  return ids;
}

async function loadCarouselEligibilityValues({ supabase, organizationIds, fields }) {
  const values = new Map();
  let scanned = 0;
  for (const field of fields || []) {
    for (let organizationOffset = 0;
      organizationOffset < organizationIds.length;
      organizationOffset += CAROUSEL_QUERY_BATCH_SIZE) {
      const organizationBatch = organizationIds.slice(
        organizationOffset,
        organizationOffset + CAROUSEL_QUERY_BATCH_SIZE,
      );
      for (let offset = 0; ; offset += CAROUSEL_QUERY_BATCH_SIZE) {
        const { data, error } = await supabase
          .from('organization_preference_value')
          .select('organization_id, value')
          .eq('field_id', field.id)
          .in('organization_id', organizationBatch)
          .order('organization_id', { ascending: true })
          .range(offset, offset + CAROUSEL_QUERY_BATCH_SIZE - 1);
        if (error) throw new Error('Failed to load organisation eligibility values');
        const batch = data || [];
        scanned += batch.length;
        if (scanned > MAX_CAROUSEL_CANDIDATES) {
          throw new Error('Organisation eligibility value inventory exceeds supported size');
        }
        for (const row of batch) {
          const key = `${row.organization_id}:${field.id}`;
          const normalized = normalizeOrganizationPreferenceValues(row.value) || [];
          values.set(key, [...(values.get(key) || []), ...normalized]);
        }
        if (batch.length < CAROUSEL_QUERY_BATCH_SIZE) break;
      }
    }
  }
  return values;
}

function applyCarouselEligibility({
  organizations,
  requesterOrganizationId,
  excludedOrgIds,
  allowedApplicationStatuses,
  visibleOrgTypes,
  eligibilityAuthority,
  values,
}) {
  const statusFieldIds = (eligibilityAuthority || [])
    .filter((field) => field.name === 'application_status')
    .map((field) => field.id);
  const typeFieldIds = (eligibilityAuthority || [])
    .filter((field) => ['org_type', 'organisation_type', 'organization_type'].includes(field.name))
    .map((field) => field.id);
  const matchesAny = (organization, fieldIds, allowed) => {
    if (!allowed.size) return true;
    return fieldIds.some((fieldId) => (
      values.get(`${organization.id}:${fieldId}`) || []
    ).some((value) => allowed.has(String(value))));
  };

  return organizations.filter((organization) => {
    const organizationId = String(organization.id);
    if (requesterOrganizationId && organizationId === String(requesterOrganizationId)) {
      return true;
    }
    if (excludedOrgIds.has(organizationId)) return false;
    if (!matchesAny(organization, statusFieldIds, allowedApplicationStatuses)) return false;
    if (!matchesAny(organization, typeFieldIds, visibleOrgTypes)) return false;
    return true;
  });
}

function safeVerifiedDomainUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || /\s/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https:\/\//i.test(raw)) {
    return null;
  }
  const candidate = /^https:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname
      || parsed.username || parsed.password) return null;
  const serialized = parsed.toString();
  return parsed.pathname === '/' && !parsed.search && !parsed.hash
    ? serialized.slice(0, -1) : serialized;
}

async function loadCarouselVerifiedDomainAuthority({ supabase, tenantId }) {
  const { data: fields, error: fieldError } = await supabase
    .from('preference_field')
    .select('id, tenant_id, entity_scope, name, is_active')
    .eq('tenant_id', tenantId)
    .eq('entity_scope', 'organization')
    .eq('name', 'verified_domains')
    .eq('is_active', true)
    .order('id', { ascending: true })
    .limit(CAROUSEL_QUERY_BATCH_SIZE + 1);
  if (fieldError) throw new Error('Failed to load verified organisation domain authority');
  if (!fields?.length) return [];
  if (fields.length > CAROUSEL_QUERY_BATCH_SIZE) {
    throw new Error('Verified organisation field inventory exceeds supported size');
  }
  return fields;
}

async function loadCarouselEligibilityAuthority({ supabase, tenantId }) {
  const fields = [];
  const fieldIds = new Set();
  for (let offset = 0; ; offset += CAROUSEL_QUERY_BATCH_SIZE) {
    const { data: batch, error } = await supabase
      .from('preference_field')
      .select('id, tenant_id, entity_scope, name, is_active')
      .eq('tenant_id', tenantId)
      .eq('entity_scope', 'organization')
      .in('name', CAROUSEL_ELIGIBILITY_FIELD_NAMES)
      .order('id', { ascending: true })
      .range(offset, offset + CAROUSEL_QUERY_BATCH_SIZE - 1);
    if (error) throw new Error('Failed to load organisation eligibility field authority');
    const page = batch || [];
    for (const field of page) {
      if (!field?.id || fieldIds.has(field.id)
          || !CAROUSEL_ELIGIBILITY_FIELD_NAMES.includes(field.name)
          || field.tenant_id !== tenantId
          || field.entity_scope !== 'organization'
          || (field.is_active !== true && field.is_active !== false)) {
        throw new Error('Malformed organisation eligibility field authority');
      }
      fieldIds.add(field.id);
    }
    fields.push(...page);
    if (fields.length > MAX_CAROUSEL_CANDIDATES) {
      throw new Error('Organisation eligibility field inventory exceeds supported size');
    }
    if (page.length < CAROUSEL_QUERY_BATCH_SIZE) break;
  }
  return fields;
}

async function loadCarouselVerifiedDomains({ supabase, organizationIds, fields }) {
  if (!fields?.length) return new Map();

  const domains = new Map();
  let scanned = 0;
  for (const field of fields) {
    for (let offset = 0; offset < organizationIds.length; offset += CAROUSEL_QUERY_BATCH_SIZE) {
      const ids = organizationIds.slice(offset, offset + CAROUSEL_QUERY_BATCH_SIZE);
      for (let preferenceOffset = 0; ; preferenceOffset += CAROUSEL_QUERY_BATCH_SIZE) {
        const { data, error } = await supabase
          .from('organization_preference_value')
          .select('organization_id, value')
          .eq('field_id', field.id)
          .in('organization_id', ids)
          .order('organization_id', { ascending: true })
          .range(preferenceOffset, preferenceOffset + CAROUSEL_QUERY_BATCH_SIZE - 1);
        if (error) throw new Error('Failed to load verified organisation domains');
        const batch = data || [];
        scanned += batch.length;
        if (scanned > MAX_CAROUSEL_CANDIDATES) {
          throw new Error('Verified organisation domain inventory exceeds supported size');
        }
        for (const row of batch) {
          if (domains.has(String(row.organization_id))) continue;
          const values = normalizeOrganizationPreferenceValues(row.value) || [];
          for (const value of values) {
            const websiteUrl = safeVerifiedDomainUrl(value);
            if (websiteUrl) {
              domains.set(String(row.organization_id), websiteUrl);
              break;
            }
          }
        }
        if (batch.length < CAROUSEL_QUERY_BATCH_SIZE) break;
      }
    }
  }
  return domains;
}

async function fetchCarouselOrganizations({
  supabase,
  tenantId,
  filterAuthority,
  verifiedDomainAuthority,
  eligibilityAuthority,
  requesterOrganizationId,
  displaySettings,
}) {
  const organizations = [];
  let scanned = 0;

  // Supabase commonly caps a response at 1,000 rows.  Read the complete
  // eligible inventory in bounded server-side batches, then seed and paginate
  // only after the inventory is complete.
  for (let offset = 0; ; offset += CAROUSEL_QUERY_BATCH_SIZE) {
    const { data, error } = await supabase
      .from('organization')
      .select(CAROUSEL_ORGANIZATION_SELECT)
      .eq('tenant_id', tenantId)
      .order('id', { ascending: true })
      .range(offset, offset + CAROUSEL_QUERY_BATCH_SIZE - 1);
    if (error) {
      console.error('[PublicDynamicDirectory] Carousel organization fetch error:', error);
      throw new Error('Failed to fetch carousel organizations');
    }
    const batch = data || [];
    scanned += batch.length;
    if (scanned > MAX_CAROUSEL_CANDIDATES) {
      throw new Error('Carousel organization inventory exceeds supported size');
    }
    organizations.push(...batch.map((organization) => ({
      id: organization.id,
      name: organization.name,
      logo_url: organization.logo_url,
    })));
    if (organizations.length > MAX_CAROUSEL_CANDIDATES) {
      throw new Error('Carousel organization inventory exceeds supported size');
    }
    if (batch.length < CAROUSEL_QUERY_BATCH_SIZE) break;
  }

  const organizationIds = organizations.map((organization) => String(organization.id));
  const filterOrganizationIds = await resolveCarouselFilterOrganizationIds({
    supabase,
    filterAuthority,
    organizationIds,
  });
  const allowedIds = filterOrganizationIds ? new Set(filterOrganizationIds) : null;
  const filteredOrganizations = allowedIds
    ? organizations.filter((organization) => allowedIds.has(String(organization.id)))
    : organizations;
  const eligibilityValues = (
    displaySettings.allowedApplicationStatuses.size || displaySettings.visibleOrgTypes.size
  ) ? await loadCarouselEligibilityValues({
    supabase,
    organizationIds: filteredOrganizations.map((organization) => String(organization.id)),
    fields: eligibilityAuthority,
  }) : new Map();
  const domainsByOrganization = displaySettings.showDomains
    ? await loadCarouselVerifiedDomains({
      supabase,
      organizationIds,
      fields: verifiedDomainAuthority,
    })
    : new Map();
  for (const organization of filteredOrganizations) {
    organization.verified_website_url =
      domainsByOrganization.get(String(organization.id)) || null;
  }

  return applyCarouselEligibility({
    organizations: filteredOrganizations,
    requesterOrganizationId,
    excludedOrgIds: displaySettings.excludedOrgIds,
    allowedApplicationStatuses: displaySettings.allowedApplicationStatuses,
    visibleOrgTypes: displaySettings.visibleOrgTypes,
    eligibilityAuthority,
    values: eligibilityValues,
  });
}

async function renderMembers({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res }) {
  const filterFields = [];
  if (directory.filter_field_id && directory.filter_value) {
    filterFields.push({ fieldId: directory.filter_field_id, value: directory.filter_value });
  }
  for (const [fieldId, value] of Object.entries(customFilters || {})) {
    if (Array.isArray(value) ? value.length > 0 : (value && value !== 'all')) filterFields.push({ fieldId, value });
  }
  let memberIds = null;
  if (filterFields.length > 0) {
    memberIds = await intersectMemberIds(supabase, filterFields);
    if (memberIds.length === 0) return res.json({ entityType: 'member', records: [], total: 0, page: pageNum, pageSize });
  }

  const baseFilter = (q) => {
    let qq = q.eq('tenant_id', tenantId)
      .or('show_in_directory.is.null,show_in_directory.neq.false')
      .or('login_enabled.is.null,login_enabled.neq.false')
      .not('email', 'ilike', 'deleted_%@deleted.local');
    if (memberIds) qq = qq.in('id', memberIds);
    if (search) {
      const p = `%${search}%`;
      qq = qq.or(`first_name.ilike.${p},last_name.ilike.${p},email.ilike.${p},job_title.ilike.${p}`);
    }
    return qq;
  };

  const { count: total } = await baseFilter(supabase.from('member').select('id', { count: 'exact', head: true }));

  let dataQ = baseFilter(supabase.from('member').select('id, first_name, last_name, job_title, profile_photo_url, handle, role_id, linkedin_url, organization_id'));
  if (sort === 'name-desc') {
    dataQ = dataQ.order('first_name', { ascending: false }).order('last_name', { ascending: false });
  } else {
    dataQ = dataQ.order('first_name', { ascending: true }).order('last_name', { ascending: true });
  }
  const { data, error } = await dataQ.range(offset, offset + pageSize - 1);
  if (error) {
    console.error('[PublicDynamicDirectory] member fetch error', error);
    return res.status(500).json({ error: 'Failed to fetch members' });
  }
  const pageMembers = data || [];

  // Config needed to render cards identically to the portal (guest view).
  const [roles, globalDisplaySettings, { directoryCustomFields }] = await Promise.all([
    fetchRoles(supabase, tenantId),
    fetchMemberDisplaySettings(supabase, tenantId),
    fetchMemberFields(supabase, tenantId, directory.id),
  ]);
  // Layer this directory's core-field visibility overrides over the global
  // settings so guest/embed cards resolve visibility exactly like the portal.
  const displaySettings = applyCoreFieldVisibility(globalDisplaySettings, directory.core_field_visibility);

  // Resolve organisation names for the page's members.
  const orgIds = [...new Set(pageMembers.map((m) => m.organization_id).filter(Boolean))];
  const orgNameById = {};
  if (orgIds.length > 0) {
    const { data: orgRows } = await supabase
      .from('organization')
      .select('id, name')
      .in('id', orgIds);
    for (const o of orgRows || []) orgNameById[o.id] = o.name;
  }

  // Custom-field values for the directory-visible fields on this page's members.
  const fieldIds = directoryCustomFields.map((f) => f.id);
  const valuesByMember = {};
  const pageMemberIds = pageMembers.map((m) => m.id);
  if (fieldIds.length > 0 && pageMemberIds.length > 0) {
    const { data: prefRows } = await supabase
      .from('member_preference_value')
      .select('member_id, field_id, value')
      .in('member_id', pageMemberIds)
      .in('field_id', fieldIds);
    for (const pv of prefRows || []) {
      if (!valuesByMember[pv.member_id]) valuesByMember[pv.member_id] = {};
      valuesByMember[pv.member_id][pv.field_id] = pv.value;
    }
  }

  const records = pageMembers.map((m) => ({
    id: m.id,
    name: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || null,
    first_name: m.first_name || null,
    last_name: m.last_name || null,
    subtitle: m.job_title || null,
    job_title: m.job_title || null,
    image_url: m.profile_photo_url || null,
    profile_photo_url: m.profile_photo_url || null,
    handle: m.handle || null,
    role_id: m.role_id || null,
    linkedin_url: m.linkedin_url || null,
    organization_id: m.organization_id || null,
    organization_name: m.organization_id ? (orgNameById[m.organization_id] || null) : null,
    customValues: valuesByMember[m.id] || {},
  }));

  return res.json({
    entityType: 'member',
    records,
    total: total || 0,
    page: pageNum,
    pageSize,
    config: { displaySettings, roles, directoryCustomFields, directory: buildPublicDirectoryPayload(directory) },
  });
}

async function renderOrganizations({ supabase, tenantId, directory, pageNum, pageSize, offset, sort, search, customFilters, res }) {
  const filterFields = [];
  if (directory.filter_field_id && directory.filter_value) {
    filterFields.push({ fieldId: directory.filter_field_id, value: directory.filter_value });
  }
  for (const [fieldId, value] of Object.entries(customFilters || {})) {
    if (Array.isArray(value) ? value.length > 0 : (value && value !== 'all')) filterFields.push({ fieldId, value });
  }
  let orgIds = null;
  if (filterFields.length > 0) {
    orgIds = await intersectOrgIds(supabase, filterFields);
    if (orgIds.length === 0) return res.json({ entityType: 'organization', records: [], total: 0, page: pageNum, pageSize });
  }
  let q = supabase
    .from('organization')
    .select('id, name, slug, logo_url, description, city, country, website_url', { count: 'exact' })
    .eq('tenant_id', tenantId);
  if (orgIds) q = q.in('id', orgIds);
  if (search) {
    const p = `%${search}%`;
    q = q.or(`name.ilike.${p},city.ilike.${p},country.ilike.${p}`);
  }
  q = sort === 'name-desc' ? q.order('name', { ascending: false }) : q.order('name', { ascending: true });
  const { data, error, count } = await q.range(offset, offset + pageSize - 1);
  if (error) {
    console.error('[PublicDynamicDirectory] organization fetch error', error);
    return res.status(500).json({ error: 'Failed to fetch organizations' });
  }
  const records = (data || []).map((o) => ({
    id: o.id,
    name: o.name,
    subtitle: [o.city, o.country].filter(Boolean).join(', ') || null,
    image_url: o.logo_url || null,
    logo_url: o.logo_url || null,
    slug: o.slug || null,
    website_url: o.website_url || null,
  }));
  const displaySettings = await fetchOrgDisplaySettings(supabase, tenantId);
  displaySettings.backFieldOrder = publicDirectoryBackOrder(displaySettings.backFieldOrder);
  // Per-directory override for the member-count core item (detail popup /
  // card back); falls back to the tenant-global org directory setting.
  displaySettings.showMemberCount = isOrgCoreItemVisible(
    directory.core_field_visibility, 'org_member_count', displaySettings.showMemberCount
  );
  return res.json({
    entityType: 'organization',
    records,
    total: count || 0,
    page: pageNum,
    pageSize,
    config: { displaySettings, directory: buildPublicDirectoryPayload(directory) },
  });
}

async function intersectMemberIds(supabase, filterFields) {
  return intersectIds(supabase, 'member_preference_value', 'member_id', filterFields);
}

async function intersectOrgIds(supabase, filterFields) {
  return intersectIds(supabase, 'organization_preference_value', 'organization_id', filterFields);
}

async function intersectIds(supabase, table, idColumn, filterFields) {
  let result = null;
  for (const { fieldId, value } of filterFields) {
    const ids = await getIdsForFieldValue(supabase, table, idColumn, fieldId, value);
    const set = new Set(ids);
    if (result === null) result = set;
    else result = new Set([...result].filter((id) => set.has(id)));
    if (result.size === 0) break;
  }
  return result ? [...result] : [];
}

async function getIdsForFieldValue(supabase, table, idColumn, fieldId, filterValue) {
  const ids = [];
  let offset = 0;
  const batchSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(`${idColumn}, value`)
      .eq('field_id', fieldId)
      .range(offset, offset + batchSize - 1);
    if (error || !data || data.length === 0) break;
    for (const pv of data) {
      if (matchesValue(pv.value, filterValue)) ids.push(pv[idColumn]);
    }
    if (data.length < batchSize) break;
    offset += batchSize;
  }
  return ids;
}

function matchesValue(storedValue, filterValue) {
  if (Array.isArray(filterValue)) {
    return filterValue.some((v) => matchesSingleValue(storedValue, v));
  }
  return matchesSingleValue(storedValue, filterValue);
}

function matchesSingleValue(storedValue, filterValue) {
  if (storedValue === filterValue) return true;
  if (Array.isArray(storedValue)) return storedValue.includes(filterValue);
  if (typeof storedValue === 'string') {
    const t = storedValue.trim();
    if (t.startsWith('[')) {
      try { const arr = JSON.parse(t); if (Array.isArray(arr) && arr.includes(filterValue)) return true; } catch {}
    }
  }
  // Boolean fields: stored values may be true/false, 'true'/'false', 'yes'/'no', '1'/'0'
  const storedBool = toBoolCanonical(storedValue);
  if (storedBool !== null) {
    return toBoolCanonical(filterValue) === storedBool;
  }
  return false;
}

const BOOL_TRUE = new Set(['true', 'yes', '1']);
const BOOL_FALSE = new Set(['false', 'no', '0']);

function toBoolCanonical(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (BOOL_TRUE.has(s)) return 'true';
  if (BOOL_FALSE.has(s)) return 'false';
  return null;
}
