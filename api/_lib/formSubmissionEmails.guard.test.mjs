import assert from 'node:assert/strict';
import test from 'node:test';
import { sendSubmissionEmailsGuarded } from './formSubmissionEmails.js';

function makeEmailStateDb(initialState = null) {
  const row = {
    id: 'submission-1',
    tenant_id: 'tenant-1',
    form_id: 'form-1',
    submission_data: { email: 'person@example.test' },
    submission_email_state: initialState,
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.updatePayload = null;
      this.filters = [];
    }
    select() { return this; }
    update(payload) { this.updatePayload = payload; return this; }
    eq(column, value) { this.filters.push(['eq', column, value]); return this; }
    is(column, value) { this.filters.push(['is', column, value]); return this; }
    neq(column, value) { this.filters.push(['neq', column, value]); return this; }
    or(expression) { this.filters.push(['or', expression]); return this; }
    not() { return this; }
    in() { return this; }
    order() { return this; }
    limit() { return this; }
    async single() {
      if (this.table === 'form_submission') {
        return { data: structuredClone(row), error: null };
      }
      if (this.table === 'email_template') {
        return {
          data: null,
          error: { code: 'PGRST116', message: 'Email template not found' },
        };
      }
      return { data: null, error: null };
    }
    async maybeSingle() {
      if (this.table === 'form_submission') {
        return { data: structuredClone(row), error: null };
      }
      return { data: null, error: null };
    }
    then(resolve, reject) {
      if (this.table !== 'form_submission' || !this.updatePayload) {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      }
      const idMatches = this.filters.every(([kind, column, value]) => {
        if (kind === 'eq' && column === 'id') return row.id === value;
        if (kind === 'is' && column === 'submission_email_state') {
          return value === null && row.submission_email_state === null;
        }
        if (kind === 'neq' && column === 'submission_email_state->>status') {
          return row.submission_email_state?.status !== value;
        }
        if (kind === 'eq' && column === 'submission_email_state->>status') {
          return row.submission_email_state?.status === value;
        }
        if (kind === 'or') {
          return row.submission_email_state === null
            || row.submission_email_state?.status === 'ready';
        }
        return true;
      });
      if (!idMatches) {
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      }
      row.submission_email_state = structuredClone(this.updatePayload.submission_email_state);
      return Promise.resolve({ data: [{ id: row.id }], error: null }).then(resolve, reject);
    }
  }

  return {
    row,
    client: {
      from(table) { return new Query(table); },
    },
  };
}

const diagnostics = {
  surface: 'embed',
  route: '/api/public/form-submission',
  request_host: 'tenant.iconn.app',
  referrer_host: 'tenant.iconn.app',
  referrer_route: '/embed/form/:form',
  deployment_id: 'deployment-1',
  git_commit_sha: 'abc123',
};

test('guard records a terminal skipped state with embed request diagnostics exactly once', async () => {
  const db = makeEmailStateDb();
  const options = {
    supabase: db.client,
    submissionId: db.row.id,
    trigger: 'server',
    diagnostics,
    form: {
      id: 'form-1',
      tenant_id: 'tenant-1',
      fields: [],
      submission_emails: [],
    },
    formValues: {},
    fields: [],
  };

  const first = await sendSubmissionEmailsGuarded(options);
  const second = await sendSubmissionEmailsGuarded({
    ...options,
    trigger: 'client',
  });

  assert.equal(first.skipped, true);
  assert.equal(first.reason, 'No emails configured');
  assert.equal(second.skipped, true);
  assert.equal(second.alreadyProcessed, true);
  assert.equal(db.row.submission_email_state.status, 'skipped');
  assert.equal(db.row.submission_email_state.trigger, 'server');
  assert.deepEqual(db.row.submission_email_state.request_context, diagnostics);
});

test('guard records a terminal failed state when configured delivery cannot resolve its template', async () => {
  const db = makeEmailStateDb();
  const result = await sendSubmissionEmailsGuarded({
    supabase: db.client,
    submissionId: db.row.id,
    trigger: 'server',
    diagnostics,
    form: {
      id: 'form-1',
      name: 'Newsletter',
      tenant_id: 'tenant-1',
      fields: [{ id: 'email', type: 'email' }],
      submission_emails: [{
        id: 'submission-email-1',
        template_id: 'missing-template',
        recipient: '{{email}}',
      }],
    },
    formValues: { email: 'person@example.test' },
    fields: [{ id: 'email', type: 'email' }],
  });

  assert.equal(result.success, false);
  assert.equal(db.row.submission_email_state.status, 'failed');
  assert.equal(db.row.submission_email_state.trigger, 'server');
  assert.deepEqual(db.row.submission_email_state.request_context, diagnostics);
  assert.equal(db.row.submission_email_state.emails[0].error, 'Template not found');
});