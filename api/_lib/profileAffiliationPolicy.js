/**
 * Profile affiliation bindings deliberately support only direct department
 * ownership and a member-owned secondary assignment bridge. Not a general
 * permission to edit custom objects. Revalidate saved bindings on every read.
 */
export const PROFILE_AFFILIATION_KEYS = [
  'memberDepartmentDefinitionId', 'departmentOrganizationDefinitionId',
  'secondaryMemberDefinitionId', 'secondaryOrganizationDefinitionId', 'secondaryLabelFieldId',
];
export function validateProfileAffiliationConfig(input, metadata, { requirePinned = false } = {}) {
  if (!input || typeof input.enabled !== 'boolean' || metadata?.complete !== true) {
    throw new Error('Complete affiliation configuration is required.');
  }
  const config = { enabled: input.enabled };
  const canonical = v => JSON.stringify(v, (_, x) => x && !Array.isArray(x) && typeof x === 'object'
    ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
  for (const key of PROFILE_AFFILIATION_KEYS) config[key] = input[key] || null;
  if (!config.enabled) return config;
  const find = id => {
    const d = metadata.relationships.find(row => row.id === id && row.status === 'active');
    if (!d) throw new Error('Choose an active relationship definition.');
    return d;
  };
  const endpoint = (d, kind) => {
    const side = d.source_kind === kind && d.target_kind === 'custom_object' ? 'source'
      : d.target_kind === kind && d.source_kind === 'custom_object' ? 'target' : null;
    if (!side) throw new Error('Unsupported relationship endpoints.');
    const other = side === 'source' ? 'target' : 'source';
    const objectId = d[`${other}_custom_object_id`];
    const object = metadata.objects.find(o => o.id === objectId && o.status === 'active');
    if (!object) {
      throw new Error('The configured object is unavailable.');
    }
    const display = (metadata.fields[objectId] || []).find(f => f.id === object.primary_display_field_id);
    if (!display?.name || display.is_active === false || display.archived_at) {
      throw new Error('The object needs an active display field.');
    }
    return { side, other, objectId };
  };
  const department = find(config.memberDepartmentDefinitionId);
  const member = endpoint(department, 'member');
  const owner = find(config.departmentOrganizationDefinitionId);
  const org = endpoint(owner, 'organization');
  if (member.objectId !== org.objectId || department.cardinality !== 'many_to_many'
    || owner.cardinality !== (org.side === 'target' ? 'many_to_one' : 'one_to_many')) {
    throw new Error('Departments need many-to-many member links and one owning organisation.');
  }
  const secondary = !!config.secondaryMemberDefinitionId;
  if (secondary !== !!config.secondaryOrganizationDefinitionId) throw new Error('Configure both secondary relationships.');
  if (!secondary && config.secondaryLabelFieldId) throw new Error('Select secondary relationships before a label field.');
  let assignment;
  if (secondary) {
    const md = find(config.secondaryMemberDefinitionId);
    const od = find(config.secondaryOrganizationDefinitionId);
    const m = endpoint(md, 'member');
    const o = endpoint(od, 'organization');
    if (m.objectId !== o.objectId || m.objectId === member.objectId
      || md.cardinality !== (m.side === 'target' ? 'many_to_one' : 'one_to_many')
      || od.cardinality !== (o.side === 'target' ? 'many_to_one' : 'one_to_many')) {
      throw new Error('Secondary affiliations need a distinct member-owned assignment object.');
    }
    assignment = { member: md, organization: od, m, o };
    for (const d of [md, od]) {
      if (d.configuration?.picker_scope) throw new Error('Scoped secondary assignments are not supported.');
      if ((d.configuration?.relationship_fields || d.configuration?.relationshipFields || []).length) {
        throw new Error('Secondary assignment metadata requires administrator management.');
      }
    }
    const fields = metadata.fields[m.objectId] || [];
    const label = fields.find(f => f.id === config.secondaryLabelFieldId);
    if (config.secondaryLabelFieldId && (!label || !['text', 'textarea'].includes(label.field_type))) {
      throw new Error('Choose a text assignment label field.');
    }
    if (fields.some(f => f.is_required && f.id !== label?.id)) throw new Error('Assignment fields require administrator input.');
  }
  // Prevent grants through defaults or resurrection. Every new boolean is
  // explicitly false in SQL; existing metadata is never rewritten.
  const relationshipFields = department.configuration?.relationship_fields
    ?? department.configuration?.relationshipFields ?? [];
  if (!Array.isArray(relationshipFields) || relationshipFields.some(f =>
    (f.type ?? f.field_type) !== 'boolean'
      || (f.default_value ?? f.defaultValue ?? f.default ?? false) !== false)) {
    throw new Error('Department relationship metadata cannot safely be granted by members.');
  }
  const scope = department.configuration?.picker_scope;
  if (scope) {
    const expected = {
      match: 'intersects', version: 2,
      [`${member.other}_path`]: [{ from_side: org.other, relationship_definition_id: owner.id }],
      [`${member.side}_path`]: assignment ? [
        { from_side: assignment.m.side, relationship_definition_id: assignment.member.id },
        { from_side: assignment.o.other, relationship_definition_id: assignment.organization.id },
      ] : [],
      [`${member.side}_terminal_sources`]: [{ type: 'core_field', field: 'organization_id' }],
    };
    if (canonical(scope) !== canonical(expected)) throw new Error('The department graph scope does not match these affiliation bindings.');
  }
  config.bindingSignature = canonical([department, owner, ...(assignment ? [assignment.member, assignment.organization] : [])].map(d => ({
    id: d.id, source_kind: d.source_kind, target_kind: d.target_kind,
    source_custom_object_id: d.source_custom_object_id || null, target_custom_object_id: d.target_custom_object_id || null,
    cardinality: d.cardinality, is_required: d.is_required === true,
    picker_scope: d.configuration?.picker_scope || null,
    relationship_fields: d.configuration?.relationship_fields ?? d.configuration?.relationshipFields ?? [],
    objects: [d.source_custom_object_id, d.target_custom_object_id].filter(Boolean).map(id => {
      const o = metadata.objects.find(o => o.id === id);
      return { id, displayField: o.primary_display_field_id,
        fields: (metadata.fields[id] || []).map(f => ({ id: f.id, name: f.name, type: f.field_type,
          required: f.is_required === true, active: f.is_active !== false && !f.archived_at })).sort((a, b) => a.id.localeCompare(b.id)) };
    }),
  })));
  if (requirePinned && input.bindingSignature !== config.bindingSignature) {
    throw new Error('Affiliation definitions changed. An administrator must review and save the settings again.');
  }
  return config;
}

export function normalizeProfileAffiliationRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => !['token', 'primary', 'secondary', 'departments'].includes(k))) {
    throw new Error('Unsupported affiliation request.');
  }
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
  if (!uuid(body.token)) throw new Error('Reload your affiliations before saving.');
  const output = {};
  if (Object.hasOwn(body, 'primary')) {
    if (body.primary !== null && !uuid(body.primary)) throw new Error('Select an existing organisation.');
    output.primary = body.primary;
  }
  for (const [key, max] of [['secondary', 100], ['departments', 500]]) {
    if (!Object.hasOwn(body, key)) continue;
    if (!Array.isArray(body[key]) || body[key].length > max || body[key].some(v => !uuid(v))
      || new Set(body[key]).size !== body[key].length) throw new Error('Select distinct existing affiliations.');
    output[key] = [...body[key]].sort();
  }
  return output;
}
