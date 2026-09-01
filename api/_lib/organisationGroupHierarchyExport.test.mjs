import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildOrganisationGroupHierarchyRows,
  loadOrganisationGroupHierarchy,
  renderOrganisationGroupHierarchyCsv,
} from './organisationGroupHierarchyExport.js';

function fakeDb(tables) {
  return {
    from(table) {
      const filters = [];
      let range = null;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push(row => row[column] === value); return query; },
        not(column, operator, value) {
          if (operator === 'is' && value === null) filters.push(row => row[column] !== null);
          return query;
        },
        is(column, value) { filters.push(row => row[column] === value); return query; },
        order() { return query; },
        range(from, to) { range = [from, to]; return query.result(); },
        maybeSingle() {
          const rows = query.rows();
          return Promise.resolve({ data: rows[0] || null, error: null });
        },
        rows() { return (tables[table] || []).filter(row => filters.every(filter => filter(row))); },
        result() {
          const rows = query.rows();
          return Promise.resolve({
            data: range ? rows.slice(range[0], range[1] + 1) : rows,
            error: null,
          });
        },
        then(resolve, reject) { return query.result().then(resolve, reject); },
      };
      return query;
    },
  };
}

test('rows preserve empty descendants, expand departments, and sort by all three names', () => {
  const rows = buildOrganisationGroupHierarchyRows(
    [{ id: 'g2', name: 'Zulu' }, { id: 'g1', name: 'Alpha' }, { id: 'g3', name: 'Empty' }],
    [
      { id: 'o2', name: 'Beta', organization_group_id: 'g1' },
      { id: 'o1', name: 'Alpha Org', organization_group_id: 'g1' },
      { id: 'o3', name: 'Only Org', organization_group_id: 'g2' },
    ],
    [
      { organization_id: 'o2', name: 'Second' },
      { organization_id: 'o2', name: 'First' },
    ],
  );
  assert.deepEqual(rows, [
    { group: 'Alpha', organisation: 'Alpha Org', department: '' },
    { group: 'Alpha', organisation: 'Beta', department: 'First' },
    { group: 'Alpha', organisation: 'Beta', department: 'Second' },
    { group: 'Empty', organisation: '', department: '' },
    { group: 'Zulu', organisation: 'Only Org', department: '' },
  ]);
});

test('CSV is Excel-friendly UTF-8 and uses shared escaping protections', () => {
  const csv = renderOrganisationGroupHierarchyCsv([
    { group: 'Grüp, "One"', organisation: '=SUM(A1)', department: 'Line\nbreak' },
  ]);
  assert.equal(csv, '\ufeffGroup,Organisation,Department\r\n"Grüp, ""One""",\'=SUM(A1),Line break');
});

test('loader pages all data, stays tenant scoped, and excludes archived departments and edges', async () => {
  const db = fakeDb({
    organization_group: [
      { id: 'g1', tenant_id: 'tenant-a', name: 'A' },
      { id: 'g2', tenant_id: 'tenant-a', name: 'B' },
      { id: 'g3', tenant_id: 'tenant-a', name: 'C' },
      { id: 'foreign-g', tenant_id: 'tenant-b', name: 'Leaked' },
    ],
    organization: [
      { id: 'o1', tenant_id: 'tenant-a', name: 'One', organization_group_id: 'g1' },
      { id: 'o2', tenant_id: 'tenant-a', name: 'Two', organization_group_id: 'g2' },
      { id: 'o3', tenant_id: 'tenant-a', name: 'Three', organization_group_id: 'g3' },
      { id: 'foreign-o', tenant_id: 'tenant-b', name: 'Leaked', organization_group_id: 'g1' },
    ],
    custom_object_definition: [
      { id: 'dept-object', tenant_id: 'tenant-a', object_key: 'org_department', status: 'active', primary_display_field_id: 'field' },
    ],
    custom_object_relationship_definition: [
      { id: 'parent', tenant_id: 'tenant-a', relationship_key: 'organisation', status: 'active', source_kind: 'custom_object', source_custom_object_id: 'dept-object', target_kind: 'organization', is_required: true },
    ],
    custom_object_relationship: [
      { id: 'e1', tenant_id: 'tenant-a', relationship_definition_id: 'parent', source_record_id: 'd1', target_record_id: 'o1', archived_at: null },
      { id: 'e2', tenant_id: 'tenant-a', relationship_definition_id: 'parent', source_record_id: 'd2', target_record_id: 'o1', archived_at: '2026-01-01' },
      { id: 'e3', tenant_id: 'tenant-b', relationship_definition_id: 'parent', source_record_id: 'foreign-d', target_record_id: 'o1', archived_at: null },
    ],
    custom_object_record: [
      { id: 'd1', tenant_id: 'tenant-a', custom_object_id: 'dept-object', archived_at: null, data: { title: 'Active' } },
      { id: 'd2', tenant_id: 'tenant-a', custom_object_id: 'dept-object', archived_at: '2026-01-01', data: { title: 'Archived' } },
    ],
    preference_field: [{ id: 'field', tenant_id: 'tenant-a', name: 'title' }],
  });
  const rows = await loadOrganisationGroupHierarchy(db, 'tenant-a', { pageSize: 2 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { group: 'A', organisation: 'One', department: 'Active' });
  assert.equal(JSON.stringify(rows).includes('Leaked'), false);
  assert.equal(JSON.stringify(rows).includes('Archived'), false);
});

test('loader exports group and organisation levels when Department schema is absent', async () => {
  const rows = await loadOrganisationGroupHierarchy(fakeDb({
    organization_group: [{ id: 'g1', tenant_id: 'tenant-a', name: 'Group' }],
    organization: [{ id: 'o1', tenant_id: 'tenant-a', name: 'Org', organization_group_id: 'g1' }],
  }), 'tenant-a', { pageSize: 2 });
  assert.deepEqual(rows, [{ group: 'Group', organisation: 'Org', department: '' }]);
});

test('endpoint enforces authenticated admin feature access and never accepts a tenant parameter', async () => {
  const source = await readFile(
    new URL('../admin/organisation-groups/export-hierarchy-csv.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /getTenantContext\(req\)/);
  assert.match(source, /hasAdminAccess\(context\)/);
  assert.match(source, /hasFeatureAccess\(context\.roleId, 'crm\.organisation-groups'\)/);
  assert.match(source, /loadOrganisationGroupHierarchy\(supabase, context\.tenantId\)/);
  assert.doesNotMatch(source, /req\.(query|body).*tenant/i);
});

test('Organisation Groups header exposes a disabled/loading export action', async () => {
  const source = await readFile(
    new URL('../../client/src/pages/OrganisationGroups.jsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /data-testid="button-export-group-hierarchy"/);
  assert.match(source, /disabled=\{isExporting\}/);
  assert.match(source, /isExporting \? 'Exporting…' : 'Export CSV'/);
  assert.match(source, /\/api\/admin\/organisation-groups\/export-hierarchy-csv/);
});
