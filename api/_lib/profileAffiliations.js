import { discoverMemberAffiliations } from './formMemberAffiliationConfig.js';
import { allAffiliationRows } from './formAffiliationReview.js';
import { resolveCustomObjectFieldAccess } from './customObjectDomain.js';
import { validateProfileAffiliationConfig } from './profileAffiliationPolicy.js';

export async function loadProfilePolicy(db, tenantId) {
  const { data, error } = await db.from('profile_affiliation_policy').select('*').eq('tenant_id', tenantId).maybeSingle();
  if (error) throw error;
  return data || { version: 0, config: { enabled: false } };
}

export async function validateLiveProfilePolicy(db, tenantId, member, policy) {
  const metadata = await discoverMemberAffiliations(db, tenantId);
  validateProfileAffiliationConfig(policy.config, metadata, { requirePinned: true });
  if (!member.role_id) throw Object.assign(new Error('Your role does not allow affiliation editing.'), { status: 403 });
  const { data: permissions, error } = await db.from('role_member_field_permission')
    .select('field_key,permission').eq('role_id', member.role_id);
  if (error) throw error;
  if ((permissions || []).some(p => ['organization_id', 'organization', 'organisation', 'departments', 'secondary_organizations'].includes(p.field_key)
    && p.permission !== 'read_write')) throw Object.assign(new Error('Your role does not allow affiliation editing.'), { status: 403 });
  const { data: fieldPermissions, error: fieldError } = await db.from('custom_object_field_role_permission')
    .select('*').eq('tenant_id', tenantId).eq('role_id', member.role_id);
  if (fieldError) throw fieldError;
  const configuredDefinitions = metadata.relationships.filter(d => Object.values(policy.config).includes(d.id));
  const objectIds = new Set(configuredDefinitions.flatMap(d => [d.source_custom_object_id, d.target_custom_object_id]).filter(Boolean));
  for (const object of metadata.objects.filter(o => objectIds.has(o.id))) {
    if ((fieldPermissions || []).some(p => p.field_id === object.primary_display_field_id
      && resolveCustomObjectFieldAccess({ permission: p }) === 'none')) {
      throw Object.assign(new Error('Affiliation labels are restricted for your role. Contact an administrator.'), { status: 403 });
    }
  }
  return metadata;
}

export async function projectProfileAffiliations(db, tenantId, memberId, captured, metadata) {
  const cfg = captured.config;
  const graph = captured.snapshot.graph;
  const other = edge => edge.source_record_id === memberId ? edge.target_record_id : edge.source_record_id;
  const secondary = [];
  for (const edge of graph.links.filter(e => e.relationship_definition_id === cfg.secondaryMemberDefinitionId)) {
    const assignment = other(edge);
    const owners = graph.recordLinks.filter(e => e.relationship_definition_id === cfg.secondaryOrganizationDefinitionId
      && [e.source_record_id, e.target_record_id].includes(assignment));
    if (owners.length !== 1) throw new Error('Secondary assignment needs administrator assistance.');
    secondary.push(owners[0].source_record_id === assignment ? owners[0].target_record_id : owners[0].source_record_id);
  }
  if (new Set(secondary).size !== secondary.length) throw new Error('Duplicate secondary assignments need administrator assistance.');
  const edges = graph.links.filter(e => e.relationship_definition_id === cfg.memberDepartmentDefinitionId);
  const owners = new Map(edges.map(e => {
    const id = other(e);
    const links = graph.recordLinks.filter(r => r.relationship_definition_id === cfg.departmentOrganizationDefinitionId
      && [r.source_record_id, r.target_record_id].includes(id));
    return [id, links.length === 1 ? (links[0].source_record_id === id ? links[0].target_record_id : links[0].source_record_id) : null];
  }));
  const orgIds = [...new Set([graph.organization_id, ...secondary, ...owners.values()].filter(Boolean))];
  const organizations = [];
  for (let offset = 0; offset < orgIds.length; offset += 100) {
    organizations.push(...await allAffiliationRows(() => db.from('organization').select('id,name', { count: 'exact' })
      .eq('tenant_id', tenantId).in('id', orgIds.slice(offset, offset + 100))));
  }
  const label = id => organizations.find(o => o.id === id)?.name || 'Unavailable organisation';
  const definition = metadata.relationships.find(d => d.id === cfg.memberDepartmentDefinitionId);
  const objectId = definition.source_kind === 'custom_object' ? definition.source_custom_object_id : definition.target_custom_object_id;
  const object = metadata.objects.find(o => o.id === objectId);
  const field = (metadata.fields[objectId] || []).find(f => f.id === object.primary_display_field_id);
  if (!field?.name) throw new Error('Department display field is unavailable.');
  return {
    active: true, token: captured.token,
    primary: graph.organization_id ? { id: graph.organization_id, label: label(graph.organization_id) } : null,
    secondary: secondary.map(id => ({ id, label: label(id) })),
    secondaryEnabled: !!cfg.secondaryMemberDefinitionId,
    departments: edges.map(edge => {
      const id = other(edge);
      const record = graph.records.find(r => r.id === id);
      return { id, label: String(record?.data?.[field.name] || 'Unavailable department'),
        organizationLabel: owners.get(id) ? label(owners.get(id)) : 'Ownership unavailable',
        protected: Object.values(edge.field_values || {}).some(value => value !== false && value != null) };
    }),
  };
}
