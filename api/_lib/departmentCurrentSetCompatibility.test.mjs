import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDepartmentCurrentSetCompatibility,
  assertDepartmentCurrentSetLoadedBounds,
  buildDepartmentCurrentSetCompatibilityContract,
} from './departmentCurrentSetCompatibility.js';

const form = () => ({
  fields: [
    {
      id: 'workforce', type: 'repeatable_rows', min_rows: 0, max_rows: 20,
      first_row_required: false, child_fields: [
        { id: 'staff', type: 'text' },
      ],
    },
    {
      id: 'equipment', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
      first_row_required: false, child_fields: [
        { id: 'serial', type: 'text', required: true, unique_across_rows: true },
        { id: 'installed', type: 'date', required: true, date_precision: 'year' },
      ],
    },
  ],
  visibility_rules: [],
});

const baseConfiguration = () => ({
  workforce_container_field_id: 'workforce',
  equipment_container_field_id: 'equipment',
  workforce_fields: { staff: 'staff_group' },
  equipment_fields: { serial: 'serial_number', installed: 'year_installed' },
  required_blank_policy: {
    existing_equipment_blank_required_field_ids: ['serial', 'installed'],
    new_equipment_required_field_ids: ['serial', 'installed'],
  },
  equipment_hidden_preserve: {},
});

function reviewedConfiguration() {
  const configuration = baseConfiguration();
  configuration.form_compatibility = buildDepartmentCurrentSetCompatibilityContract({
    form: form(), configuration,
  });
  return configuration;
}

test('compatibility accepts its reviewed projection without comparing labels or unrelated fields', () => {
  const configuration = reviewedConfiguration();
  const changedPresentation = form();
  changedPresentation.fields[1].label = 'Current equipment';
  changedPresentation.fields.push({ id: 'unrelated', type: 'text', label: 'Unrelated' });
  assert.doesNotThrow(() => assertDepartmentCurrentSetCompatibility({
    form: changedPresentation, configuration,
  }));
});

test('compatibility fails closed for mapped-field, date, bounds, and visibility drift', () => {
  const configuration = reviewedConfiguration();
  for (const mutate of [
    candidate => { candidate.fields[1].child_fields[0].type = 'textarea'; },
    candidate => { candidate.fields[1].child_fields[1].date_precision = 'day'; },
    candidate => { candidate.fields[1].max_rows = 99; },
    candidate => { candidate.fields[1].child_fields[0].row_visibility = { mode: 'show_when' }; },
    candidate => { candidate.visibility_rules = [{ action: 'hide', target_field_ids: ['serial'] }]; },
  ]) {
    const candidate = form();
    mutate(candidate);
    assert.throws(() => assertDepartmentCurrentSetCompatibility({
      form: candidate, configuration,
    }), error => error?.code === 'CURRENT_SET_CONFIGURATION_INVALID');
  }
});

test('compatibility pins the supported optional hidden-value rule and keeps core fields visible', () => {
  const candidate = form();
  candidate.fields[1].child_fields.push({
    id: 'decommissioned', type: 'date', date_precision: 'year',
    row_visibility: { mode: 'show_when', source_field_id: 'installed', value: 'No' },
  });
  const configuration = baseConfiguration();
  configuration.equipment_fields.decommissioned = 'year_decommissioned';
  configuration.equipment_hidden_preserve = {
    decommissioned: { mode: 'show_when', source_field_id: 'installed', value: 'No' },
  };
  configuration.form_compatibility = buildDepartmentCurrentSetCompatibilityContract({
    form: candidate, configuration,
  });
  assert.doesNotThrow(() => assertDepartmentCurrentSetCompatibility({
    form: candidate, configuration,
  }));

  const unsafe = structuredClone(candidate);
  unsafe.fields[1].child_fields[0].row_visibility = {
    mode: 'show_when', source_field_id: 'installed', value: 'No',
  };
  assert.throws(() => assertDepartmentCurrentSetCompatibility({
    form: unsafe, configuration,
  }), error => error?.code === 'CURRENT_SET_CONFIGURATION_INVALID');
});

test('complete prefill is blocked rather than truncated beyond its reviewed row limit', () => {
  const configuration = reviewedConfiguration();
  const contract = assertDepartmentCurrentSetCompatibility({ form: form(), configuration });
  assert.throws(() => assertDepartmentCurrentSetLoadedBounds({
    contract,
    loaded: {
      form_values: {
        workforce: [],
        equipment: Array.from({ length: 101 }, () => ({})),
      },
    },
  }), error => error?.code === 'CURRENT_SET_CONFIGURATION_INVALID'
    && /exceeds the reviewed form capacity/.test(error.message));
});