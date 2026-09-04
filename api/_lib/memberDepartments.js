// Department membership is represented exclusively by Custom Object edges.
// These helpers keep the schema lookup and batched edge resolution consistent
// for member list, export, and directory callers.
export class MemberDepartmentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const pageRows = async (queryFactory, size = 1000) => {
  const rows = [];
  for (let from = 0;; from += size) {
    const { data, error } = await queryFactory(from, from + size - 1);
    if (error) throw new Error(`Department query failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < size) return rows;
  }
};

export async function resolveMemberDepartmentDefinition(db, tenantId, { required = false } = {}) {
  const { data: objects, error: objectError } = await db.from('custom_object_definition')
    .select('id, primary_display_field_id').eq('tenant_id', tenantId)
    .eq('object_key', 'org_department').eq('status', 'active');
  if (objectError) throw new Error(`Department object lookup failed: ${objectError.message}`);
  if ((objects || []).length === 0 && !required) return null;
  if ((objects || []).length !== 1) throw new MemberDepartmentError('Department schema is unavailable', 409);
  const department = objects[0];
  const { data: definitions, error } = await db.from('custom_object_relationship_definition')
    .select('id, source_custom_object_id, source_kind, target_kind, target_custom_object_id, cardinality').eq('tenant_id', tenantId).eq('relationship_key', 'members')
    .eq('status', 'active');
  if (error) throw new Error(`Department relationship lookup failed: ${error.message}`);
  if ((definitions || []).length === 0 && !required) return null;
  if ((definitions || []).length !== 1
    || definitions[0].source_kind !== 'custom_object'
    || definitions[0].source_custom_object_id !== department.id
    || definitions[0].target_kind !== 'member'
    || definitions[0].target_custom_object_id !== null
    || !['one_to_many', 'many_to_many'].includes(definitions[0].cardinality)) {
    throw new MemberDepartmentError('Department membership schema is unavailable', 409);
  }
  return { departmentObjectId: department.id, primaryDisplayFieldId: department.primary_display_field_id, definitionId: definitions[0].id };
}

export async function validateDepartmentIds(db, tenantId, ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];
  const schema = await resolveMemberDepartmentDefinition(db, tenantId, { required: true });
  const rows = await pageRows((from, to) => db.from('custom_object_record').select('id')
    .eq('tenant_id', tenantId).eq('custom_object_id', schema.departmentObjectId).is('archived_at', null)
    .in('id', unique).range(from, to));
  if (rows.length !== unique.length) throw new MemberDepartmentError('One or more department IDs are invalid', 400);
  return unique;
}

export async function resolveDepartmentMemberIds(db, tenantId, departmentIds) {
  const ids = await validateDepartmentIds(db, tenantId, departmentIds);
  if (!ids.length) return [];
  const { definitionId, departmentObjectId } = await resolveMemberDepartmentDefinition(db, tenantId, { required: true });
  const { data: parentDefinitions, error: parentError } = await db.from('custom_object_relationship_definition')
    .select('id, cardinality, target_custom_object_id')
    .eq('tenant_id', tenantId).eq('relationship_key', 'organisation').eq('status', 'active')
    .eq('source_kind', 'custom_object').eq('source_custom_object_id', departmentObjectId)
    .eq('target_kind', 'organization').eq('is_required', true);
  if (parentError || (parentDefinitions || []).length !== 1
    || parentDefinitions[0].cardinality !== 'many_to_one'
    || parentDefinitions[0].target_custom_object_id !== null) {
    throw new MemberDepartmentError('Department organisation schema is unavailable', 409);
  }
  const [edges, parentEdges] = await Promise.all([
    pageRows((from, to) => db.from('custom_object_relationship')
      .select('source_record_id, target_record_id').eq('tenant_id', tenantId)
      .eq('relationship_definition_id', definitionId).is('archived_at', null)
      .in('source_record_id', ids).range(from, to)),
    pageRows((from, to) => db.from('custom_object_relationship')
      .select('source_record_id, target_record_id').eq('tenant_id', tenantId)
      .eq('relationship_definition_id', parentDefinitions[0].id).is('archived_at', null)
      .in('source_record_id', ids).range(from, to)),
  ]);
  const parentsByDepartment = new Map();
  for (const edge of parentEdges) {
    const parentIds = parentsByDepartment.get(edge.source_record_id) || [];
    parentIds.push(edge.target_record_id);
    parentsByDepartment.set(edge.source_record_id, parentIds);
  }
  const memberIds = [...new Set(edges.map(edge => edge.target_record_id))];
  if (!memberIds.length) return [];
  const members = await pageRows((from, to) => db.from('member').select('id, organization_id')
    .eq('tenant_id', tenantId).in('id', memberIds).range(from, to));
  const organizationByMember = new Map(members.map(member => [member.id, member.organization_id]));
  return [...new Set(edges.filter(edge => {
    const parentIds = parentsByDepartment.get(edge.source_record_id);
    return parentIds?.length === 1
      && organizationByMember.get(edge.target_record_id)
      && organizationByMember.get(edge.target_record_id) === parentIds[0];
  }).map(edge => edge.target_record_id))];
}

export async function enrichMembersWithDepartments(db, tenantId, members) {
  if (!members?.length) return members || [];
  const schema = await resolveMemberDepartmentDefinition(db, tenantId);
  if (!schema) return members.map(row => ({ ...row, departments: [], department_ids: [] }));
  const { definitionId, departmentObjectId, primaryDisplayFieldId } = schema;
  const memberIds = members.map(row => row.id);
  const edges = await pageRows((from, to) => db.from('custom_object_relationship').select('source_record_id, target_record_id')
    .eq('tenant_id', tenantId).eq('relationship_definition_id', definitionId).is('archived_at', null)
    .in('target_record_id', memberIds).range(from, to));
  const departmentIds = [...new Set(edges.map(row => row.source_record_id))];
  if (!departmentIds.length) return members.map(row => ({ ...row, departments: [], department_ids: [] }));
  const [departments, fields, parentDefinitions] = await Promise.all([
    pageRows((from, to) => db.from('custom_object_record').select('id, data').eq('tenant_id', tenantId)
      .eq('custom_object_id', departmentObjectId).is('archived_at', null).in('id', departmentIds).range(from, to)),
    primaryDisplayFieldId ? db.from('preference_field').select('id, name').eq('tenant_id', tenantId).eq('id', primaryDisplayFieldId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    db.from('custom_object_relationship_definition').select('id, cardinality, target_custom_object_id')
      .eq('tenant_id', tenantId).eq('relationship_key', 'organisation').eq('status', 'active')
      .eq('source_kind', 'custom_object').eq('source_custom_object_id', departmentObjectId)
      .eq('target_kind', 'organization').eq('is_required', true),
  ]);
  if (fields.error) throw new Error(`Department display field lookup failed: ${fields.error.message}`);
  if (parentDefinitions.error || (parentDefinitions.data || []).length !== 1
    || parentDefinitions.data[0].cardinality !== 'many_to_one'
    || parentDefinitions.data[0].target_custom_object_id !== null) {
    throw new MemberDepartmentError('Department organisation schema is unavailable', 409);
  }
  const parentEdges = await pageRows((from, to) => db.from('custom_object_relationship')
    .select('source_record_id, target_record_id').eq('tenant_id', tenantId)
    .eq('relationship_definition_id', parentDefinitions.data[0].id).is('archived_at', null)
    .in('source_record_id', departmentIds).range(from, to));
  const nameKey = fields.data?.name;
  const orgIds = [...new Set(members.map(row => row.organization_id).filter(Boolean))];
  const organizations = orgIds.length ? await pageRows((from, to) => db.from('organization').select('id, name')
    .eq('tenant_id', tenantId).in('id', orgIds).range(from, to)) : [];
  const names = new Map(departments.map(row => [row.id, nameKey ? row.data?.[nameKey] : null]));
  const orgNames = new Map(organizations.map(row => [row.id, row.name]));
  const parentsByDepartment = new Map();
  for (const edge of parentEdges) {
    const parentIds = parentsByDepartment.get(edge.source_record_id) || [];
    parentIds.push(edge.target_record_id);
    parentsByDepartment.set(edge.source_record_id, parentIds);
  }
  const records = new Set(departments.map(row => row.id));
  const edgesByMember = new Map();
  for (const edge of edges) {
    const ids = edgesByMember.get(edge.target_record_id) || [];
    ids.push(edge.source_record_id);
    edgesByMember.set(edge.target_record_id, ids);
  }
  return members.map(row => {
    const departmentIdsForMember = [...new Set(edgesByMember.get(row.id) || [])]
      .filter(id => records.has(id)
        && row.organization_id
        && parentsByDepartment.get(id)?.length === 1
        && parentsByDepartment.get(id)[0] === row.organization_id);
    const departmentsForMember = departmentIdsForMember.map(id => ({
      id,
      name: names.get(id) || '',
      organization_id: row.organization_id,
      organization_name: orgNames.get(row.organization_id) || '',
    })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return {
      ...row,
      departments: departmentsForMember,
      department_ids: departmentsForMember.map(department => department.id),
    };
  });
}

export async function listDepartmentOptions(db, tenantId, organizationIds = []) {
  const schema = await resolveMemberDepartmentDefinition(db, tenantId);
  if (!schema) return [];
  // Deliberately resolve parent definition separately; don't assume an ID or
  // relationship cardinality from the member definition.
  const { data: parents, error } = await db.from('custom_object_relationship_definition').select('id, cardinality, target_custom_object_id')
    .eq('tenant_id', tenantId).eq('relationship_key', 'organisation').eq('status', 'active')
    .eq('source_kind', 'custom_object').eq('source_custom_object_id', schema.departmentObjectId).eq('target_kind', 'organization').eq('is_required', true);
  if (error || (parents || []).length !== 1 || parents[0].cardinality !== 'many_to_one'
    || parents[0].target_custom_object_id !== null) {
    throw new MemberDepartmentError('Department organisation schema is unavailable', 409);
  }
  const parentEdges = await pageRows((from, to) => db.from('custom_object_relationship').select('source_record_id, target_record_id')
    .eq('tenant_id', tenantId).eq('relationship_definition_id', parents[0].id).is('archived_at', null).range(from, to));
  const requested = new Set(organizationIds || []);
  const parentsByDepartment = new Map();
  for (const edge of parentEdges) {
    const rows = parentsByDepartment.get(edge.source_record_id) || [];
    rows.push(edge);
    parentsByDepartment.set(edge.source_record_id, rows);
  }
  const relevant = [...parentsByDepartment.values()]
    .filter(rows => rows.length === 1)
    .map(rows => rows[0])
    .filter(edge => !requested.size || requested.has(edge.target_record_id));
  if (!relevant.length) return [];
  const records = await pageRows((from, to) => db.from('custom_object_record').select('id, data').eq('tenant_id', tenantId)
    .eq('custom_object_id', schema.departmentObjectId).is('archived_at', null).in('id', relevant.map(e => e.source_record_id)).range(from, to));
  const field = schema.primaryDisplayFieldId ? await db.from('preference_field').select('name').eq('tenant_id', tenantId).eq('id', schema.primaryDisplayFieldId).maybeSingle() : { data: null };
  const orgs = await pageRows((from, to) => db.from('organization').select('id, name').eq('tenant_id', tenantId)
    .in('id', [...new Set(relevant.map(e => e.target_record_id))]).range(from, to));
  const recordMap = new Map(records.map(r => [r.id, r])); const orgMap = new Map(orgs.map(o => [o.id, o.name]));
  return relevant.map(e => ({ id: e.source_record_id, name: recordMap.get(e.source_record_id)?.data?.[field.data?.name] || '', organization_id: e.target_record_id, organization_name: orgMap.get(e.target_record_id) || '' }))
    .filter(row => recordMap.has(row.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}