// Task #3502: paid-form entity pipelines must never be skipped silently, and
// every server-driven finalization path (GC webhook, cron reconcile) must
// supply a tenant-trusted baseUrl — without one the member/org record is
// never created and membership finalization loops on awaiting_entity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runFormEntityPipelines } from './formEntityPipelines.js';
import { reconcileFormPayments } from './formPaymentReconciliation.js';
import { verifyFormProcessingRequest, canProcessPersistedPaymentStatus } from './formProcessingAuth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8');

function makeSupabaseSpy() {
  const updates = [];
  return {
    updates,
    from(table) {
      return {
        update(values) {
          return {
            eq(col, val) {
              updates.push({ table, values, eq: [col, val] });
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  };
}

test('one-off membership response cannot repair missing or conflicting durable processor links', async () => {
  const oldFetch = globalThis.fetch;
  const oldUrl = process.env.APP_URL;
  process.env.APP_URL = 'https://configured-internal.example';
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      success: true, created_member_id: 'returned-member',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    for (const persistedId of [null, 'different-member', 'returned-member']) {
      const writes = [];
      const db = { from() {
        const q = {
          select() { return q; }, eq() { return q; }, filter() { return q; },
          update(payload) { writes.push(payload); return q; },
          maybeSingle: async () => ({ data: { created_member_id: persistedId } }),
          then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
        };
        return q;
      } };
      const out = await runFormEntityPipelines({
        supabase: db,
        submission: { id: 'sub-link', tenant_id: 'tenant-1', payment_status: 'paid',
          payment_provider: 'stripe', payment_meta: { membership: { quote: { target: 'member' } } } },
        form: FORM_WITH_PIPELINES,
      });
      assert.equal(out.failed, persistedId !== 'returned-member');
      if (out.failed) assert.equal(out.integrityErrorCode, 'MEMBERSHIP_PROCESSOR_LINK_MISMATCH');
      assert.equal(writes.some(value => 'created_member_id' in value), false);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = oldUrl;
  }
});

const FORM_WITH_PIPELINES = { id: 'f1', entity_pipelines: { members: [{ id: 'p1' }], organisations: [] } };

test('only complete monthly processing may defer profile mapping until the first payment', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  const completeBody = {
    success: true,
    addressAwaitingFirstPayment: true,
    created_member_id: 'member-monthly',
    structured_actions: { success: true },
    related_records: { success: true },
    stripe_address_mappings: { pending: true, reason: 'first_payment_not_paid' },
  };
  try {
    const cases = [
      { label: 'monthly full success', defer: true },
      { label: 'one-off', provider: 'stripe', paymentStatus: 'paid' },
      { label: 'unconfirmed setup', paymentStatus: 'pending' },
      { label: 'other address error', body: { ...completeBody, stripe_address_mappings: { pending: true, reason: 'target_unresolved' } } },
      { label: 'structured failure', body: { ...completeBody, structured_actions: { success: false } } },
      { label: 'relationship failure', body: { ...completeBody, related_records: { success: false } } },
      { label: 'failed response', body: { ...completeBody, success: false } },
      { label: 'unproven response', body: { ...completeBody, success: undefined } },
      { label: 'no explicit completed-processing handoff', body: { ...completeBody, addressAwaitingFirstPayment: undefined } },
      { label: 'early address return', status: 409, body: { ...completeBody, success: false, retryable: true, code: 'STRIPE_ADDRESS_MAPPINGS_INCOMPLETE' } },
    ];
    for (const entry of cases) {
      globalThis.fetch = async () => new Response(JSON.stringify(entry.body || completeBody), {
        status: entry.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
      const result = await runFormEntityPipelines({
        supabase: makeSupabaseSpy(),
        submission: {
          id: 'sub-monthly', tenant_id: 'tenant-1',
          payment_provider: entry.provider || 'stripe_monthly_card',
          payment_status: entry.paymentStatus || 'setup_complete',
          payment_meta: {},
        },
        form: FORM_WITH_PIPELINES,
      });
      assert.equal(result.partial, !entry.defer, entry.label);
      assert.equal(result.addressAwaitingFirstPayment === true, !!entry.defer, entry.label);
      if (entry.defer) {
        assert.equal(result.failed, false);
        assert.equal(result.memberId, 'member-monthly');
        assert.equal(result.stripeAddressMappings.pending, true);
      }
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test('missing baseUrl with pipelines writes a visible processing note (no silent skip)', async () => {
  const supabase = makeSupabaseSpy();
  const result = await runFormEntityPipelines({
    supabase,
    submission: { id: 'sub-1', payment_meta: {} },
    form: FORM_WITH_PIPELINES,
    baseUrl: null,
  });
  assert.equal(result.ran, false);
  assert.equal(supabase.updates.length, 1);
  assert.equal(supabase.updates[0].table, 'form_submission');
  assert.match(supabase.updates[0].values.processing_notes, /processing was skipped/i);
  assert.deepEqual(supabase.updates[0].eq, ['id', 'sub-1']);
});

test('no pipelines configured stays a clean no-op (no note)', async () => {
  const supabase = makeSupabaseSpy();
  const result = await runFormEntityPipelines({
    supabase,
    submission: { id: 'sub-2' },
    form: { id: 'f2', entity_pipelines: { members: [], organisations: [] } },
    baseUrl: null,
  });
  assert.equal(result.ran, false);
  assert.equal(supabase.updates.length, 0);
});

test('null and absent unconfigured forms never invoke paid entity processing', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('unconfigured forms must not fetch');
  };
  try {
    for (const form of [{ id: 'absent' }, { id: 'null', entity_pipelines: null }]) {
      const supabase = makeSupabaseSpy();
      const result = await runFormEntityPipelines({
        supabase,
        submission: { id: `sub-${form.id}`, payment_meta: {} },
        form,
      });
      assert.equal(result.ran, false);
      assert.equal(supabase.updates.length, 0);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('forged caller baseUrl never receives the internal processing proof', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  process.env.SESSION_SECRET = 'form-pipeline-test-secret';
  let requestedUrl = null;
  let requestOptions = null;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestOptions = options;
    return {
      ok: true,
      async json() { return {}; },
    };
  };
  try {
    const result = await runFormEntityPipelines({
      supabase: makeSupabaseSpy(),
      submission: {
        id: 'sub-secure',
        tenant_id: 'tenant-1',
        submission_data: {},
        payment_meta: {
          verified_submitter_member_id: 'member-self',
          verified_admin_access: true,
        },
      },
      form: FORM_WITH_PIPELINES,
      baseUrl: 'https://attacker.example',
    });
    assert.equal(result.ran, true);
    assert.equal(requestedUrl, 'https://configured-internal.example/api/forms/process-application');
    const body = JSON.parse(requestOptions.body);
    assert.equal(body.verified_submitter_member_id, 'member-self');
    assert.equal(verifyFormProcessingRequest({ headers: requestOptions.headers }, {
      tenantId: 'tenant-1',
      formId: 'f1',
      submissionId: 'sub-secure',
      verifiedSubmitterMemberId: 'member-self',
      verifiedAdminAccess: true,
    }), true);
    assert.equal(body.verified_admin_access, true);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    globalThis.fetch = previousFetch;
  }
});

test('paid processing preserves a structured-action partial result for reconciliation', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  process.env.SESSION_SECRET = 'form-pipeline-partial-test-secret';
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        success: false,
        structured_actions: {
          success: false,
          failed_count: 1,
          outcomes: [{ action_id: 'organization-action', status: 'failed' }],
        },
      };
    },
  });
  try {
    const result = await runFormEntityPipelines({
      supabase: makeSupabaseSpy(),
      submission: {
        id: 'sub-partial',
        tenant_id: 'tenant-1',
        submission_data: {},
        payment_meta: {},
      },
      form: {
        id: 'f-partial',
        structured_actions: {
          version: 1,
          actions: [{ id: 'organization-action' }],
        },
      },
    });
    assert.equal(result.ran, true);
    assert.equal(result.partial, true);
    assert.equal(result.structuredActions.failed_count, 1);
  } finally {
    process.env.APP_URL = previousAppUrl;
    process.env.SESSION_SECRET = previousSessionSecret;
    globalThis.fetch = previousFetch;
  }
});

test('HTTP and invalid-JSON responses have an explicit failed contract without erasing useful notes', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  process.env.SESSION_SECRET = 'form-pipeline-failure-test-secret';
  const submission = {
    id: 'sub-failure',
    tenant_id: 'tenant-1',
    submission_data: {},
    payment_meta: {},
    processing_notes: 'Manual review: surname needs confirmation.',
  };
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'unavailable' });
    const httpDb = makeSupabaseSpy();
    const http = await runFormEntityPipelines({
      supabase: httpDb,
      submission,
      form: FORM_WITH_PIPELINES,
      completionDescription: 'Payment setup completed',
    });
    assert.equal(http.ran, false);
    assert.equal(http.failed, true);
    assert.match(http.detail, /HTTP 503/);
    assert.match(httpDb.updates[0].values.processing_notes, /Manual review/);
    assert.match(httpDb.updates[0].values.processing_notes, /Payment setup completed/);

    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } });
    const invalidJson = await runFormEntityPipelines({
      supabase: makeSupabaseSpy(),
      submission,
      form: FORM_WITH_PIPELINES,
      completionDescription: 'Payment setup completed',
    });
    assert.equal(invalidJson.ran, true);
    assert.equal(invalidJson.failed, true);
    assert.match(invalidJson.detail, /no valid JSON/);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    globalThis.fetch = previousFetch;
  }
});

