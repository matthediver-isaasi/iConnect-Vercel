import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  gocardlessProviderContext, validateGocardlessProviderContext,
  gocardlessLookupFailure, retrieveFormGocardlessBillingRequest,
  filterGocardlessPendingSelection,
} from './gocardlessFormProviderContext.js';

const creds = { accessToken: 'sandbox_fixture_only', source: 'tenant', tenantId: 'tenant', environment: 'sandbox' };
const origin = gocardlessProviderContext(creds);
const now = Date.parse('2026-09-07T00:00:00Z');

test('origin contains no token and matches exact resolved creation client only', () => {
  assert.equal(JSON.stringify(origin).includes(creds.accessToken), false);
  assert.equal(validateGocardlessProviderContext(origin, gocardlessProviderContext(creds)), null);
  assert.equal(validateGocardlessProviderContext(origin, { ...origin, environment: 'live' }), 'origin_environment_mismatch');
  assert.equal(validateGocardlessProviderContext(origin, gocardlessProviderContext({ ...creds, accessToken: 'other' })), 'origin_account_mismatch');
  assert.equal(validateGocardlessProviderContext(origin, { ...origin, source: 'platform-env' }), 'origin_account_mismatch');
  assert.equal(validateGocardlessProviderContext(origin, { ...origin, tenant_id: 'other' }), 'origin_account_mismatch');
  assert.equal(validateGocardlessProviderContext(null, origin), 'origin_context_unknown');
  assert.equal(validateGocardlessProviderContext(null, origin, { environment: 'live' }), 'agreement_environment_mismatch');
  assert.equal(validateGocardlessProviderContext(null, origin, { environment: 'sandbox' }), 'origin_context_unknown');
});

test('404 and transient failures back off then require review, never payment failure', () => {
  for (const status of [404, 429, 500, undefined]) {
    let previous;
    for (let attempt = 1; attempt <= 5; attempt++) {
      previous = gocardlessLookupFailure(previous, { status, message: 'must not persist this secret' }, now);
      assert.equal(previous.attempts, attempt);
      assert.equal(previous.status, attempt === 5 ? 'blocked' : 'retry');
      assert.equal(previous.requires_review, attempt === 5);
      assert.equal(previous.next_attempt_at, attempt === 5 ? null : new Date(now + 5 * 2 ** (attempt - 1) * 60_000).toISOString());
      assert.equal(JSON.stringify(previous).includes('secret'), false);
      assert.equal('payment_status' in previous, false);
    }
  }
});

function fixture(meta = {}) {
  const row = { id: 'submission', tenant_id: 'tenant', payment_status: 'pending',
    payment_meta: { gc_provider_context: origin, unrelated: true, ...meta } };
  let calls = 0;
  const writes = [];
  const db = { async rpc(name, args) {
    assert.equal(name, 'record_form_gocardless_reconciliation');
    assert.equal(args.p_submission_id, row.id);
    writes.push(args.p_diagnostic);
    row.payment_meta.gc_reconciliation = args.p_diagnostic;
    return { data: true };
  } };
  const gc = { providerContext: origin, async getBillingRequest() { calls++; return { id: 'BR', status: 'fulfilled' }; } };
  return { row, db, gc, writes, calls: () => calls };
}

test('blocked, deferred, unknown, and mismatched contexts perform zero provider calls', async () => {
  for (const meta of [
    { gc_reconciliation: { status: 'blocked' } },
    { gc_reconciliation: { next_attempt_at: new Date(Date.now() + 60_000).toISOString() } },
    { gc_provider_context: null },
    { gc_provider_context: { ...origin, environment: 'live' } },
    { gc_provider_context: { ...origin, account_fingerprint: 'different' } },
  ]) {
    const f = fixture(meta);
    assert.equal(await retrieveFormGocardlessBillingRequest({ ...f, reference: 'BR' }), null);
    assert.equal(f.calls(), 0);
    assert.equal(f.row.payment_status, 'pending');
  }
});

test('same context can discover fulfilled payment; 404 persists bounded diagnostics only', async () => {
  const f = fixture();
  assert.equal((await retrieveFormGocardlessBillingRequest({ ...f, reference: 'BR' })).status, 'fulfilled');
  assert.equal(f.calls(), 1);
  assert.equal(f.row.payment_meta.unrelated, true);
  f.row.payment_meta.gc_reconciliation = { attempts: 4 };
  f.gc.getBillingRequest = async () => { throw { status: 404 }; };
  assert.equal(await retrieveFormGocardlessBillingRequest({ ...f, reference: 'BR' }), null);
  assert.equal(f.writes.at(-1).status, 'blocked');
  assert.equal(f.row.payment_status, 'pending');
});

test('browser refresh bypasses only successful waiting throttle, never lookup-error backoff or review', async () => {
  const next_attempt_at = new Date(Date.now() + 15 * 60_000).toISOString();
  const f = fixture({ gc_reconciliation: { status: 'waiting', next_attempt_at } });
  assert.equal(await retrieveFormGocardlessBillingRequest({ ...f, reference: 'BR' }), null);
  assert.equal(f.calls(), 0);
  assert.equal((await retrieveFormGocardlessBillingRequest({ ...f, reference: 'BR', refreshWaiting: true })).status, 'fulfilled');
  assert.equal(f.calls(), 1);
  for (const status of ['retry', 'blocked']) {
    const deferred = fixture({ gc_reconciliation: { status, next_attempt_at } });
    assert.equal(await retrieveFormGocardlessBillingRequest({ ...deferred, reference: 'BR', refreshWaiting: true }), null);
    assert.equal(deferred.calls(), 0);
  }
});

test('SQL selection filters precede limit and retain stable oldest-first ordering', async () => {
  const filters = [];
  const query = { or(value) { filters.push(value); return this; } };
  assert.equal(filterGocardlessPendingSelection(query, now), query);
  assert.match(filters[0], /status\.neq\.blocked/);
  assert.match(filters[1], /next_attempt_at\.lte\.2026-09-07/);
  const source = await readFile(new URL('./formPaymentReconciliation.js', import.meta.url), 'utf8');
  const pending = source.slice(source.indexOf('let rows = []'), source.indexOf('const processMonthlyDirectDebitRow'));
  assert.match(pending, /filterGocardlessPendingSelection[\s\S]*\.order\('created_date'[\s\S]*\.order\('id'[\s\S]*\.limit\(limit\)/);
});

test('creation snapshots exact client in new insert, reused rows are not retrofitted', async () => {
  const source = await readFile(new URL('../public/form-payment.js', import.meta.url), 'utf8');
  assert.match(source, /const creationGc = provider === 'gocardless'[\s\S]*if \(!submissionRow\)[\s\S]*gc_provider_context: creationGc.providerContext/);
  assert.match(source, /const gc = creationGc/);
  assert.match(source, /validateGocardlessProviderContext\(existingOrigin, gc.providerContext\)/);
  assert.doesNotMatch(source, /update\(\{[^}]*gc_provider_context/);
});