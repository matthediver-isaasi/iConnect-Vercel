import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FORM_FIELDS, OBJECT_IDS, RELATIONSHIP_IDS, buildDepartmentCurrentSetConfig,
  fingerprint, formCurrentSetCandidate, synchronizeWorkforceDropdownOptions, validateCurrentSetConfig,
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
    equipment_department: RELATIONSHIP_IDS.equipmentDepartment,
    equipment_type: RELATIONSHIP_IDS.equipmentType,
    equipment_model: RELATIONSHIP_IDS.equipmentModel,
    model_type: RELATIONSHIP_IDS.modelType,
  });
  assert.equal(config.relationship_keys.model_type, 'equipment_model_type');
  assert.equal(config.version, 2);
  assert.equal(Object.hasOwn(config, 'workforce_object_id'), false);
  assert.equal(Object.hasOwn(config.relationship_ids, 'workforce_row'), false);
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

test('direct config has no workforce survey parent pins', () => {
  const config = buildDepartmentCurrentSetConfig(formCurrentSetCandidate(minimalForm()));
  assert.equal(Object.hasOwn(OBJECT_IDS, 'workforceSurvey'), false);
  assert.equal(Object.hasOwn(config, 'workforce_object_id'), false);
  assert.equal(Object.hasOwn(config.relationship_keys, 'workforce_row'), false);
  assert.equal(config.relationship_keys.workforce_department, 'workforce_survey_row_department');
});

test('candidate raises both current-set capacities to the supported maximum', () => {
  const form = minimalForm();
  form.fields[0].min_rows = 0;
  form.fields[0].first_row_required = false;
  form.fields[1].min_rows = 0;
  form.fields[1].first_row_required = false;
  const candidate = formCurrentSetCandidate(form);
  assert.equal(candidate.fields[0].max_rows, 100);
  assert.equal(candidate.fields[1].max_rows, 100);
  assert.equal(form.fields[0].max_rows, 20);
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

test('candidate refuses to silently reduce an already unsupported repeatable capacity', () => {
  const form = minimalForm();
  form.fields[0].max_rows = 101;
  assert.throws(() => formCurrentSetCandidate(form), /exceeds the supported maximum/);
});

test('live Workforce form shape syncs only canonical saved values while retaining displayed labels and order', () => {
  const form = minimalForm();
  const workforce = form.fields[0];
  workforce.child_fields[0] = {
    id: FORM_FIELDS.workforce.staffGroup, type: 'select', label: 'Staff group',
    options: ['Administrator/Clerical', 'Apprentice Clinical Technologist', 'Assistant Practitioner',
      'Clinical Practitioner – Radiographer', 'Clinical Practitioner – Technologist', 'Clinical Scientist',
      'HCA/Imaging Assistant', 'Nurse', 'Physician', 'Radiologist'],
  };
  workforce.child_fields[1] = {
    id: FORM_FIELDS.workforce.grade, type: 'select', label: 'Grade',
    options: ['Band 1', 'Band 2', 'Band 3', 'Band 4', 'Band 5', 'Band 6', 'Band 7',
      'Band 8a', 'Band 8b', 'Band 8c', 'Band 8d', 'Band 9', 'Apprentice'],
  };
  const canonicalFields = [
    {
      name: 'staff_group', field_type: 'dropdown', options: [
        { label: 'Administrator/Clerical', value: 'Administrator/Clerical' },
        { label: 'Apprentice Clinical Technologist', value: 'Apprentice Clinical Technologist' },
        { label: 'Assistant Practitioner ', value: 'Assistant Practitioner ' },
        { label: 'Clinical Practitioner – Radiographer', value: 'Clinical Practitioner – Radiographer ' },
        { label: 'Clinical Practitioner – Technologist', value: 'Clinical Practitioner – Technologist ' },
        { label: 'Clinical Scientist', value: 'Clinical Scientist' },
        { label: 'HCA/Imaging Assistant', value: 'HCA/Imaging Assistant' },
        { label: 'Nurse', value: 'Nurse' }, { label: 'Physician', value: 'Physician' },
        { label: 'Radiologist', value: 'Radiologist' },
      ],
    },
    {
      name: 'grade', field_type: 'dropdown', options: [
        ...['Band 1', 'Band 2', 'Band 3', 'Band 4', 'Band 5', 'Band 6', 'Band 7',
          'Band 8a', 'Band 8b', 'Band 8c', 'Band 9', 'Apprentice', 'Consultant',
          'Consultant – dual accredited', 'Registrar/Specialty trainee']
          .map(value => ({ label: value, value })),
        { label: 'Fellow', value: 'Fellow ' },
        ...['Other medical grade', 'Not applicable', 'Radionuclide Radiologist', 'Band 8d']
          .map(value => ({ label: value, value })),
      ],
    },
  ];
  const candidate = formCurrentSetCandidate(form, { canonicalFields });
  const [staff, grade] = candidate.fields[0].child_fields;
  assert.deepEqual(staff.options.slice(0, 5), [
    'Administrator/Clerical',
    'Apprentice Clinical Technologist',
    { label: 'Assistant Practitioner', value: 'Assistant Practitioner ' },
    { label: 'Clinical Practitioner – Radiographer', value: 'Clinical Practitioner – Radiographer ' },
    { label: 'Clinical Practitioner – Technologist', value: 'Clinical Practitioner – Technologist ' },
  ]);
  assert.deepEqual(grade.options.slice(0, 13), form.fields[0].child_fields[1].options);
  assert.deepEqual(grade.options.slice(13), [
    { label: 'Consultant', value: 'Consultant' },
    { label: 'Consultant – dual accredited', value: 'Consultant – dual accredited' },
    { label: 'Registrar/Specialty trainee', value: 'Registrar/Specialty trainee' },
    { label: 'Fellow', value: 'Fellow ' },
    { label: 'Other medical grade', value: 'Other medical grade' },
    { label: 'Not applicable', value: 'Not applicable' },
    { label: 'Radionuclide Radiologist', value: 'Radionuclide Radiologist' },
  ]);
  assert.deepEqual(candidate.workforceDropdownChanges.map(change => change.field_name), ['staff_group', 'grade']);
  assert.equal(candidate.workforceDropdownChanges[0].canonicalized_existing_values.length, 3);
  assert.deepEqual(candidate.workforceDropdownChanges[0].canonicalized_existing_values.map(change => change.match),
    ['trailing_whitespace_only', 'exact_display_label', 'exact_display_label']);
  assert.equal(candidate.workforceDropdownChanges[1].appended_canonical_values.length, 7);
});

test('workforce form option sync rejects ambiguous canonical values rather than normalizing them', () => {
  const form = minimalForm();
  form.fields[0].child_fields[0] = {
    id: FORM_FIELDS.workforce.staffGroup, type: 'select', options: ['A'],
  };
  assert.throws(() => synchronizeWorkforceDropdownOptions(form, [{
    name: 'staff_group', field_type: 'dropdown',
    options: [{ label: 'A', value: 'A' }, { label: 'A duplicate', value: 'A' }],
  }]), /values are ambiguous/);
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