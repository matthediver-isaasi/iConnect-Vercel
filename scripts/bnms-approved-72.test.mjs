import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, assertRecord, historyId, financialProjection, approvalState } from './bnms-approved-72-core.mjs';

function fixture() {
  return {
    candidate: { memberId: 'reviewed-member', memberClass: 'Full', proposedStart: '2026-03-01',
      retainedExpiry: '2027-02-28', proposedRenewal: '2027-03-01', membershipAmount: 156 },
    config: { id: 'config', billing_period: 'annual', start_mode: 'immediate', structure_match_value: 'Full' },
    provider: { latestPaidInvoiceId: 'invoice',
      membershipInvoices: [{ InvoiceID: 'invoice', InvoiceNumber: '123', Total: 556,
        LineItems: [{ LineItemID: 'membership', Description: 'Full Membership UK', Quantity: 1, LineAmount: 156, TaxAmount: 0 },
          { Description: 'Event', LineAmount: 400, TaxAmount: 0 }] }],
      payments: [{ PaymentID: 'payment', Date: '/Date(1772409600000+0000)/' }] },
  };
}
test('mixed invoice reconstructs only approved membership amount, preserving unknowns', () => {
  const f = fixture(), row = buildRecord(f.candidate, f.config, f.provider);
  assert.equal(row.final_cost, 156); assert.equal(row.total_with_vat, 156);
  assert.equal(row.term_start_date, '2026-03-01'); assert.equal(row.term_end_date, '2027-02-28');
  assert.equal(row.membership_renewal_date, '2027-03-01');
  assert.equal(row.previous_term_id, null);
  const notes = JSON.parse(row.notes);
  assert.equal(notes.futureCollectionConsent, false);
  assert.equal(notes.originalQuoteAndConsent, 'unknown');
  assert.equal(notes.historicalPaymentInstrument, 'unknown');
});
test('wrong dates, structure, amounts, quantities, tax and missing payments fail closed', () => {
  for (const mutate of [
    f => f.candidate.proposedRenewal = '2027-03-02',
    f => f.candidate.retainedExpiry = '2027-02-27',
    f => f.config.structure_match_value = 'Student',
    f => f.config.start_mode = 'fixed',
    f => f.config.billing_period = 'monthly',
    f => f.candidate.membershipAmount = 556,
    f => f.provider.membershipInvoices[0].LineItems[0].TaxAmount = 1,
    f => f.provider.membershipInvoices[0].LineItems[0].Quantity = 2,
    f => f.provider.payments = [],
    f => f.provider.payments[0].Date = 'unknown',
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => buildRecord(f.candidate, f.config, f.provider));
  }
});
test('deterministic row identities and timestamp-normalized replay reject actual changes', () => {
  assert.equal(historyId('member'), historyId('member'));
  assert.notEqual(historyId('member'), historyId('other'));
  const f = fixture(), row = buildRecord(f.candidate, f.config, f.provider);
  assertRecord({ ...row, paid_at: row.paid_at.replace('.000Z', '+00:00') }, row);
  assert.throws(() => assertRecord({ ...row, final_cost: 556 }, row));
  assert.throws(() => assertRecord({ ...row, term_end_date: '2028-02-28' }, row));
});
test('financial projection ignores display metadata, but retains payment and line evidence', () => {
  const a = { InvoiceID: 'i', Contact: { ContactID: 'c', Name: 'Old name' }, Total: 156 };
  assert.deepEqual(financialProjection(a), financialProjection({ ...a, Contact: { ContactID: 'c', Name: 'New name' } }));
  assert.notDeepEqual(financialProjection(a), financialProjection({ ...a, Total: 200 }));
});
test('between-phase approval pins every approved member field, preference, history and proposed row', () => {
  const before = { member: [{ id: 'approved', status: 'active' }, { id: 'other', last_activity: 'old' }],
    member_preference_value: [{ member_id: 'approved', value: 'Full' }],
    member_membership_history: [] };
  const records = [{ member_id: 'approved', final_cost: 156 }];
  const expected = approvalState(before, records);
  const unrelated = structuredClone(before);
  unrelated.member[1].last_activity = 'new';
  assert.deepEqual(approvalState(unrelated, records), expected);
  for (const mutate of [
    b => b.member[0].status = 'inactive',
    b => b.member_preference_value[0].value = 'Student',
    b => b.member_membership_history.push({ member_id: 'approved', id: 'new' }),
  ]) {
    const changed = structuredClone(before); mutate(changed);
    assert.notDeepEqual(approvalState(changed, records), expected);
  }
  assert.notDeepEqual(approvalState(before, [{ member_id: 'approved', final_cost: 200 }]), expected);
});
