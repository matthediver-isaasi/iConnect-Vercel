import test from 'node:test';
import assert from 'node:assert/strict';
import { audienceRows, discoverAudienceCustomObjects, validateAudienceCustomObjects, resolveCustomObjectConditions, matchesCustomObjectValue } from './audienceCustomObjects.js';

const condition = { entity_scope: 'custom_object', version: 1, custom_object_id: 'object',
  relationship_definition_id: 'rel', object_side: 'source', field_type: 'relationship',
  field_id: 'respondent', field_key: 'respondent', data_type: 'boolean', operator: 'is_true' };
function fixture() {
  return {
    custom_object_definition: [{ id: 'object', tenant_id: 'tenant', status: 'active', archived_at: null, singular_label: 'Department' }],
    custom_object_relationship_definition: [{ id: 'rel', tenant_id: 'tenant', status: 'active', archived_at: null,
      source_kind: 'custom_object', source_custom_object_id: 'object', target_kind: 'member', source_label: 'Members',
      configuration: { relationship_fields: [{ id: 'respondent', key: 'respondent', label: 'Survey respondent', type: 'boolean' }] } }],
    preference_field: [{ id: 'name-field', tenant_id: 'tenant', custom_object_id: 'object', entity_scope: 'custom_object',
      is_active: true, name: 'name', label: 'Name', field_type: 'text' }],
    custom_object_record: [
      { id: 'a', tenant_id: 'tenant', custom_object_id: 'object', archived_at: null, data: { name: 'A' } },
      { id: 'b', tenant_id: 'tenant', custom_object_id: 'object', archived_at: null, data: { name: 'B' } },
    ],
    custom_object_relationship: [
      { id: '1', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'a', target_record_id: 'm1', archived_at: null, field_values: { respondent: false } },
      { id: '2', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'b', target_record_id: 'm1', archived_at: null, field_values: { respondent: true } },
      { id: '3', tenant_id: 'tenant', relationship_definition_id: 'rel', source_record_id: 'b', target_record_id: 'm2', archived_at: null, field_values: { respondent: true } },
    ],
    custom_object_role_permission: [], custom_object_field_role_permission: [],
  };
}
function database(tables, failTable) {
  return { from(table) {
    let rows = [...(tables[table] || [])], start = 0, end = Infinity;
    const query = {
      select() { return query; },
      eq(key, value) { rows = rows.filter(r => r[key] === value); return query; },
      is(key, value) { rows = rows.filter(r => (r[key] ?? null) === value); return query; },
      in(key, values) { rows = rows.filter(r => values.includes(r[key])); return query; },
      not(key, operator, value) {
        if (key === 'email' && operator === 'ilike') rows = rows.filter(r => !/^deleted_.*@deleted\.local$/i.test(r.email));
        return query;
      },
      order() { rows.sort((a, b) => a.id.localeCompare(b.id)); return query; },
      range(a, b) { start = a; end = b; return query; },
      then(resolve) { return Promise.resolve({ data: rows.slice(start, end + 1), error: table === failTable ? { message: 'fixture query failure' } : null }).then(resolve); },
    };
    return query;
  } };
}
const targets = conditions => [{ type: 'field_filter', filter_groups: [{ conditions }] }];

test('discovery exposes stable storage keys, direction and authorized record/edge fields', async () => {
  const tables = fixture(), db = database(tables);
  assert.equal((await discoverAudienceCustomObjects(db, 'tenant', { context: { roleId: 'role' } })).length, 0);
  tables.custom_object_role_permission.push({ id: 'grant', tenant_id: 'tenant', role_id: 'role', custom_object_id: 'object', can_view_records: true });
  tables.custom_object_field_role_permission.push({ id: 'acl', tenant_id: 'tenant', role_id: 'role', field_id: 'name-field', access_level: 'none' });
  const discovered = await discoverAudienceCustomObjects(db, 'tenant', { context: { roleId: 'role' } });
  const rel = discovered[0].relationships[0];
  assert.equal(rel.object_side, 'source');
  assert.equal(rel.relationship_fields[0].key, 'respondent');
  assert.deepEqual(rel.record_fields, []);
  await assert.rejects(validateAudienceCustomObjects(db, 'tenant', targets([{ ...condition, field_type: 'record', field_id: 'name-field', field_key: 'name', data_type: 'text', operator: 'equals', value: 'A' }]), { context: { roleId: 'role' } }), /unavailable/);
});

test('boolean edges deduplicate and AND predicates bind the same occurrence', async () => {
  const db = database(fixture());
  assert.deepEqual([...await resolveCustomObjectConditions(db, 'tenant', [condition])].sort(), ['m1', 'm2']);
  const record = { ...condition, field_type: 'record', field_id: 'name-field', field_key: 'name', data_type: 'text', operator: 'equals', value: 'A' };
  assert.equal((await resolveCustomObjectConditions(db, 'tenant', [condition, record])).size, 0);
  assert.deepEqual([...await resolveCustomObjectConditions(db, 'tenant', [record])], ['m1']);
  // OR is a union of independently resolved groups, not a shared occurrence.
  const union = new Set([...await resolveCustomObjectConditions(db, 'tenant', [condition]), ...await resolveCustomObjectConditions(db, 'tenant', [record])]);
  assert.equal(union.size, 2);
});

