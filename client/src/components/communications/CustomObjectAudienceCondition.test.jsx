import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CustomObjectAudienceCondition, { customObjectSelection, customObjectConditionError, customObjectSummary } from './CustomObjectAudienceCondition.jsx';

const metadata = { custom_objects: [{ id: 'department', label: 'Department', relationships: [
  { id: 'members', label: 'Members', object_side: 'source', record_fields: [{ id: 'name-id', key: 'name', label: 'Name', data_type: 'text', operators: ['equals', 'contains', 'is_empty'] }], relationship_fields: [{ id: 'responder-id', key: 'responder_key', label: 'Survey Responder', data_type: 'boolean', operators: ['equals', 'is_true', 'is_false', 'is_empty'], options: [] }] },
  { id: 'reverse', label: 'Departments', object_side: 'target', record_fields: [], relationship_fields: [] },
] }] };
const saved = { entity_scope: 'custom_object', version: 1, custom_object_id: 'department', relationship_definition_id: 'members', object_side: 'source', field_type: 'relationship', field_key: 'responder_key', field_id: 'responder-id', data_type: 'boolean', operator: 'equals', value: true, custom_object_label: 'Department', relationship_label: 'Members', field_label: 'Survey Responder' };
const render = (condition = saved, extra = {}) => renderToStaticMarkup(<CustomObjectAudienceCondition condition={condition} metadata={metadata} onChange={() => assert.fail('Rendering must not mutate saved state')} {...extra} />);

test('saved boolean relationship reopens with object, relationship, field and Yes', () => {
  const html = render(JSON.parse(JSON.stringify(saved)));
  for (const label of ['Department', 'Members (Object', 'Relationship: Survey Responder', 'Yes']) assert.ok(html.includes(label), label);
  assert.equal(customObjectConditionError(saved, metadata), '');
  assert.match(customObjectSummary(saved, metadata), /Department → Members → Relationship: Survey Responder equals Yes/);
  assert.ok(render({ ...saved, value: false }).includes('No'));
});
test('stable field identity, direction, version and data type are required', () => {
  for (const patch of [{ field_id: 'missing' }, { field_key: 'Survey Responder' }, { object_side: 'target' }, { version: 2 }, { data_type: 'text' }, { custom_object_id: 'archived' }, { relationship_definition_id: 'archived' }, { operator: 'contains' }, { value: '' }]) {
    assert.ok(customObjectConditionError({ ...saved, ...patch }, metadata), JSON.stringify(patch));
  }
});
test('record and relationship fields stay distinct and reverse direction resolves', () => {
  const record = { ...saved, field_type: 'record', field_id: 'name-id', field_key: 'name', data_type: 'text', value: 'Clinical' };
  assert.equal(customObjectConditionError(record, metadata), '');
  assert.ok(render(record).includes('Record: Name'));
  assert.equal(customObjectSelection({ ...saved, relationship_definition_id: 'reverse', object_side: 'target' }, metadata).relationship.id, 'reverse');
  assert.equal(customObjectSelection({ ...record, field_type: 'relationship' }, metadata).field, undefined);
});
test('loading and unavailable definitions retain saved labels without mutation', () => {
  const before = JSON.stringify(saved);
  const html = render(saved, { metadata: null, disabled: true });
  for (const label of ['Department', 'Members', 'Survey Responder', 'Retry loading before saving']) assert.ok(html.includes(label), label);
  assert.equal(JSON.stringify(saved), before);
  assert.match(render(saved, { metadata: { custom_objects: [] } }), /archived or inaccessible/);
});
test('null operators omit value control; unsupported and empty values fail closed', () => {
  assert.equal(customObjectConditionError({ ...saved, operator: 'is_empty', value: '' }, metadata), '');
  assert.ok(!render({ ...saved, operator: 'is_empty', value: '' }).includes('aria-label="Value"'));
  assert.match(customObjectConditionError({ ...saved, value: 'maybe' }, metadata), /Yes or No/);
});