import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import handler from './process-application.js';
import { finalizeFormSubmission } from '../_lib/formPaymentFinalize.js';
import { buildFormProcessingHeaders } from '../_lib/formProcessingAuth.js';
import { buildStripeAddressTargetResolution } from '../../shared/formStripeAddressMappings.js';

const source = await readFile(new URL('./process-application.js', import.meta.url), 'utf8');
const structuredActionsSource = await readFile(new URL('../_lib/formStructuredActions.js', import.meta.url), 'utf8');

test('Stripe address mappings run after normal and related-record mappings', () => {
  const related = source.lastIndexOf('const relatedRecords = await processPrimaryPipelineRelatedRecords');
  const stripe = source.lastIndexOf('const stripeAddressMappings = await processPersistedStripeAddressMappings');
  const completion = source.lastIndexOf('updatePayload.entity_processing_completed_at');
  assert.ok(related >= 0 && stripe > related && completion > stripe);
});

test('entity creation provenance is persisted immediately for both primary targets', () => {
  assert.match(source, /persistEntityCreationProvenance\('organization', orgInsertData\.id\)[\s\S]{0,400}\.from\('organization'\)\s*\.insert\(orgInsertData\)/);
  assert.match(source, /persistEntityCreationProvenance\('member', memberInsertData\.id\)[\s\S]{0,400}\.from\('member'\)\s*\.insert\(memberInsertData\)/);
});

