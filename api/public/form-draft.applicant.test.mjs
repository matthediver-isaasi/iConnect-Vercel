import test from 'node:test';
import assert from 'node:assert/strict';
import handler from './form-draft.js';
import {
  applicantConfigurationDigest, hashApplicantToken, verifyApplicantContinuation,
  bindApplicantContinuation, loadSubmissionApplicantContinuation,
} from '../_lib/formApplicantContinuation.js';

function harness() {
  const form = { id: 'form', tenant_id: 'tenant', is_active: true, slug: 'application',
    fields: [], mutation_access_policy: { version: 1, mode: 'applicant_continuation' } };
  const token = 'a'.repeat(43);
  const grant = { id: 'grant', tenant_id: 'tenant', form_id: form.id, organization_id: 'org',
    token_hash: hashApplicantToken(token), expires_at: '2099-01-01T00:00:00Z',
    configuration_digest: applicantConfigurationDigest(form), draft_token_hashes: [] };
  const tables = { form: [form], form_applicant_continuation: [grant],
    form_draft_submission: [], form_submission: [] };
  class Query {
    constructor(table) { this.table = table; this.predicates = []; }
    select() { return this; }
    eq(key, value) { this.predicates.push(row => row[key] === value); return this; }
    contains(key, values) { this.predicates.push(row => values.every(value => row[key]?.includes(value))); return this; }
    insert(data) { this.inserted = data; return this; }
    update(data) { this.updated = data; return this; }
    result(single = false) {
      if (this.inserted) tables[this.table].push({ id: 'draft', ...structuredClone(this.inserted) });
      const rows = (tables[this.table] || []).filter(row => this.predicates.every(predicate => predicate(row)));
      if (this.updated) rows.forEach(row => Object.assign(row, structuredClone(this.updated)));
      return { data: structuredClone(single ? rows[0] || null : rows), error: null };
    }
    async single() { return this.result(true); }
    async maybeSingle() { return this.result(true); }
    then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
  }
  const db = {
    from: table => new Query(table),
    async rpc(name, args) {
      assert.equal(args.p_grant_id, grant.id);
      if (name === 'bind_form_applicant_draft') {
        grant.draft_token_hashes.push(args.p_token_hash);
        return { data: true };
      }
      assert.equal(name, 'bind_form_applicant_continuation');
      if (grant.submission_id && grant.submission_id !== args.p_submission_id) return { data: false };
      grant.submission_id = args.p_submission_id;
      grant.bound_at = new Date().toISOString();
      return { data: true };
    },
  };
  async function invoke(method, body = {}, query = {}) {
    const response = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; } };
    await handler({ method, body, query, headers: { host: 'tenant.example.test' } }, response,
      { supabase: db, tenantData: { id: 'tenant', slug: 'tenant' } });
    return response;
  }
  return { form, token, grant, tables, db, invoke };
}

test('public draft save/resume persists only hashed capability and keeps answers across updates', async () => {
  const h = harness();
  const saved = await h.invoke('POST', { form_id: h.form.id, draft_data: { answer: 'first' },
    applicant_continuation_token: h.token });
  assert.equal(saved.statusCode, 201);
  const resumeToken = saved.payload.resume_token;
  assert.ok(resumeToken);
  assert.equal(JSON.stringify(h.tables).includes(h.token), false);
  assert.equal(JSON.stringify(h.tables).includes(resumeToken), false);
  const resumed = await h.invoke('GET', {}, { token: resumeToken });
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.payload.applicant_continuation.organization_id, 'org');
  assert.deepEqual(resumed.payload.draft.draft_data, { answer: 'first' });
  const updated = await h.invoke('POST', { form_id: h.form.id,
    draft_data: { answer: 'revised' }, resume_token: resumeToken });
  assert.equal(updated.statusCode, 200);
  const grant = await verifyApplicantContinuation({ db: h.db, form: h.form, resumeToken });
  await bindApplicantContinuation({ db: h.db, form: h.form, grant, submissionId: 'submission' });
  await bindApplicantContinuation({ db: h.db, form: h.form, grant, submissionId: 'submission' });
  assert.equal((await loadSubmissionApplicantContinuation({
    db: h.db, form: h.form, submissionId: 'submission',
  })).organization_id, 'org');
  await assert.rejects(bindApplicantContinuation({
    db: h.db, form: h.form, grant, submissionId: 'different-submission',
  }));
});

test('forged draft grant ID does not substitute for server-persisted resume hash', async () => {
  const h = harness();
  const saved = await h.invoke('POST', { form_id: h.form.id, draft_data: { answer: 'kept' } });
  assert.equal(saved.statusCode, 201);
  h.tables.form_draft_submission[0].applicant_continuation_id = h.grant.id;
  const resumed = await h.invoke('GET', {}, { token: saved.payload.resume_token });
  assert.equal(resumed.statusCode, 403);
});

test('changed form configuration invalidates saved applicant draft authority', async () => {
  const h = harness();
  const saved = await h.invoke('POST', { form_id: h.form.id, draft_data: {},
    applicant_continuation_token: h.token });
  h.form.default_member_role_id = 'changed-role';
  const resumed = await h.invoke('GET', {}, { token: saved.payload.resume_token });
  assert.equal(resumed.statusCode, 403);
});