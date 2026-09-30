import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPersistedFormEntityCreations,
  singlePersistedCreationId,
} from './formEntityCreationProvenance.js';

function query(result) {
  const value = {
    select() { return value; },
    eq() { return value; },
    in() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return value;
}

test('reload adopts inserted entities but excludes crashed orphan reservations', async () => {
  const db = {
    from(table) {
      if (table === 'form_submission_entity_creation') {
        return query({ data: [
          { entity_type: 'member', entity_id: 'inserted-member' },
          { entity_type: 'member', entity_id: 'orphan-member' },
          { entity_type: 'organization', entity_id: 'inserted-org' },
        ], error: null });
      }
      if (table === 'member') return query({ data: [{ id: 'inserted-member' }], error: null });
      if (table === 'organization') return query({ data: [{ id: 'inserted-org' }], error: null });
      throw new Error(`unexpected table ${table}`);
    },
  };
  const result = await loadPersistedFormEntityCreations({
    db,
    tenantId: 'tenant-1',
    submissionId: 'submission-1',
  });
  assert.deepEqual([...result.member], ['inserted-member']);
  assert.deepEqual([...result.organization], ['inserted-org']);
  assert.equal(singlePersistedCreationId(result, 'member'), 'inserted-member');
});

test('multiple inserted entities fail closed instead of choosing one', async () => {
  const db = {
    from(table) {
      if (table === 'form_submission_entity_creation') {
        return query({ data: [
          { entity_type: 'organization', entity_id: 'org-1' },
          { entity_type: 'organization', entity_id: 'org-2' },
        ], error: null });
      }
      return query({ data: [{ id: 'org-1' }, { id: 'org-2' }], error: null });
    },
  };
  await assert.rejects(
    loadPersistedFormEntityCreations({ db, tenantId: 'tenant-1', submissionId: 'submission-1' }),
    error => error.code === 'FORM_ENTITY_CREATION_PROVENANCE_CONFLICT',
  );
});