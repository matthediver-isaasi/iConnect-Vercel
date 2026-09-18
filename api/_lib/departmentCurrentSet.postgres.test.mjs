import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// This test uses a disposable, local PostgreSQL cluster. It deliberately does
// not accept DEST/DEV_DATABASE_URL: current-set reconciliation is destructive,
// and the only safe integration test target is a fresh database.
const migration = fileURLToPath(new URL(
  '../../supabase/migrations/20261101_department_current_set.sql',
  import.meta.url,
));
const relationshipValuesMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261001_custom_object_relationship_values.sql',
  import.meta.url,
));
const authMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261102_department_current_set_auth.sql',
  import.meta.url,
));
const directWorkforceMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261103_department_current_set_direct_workforce.sql',
  import.meta.url,
));
const departmentOrganisationAuthMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261104_department_current_set_department_organisation_auth.sql',
  import.meta.url,
));
const departmentAssignmentAuthMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261105_department_current_set_assignment_auth.sql',
  import.meta.url,
));
const surveyStampMigration = fileURLToPath(new URL(
  '../../supabase/migrations/20261106_department_current_set_survey_stamp.sql',
  import.meta.url,
));

const executable = name => spawnSync('sh', ['-c', `command -v ${name}`], {
  encoding: 'utf8',
}).stdout.trim();

