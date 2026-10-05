import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { prepareSwapAnswers, swapValidationResponse, swapSourceAnswer } from './_swapAnswers.js';

const tenantId = 'fixture-tenant';
const linked = '11111111-1111-4111-8111-111111111111';
const stale = '22222222-2222-4222-8222-222222222222';
const org = { id: 'org', label: 'Name of organisation', type: 'organisation_dropdown', locked: true, prefill_field: 'org:name', required: true };
function fixture() {
  const sourceForm = { id: 'source', name: 'Source', due_diligence_required: true, fields: [org, { id: 'text', label: 'Notes', type: 'text' }] };
  const targetForm = { ...structuredClone(sourceForm), id: 'target', name: 'ESO Long form' };
  const sourceDDSubmission = {
    id: 'dd', tenant_id: tenantId, form_submission_id: 'fs',
    reviewed_form_values: { org: stale },
    original_form_values: { org: stale, text: 'Retained' },
    form_submission: { id: 'fs', tenant_id: tenantId, form_id: 'source', organization_id: linked, submission_data: { org: linked } },
  };
  const tables = {
    organization: [{ id: linked, tenant_id: tenantId }],
    form: [sourceForm, targetForm],
    form_submission_due_diligence: [sourceDDSubmission],
    form_due_diligence_config: [{ id: 'config', tenant_id: tenantId, form_id: 'target', workflow_stages: [{ id: 'new', is_initial: true, actions: [{}] }] }],
    contract_instance: [],
  };
  for (const form of tables.form) form.tenant_id = tenantId;
  const writes = [];
  const db = { from(table) {
    const filters = []; let write; let single = false;
    const q = {
      select() { return q; }, eq(k, v) { filters.push(row => row[k] === v); return q; },
      in(k, v) { filters.push(row => v.includes(row[k])); return q; },
      is(k, v) { filters.push(row => (row[k] ?? null) === v); return q; },
      insert(data) { write = { operation: 'insert', table, data }; return q; },
      update(data) { write = { operation: 'update', table, data }; return q; },
      delete() { write = { operation: 'delete', table }; return q; },
      single() { single = true; return q; }, maybeSingle() { single = true; return q; },
      then(resolve, reject) {
        if (write) writes.push(write);
        const rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
        return Promise.resolve({ data: write?.operation === 'insert'
          ? { ...write.data, id: `new-${table}` } : single ? rows[0] || null : rows, error: null }).then(resolve, reject);
      },
    };
    return q;
  } };
  return { db, tenantId, sourceDDSubmission, sourceForm, targetForm, tables, writes };
}

async function endpoint(name, f) {
  const source = await readFile(new URL(`./swap-${name}.js`, import.meta.url), 'utf8');
  let actions = 0;
  const handler = vm.runInNewContext(
    source.replace(/^import .*;\n/gm, '').replace('export default async function handler', 'async function handler') + '\nhandler',
    { supabase: f.db, getSessionMember: async () => ({ email: 'reviewer@example.invalid' }),
      getTenantContext: async () => ({ tenantId }), prepareSwapAnswers, swapValidationResponse,
      swapSourceAnswer, executeStageActions: async () => { actions++; return { stage_actions_results: [{}] }; }, console },
  );
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'POST', body: { sourceSubmissionId: 'dd', targetFormId: 'target' } }, res);
  return { ...res, actions };
}

test('redacted GSF stale snapshot is resolved from matching persisted raw answer and applicant link', async () => {
  const f = fixture();
  const result = await prepareSwapAnswers(f);
  assert.equal(result.canSwap, true);
  assert.deepEqual(result.values, { org: linked, text: 'Retained' });
  assert.equal(result.fieldMapping.mapped[0].resolvedFromApplicant, true);
  assert.equal(f.writes.length, 0);
});

test('partial review falls back per field; explicit null, empty string and empty array never fall back', async () => {
  for (const value of [null, '', []]) {
    const f = fixture();
    f.sourceDDSubmission.reviewed_form_values = { text: value };
    const result = await prepareSwapAnswers(f);
    assert.deepEqual(result.values.text, value);
    assert.equal(result.values.org, linked);
  }
});

