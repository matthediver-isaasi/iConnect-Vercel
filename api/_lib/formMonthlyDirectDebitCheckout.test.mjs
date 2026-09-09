import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeFormMonthlyDirectDebitEmail,
  formMonthlyDirectDebitApplicantAgreementKey,
  claimFormMonthlyDirectDebitApplicantAgreement,
  persistMonthlyDirectDebitLink,
  findFormMonthlyDirectDebitAgreement,
} from './formMonthlyDirectDebitCheckout.js';

test('DD applicant keys normalize identity without exposing email', () => {
  const key = formMonthlyDirectDebitApplicantAgreementKey({
    tenantId: 't1', email: ' Person@Example.com ', membershipYear: '2026/27',
  });
  assert.match(key, /^form-dd-applicant:[0-9a-f]{64}$/);
  assert.doesNotMatch(key, /person@example/i);
  assert.equal(normalizeFormMonthlyDirectDebitEmail(' A@B.COM '), 'a@b.com');
});

test('claim delegates to guarded transactional RPC and normalizes email', async () => {
  const calls = [];
  const db = { rpc: async (name, params) => {
    calls.push({ name, params });
    return { data: { ok: true, agreement: { id: 'a1' } }, error: null };
  } };
  const result = await claimFormMonthlyDirectDebitApplicantAgreement(db, {
    tenantId: 't1', submissionId: 's1', applicantEmail: ' A@B.COM ',
    membershipYear: '2026/27', agreementKey: 'form-dd-applicant:x',
    environment: 'sandbox', ddSnapshot: { kind: 'monthly_direct_debit' },
  });
  assert.equal(result.data.id, 'a1');
  assert.equal(calls[0].name, 'claim_form_monthly_direct_debit_applicant_agreement');
  assert.equal(calls[0].params.p_applicant_email, 'a@b.com');
});

test('link is CAS guarded to DD pending rows and stores payment reference', async () => {
  const updates = [];
  const db = { from: () => {
    const q = { update: (v) => { updates.push(v); return q; }, eq: () => q,
      select: () => q, maybeSingle: async () => ({ data: { id: 's1' }, error: null }) };
    return q;
  } };
  await persistMonthlyDirectDebitLink(db, { id: 's1', tenant_id: 't1', payment_provider: 'gocardless_monthly_dd', payment_status: 'pending' },
    { monthlyAmountMinor: 1000 }, {
      id: 'a1', tenant_id: 't1', provider: 'gocardless',
      metadata: { form_submission_id: 's1' }, gocardless_billing_request_id: 'br1',
      gocardless_billing_request_flow_id: 'flow1',
    });
  assert.equal(updates[0].payment_reference, 'br1');
});

test('agreement lookup is tenant scoped and direct-id capable', async () => {
  const filters = [];
  const db = { from: () => {
    const q = { select: () => q, eq: (k, v) => { filters.push([k, v]); return q; },
      maybeSingle: async () => ({ data: { id: 'a1' }, error: null }) };
    return q;
  } };
  await findFormMonthlyDirectDebitAgreement(db, { tenantId: 't1', submissionId: 's1', agreementId: 'a1' });
  assert.deepEqual(filters, [['tenant_id', 't1'], ['id', 'a1']]);
});

test('migration revokes public execution and stores DD snapshot server-side', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261016_form_monthly_direct_debit_lifecycle.sql', import.meta.url), 'utf8');
  assert.match(sql, /REVOKE ALL ON FUNCTION claim_form_monthly_direct_debit_applicant_agreement[\s\S]*?FROM PUBLIC/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION bind_form_monthly_direct_debit_membership[\s\S]*?TO service_role/i);
  assert.match(sql, /quote_snapshot/);
});