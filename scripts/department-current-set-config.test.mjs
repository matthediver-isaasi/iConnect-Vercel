import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORM_FIELDS, OBJECT_IDS, RELATIONSHIP_IDS, buildDepartmentCurrentSetConfig,
  fingerprint, formCurrentSetCandidate, validateCurrentSetConfig,
} from './department-current-set-config.mjs';

const minimalForm = () => ({
  fields: [
    {
      id: FORM_FIELDS.workforceContainer, type: 'repeatable_rows', min_rows: 0,
      first_row_required: false, max_rows: 20,
      child_fields: [
        { id: FORM_FIELDS.workforce.staffGroup, type: 'text' },
        { id: FORM_FIELDS.workforce.grade, type: 'text' },
        { id: FORM_FIELDS.workforce.occupiedWte, type: 'number' },
        { id: FORM_FIELDS.workforce.vacantWte, type: 'number' },
      ],
    },
    {
      id: FORM_FIELDS.equipmentContainer,
      type: 'repeatable_rows',
      min_rows: 0,
      first_row_required: false,
      max_rows: 30,
      child_fields: [
        { id: FORM_FIELDS.equipment.type, type: 'relationship_dropdown' },
        { id: FORM_FIELDS.equipment.manufacturer, type: 'relationship_dropdown' },
        { id: FORM_FIELDS.equipment.model, type: 'relationship_dropdown' },
        { id: FORM_FIELDS.equipment.serialNumber, type: 'text', required: true, unique_across_rows: true },
        { id: FORM_FIELDS.equipment.installationYear, type: 'date', date_precision: 'year', required: true },
        { id: FORM_FIELDS.equipment.stillInService, type: 'select' },
        {
          id: FORM_FIELDS.equipment.decommissioningYear, type: 'date', date_precision: 'year',
          row_visibility: {
            mode: 'show_when',
            source_field_id: FORM_FIELDS.equipment.stillInService,
            value: 'No',
          },
        },
        { id: FORM_FIELDS.equipment.additionalInformation, type: 'textarea' },
      ],
    },
  ],
});

test('pinned configuration maps exactly the approved objects, form fields, and respondent edge', () => {
  const config = buildDepartmentCurrentSetConfig(formCurrentSetCandidate(minimalForm()));
  assert.equal(config.department_object_id, OBJECT_IDS.department);
  assert.equal(config.respondent_relationship_id, RELATIONSHIP_IDS.departmentRespondent);
  assert.equal(config.respondent_field_key, 'survey_respondent');
  assert.equal(config.equipment_fields[FORM_FIELDS.equipment.installationYear], 'year_installed');
  assert.equal(config.equipment_fields[FORM_FIELDS.equipment.decommissioningYear], 'year_decommissioned');
  assert.deepEqual(config.relationship_ids, {
    workforce_department: RELATIONSHIP_IDS.workforceDepartment,
    workforce_row: RELATIONSHIP_IDS.workforceRowSurvey,
    equipment_department: RELATIONSHIP_IDS.equipmentDepartment,
    equipment_type: RELATIONSHIP_IDS.equipmentType,
    equipment_model: RELATIONSHIP_IDS.equipmentModel,
    model_type: RELATIONSHIP_IDS.modelType,
  });
  assert.equal(config.relationship_keys.model_type, 'equipment_model_type');
  assert.equal(validateCurrentSetConfig(config, formCurrentSetCandidate(minimalForm())), true);
  const missingPins = structuredClone(config);
  delete missingPins.relationship_ids;
  assert.equal(validateCurrentSetConfig(missingPins), false);
});

test('config maps only respondent-editable form answers and preserves unmapped workforce provenance fields', () => {
  const config = buildDepartmentCurrentSetConfig(formCurrentSetCandidate(minimalForm()));
  assert.deepEqual(config.workforce_fields, {
    [FORM_FIELDS.workforce.staffGroup]: 'staff_group',
    [FORM_FIELDS.workforce.grade]: 'grade',
    [FORM_FIELDS.workforce.occupiedWte]: 'occupied_wte',
    [FORM_FIELDS.workforce.vacantWte]: 'vacant_wte',
  });
  assert.equal(Object.values(config.workforce_fields).includes('row_name'), false);
  assert.equal(Object.values(config.workforce_fields).includes('legacy_vacancy_reported'), false);
  assert.equal(config.equipment_fields[FORM_FIELDS.equipment.serialNumber], 'serial_number');
  assert.equal(config.equipment_fields[FORM_FIELDS.equipment.installationYear], 'year_installed');
  assert.equal(config.equipment_fields[FORM_FIELDS.equipment.decommissioningYear], 'year_decommissioned');
});

test('candidate raises only the equipment capacity to the supported maximum', () => {
  const form = minimalForm();
  form.fields[0].min_rows = 0;
  form.fields[0].first_row_required = false;
  form.fields[1].min_rows = 0;
  form.fields[1].first_row_required = false;
  const candidate = formCurrentSetCandidate(form);
  assert.equal(candidate.fields[1].max_rows, 100);
  assert.equal(form.fields[1].max_rows, 30);
  assert.deepEqual(candidate.fields[1].child_fields, form.fields[1].child_fields);
  assert.equal(candidate.fields[0].min_rows, 0);
  assert.equal(candidate.fields[0].first_row_required, false);
  assert.equal(candidate.fields[1].min_rows, 0);
  assert.equal(candidate.fields[1].first_row_required, false);
});

test('candidate fails closed if either user-owned date field is not year-only', () => {
  const form = minimalForm();
  form.fields[1].child_fields[4].date_precision = 'day';
  assert.throws(() => formCurrentSetCandidate(form), /not a year-only date/);
});

test('saved compatibility projection rejects mapped type, bounds, and visibility drift', () => {
  const candidate = formCurrentSetCandidate(minimalForm());
  const config = buildDepartmentCurrentSetConfig(candidate);
  assert.equal(validateCurrentSetConfig(config, candidate), true);

  const wrongType = structuredClone(candidate);
  wrongType.fields[1].child_fields[0].type = 'text';
  assert.equal(validateCurrentSetConfig(config, wrongType), false);

  const wrongBounds = structuredClone(candidate);
  wrongBounds.fields[1].max_rows = 99;
  assert.equal(validateCurrentSetConfig(config, wrongBounds), false);

  const hiddenChild = structuredClone(candidate);
  hiddenChild.fields[1].child_fields[0].row_visibility = {
    mode: 'show_when', source_field_id: FORM_FIELDS.equipment.manufacturer, value: 'Acme',
  };
  assert.equal(validateCurrentSetConfig(config, hiddenChild), false);
});

test('fingerprints are key-order independent and change when the reviewed scope changes', () => {
  assert.equal(fingerprint({ a: 1, b: { z: 2, y: 3 } }), fingerprint({ b: { y: 3, z: 2 }, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});