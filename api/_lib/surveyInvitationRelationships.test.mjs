import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInvitationRelationships } from './surveyInvitationRelationships.js';
import { buildSurveyInvitationPrefill } from '../../shared/surveyInvitationPrefill.js';

function fixture() {
  const rows = {
    custom_object_relationship_definition: [{
      id: 'rel', tenant_id: 'tenant', source_kind: 'member', target_kind: 'custom_object',
      source_custom_object_id: null, target_custom_object_id: 'department', status: 'active',
    }],
    custom_object_definition: [{ id: 'department', tenant_id: 'tenant', status: 'active', primary_display_field_id: 'label' }],
    custom_object_relationship: [
      { id: 'edge', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'attendee', target_record_id: 'assigned', archived_at: null },
      { id: 'unrelated', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'booker', target_record_id: 'unrelated', archived_at: null },
      { id: 'archived', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'attendee', target_record_id: 'old', archived_at: '2026-01-01' },
      { id: 'foreign', tenant_id: 'other', relationship_definition_id: 'rel', source_record_id: 'attendee', target_record_id: 'foreign', archived_at: null },
    ],
    custom_object_record: [
      { id: 'assigned', tenant_id: 'tenant', custom_object_id: 'department', archived_at: null, data: { secret: 'NEVER EXPOSE' } },
      { id: 'unrelated', tenant_id: 'tenant', custom_object_id: 'department', archived_at: null },
    ],
    organization: [{ id: 'org', tenant_id: 'tenant' }],
  };
  const calls = [];
  const db = { from(table) {
    const filters = [];
    let limit = Infinity;
    const q = {
      select(columns) { calls.push({ table, columns }); return q; },
      eq(key, value) { filters.push(row => row[key] === value); return q; },
      is(key, value) { filters.push(row => (row[key] ?? null) === value); return q; },
      in(key, values) { filters.push(row => values.includes(row[key])); return q; },
      order() { return q; },
      limit(value) { limit = value; return q; },
      maybeSingle() { return Promise.resolve({ data: rows[table].find(row => filters.every(filter => filter(row))) || null }); },
      then(resolve, reject) { return Promise.resolve({ data: rows[table].filter(row => filters.every(filter => filter(row))).slice(0, limit) }).then(resolve, reject); },
    };
    return q;
  } };
  const field = { id: 'department', type: 'relationship_dropdown', relationship_config: {
    relationship_definition_id: 'rel', source: 'member', source_side: 'source',
    related_kind: 'custom_object', related_custom_object_id: 'department', value: 'id',
  } };
  const args = { db, tenantId: 'tenant', fields: [field], settings: { invitation_prefill_config: { source: 'member' } },
    member: { id: 'attendee' }, organization: { id: 'org' }, relationships: { organization_id: 'org' } };
  return { rows, calls, field, args };
}

test('published member-root relationship returns only linked field-ID values, not booker/unrelated/archived/foreign graph or records', async () => {
  const f = fixture();
  const graph = await resolveInvitationRelationships(f.args);
  assert.deepEqual(graph, { values: { department: 'assigned' }, reasons: {} });
  const payload = buildSurveyInvitationPrefill(f.args.fields, {}, f.args.settings, { graph });
  assert.deepEqual(payload, { values: { department: 'assigned' }, unavailable: [] });
  assert.equal(JSON.stringify(payload).includes('NEVER EXPOSE'), false);
  assert.equal(f.calls.some(call => call.columns.includes('*') || call.columns.includes('data')), false);
});

test('inactive definitions/objects, wrong scopes and archived/foreign endpoint records are unavailable', async () => {
  for (const change of [
    f => { f.rows.custom_object_relationship_definition[0].status = 'archived'; },
    f => { f.rows.custom_object_relationship_definition[0].tenant_id = 'other'; },
    f => { f.rows.custom_object_relationship_definition[0].show_on_source = false; },
    f => { f.rows.custom_object_definition[0].status = 'archived'; },
    f => { f.rows.custom_object_record[0].archived_at = '2026-01-01'; },
    f => { f.rows.custom_object_record[0].tenant_id = 'other'; },
    f => { f.rows.custom_object_record[0].custom_object_id = 'different'; },
    f => { f.field.relationship_config.source = 'organization'; },
    f => { f.field.relationship_config.source_record_id = 'booker'; },
    f => { f.field.relationship_config.value = 'secret'; },
  ]) {
    const f = fixture();
    change(f);
    const graph = await resolveInvitationRelationships(f.args);
    assert.deepEqual(graph.values, {});
    assert.ok(graph.reasons.department);
  }
});

test('single-select ambiguity is unavailable, configured multi-selection is bounded and filters to saved options', async () => {
  const f = fixture();
  f.rows.custom_object_record.push({ id: 'second', tenant_id: 'tenant', custom_object_id: 'department', archived_at: null });
  f.rows.custom_object_relationship.push({ id: 'two', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'attendee', target_record_id: 'second', archived_at: null });
  assert.equal((await resolveInvitationRelationships(f.args)).reasons.department, 'relationship_ambiguous');
  f.field.selection_mode = 'multiple';
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values.department, ['assigned', 'second']);
  f.field.options = [{ value: 'second' }];
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values.department, ['second']);
  for (let index = 0; index < 100; index++) f.rows.custom_object_relationship.push({
    id: `extra${index}`, tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'attendee', target_record_id: 'assigned', archived_at: null,
  });
  const capped = await resolveInvitationRelationships(f.args);
  assert.equal(capped.reasons.department, 'relationship_scope_limit');
  assert.deepEqual(capped.values, {});
});

test('existing saved flat dropdown metadata uses only an authoritative preceding organization parent', async () => {
  const f = fixture();
  f.rows.custom_object_relationship_definition[0].source_kind = 'organization';
  f.rows.custom_object_relationship[0].source_record_id = 'org';
  f.args.fields = [
    { id: 'orgField', type: 'organisation_dropdown' },
    { id: 'department', type: 'relationship_dropdown', parent_field_id: 'orgField',
      relationship_definition_id: 'rel', relationship_parent_kind: 'organization', relationship_parent_side: 'source',
      related_kind: 'custom_object', related_custom_object_id: 'department', related_primary_display_field_id: 'label' },
  ];
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values, { department: 'assigned' });
  f.args.relationships.organization_id = null;
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values, {});
  f.args.relationships.organization_id = 'org';
  f.args.fields[0].prefill_field = 'booking:organization_id';
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values, {});
});

test('reverse graph direction honors the saved source side and fields with unsupported filters fail closed', async () => {
  const f = fixture();
  const d = f.rows.custom_object_relationship_definition[0];
  Object.assign(d, { source_kind: 'custom_object', source_custom_object_id: 'department', target_kind: 'member', target_custom_object_id: null });
  Object.assign(f.rows.custom_object_relationship[0], { source_record_id: 'assigned', target_record_id: 'attendee' });
  f.field.relationship_config.source_side = 'target';
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values, { department: 'assigned' });
  f.field.conditional_filter = { source_field_id: 'untrusted' };
  assert.deepEqual((await resolveInvitationRelationships(f.args)).values, {});
});