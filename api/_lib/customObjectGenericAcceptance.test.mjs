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

test('a Workforce Survey-shaped record uses the same field and display contracts', () => {
  const surveyTitle = fieldDefinition(
    departmentId,
    '99999999-9999-4999-8999-999999999999',
    'survey_title',
    'Survey title',
  );
  const responseCount = {
    ...fieldDefinition(
      departmentId,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'response_count',
      'Response count',
    ),
    field_type: 'number',
    is_required: false,
  };
  const survey = objectDefinition(
    departmentId,
    'staff_feedback',
    'Workforce Survey',
    surveyTitle.id,
  );

  const validated = validateCustomObjectRecordData({
    data: { survey_title: 'Autumn engagement', response_count: '42' },
    fields: [surveyTitle, responseCount],
    mode: 'create',
  });
  assert.deepEqual(validated, {
    ok: true,
    data: { survey_title: 'Autumn engagement', response_count: 42 },
    errors: [],
  });
  assert.equal(resolveCustomObjectDisplayValue({
    objectDefinition: survey,
    record: { id: 'survey-record', data: validated.data },
    fields: [surveyTitle, responseCount],
  }), 'Autumn engagement');
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

test('record presentation implementation has no Workforce Survey, Department, or Region rendering branch', async () => {
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
    '../../client/src/pages/customObjects/ContextualRecordCreateDialog.jsx',
    '../../client/src/pages/customObjects/RecordFieldControls.jsx',
    '../../client/src/pages/customObjects/recordHelpers.js',
    '../../client/src/pages/customObjects/relationshipHelpers.js',
  ];
  const sources = await Promise.all(paths.map(async (path) => ({
    path,
    source: await readFile(new URL(path, import.meta.url), 'utf8'),
  })));
  for (const { path, source } of sources) {
    assert.doesNotMatch(source, /\b(?:workforce(?:[_\s-]?survey)?|department|region)s?\b/i, path);
    assert.doesNotMatch(source, /(?:if|switch)\s*\([^)]*(?:object|kind)[^)]*\)[^{]*\{[^}]*(?:workforce|department|region)/i, path);
  }
});

test('generic record creation supports relationship initialization without object-specific branches', async () => {
  const [service, route, migration] = await Promise.all([
    readFile(new URL('./customObjectService.js', import.meta.url), 'utf8'),
    readFile(new URL('./customObjectRoute.js', import.meta.url), 'utf8'),
    readFile(new URL('../../supabase/migrations/20260925_custom_object_record_relationship_create.sql', import.meta.url), 'utf8'),
  ]);
  assert.match(service, /createRecordWithRelationships/);
  assert.match(service, /create_custom_object_record_with_relationships/);
  assert.match(route, /createRecordWithRelationships/);
  assert.match(migration, /p_relationships jsonb/);
  assert.match(migration, /routed_side = 'source'/);
  assert.match(migration, /routed_side = 'target'/);
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

test('Data Studio uses one canonical page permission across routes and menu catalogues', async () => {
  const [layout, pageIndex, adminPage, portalMenu, navigationMenu] = await Promise.all([
    readFile(new URL('../../client/src/pages/Layout.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/index.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/CustomObjectsAdmin.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/PortalMenuManagement.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../client/src/pages/NavigationManagement.jsx', import.meta.url), 'utf8'),
  ]);

  assert.match(layout, /'CustomObjectsAdmin': 'admin\.data-studio'/);
  assert.match(layout, /featureId: "admin\.data-studio"/);
  assert.match(
    layout,
    /itemSection === 'admin'[\s\S]*`page_admin_\$\{item\.url\}`/,
  );
  assert.match(adminPage, /isFeatureExcluded\("admin\.data-studio"\)/);
  assert.doesNotMatch(adminPage, /isFeatureExcluded\("data\.custom-objects"\)/);
  assert.match(
    pageIndex,
    /urlParts\[0\]\?\.toLowerCase\(\) === 'customobjectsadmin'[\s\S]*return 'CustomObjectsAdmin'/,
  );
  assert.equal(
    (pageIndex.match(/<Route path="\/CustomObjectsAdmin[^"]*"/g) || []).length,
    6,
  );
  assert.match(
    portalMenu,
    /\{ value: "CustomObjectsAdmin", label: "Data Studio" \}/,
  );
  assert.match(
    navigationMenu,
    /\{ name: "CustomObjectsAdmin", label: "Data Studio" \}/,
  );
});

test('Presentation editor wires list columns, CRM cards, relationships, and visibility rules', async () => {
  const adminPage = await readFile(
    new URL('../../client/src/pages/CustomObjectsAdmin.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    adminPage,
    /import\s+\{\s*Checkbox\s*\}\s+from\s+["']@\/components\/ui\/checkbox["']/,
  );
  assert.match(
    adminPage,
    /function OrderedFieldPicker[\s\S]*<Checkbox\b[\s\S]*onCheckedChange=/,
  );
  assert.match(
    adminPage,
    /Default list columns[\s\S]*<OrderedFieldPicker\b/,
  );
  assert.match(
    adminPage,
    /Record page cards[\s\S]*<OrgDetailLayoutEditor\b/,
  );
  assert.match(
    adminPage,
    /relationshipPanels=\{panels\}/,
  );
  assert.match(
    adminPage,
    /Conditional visibility/,
  );
  assert.match(
    adminPage,
    /visibility_rules/,
  );
  assert.match(
    adminPage,
    /loadCustomObjectFields\(objectId/,
  );
  assert.match(
    adminPage,
    /loadRelationshipDefinitions\(objectId, api\)/,
  );
  assert.match(
    adminPage,
    /<Button[^>]*onClick=\{\(\) => save\.mutate\(\)\}[\s\S]*Save presentation<\/Button>/,
  );
});