test('a new paid completion transport timeout waits without marking the remote operation attention', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  process.env.SESSION_SECRET = 'form-pipeline-operation-test-secret';
  const rpcCalls = [];
  const supabase = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      if (name === 'observe_or_begin_form_paid_pipeline_operation') return { data: { status: 'claimed' }, error: null };
      if (name === 'finish_form_paid_pipeline_operation') return { data: true, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
    from() {
      const query = {
        update: () => query,
        eq: () => query,
        filter: () => query,
        then: resolve => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    },
  };
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    assert.ok(options.signal, 'deadline must be propagated to fetch');
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  try {
    const result = await runFormEntityPipelines({
      supabase,
      submission: { id: 'sub-op', tenant_id: 'tenant-1', submission_data: {}, payment_meta: {} },
      form: FORM_WITH_PIPELINES,
      completionOperationId: '00000000-0000-4000-8000-000000000001',
      observeLateSuccess: true,
      // The runner reserves five seconds for outcome persistence, so this
      // reaches its transport deadline immediately without a slow test.
      deadlineAt: Date.now() + 5_025,
    });
    assert.equal(result.failed, true);
    assert.equal(result.ambiguous, undefined);
    assert.equal(result.awaitingOperation, true);
    assert.deepEqual(rpcCalls.map(call => call.name), [
      'observe_or_begin_form_paid_pipeline_operation',
    ]);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    globalThis.fetch = previousFetch;
  }
});

