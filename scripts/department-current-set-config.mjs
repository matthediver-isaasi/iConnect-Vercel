import { createHash } from 'node:crypto';
import {
  assertDepartmentCurrentSetCompatibility,
  buildDepartmentCurrentSetCompatibilityContract,
} from '../api/_lib/departmentCurrentSetCompatibility.js';

export const CURRENT_SET_CONFIG_TABLE = 'department_current_set_config';
export const TENANT_ID = 'ff2df806-b321-4254-b651-3af11fccf1db';
export const FORM_ID = '8b6f44d3-83f8-449e-9496-b10b1dc28e5f';

export const OBJECT_IDS = Object.freeze({
  department: 'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
  workforceSurvey: '931df885-c3b7-449a-b206-eef31fb9e883',
  workforceRow: 'bf123bdb-7227-4f45-b5f9-8344d0f65446',
  equipment: 'c1ce08d4-5f28-496e-ac41-cc4d417f2f4a',
  equipmentType: '3dae6022-c7e3-4ca9-b9d8-3676cb0e2173',
  equipmentModel: '633d90fa-aa52-4d1b-9a1d-ffd0e6e9c42a',
});

export const RELATIONSHIP_IDS = Object.freeze({
  equipmentDepartment: 'a26345b6-0f4a-4d1b-a61a-bfc0a32abcfc',
  equipmentType: 'd7d2cecb-d6e3-416d-8a55-04dcc8aff621',
  equipmentModel: '0c7e461e-a518-4bf2-863a-f18d84be00d0',
  modelType: '0d97b25e-8536-469d-982c-8fd2d6908830',
  workforceDepartment: 'ab296a40-f032-4a3b-8155-108636a2cfc3',
  workforceRowSurvey: '749598f1-e2e8-4fc9-b5f4-fb5d8af53f3c',
  departmentRespondent: '0fdede92-efa2-4d84-9b16-df1a88069486',
});

export const FORM_FIELDS = Object.freeze({
  workforceContainer: 'field_1788530969408',
  workforce: Object.freeze({
    staffGroup: 'row_field_1788531041536_lih29',
    grade: 'row_field_1788531109823_jsmok',
    occupiedWte: 'row_field_1788531209745_59bsx',
    vacantWte: 'row_field_1788531232436_3rjy1',
  }),
  equipmentContainer: 'field_1789479861104',
  equipment: Object.freeze({
    type: 'row_field_1789479870791_pzi5h',
    manufacturer: 'row_field_1789479894031_n8x01',
    model: 'row_field_1789480125994_5lfxm',
    serialNumber: 'row_field_1789639793360_0h7t0',
    installationYear: 'row_field_1789483471565_28vfi',
    stillInService: 'row_field_1789639334614_fwsk0',
    decommissioningYear: 'row_field_1789483556749_2j3hp',
    additionalInformation: 'row_field_1789484050588_qhn76',
  }),
});

export const OBJECT_FIELD_NAMES = Object.freeze({
  workforceSurvey: Object.freeze({ surveyName: 'survey_name' }),
  workforceRow: Object.freeze({
    rowName: 'row_name',
    staffGroup: 'staff_group',
    grade: 'grade',
    occupiedWte: 'occupied_wte',
    vacantWte: 'vacant_wte',
    legacyVacancyReported: 'legacy_vacancy_reported',
  }),
  equipment: Object.freeze({
    serialNumber: 'serial_number',
    installationYear: 'year_installed',
    decommissioningYear: 'year_decommissioned',
    stillInService: 'still_in_service',
    additionalInformation: 'additional_information',
  }),
});

export const canonicalJson = value => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalJson(child)]));
  }
  return value;
};

export const fingerprint = value => createHash('sha256')
  .update(JSON.stringify(canonicalJson(value))).digest('hex');

