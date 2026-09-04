import { escapeCsvCell, CSV_BOM, CSV_ROW_SEPARATOR } from './csvCell.js';

const PAGE_SIZE = 1000;

async function pageRows(queryFactory, pageSize = PAGE_SIZE) {
  const rows = [];
  for (let from = 0;; from += pageSize) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

function compareNames(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });
}

export function buildOrganisationGroupHierarchyRows(groups, organisations, departments = []) {
  const organisationsByGroup = new Map();
  for (const organisation of organisations) {
    if (!organisation.organization_group_id) continue;
    const current = organisationsByGroup.get(organisation.organization_group_id) || [];
    current.push(organisation);
    organisationsByGroup.set(organisation.organization_group_id, current);
  }
  const departmentsByOrganisation = new Map();
  for (const department of departments) {
    const current = departmentsByOrganisation.get(department.organization_id) || [];
    current.push(department);
    departmentsByOrganisation.set(department.organization_id, current);
  }

  const rows = [];
  for (const group of groups) {
    const groupOrganisations = organisationsByGroup.get(group.id) || [];
    if (!groupOrganisations.length) {
      rows.push({
        group: group.name || '',
        groupId: group.id || '',
        organisation: '',
        organisationId: '',
        department: '',
        departmentId: '',
      });
      continue;
    }
    for (const organisation of groupOrganisations) {
      const organisationDepartments = departmentsByOrganisation.get(organisation.id) || [];
      if (!organisationDepartments.length) {
        rows.push({
          group: group.name || '',
          groupId: group.id || '',
          organisation: organisation.name || '',
          organisationId: organisation.id || '',
          department: '',
          departmentId: '',
        });
        continue;
      }
      for (const department of organisationDepartments) {
        rows.push({
          group: group.name || '',
          groupId: group.id || '',
          organisation: organisation.name || '',
          organisationId: organisation.id || '',
          department: department.name || '',
          departmentId: department.id || '',
        });
      }
    }
  }
  return rows.sort((a, b) =>
    compareNames(a.group, b.group)
    || compareNames(a.organisation, b.organisation)
    || compareNames(a.department, b.department));
}

export function renderOrganisationGroupHierarchyCsv(rows) {
  const lines = [
    ['Group', 'Group UUID', 'Organisation', 'Organisation UUID', 'Department', 'Department UUID']
      .map(escapeCsvCell).join(','),
    ...rows.map(row => [
      row.group,
      row.groupId,
      row.organisation,
      row.organisationId,
      row.department,
      row.departmentId,
    ].map(escapeCsvCell).join(',')),
  ];
  return CSV_BOM + lines.join(CSV_ROW_SEPARATOR);
}

export async function loadOrganisationGroupHierarchy(db, tenantId, { pageSize = PAGE_SIZE } = {}) {
  const groups = await pageRows(
    (from, to) => db.from('organization_group').select('id, name')
      .eq('tenant_id', tenantId).order('id', { ascending: true }).range(from, to),
    pageSize,
  );
  const organisations = await pageRows(
    (from, to) => db.from('organization').select('id, name, organization_group_id')
      .eq('tenant_id', tenantId).not('organization_group_id', 'is', null)
      .order('id', { ascending: true }).range(from, to),
    pageSize,
  );

  const { data: definitions, error: definitionError } = await db.from('custom_object_definition')
    .select('id, primary_display_field_id').eq('tenant_id', tenantId)
    .eq('object_key', 'org_department').eq('status', 'active');
  if (definitionError) throw new Error(definitionError.message);
  if (!definitions?.length) {
    return buildOrganisationGroupHierarchyRows(groups, organisations);
  }
  if (definitions.length !== 1) throw new Error('Department schema is unavailable');
  const departmentDefinition = definitions[0];

  const { data: relationships, error: relationshipError } = await db.from('custom_object_relationship_definition')
    .select('id').eq('tenant_id', tenantId).eq('relationship_key', 'organisation')
    .eq('status', 'active').eq('source_kind', 'custom_object')
    .eq('source_custom_object_id', departmentDefinition.id)
    .eq('target_kind', 'organization').eq('is_required', true);
  if (relationshipError) throw new Error(relationshipError.message);
  if (!relationships?.length) {
    return buildOrganisationGroupHierarchyRows(groups, organisations);
  }
  if (relationships.length !== 1) throw new Error('Department organisation schema is unavailable');

  const edges = await pageRows(
    (from, to) => db.from('custom_object_relationship').select('source_record_id, target_record_id')
      .eq('tenant_id', tenantId).eq('relationship_definition_id', relationships[0].id)
      .is('archived_at', null).order('id', { ascending: true }).range(from, to),
    pageSize,
  );
  if (!edges.length) return buildOrganisationGroupHierarchyRows(groups, organisations);

  const records = await pageRows(
    (from, to) => db.from('custom_object_record').select('id, data')
      .eq('tenant_id', tenantId).eq('custom_object_id', departmentDefinition.id)
      .is('archived_at', null).order('id', { ascending: true }).range(from, to),
    pageSize,
  );
  let displayFieldName = null;
  if (departmentDefinition.primary_display_field_id) {
    const { data: displayField, error: displayFieldError } = await db.from('preference_field')
      .select('name').eq('tenant_id', tenantId)
      .eq('id', departmentDefinition.primary_display_field_id).maybeSingle();
    if (displayFieldError) throw new Error(displayFieldError.message);
    displayFieldName = displayField?.name || null;
  }
  const recordsById = new Map(records.map(record => [record.id, record]));
  const departments = edges.flatMap(edge => {
    const record = recordsById.get(edge.source_record_id);
    if (!record) return [];
    return [{
      id: record.id,
      organization_id: edge.target_record_id,
      name: displayFieldName ? record.data?.[displayFieldName] || '' : '',
    }];
  });
  return buildOrganisationGroupHierarchyRows(groups, organisations, departments);
}
