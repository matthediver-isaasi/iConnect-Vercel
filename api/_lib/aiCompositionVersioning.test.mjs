/**
 * AI Composition version retention tests (Task #2849).
 * Pure decision logic: rolling window prune that never touches the current
 * version or locked versions; restore builds a NEW version with parent chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectVersionsToPrune,
  buildRestoreVersion,
  MAX_KEEP,
} from './aiCompositionVersioning.js';

const mkVersions = (n) => Array.from({ length: n }, (_, i) => ({
  id: `v${i + 1}`,
  created_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
}));

test('no pruning within the window', () => {
  assert.deepEqual(selectVersionsToPrune(mkVersions(MAX_KEEP), 'v1'), []);
});

test('oldest beyond the window are pruned', () => {
  const versions = mkVersions(MAX_KEEP + 3); // v1..v13, newest v13
  const ids = selectVersionsToPrune(versions, 'v13');
  assert.deepEqual(ids.sort(), ['v1', 'v2', 'v3']);
});

test('the CURRENT version is never pruned even when aged out', () => {
  const versions = mkVersions(MAX_KEEP + 3);
  const ids = selectVersionsToPrune(versions, 'v2'); // v2 aged out but current
  assert.ok(!ids.includes('v2'));
  assert.deepEqual(ids.sort(), ['v1', 'v3']);
});

test('locked versions sit outside the prune pot', () => {
  const versions = mkVersions(MAX_KEEP + 2);
  versions[0].locked = true; // v1 locked
  const ids = selectVersionsToPrune(versions, 'v12');
  assert.ok(!ids.includes('v1'));
  assert.deepEqual(ids, ['v2']);
});

test('buildRestoreVersion copies document and chains parent', () => {
  const source = {
    id: 'v5',
    created_at: '2026-01-05T00:00:00Z',
    document: { schemaVersion: 1, sections: [] },
    generation_metadata: { model: 'x' },
  };
  const row = buildRestoreVersion(source, { tenantId: 't1', compositionId: 'c1', createdBy: 'u1' });
  assert.equal(row.parent_version_id, 'v5');
  assert.equal(row.operation_type, 'restore');
  assert.equal(row.tenant_id, 't1');
  assert.equal(row.composition_id, 'c1');
  assert.deepEqual(row.document, source.document);
  assert.equal(row.validation_result.restoredFrom, 'v5');
});

test('buildRestoreVersion refuses a version without a document', () => {
  assert.throws(() => buildRestoreVersion({ id: 'v1' }, { tenantId: 't', compositionId: 'c' }));
});