test('a new completion owner reuses a durable done pipeline result without fetch', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error('must not replay done pipeline'); };
  const supabase = {
    rpc: async (name) => {
      assert.equal(name, 'begin_form_paid_pipeline_operation');
      return { data: { status: 'done' }, error: null };
    },
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: {
            created_member_id: 'member-1',
            organization_id: 'org-1',
            payment_meta: {},
          },
          error: null,
        }),
      };
      return query;
    },
  };
  try {
    const result = await runFormEntityPipelines({
      supabase,
      submission: { id: 'sub-done', tenant_id: 'tenant-1', submission_data: {}, payment_meta: {} },
      form: FORM_WITH_PIPELINES,
      completionOperationId: '00000000-0000-4000-8000-000000000098',
    });
    assert.equal(fetches, 0);
    assert.equal(result.ran, true);
    assert.equal(result.memberId, 'member-1');
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    globalThis.fetch = previousFetch;
  }
});

test('durable structured-action 409 is partial, not an ambiguous pipeline outcome', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  const rpcCalls = [];
  const supabase = {
    rpc: async (name, args) => {
      rpcCalls.push(name);
      if (name === 'begin_form_paid_pipeline_operation') return { data: { status: 'claimed' }, error: null };
      if (name === 'finish_form_paid_pipeline_operation') return { data: true, error: null };
      throw new Error(`unexpected RPC ${name} ${JSON.stringify(args)}`);
    },
    from() {
      const query = { update: () => query, eq: () => query, filter: () => query, then: resolve => Promise.resolve({ data: [], error: null }).then(resolve) };
      return query;
    },
  };
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      code: 'STRUCTURED_ACTIONS_INCOMPLETE',
      retryable: true,
      structured_actions: { success: false, outcomes: [{ status: 'skipped', retryable: true }] },
      created_member_id: 'member-1',
    }),
  });
  try {
    const result = await runFormEntityPipelines({
      supabase,
      submission: { id: 'sub-partial', tenant_id: 'tenant-1', submission_data: {}, payment_meta: {} },
      form: FORM_WITH_PIPELINES,
      completionOperationId: '00000000-0000-4000-8000-000000000097',
      completionOperationKind: 'followup',
    });
    assert.equal(result.partial, true);
    assert.equal(result.ambiguous, undefined);
    assert.deepEqual(rpcCalls, ['begin_form_paid_pipeline_operation']);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    globalThis.fetch = previousFetch;
  }
});

