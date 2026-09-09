import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  finalizeFormMonthlyDirectDebit,
  isFormMonthlyDirectDebitFinalized,
  isFormMonthlyDirectDebitProcessing,
  FINALIZE_CLAIM_TTL_MS,
  FORM_COLUMNS,
} from './formMonthlyDirectDebitFinalize.js';

const agreement = {
  id: 'a1', tenant_id: 't1', provider: 'gocardless', agreement_type: 'member',
  metadata: { form_submission_id: 's1', dd: { kind: 'monthly_direct_debit', membership_year: '2026/27', plan_total: 120 } },
};
const form = { id: 'f1', tenant_id: 't1', fields: [], entity_pipelines: { members: [], organisations: [] } };
function fake(sub, rpcResult = { ok: true, history_id: 'h1' }) {
  const tables = { form_submission: [structuredClone(sub)], form: [form] };
  return {
    tables,
    from(table) {
      const filters = [];
      let payload;
      const q = { select: () => q, update: (p) => { payload = p; return q; },
        eq: (k, v) => { filters.push([k, v]); return q; },
        filter: (k, op, v) => { filters.push([k, op, v]); return q; },
        maybeSingle: async () => {
          const row = tables[table]?.[0];
          if (payload && row && filters.every(([k, op, v]) => op === 'eq' ? row[k] === v : true)) Object.assign(row, payload);
          return { data: row ? structuredClone(row) : null, error: null };
        },
      }; return q;
    },
    rpc: async () => ({ data: rpcResult, error: null }),
  };
}
function submission(overrides = {}) {
  return { id: 's1', tenant_id: 't1', form_id: 'f1', payment_status: 'setup_complete',
    payment_provider: 'gocardless_monthly_dd', payment_meta: {}, created_member_id: 'm1', ...overrides };
}

test('done state is idempotent and fresh processing leases are retryable', async () => {
  assert.equal(isFormMonthlyDirectDebitFinalized({ payment_status: 'setup_complete', payment_meta: { monthly_dd_state: { status: 'done' } } }), true);
  assert.equal(isFormMonthlyDirectDebitProcessing({ payment_status: 'setup_complete', payment_meta: { monthly_dd_state: { status: 'processing', claimed_at: new Date().toISOString() } } }), true);
  const db = fake(submission({ payment_meta: { monthly_dd_state: { status: 'processing', claimed_at: new Date().toISOString() } } }));
  const result = await finalizeFormMonthlyDirectDebit({ db, agreement });
  assert.equal(result.retryable, true);
});

test('missing member releases lease for retry and stale lease can be reclaimed', async () => {
  const db = fake(submission({ created_member_id: null, payment_meta: {
    monthly_dd_state: { status: 'processing', claimed_at: new Date(Date.now() - FINALIZE_CLAIM_TTL_MS * 2).toISOString(), owner_token: 'dead' },
  } }));
  const result = await finalizeFormMonthlyDirectDebit({ db, agreement });
  assert.equal(result.retryable, true);
});

test('access proof and provider/tenant association fail closed', async () => {
  const noProof = fake(submission({ payment_meta: {} }));
  const restricted = { ...form, access_policy: { mode: 'authenticated' } };
  noProof.tables.form[0] = restricted;
  const access = await finalizeFormMonthlyDirectDebit({ db: noProof, agreement });
  assert.equal(access.code, 'FORM_ACCESS_NOT_AUTHORIZED');
  const wrong = await finalizeFormMonthlyDirectDebit({ db: fake(submission()), agreement: { ...agreement, provider: 'stripe' } });
  assert.equal(wrong.code, 'INVALID_AGREEMENT');
});

test('source contract keeps mandate-only finalizer free of subscription creation', () => {
  const source = readFileSync(new URL('./formMonthlyDirectDebitFinalize.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createSubscription|ensureSubscriptionForAgreement/);
  assert.match(FORM_COLUMNS, /access_policy/);
});

test('migration has durable conflict state and DD history values', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261016_form_monthly_direct_debit_lifecycle.sql', import.meta.url), 'utf8');
  assert.match(sql, /status','conflict|MEMBERSHIP_YEAR_EXISTS/);
  assert.match(sql, /monthly_direct_debit/);
  assert.match(sql, /direct_debit/);
});