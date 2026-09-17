import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const script = await readFile(new URL('./configure-department-current-set.mjs', import.meta.url), 'utf8');

test('rollout is dry-run-first and requires a reviewed report for writes', () => {
  assert.match(script, /APPLY && !reviewArgument/);
  assert.match(script, /--apply requires an explicit reviewed dry-run report/);
  assert.match(script, /--apply requires --application-published/);
  assert.match(script, /applicationPublishedAcknowledgementRequired: true/);
  assert.match(script, /review\.preflightFingerprint === state\.fingerprint/);
});

test('apply locks and atomically commits the pinned form plus config', () => {
  assert.match(script, /DEST_DATABASE_URL is required for the guarded atomic apply/);
  assert.match(script, /rejectUnauthorized: true/);
  assert.match(script, /DESTINATION_CA_URL/);
  assert.match(script, /Shared pool username is not pinned/);
  assert.match(script, /db\.lvmzliemqnieeoruhkik\.supabase\.co/);
  assert.match(script, /public\.department_current_set_lock\(\$1::uuid\)/);
  assert.match(script, /department_current_set_load_authenticated/);
  assert.match(script, /department_current_set_reconcile_authenticated/);
  assert.match(script, /to_regprocedure/);
  assert.match(script, /FOR UPDATE/);
  assert.match(script, /BEGIN/);
  assert.match(script, /COMMIT/);
  assert.match(script, /ROLLBACK/);
  assert.match(script, /INSERT INTO public\.\$\{CURRENT_SET_CONFIG_TABLE\}/);
});

test('preflight remains data read-only and reports the import re-review requirement', () => {
  assert.match(script, /pages\(db\.from\('custom_object_record'\)/);
  assert.match(script, /\.order\('id', \{ ascending: true \}\)/);
  assert.match(script, /pagination repeated or omitted a record ID/);
  assert.match(script, /maximumEquipmentRowsForOneDepartment/);
  assert.match(script, /maximumWorkforceRowsForOneDepartment/);
  assert.match(script, /maximumProjectedRowsForOneDepartment/);
  assert.match(script, /workforce_survey_row_department/);
  assert.match(script, /respondentAssignmentSuitability/);
  assert.match(script, /departmentOrganisationSuitability/);
  assert.match(script, /departmentsWithExactlyOneRespondentInSameOrganisation/);
  assert.match(script, /Department organisation relationship definitions/);
  assert.match(script, /dropdownCanonicalCompatibility/);
  assert.match(script, /workforceDropdownOptionChanges/);
  assert.match(script, /This currently public form will require sign-in/);
  assert.match(script, /existingEquipmentBlankSerial/);
  assert.match(script, /deliberateEmptyWorkforceAndEquipmentAllowed: true/);
  assert.match(script, /blocks an intentional empty current set/);
  assert.match(script, /preparedWorkforceImportChanged: false/);
  assert.match(script, /repeat that import package/);
});