test('durable address-mapping 409 remains a retryable partial, not attention', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  const supabase = {
    rpc: async name => {
      if (name === 'begin_form_paid_pipeline_operation') return { data: { status: 'claimed' }, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
    from() {
      const query = { update: () => query, eq: () => query, filter: () => query, then: resolve => Promise.resolve({ data: [], error: null }).then(resolve) };
      return query;
    },
  };
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      code: 'STRIPE_ADDRESS_MAPPINGS_INCOMPLETE',
      retryable: true,
      stripe_address_mappings: {
        configured: true,
        applied: false,
        pending: true,
        reason: 'stripe_address_mapping_target_unresolved',
      },
    }),
  });
  try {
    const result = await runFormEntityPipelines({
      supabase,
      submission: { id: 'sub-address-partial', tenant_id: 'tenant-1', submission_data: {}, payment_meta: {} },
      form: FORM_WITH_PIPELINES,
      completionOperationId: '00000000-0000-4000-8000-000000000096',
      completionOperationKind: 'followup',
    });
    assert.equal(result.partial, true);
    assert.equal(result.ambiguous, undefined);
    assert.equal(result.stripeAddressMappings.pending, true);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    globalThis.fetch = previousFetch;
  }
});

test('public and embedded submissions surface incomplete structured actions without deleting retry state', () => {
  const source = read('../public/form-submission.js');
  const incompleteStart = source.indexOf("if (result.structured_actions?.success === false)");
  const finalSuccess = source.indexOf("return res.status(201).json({");
  assert.ok(incompleteStart > 0 && incompleteStart < finalSuccess);
  const incompleteBranch = source.slice(incompleteStart, source.indexOf("// If the pipeline resolved", incompleteStart));
  assert.match(incompleteBranch, /status\(422\)/);
  assert.match(incompleteBranch, /STRUCTURED_ACTION_PROCESSING_INCOMPLETE/);
  assert.match(incompleteBranch, /processing_retryable: true/);
  assert.doesNotMatch(incompleteBranch, /form_submission'\)\.delete/);
  assert.match(source, /hasIncompleteStructuredActions/);
  assert.match(source, /communication_finalization_state, processing_notes/);
});

test('paid runner invokes processing for a legacy-only form', async () => {
  const previousAppUrl = process.env.APP_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  const previousFetch = globalThis.fetch;
  process.env.APP_URL = 'https://configured-internal.example';
  process.env.SESSION_SECRET = 'form-pipeline-test-secret';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, async json() { return {}; } };
  };
  try {
    const result = await runFormEntityPipelines({
      supabase: makeSupabaseSpy(),
      submission: { id: 'sub-legacy-paid', tenant_id: 'tenant-1', submission_data: {}, payment_meta: {} },
      form: { id: 'legacy-form', entity_pipelines: null, member_entity_action: 'create' },
      baseUrl: 'https://attacker.example',
    });
    assert.equal(result.ran, true);
    assert.equal(calls, 1);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    globalThis.fetch = previousFetch;
  }
});

// --- Source contracts: server-driven finalize paths supply a real baseUrl ---

