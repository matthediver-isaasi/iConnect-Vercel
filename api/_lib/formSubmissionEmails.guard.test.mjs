import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  sendSubmissionEmails,
  sendSubmissionEmailsGuarded,
} from './formSubmissionEmails.js';

function makeEmailStateDb(initialState = null, {
  verificationError = null,
  loseOutcomeClaim = false,
} = {}) {
  const row = {
    id: 'submission-1',
    tenant_id: 'tenant-1',
    form_id: 'form-1',
    submission_data: { email: 'person@example.test' },
    created_member_id: 'member-1',
    created_organization_id: 'organization-1',
    organization_id: null,
    submission_email_state: initialState,
  };
  const submissionSelects = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.updatePayload = null;
      this.filters = [];
    }
    select(columns = '*') {
      if (this.table === 'form_submission') submissionSelects.push(columns);
      return this;
    }
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
        if (verificationError && this.filters.some(
          ([kind, column]) => kind === 'eq' && column === 'tenant_id',
        )) {
          return { data: null, error: verificationError };
        }
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
      // Simulate a newer sender taking ownership between delivery and its
      // outcome write.  The older worker must report a non-durable result.
      if (loseOutcomeClaim && this.filters.some(
        ([kind, column]) => kind === 'eq' && column === 'submission_email_state->>claim_id',
      )) {
        row.submission_email_state = {
          status: 'processing',
          claim_id: '00000000-0000-4000-8000-000000000099',
        };
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
        if (kind === 'eq' && column === 'submission_email_state->>claim_id') {
          return row.submission_email_state?.claim_id === value;
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
    submissionSelects,
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

test('configured email projects hidden row cells and metadata after raw chained visibility evaluation', async () => {
  const form = {
    id: 'row-email-form',
    tenant_id: 'tenant-1',
    fields: [{
      id: 'rows',
      type: 'repeatable_rows',
      children: [
        { id: 'mode', type: 'select', options: ['hide', 'show'] },
        {
          id: 'hidden-source',
          type: 'select',
          options: ['reveal', 'other'],
          row_visibility: { mode: 'hide_when', source_field_id: 'mode', value: 'hide' },
        },
        {
          id: 'visible-target',
          type: 'text',
          row_visibility: { mode: 'show_when', source_field_id: 'hidden-source', value: 'reveal' },
        },
      ],
    }],
    submission_emails: [{
      id: 'configured-row-email',
      template_id: 'template-1',
      // Capturing the repeatable placeholder as the recipient lets this
      // regression assert the exact email-side effective view without any
      // delivery credentials or network activity.
      recipient: '{{rows}}',
    }],
  };
  const db = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async single() {
          return table === 'email_template'
            ? { data: { subject: 'Row values', body: '{{rows}}' }, error: null }
            : { data: null, error: null };
        },
      };
    },
  };
  const result = await sendSubmissionEmails({
    supabase: db,
    form,
    formValues: {
      rows: [{
        _row_id: 'row-1',
        mode: 'hide',
        'hidden-source': 'reveal',
        'visible-target': 'safe target value',
        __not_listed_choice_text: { 'hidden-source': 'forged hidden metadata' },
        __not_listed_choice_labels: { 'hidden-source': 'Forged hidden label' },
      }],
    },
  });
  assert.equal(result.emails.length, 1);
  assert.deepEqual(result.emails[0].to, [{
    _row_id: 'row-1',
    mode: 'hide',
    'visible-target': 'safe target value',
  }]);
});

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

test('verification uses the production submission columns and persists the database failure reason', async () => {
  const db = makeEmailStateDb(null, {
    verificationError: {
      code: 'PGRST204',
      message: 'Could not find the requested submission row',
    },
  });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
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
          template_id: 'template-1',
          recipient: '{{email}}',
        }],
      },
      formValues: { email: 'caller@example.test' },
      fields: [{ id: 'email', type: 'email' }],
    });

    assert.equal(result.success, false);
    assert.equal(
      result.reason,
      'Persisted submission could not be verified: PGRST204: Could not find the requested submission row',
    );
    assert.equal(db.row.submission_email_state.status, 'failed');
    assert.equal(db.row.submission_email_state.reason, result.reason);
    assert.ok(db.submissionSelects.includes(
      'created_member_id, created_organization_id, organization_id, submission_data',
    ));
    assert.equal(db.submissionSelects.some(columns => /(^|,\s*)member_id(\s*,|$)/.test(columns)), false);
    assert.equal(logged.some(args => (
      args[0] === '[SubmissionEmails] Persisted submission verification failed'
      && args[1]?.submission_id === db.row.id
      && args[1]?.database_code === 'PGRST204'
    )), true);
    assert.equal(JSON.stringify(logged).includes('person@example.test'), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test('guarded email outcome is fenced to its processing claim and stale sends require attention', () => {
  const source = readFileSync(new URL('./formSubmissionEmails.js', import.meta.url), 'utf8');
  assert.match(source, /recordOutcome\(supabase, submissionId, state, claimId = state\?\.claim_id \|\| null\)/);
  assert.match(source, /\.eq\('submission_email_state->>claim_id', claimId\)/);
  assert.match(source, /mark_stale_submission_email_attention/);
  assert.match(source, /requiresAttention: attentionRequired/);
});

test('a persisted email attention outcome is terminal, not a successful skipped send', async () => {
  const db = makeEmailStateDb({
    status: 'attention',
    claim_id: '00000000-0000-4000-8000-000000000088',
    reason: 'delivery outcome was ambiguous',
  });
  const result = await sendSubmissionEmailsGuarded({
    supabase: db.client,
    submissionId: db.row.id,
    form: { id: db.row.form_id, tenant_id: db.row.tenant_id, submission_emails: [] },
    formValues: db.row.submission_data,
    fields: [],
    allowUnguarded: false,
  });
  assert.equal(result.success, false);
  assert.equal(result.requiresAttention, true);
  assert.equal(result.alreadyProcessed, false);
  assert.equal(result.state.status, 'attention');
});

test('a transient stale-attention write failure stays non-successful and recovers terminally once attention persists', async () => {
  const db = makeEmailStateDb({
    status: 'processing',
    claim_id: '00000000-0000-4000-8000-000000000089',
    claimed_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
  });
  const options = {
    supabase: db.client,
    submissionId: db.row.id,
    form: { id: db.row.form_id, tenant_id: db.row.tenant_id, submission_emails: [] },
    formValues: db.row.submission_data,
    fields: [],
    allowUnguarded: false,
  };
  const duringWriteFailure = await sendSubmissionEmailsGuarded(options);
  assert.equal(duringWriteFailure.success, false);
  assert.equal(duringWriteFailure.inProgress, true);

  db.row.submission_email_state = {
    status: 'attention',
    claim_id: db.row.submission_email_state.claim_id,
  };
  const recovered = await sendSubmissionEmailsGuarded(options);
  assert.equal(recovered.success, false);
  assert.equal(recovered.requiresAttention, true);
});

test('a zero-row fenced outcome write is not reported as durable', async () => {
  const db = makeEmailStateDb(null, { loseOutcomeClaim: true });
  const result = await sendSubmissionEmailsGuarded({
    supabase: db.client,
    submissionId: db.row.id,
    form: { id: db.row.form_id, tenant_id: db.row.tenant_id, submission_emails: [] },
    formValues: db.row.submission_data,
    fields: [],
    allowUnguarded: false,
  });
  assert.equal(result.success, true);
  assert.equal(result.durable, false);
  assert.equal(db.row.submission_email_state.claim_id, '00000000-0000-4000-8000-000000000099');
});
