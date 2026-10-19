import { directoryEligibleIds, readDirectoryPages } from './directoryExpression.js';
import { applyCoreFieldVisibility, isMemberFieldVisibleOnFront } from './directoryConfig.js';
import { isMemberPaused } from './memberPause.js';
import { isDeletedRelationshipMember } from './customObjectMemberEligibility.js';

const MEMBER_SELECT = 'id, first_name, last_name, profile_photo_url, job_title, role_id, email, membership_paused';

// No contact fields, handles, preference values or arbitrary CRM columns leave
// this path. Additional profile fields need their own publication decision.
export function projectCarouselMember(row, settings) {
  const visible = key => isMemberFieldVisibleOnFront(settings, key);
  return {
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    profile_photo_url: visible('show_profile_photo') ? row.profile_photo_url || null : null,
    job_title: visible('show_job_title') ? row.job_title || null : null,
    organization_name: null,
    linkedin_url: null,
    bio: null,
  };
}

export async function renderSecureDirectoryCarousel({
  supabase: db, tenantId, req, slug: legacySlug, page, limit, seed, resolveTenantContext,
  featureCheck, exclusionsResolver, helpers: h, res,
}) {
  const source = req.query.source || 'dynamic';
  if (!['dynamic', 'primary-member', 'primary-organization'].includes(source)) {
    return res.status(400).json({ error: 'Invalid carousel source' });
  }
  const directoryId = req.query.directory_id;
  const slug = req.query.slug;
  // The caller strips slug only for tenant resolution; restore it separately.
  const selectedSlug = slug || legacySlug;
  if (source === 'dynamic' && !directoryId && !selectedSlug) {
    return res.status(400).json({ error: 'directory_id or slug is required' });
  }
  const effectiveSeed = h.normalizeCarouselSeed(seed);
  if (effectiveSeed === null) return res.status(400).json({ error: 'seed is too long' });
  const { pageNum, pageSize } = h.parseCarouselPagination(page, limit);
  const embedded = req.query.embed === 'true' || req.headers?.['x-embed-context'] === 'true'
    || /\/embed(?:\/|[?#]|$)/i.test(String(req.headers?.referer || req.headers?.referrer || ''));

  async function authority() {
    const context = await resolveTenantContext(req);
    if (context?.tenantMismatch || ((context?.tenantId || context?.tenantFromHost?.id)
      && (context.tenantId || context.tenantFromHost.id) !== tenantId)) {
      return { error: 'Tenant context mismatch', status: 409 };
    }
    let directory;
    if (source === 'dynamic') {
      // SELECT * tolerates the not-yet-applied consent migration. Undefined
      // consent remains off, while legacy private readers keep working.
      let query = db.from('dynamic_directory').select('*')
        .eq('tenant_id', tenantId).eq('is_active', true);
      query = directoryId ? query.eq('id', directoryId) : query.eq('slug', selectedSlug);
      const { data, error } = await query.limit(2);
      if (error) throw new Error('Unable to read carousel publication authority');
      if (data?.length !== 1) return { error: 'Directory not found', status: 404 };
      directory = data[0];
    } else {
      directory = { id: 'main', entity_type: source === 'primary-member' ? 'member' : 'organization', is_active: true, allowed_role_ids: [] };
      const key = directory.entity_type === 'member'
        ? 'member_directory_public_carousel_enabled' : 'org_directory_public_carousel_enabled';
      const { data, error } = await db.from('system_settings').select('setting_value')
        .eq('tenant_id', tenantId).eq('setting_key', key).limit(2);
      if (error) throw new Error('Unable to read carousel publication authority');
      directory.public_carousel_enabled = data?.length === 1 && data[0].setting_value === 'true';
    }
    if (!['member', 'organization'].includes(directory.entity_type)) return { error: 'Unsupported directory entity type', status: 400 };
    const policy = h.parseCarouselAllowedRoleIds(directory.allowed_role_ids);
    if (!policy.valid) return { error: 'Directory access denied', status: 403 };
    const guest = !context?.isAuthenticated && !context?.tenantUserId;
    if (guest || embedded) {
      if (directory.public_carousel_enabled !== true) return {
        error: embedded ? 'Embed access denied' : 'Authentication required', status: embedded ? 403 : 401,
      };
    } else {
      const access = await h.resolveCarouselAuthority({
        context, tenantId, allowedRoleIds: policy.ids, db, featureCheck, exclusionsResolver,
        feature: directory.entity_type === 'member' ? 'membership.member-directory' : 'membership.organisation-directory',
      });
      if (!access.allowed) return { error: 'Directory access denied', status: 403 };
    }
    let settings;
    if (directory.entity_type === 'member') {
      const { data, error } = await db.from('system_settings').select('setting_value')
        .eq('tenant_id', tenantId).eq('setting_key', 'member_directory_display').limit(2);
      if (error || data?.length > 1) throw new Error('Unable to read member display authority');
      settings = data?.length ? JSON.parse(data[0].setting_value) : {};
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid member display authority');
      if (source === 'primary-member' && settings.visible_role_ids != null
        && (!Array.isArray(settings.visible_role_ids)
          || settings.visible_role_ids.some(id => typeof id !== 'string' || !id.trim()))) {
        throw new Error('Invalid member role visibility authority');
      }
      settings = applyCoreFieldVisibility(settings, directory.core_field_visibility);
    } else settings = await h.loadCarouselDirectorySettings(db, tenantId);
    let organizationAuthority;
    if (directory.entity_type === 'organization') {
      organizationAuthority = {
        filterAuthority: await h.loadCarouselFilterAuthority({ supabase: db, tenantId,
          fieldId: directory.filter_expression != null ? null : directory.filter_field_id, filterValue: directory.filter_value }),
        verifiedDomainAuthority: await h.loadCarouselVerifiedDomainAuthority({ supabase: db, tenantId }),
        eligibilityAuthority: await h.loadCarouselEligibilityAuthority({ supabase: db, tenantId }),
      };
    }
    return { context, directory, settings, publicView: guest || embedded, organizationAuthority };
  }

  async function inventory(a) {
    const { directory, settings, context, publicView } = a;
    let rows;
    if (directory.entity_type === 'member') {
      rows = await readDirectoryPages(() => db.from('member').select(MEMBER_SELECT)
        .eq('tenant_id', tenantId)
        .or('show_in_directory.is.null,show_in_directory.neq.false')
        .or('login_enabled.is.null,login_enabled.neq.false')
        .not('email', 'ilike', 'deleted_%@deleted.local').order('id'));
      const visibleRoles = source === 'primary-member' ? settings.visible_role_ids || [] : [];
      rows = rows.filter(row => !isMemberPaused(row) && !isDeletedRelationshipMember(row)
        && (!visibleRoles.length || visibleRoles.includes(row.role_id)));
    } else {
      const { filterAuthority, verifiedDomainAuthority, eligibilityAuthority } = a.organizationAuthority;
      // Dynamic directories own their inclusion expression. The main directory's
      // status/type selectors must not narrow a separately configured directory
      // (for example Partners when the main directory lists Universities).
      // Keep display permissions and explicit exclusions unchanged.
      const populationSettings = source === 'dynamic' ? {
        ...settings,
        allowedApplicationStatuses: new Set(),
        visibleOrgTypes: new Set(),
      } : settings;
      rows = await h.fetchCarouselOrganizations({ supabase: db, tenantId, filterAuthority,
        verifiedDomainAuthority, eligibilityAuthority, displaySettings: populationSettings,
        requesterOrganizationId: publicView ? null : context?.organizationId });
      // Primary canonical search never bypasses explicit exclusions for one's
      // own organisation. Keep the legacy dynamic-carousel exception separate.
      if (source === 'primary-organization') rows = rows.filter(row => !settings.excludedOrgIds.has(String(row.id)));
    }
    const ids = await directoryEligibleIds(db, tenantId, directory, rows.map(row => row.id));
    const eligible = ids === null ? null : new Set(ids);
    return rows.filter(row => !eligible || eligible.has(row.id)).map(row =>
      directory.entity_type === 'member' ? projectCarouselMember(row, settings) : h.projectCarouselOrganization(row, settings));
  }
  // Re-read the full eligible projection, not merely the returned page. This
  // catches consent/opt-out/deletion and preference changes during long scans.
  const fingerprint = value => JSON.stringify(h.stableAuthorityValue(
    JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Set ? [...item].sort() : item))));
  const initial = await authority();
  if (initial.error) return res.status(initial.status).json({ error: initial.error });
  let records;
  try {
    records = await inventory(initial);
  } catch (error) {
    const latest = await authority();
    if (latest.error) return res.status(latest.status).json({ error: latest.error });
    if (fingerprint(initial) !== fingerprint(latest)) {
      return res.status(409).json({ error: 'Directory authority changed; retry' });
    }
    throw error;
  }
  const refreshed = await authority();
  if (refreshed.error) return res.status(refreshed.status).json({ error: refreshed.error });
  if (fingerprint(initial) !== fingerprint(refreshed)) {
    return res.status(409).json({ error: 'Directory authority changed; retry' });
  }
  const current = await inventory(refreshed);
  const final = await authority();
  if (final.error) return res.status(final.status).json({ error: final.error });
  if (fingerprint(initial) !== fingerprint(refreshed)
    || fingerprint(records) !== fingerprint(current)
    || fingerprint(refreshed) !== fingerprint(final)) {
    return res.status(409).json({ error: 'Directory authority changed; retry' });
  }
  const ordered = h.seededOrganizationOrder(current, effectiveSeed);
  const offset = (pageNum - 1) * pageSize;
  return res.json({ entityType: final.directory.entity_type,
    records: ordered.slice(offset, offset + pageSize), total: ordered.length,
    page: pageNum, pageSize, seed: effectiveSeed });
}
