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
});

test('pipeline runner fails loudly when baseUrl is missing (source contract)', () => {
  const src = read('./formEntityPipelines.js');
  assert.doesNotMatch(src, /!hasEntityPipelines \|\| !baseUrl/, 'silent combined early-return must not come back');
  assert.match(src, /processing was skipped \(no base URL\)/, 'missing-baseUrl processing note expected');
});
