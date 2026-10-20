import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS, TENANT, hash } from './prepare-bnms-five-members.mjs';
import { APPROVED, buildApprovedRows, invoiceProjection, paymentProjection }
  from './repair-bnms-five-verified-paid.mjs';

// Synthetic unit evidence, never sent to a database or provider.
function fixture() {
  const terms = [
    [352, 'Full Membership DD', '2026-07-30', null],
    [3949, 'Trainee Membership UK', '2026-02-26', '2027-01-31'],
    [1932, 'LMIC Membership', '2026-01-14', '2027-01-12'],
    [175, 'Junior Membership UK', '2021-02-18', '2026-08-25'],
    [3661, 'Full Membership UK', '2026-02-17', '2027-02-17'],
  ];
  const evidence = MEMBERS.map((id,index) => ({
    member: { id, tenant_id: TENANT, email: `fixture-${index}@example.invalid` },
    prefs: [{ name: 'member_class', value: 'Unit fixture' },
      ...(terms[index][3] ? [{ name: 'ym_date_membership_expires',
        value: terms[index][3].split('-').reverse().join('/') }] : [])],
    contacts: [], invoices: [],
  }));
  const source = terms.map(([row, type, start, end], index) => ({
    row, sha256: 'eb6939e0e1d88357a54a988d9238f49ac1fb706d62643f8b61ea8f9d6560dc8c',
    file: 'attached_assets/unit-fixture.xlsx', sheet: 'fixture',
    data: { 'iConnect UUID': MEMBERS[index], 'Membership History - Membership': type,
      'Membership History - Membership Start Date': `${start} 00:00:00`,
      ...(end ? { 'Membership History - Membership End Date': `${end} 00:00:00` } : {}) },
  }));
  source.push({ row: 162, sha256: source[0].sha256, data: {
    'iConnect UUID': MEMBERS[3], 'Membership History - Membership': 'Guest',
    'Membership History - Membership Start Date': '2026-08-26 00:00:00',
  } });
  const decisions = APPROVED.map(([memberId,invoiceId,number,total], index) => {
    const member = evidence.find(e => e.member.id === memberId);
    const contactId = `fixture-contact-${index}`;
    const payment = { PaymentID: `fixture-payment-${index}`, Invoice: { InvoiceID: invoiceId },
      Status: 'AUTHORISED', Amount: total, Date: '/Date(1785283200000+0000)/' };
    member.contacts.push({ ContactID: contactId, EmailAddress: member.member.email });
    member.invoices.push({ InvoiceID: invoiceId, InvoiceNumber: number, Type: 'ACCREC',
      Status: 'PAID', Contact: { ContactID: contactId }, CurrencyCode: 'GBP',
      Total: total, SubTotal: total, TotalTax: 0, AmountPaid: total, AmountDue: 0,
      LineItems: [{ Description: 'Unit Membership' }],
      Payments: [{ PaymentID: payment.PaymentID, Amount: total }] });
    return { memberId, invoiceId, invoiceNumber: number, contactId, payments: [payment] };
  });
  return { evidence, decisions, source };
}
test('approved runner constructs only the three verified paid legacy rows', () => {
  const { evidence, decisions, source } = fixture();
  const original = hash({ evidence, decisions, source });
  const rows = buildApprovedRows(evidence, decisions, source);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.member_id), APPROVED.map(a => a[0]));
  assert.deepEqual(rows.map(r => r.total_with_vat), [156,61,156]);
  assert.equal(rows[0].term_start_date, '2026-07-30');
  assert.equal(rows[0].term_end_date, null);
  assert.equal(rows[1].term_start_date, '2026-01-14');
  assert.equal(rows[1].term_end_date, '2027-01-12');
  assert.equal(rows[2].term_end_date, '2027-02-17');
  for (const row of rows) {
    assert.equal(row.payment_status, 'paid');
    assert.equal(row.paid_at, '2026-07-29T00:00:00.000Z');
    assert.ok(!('membership_source' in row) && !('payment_frequency' in row));
    for (const key of ['config_id','term_key','membership_renewal_date','commitment_snapshot',
      'billing_agreement_id','payment_method','billing_period','annual_cost']) assert.equal(row[key], null);
    const notes = JSON.parse(row.notes);
    assert.equal(notes.purchasedRollingCommitment, false);
    assert.equal(notes.renewalAuthority, false);
    assert.equal(notes.futureCollectionConsent, false);
  }
  assert.equal(hash({ evidence, decisions, source }), original);
});
test('runner fails closed for altered scope, amount, settlement date or source', () => {
  for (const mutation of [
    f => f.decisions.pop(),
    f => { f.decisions[0].memberId = MEMBERS[1]; },
    f => { f.evidence[0].invoices[0].Total = 155; },
    f => { f.decisions[0].payments[0].Date = null; },
    f => { f.source[0].data['Membership History - Membership Start Date'] = '2026-07-01 00:00:00'; },
  ]) {
    const f = fixture(); mutation(f);
    assert.throws(() => buildApprovedRows(f.evidence, f.decisions, f.source));
  }
});
test('provider invariant projections detect financial changes and ignore response decorations', () => {
  const { evidence, decisions } = fixture();
  const invoice = evidence[0].invoices[0], payment = decisions[0].payments[0];
  assert.deepEqual(invoiceProjection(invoice), invoiceProjection({ ...invoice, HasErrors: false }));
  assert.notDeepEqual(invoiceProjection(invoice), invoiceProjection({ ...invoice, AmountCredited: 156 }));
  assert.notDeepEqual(paymentProjection(payment), paymentProjection({ ...payment, Status: 'DELETED' }));
});