test('member-source direction resolves correctly', async () => {
  const tables = fixture(), def = tables.custom_object_relationship_definition[0];
  Object.assign(def, { source_kind: 'member', source_custom_object_id: null, target_kind: 'custom_object', target_custom_object_id: 'object' });
  tables.custom_object_relationship.forEach(edge => {
    [edge.source_record_id, edge.target_record_id] = [edge.target_record_id, edge.source_record_id];
  });
  assert.equal((await resolveCustomObjectConditions(database(tables), 'tenant', [{ ...condition, object_side: 'target' }])).size, 2);
});

test('archived records and edges and foreign tenants never qualify', async () => {
  for (const mutate of [
    t => { t.custom_object_record[1].archived_at = '2026-01-01'; },
    t => { t.custom_object_record[1].tenant_id = 'foreign'; },
    t => { t.custom_object_relationship.forEach(e => { e.archived_at = '2026-01-01'; }); },
    t => { t.custom_object_relationship.forEach(e => { e.tenant_id = 'foreign'; }); },
  ]) {
    const tables = fixture(); mutate(tables);
    assert.equal((await resolveCustomObjectConditions(database(tables), 'tenant', [condition])).size, 0);
  }
});

test('stale references, invalid types/operators/direction and unauthorized saves fail closed', async () => {
  const db = database(fixture());
  for (const change of [{ version: 2 }, { custom_object_id: 'foreign' }, { relationship_definition_id: 'stale' },
    { field_id: 'stale' }, { field_key: 'stale' }, { object_side: 'target' }, { data_type: 'text' }, { operator: 'contains' }]) {
    await assert.rejects(validateAudienceCustomObjects(db, 'tenant', targets([{ ...condition, ...change }])), /Custom Object audience/);
    await assert.rejects(resolveCustomObjectConditions(db, 'tenant', [{ ...condition, ...change }]), /Custom Object audience/);
  }
  await assert.rejects(validateAudienceCustomObjects(db, 'tenant', targets([condition]), { context: { roleId: 'denied' } }), /not authorized/);
  for (const table of ['custom_object_definition', 'custom_object_relationship_definition']) {
    const tables = fixture(); tables[table][0].status = 'archived';
    await assert.rejects(resolveCustomObjectConditions(database(tables), 'tenant', [condition]), /unavailable/);
  }
});

test('null is not false; explicit empty predicates and typed comparisons', () => {
  assert.equal(matchesCustomObjectValue(null, { ...condition, operator: 'is_false' }), false);
  assert.equal(matchesCustomObjectValue('true', condition), false);
  assert.equal(matchesCustomObjectValue(false, { ...condition, operator: 'is_false' }), true);
  assert.equal(matchesCustomObjectValue(undefined, { ...condition, operator: 'is_empty' }), true);
  assert.equal(matchesCustomObjectValue(12, { data_type: 'number', operator: 'greater_than', value: '2' }), true);
});

test('complete pagination beyond a query page, bounded lookup batches and explicit errors', async () => {
  const tables = fixture();
  tables.custom_object_relationship = Array.from({ length: 1201 }, (_, i) => ({
    ...tables.custom_object_relationship[1], id: `edge-${i}`, target_record_id: `member-${i}`,
  }));
  assert.equal((await resolveCustomObjectConditions(database(tables), 'tenant', [condition])).size, 1201);
  await assert.rejects(resolveCustomObjectConditions(database(tables, 'custom_object_record'), 'tenant', [condition]), /fixture query failure/);
  await assert.rejects(audienceRows(() => database(tables).from('custom_object_relationship').select('*'), 'test bound', 500), /safe evaluation limit/);
});

test('shared campaign resolution preserves group OR, member AND, deleted suppression and opt-outs for counts and preview', async t => {
  process.env.SUPABASE_URL = 'https://audience-fixture.invalid';
  process.env.SUPABASE_SERVICE_KEY = 'isolated-test-key';
  const { supabase } = await import('./database.js');
  const { getTargetRecipients } = await import('./campaignService.js');
  const original = supabase.from;
  t.after(() => { supabase.from = original; });
  const tables = fixture();
  tables.member = [
    { id: 'm1', tenant_id: 'tenant', email: 'one@example.test', first_name: 'One' },
    { id: 'm2', tenant_id: 'tenant', email: 'two@example.test', first_name: 'Two', communications_opted_out_all: true },
    { id: 'm3', tenant_id: 'tenant', email: 'deleted_three@deleted.local', first_name: 'Three' },
  ];
  tables.custom_object_relationship.push({ ...tables.custom_object_relationship[2], id: '4', target_record_id: 'm3' });
  supabase.from = database(tables).from;
  const campaign = { target_audiences: targets([condition]) };
  const resolved = await getTargetRecipients(campaign, 'tenant');
  assert.equal(resolved.success, true, resolved.error);
  assert.deepEqual(resolved.recipients.map(r => r.id), ['m1']);
  assert.equal((await getTargetRecipients(campaign, 'tenant', true)).count, 1);
  campaign.target_audiences = targets([condition, { entity_scope: 'member', field_type: 'core', field_key: 'first_name', data_type: 'text', operator: 'equals', value: 'Two' }]);
  assert.equal((await getTargetRecipients(campaign, 'tenant', true)).count, 0);
  campaign.target_audiences[0].filter_groups.push({ conditions: [condition] });
  assert.equal((await getTargetRecipients(campaign, 'tenant', true)).count, 1);
  campaign.target_audiences[0].filter_groups.push({ conditions: [{ ...condition, field_id: 'stale' }] });
  assert.equal((await getTargetRecipients(campaign, 'tenant', true)).success, false);
});