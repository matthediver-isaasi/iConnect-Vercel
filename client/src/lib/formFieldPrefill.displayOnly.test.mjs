import test from 'node:test';
import assert from 'node:assert/strict';
import { isFieldValueFilled } from './formFieldPrefill.js';

test('required display blocks never demand an uneditable answer', () => {
  for (const type of ['instructions', 'image', 'section_header', 'heading', 'paragraph', 'divider', 'spacer', 'html']) {
    for (const value of [undefined, null, '']) {
      assert.equal(isFieldValueFilled({ type, required: true, label: 'Learning Outcomes' }, value), true);
    }
  }
});

test('learning outcome ratings remain required alongside instructions', () => {
  const fields = [
    { id: 'intro', type: 'instructions', required: true },
    { id: 'aim1', type: 'score', required: true, score_min: 1, score_max: 5 },
    { id: 'aim2', type: 'score', required: true, score_min: 1, score_max: 5 },
  ];
  const missing = values => fields.filter(f => f.required && !isFieldValueFilled(f, values[f.id])).map(f => f.id);
  assert.deepEqual(missing({}), ['aim1', 'aim2']);
  assert.deepEqual(missing({ aim1: { score: 4 } }), ['aim2']);
  assert.deepEqual(missing({ aim1: { score: 4 }, aim2: { score: 5 } }), []);
  assert.equal(isFieldValueFilled({ type: 'text', required: true }, ''), false);
});
