import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCustomObjectRowSource,
  isDistinctRowSource,
  rowSourceDependencyIds,
  rowSourceValueDomain,
  validateRowSourceConfiguration,
} from './formCustomObjectRowSources.js';

test('shared equality domains distinguish numeric inputs and calendar dates from clock times', () => {
  for (const type of ['number', 'decimal', 'percentage', 'currency', 'integer']) {
    assert.equal(rowSourceValueDomain(type), 'number');
  }
  assert.equal(rowSourceValueDomain('date'), 'date');
  assert.equal(rowSourceValueDomain('boolean'), 'boolean');
  assert.equal(rowSourceValueDomain('time'), 'string');
  for (const type of ['datetime', 'date_time', 'picklist', 'multiselect', null]) {
    assert.equal(rowSourceValueDomain(type), null);
  }
});

const objectId = '10000000-0000-0000-0000-000000000001';
const displayId = '10000000-0000-0000-0000-000000000002';
const valueId = '10000000-0000-0000-0000-000000000003';
const scalarId = 'child_existing_scalar';
const filterId = '10000000-0000-0000-0000-000000000005';
const parentId = '10000000-0000-0000-0000-000000000006';
const childId = '10000000-0000-0000-0000-000000000007';

const records = {
  id: childId,
  type: 'relationship_dropdown',
  option_source: {
    version: 1,
    kind: 'records',
    custom_object_id: objectId,
    primary_display_field_id: displayId,
    filters: [{ field_id: filterId, source_field_id: scalarId }],
  },
};

test('recognises only the strict versioned custom object source contract', () => {
  assert.equal(isCustomObjectRowSource(records), true);
  assert.equal(isDistinctRowSource(records), false);
  assert.deepEqual(rowSourceDependencyIds(records), [scalarId]);
  assert.equal(isCustomObjectRowSource({
    ...records,
    option_source: { ...records.option_source, value_field_id: valueId },
  }), false);
  assert.equal(isCustomObjectRowSource({ ...records, selection_mode: 'single' }), true);
  assert.equal(isCustomObjectRowSource({ ...records, selection_mode: 'multiple' }), false);
  assert.equal(isCustomObjectRowSource({
    ...records,
    not_listed_choice: { enabled: true, label: 'Other' },
  }), false);
  assert.equal(isCustomObjectRowSource({
    ...records,
    option_source: { ...records.option_source, custom_object_id: 'not-a-uuid' },
  }), false);
  assert.deepEqual(rowSourceDependencyIds({
    ...records,
    option_source: { ...records.option_source, forged: true },
  }), []);
  assert.equal(isCustomObjectRowSource({
    ...records,
    option_source: {
      ...records.option_source,
      filters: [{ field_id: filterId, source_field_id: '_row_id' }],
    },
  }), false);
});

test('validates direct record sources and earlier scalar filter dependencies', () => {
  const scalar = { id: scalarId, type: 'text' };
  assert.equal(validateRowSourceConfiguration(records, [scalar, records]).valid, true);
  assert.equal(validateRowSourceConfiguration(records, [records, scalar]).valid, false);
  assert.equal(validateRowSourceConfiguration(records, [
    { id: scalarId, type: 'organisation_dropdown' },
    records,
  ]).valid, false);
  assert.equal(validateRowSourceConfiguration(records, []).valid, false);
  assert.equal(validateRowSourceConfiguration({
    ...records,
    selection_mode: 'multiple',
  }, [{ id: scalarId, type: 'text' }, records]).valid, false);
  assert.equal(validateRowSourceConfiguration({
    ...records,
    not_listed_choice: { enabled: true, label: 'Other' },
  }, [{ id: scalarId, type: 'text' }, records]).valid, false);
});

test('distinct sources require an earlier record parent and remain scalar dependencies', () => {
  const parent = {
    id: parentId,
    type: 'relationship_dropdown',
    ...records,
    option_source: { ...records.option_source, filters: [] },
  };
  parent.id = parentId;
  const distinct = {
    id: childId,
    type: 'relationship_dropdown',
    relationship_definition_id: 'relationship-1',
    parent_field_id: parentId,
    option_source: {
      ...records.option_source,
      kind: 'distinct',
      value_field_id: valueId,
      filters: [],
    },
  };
  assert.equal(isDistinctRowSource(distinct), true);
  assert.deepEqual(rowSourceDependencyIds(distinct), [parentId]);
  assert.equal(validateRowSourceConfiguration(distinct, [parent, distinct]).valid, true);
  assert.equal(validateRowSourceConfiguration({ ...distinct, relationship_definition_id: null }, [
    parent,
    distinct,
  ]).valid, false);
  assert.equal(validateRowSourceConfiguration(distinct, [
    { ...distinct, id: parentId, parent_field_id: 'missing' },
    distinct,
  ]).valid, false);
  assert.equal(validateRowSourceConfiguration({
    ...distinct,
    parent_field_scope: 'form',
  }, [parent, distinct]).valid, false);
});