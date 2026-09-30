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

function jsonbRoundTrip(value) {
  const reorderKeys = candidate => {
    if (Array.isArray(candidate)) return candidate.map(reorderKeys);
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, reorderKeys(child)]));
    }
    return candidate;
  };
  return JSON.parse(JSON.stringify(reorderKeys(value)));
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

test('compatibility accepts a JSONB-style reordered config but still rejects meaningful contract drift', () => {
  const configuration = reviewedConfiguration();
  const persisted = jsonbRoundTrip(configuration);
  assert.doesNotThrow(() => assertDepartmentCurrentSetCompatibility({
    form: jsonbRoundTrip(form()), configuration: persisted,
  }));

  persisted.form_compatibility.containers.equipment.max_rows += 1;
  assert.throws(() => assertDepartmentCurrentSetCompatibility({
    form: jsonbRoundTrip(form()), configuration: persisted,
  }), error => error?.code === 'CURRENT_SET_CONFIGURATION_INVALID');
});

test('compatibility accepts the live BNMS mapping order after a JSONB roundtrip', () => {
  const liveForm = {
    fields: [
      {
        id: 'field_1788530969408', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
        first_row_required: false, child_fields: [
          { id: 'row_field_1788531041536_lih29', type: 'select' },
          { id: 'row_field_1788531109823_jsmok', type: 'select' },
          { id: 'row_field_1788531209745_59bsx', type: 'number' },
          { id: 'row_field_1788531232436_3rjy1', type: 'number' },
        ],
      },
      {
        id: 'field_1789479861104', type: 'repeatable_rows', min_rows: 0, max_rows: 100,
        first_row_required: false, child_fields: [
          { id: 'row_field_1789479870791_pzi5h', type: 'relationship_dropdown' },
          { id: 'row_field_1789479894031_n8x01', type: 'relationship_dropdown' },
          { id: 'row_field_1789480125994_5lfxm', type: 'relationship_dropdown' },
          { id: 'row_field_1789639793360_0h7t0', type: 'text', required: true },
          { id: 'row_field_1789483471565_28vfi', type: 'date', required: true, date_precision: 'year' },
          { id: 'row_field_1789639334614_fwsk0', type: 'select' },
          {
            id: 'row_field_1789483556749_2j3hp', type: 'date', date_precision: 'year',
            row_visibility: {
              mode: 'show_when', source_field_id: 'row_field_1789639334614_fwsk0', value: 'No',
            },
          },
          { id: 'row_field_1789484050588_qhn76', type: 'textarea' },
        ],
      },
    ],
    visibility_rules: [],
  };
  const liveConfiguration = {
    workforce_container_field_id: 'field_1788530969408',
    equipment_container_field_id: 'field_1789479861104',
    workforce_fields: {
      row_field_1788531041536_lih29: 'staff_group',
      row_field_1788531109823_jsmok: 'grade',
      row_field_1788531209745_59bsx: 'occupied_wte',
      row_field_1788531232436_3rjy1: 'vacant_wte',
    },
    equipment_fields: {
      row_field_1789479870791_pzi5h: 'equipment_type_id',
      row_field_1789479894031_n8x01: 'manufacturer',
      row_field_1789480125994_5lfxm: 'model_id',
      row_field_1789639793360_0h7t0: 'serial_number',
      row_field_1789483471565_28vfi: 'year_installed',
      row_field_1789483556749_2j3hp: 'year_decommissioned',
      row_field_1789639334614_fwsk0: 'still_in_service',
      row_field_1789484050588_qhn76: 'additional_information',
    },
    required_blank_policy: {
      existing_equipment_blank_required_field_ids: ['row_field_1789639793360_0h7t0', 'row_field_1789483471565_28vfi'],
      new_equipment_required_field_ids: ['row_field_1789639793360_0h7t0', 'row_field_1789483471565_28vfi'],
    },
    equipment_hidden_preserve: {
      row_field_1789483556749_2j3hp: {
        mode: 'show_when', source_field_id: 'row_field_1789639334614_fwsk0', value: 'No',
      },
    },
  };
  liveConfiguration.form_compatibility = buildDepartmentCurrentSetCompatibilityContract({
    form: liveForm, configuration: liveConfiguration,
  });
  const persisted = jsonbRoundTrip(liveConfiguration);
  assert.doesNotThrow(() => assertDepartmentCurrentSetCompatibility({
    form: liveForm, configuration: persisted,
  }));
  persisted.form_compatibility.containers.equipment.children
    .find(child => child.id === 'row_field_1789483471565_28vfi').required = false;
  assert.throws(() => assertDepartmentCurrentSetCompatibility({
    form: liveForm, configuration: persisted,
  }), error => error?.code === 'CURRENT_SET_CONFIGURATION_INVALID');
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