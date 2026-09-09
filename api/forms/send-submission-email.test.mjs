import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSendSubmissionEmail } from './send-submission-email.js';

function makeDatabase({
  formId = 'form-1',
  tenantId = 'tenant-1',
  submissionId = 'submission-1',
} = {}) {
  const form = {
    id: formId,
    tenant_id: tenantId,
    fields: [{ id: 'email', type: 'email' }],
    submission_emails: [],
  };
  const submission = {
    id: submissionId,
    form_id: formId,
    tenant_id: tenantId,
    submission_data: { email: 'persisted@example.test', first_name: 'Persisted' },
    created_member_id: 'persisted-member',
    created_organization_id: 'persisted-organization',
    organization_id: null,
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
    }
    select() { return this; }
    eq(column, value) { this.filters.push([column, value]); return this; }
    async single() {
      const row = this.table === 'form'
        ? form
        : this.table === 'form_submission'
          ? submission
          : null;
      const matches = row && this.filters.every(([column, value]) => row[column] === value);
      return matches
        ? { data: structuredClone(row), error: null }
        : { data: null, error: { code: 'PGRST116', message: 'Not found' } };
    }
  }

  return {
    client: { from(table) { return new Query(table); } },
    form,
    submission,
  };
}

function makeResponseRecorder() {
  const response = { statusCode: 200, body: null };
  return {
    response,
    res: {
      status(code) { response.statusCode = code; return this; },
      json(body) { response.body = body; return body; },
    },
  };
}

test('cached-client backstop requires a persisted submission id', async () => {
  const db = makeDatabase();
  const { response, res } = makeResponseRecorder();
  let senderCalled = false;

  await handleSendSubmissionEmail({
    method: 'POST',
    body: { form_id: db.form.id },
  }, res, {
    supabase: db.client,
    sendSubmissionEmailsGuarded: async () => {
      senderCalled = true;
      return { success: true, emails: [] };
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(senderCalled, false);
});

test('cached-client backstop binds form, tenant, values and linked records to the persisted row', async () => {
  const db = makeDatabase();
  const { response, res } = makeResponseRecorder();
  const calls = [];

  await handleSendSubmissionEmail({
    method: 'POST',
    headers: { origin: 'https://attacker.example' },
    body: {
      form_id: db.form.id,
      submission_id: db.submission.id,
      form_values: { email: 'attacker@example.test' },
      fields: [{ id: 'attacker-field', type: 'email' }],
      created_member_id: 'attacker-member',
      created_organization_id: 'attacker-organization',
    },
  }, res, {
    supabase: db.client,
    getTrustedBaseUrlForTenant: async () => 'https://tenant.iconn.app',
    sendSubmissionEmailsGuarded: async (options) => {
      calls.push(options);
      return { success: true, durable: true, emails: [] };
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].formValues, db.submission.submission_data);
  assert.deepEqual(calls[0].fields, db.form.fields);
  assert.equal(calls[0].createdMemberId, db.submission.created_member_id);
  assert.equal(calls[0].createdOrganizationId, db.submission.created_organization_id);
  assert.equal(calls[0].baseUrl, 'https://tenant.iconn.app');
  assert.equal(calls[0].allowUnguarded, false);
});

test('cached-client backstop refuses a submission outside the form and tenant', async () => {
  const db = makeDatabase();
  const { response, res } = makeResponseRecorder();
  let senderCalled = false;

  await handleSendSubmissionEmail({
    method: 'POST',
    body: {
      form_id: db.form.id,
      submission_id: 'submission-from-another-form',
    },
  }, res, {
    supabase: db.client,
    sendSubmissionEmailsGuarded: async () => {
      senderCalled = true;
      return { success: true, emails: [] };
    },
  });

  assert.equal(response.statusCode, 404);
  assert.equal(senderCalled, false);
});

test('force resend remains restricted to an admin of the persisted tenant', async () => {
  const db = makeDatabase();
  const { response, res } = makeResponseRecorder();
  let senderCalled = false;

  await handleSendSubmissionEmail({
    method: 'POST',
    body: {
      form_id: db.form.id,
      submission_id: db.submission.id,
      force_resend: true,
    },
  }, res, {
    supabase: db.client,
    getTrustedBaseUrlForTenant: async () => 'https://tenant.iconn.app',
    tenantContextModule: {
      getTenantContext: async () => ({ tenantId: 'other-tenant' }),
      hasAdminAccess: async () => true,
    },
    sendSubmissionEmailsGuarded: async () => {
      senderCalled = true;
      return { success: true, emails: [] };
    },
  });

  assert.equal(response.statusCode, 403);
  assert.equal(senderCalled, false);
});