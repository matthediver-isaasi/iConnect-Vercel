import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  createFormRelationshipService,
  FormRelationshipError,
} from '../_lib/formRelationshipOptions.js';
import { validateRepeatableRowSubmission } from '../_lib/formRepeatableRowValidation.js';
import {
  FORM_NOT_LISTED_VALUE,
  FORM_NOT_LISTED_TEXT_KEY,
  FORM_NOT_LISTED_LABELS_KEY,
  snapshotFormNotListedLabels,
} from '../../shared/formNotListedChoice.js';
import {
  validateFormOrganisationGroupAnswers,
  validateOrganisationGroupDependentOrganizationAnswers,
} from '../_lib/formOrganisationGroups.js';
import { invalidRequiredAddressLookupFields } from '../_lib/idealPostcodes.js';
import { computeAuthoritativeHiddenFieldIds } from '../_lib/formFieldVisibility.js';
import { rulesUseLmicOperators } from '../_lib/formLmicConditions.js';
import { validateFutureDateFields } from '../../shared/formFutureDates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'manual-form-submission.js'), 'utf8');

test('manual handler accepts retained hidden Not-listed rows and rejects visible missing text before writing', async () => {
  // Execute the unchanged handler body, injecting only its closed-over module
  // bindings. All validators are real; session and database I/O are fixtures.
  const handlerBody = source.slice(source.indexOf('export default async function handler'))
    .replace('export default ', 'return ');
  const container = {
    id: 'rows', type: 'repeatable_rows',
    children: [
      { id: 'driver', type: 'select', options: ['Yes', 'No'] },
      {
        id: 'country', type: 'country',
        not_listed_choice: { enabled: true, label: 'Other country' },
        row_visibility: { mode: 'show_when', source_field_id: 'driver', value: 'Yes' },
      },
    ],
  };
  const form = { id: 'form-fixture', tenant_id: 'tenant-fixture', fields: [container] };
  for (const companion of [undefined, { country: '' }, { country: 'x'.repeat(501) }]) {
    for (const visible of [false, true]) {
      const inserted = [];
      let rootValidationCalls = 0;
      const db = {
        from(table) {
          assert.ok(['form', 'form_submission'].includes(table), `Unexpected lookup: ${table}`);
          const chain = {
            select() { return chain; },
            eq() { return chain; },
            insert(record) { inserted.push(record); return chain; },
            async single() {
              return { data: table === 'form' ? form : { id: 'submission-fixture' }, error: null };
            },
          };
          return chain;
        },
      };
      const bindings = {
        supabase: db,
        getSessionMember: async () => ({ tenant_id: form.tenant_id }),
        createFormRelationshipService(args) {
          const service = createFormRelationshipService(args);
          return {
            async validateSubmission(input) {
              rootValidationCalls++;
              return service.validateSubmission(input);
            },
          };
        },
        FormRelationshipError,
        validateRepeatableRowSubmission,
        snapshotFormNotListedLabels,
        validateFormOrganisationGroupAnswers,
        validateOrganisationGroupDependentOrganizationAnswers,
        invalidRequiredAddressLookupFields,
        computeAuthoritativeHiddenFieldIds,
        rulesUseLmicOperators,
        loadTenantLmicCodes: async () => { throw new Error('Unexpected LMIC lookup'); },
        validateFutureDateFields,
      };
      const handler = new Function(...Object.keys(bindings), handlerBody)(...Object.values(bindings));
      const row = {
        _row_id: 'row-fixture',
        driver: visible ? 'Yes' : 'No',
        country: FORM_NOT_LISTED_VALUE,
        ...(companion === undefined ? {} : {
          [FORM_NOT_LISTED_TEXT_KEY]: companion,
          [FORM_NOT_LISTED_LABELS_KEY]: { country: 'Retained label' },
        }),
      };
      const res = {
        statusCode: 200,
        setHeader() {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await handler({
        method: 'POST', headers: {},
        body: { form_id: form.id, submission_data: { rows: [row] } },
      }, res);
      assert.equal(res.statusCode, visible ? 400 : 200, JSON.stringify(res.body));
      if (visible) {
        assert.equal(inserted.length, 0);
      } else {
        assert.equal(rootValidationCalls, 1, 'the actual root validator must also accept the row');
        assert.equal(inserted.length, 1);
        assert.deepEqual(inserted[0].submission_data.rows, [row]);
      }
    }
  }
});

test('manual submissions enforce relationship and Organisation Group validation before persistence', () => {
  const repeatableIndex = source.indexOf('await validateRepeatableRowSubmission({');
  const relationshipIndex = source.indexOf(
    'await createFormRelationshipService({ db: supabase, tenantId }).validateSubmission({',
  );
  const groupIndex = source.indexOf('await validateFormOrganisationGroupAnswers({');
  const dependentIndex = source.indexOf(
    'await validateOrganisationGroupDependentOrganizationAnswers({',
  );
  const insertIndex = source.indexOf(".from('form_submission')");

  assert.ok(repeatableIndex >= 0);
  assert.ok(relationshipIndex > repeatableIndex);
  assert.ok(groupIndex > relationshipIndex);
  assert.ok(dependentIndex > groupIndex);
  assert.ok(insertIndex > dependentIndex);
});

test('manual submissions snapshot repeatable not-listed labels before persistence', () => {
  assert.match(
    source,
    /submission_data: snapshotFormNotListedLabels\(form\.fields \|\| \[\], submission_data \|\| \{\}\)/,
  );
  assert.match(source, /rulesUseLmicOperators\(form\.visibility_rules\)/);
  assert.match(source, /loadTenantLmicCodes\(supabase, tenantId\)/);
});

test('manual API sends raw hidden repeatable Not-listed rows to the real root relationship validator', () => {
  const relationshipValidation = source.slice(
    source.indexOf('await createFormRelationshipService({ db: supabase, tenantId }).validateSubmission({'),
    source.indexOf('\n    } catch (error)', source.indexOf(
      'await createFormRelationshipService({ db: supabase, tenantId }).validateSubmission({',
    )),
  );
  // Do not substitute a projected payload here: the shared validator must see
  // raw companion metadata and apply its row-local hidden set recursively.
  assert.match(relationshipValidation, /form,/);
  assert.match(relationshipValidation, /submissionData: submission_data \|\| \{\}/);
  assert.match(relationshipValidation, /hiddenFieldIds,/);
  // Storage also intentionally retains the raw hidden answer for restoration.
  assert.match(source, /submission_data: snapshotFormNotListedLabels\(form\.fields \|\| \[\], submission_data \|\| \{\}\)/);
});

test('manual submission UI delegates address lookup to the shared structured renderer', async () => {
  const dialogSource = readFileSync(
    path.join(here, '../../client/src/components/ManualSubmissionDialog.jsx'),
    'utf8',
  );
  assert.match(dialogSource, /if \(!\['file', 'signature'\]\.includes\(field\.type\)\)/);
  assert.match(dialogSource, /<FormRenderer[\s\S]*field=\{field\}/);
  assert.match(dialogSource, /isFieldValueFilled\(field, value\)/);
});