export function buildDepartmentCurrentSetConfig(form) {
  const config = {
    version: 1,
    department_object_id: OBJECT_IDS.department,
    workforce_object_id: OBJECT_IDS.workforceSurvey,
    workforce_row_object_id: OBJECT_IDS.workforceRow,
    equipment_object_id: OBJECT_IDS.equipment,
    equipment_type_object_id: OBJECT_IDS.equipmentType,
    equipment_model_object_id: OBJECT_IDS.equipmentModel,
    respondent_relationship_id: RELATIONSHIP_IDS.departmentRespondent,
    respondent_field_key: 'survey_respondent',
    workforce_container_field_id: FORM_FIELDS.workforceContainer,
    equipment_container_field_id: FORM_FIELDS.equipmentContainer,
    workforce_fields: {
      [FORM_FIELDS.workforce.staffGroup]: OBJECT_FIELD_NAMES.workforceRow.staffGroup,
      [FORM_FIELDS.workforce.grade]: OBJECT_FIELD_NAMES.workforceRow.grade,
      [FORM_FIELDS.workforce.occupiedWte]: OBJECT_FIELD_NAMES.workforceRow.occupiedWte,
      [FORM_FIELDS.workforce.vacantWte]: OBJECT_FIELD_NAMES.workforceRow.vacantWte,
    },
    equipment_fields: {
      [FORM_FIELDS.equipment.type]: 'equipment_type_id',
      [FORM_FIELDS.equipment.manufacturer]: 'manufacturer',
      [FORM_FIELDS.equipment.model]: 'model_id',
      [FORM_FIELDS.equipment.serialNumber]: OBJECT_FIELD_NAMES.equipment.serialNumber,
      [FORM_FIELDS.equipment.installationYear]: OBJECT_FIELD_NAMES.equipment.installationYear,
      [FORM_FIELDS.equipment.decommissioningYear]: OBJECT_FIELD_NAMES.equipment.decommissioningYear,
      [FORM_FIELDS.equipment.stillInService]: OBJECT_FIELD_NAMES.equipment.stillInService,
      [FORM_FIELDS.equipment.additionalInformation]: OBJECT_FIELD_NAMES.equipment.additionalInformation,
    },
    required_blank_policy: {
      existing_equipment_blank_required_field_ids: [
        FORM_FIELDS.equipment.serialNumber,
        FORM_FIELDS.equipment.installationYear,
      ],
      new_equipment_required_field_ids: [
        FORM_FIELDS.equipment.serialNumber,
        FORM_FIELDS.equipment.installationYear,
      ],
    },
    // Existing decommissioning dates are intentionally hidden when the
    // respondent says the equipment remains in service. Reconciliation keeps
    // that persisted value unchanged while hidden; it never treats omission as
    // a clear. This reviewed rule is also pinned in form_compatibility.
    equipment_hidden_preserve: {
      [FORM_FIELDS.equipment.decommissioningYear]: {
        mode: 'show_when',
        source_field_id: FORM_FIELDS.equipment.stillInService,
        value: 'No',
      },
    },
    relationship_keys: {
      workforce_department: 'workforce_survey_department',
      workforce_row: 'workforce_survey_row_survey',
      equipment_department: 'equipment_register_department',
      equipment_type: 'equipment_register_type',
      equipment_model: 'equipment_register_model',
      model_type: 'equipment_model_type',
    },
    relationship_ids: {
      workforce_department: RELATIONSHIP_IDS.workforceDepartment,
      workforce_row: RELATIONSHIP_IDS.workforceRowSurvey,
      equipment_department: RELATIONSHIP_IDS.equipmentDepartment,
      equipment_type: RELATIONSHIP_IDS.equipmentType,
      equipment_model: RELATIONSHIP_IDS.equipmentModel,
      model_type: RELATIONSHIP_IDS.modelType,
    },
  };
  if (!form) return config;
  return {
    ...config,
    form_compatibility: buildDepartmentCurrentSetCompatibilityContract({ form, configuration: config }),
  };
}

export function validateCurrentSetConfig(config, form) {
  const expected = buildDepartmentCurrentSetConfig();
  const { form_compatibility: contract, ...withoutContract } = config || {};
  if (JSON.stringify(canonicalJson(withoutContract)) !== JSON.stringify(canonicalJson(expected)) || !contract) {
    return false;
  }
  try {
    if (form) assertDepartmentCurrentSetCompatibility({ form, configuration: config });
    return contract.version === 1;
  } catch {
    return false;
  }
}

export function formCurrentSetCandidate(form) {
  if (!form || !Array.isArray(form.fields)) throw new Error('Pinned form has no fields');
  const fields = structuredClone(form.fields);
  const workforce = fields.find(field => field?.id === FORM_FIELDS.workforceContainer);
  const equipment = fields.find(field => field?.id === FORM_FIELDS.equipmentContainer);
  if (!workforce || workforce.type !== 'repeatable_rows') throw new Error('Workforce container drifted');
  if (!equipment || equipment.type !== 'repeatable_rows') throw new Error('Equipment container drifted');
  const actualChildren = equipment.child_fields || [];
  for (const [name, id] of Object.entries(FORM_FIELDS.equipment)) {
    if (!actualChildren.some(child => child?.id === id)) throw new Error(`Equipment ${name} field drifted`);
  }
  for (const id of [FORM_FIELDS.equipment.installationYear, FORM_FIELDS.equipment.decommissioningYear]) {
    const field = actualChildren.find(child => child.id === id);
    if (field.type !== 'date' || field.date_precision !== 'year') {
      throw new Error(`Equipment date field ${id} is not a year-only date`);
    }
  }
  // The schema supports at most 100 repeatable rows.  Raising only this
  // container limit preserves all user-authored fields and workflow settings.
  equipment.max_rows = 100;
  return { ...form, fields };
}