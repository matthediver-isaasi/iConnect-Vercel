import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areFormTransitionFieldsCompatible,
  findPersistedOpenFormAction,
  mapFormTransitionValues,
  normalizeFormTransitionMappings,
} from './formOpenTransition.js';

test('finds only the persisted open-form action by id', () => {
  const rules = [{
    id: 'rule-1',
    actions: [
      { id: 'show-1', action_type: 'show' },
      { id: 'open-1', action_type: 'open_form', destination_form_id: 'form-2' },
    ],
  }];
  assert.equal(findPersistedOpenFormAction(rules, 'show-1'), null);
  assert.equal(findPersistedOpenFormAction(rules, 'forged-open'), null);
  assert.equal(findPersistedOpenFormAction(rules, 'open-1').rule.id, 'rule-1');
});

test('allows compatible fields and rejects unsafe or shape-changing mappings', () => {
  assert.equal(
    areFormTransitionFieldsCompatible({ id: 'a', type: 'text' }, { id: 'b', type: 'email' }),
    true,
  );
  assert.equal(
    areFormTransitionFieldsCompatible({ id: 'a', type: 'number' }, { id: 'b', type: 'number' }),
    true,
  );
  assert.equal(
    areFormTransitionFieldsCompatible({ id: 'a', type: 'number' }, { id: 'b', type: 'text' }),
    false,
  );
  assert.equal(
    areFormTransitionFieldsCompatible({ id: 'a', type: 'file' }, { id: 'b', type: 'file' }),
    false,
  );
});

test('rejects duplicate targets, missing fields and incompatible persisted mappings', () => {
  const source = [{ id: 'source-1', type: 'text' }, { id: 'source-2', type: 'number' }];
  const target = [{ id: 'target-1', type: 'text' }];
  assert.equal(normalizeFormTransitionMappings({
    mappings: [
      { source_field_id: 'source-1', target_field_id: 'target-1' },
      { source_field_id: 'source-1', target_field_id: 'target-1' },
    ],
  }, source, target).valid, false);
  assert.equal(normalizeFormTransitionMappings({
    mappings: [{ source_field_id: 'source-2', target_field_id: 'target-1' }],
  }, source, target).valid, false);
  assert.equal(normalizeFormTransitionMappings({
    mappings: [{ source_field_id: 'missing', target_field_id: 'target-1' }],
  }, source, target).valid, false);
});

test('carries only explicitly mapped answers', () => {
  assert.deepEqual(mapFormTransitionValues([
    { source_field_id: 'source-1', target_field_id: 'target-1' },
    { source_field_id: 'source-2', target_field_id: 'target-2' },
  ], {
    'source-1': 'carried',
    'source-3': 'discarded',
  }), {
    'target-1': 'carried',
  });
});