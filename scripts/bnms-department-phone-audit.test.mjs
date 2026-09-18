import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PHONE_FIELD_ID,
  jsonReferences,
} from './lib/bnms-department-phone-audit.mjs';

test('finds exact, prefixed, array, and path-key phone field references', () => {
  const references = jsonReferences({
    exact: PHONE_FIELD_ID,
    fields: [`field:${PHONE_FIELD_ID}`, `custom:${PHONE_FIELD_ID}`],
    [`path-${PHONE_FIELD_ID}`]: { enabled: true },
  });
  assert.deepEqual(
    references.map((item) => item.path),
    ['exact', 'fields.0', 'fields.1', `path-${PHONE_FIELD_ID}`],
  );
  assert.ok(references.every((item) => item.reference === 'field_id'));
});

test('finds phone key references and reports nearby numeric semantics', () => {
  const references = jsonReferences({
    filters: [{ field: 'phone_number', operator: 'greater_than', value: 10 }],
  });
  assert.equal(references.length, 1);
  assert.equal(references[0].path, 'filters.0.field');
  assert.deepEqual(references[0].numericTokens, ['greater_than']);
});

test('ignores unrelated phone-like values and non-numeric operators', () => {
  assert.deepEqual(jsonReferences({
    field: 'main_phone_number',
    label: 'Phone number',
    operator: 'contains',
  }), []);
});