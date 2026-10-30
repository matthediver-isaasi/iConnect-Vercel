import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormCopy } from './formDuplication.js';
import { validateFormMutationAccessSave } from './formMutationContract.js';

test('unsafe public member configuration copies as an editable draft without bypassing activation checks', () => {
  const original = {
    id: 'source', name: 'Associate join', slug: 'associate-join',
    is_active: true, require_authentication: false, mutation_access_policy: null,
    fields: [{ id: 'email', type: 'email' }],
    structured_actions: { actions: [{ operation: 'update', target: { kind: 'member' } }] },
    entity_pipelines: { members: [{
      id: 'member', uniqueness_key: 'email', mappings: [
        { source_field_id: 'email', target_type: 'core', target_field: 'email' },
      ],
    }], organisations: [] },
    created_at: 'old', archived_at: 'old', submission_count: 50,
  };
  assert.equal(validateFormMutationAccessSave({ form: original, isCreate: true }).ok, false);
  const copy = createFormCopy(original, 123);
  assert.equal(copy.is_active, false);
  assert.equal(copy.id, undefined);
  assert.equal(copy.archived_at, undefined);
  assert.equal(copy.created_at, undefined);
  assert.equal(copy.submission_count, 0);
  assert.equal(copy.slug, 'associate-join-copy-123');
  assert.deepEqual(copy.entity_pipelines, original.entity_pipelines);
  assert.deepEqual(copy.fields, original.fields);
  assert.equal(copy.require_authentication, false);
  assert.equal(original.is_active, true);
  assert.equal(validateFormMutationAccessSave({ form: copy, isCreate: true }).ok, true);
  assert.equal(validateFormMutationAccessSave({
    form: { ...copy, is_active: true }, previousForm: copy,
  }).ok, false, 'activating an unsafe copied contract must still be rejected');
});