function run(command, args, input = '') {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function fails(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(result.status, 0, 'expected SQL to fail');
  return `${result.stdout}\n${result.stderr}`;
}

function runAsync(command, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

const ID = Object.freeze({
  // These are destination pins enforced by the migration. They remain safe in
  // this isolated initdb cluster and never identify a database connection.
  tenant: 'ff2df806-b321-4254-b651-3af11fccf1db',
  form: '8b6f44d3-83f8-449e-9496-b10b1dc28e5f',
  otherForm: '10000000-0000-4000-8000-000000000009',
  department: '10000000-0000-4000-8000-000000000003',
  otherDepartment: '10000000-0000-4000-8000-000000000004',
  member: '10000000-0000-4000-8000-000000000005',
  otherMember: '10000000-0000-4000-8000-000000000006',
  organization: '10000000-0000-4000-8000-000000000007',
  otherOrganization: '10000000-0000-4000-8000-000000000050',
  role: '10000000-0000-4000-8000-000000000008',
  group: '10000000-0000-4000-8000-000000000009',
  session: 'current-set-session',
  otherSession: 'other-current-set-session',
  departmentObject: 'cd1ebfd3-3e16-4091-be5a-99992d926f2f',
  surveyObject: '10000000-0000-4000-8000-000000000011',
  rowObject: '10000000-0000-4000-8000-000000000012',
  equipmentObject: '10000000-0000-4000-8000-000000000013',
  typeObject: '10000000-0000-4000-8000-000000000014',
  modelObject: '10000000-0000-4000-8000-000000000015',
  survey: '10000000-0000-4000-8000-000000000020',
  workforceRow: '10000000-0000-4000-8000-000000000021',
  equipment: '10000000-0000-4000-8000-000000000022',
  foreignEquipment: '10000000-0000-4000-8000-000000000023',
  type: '10000000-0000-4000-8000-000000000024',
  model: '10000000-0000-4000-8000-000000000025',
  foreignType: '10000000-0000-4000-8000-000000000026',
  subOne: '10000000-0000-4000-8000-000000000030',
  subTwo: '10000000-0000-4000-8000-000000000031',
  subBad: '10000000-0000-4000-8000-000000000032',
  subThree: '10000000-0000-4000-8000-000000000033',
  subFour: '10000000-0000-4000-8000-000000000034',
  subFive: '10000000-0000-4000-8000-000000000035',
  subSix: '10000000-0000-4000-8000-000000000036',
  subSeven: '10000000-0000-4000-8000-000000000037',
  subStampOne: '10000000-0000-4000-8000-000000000038',
  subStampTwo: '10000000-0000-4000-8000-000000000039',
  subStampThree: '10000000-0000-4000-8000-000000000052',
  respondent: '10000000-0000-4000-8000-000000000040',
  surveyDepartment: '10000000-0000-4000-8000-000000000041',
  rowSurvey: '10000000-0000-4000-8000-000000000042',
  equipmentDepartment: '10000000-0000-4000-8000-000000000043',
  equipmentType: '10000000-0000-4000-8000-000000000044',
  equipmentModel: '10000000-0000-4000-8000-000000000045',
  modelType: '10000000-0000-4000-8000-000000000046',
  staffGroupField: '10000000-0000-4000-8000-000000000047',
  gradeField: '10000000-0000-4000-8000-000000000048',
  rowNameField: '10000000-0000-4000-8000-000000000049',
  departmentOrganization: '10000000-0000-4000-8000-000000000051',
  surveyLastUpdatedField: 'c5dcd16c-e63e-49f2-b72f-b0caaa7c5903',
  foreignTenant: '20000000-0000-4000-8000-000000000001',
  foreignObject: '20000000-0000-4000-8000-000000000002',
  foreignDepartment: '20000000-0000-4000-8000-000000000003',
});

const q = value => `'${String(value).replaceAll("'", "''")}'`;

function sqlCall(submissionId, payloadSql, expectedVersionSql = null) {
  const version = expectedVersionSql || `(SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid, ${q(ID.form)}::uuid, ${q(ID.department)}::uuid, ${q(ID.member)}::uuid, ${q(ID.session)})->>'version')`;
  return `
    UPDATE form_submission SET submission_data = ${payloadSql} WHERE id = ${q(submissionId)}::uuid;
    SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid, ${q(ID.form)}::uuid, ${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid, ${q(submissionId)}::uuid, ${version}, ${q(ID.session)},
      (SELECT submission_data FROM form_submission WHERE id=${q(submissionId)}::uuid)
    )::text;
  `;
}

function payload({ workforce = "'[]'::jsonb", equipment = "'[]'::jsonb" } = {}) {
  return `jsonb_build_object(
    'wf', ${workforce},
    'eq', ${equipment},
    '__department_current_set', jsonb_build_object(
      'department_id', ${q(ID.department)},
      'version', department_current_set_load_authenticated(${q(ID.tenant)}::uuid, ${q(ID.form)}::uuid, ${q(ID.department)}::uuid, ${q(ID.member)}::uuid, ${q(ID.session)})->>'version',
      'complete_sections', jsonb_build_array('wf', 'eq')
    )
  )`;
}

// JavaScript cannot put the SQL cast used above in a default safely; this
// produces a canonical payload with both arrays present.
function completePayload(workforce = "'[]'::jsonb", equipment = "'[]'::jsonb") {
  return payload({ workforce, equipment });
}

function currentPayload() {
  return `(SELECT value->'form_values' FROM (
    SELECT department_current_set_load_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.session)}
    ) AS value
  ) loaded)`;
}

// Re-submit the current complete set while changing only the selected
// equipment's controlling/hidden fields. This mirrors a repeatable-row
// renderer: all other server-loaded row values are retained.
function currentEquipmentPayload({ service, decommissioned, omitDecommissioned = false }) {
  const changed = omitDecommissioned
    ? `(item - 'decommissioned') || jsonb_build_object('service', ${q(service)})`
    : `item || jsonb_build_object('service', ${q(service)}, 'decommissioned', ${q(decommissioned)})`;
  return `(
    WITH current_set AS (
      SELECT department_current_set_load_authenticated(
        ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)}
      ) AS value
    )
    SELECT jsonb_build_object(
      'wf', value->'form_values'->'wf',
      'eq', (SELECT jsonb_agg(
        CASE WHEN item->>'_row_id' = 'existing:${ID.equipment}' THEN ${changed} ELSE item END
        ORDER BY ordinal
      ) FROM jsonb_array_elements(value->'form_values'->'eq') WITH ORDINALITY AS rows(item, ordinal)),
      '__department_current_set', value->'form_values'->'__department_current_set'
    ) FROM current_set
  )`;
}

function fixtureSql() {
  const obj = (id, key) => `INSERT INTO custom_object_definition
    (id,tenant_id,object_key,singular_label,plural_label,status)
    VALUES (${q(id)},${q(ID.tenant)},${q(key)},${q(key)},${q(`${key}s`)},'active');`;
  const definition = (id, key, sourceKind, sourceObject, targetKind, targetObject,
    configuration = "'{}'::jsonb", cardinality = 'many_to_many', required = false) => `
    INSERT INTO custom_object_relationship_definition
      (id,tenant_id,relationship_key,source_kind,source_custom_object_id,target_kind,target_custom_object_id,
       cardinality,source_label,target_label,is_required,status,configuration)
    VALUES (${q(id)},${q(ID.tenant)},${q(key)},${q(sourceKind)},${sourceObject ? q(sourceObject) : 'NULL'},
      ${q(targetKind)},${targetObject ? q(targetObject) : 'NULL'},${q(cardinality)},'source','target',${required},'active',${configuration});`;
  return `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE tenant (id uuid PRIMARY KEY);
    CREATE TABLE organization (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), member_login_blocked boolean NOT NULL DEFAULT false,
      member_login_revocation_generation bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE role (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id));
    CREATE TABLE member (
      id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenant(id), organization_id uuid REFERENCES organization(id),
      role_id uuid, login_enabled boolean NOT NULL DEFAULT true, membership_paused boolean NOT NULL DEFAULT false, email text
    );
    CREATE TABLE session (sid text PRIMARY KEY, sess text NOT NULL, expire timestamptz NOT NULL);
    CREATE TABLE member_group (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), is_active boolean NOT NULL DEFAULT true,
      roles jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE member_group_assignment (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
      group_id uuid NOT NULL REFERENCES member_group(id), member_id uuid NOT NULL, group_role text, expires_at timestamptz
    );
    CREATE TABLE member_login_session_revocation (
      member_id text PRIMARY KEY, tenant_id uuid, generation bigint NOT NULL DEFAULT 0
    );
    CREATE TABLE system_settings (
      tenant_id uuid NOT NULL REFERENCES tenant(id), setting_key text NOT NULL, setting_value jsonb,
      PRIMARY KEY (tenant_id, setting_key)
    );
    CREATE OR REPLACE FUNCTION organisation_login_gate_transaction_lock(p_tenant_id text, p_exclusive boolean)
    RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
    CREATE OR REPLACE FUNCTION organisation_login_gate_config(p_value jsonb)
    RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT $1 $$;
    CREATE OR REPLACE FUNCTION organisation_login_gate_allows(p_config jsonb, p_organization jsonb, p_organization_id text)
    RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
    CREATE TABLE form (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), is_active boolean NOT NULL DEFAULT true,
      require_authentication boolean NOT NULL DEFAULT true, access_policy jsonb, fields jsonb NOT NULL DEFAULT '[]'::jsonb,
      deactivate_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE form_submission (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), form_id uuid NOT NULL REFERENCES form(id),
      submission_data jsonb NOT NULL DEFAULT '{}'::jsonb, created_member_id uuid, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE preference_field (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
      custom_object_id uuid, entity_scope text NOT NULL DEFAULT 'member',
      name text NOT NULL, field_type text NOT NULL DEFAULT 'text',
      is_active boolean NOT NULL DEFAULT true, is_required boolean NOT NULL DEFAULT false,
      options jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE custom_object_definition (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), object_key text NOT NULL,
      singular_label text NOT NULL, plural_label text NOT NULL, primary_display_field_id uuid,
      status text NOT NULL, configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
      UNIQUE (tenant_id,id), UNIQUE (tenant_id,object_key)
    );
    CREATE TABLE custom_object_record (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
      custom_object_id uuid NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb, created_by text, updated_by text,
      archived_at timestamptz, archived_by text, archive_reason text, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id,id),
      CHECK (jsonb_typeof(data) = 'object')
    );
    -- Production's shared record validator owns the audit timestamp. Keep that
    -- BEFORE-trigger behavior in this disposable fixture so the stamp RPC
    -- cannot assume its requested clock instant survives unchanged.
    CREATE FUNCTION validate_custom_object_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END $$;
    CREATE TRIGGER validate_custom_object_record
      BEFORE INSERT OR UPDATE ON custom_object_record
      FOR EACH ROW EXECUTE FUNCTION validate_custom_object_record();
    CREATE TABLE custom_object_relationship_definition (
      id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), relationship_key text NOT NULL,
      source_kind text NOT NULL, source_custom_object_id uuid, target_kind text NOT NULL, target_custom_object_id uuid,
      cardinality text NOT NULL, source_label text NOT NULL, target_label text NOT NULL, is_required boolean NOT NULL DEFAULT false,
      show_on_source boolean NOT NULL DEFAULT true, show_on_target boolean NOT NULL DEFAULT true,
      edit_from_source boolean NOT NULL DEFAULT true, edit_from_target boolean NOT NULL DEFAULT true,
      status text NOT NULL, configuration jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE (tenant_id,id), UNIQUE (tenant_id,relationship_key)
    );
    CREATE TABLE custom_object_relationship (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenant(id),
      relationship_definition_id uuid NOT NULL, source_record_id uuid NOT NULL, target_record_id uuid NOT NULL,
      created_by text, archived_at timestamptz, archived_by text, created_at timestamptz NOT NULL DEFAULT now(),
      field_values jsonb NOT NULL DEFAULT '{}'::jsonb, updated_by text, updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (jsonb_typeof(field_values) = 'object')
    );
    INSERT INTO tenant VALUES (${q(ID.tenant)}), (${q(ID.foreignTenant)});
    INSERT INTO organization (id,tenant_id) VALUES
      (${q(ID.organization)},${q(ID.tenant)}),
      (${q(ID.otherOrganization)},${q(ID.tenant)});
    INSERT INTO role (id,tenant_id) VALUES (${q(ID.role)},${q(ID.tenant)});
    INSERT INTO member (id,tenant_id,organization_id,role_id) VALUES (${q(ID.member)},${q(ID.tenant)},${q(ID.organization)},${q(ID.role)});
    INSERT INTO member (id,tenant_id,organization_id,role_id) VALUES (${q(ID.otherMember)},${q(ID.tenant)},${q(ID.organization)},${q(ID.role)});
    INSERT INTO session VALUES (${q(ID.session)}, ${q(JSON.stringify({ memberId: ID.member, tenantId: ID.tenant }))}, now() + interval '1 hour');
    INSERT INTO session VALUES (${q(ID.otherSession)}, ${q(JSON.stringify({ memberId: ID.otherMember, tenantId: ID.tenant }))}, now() + interval '1 hour');
    INSERT INTO form (id,tenant_id,fields) VALUES (${q(ID.form)},${q(ID.tenant)},'[{"id":"wf"},{"id":"eq"}]');
    ${obj(ID.departmentObject, 'org_department')} ${obj(ID.surveyObject, 'survey')} ${obj(ID.rowObject, 'workforce_row')}
    ${obj(ID.equipmentObject, 'equipment')} ${obj(ID.typeObject, 'equipment_type')} ${obj(ID.modelObject, 'equipment_model')}
    INSERT INTO custom_object_definition
      (id,tenant_id,object_key,singular_label,plural_label,status)
      VALUES (${q(ID.foreignObject)},${q(ID.foreignTenant)},'org_department','Foreign Department','Foreign Departments','active');
    INSERT INTO preference_field (id,tenant_id,custom_object_id,entity_scope,name,field_type,is_active,is_required,options) VALUES
      (${q(ID.surveyLastUpdatedField)},${q(ID.tenant)},${q(ID.departmentObject)},'custom_object','survey_last_updated','date',true,false,'[]'),
      (${q(ID.staffGroupField)},${q(ID.tenant)},${q(ID.rowObject)},'custom_object','staff_group','dropdown',true,true,
        '["Clinical Practitioner – Technologist ","Nurse","Radiographer"]'),
      (${q(ID.gradeField)},${q(ID.tenant)},${q(ID.rowObject)},'custom_object','grade','dropdown',true,true,
        '["Band 5","Band 6","Band 7","Band 8a"]'),
      (${q(ID.rowNameField)},${q(ID.tenant)},${q(ID.rowObject)},'custom_object','row_name','text',false,true,'[]');
    UPDATE custom_object_definition SET primary_display_field_id=${q(ID.staffGroupField)}::uuid
      WHERE id=${q(ID.rowObject)}::uuid;
    ${definition(ID.respondent, 'members', 'custom_object', ID.departmentObject, 'member', null,
      `'{"relationship_fields":[{"key":"survey_respondent","type":"boolean","default_value":false}]}'::jsonb`)}
    ${definition(ID.departmentOrganization, 'organisation', 'custom_object', ID.departmentObject, 'organization', null, "'{}'::jsonb", 'many_to_one', true)}
    ${definition(ID.surveyDepartment, 'retired_workforce_survey_department', 'custom_object', ID.surveyObject, 'custom_object', ID.departmentObject)}
    ${definition(ID.rowSurvey, 'workforce_survey_row_department', 'custom_object', ID.rowObject, 'custom_object', ID.departmentObject, "'{}'::jsonb", 'many_to_one', true)}
    ${definition(ID.equipmentDepartment, 'equipment_register_department', 'custom_object', ID.equipmentObject, 'custom_object', ID.departmentObject)}
    ${definition(ID.equipmentType, 'equipment_register_type', 'custom_object', ID.equipmentObject, 'custom_object', ID.typeObject)}
    ${definition(ID.equipmentModel, 'equipment_register_model', 'custom_object', ID.equipmentObject, 'custom_object', ID.modelObject)}
    ${definition(ID.modelType, 'model_type', 'custom_object', ID.modelObject, 'custom_object', ID.typeObject)}
    INSERT INTO custom_object_record (id,tenant_id,custom_object_id,data) VALUES
      (${q(ID.department)},${q(ID.tenant)},${q(ID.departmentObject)},'{"name":"North","unrelated":{"preserve":true},"legacy_code":"N-1"}'),
      (${q(ID.otherDepartment)},${q(ID.tenant)},${q(ID.departmentObject)},'{"name":"South"}'),
      (${q(ID.foreignDepartment)},${q(ID.foreignTenant)},${q(ID.foreignObject)},'{"name":"Foreign","survey_last_updated":"1999-12-31"}'),
      (${q(ID.survey)},${q(ID.tenant)},${q(ID.surveyObject)},'{"survey_name":"Current workforce"}'),
      (${q(ID.workforceRow)},${q(ID.tenant)},${q(ID.rowObject)},'{"row_name":"Original","staff_group":"Clinical Practitioner – Technologist ","grade":"Band 7","occupied_wte":0,"vacant_wte":1,"legacy_vacancy_reported":"Unknown"}'),
       (${q(ID.equipment)},${q(ID.tenant)},${q(ID.equipmentObject)},'{"still_in_service":"Yes","year_decommissioned":2018,"additional_information":"legacy"}'),
      (${q(ID.foreignEquipment)},${q(ID.tenant)},${q(ID.equipmentObject)},'{"serial_number":"FOREIGN","year_installed":2020}'),
      (${q(ID.type)},${q(ID.tenant)},${q(ID.typeObject)},'{"name":"Gamma"}'),
      (${q(ID.foreignType)},${q(ID.tenant)},${q(ID.typeObject)},'{"name":"Wrong"}'),
      (${q(ID.model)},${q(ID.tenant)},${q(ID.modelObject)},'{"name":"GX","manufacturer":"Acme"}');
    \\i ${relationshipValuesMigration}
    INSERT INTO custom_object_relationship (tenant_id,relationship_definition_id,source_record_id,target_record_id,field_values) VALUES
      (${q(ID.tenant)},${q(ID.respondent)},${q(ID.department)},${q(ID.member)},'{"survey_respondent":true}'),
      (${q(ID.tenant)},${q(ID.respondent)},${q(ID.department)},${q(ID.otherMember)},'{"survey_respondent":true}'),
      (${q(ID.tenant)},${q(ID.departmentOrganization)},${q(ID.department)},${q(ID.organization)},'{}'),
      (${q(ID.tenant)},${q(ID.surveyDepartment)},${q(ID.survey)},${q(ID.department)},'{}'),
      (${q(ID.tenant)},${q(ID.rowSurvey)},${q(ID.workforceRow)},${q(ID.department)},'{}'),
      (${q(ID.tenant)},${q(ID.equipmentDepartment)},${q(ID.equipment)},${q(ID.department)},'{}'),
      (${q(ID.tenant)},${q(ID.equipmentDepartment)},${q(ID.foreignEquipment)},${q(ID.otherDepartment)},'{}'),
      (${q(ID.tenant)},${q(ID.equipmentType)},${q(ID.equipment)},${q(ID.type)},'{}'),
      (${q(ID.tenant)},${q(ID.modelType)},${q(ID.model)},${q(ID.type)},'{}');
    \\i ${migration}
    \\i ${directWorkforceMigration}
    \\i ${departmentOrganisationAuthMigration}
    \\i ${departmentAssignmentAuthMigration}
    INSERT INTO department_current_set_config (tenant_id,form_id,config) VALUES (${q(ID.tenant)},${q(ID.form)}, $cfg$
      {"version":2,"department_object_id":"${ID.departmentObject}","workforce_row_object_id":"${ID.rowObject}","equipment_object_id":"${ID.equipmentObject}",
       "equipment_type_object_id":"${ID.typeObject}","equipment_model_object_id":"${ID.modelObject}",
       "respondent_relationship_id":"${ID.respondent}","respondent_field_key":"survey_respondent",
       "workforce_container_field_id":"wf","equipment_container_field_id":"eq",
        "form_compatibility":{"version":1},
        "required_blank_policy":{"existing_equipment_blank_required_field_ids":["serial","installed"],"new_equipment_required_field_ids":["serial","installed"]},
         "equipment_hidden_preserve":{"decommissioned":{"mode":"show_when","source_field_id":"service","value":"No"}},
       "workforce_fields":{"staff":"staff_group","grade":"grade","occupied":"occupied_wte","vacant":"vacant_wte"},
       "equipment_fields":{"type":"equipment_type_id","manufacturer":"manufacturer","model":"model_id","serial":"serial_number","installed":"year_installed","decommissioned":"year_decommissioned","service":"still_in_service","notes":"additional_information"},
        "relationship_keys":{"workforce_department":"workforce_survey_row_department","equipment_department":"equipment_register_department","equipment_type":"equipment_register_type","equipment_model":"equipment_register_model","model_type":"model_type"},
        "relationship_ids":{"workforce_department":"${ID.rowSurvey}","equipment_department":"${ID.equipmentDepartment}","equipment_type":"${ID.equipmentType}","equipment_model":"${ID.equipmentModel}","model_type":"${ID.modelType}"}}$cfg$::jsonb);
    \\i ${surveyStampMigration}
    INSERT INTO form_submission (id,tenant_id,form_id,created_member_id) VALUES
      (${q(ID.subOne)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subTwo)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subBad)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subThree)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subFour)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subFive)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subSix)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subSeven)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subStampOne)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subStampTwo)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)}),
      (${q(ID.subStampThree)},${q(ID.tenant)},${q(ID.form)},${q(ID.member)});
    \\i ${authMigration}
    -- Match the production writer role narrowly enough to prove trigger
    -- privilege nesting, without granting its private lock helpers directly.
    GRANT USAGE ON SCHEMA public TO service_role;
    GRANT SELECT, UPDATE ON member, organization, custom_object_record TO service_role;
  `;
}

test('Department current-set migration executes its reconciliation behavior only on a disposable PostgreSQL cluster', { timeout: 60_000 }, async t => {
  const initdb = executable('initdb');
  const pgCtl = executable('pg_ctl');
  const psql = executable('psql');
  if (!initdb || !pgCtl || !psql) return t.skip('local PostgreSQL tools unavailable; no database was contacted');

  const root = await mkdtemp(path.join(tmpdir(), 'department-current-set-'));
  const data = path.join(root, 'data');
  const socket = path.join(root, 'socket');
  run('mkdir', ['-p', socket]);
  run(initdb, ['-D', data, '--no-locale', '--encoding=UTF8', '--auth=trust', '-U', 'postgres']);
  run(pgCtl, ['-D', data, '-l', path.join(root, 'postgres.log'), '-o', `-k ${socket}`, '-w', 'start']);
  const args = ['-h', socket, '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'];
  const scalar = statement => run(psql, [...args, '-t', '-A'], statement);
  try {
    run(psql, args, fixtureSql());
    // The stamp migration is safe to apply repeatedly and retains the narrow
    // writer-role boundary established by the authenticated wrapper.
    run(psql, args, `\\i ${surveyStampMigration}`);
    assert.equal(scalar(`SELECT concat_ws(':',pf.name,pf.field_type,pf.entity_scope,pf.is_active,
      pf.custom_object_id,d.object_key,d.status)
      FROM preference_field pf JOIN custom_object_definition d ON d.id=pf.custom_object_id
      WHERE pf.id=${q(ID.surveyLastUpdatedField)}::uuid;`),
    `survey_last_updated:date:custom_object:t:${ID.departmentObject}:org_department:active`);
    run(psql, args, `INSERT INTO form (id,tenant_id) VALUES (${q(ID.otherForm)},${q(ID.tenant)});`);
    assert.match(fails(psql, args, `INSERT INTO department_current_set_config (tenant_id,form_id,config)
      VALUES (${q(ID.tenant)},${q(ID.otherForm)},'{}');`), /department_current_set_config_scope/);
    // Data Studio's writer role must be able to make ordinary graph/auth
    // updates. It cannot execute either private auth-lock helper directly;
    // the SECURITY DEFINER trigger functions own that nested capability.
    run(psql, args, `
      SET ROLE service_role;
      UPDATE member SET login_enabled=login_enabled WHERE id=${q(ID.member)}::uuid;
      UPDATE organization SET member_login_blocked=member_login_blocked WHERE id=${q(ID.organization)}::uuid;
      UPDATE custom_object_record SET data=data WHERE id=${q(ID.department)}::uuid;
      RESET ROLE;
    `);
    assert.match(fails(psql, args, `SET ROLE service_role; SELECT department_current_set_auth_lock(${q(ID.tenant)},true);`), /permission denied/);

    const loaded = JSON.parse(scalar(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)})::text;`));
    assert.equal(loaded.form_values.wf.length, 1);
    assert.equal(loaded.form_values.eq.length, 1);
    assert.equal(loaded.form_values.wf[0].staff, 'Clinical Practitioner – Technologist ');
    assert.equal(loaded.form_values.wf[0].occupied, 0);
    assert.equal(loaded.form_values.eq[0].serial, null);
    assert.equal(loaded.form_values.eq[0].installed, null);

    // A signed-in member from another organisation is allowed when the
    // Department explicitly assigns that member as a respondent.
    run(psql, args, `UPDATE member SET organization_id=${q(ID.otherOrganization)}::uuid
      WHERE id=${q(ID.otherMember)}::uuid;`);
    assert.equal(JSON.parse(scalar(`SELECT department_current_set_load_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.otherMember)}::uuid,${q(ID.otherSession)})::text;`)).department.id, ID.department);

    // The respondent assignment, rather than organisation membership, is the
    // Department authority. Removing it denies both read and reconcile.
    run(psql, args, `UPDATE form_submission SET submission_data=${completePayload()}
      ,created_member_id=${q(ID.otherMember)}::uuid
      WHERE id=${q(ID.subBad)}::uuid;`);
    run(psql, args, `DELETE FROM custom_object_relationship
      WHERE relationship_definition_id=${q(ID.respondent)}::uuid
        AND source_record_id=${q(ID.department)}::uuid
        AND target_record_id=${q(ID.otherMember)}::uuid;`);
    assert.match(fails(psql, args, `SELECT department_current_set_load_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.otherMember)}::uuid,${q(ID.otherSession)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(fails(psql, args, `SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.otherMember)}::uuid,${q(ID.subBad)}::uuid,'stale',${q(ID.otherSession)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subBad)}::uuid));`), /CURRENT_SET_AUTHORIZATION/);
    run(psql, args, `INSERT INTO custom_object_relationship
      (tenant_id,relationship_definition_id,source_record_id,target_record_id,field_values)
      VALUES (${q(ID.tenant)},${q(ID.respondent)},${q(ID.department)},${q(ID.otherMember)},
        '{"survey_respondent":true}');
      UPDATE form_submission SET created_member_id=${q(ID.member)}::uuid
        WHERE id=${q(ID.subBad)}::uuid;`);

    // The public functions are wrapper-only: an otherwise valid signed member
    // cannot load or mutate with an absent/expired/wrong session or revoked
    // audience. Relationship field defaults also enforce a real JSON boolean,
    // not truthy strings.
    const failSql = statement => fails(psql, args, statement);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,'missing-session');`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.otherSession)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`UPDATE custom_object_relationship SET field_values='{"survey_respondent":"true"}' WHERE relationship_definition_id=${q(ID.respondent)}::uuid;`), /must be a boolean/);
    run(psql, args, `UPDATE form_submission SET submission_data=${completePayload()}
      WHERE id=${q(ID.subBad)}::uuid;`);
    run(psql, args, `UPDATE custom_object_relationship SET field_values='{"survey_respondent":false}' WHERE relationship_definition_id=${q(ID.respondent)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.subBad)}::uuid,'stale',${q(ID.session)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subBad)}::uuid));`), /CURRENT_SET_AUTHORIZATION/);
    run(psql, args, `UPDATE custom_object_relationship SET field_values='{"survey_respondent":true}' WHERE relationship_definition_id=${q(ID.respondent)}::uuid;`);
    run(psql, args, `UPDATE form SET access_policy=jsonb_build_object('version','1','operator','or','rbac_role_ids',jsonb_build_array('10000000-0000-4000-8000-000000000099'),'group_rules','[]'::jsonb) WHERE id=${q(ID.form)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    // A matching role cannot turn a malformed/incomplete audience object into
    // a grant: all policy keys have to be present and correctly shaped.
    run(psql, args, `UPDATE form SET access_policy=jsonb_build_object('version','1','operator','or','rbac_role_ids',jsonb_build_array(${q(ID.role)})) WHERE id=${q(ID.form)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    run(psql, args, `UPDATE form SET access_policy=jsonb_build_object('version','1','operator','or','rbac_role_ids',jsonb_build_array(${q(ID.role)}),'group_rules','[]'::jsonb) WHERE id=${q(ID.form)}::uuid;`);
    assert.equal(JSON.parse(scalar(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)})::text;`)).department.id, ID.department);
    run(psql, args, `DELETE FROM role WHERE id=${q(ID.role)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    run(psql, args, `INSERT INTO role (id,tenant_id) VALUES (${q(ID.role)},${q(ID.tenant)});`);
    run(psql, args, `
      INSERT INTO member_group (id,tenant_id,roles) VALUES (${q(ID.group)},${q(ID.tenant)},'["Editor"]');
      INSERT INTO member_group_assignment (tenant_id,group_id,member_id,group_role)
        VALUES (${q(ID.tenant)},${q(ID.group)},${q(ID.member)},'Editor');
      UPDATE form SET access_policy=jsonb_build_object('version','1','operator','or','rbac_role_ids','[]'::jsonb,
        'group_rules',jsonb_build_array(jsonb_build_object('group_id',${q(ID.group)},'role_names',jsonb_build_array('Editor'))))
        WHERE id=${q(ID.form)}::uuid;
    `);
    assert.equal(JSON.parse(scalar(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)})::text;`)).department.id, ID.department);
    run(psql, args, `UPDATE member_group SET is_active=false WHERE id=${q(ID.group)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    run(psql, args, `UPDATE form SET access_policy=NULL WHERE id=${q(ID.form)}::uuid;`);
    // A direct tenant member without an organisation is still eligible when
    // the explicit respondent assignment is live.
    run(psql, args, `UPDATE member SET organization_id=NULL WHERE id=${q(ID.otherMember)}::uuid;`);
    assert.equal(JSON.parse(scalar(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.otherMember)}::uuid,${q(ID.otherSession)})::text;`)).department.id, ID.department);
    run(psql, args, `UPDATE member SET tenant_id=NULL WHERE id=${q(ID.otherMember)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.otherMember)}::uuid,${q(ID.otherSession)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.otherMember)}::uuid,${q(ID.subBad)}::uuid,'stale',${q(ID.otherSession)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subBad)}::uuid));`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(
      '20000000-0000-4000-8000-000000000001'::uuid,${q(ID.form)}::uuid,
      ${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION|CURRENT_SET_INVALID/);
    assert.match(failSql(`SELECT department_current_set_reconcile_authenticated(
      '20000000-0000-4000-8000-000000000001'::uuid,${q(ID.form)}::uuid,
      ${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.subBad)}::uuid,
      'stale',${q(ID.session)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subBad)}::uuid));`), /CURRENT_SET_AUTHORIZATION/);
    // Revoking then restoring login state cannot revive a session with the old
    // durable generation. A freshly generated session is accepted.
    run(psql, args, `INSERT INTO member_login_session_revocation (member_id,tenant_id,generation)
      VALUES (${q(ID.member)},${q(ID.tenant)},1); UPDATE member SET login_enabled=false WHERE id=${q(ID.member)}::uuid;
      UPDATE member SET login_enabled=true WHERE id=${q(ID.member)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    run(psql, args, `UPDATE session SET sess=${q(JSON.stringify({
      memberId: ID.member, tenantId: ID.tenant, memberLoginGeneration: '1', organizationLoginGeneration: '0',
    }))} WHERE sid=${q(ID.session)};`);
    assert.equal(JSON.parse(scalar(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)})::text;`)).department.id, ID.department);
    assert.equal(scalar(`SELECT has_function_privilege('authenticated','department_current_set_load_authenticated(uuid,uuid,uuid,uuid,text)','EXECUTE');`), 'f');
    assert.equal(scalar(`SELECT has_function_privilege('service_role','department_current_set_reconcile_authenticated(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)','EXECUTE');`), 't');
    assert.equal(scalar(`SELECT has_function_privilege('anon','department_current_set_reconcile_authenticated(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)','EXECUTE');`), 'f');
    assert.equal(scalar(`SELECT has_function_privilege('authenticated','department_current_set_reconcile_authenticated(uuid,uuid,uuid,uuid,uuid,text,text,jsonb)','EXECUTE');`), 'f');
    assert.equal(scalar(`SELECT has_function_privilege('service_role','department_current_set_assert_survey_stamp_metadata(uuid,uuid,jsonb)','EXECUTE');`), 'f');
    assert.equal(scalar(`SELECT has_function_privilege('anon','department_current_set_assert_survey_stamp_metadata(uuid,uuid,jsonb)','EXECUTE');`), 'f');

    // A successful save stamps the Department itself even when its submitted
    // answers are unchanged. The date is UTC and date-only; audit identity and
    // time come from the database, not from the payload or response.
    assert.equal(scalar(`SELECT data ? 'survey_last_updated' FROM custom_object_record WHERE id=${q(ID.department)}::uuid;`), 'f');
    const unaffectedBefore = scalar(`SELECT jsonb_build_object(
      'other_department',(SELECT to_jsonb(r) FROM custom_object_record r WHERE id=${q(ID.otherDepartment)}::uuid),
      'other_tenant',(SELECT to_jsonb(r) FROM custom_object_record r WHERE id=${q(ID.foreignDepartment)}::uuid),
      'other_object',(SELECT to_jsonb(r) FROM custom_object_record r WHERE id=${q(ID.survey)}::uuid)
    )::text;`);
    const firstBefore = Date.parse(scalar(`SELECT clock_timestamp()::text;`));
    const firstStampResult = JSON.parse(scalar(`SET TIME ZONE 'Pacific/Kiritimati'; ${sqlCall(ID.subStampOne, currentPayload())}`));
    const firstAfter = Date.parse(scalar(`SELECT clock_timestamp()::text;`));
    const firstRecord = JSON.parse(scalar(`SELECT jsonb_build_object(
      'data',data,'updated_at',updated_at,'updated_by',updated_by
    )::text FROM custom_object_record WHERE id=${q(ID.department)}::uuid;`));
    assert.match(firstRecord.data.survey_last_updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(firstRecord.data.survey_last_updated, scalar(`SELECT (clock_timestamp() AT TIME ZONE 'UTC')::date::text;`));
    assert.equal(firstRecord.updated_by, `member:${ID.member}`);
    assert.ok(Date.parse(firstRecord.updated_at) >= firstBefore);
    assert.ok(Date.parse(firstRecord.updated_at) <= firstAfter);
    assert.deepEqual(firstRecord.data.unrelated, { preserve: true });
    assert.equal(firstRecord.data.legacy_code, 'N-1');
    assert.equal(scalar(`SELECT jsonb_build_object(
      'other_department',(SELECT to_jsonb(r) FROM custom_object_record r WHERE id=${q(ID.otherDepartment)}::uuid),
      'other_tenant',(SELECT to_jsonb(r) FROM custom_object_record r WHERE id=${q(ID.foreignDepartment)}::uuid),
      'other_object',(SELECT to_jsonb(r) FROM custom_object_record r WHERE id=${q(ID.survey)}::uuid)
    )::text;`), unaffectedBefore);

    const freshAfterFirst = JSON.parse(scalar(`SET TIME ZONE 'Pacific/Kiritimati';
      SELECT department_current_set_load_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.session)})::text;`));
    assert.equal(firstStampResult.version, freshAfterFirst.version);

    // The result version is immediately usable for the next save. A later
    // unchanged save refreshes audit time, while retrying the earlier
    // submission preserves both the newer date and its exact audit instant.
    run(psql, args, `SELECT pg_sleep(0.02);`);
    const secondStampResult = JSON.parse(scalar(`SET TIME ZONE 'Pacific/Kiritimati'; ${sqlCall(
      ID.subStampTwo,
      currentPayload(),
      q(firstStampResult.version),
    )}`));
    const secondRecord = JSON.parse(scalar(`SELECT jsonb_build_object(
      'data',data,'updated_at',updated_at,'updated_by',updated_by
    )::text FROM custom_object_record WHERE id=${q(ID.department)}::uuid;`));
    assert.ok(Date.parse(secondRecord.updated_at) > Date.parse(firstRecord.updated_at));
    assert.equal(secondRecord.updated_by, `member:${ID.member}`);
    assert.equal(secondStampResult.version, scalar(`SET TIME ZONE 'Pacific/Kiritimati';
      SELECT department_current_set_load_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.session)})->>'version';`));
    assert.match(scalar(`SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,
      ${q(ID.subStampOne)}::uuid,'old-version',${q(ID.session)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subStampOne)}::uuid)
    )::text;`), /replayed/);
    assert.deepEqual(JSON.parse(scalar(`SELECT jsonb_build_object('data',data,'updated_at',updated_at,'updated_by',updated_by)::text
      FROM custom_object_record WHERE id=${q(ID.department)}::uuid;`)), secondRecord);

    const stampState = () => scalar(`SELECT jsonb_build_object(
      'stamp',data->'survey_last_updated','updated_at',updated_at,'updated_by',updated_by
    )::text FROM custom_object_record WHERE id=${q(ID.department)}::uuid;`);
    const stableStamp = stampState();

    // Validation, authorization, and optimistic conflicts all fail before the
    // stamp write and leave its date and audit columns untouched.
    assert.match(failSql(sqlCall(ID.subBad, completePayload(
      `jsonb_build_array(jsonb_build_object('grade','Band 5','occupied',0,'vacant',0))`,
      "'[]'::jsonb",
    ))), /missing an active required field/);
    assert.equal(stampState(), stableStamp);
    run(psql, args, `UPDATE custom_object_relationship SET field_values='{"survey_respondent":false}'
      WHERE relationship_definition_id=${q(ID.respondent)}::uuid AND source_record_id=${q(ID.department)}::uuid
        AND target_record_id=${q(ID.member)}::uuid;`);
    assert.match(fails(psql, args, sqlCall(ID.subBad, currentPayload())), /CURRENT_SET_AUTHORIZATION/);
    assert.equal(stampState(), stableStamp);
    run(psql, args, `UPDATE custom_object_relationship SET field_values='{"survey_respondent":true}'
      WHERE relationship_definition_id=${q(ID.respondent)}::uuid AND source_record_id=${q(ID.department)}::uuid
        AND target_record_id=${q(ID.member)}::uuid;`);
    assert.match(fails(psql, args, sqlCall(ID.subBad, currentPayload(), q('stale-version'))), /CURRENT_SET_CONFLICT/);
    assert.equal(stampState(), stableStamp);

    // The pinned field metadata is checked at write time. A field with the
    // right id but an incompatible type fails closed rather than writing an
    // unvalidated key.
    run(psql, args, `UPDATE preference_field SET field_type='text' WHERE id=${q(ID.surveyLastUpdatedField)}::uuid;`);
    assert.match(fails(psql, args, sqlCall(ID.subBad, currentPayload())), /CURRENT_SET_INVALID|survey_last_updated|stamp/i);
    assert.equal(stampState(), stableStamp);
    run(psql, args, `UPDATE preference_field SET field_type='date' WHERE id=${q(ID.surveyLastUpdatedField)}::uuid;`);

    // Force the final Department write to fail after reconciliation work. The
    // transaction must roll back the changed answer as well as the stamp.
    const gradeBeforeStampFailure = scalar(`SELECT data->>'grade' FROM custom_object_record WHERE id=${q(ID.workforceRow)}::uuid;`);
    run(psql, args, `
      CREATE FUNCTION reject_department_stamp_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced stamp write failure'; END $$;
      CREATE TRIGGER reject_department_stamp_for_test BEFORE UPDATE ON custom_object_record
        FOR EACH ROW WHEN (NEW.id = ${q(ID.department)}::uuid)
        EXECUTE FUNCTION reject_department_stamp_for_test();
    `);
    const changedCurrentPayload = `(SELECT jsonb_set(value->'form_values','{wf,0,grade}','"Band 6"'::jsonb)
      FROM (SELECT department_current_set_load_authenticated(
        ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
        ${q(ID.member)}::uuid,${q(ID.session)}) AS value) loaded)`;
    assert.match(fails(psql, args, sqlCall(ID.subStampThree, changedCurrentPayload)), /forced stamp write failure/);
    assert.equal(scalar(`SELECT data->>'grade' FROM custom_object_record WHERE id=${q(ID.workforceRow)}::uuid;`), gradeBeforeStampFailure);
    assert.equal(stampState(), stableStamp);
    run(psql, args, `DROP TRIGGER reject_department_stamp_for_test ON custom_object_record;
      DROP FUNCTION reject_department_stamp_for_test();`);

    // Identity hints cannot point at a current-set record owned by another
    // Department, and a late invalid equipment section rolls back without
    // clearing valid workforce data.
    assert.match(failSql(sqlCall(ID.subBad, completePayload("'[]'::jsonb", `jsonb_build_array(jsonb_build_object('_row_id','existing:${ID.foreignEquipment}'))`))), /does not belong to this Department/);
    assert.equal(scalar(`SELECT archived_at IS NULL FROM custom_object_record WHERE id=${q(ID.workforceRow)}::uuid;`), 't');
    assert.match(failSql(sqlCall(ID.subBad, completePayload(
      `jsonb_build_array(jsonb_build_object('grade','Band 5','occupied',0,'vacant',0))`,
      "'[]'::jsonb",
    ))), /missing an active required field/);
    assert.match(failSql(sqlCall(ID.subBad, completePayload(
      `jsonb_build_array(jsonb_build_object('staff','Nurse ','grade','Band 5','occupied',0,'vacant',0))`,
      "'[]'::jsonb",
    ))), /exact canonical option/);
    assert.match(failSql(sqlCall(ID.subBad, completePayload("'[]'::jsonb", `jsonb_build_array(jsonb_build_object('type',${q(ID.type)},'serial','','installed','2024'))`))), /new equipment requires serial number/);
    assert.match(failSql(sqlCall(ID.subBad, completePayload("'[]'::jsonb", `jsonb_build_array(jsonb_build_object('type',${q(ID.foreignType)},'manufacturer','Acme','model',${q(ID.model)},'serial','attack','installed','2024'))`))), /Model does not match Type and Manufacturer/);
    assert.equal(scalar(`SELECT data->>'grade' FROM custom_object_record WHERE id=${q(ID.workforceRow)}::uuid;`), 'Band 7');

    // The wrapper accepts only the exact object server-side validation saw,
    // after locking the durable submission row. It must never consume a
    // separately supplied browser payload.
    run(psql, args, `UPDATE form_submission SET submission_data=${completePayload()} WHERE id=${q(ID.subBad)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,
      ${q(ID.subBad)}::uuid,(SELECT submission_data->'__department_current_set'->>'version' FROM form_submission WHERE id=${q(ID.subBad)}::uuid),
      ${q(ID.session)},'{"changed_by_browser":true}'::jsonb
    );`), /persisted submission changed after validation/);

    // Reorder is identity preserving, adds one row of each kind, and retains
    // the legacy equipment's blank required values. Numeric zero must survive.
    const wf = `jsonb_build_array(
      jsonb_build_object('_row_id','existing:${ID.workforceRow}','staff','Clinical Practitioner – Technologist ','grade','Band 8a','occupied',0,'vacant',2),
      jsonb_build_object('staff','Nurse','grade','Band 5','occupied',1.5,'vacant',0),
      jsonb_build_object('staff','Nurse','grade','Band 5','occupied',1.5,'vacant',0)
    )`;
    const eq = `jsonb_build_array(
      jsonb_build_object('_row_id','existing:${ID.equipment}','type',${q(ID.type)},'manufacturer','Acme','model',${q(ID.model)},'service','Yes','decommissioned','2099','notes','legacy'),
      jsonb_build_object('type',${q(ID.type)},'manufacturer','Acme','model',${q(ID.model)},'serial','NEW-1','installed','2024','decommissioned','2025','service','No','notes','new'),
      jsonb_build_object('type',${q(ID.type)},'manufacturer','Acme','model',${q(ID.model)},'serial','NEW-2','installed','2023','service','Yes','notes','hidden new')
    )`;
    const committed = scalar(sqlCall(ID.subOne, completePayload(wf, eq)));
    assert.match(committed, /"status": "committed"|\"status\":\"committed\"/);
    const committedProjection = JSON.parse(committed);
    assert.equal(committedProjection.form_values.eq.find(row => row.serial === 'NEW-1').installed, '2024');
    assert.equal(committedProjection.form_values.eq.find(row => row.serial === 'NEW-1').decommissioned, '2025');
    assert.equal(scalar(`SELECT (data->>'staff_group') || ':' || (data->>'occupied_wte') || ':' || (data->>'legacy_vacancy_reported') FROM custom_object_record WHERE id=${q(ID.workforceRow)}::uuid;`), 'Clinical Practitioner – Technologist :0:Unknown');
    assert.equal(scalar(`SELECT count(*) FROM custom_object_record WHERE custom_object_id=${q(ID.rowObject)}::uuid AND archived_at IS NULL;`), '3');
    assert.equal(scalar(`SELECT count(*) FROM custom_object_record WHERE custom_object_id=${q(ID.equipmentObject)}::uuid AND archived_at IS NULL;`), '4');
    assert.equal(scalar(`SELECT count(*) FROM custom_object_record WHERE custom_object_id=${q(ID.equipmentObject)}::uuid AND data->>'serial_number'='NEW-1';`), '1');
    assert.equal(scalar(`SELECT (data->>'year_installed') || ':' || (data->>'year_decommissioned') || ':' || (data->>'still_in_service') || ':' || (data->>'additional_information')
      FROM custom_object_record WHERE custom_object_id=${q(ID.equipmentObject)}::uuid AND data->>'serial_number'='NEW-1';`), '2024:2025:No:new');
    assert.equal(scalar(`SELECT data ? 'year_decommissioned' FROM custom_object_record
      WHERE custom_object_id=${q(ID.equipmentObject)}::uuid AND data->>'serial_number'='NEW-2';`), 'f');
    assert.equal(scalar(`SELECT data->>'year_decommissioned' FROM custom_object_record WHERE id=${q(ID.equipment)}::uuid;`), '2018');
    assert.equal(scalar(`SELECT count(*) FROM custom_object_relationship edge
      WHERE edge.source_record_id=(SELECT id FROM custom_object_record WHERE data->>'serial_number'='NEW-1')
        AND edge.archived_at IS NULL AND edge.relationship_definition_id IN (${q(ID.equipmentType)}::uuid,${q(ID.equipmentModel)}::uuid);`), '2');

    // The configured show_when rule owns a hidden child value. Existing
    // records retain it whether the browser omits it or forges another value;
    // a new hidden row above did not receive the field at all. Once visible,
    // normal whole-year updates and an explicit clear are applied.
    const hiddenMissing = scalar(sqlCall(ID.subFive, currentEquipmentPayload({
      service: 'Yes', omitDecommissioned: true,
    })));
    assert.match(hiddenMissing, /committed/);
    assert.equal(scalar(`SELECT data->>'year_decommissioned' FROM custom_object_record WHERE id=${q(ID.equipment)}::uuid;`), '2018');
    assert.match(failSql(sqlCall(ID.subBad, currentEquipmentPayload({
      service: 'No', decommissioned: '22',
    }))), /decommissioning year must be a whole year/);
    const visibleUpdate = scalar(sqlCall(ID.subSix, currentEquipmentPayload({
      service: 'No', decommissioned: '2022',
    })));
    assert.match(visibleUpdate, /committed/);
    assert.equal(scalar(`SELECT data->>'year_decommissioned' FROM custom_object_record WHERE id=${q(ID.equipment)}::uuid;`), '2022');
    const visibleClear = scalar(sqlCall(ID.subSeven, currentEquipmentPayload({
      service: 'No', decommissioned: '',
    })));
    assert.match(visibleClear, /committed/);
    assert.equal(scalar(`SELECT data ? 'year_decommissioned' FROM custom_object_record WHERE id=${q(ID.equipment)}::uuid;`), 'f');

    // A retry returns the prior committed result and cannot use subsequently
    // changed live values to replay an old payload.
    assert.match(scalar(`SELECT department_current_set_reconcile_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.subOne)}::uuid,'not-current',${q(ID.session)},(SELECT submission_data FROM form_submission WHERE id=${q(ID.subOne)}::uuid))::text;`), /replayed/);
    assert.equal(scalar(`SELECT count(*) FROM department_current_set_commit WHERE submission_id=${q(ID.subOne)}::uuid;`), '1');

    // New equipment must supply both required values, and once values exist
    // they cannot be cleared. The grandfathered blank legacy record remains
    // editable (covered by the successful payload above).
    const newEquipment = scalar(`SELECT id::text FROM custom_object_record WHERE custom_object_id=${q(ID.equipmentObject)}::uuid AND data->>'serial_number'='NEW-1';`);
    const clearingNewEquipment = `jsonb_build_array(jsonb_build_object(
      '_row_id','existing:' || ${q(newEquipment)},'type',${q(ID.type)},'manufacturer','Acme',
      'model',${q(ID.model)},'serial','','installed',''
    ))`;
    assert.match(failSql(sqlCall(ID.subBad, completePayload("'[]'::jsonb", clearingNewEquipment))), /existing serial number cannot be cleared/);
    assert.equal(scalar(`SELECT data->>'serial_number' FROM custom_object_record WHERE id=${q(newEquipment)}::uuid;`), 'NEW-1');

    // Two independent psql clients model a studio write racing a stale
    // submission. The tenant lock makes the transaction wait, then the
    // Department fingerprint rejects the stale completion instead of losing
    // the studio edit.
    run(psql, args, `UPDATE form_submission SET submission_data=${completePayload()} WHERE id=${q(ID.subThree)}::uuid;`);
    const holder = runAsync(psql, args, `
      BEGIN;
      SELECT department_current_set_lock(${q(ID.tenant)}::uuid);
      SELECT pg_sleep(0.8);
      UPDATE custom_object_record SET data=data || '{"studio_note":"concurrent"}'::jsonb
        WHERE id=${q(ID.department)}::uuid;
      COMMIT;
    `);
    await new Promise(resolve => setTimeout(resolve, 100));
    const racing = await runAsync(psql, args, `SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,
      ${q(ID.subThree)}::uuid,
      (SELECT submission_data->'__department_current_set'->>'version' FROM form_submission WHERE id=${q(ID.subThree)}::uuid),
      ${q(ID.session)}, (SELECT submission_data FROM form_submission WHERE id=${q(ID.subThree)}::uuid)
    );`);
    const held = await holder;
    assert.equal(held.status, 0, held.stderr);
    assert.notEqual(racing.status, 0, 'stale concurrent save must not commit');
    assert.match(`${racing.stdout}\n${racing.stderr}`, /CURRENT_SET_CONFLICT/);
    assert.equal(scalar(`SELECT data->>'studio_note' FROM custom_object_record WHERE id=${q(ID.department)}::uuid;`), 'concurrent');

    // Deliberately empty arrays clear only this Department's current sets.
    const clear = scalar(sqlCall(ID.subTwo, completePayload()));
    assert.match(clear, /committed/);
    assert.equal(scalar(`SELECT count(*) FROM custom_object_record WHERE id IN (${q(ID.workforceRow)}::uuid,${q(ID.equipment)}::uuid) AND archived_at IS NOT NULL;`), '2');
    assert.equal(scalar(`SELECT count(*) FROM custom_object_record WHERE id=${q(ID.foreignEquipment)}::uuid AND archived_at IS NULL;`), '1');

    // A nonempty direct set creates a Row-to-Department edge only. Retiring an
    // unrelated historical survey must never cause an implicit survey creation.
    run(psql, args, `
      UPDATE custom_object_relationship SET archived_at=now(), archived_by='test'
        WHERE relationship_definition_id=${q(ID.surveyDepartment)}::uuid AND archived_at IS NULL;
      UPDATE custom_object_record SET archived_at=now(), archived_by='test', archive_reason='historical'
        WHERE id=${q(ID.survey)}::uuid;
    `);
    const recreated = scalar(sqlCall(ID.subFour, completePayload(
      `jsonb_build_array(jsonb_build_object('staff','Radiographer','grade','Band 6','occupied',0,'vacant',0))`,
      "'[]'::jsonb",
    )));
    assert.match(recreated, /committed/);
    assert.equal(scalar(`SELECT count(*) FROM custom_object_record WHERE custom_object_id=${q(ID.surveyObject)}::uuid AND archived_at IS NULL;`), '0');
    assert.equal(scalar(`SELECT count(*) FROM custom_object_relationship edge
      JOIN custom_object_record row ON row.id=edge.source_record_id
      WHERE row.custom_object_id=${q(ID.rowObject)}::uuid AND row.data->>'staff_group'='Radiographer'
        AND edge.relationship_definition_id=${q(ID.rowSurvey)}::uuid
        AND edge.target_record_id=${q(ID.department)}::uuid AND edge.archived_at IS NULL;`), '1');
    assert.match(scalar(`SELECT department_current_set_reconcile_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.subFour)}::uuid,'stale',${q(ID.session)},(SELECT submission_data FROM form_submission WHERE id=${q(ID.subFour)}::uuid))::text;`), /replayed/);

    // Exact respondent truth is required throughout the request. Missing is
    // unauthorized; JSON null is rejected by the production boolean trigger;
    // an archived link is a revoked authorization.
    run(psql, args, `UPDATE custom_object_relationship SET field_values='{}' WHERE relationship_definition_id=${q(ID.respondent)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`UPDATE custom_object_relationship SET field_values='{"survey_respondent":null}' WHERE relationship_definition_id=${q(ID.respondent)}::uuid;`), /must be a boolean/);
    run(psql, args, `UPDATE custom_object_relationship SET field_values='{"survey_respondent":true}', archived_at=now(), archived_by='test' WHERE relationship_definition_id=${q(ID.respondent)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.subBad)}::uuid,'stale',${q(ID.session)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subBad)}::uuid));`), /CURRENT_SET_AUTHORIZATION/);

    // Archiving the requested Department revokes both operations even if a
    // respondent edge is otherwise present.
    run(psql, args, `UPDATE custom_object_relationship
      SET archived_at=NULL, archived_by=NULL
      WHERE relationship_definition_id=${q(ID.respondent)}::uuid
        AND source_record_id=${q(ID.department)}::uuid
        AND target_record_id=${q(ID.member)}::uuid;
      UPDATE custom_object_record SET archived_at=now(), archived_by='test'
        WHERE id=${q(ID.department)}::uuid;`);
    assert.match(failSql(`SELECT department_current_set_load_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.session)});`), /CURRENT_SET_AUTHORIZATION/);
    assert.match(failSql(`SELECT department_current_set_reconcile_authenticated(
      ${q(ID.tenant)}::uuid,${q(ID.form)}::uuid,${q(ID.department)}::uuid,
      ${q(ID.member)}::uuid,${q(ID.subBad)}::uuid,'stale',${q(ID.session)},
      (SELECT submission_data FROM form_submission WHERE id=${q(ID.subBad)}::uuid));`), /CURRENT_SET_AUTHORIZATION/);
  } finally {
    spawnSync(pgCtl, ['-D', data, '-m', 'immediate', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
