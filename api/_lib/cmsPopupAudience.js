import { popupOperators, validatePopupGroups } from '../../shared/cmsPopupContract.js';
import { allAffiliationRows } from './formAffiliationReview.js';

const core = (key, label, data_type = 'text') => ({ key, label, data_type, field_type: 'core' });
export const POPUP_CORE_FIELDS = {
  member: [core('first_name', 'First name'), core('last_name', 'Last name'), core('email', 'Email'),
    core('job_title', 'Job title'), { ...core('role_id', 'Role'), choice_only: true }, core('login_enabled', 'Login enabled', 'boolean'),
    { ...core('membership_status', 'Membership status', 'dropdown'), options: ['active', 'pending', 'expired', 'paused', 'failed', 'none'] },
    core('membership_type', 'Membership type / tier', 'text')],
  organization: [core('id', 'Selected organisations', 'picklist'), core('name', 'Name'), core('status', 'Status')],
};

// All scans are metadata/choices, never a tenant-wide member/recipient scan.
export async function discoverPopupFields(db, tenantId, { choices = false } = {}) {
  const rows = await allAffiliationRows(() => db.from('preference_field')
    .select('id,name,label,field_type,options,entity_scope,is_active,custom_object_id', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('is_active', true).in('entity_scope', ['member', 'organization']));
  const fields = {};
  for (const scope of ['member', 'organization']) {
    fields[scope] = { core: POPUP_CORE_FIELDS[scope].map(f => ({ ...f })),
      custom: rows.filter(f => f.entity_scope === scope && !f.custom_object_id && popupOperators(f.field_type).length)
        .map(f => ({ key: f.id, label: f.label || f.name, data_type: f.field_type, field_type: 'custom', options: f.options })) };
  }
  if (choices) {
    const [organizations, roles] = await Promise.all([
      allAffiliationRows(() => db.from('organization').select('id,name', { count: 'exact' }).eq('tenant_id', tenantId)),
      allAffiliationRows(() => db.from('role').select('id,name', { count: 'exact' }).eq('tenant_id', tenantId)),
    ]);
    fields.organization.core[0].options = organizations.map(o => ({ value: o.id, label: o.name }));
    fields.member.core.find(f => f.key === 'role_id').options = roles
      .sort((a, b) => a.name.localeCompare(b.name)).map(r => ({ value: r.id, label: r.name }));
  }
  return fields;
}

async function one(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
// Resolve only the configured secondary-assignment graph. Department owners do
// not count as affiliations, and unrelated custom-object edges are never used.
export async function popupOrganizationIds(db, tenantId, member) {
  const ids = new Set(member.organization_id ? [member.organization_id] : []);
  const policy = await one(db.from('profile_affiliation_policy').select('config').eq('tenant_id', tenantId).maybeSingle());
  const config = policy?.config;
  if (!config?.secondaryMemberDefinitionId && !config?.secondaryOrganizationDefinitionId) return [...ids];
  if (!config.secondaryMemberDefinitionId || !config.secondaryOrganizationDefinitionId) throw new Error('Incomplete affiliation configuration.');
  const definitions = await allAffiliationRows(() => db.from('custom_object_relationship_definition')
    .select('*', { count: 'exact' }).eq('tenant_id', tenantId)
    .in('id', [config.secondaryMemberDefinitionId, config.secondaryOrganizationDefinitionId]).eq('status', 'active'), 2);
  const md = definitions.find(d => d.id === config.secondaryMemberDefinitionId);
  const od = definitions.find(d => d.id === config.secondaryOrganizationDefinitionId);
  const endpoint = (d, kind) => d?.source_kind === kind && d.target_kind === 'custom_object'
    ? { side: 'source', object: d.target_custom_object_id }
    : d?.target_kind === kind && d.source_kind === 'custom_object'
      ? { side: 'target', object: d.source_custom_object_id } : null;
  const me = endpoint(md, 'member'), org = endpoint(od, 'organization');
  if (!me || !org || me.object !== org.object) throw new Error('Invalid affiliation definitions.');
  const links = await allAffiliationRows(() => db.from('custom_object_relationship').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('relationship_definition_id', md.id)
    .eq(`${me.side}_record_id`, member.id).is('archived_at', null), 100);
  const otherSide = me.side === 'source' ? 'target' : 'source';
  const assignmentIds = [...new Set(links.map(e => e[`${otherSide}_record_id`]))];
  if (!assignmentIds.length) return [...ids];
  const records = await allAffiliationRows(() => db.from('custom_object_record').select('id', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('custom_object_id', me.object).in('id', assignmentIds).is('archived_at', null), 100);
  const liveIds = records.map(r => r.id);
  if (!liveIds.length) return [...ids];
  const assignmentSide = org.side === 'source' ? 'target' : 'source';
  const owners = await allAffiliationRows(() => db.from('custom_object_relationship').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('relationship_definition_id', od.id)
    .in(`${assignmentSide}_record_id`, liveIds).is('archived_at', null), 100);
  for (const id of liveIds) {
    const matches = owners.filter(e => e[`${assignmentSide}_record_id`] === id);
    if (matches.length !== 1) throw new Error('Ambiguous secondary affiliation.');
    ids.add(matches[0][`${org.side}_record_id`]);
  }
  return [...ids];
}

export async function loadPopupAudience(db, tenantId, memberId, configs, fields, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const conditions = configs.flatMap(c => validatePopupGroups(c.groups, fields).flat());
  if (!memberId || !conditions.length) return { member: null, organizations: [] };
  const member = await one(db.from('member').select('*').eq('tenant_id', tenantId).eq('id', memberId).single());
  if (!member) throw new Error('Member unavailable.');
  if (conditions.some(c => c.entity_scope === 'member' && c.field_type === 'core' && c.field_key.startsWith('membership_'))) {
    Object.assign(member, await loadPopupMembership(db, tenantId, member, today));
  }
  member.custom = {};
  const memberFields = [...new Set(conditions.filter(c => c.entity_scope === 'member' && c.field_type === 'custom').map(c => c.field_key))];
  if (memberFields.length) {
    const values = await allAffiliationRows(() => db.from('member_preference_value')
      .select('id,field_id,value', { count: 'exact' }).eq('member_id', memberId).in('field_id', memberFields), 200);
    for (const row of values) {
      if (Object.hasOwn(member.custom, row.field_id)) throw new Error('Ambiguous member field values.');
      member.custom[row.field_id] = row.value;
    }
  }
  let organizations = [];
  if (conditions.some(c => c.entity_scope === 'organization')) {
    const ids = await popupOrganizationIds(db, tenantId, member);
    if (ids.length) {
      organizations = await allAffiliationRows(() => db.from('organization').select('*', { count: 'exact' })
        .eq('tenant_id', tenantId).in('id', ids), 101);
      if (organizations.length !== ids.length) throw new Error('Affiliation organization unavailable.');
      organizations.forEach(o => { o.custom = {}; });
      const orgFields = [...new Set(conditions.filter(c => c.entity_scope === 'organization' && c.field_type === 'custom').map(c => c.field_key))];
      if (orgFields.length) {
        const values = await allAffiliationRows(() => db.from('organization_preference_value')
          .select('id,organization_id,field_id,value', { count: 'exact' }).in('organization_id', ids).in('field_id', orgFields), 2000);
        for (const row of values) {
          const org = organizations.find(o => o.id === row.organization_id);
          if (!org || Object.hasOwn(org.custom, row.field_id)) throw new Error('Ambiguous organisation field values.');
          org.custom[row.field_id] = row.value;
        }
      }
    }
  }
  return { member, organizations };
}

// Reuse the Canvas membership selection/state contract; do not infer membership
// from login permission, an organisation edge, invoices or a tenant-user role.
// These imports are lazy so non-targeted public requests do not load billing.
export async function loadPopupMembership(db, tenantId, member, today) {
  const [{ selectCanvasCommitment, buildCanvasSummary }, { resolveMemberAmendmentReadOverlays },
    { attachAlphaMembershipRecognition }] = await Promise.all([
    import('../membership/canvas-summary.js'), import('./membershipAmendmentReadOverlay.js'),
    import('./alphaMembershipRecognition.js'),
  ]);
  const personal = await allAffiliationRows(() => db.from('member_membership_history').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId).eq('member_id', member.id), 2000);
  const organization = member.organization_id ? await allAffiliationRows(() => db.from('organisation_membership_history')
    .select('*', { count: 'exact' }).eq('tenant_id', tenantId).eq('organization_id', member.organization_id), 2000) : [];
  const history = await resolveMemberAmendmentReadOverlays({ db, tenantId,
    history: personal.map(row => ({ ...row, membership_source: 'personal' })) });
  await attachAlphaMembershipRecognition(db, tenantId, member.id, history, today);
  const selected = selectCanvasCommitment(history, organization.map(row => ({ ...row, membership_source: 'organisation' })), today);
  const { membership } = buildCanvasSummary({ selected, paused: member.membership_paused === true, today });
  if (membership.state === 'unavailable') throw new Error('Membership evidence unavailable.');
  return { membership_status: membership.state, membership_type: membership.membershipType };
}