test('GC webhook form-payment path derives a tenant-trusted baseUrl (never null)', () => {
  const src = read('./gocardlessWebhookProcessor.js');
  const fn = src.slice(src.indexOf('async function maybeProcessFormPaymentBillingRequest'));
  const body = fn.slice(0, fn.indexOf('\nasync function', 10));
  assert.match(body, /getTrustedBaseUrlForTenant\(/, 'webhook must resolve tenant-trusted base URL');
  assert.doesNotMatch(body, /baseUrl:\s*null/, 'webhook must not pass baseUrl: null into finalizeFormSubmission');
  assert.match(body, /finalizeFormSubmission\(\{[\s\S]*?baseUrl,?[\s\S]*?\}\)/, 'finalize call must receive the resolved baseUrl');
});

test('reconcile sweep resolves baseUrl per tenant so the cron path runs pipelines', () => {
  const src = read('./formPaymentReconciliation.js');
  assert.match(src, /getTrustedBaseUrlForTenant\(/, 'reconciler must resolve tenant-trusted base URLs');
  assert.match(src, /const resolveBaseUrl = async \(tenantId\)/, 'per-tenant resolver expected');
  // Every finalize/membership call site must use the resolved URL, not the raw
  // (possibly null) caller argument.
  assert.doesNotMatch(src, /finalizeFormSubmission\(\{[^}]*baseUrl,\s*\n/, 'finalize calls must use resolveBaseUrl(...)');
  const finalizeCalls = src.match(/finalizeFormSubmission\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(finalizeCalls.length >= 3, 'expected the three sweep finalize call sites');
  for (const call of finalizeCalls) {
    assert.match(call, /baseUrl: await resolveBaseUrl\(row\.tenant_id\)/, `finalize call missing resolved baseUrl: ${call.slice(0, 120)}`);
  }
  assert.match(src, /finalizeFormMembership\(\{[\s\S]*?supabase,\s*submission: row,\s*baseUrl: rowBaseUrl,\s*deadlineAt,/i, 'membership retry must use resolved baseUrl and deadline');
  assert.match(src, /entityMissing && rowBaseUrl/, 'pipeline re-run gate must use resolved baseUrl');
  assert.match(src, /payment_meta->related_records_pending/, 'failed paid Related Records links must have an independent retry sweep');
  assert.match(src, /payment_status\.eq\.paid,payment_status\.eq\.setup_complete/, 'the retry sweep must include one-off and monthly-card paid states');
  assert.match(src, /pipelineOut\.relatedRecords\?\.success/, 'the retry sweep must observe successful relationship reconciliation');
});

test('pipeline runner fails loudly when baseUrl is missing (source contract)', () => {
  const src = read('./formEntityPipelines.js');
  assert.doesNotMatch(src, /!hasEntityPipelines \|\| !baseUrl/, 'silent combined early-return must not come back');
  assert.match(src, /processing was skipped \(no base URL\)/, 'missing-baseUrl processing note expected');
  assert.match(src, /getInternalApiBaseUrl\(null\)/, 'runner must choose a request-independent processing origin');
  assert.equal(src.includes('fetch(`${baseUrl}'), false, 'caller baseUrl must never receive internal auth headers');
});

test('paid creation and every async finalizer preserve the verified submitter identity', () => {
  const payment = read('../public/form-payment.js');
  const persistedIdentityWrites = payment.match(
    /verified_submitter_member_id:\s*access\.verifiedSubmitterMemberId\s*\|\|\s*null/g,
  ) || [];
  assert.ok(persistedIdentityWrites.length >= 4, 'monthly, normal insert, retry refresh, and legacy confirm must persist identity');
  const persistedAdminWrites = payment.match(
    /verified_admin_access:\s*access\.verifiedAdminAccess\s*===\s*true/g,
  ) || [];
  assert.ok(persistedAdminWrites.length >= 4, 'every paid start/retry path must persist server-derived admin authority');
  const runner = read('./formEntityPipelines.js');
  assert.match(runner, /meta\.verified_submitter_member_id/);
  assert.match(runner, /verifiedSubmitterMemberId,/);
  assert.match(runner, /verified_submitter_member_id:\s*verifiedSubmitterMemberId/);
  assert.match(runner, /meta\.verified_admin_access === true/);
  assert.match(runner, /verified_admin_access:\s*verifiedAdminAccess/);
  for (const rel of [
    './formPaymentFinalize.js',
    './formMonthlyCardFinalize.js',
    './formPaymentReconciliation.js',
    './gocardlessWebhookProcessor.js',
  ]) {
    const source = read(rel);
    assert.match(
      source,
      /finalizeFormSubmission|runFormEntityPipelines/,
      `${rel} must route through shared paid form finalization`,
    );
  }
});

test('reconciliation retries and clears pending Structured Actions and Related Records for monthly-card submissions', async () => {
  const row = {
    id: 'submission-monthly',
    form_id: 'form-monthly',
    tenant_id: 'tenant-1',
    payment_status: 'setup_complete',
    payment_meta: { structured_actions_pending: true, related_records_pending: true },
    submission_data: {},
  };
  const form = {
    id: row.form_id,
    tenant_id: row.tenant_id,
    access_policy: null,
    entity_pipelines: { members: [{ id: 'primary', isPrimary: true }], organisations: [] },
  };
  const updates = [];
  class Query {
    constructor(table) { this.table = table; this.equals = []; this.ins = []; this.nots = []; this.filters = []; this.updatePayload = null; }
    select() { return this; }
    eq(column, value) { this.equals.push([column, value]); return this; }
    in(column, values) { this.ins.push([column, values]); return this; }
    not(...args) { this.nots.push(args); return this; }
    filter(...args) { this.filters.push(args); return this; }
    gte() { return this; }
    lte() { return this; }
    order() { return this; }
    limit() { return this; }
    or(expression) {
      if (expression === 'payment_status.eq.paid,payment_status.eq.setup_complete') {
        this.ins.push(['payment_status', ['paid', 'setup_complete']]);
      }
      if (expression.includes('payment_meta->structured_actions_pending.eq.true')) {
        this.filters.push(['pending-structured-or-related']);
      }
      return this;
    }
    update(payload) { this.updatePayload = payload; updates.push(payload); return this; }
    async maybeSingle() {
      if (this.table === 'form') return { data: form, error: null };
      return { data: null, error: null };
    }
    then(resolve, reject) {
      let data = [];
      if (this.table === 'form_submission' && !this.updatePayload) {
        const isPipelineRetrySweep = this.ins.some(([column]) => column === 'payment_status')
          && this.filters.some(([kind]) => kind === 'pending-structured-or-related');
        data = isPipelineRetrySweep ? [row] : [];
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  }
  const supabase = {
    from: table => new Query(table),
    rpc: async (name, args) => {
      if (name === 'claim_form_payment_reconciliation_work') {
        return { data: [], error: null };
      }
      if (name === 'begin_form_paid_pipeline_operation') {
        assert.equal(args.p_tenant_id, row.tenant_id);
        assert.equal(args.p_submission_id, row.id);
        assert.match(args.p_operation_id, /^[0-9a-f-]{36}$/i);
        return { data: { status: 'claimed' }, error: null };
      }
      assert.equal(name, 'patch_form_submission_payment_meta');
      assert.equal(args.p_tenant_id, row.tenant_id);
      assert.equal(args.p_submission_id, row.id);
      row.payment_meta = { ...row.payment_meta, ...args.p_patch };
      // Preserve the test's existing observable contract while modelling the
      // atomic merge performed by the production RPC.
      updates.push({ payment_meta: row.payment_meta });
      return { data: row.payment_meta, error: null };
    },
  };
  const previousFetch = globalThis.fetch;
  const previousAppUrl = process.env.APP_URL;
  const previousSecret = process.env.SESSION_SECRET;
  process.env.APP_URL = 'https://internal.example.test';
  process.env.SESSION_SECRET = 'test-session-secret';
  let processingCalls = 0;
  globalThis.fetch = async () => {
    processingCalls += 1;
    return {
      ok: true,
      json: async () => ({
        structured_actions: { success: true, outcomes: [{ status: 'already_completed' }] },
        related_records: { success: true, outcomes: [{ status: 'already_linked' }] },
      }),
    };
  };
  try {
    const result = await reconcileFormPayments(supabase, { baseUrl: 'https://tenant.example.test' });
    assert.equal(processingCalls, 1);
    assert.equal(result.structuredActionsReconciled, 1);
    assert.equal(result.relatedRecordsReconciled, 1);
    assert.ok(updates.some(update => update.payment_meta?.structured_actions_pending === false));
    assert.ok(updates.some(update => update.payment_meta?.related_records_pending === false));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
});

test('receiptless paid GoCardless and historical Stripe crashes recover only when actually unfinalized', async () => {
  const form = {
    id: 'legacy-form',
    tenant_id: 'tenant-legacy',
    access_policy: null,
    entity_pipelines: null,
    fields: [],
    submission_emails: [],
  };
  for (const paymentProvider of ['gocardless', 'stripe']) {
    const row = {
      id: `legacy-${paymentProvider}`,
      form_id: form.id,
      tenant_id: form.tenant_id,
      payment_provider: paymentProvider,
      payment_status: 'paid',
      payment_meta: {},
      submission_data: {},
      created_date: '2020-01-01T00:00:00.000Z',
    };
    const updates = [];
    class Query {
      constructor(table) { this.table = table; this.equal = []; this.filters = []; this.ors = []; this.payload = null; }
      select() { return this; }
      eq(column, value) { this.equal.push([column, value]); return this; }
      filter(...args) { this.filters.push(args); return this; }
      or(value) { this.ors.push(value); return this; }
      not() { return this; }
      in() { return this; }
      gte() { return this; }
      lte() { return this; }
      order() { return this; }
      limit() { return this; }
      update(payload) { this.payload = payload; return this; }
      matchesLegacyFallback() {
        return this.table === 'form_submission'
          && this.equal.some(([column, value]) => column === 'payment_status' && value === 'paid')
          && this.filters.some(([column, operator, value]) => column === 'payment_meta->finalized' && operator === 'is' && value === null)
          && this.ors.includes('payment_provider.eq.stripe,payment_provider.eq.gocardless');
      }
      result() {
        if (this.table === 'form') return { data: [form], error: null };
        if (this.table !== 'form_submission') return { data: [], error: null };
        if (this.payload) {
          Object.assign(row, this.payload);
          updates.push(this.payload);
          return { data: [row], error: null };
        }
        return { data: this.matchesLegacyFallback() ? [row] : [], error: null };
      }
      async maybeSingle() {
        const result = this.result();
        return { data: result.data[0] || null, error: result.error };
      }
      then(resolve, reject) { return Promise.resolve(this.result()).then(resolve, reject); }
    }
    const db = {
      from: table => new Query(table),
      rpc: async () => ({ data: [], error: null }),
    };
    const outcome = await reconcileFormPayments(db, {
      baseUrl: 'https://tenant.example.test',
      timeBudgetMs: 60_000,
    });
    assert.equal(outcome.finalized, 1, `${paymentProvider} crash should reach legacy finalization`);
    assert.equal(row.payment_meta.finalized, true);
    assert.ok(updates.some(update => update.payment_meta?.finalized === true));
  }
});

test('legacy compatibility sweep preserves paid rows with an actual finalized stamp', () => {
  const source = read('./formPaymentReconciliation.js');
  const start = source.indexOf('// Compatibility sweep:');
  const end = source.indexOf('// Third sweep (Task #3489):', start);
  const sweep = source.slice(start, end);
  assert.match(sweep, /\.eq\('payment_status', 'paid'\)/);
  assert.match(sweep, /\.filter\('payment_meta->finalized', 'is', null\)/);
  assert.match(sweep, /payment_provider\.eq\.stripe,payment_provider\.eq\.gocardless/);
  assert.match(sweep, /completion->>version\.is\.null/);
  assert.ok(!sweep.includes('queueFormPaymentCompletion'),
    'receiptless history must retain its legacy completion protocol');
});

test('only trusted internal processing accepts the terminal monthly-card payment state', () => {
  assert.equal(canProcessPersistedPaymentStatus(null), true);
  assert.equal(canProcessPersistedPaymentStatus('paid'), true);
  assert.equal(canProcessPersistedPaymentStatus('setup_complete'), false);
  assert.equal(canProcessPersistedPaymentStatus('setup_complete', { trustedInternal: true }), true);
  assert.equal(canProcessPersistedPaymentStatus('pending', { trustedInternal: true }), false);
  const handler = read('../forms/process-application.js');
  assert.match(handler, /canProcessPersistedPaymentStatus\(persistedSubmission\.payment_status, \{ trustedInternal \}\)/);
});
