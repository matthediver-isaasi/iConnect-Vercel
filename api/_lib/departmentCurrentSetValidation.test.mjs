import test from 'node:test';
import assert from 'node:assert/strict';
import { departmentCurrentSetValidationOptions } from './departmentCurrentSetValidation.js';

const configuration = {
  workforce_container_field_id: 'wf', equipment_container_field_id: 'eq',
  workforce_fields: { staff: 'staff_group', grade: 'grade', occupied: 'occupied_wte' },
  equipment_fields: { serial: 'serial_number', year: 'year_installed', notes: 'additional_information' },
};
const loaded = {
  complete_sections: ['wf', 'eq'],
  form_values: {
    wf: [{ _row_id: 'existing:w', staff: 'Technologist ', grade: 'Legacy grade' }],
    eq: [{ _row_id: 'existing:e', serial: null, year: '' },
      { _row_id: 'existing:filled', serial: 'SN', year: '2020' }],
  },
};
const blank = (options, id, child = 'serial', field = 'eq') => options.allowRequiredBlank({
  row: { _row_id: id, [child]: '' }, child: { id: child }, field: { id: field },
});

test('required exceptions bind exact loaded identities and original blanks', () => {
  const options = departmentCurrentSetValidationOptions(configuration, loaded);
  assert.equal(blank(options, 'existing:e'), true);
  assert.equal(blank(options, 'existing:e', 'year'), true);
  assert.equal(blank(options, 'existing:filled'), false);
  assert.equal(blank(options, 'existing:forged'), false);
  assert.equal(blank(options, 'new'), false);
  assert.equal(blank(options, 'existing:e', 'notes'), false);
  assert.equal(blank(options, 'existing:e', 'serial', 'wf'), false);
});

test('legacy choice exception preserves the exact source string and occurrence', () => {
  const options = departmentCurrentSetValidationOptions(configuration, loaded);
  const selection = { field: { id: 'wf' }, child: { id: 'staff' },
    row: { _row_id: 'existing:w' }, value: 'Technologist ' };
  assert.equal(options.isAllowedSpecialSelection(selection), true);
  assert.equal(options.isAllowedSpecialSelection({ ...selection, value: 'Technologist' }), false);
  assert.equal(options.isAllowedSpecialSelection({ ...selection, row: { _row_id: 'new' } }), false);
});

test('missing or incomplete source arrays never authorize exceptions', () => {
  assert.throws(() => departmentCurrentSetValidationOptions(configuration, {
    ...loaded, form_values: { wf: [] },
  }), /complete authorized/);
  assert.throws(() => departmentCurrentSetValidationOptions(configuration, {
    ...loaded, complete_sections: ['wf'],
  }), /complete authorized/);
});