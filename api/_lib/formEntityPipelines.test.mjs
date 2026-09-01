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

const FORM_WITH_PIPELINES = { id: 'f1', entity_pipelines: { members: [{ id: 'p1' }], organisations: [] } };

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
  assert.match(src, /finalizeFormMembership\(\{ supabase, submission: row, baseUrl: rowBaseUrl \}\)/, 'membership retry must use resolved baseUrl');
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

test('reconciliation retries and clears pending Related Records for monthly-card submissions', async () => {
  const row = {
    id: 'submission-monthly',
    form_id: 'form-monthly',
    tenant_id: 'tenant-1',
    payment_status: 'setup_complete',
    payment_meta: { related_records_pending: true },
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
        const isRelatedSweep = this.ins.some(([column]) => column === 'payment_status')
          && this.equals.some(([column, value]) => column === 'payment_meta->related_records_pending' && value === true);
        data = isRelatedSweep ? [row] : [];
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  }
  const supabase = { from: table => new Query(table) };
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
        related_records: { success: true, outcomes: [{ status: 'already_linked' }] },
      }),
    };
  };
  try {
    const result = await reconcileFormPayments(supabase, { baseUrl: 'https://tenant.example.test' });
    assert.equal(processingCalls, 1);
    assert.equal(result.relatedRecordsReconciled, 1);
    assert.ok(updates.some(update => update.payment_meta?.related_records_pending === false));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
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