test('canonical ID retained; deliberate edits, foreign records and missing raw evidence are rejected', async () => {
  const valid = fixture();
  valid.sourceDDSubmission.reviewed_form_values.org = linked;
  assert.equal((await prepareSwapAnswers(valid)).canSwap, true);
  for (const change of [
    f => { f.sourceDDSubmission.reviewed_form_values.org = '33333333-3333-4333-8333-333333333333'; },
    f => { f.tables.organization.push({ id: stale, tenant_id: 'foreign' }); },
    f => { f.sourceDDSubmission.form_submission.submission_data = {}; },
    f => { f.sourceDDSubmission.reviewed_form_values.org = { name: 'Not a record ID' }; },
    f => { f.sourceDDSubmission.reviewed_form_values.org = 'A legacy name'; },
    f => { f.targetForm.fields[0].org_filter = { type: 'core', field: 'status', values: ['approved'] }; },
  ]) {
    const f = fixture(); change(f);
    const result = await prepareSwapAnswers(f);
    assert.equal(result.canSwap, false);
    assert.equal(result.problems[0].fieldId, 'org');
    assert.equal(f.writes.length, 0);
  }
});

test('email and saved email custom-field metadata map compatibly in both directions', async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    const email = { id: 'email', label: 'Applicant email', type: 'email' };
    const custom = { ...email, type: 'custom_field', custom_field_id: 'email-preference' };
    f.sourceForm.fields.push(reverse ? custom : email);
    f.targetForm.fields.push(reverse ? email : custom);
    f.tables.preference_field = [{ id: 'email-preference', tenant_id: tenantId, field_type: 'email' }];
    f.sourceDDSubmission.reviewed_form_values.email = 'applicant@example.invalid';
    assert.equal((await prepareSwapAnswers(f)).canSwap, true);
  }
});

test('incompatible visible types block; hidden incompatible answers follow authoritative visibility', async () => {
  const f = fixture();
  f.targetForm.fields[1].type = 'number';
  assert.equal((await prepareSwapAnswers(f)).canSwap, false);
  f.targetForm.fields[1].starts_hidden = true;
  assert.equal((await prepareSwapAnswers(f)).canSwap, true);
});

test('ordinary endpoints share preparation; valid execution retains applicant, archive and stage action behavior', async () => {
  const f = fixture();
  const preview = await endpoint('preview', f);
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.preview.canSwap, true);
  assert.equal(f.writes.length, 0);
  const executed = await endpoint('execute', f);
  assert.equal(executed.statusCode, 201);
  assert.equal(executed.actions, 1);
  const insert = f.writes.find(w => w.table === 'form_submission');
  assert.equal(insert.data.organization_id, linked);
  assert.deepEqual(insert.data.submission_data, { org: linked, text: 'Retained' });
  assert.ok(f.writes.find(w => w.table === 'form_submission_due_diligence' && w.operation === 'update').data.archived_at);
});

test('rejected preview and confirmation have identical problems and zero writes/actions', async () => {
  const f = fixture();
  f.sourceDDSubmission.reviewed_form_values.org = 'invalid';
  const preview = await endpoint('preview', f);
  const executed = await endpoint('execute', f);
  assert.equal(preview.body.preview.canSwap, false);
  assert.equal(executed.statusCode, 400);
  assert.deepEqual(executed.body.details, preview.body.preview.problems);
  assert.equal(executed.actions, 0);
  assert.equal(f.writes.length, 0);
});

test('valid swap relinks matching contracts without changing the contract selection behavior', async () => {
  const f = fixture();
  f.sourceForm.fields.push({ id: 'old-contact', label: 'Contact', type: 'contact', contract_form_id: 'contract-form' });
  f.targetForm.fields.push({ id: 'new-contact', label: 'Contact', type: 'contact', contract_form_id: 'contract-form' });
  f.tables.contract_instance.push({ id: 'contract', tenant_id: tenantId, form_submission_id: 'fs', form_id: 'contract-form', source_contact_field_id: 'old-contact', status: 'pending' });
  const result = await endpoint('execute', f);
  assert.equal(result.statusCode, 201);
  const relink = f.writes.find(w => w.table === 'contract_instance');
  assert.equal(relink.data.source_contact_field_id, 'new-contact');
  assert.equal(relink.data.form_submission_id, 'new-form_submission');
});