test('row-effective mappings do not replace raw answers for role or structured-rule evaluation', () => {
  // A row-hidden source may itself control a visible target. The mapping view
  // omits that source, so sending form_values back through either evaluator
  // would evaluate the target a second time against incomplete answers.
  assert.match(source, /form_values = effectiveRepeatableRowSubmissionData\(\s*persistedForm,\s*authoritativeAnswers,/);
  assert.match(source, /derivePersistedFormRole\(\{[\s\S]*?answers: authoritativeAnswers,/);
  assert.match(source, /resolveMemberRoleAssignment\(\{[\s\S]*?answers: authoritativeAnswers,/);

  const structuredCall = source.slice(
    source.indexOf('const structuredResult = await processPersistedStructuredActions({'),
    source.indexOf('if (structuredResult?.success === false)'),
  );
  assert.match(structuredCall, /submissionId: submission_id/);
  assert.doesNotMatch(structuredCall, /form_values/);
  // The persisted-action executor reloads submission_data itself; this keeps
  // the raw chained visibility source available to its row projection.
  assert.match(structuredActionsSource, /const answers = submission\?\.submission_data \|\| \{\};/);
});

test('failed post-insert retries adopt verified provenance before email/name resolution', () => {
  assert.match(source, /loadPersistedFormEntityCreations\(\{[\s\S]*submissionId: submission_id/);
  assert.match(source, /effectivePrefillOrgId = persistedCreatedOrganizationId \|\| prefill_organization_id/);
  assert.match(source, /effectivePrefillMemberId = persistedCreatedMemberId \|\| prefill_member_id/);
  assert.match(source, /organization: new Set\(persistedEntityCreations\.organization\)/);
  assert.match(source, /\.\.\.persistedEntityCreations\.member/);
});

test('completed address ledger bypasses every normal processing side effect', () => {
  const ledger = source.indexOf("from('form_stripe_address_mapping_ledger')");
  const structured = source.indexOf('processPersistedStructuredActions({');
  const organizationProcessing = source.indexOf('// Process organization based on orgAction');
  assert.ok(ledger >= 0 && ledger < structured && ledger < organizationProcessing);
  const completedBranch = source.slice(ledger, structured);
  assert.match(completedBranch, /if \(completedAddressMapping\) \{[\s\S]*return res\.json/);
});

test('target-resolution signature drift rejects before processor side effects', () => {
  const ledger = source.indexOf("from('form_stripe_address_mapping_ledger')");
  const signature = source.indexOf('validateStripeAddressTargetResolution(', ledger);
  const structured = source.indexOf('processPersistedStructuredActions({');
  assert.ok(ledger >= 0 && signature > ledger && signature < structured);
  assert.match(source.slice(signature, structured), /STRIPE_ADDRESS_TARGET_RESOLUTION_DRIFT/);
});

for (const resolved of [false, true]) {
  test(`monthly first-payment address wait completes ordinary processing (${resolved ? 'resolved' : 'normal'} path)`, async () => {
    const form = stripeLeaseForm();
    const db = createHandlerDatabase({
      form,
      submission: monthlyFirstPaymentPendingSubmission(form, { resolved }),
    });
    const result = await invokeHandlerWithDb(db);

    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    assert.notEqual(result.response.body.success, false);
    assert.equal(result.response.body.addressAwaitingFirstPayment, true);
    assert.equal(result.response.body.stripe_address_mappings?.pending, true);
    assert.equal(result.response.body.stripe_address_mappings?.reason, 'first_payment_not_paid');
    assert.equal(db.submission.payment_meta.stripe_address_mappings_pending, true);
    assert.equal(db.submission.payment_meta.stripe_address_mappings_result?.reason, 'first_payment_not_paid');
    assert.equal(
      db.calls.some(call => call.name === 'release_form_stripe_address_mapping_processing'),
      true,
      'the nonblocking wait must still release the address lease',
    );
  });
}

test('monthly address validation errors remain blocking instead of becoming a first-payment wait', async () => {
  const form = stripeLeaseForm();
  const submission = monthlyFirstPaymentPendingSubmission(form);
  delete submission.payment_meta.stripe_billing_address;
  const db = createHandlerDatabase({ form, submission });
  const result = await invokeHandlerWithDb(db);

  assert.equal(result.response.statusCode, 409, JSON.stringify(result.response.body));
  assert.equal(result.response.body.code, 'STRIPE_ADDRESS_MAPPINGS_INCOMPLETE');
  assert.notEqual(result.response.body.addressAwaitingFirstPayment, true);
});

/*
 * These tests deliberately exercise the handler rather than extracting the
 * lease helper. Supabase's PostgREST query builders are thenables, but are not
 * Promise instances: an RPC builder does not necessarily have `.catch()`.
 * The fake below keeps that distinction so a cleanup implementation that calls
 * `supabase.rpc(...).catch(...)` fails like it would against the real client.
 */
const ADDRESS_TENANT_ID = 'tenant-stripe-lease-test';
const ADDRESS_FORM_ID = 'form-stripe-lease-test';
const ADDRESS_SUBMISSION_ID = 'submission-stripe-lease-test';
const ADDRESS_ORGANIZATION_ID = 'organization-stripe-lease-test';

function thenable(value, { reject = false, onSettled = null } = {}) {
  const builder = {
    then(resolve, rejectCallback) {
      Promise.resolve().then(() => {
        onSettled?.();
        if (reject) return rejectCallback(value);
        return resolve(value);
      });
    },
  };
  assert.equal(typeof builder.catch, 'undefined');
  return builder;
}

function stripeLeaseForm() {
  return {
    id: ADDRESS_FORM_ID,
    tenant_id: ADDRESS_TENANT_ID,
    pages: [],
    visibility_rules: [],
    fields: [],
    field_mappings: [],
    application_level: 'organization',
    auto_create_entity: false,
    create_entity_type: 'organization',
    entity_action: 'none',
    member_entity_action: 'none',
    organization_entity_action: 'none',
    additional_member_creations: [],
    entity_pipelines: { members: [], organisations: [] },
    structured_actions: null,
    default_member_role_id: null,
  };
}

function stripeLeaseSubmission(form, {
  stripeAddressMappings = true,
  organizationId = ADDRESS_ORGANIZATION_ID,
  paymentMeta = {},
} = {}) {
  const mappings = stripeAddressMappings
    ? [{
      source: 'formatted',
      target_entity: 'organization',
      target_type: 'core',
      target_field: 'invoicing_address',
    }]
    : [];
  return {
    id: ADDRESS_SUBMISSION_ID,
    form_id: form.id,
    tenant_id: form.tenant_id,
    submission_data: {},
    submitted_by_email: null,
    organization_id: organizationId,
    created_member_id: null,
    created_organization_id: null,
    entity_processing_completed_at: null,
    payment_reference: null,
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_meta: {
      verified_submitter_member_id: null,
      verified_admin_access: true,
      ...(stripeAddressMappings ? {
        stripe_address_mapping_config: {
          version: 1,
          mappings,
          target_resolution: buildStripeAddressTargetResolution(form, mappings),
        },
        stripe_billing_address: {
          line1: '10 High Street',
          line2: null,
          city: 'Leeds',
          state: null,
          postal_code: 'LS1 1AA',
          country: 'GB',
          formatted: '10 High Street\nLeeds\nLS1 1AA\nGB',
        },
      } : {}),
      ...paymentMeta,
    },
    processing_notes: [],
    submission_email_state: null,
  };
}

function monthlyFirstPaymentPendingSubmission(form, {
  resolved = false,
} = {}) {
  const submission = stripeLeaseSubmission(form, {
    paymentMeta: {
      monthly_card: {
        agreement_id: 'agreement-monthly-address-wait',
      },
    },
  });
  submission.payment_provider = 'stripe_monthly_card';
  submission.payment_status = 'setup_complete';
  if (resolved) {
    submission.created_member_id = 'member-monthly-address-wait';
    submission.created_organization_id = ADDRESS_ORGANIZATION_ID;
    submission.entity_processing_completed_at = '2026-01-01T00:00:00.000Z';
  }
  return submission;
}

class HandlerQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.selected = null;
    this.operation = null;
    this.payload = null;
  }

  select(columns = '*') {
    this.selected = columns;
    return this;
  }

  eq(column, value) {
    this.filters.push(['eq', column, value]);
    return this;
  }

  neq(column, value) {
    this.filters.push(['neq', column, value]);
    return this;
  }

  ilike(column, value) {
    this.filters.push(['ilike', column, value]);
    return this;
  }

  in(column, value) {
    this.filters.push(['in', column, value]);
    return this;
  }

  is(column, value) {
    this.filters.push(['is', column, value]);
    return this;
  }

  or(value) {
    this.filters.push(['or', value]);
    return this;
  }

  filter(...value) {
    this.filters.push(['filter', ...value]);
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  insert(payload) {
    this.operation = 'insert';
    this.payload = payload;
    return this;
  }

  upsert(payload) {
    this.operation = 'upsert';
    this.payload = payload;
    return this;
  }

  update(payload) {
    this.operation = 'update';
    this.payload = payload;
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  async maybeSingle() {
    return this.db.executeQuery(this, 'maybeSingle');
  }

  async single() {
    return this.db.executeQuery(this, 'single');
  }

  then(resolve, reject) {
    return Promise.resolve(this.db.executeQuery(this, 'many')).then(resolve, reject);
  }
}

function createHandlerDatabase({
  releaseMode = 'success',
  primaryError = null,
  form = stripeLeaseForm(),
  submission = stripeLeaseSubmission(form),
} = {}) {
  const calls = [];
  const releaseState = { settled: false };
  let leaseToken = null;

  const db = {
    calls,
    form,
    submission,
    releaseState,
    leaseToken: () => leaseToken,

    from(table) {
      return new HandlerQuery(db, table);
    },

    rpc(name, args) {
      calls.push({ name, args });
      if (name === 'claim_form_stripe_address_mapping_processing') {
        leaseToken = args.p_token;
        return { data: true, error: null };
      }
      if (name === 'apply_form_stripe_address_mappings') {
        if (primaryError) return { data: null, error: primaryError };
        return { data: { ok: true, applied: true }, error: null };
      }
      if (name === 'release_form_stripe_address_mapping_processing') {
        if (releaseMode === 'sync-throw') {
          throw new Error('release-sync-secret');
        }
        if (releaseMode === 'reject') {
          return thenable(new Error('release-rejected-secret'), {
            reject: true,
            onSettled: () => { releaseState.settled = true; },
          });
        }
        if (releaseMode === 'db-error') {
          return thenable({
            data: null,
            error: { message: 'release-db-secret' },
          }, { onSettled: () => { releaseState.settled = true; } });
        }
        return thenable({ data: null, error: null }, {
          onSettled: () => { releaseState.settled = true; },
        });
      }
      if (name === 'mark_one_off_form_due_diligence_ready') {
        calls[calls.length - 1].releaseSettled = releaseState.settled;
        return { data: true, error: null };
      }
      if (name === 'claim_form_due_diligence_initialization') {
        return { data: { claimed: false, code: 'NOT_ELIGIBLE' }, error: null };
      }
      if (name === 'record_form_due_diligence_claim_failure') {
        return { data: { recorded: true }, error: null };
      }
      return { data: null, error: null };
    },

    executeQuery(query, mode) {
      const { table, selected, operation, payload } = query;

      if (table === 'form_submission' && operation === 'update') {
        Object.assign(submission, payload || {});
        if (mode === 'many') return { data: [{ id: submission.id }], error: null };
        if (mode === 'maybeSingle') return { data: { id: submission.id }, error: null };
        return { data: null, error: null };
      }
      if (table === 'form_submission' && mode === 'maybeSingle') {
        if (selected === 'tenant_id') return { data: { tenant_id: submission.tenant_id }, error: null };
        if (selected === 'organization_id') {
          return { data: { organization_id: submission.organization_id }, error: null };
        }
        return { data: submission, error: null };
      }
      if (table === 'form' && mode === 'maybeSingle') {
        if (selected === 'tenant_id') return { data: { tenant_id: form.tenant_id }, error: null };
        return { data: form, error: null };
      }
      if (table === 'form' && mode === 'single') return { data: form, error: null };
      if (table === 'form_stripe_address_mapping_ledger' && mode === 'maybeSingle') {
        return { data: null, error: null };
      }
      if (table === 'form_submission_entity_creation' && mode === 'many') {
        return { data: [], error: null };
      }
      if (table === 'form_submission_pipeline_entity' && mode === 'many') {
        return { data: [], error: null };
      }
      if (table === 'form_stripe_address_mapping_target' && mode === 'many') {
        return { data: [], error: null };
      }
      if (table === 'preference_field' && mode === 'many') {
        return { data: [], error: null };
      }
      if (table === 'member' && operation === 'insert' && mode === 'single') {
        const row = { id: 'created-member', ...(payload || {}) };
        return { data: row, error: null };
      }
      if (table === 'organization' && operation === 'insert' && mode === 'single') {
        const row = { id: 'created-organization', ...(payload || {}) };
        return { data: row, error: null };
      }
      if (mode === 'single' || mode === 'maybeSingle') return { data: null, error: null };
      return { data: [], error: null };
    },
  };
  return db;
}

function invokeHandlerWithDb(db, {
  bodyOverrides = {},
  verifiedAdminAccess = true,
} = {}) {
  const body = {
    form_id: db.form.id,
    submission_id: db.submission.id,
    tenant_id: db.submission.tenant_id,
    form_values: db.submission.submission_data,
    fields: db.form.fields,
    entity_pipelines: db.form.entity_pipelines,
    verified_submitter_member_id: null,
    verified_admin_access: verifiedAdminAccess,
    ...bodyOverrides,
  };
  const req = {
    method: 'POST',
    headers: {
      host: 'lease-handler-test.invalid',
      ...buildFormProcessingHeaders({
        tenantId: db.submission.tenant_id,
        formId: db.form.id,
        submissionId: db.submission.id,
        verifiedSubmitterMemberId: null,
        verifiedAdminAccess,
      }),
    },
    body,
  };
  const response = { statusCode: 200, body: null };
  const res = {
    status(code) {
      response.statusCode = code;
      return this;
    },
    json(value) {
      response.body = value;
      return value;
    },
  };
  return handler(req, res, { supabase: db }).then(() => ({ response, db }));
}

async function invokeHandlerCapturingWarnings(db, options) {
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    return { ...(await invokeHandlerWithDb(db, options)), warnings };
  } finally {
    console.warn = previousWarn;
  }
}

function assertLeaseRelease(db) {
  const claim = db.calls.find(call =>
    call.name === 'claim_form_stripe_address_mapping_processing');
  const release = db.calls.filter(call =>
    call.name === 'release_form_stripe_address_mapping_processing');
  assert.ok(claim, 'the handler must claim the Stripe processing lease');
  assert.equal(release.length, 1, 'the handler must release the lease once');
  assert.deepEqual(release[0].args, {
    p_tenant_id: ADDRESS_TENANT_ID,
    p_submission_id: ADDRESS_SUBMISSION_ID,
    p_token: claim.args.p_token,
  });
  assert.equal(release[0].args.p_token, db.leaseToken());
}

for (const releaseMode of ['success', 'db-error', 'reject', 'sync-throw']) {
  test(`Stripe lease cleanup preserves a successful handler response (${releaseMode})`, async () => {
    const db = createHandlerDatabase({ releaseMode });
    const result = await invokeHandlerCapturingWarnings(db);
    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    assert.equal(result.response.body.success, true);
    assertLeaseRelease(db);
    assert.equal(result.warnings.some(warning => warning.includes('release-')), false,
      'lease cleanup diagnostics must not expose raw RPC errors');
    if (releaseMode === 'db-error') {
      assert.equal(
        result.warnings.some(warning =>
          warning === '[AppProcessor] Stripe processing lease release returned a database error'),
        true,
      );
    }
    if (releaseMode === 'reject' || releaseMode === 'sync-throw') {
      assert.equal(
        result.warnings.some(warning =>
          warning === '[AppProcessor] Stripe processing lease release operation failed'),
        true,
      );
    }
  });
}

for (const releaseMode of ['success', 'db-error', 'reject', 'sync-throw']) {
  test(`Stripe lease cleanup preserves the genuine primary error (${releaseMode})`, async () => {
    const db = createHandlerDatabase({
      releaseMode,
      primaryError: { message: 'primary-stripe-write-failure' },
    });
    const result = await invokeHandlerCapturingWarnings(db);
    assert.equal(result.response.statusCode, 500);
    assert.equal(result.response.body.code, 'STRIPE_ADDRESS_MAPPING_WRITE_FAILED');
    assert.match(result.response.body.error, /primary-stripe-write-failure/);
    assert.doesNotMatch(result.response.body.error, /release-/);
    assertLeaseRelease(db);
  });
}

for (const releaseMode of ['success', 'db-error']) {
test(`paid finalization runs Stripe mapping, real pipeline processing, and DD readiness (${releaseMode})`, async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://paid-finalizer-test.invalid';
  process.env.SESSION_SECRET = 'paid-finalizer-handler-test-secret';

  const form = {
    id: 'form-paid-finalizer-handler',
    tenant_id: 'tenant-paid-finalizer-handler',
    pages: [],
    visibility_rules: [],
    fields: [{ id: 'email', type: 'email' }],
    field_mappings: [],
    application_level: 'member',
    auto_create_entity: true,
    create_entity_type: 'member',
    entity_action: 'create',
    member_entity_action: 'upsert',
    organization_entity_action: 'none',
    additional_member_creations: [],
    entity_pipelines: {
      members: [{
        id: 'member-primary',
        isPrimary: true,
        mappings: [{
          source_type: 'field',
          source_field_id: 'email',
          target_type: 'core',
          target_entity: 'member',
          target_field: 'email',
        }],
      }],
      organisations: [],
    },
    structured_actions: null,
    default_member_role_id: null,
    submission_emails: [],
  };
  const stripeMappings = [{
    source: 'formatted',
    target_entity: 'member',
    target_type: 'custom',
    target_field: 'member-billing-address',
  }];
  const submission = {
    id: 'submission-paid-finalizer-handler',
    form_id: form.id,
    tenant_id: form.tenant_id,
    submission_data: { email: 'paid-pipeline@example.test' },
    submitted_by_email: null,
    organization_id: null,
    created_member_id: null,
    created_organization_id: null,
    payment_reference: null,
    payment_provider: 'stripe',
    payment_status: 'paid',
    payment_meta: {
      finalized: false,
      verified_submitter_member_id: null,
      verified_admin_access: true,
      stripe_address_mapping_config: {
        version: 1,
        mappings: stripeMappings,
        target_resolution: buildStripeAddressTargetResolution(form, stripeMappings),
      },
      stripe_billing_address: {
        line1: '10 High Street',
        line2: null,
        city: 'Leeds',
        state: null,
        postal_code: 'LS1 1AA',
        country: 'GB',
        formatted: '10 High Street\nLeeds\nLS1 1AA\nGB',
      },
    },
    processing_notes: null,
    submission_email_state: null,
  };
  const processorDb = createHandlerDatabase({ form, submission, releaseMode });

  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    const requestUrl = String(url);
    // The handler's member workflow / fee helpers use the application
    // Supabase client. Keep those incidental reads entirely in-process too:
    // only the paid runner's internal processing URL is routed to the real
    // handler under test.
    if (!requestUrl.endsWith('/api/forms/process-application')) {
      return {
        ok: false,
        status: 503,
        async json() {
          return {};
        },
        async text() {
          return 'integration disabled in regression fixture';
        },
      };
    }
    fetchCalls.push({ url: requestUrl, options });
    const body = JSON.parse(options.body);
    const req = {
      method: options.method,
      headers: options.headers,
      body,
    };
    const response = { statusCode: 200, body: null };
    const res = {
      status(code) {
        response.statusCode = code;
        return this;
      },
      json(value) {
        response.body = value;
        return value;
      },
    };
    await handler(req, res, { supabase: processorDb });
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      async json() {
        return response.body;
      },
      async text() {
        return JSON.stringify(response.body);
      },
    };
  };

  try {
    const result = await finalizeFormSubmission({
      supabase: processorDb,
      submission,
      form,
      baseUrl: 'https://caller-controlled.invalid',
    });
    assert.equal(result.finalized, true);
    assert.equal(fetchCalls.length, 1, 'paid finalizer must invoke the real pipeline runner once');
    assert.equal(fetchCalls[0].url, 'https://paid-finalizer-test.invalid/api/forms/process-application');
    assert.match(processorDb.submission.created_member_id, /^[0-9a-f-]{36}$/i,
      'Stripe processing must use the newly-created member id');
    assert.equal(processorDb.submission.entity_processing_completed_at !== null, true);
    const rpcCalls = processorDb.calls;
    const claimAt = rpcCalls.findIndex(call =>
      call.name === 'claim_form_stripe_address_mapping_processing');
    const applyAt = rpcCalls.findIndex(call =>
      call.name === 'apply_form_stripe_address_mappings');
    const releaseAt = rpcCalls.findIndex(call =>
      call.name === 'release_form_stripe_address_mapping_processing');
    const readinessAt = rpcCalls.findIndex(call =>
      call.name === 'mark_one_off_form_due_diligence_ready');
    const ddAt = rpcCalls.findIndex(call =>
      call.name === 'claim_form_due_diligence_initialization');
    assert.ok(claimAt >= 0 && applyAt > claimAt && releaseAt > applyAt);
    assert.equal(
      rpcCalls[applyAt].args.p_member_id,
      processorDb.submission.created_member_id,
      'persisted Stripe mapping must target the new member',
    );
    assert.ok(readinessAt > releaseAt && ddAt > readinessAt);
    assert.equal(processorDb.releaseState.settled, true,
      'finalizer must wait for handler lease cleanup before readiness');
    assert.equal(rpcCalls[readinessAt].releaseSettled, true,
      'readiness RPC must run only after the thenable release settles');
    assert.equal(
      rpcCalls.some(call => call.name === 'mark_one_off_form_due_diligence_ready'),
      true,
      'readiness must be marked after the handler pipeline succeeds',
    );
    assert.equal(
      rpcCalls.some(call => call.name === 'claim_form_due_diligence_initialization'),
      true,
      'paid DD initialization must be attempted by the finalizer',
    );
    assert.equal(
      rpcCalls.some(call => call.name.includes('reconcile') || call.name.includes('list_form_due_diligence')),
      false,
      'the integrated path must not depend on a cron/reconciliation sweep',
    );
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    globalThis.fetch = previousFetch;
  }
});
}