import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesResourceSubcategories as matches } from './resourceSubcategoryFilter.mjs';

const categories = [
  { subcategories: ['Guidelines', 'Images'] },
  { subcategories: ['Bone', 'Brain'] },
  { subcategories: ['Diagnostics', 'Management'] },
  { subcategories: ['Patients and Carers'] },
];
const selected = categories.flatMap(c => c.subcategories);
test('default and explicit OR preserve any-match behaviour', () => {
  for (const mode of [undefined, 'or']) {
    assert.equal(matches({ subcategories: ['Images'] }, selected, categories, mode), true);
    assert.equal(matches({ subcategories: ['Other'] }, selected, categories, mode), false);
  }
});
test('BNMS example requires each selected category, not each selected item', () => {
  const tags = ['Images', 'Brain', 'Diagnostics', 'Patients and Carers'];
  assert.equal(matches({ subcategories: tags }, selected, categories, 'and'), true);
  for (const tag of tags) {
    assert.equal(matches({ subcategories: tags.filter(t => t !== tag) }, selected, categories, 'and'), false);
  }
});
test('empty selections and unselected categories impose no restriction', () => {
  assert.equal(matches({}, [], categories, 'and'), true);
  assert.equal(matches({ subcategories: ['Images'] }, ['Guidelines', 'Images'], categories, 'and'), true);
  assert.equal(matches({}, ['Images'], categories, 'and'), false);
});
test('legacy names remain a filter and duplicate names remain usable', () => {
  assert.equal(matches({ subcategories: ['Legacy'] }, ['Legacy'], categories, 'and'), true);
  assert.equal(matches({}, ['Legacy'], categories, 'and'), false);
  assert.equal(matches({ subcategories: ['Images'] }, ['Images'], [...categories, { subcategories: ['Images'] }], 'and'), true);
});