test('relationship parent failures and conditional exclusions are field-specific and write-free', async () => {
  for (const conditional of [false, true]) {
    const f = fixture();
    if (conditional) {
      f.targetForm.fields[0].conditional_filters = { version: 1, rules: [{
        is_fallback: true, allowed_values: [linked], allowed_values_mode: 'exclude',
      }] };
    } else {
      f.sourceDDSubmission.reviewed_form_values.org = '';
      const field = { id: 'related', label: 'Department', type: 'relationship_dropdown',
        parent_field_id: 'org', relationship_definition_id: 'definition',
        related_kind: 'custom_object', related_custom_object_id: 'object', related_primary_display_field_id: 'name' };
      f.sourceForm.fields.push(field);
      f.targetForm.fields.push({ ...field });
      f.sourceDDSubmission.reviewed_form_values.related = 'record';
    }
    const result = await endpoint('execute', f);
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.details[0].fieldId, conditional ? 'org' : 'related');
    assert.equal(f.writes.length, 0);
    assert.equal(result.actions, 0);
  }
});

test('Other answers, normalized options and long-text aliases pass preparation and both endpoints', async () => {
  for (const variant of ['other', 'option-id', 'numeric-option', 'long-text']) {
    const f = fixture();
    const field = { id: 'answer', label: 'Answer', type: 'select', options: ['Listed'], allow_other: true };
    let value = 'My free-text other answer';
    if (variant === 'option-id') { field.options = [{ id: 'choice', label: 'Choice' }]; value = 'choice'; field.allow_other = false; }
    if (variant === 'numeric-option') { field.options = [42]; value = '42'; field.allow_other = false; }
    if (variant === 'long-text') field.type = 'textarea';
    f.sourceForm.fields.push(field);
    f.targetForm.fields.push(variant === 'long-text'
      ? { ...field, type: 'custom_field', custom_field_id: 'long' } : { ...field });
    f.tables.preference_field = [{ id: 'long', tenant_id: tenantId, field_type: 'long_text' }];
    f.sourceDDSubmission.reviewed_form_values.answer = value;
    assert.equal((await prepareSwapAnswers(f)).canSwap, true, variant);
    assert.equal((await endpoint('preview', f)).body.preview.canSwap, true, variant);
    assert.equal((await endpoint('execute', f)).statusCode, 201, variant);
    assert.equal(f.writes.find(w => w.table === 'form_submission').data.submission_data.answer, value);
  }
});

test('Other remains subject to target conditional rules', async () => {
  const f = fixture();
  const field = { id: 'answer', label: 'Choice', type: 'select', options: ['Listed'], allow_other: true,
    conditional_filters: { version: 1, rules: [{ is_fallback: true, allowed_values: ['Listed'] }] } };
  f.sourceForm.fields.push(field); f.targetForm.fields.push({ ...field });
  f.sourceDDSubmission.reviewed_form_values.answer = 'Other text';
  assert.equal((await endpoint('preview', f)).body.preview.canSwap, false);
  assert.equal((await endpoint('execute', f)).statusCode, 400);
  assert.equal(f.writes.length, 0);
});

test('all repeatable aliases and nested schemas reject differently keyed children before writes', async () => {
  for (const type of ['repeatable_row', 'repeatable_rows', 'repeatable_grid']) {
    for (const nested of [false, true]) {
      const f = fixture();
      const makeField = childId => ({ id: 'rows', label: 'Rows', type,
        ...(nested
          ? { repeatable_row: { child_fields: [{ id: childId, type: 'text', label: 'Item' }] } }
          : { child_fields: [{ id: childId, type: 'text', label: 'Item' }] }),
      });
      f.sourceForm.fields.push(makeField('old-child'));
      f.targetForm.fields.push(makeField('new-child'));
      f.sourceDDSubmission.reviewed_form_values.rows = [{ _row_id: 'row-1', 'old-child': 'Retain me' }];
      assert.equal((await prepareSwapAnswers(f)).canSwap, false, `${type}/${nested}`);
      assert.equal((await endpoint('preview', f)).body.preview.canSwap, false);
      assert.equal((await endpoint('execute', f)).statusCode, 400);
      assert.equal(f.writes.length, 0);
    }
  }
});
