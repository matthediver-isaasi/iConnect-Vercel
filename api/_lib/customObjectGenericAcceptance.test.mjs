import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CUSTOM_OBJECT_RELATIONSHIP_CARDINALITIES,
  resolveCustomObjectDisplayValue,
  validateCustomObjectFieldDefinition,
  validateCustomObjectRecordData,
  validateCustomObjectRelationshipDefinition,
  validateCustomObjectRelationshipEndpoints,
} from './customObjectDomain.js';

const tenantId = '22222222-2222-4222-8222-222222222222';
const departmentId = '11111111-1111-4111-8111-111111111111';
const regionId = '33333333-3333-4333-8333-333333333333';

const objectDefinition = (id, objectKey, singularLabel, primaryDisplayFieldId) => ({
  id,
  tenant_id: tenantId,
  object_key: objectKey,
  singular_label: singularLabel,
  plural_label: `${singularLabel}s`,
  primary_display_field_id: primaryDisplayFieldId,
  status: 'active',
});

const fieldDefinition = (customObjectId, id, name, label) => ({
  id,
  tenant_id: tenantId,
  custom_object_id: customObjectId,
  entity_scope: 'custom_object',
  name,
  label,
  field_type: 'text',
  is_active: true,
  is_required: true,
});

test('Department and Region are metadata-driven Custom Object acceptance scenarios', () => {
  const departmentName = fieldDefinition(
    departmentId,
    '44444444-4444-4444-8444-444444444444',
    'department_name',
    'Department name',
  );
  const regionName = fieldDefinition(
    regionId,
    '55555555-5555-4555-8555-555555555555',
    'region_name',
    'Region name',
  );
  const department = objectDefinition(
    departmentId,
    'departments',
    'Department',
    departmentName.id,
  );
  const region = objectDefinition(regionId, 'regions', 'Region', regionName.id);

  for (const [definition, field, incoming, expectedDisplay] of [
    [department, departmentName, { department_name: 'Radiology' }, 'Radiology'],
    [region, regionName, { region_name: 'North West' }, 'North West'],
  ]) {
    assert.equal(validateCustomObjectFieldDefinition(field).ok, true);
    const validated = validateCustomObjectRecordData({
      data: incoming,
      fields: [field],
      mode: 'create',
    });
    assert.equal(validated.ok, true);
    const record = {
      id: crypto.randomUUID(),
      tenant_id: tenantId,
      custom_object_id: definition.id,
      data: validated.data,
      archived_at: null,
    };
    assert.equal(resolveCustomObjectDisplayValue({
      objectDefinition: definition,
      record,
      fields: [field],
    }), expectedDisplay);
  }
});

test('one Region to many Departments uses one generic bidirectional definition', () => {
  const relationship = {
    id: '66666666-6666-4666-8666-666666666666',
    tenant_id: tenantId,
    relationship_key: 'region_departments',
    status: 'active',
    cardinality: 'one_to_many',
    source_kind: 'custom_object',
    source_custom_object_id: regionId,
    source_label: 'Departments',
    target_kind: 'custom_object',
    target_custom_object_id: departmentId,
    target_label: 'Region',
    is_required: false,
    show_on_source: true,
    show_on_target: true,
    edit_from_source: true,
    edit_from_target: true,
    configuration: {},
  };
  const regionRecord = {
    id: '77777777-7777-4777-8777-777777777777',
    tenant_id: tenantId,
    kind: 'custom_object',
    custom_object_id: regionId,
    archived_at: null,
  };
  const departmentRecord = {
    id: '88888888-8888-4888-8888-888888888888',
    tenant_id: tenantId,
    kind: 'custom_object',
    custom_object_id: departmentId,
    archived_at: null,
  };

  assert.equal(validateCustomObjectRelationshipDefinition(relationship).ok, true);
  assert.equal(validateCustomObjectRelationshipEndpoints({
    tenantId,
    definition: relationship,
    source: regionRecord,
    target: departmentRecord,
  }), true);
  assert.deepEqual(
    [relationship.show_on_source, relationship.show_on_target],
    [true, true],
  );
  assert.deepEqual(
    [relationship.source_label, relationship.target_label],
    ['Departments', 'Region'],
  );
  assert.deepEqual(CUSTOM_OBJECT_RELATIONSHIP_CARDINALITIES, [
    'one_to_one',
    'one_to_many',
    'many_to_one',
    'many_to_many',
  ]);
});

test('generic implementation has no Department or Region branches, tables, or routes', async () => {
  const paths = [
    './customObjectDomain.js',
    './customObjectService.js',
    './customObjectRoute.js',
    '../custom-objects/index.js',
    '../custom-objects/[objectId].js',
    '../custom-objects/[objectId]/[resource].js',
    '../custom-objects/[objectId]/[resource]/[resourceId].js',
    '../../client/src/pages/CustomObjectsAdmin.jsx',
    '../../client/src/pages/CustomObjectRecords.jsx',
    '../../client/src/pages/customObjects/RelationshipDefinitions.jsx',
    '../../client/src/pages/customObjects/RelatedRecordsPanel.jsx',
  ];
  const sources = await Promise.all(paths.map(async (path) => ({
    path,
    source: await readFile(new URL(path, import.meta.url), 'utf8'),
  })));
  for (const { path, source } of sources) {
    assert.doesNotMatch(source, /\b(?:department|region)s?\b/i, path);
    assert.doesNotMatch(source, /(?:if|switch)\s*\([^)]*(?:object|kind)[^)]*\)[^{]*\{[^}]*(?:department|region)/i, path);
  }
});

test('generic API route entry points remain registered and non-public', async () => {
  const entries = [
    ['../custom-objects/index.js', 'collection'],
    ['../custom-objects/[objectId].js', 'object'],
    ['../custom-objects/[objectId]/[resource].js', 'resource'],
    ['../custom-objects/[objectId]/[resource]/[resourceId].js', 'item'],
  ];
  for (const [path, level] of entries) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /createCustomObjectRouteHandler/);
    assert.match(source, new RegExp(`createCustomObjectRouteHandler\\('${level}'\\)`));
    assert.doesNotMatch(path, /\/public\//);
  }

  const route = await readFile(new URL('./customObjectRoute.js', import.meta.url), 'utf8');
  assert.match(route, /if \(!context\?\.isAuthenticated\)/);
  assert.match(route, /if \(!context\?\.tenantId\)/);
});