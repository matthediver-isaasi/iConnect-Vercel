import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { effectiveReviewSubmissionValues } from './reviewSubmissionValues.js';
import { FormRelationshipError } from '../_lib/formRelationshipOptions.js';

const source = readFileSync(new URL('./save-review.js', import.meta.url), 'utf8');
async function save(body, { stored = {}, invalid = false, tenant = 'tenant', missing = false } = {}) {
  const writes = [];
  const validations = [];
  const form = { fields: [{ id: 'org', name: 'Organisation', type: 'organisation_dropdown' }] };
  const row = {
    id: 'submission', tenant_id: 'tenant', reviewed_by: 'reviewer@example.invalid',
    original_form_values: { Organisation: 'Historical organisation name' },
    reviewed_form_values: stored, history_log: [],
    form_submission: { form_id: 'form' },
  };
  const db = { from(table) {
    const filters = [];
    let update;
    const result = () => {
      if (table === 'form') return { data: form };
      if (table === 'form_due_diligence_config') return { data: null };
      assert.equal(table, 'form_submission_due_diligence');
      const matches = !missing && filters.every(([key, value]) => row[key] === value);
      if (update && matches) writes.push(structuredClone(update));
      return { data: matches ? structuredClone(row) : null };
    };
    return {
      select() { return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      update(value) { update = value; return this; },
      async single() { return result(); },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
  } };
  const context = vm.createContext({
    supabase: db, isDeepStrictEqual, effectiveReviewSubmissionValues, FormRelationshipError,
    getSessionMember: async () => ({ email: 'reviewer@example.invalid' }),
    getTenantContext: async () => ({ tenantId: tenant }),
    rulesUseLmicOperators: () => false,
    computeAuthoritativeHiddenFieldIds: async () => { validations.push('visibility'); return new Set(); },
    validateFutureDateFields: () => [],
    validateRepeatableRowSubmission: async () => { validations.push('repeatable'); },
    createFormRelationshipService: () => ({
      validateSubmission: async ({ submissionData }) => {
        validations.push(structuredClone(submissionData));
        if (invalid) throw new FormRelationshipError(400, 'Invalid organization selection');
      },
    }),
    console: { log() {}, error() {} },
  });
  vm.runInContext(source.replace(/^import .*;\n/gm, '')
    .replace('export default async function handler', 'async function handler'), context);
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; } };
  await context.handler({ method: 'POST', body: { submissionId: 'submission', ...body } }, res);
  return { res, writes, validations };
}

test('note-only UI payload preserves historical answers without invoking answer validation', async () => {
  for (const stored of [{}, { org: 'Previously reviewed legacy name' }]) {
    const { res, writes, validations } = await save({
      reviewedFormValues: structuredClone(stored), fieldNotes: { org: 'Reviewer note' },
      fieldReviewStatus: { org: 'approved' },
    }, { stored, invalid: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(validations, []);
    assert.deepEqual(writes[0].reviewed_form_values, stored);
    assert.deepEqual(writes[0].field_notes, { org: 'Reviewer note' });
    assert.ok(writes.some(write => write.history_log?.length === 1));
  }
});

test('omitting reviewed values permits notes without replacing answers', async () => {
  const { res, writes, validations } = await save({ notes: 'Review note' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(validations, []);
  assert.equal('reviewed_form_values' in writes[0], false);
});

test('changed answers still validate before any note or answer is written', async () => {
  const { res, writes, validations } = await save({
    reviewedFormValues: { org: 'new-invalid-selection' }, fieldNotes: { org: 'Note' },
  }, { invalid: true });
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, 0);
  assert.deepEqual(validations.at(-1), { org: 'new-invalid-selection' });
});

test('removing a reviewed override validates the actual replacement, not a merged old answer', async () => {
  const { res, writes, validations } = await save({ reviewedFormValues: {} },
    { stored: { org: 'valid-old-id' }, invalid: true });
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, 0);
  assert.deepEqual(validations.at(-1), { org: 'Historical organisation name' });
});

test('valid answer changes are validated and persisted', async () => {
  const { res, writes, validations } = await save({ reviewedFormValues: { org: 'valid-new-id' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(validations.at(-1), { org: 'valid-new-id' });
  assert.deepEqual(writes[0].reviewed_form_values, { org: 'valid-new-id' });
});

test('malformed answer objects and foreign-tenant submissions cannot be saved', async () => {
  for (const value of [null, [], 'invalid']) {
    const { res, writes } = await save({ reviewedFormValues: value });
    assert.equal(res.statusCode, 400);
    assert.equal(writes.length, 0);
  }
  const { res, writes } = await save({ fieldNotes: { org: 'Note' } }, { tenant: 'other-tenant' });
  assert.equal(res.statusCode, 404);
  assert.equal(writes.length, 0);
});
