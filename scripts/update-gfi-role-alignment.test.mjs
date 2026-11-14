import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeOptions } from './update-gfi-role-alignment.mjs';

test('preserves values and unrelated options, appends in order, and replays unchanged', () => {
  const existing = ['Legacy', { value: 'Employer engagement', label: 'Employer engagement' }];
  const themes = ['Employer Engagement', 'AI & Technology', 'Enterprise & Entrepreneurship'];
  const result = mergeOptions(existing, themes);
  assert.deepEqual(result.options, ['Legacy', { value: 'Employer engagement', label: 'Employer Engagement' },
    { value: themes[1], label: themes[1] }, { value: themes[2], label: themes[2] }]);
  assert.equal(existing[1].label, 'Employer engagement');
  assert.deepEqual(mergeOptions(result.options, themes), { options: result.options, added: [] });
});

test('rejects ambiguous labels, stored-value collisions, and unapproved renaming', () => {
  assert.throws(() => mergeOptions([{ value: 'a', label: 'Theme' }, { value: 'b', label: 'Theme' }], ['Theme']));
  assert.throws(() => mergeOptions([{ value: 'Theme', label: 'Different' }], ['Theme']));
  assert.throws(() => mergeOptions(['theme'], ['Theme']));
  assert.throws(() => mergeOptions([''], ['Theme']));
});

test('matches existing visible labels without rewriting stored values and deduplicates source', () => {
  const existing = [{ value: 'stable-id', label: 'Theme' }];
  assert.deepEqual(mergeOptions(existing, ['Theme', 'Theme']), { options: existing, added: [] });
});
