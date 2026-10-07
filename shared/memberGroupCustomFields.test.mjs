import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGroupDefinitions, validateGroupValues, groupDisplayValues, GROUP_FIELD_TYPES } from './memberGroupCustomFields.js';
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const defs = GROUP_FIELD_TYPES.map((type, n) => ({ id: id(n), name: type, type, choices: type === 'select' ? ['One', 'Two'] : [], show_on_detail: true }));
test('all eight types round-trip; zero and explicit false are populated', () => {
  const input = Object.fromEntries(defs.map((f, n) => [f.id, ['Hello', 'One\nTwo', 0, '2026-10-07', 'One', false, 'a@example.test', 'https://example.test'][n]]));
  assert.deepEqual(validateGroupValues(input, validateGroupDefinitions(defs)), input);
  assert.equal(groupDisplayValues(input, defs).length, 8);
});
test('clearing is explicit and unknown IDs including foreign/deleted ones fail', () => {
  assert.deepEqual(validateGroupValues({ [id(0)]: '', [id(1)]: null }, defs), {});
  assert.deepEqual(validateGroupValues({}, defs), {});
  assert.throws(() => validateGroupValues({ [id(50)]: '' }, defs), /Unknown/);
  for (const value of [null, [], 'text', 0]) assert.throws(() => validateGroupValues(value, defs));
});
test('strict typed validation, real dates and safe links', () => {
  for (const [n, values] of [[0, [5, 'a\nb']], [2, ['0', false, Infinity]], [3, ['2026-02-30','2026-13-01']], [4, ['Unknown']], [5, ['false', 0]], [6, ['bad', 'a@b']], [7, ['javascript:alert(1)', 'data:text/html,hello', 'https://user:pass@example.test']]]) {
    for (const v of values) assert.throws(() => validateGroupValues({ [id(n)]: v }, defs));
  }
});
test('private/orphan/empty values never display; rename preserves identity', () => {
  const values = { [id(0)]: 'A', [id(1)]: 'B', [id(2)]: 0, [id(5)]: false, [id(40)]: 'orphan' };
  const changed = defs.map(f => ({ ...f, name: `Renamed ${f.name}`, show_on_detail: f.type !== 'textarea' }));
  const shown = groupDisplayValues(values, changed);
  assert.equal(shown.length, 3);
  assert.equal(shown[0].name, 'Renamed text');
  assert.equal(shown[0].value, 'A');
  assert.equal(groupDisplayValues(values, []).length, 0);
});
test('definition limits, default visibility and stable unique IDs', () => {
  assert.equal(validateGroupDefinitions([{ ...defs[0], show_on_detail: undefined }])[0].show_on_detail, false);
  for (const fields of [[defs[0], defs[0]], [{ ...defs[0], id: '__proto__' }], [{ ...defs[0], name: ' ' }], [{ ...defs[4], choices: ['A',' A '] }], [{ ...defs[4], choices: [] }], Array(51).fill(defs[0])]) assert.throws(() => validateGroupDefinitions(fields));
});
