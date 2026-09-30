import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyEmptyMappingSource, isEmptyMappingAnswer, summarizeMappingResults } from './mappingEmptySource.js';

const mapping = { source_field_id: 'source', target_type: 'core', target_field: 'name' };
const context = (field = {}, extra = {}) => ({
  sourceForm: { fields: [{ id: 'source', required: false, ...field }], ...extra },
});

test('optional empty scalars and collections skip; false and zero remain values', () => {
  for (const value of [undefined, null, '', '  ', [], {}]) {
    assert.equal(isEmptyMappingAnswer(value), true);
    assert.equal(classifyEmptyMappingSource(mapping, value, context()).status, 'skipped');
  }
  for (const value of [false, 0, '0', 'false', [0], { value: false }]) {
    assert.equal(isEmptyMappingAnswer(value), false);
    assert.equal(classifyEmptyMappingSource(mapping, value, context()), null);
  }
});

test('required, unknown definitions and unknown conditional requirements fail closed', () => {
  for (const field of [{ required: true }, { is_required: true }, { required: 'true' },
    { required_if: {} }, { required_rules: [] }]) {
    assert.equal(classifyEmptyMappingSource(mapping, '', context(field)).status, 'requires_attention');
  }
  assert.equal(classifyEmptyMappingSource(mapping, '', {}).reason, 'Source field definition is missing');
  assert.equal(classifyEmptyMappingSource({ source_type: 'static' }, '', {}).status, 'requires_attention');
});

test('canonical visibility and hidden pages exclude otherwise-required empty sources', () => {
  assert.equal(classifyEmptyMappingSource(mapping, '', context({ required: true, starts_hidden: true })).status, 'skipped');
  assert.equal(classifyEmptyMappingSource(mapping, '', context(
    { required: true, page_id: 'page' }, { pages: [{ id: 'page', starts_hidden: true }] },
  )).status, 'skipped');
  const config = context({ required: true }, {
    visibility_rules: [{
      conditions: [{ field_id: 'gate', operator: 'equals', value: 'hide' }],
      action: 'hide', target_field_ids: ['source'],
    }],
  });
  assert.equal(classifyEmptyMappingSource(mapping, '', { ...config, answers: { gate: 'hide' } }).status, 'skipped');
  assert.equal(classifyEmptyMappingSource(mapping, '', { ...config, answers: { gate: 'show' } }).status, 'requires_attention');
});

test('explicit clearing remains distinct from an absent optional answer', () => {
  assert.equal(classifyEmptyMappingSource(mapping, '', { ...context(), explicitEmpty: true }), null);
});

test('33 mapping / 4 optional blank shape reports accurate totals and does not hide failures', () => {
  const mappings = Array.from({ length: 33 }, (_, index) => (
    [1, 6, 20, 28].includes(index)
      ? classifyEmptyMappingSource(mapping, '', context())
      : { status: 'updated' }
  ));
  assert.deepEqual(summarizeMappingResults(mappings), {
    status: 'success',
    history: { mappings_count: 29, applied_count: 29, skipped_count: 4, attention_count: 0, noop_count: 0 },
  });
  mappings[0] = { status: 'error', error: 'write failed' };
  assert.equal(summarizeMappingResults(mappings).status, 'partial');
  assert.equal(summarizeMappingResults(mappings).history.attention_count, 1);
  assert.equal(summarizeMappingResults(mappings.filter(m => m.status === 'skipped')).status, 'success');
});