import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPublicFormWidth,
  validateFormWidthPayload,
} from '../../shared/formWidth.js';

test('generic Form create/update validation has the API error contract', () => {
  for (const value of ['narrow', 'medium', 'wide']) {
    assert.equal(validateFormWidthPayload({ form_width: value }), null);
  }
  for (const value of [undefined, null, '', 'full', 64, {}, []]) {
    assert.deepEqual(validateFormWidthPayload({ form_width: value }), {
      error: 'form_width must be one of: narrow, medium, wide',
      code: 'INVALID_FORM_WIDTH',
    });
  }
  assert.equal(validateFormWidthPayload({ name: 'legacy form' }), null);
  assert.equal(validateFormWidthPayload(null), null);
});

test('public projections normalize missing and invalid persisted widths', () => {
  assert.equal(getPublicFormWidth({ form_width: 'wide' }), 'wide');
  assert.equal(getPublicFormWidth({ form_width: 'medium' }), 'medium');
  assert.equal(getPublicFormWidth({}), 'narrow');
  assert.equal(getPublicFormWidth({ form_width: 'invalid' }), 'narrow');
  assert.equal(getPublicFormWidth(null), 'narrow');
});