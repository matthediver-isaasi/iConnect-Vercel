import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMBERS, TENANT, prepareProposal, planIdempotentInserts, legacyExpiry, hash }
  from './prepare-bnms-five-members.mjs';

// Synthetic unit fixtures only; no provider or database clients.
const fixture = () => MEMBERS.map((id, index) => ({
  member: { id, tenant_id: TENANT, email: `member${index}@example.invalid` },
  prefs: [
    { name: 'member_class', value: 'Test class' },
    { name: 'ym_date_membership_expires', value: index === 3 ? '25/08/2026' : '12/01/2027' },
  ], contacts: [], invoices: [],
}));
const today = '2026-10-17';
function withInvoice() {
  const evidence = fixture();
  const invoice = {
    InvoiceID: 'unit-invoice', InvoiceNumber: 'UNIT-1', Type: 'ACCREC', Status: 'PAID',
    CurrencyCode: 'GBP', Total: 61, SubTotal: 61, TotalTax: 0, AmountDue: 0, AmountPaid: 61,
    Contact: { ContactID: 'unit-contact' }, LineItems: [{ Description: 'LMIC Membership' }],
    Payments: [{ PaymentID: 'unit-payment', Amount: 61 }],
  };
  evidence[2].invoices = [invoice];
  evidence[2].contacts = [{ ContactID: 'unit-contact', EmailAddress: evidence[2].member.email }];
  const decision = { memberId: MEMBERS[2], invoiceId: 'unit-invoice', invoiceNumber: 'UNIT-1',
    contactId: 'unit-contact', payments: [{ PaymentID: 'unit-payment', Amount: 61,
      Status: 'AUTHORISED', Invoice: { InvoiceID: 'unit-invoice' } }] };
  return { evidence, decision, invoice };
}
test('invoice-less histories preserve unknown payment, money, start and renewal authority', () => {
  const proposal = prepareProposal(fixture(), [], today);
  assert.equal(proposal.rows.length, 5);
  for (const row of proposal.rows) {
    for (const key of ['payment_status','payment_method','annual_cost','total_with_vat',
      'term_start_date','membership_renewal_date','config_id','billing_agreement_id','paid_at']) {
      assert.equal(row[key], null, key);
    }
    assert.equal(JSON.parse(row.notes).renewalAuthority, false);
  }
  assert.equal(proposal.rows[3].status, 'expired');
  assert.equal(proposal.productionWrites, 0);
});
test('missing expiry is blocked, never inferred from invoice issue date', () => {
  const { evidence, decision, invoice } = withInvoice();
  evidence[2].prefs = evidence[2].prefs.filter(p => !p.name.includes('expires'));
  invoice.DateString = '2026-01-08T00:00:00';
  const proposal = prepareProposal(evidence, [decision], today);
  assert.equal(proposal.rows.length, 4);
  assert.equal(proposal.blocked[0].memberId, MEMBERS[2]);
});
test('only explicitly selected membership invoice with verified actual payments is linked', () => {
  const { evidence, decision } = withInvoice();
  const row = prepareProposal(evidence, [decision], today).rows[2];
  assert.equal(row.total_with_vat, 61);
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.xero_invoice_number, 'UNIT-1');
  assert.equal(row.term_start_date, null);
  assert.equal(row.payment_method, null);
});
for (const [name, mutate] of [
  ['credited paid invoice', ({ invoice }) => { invoice.AmountPaid = 0; invoice.AmountCredited = 61; }],
  ['deleted invoice', ({ invoice }) => { invoice.Status = 'DELETED'; }],
  ['event invoice', ({ invoice }) => { invoice.LineItems[0].Description = 'Spring meeting'; }],
  ['mixed invoice', ({ invoice }) => { invoice.LineItems.push({ Description: 'Meeting' }); }],
  ['unverified alternate contact', ({ evidence }) => { evidence[2].contacts[0].EmailAddress = 'other@example.invalid'; }],
  ['missing payment', ({ decision }) => { decision.payments = []; }],
  ['deleted payment', ({ decision }) => { decision.payments[0].Status = 'DELETED'; }],
  ['payment on other invoice', ({ decision }) => { decision.payments[0].Invoice.InvoiceID = 'other'; }],
  ['mismatched invoice number', ({ decision }) => { decision.invoiceNumber = 'other'; }],
]) {
  test(`rejects ${name}`, () => {
    const context = withInvoice();
    mutate(context);
    assert.throws(() => prepareProposal(context.evidence, [context.decision], today));
  });
}
test('exact replay is no-op; drift, other histories and invoice reuse fail closed', () => {
  const { evidence, decision } = withInvoice();
  const { rows } = prepareProposal(evidence, [decision], today);
  assert.equal(planIdempotentInserts(rows, []).pending.length, 5);
  assert.equal(planIdempotentInserts(rows, structuredClone(rows)).pending.length, 0);
  assert.equal(planIdempotentInserts(rows, structuredClone(rows)).replayed.length, 5);
  const drift = structuredClone(rows); drift[0].total_with_vat = 123;
  assert.throws(() => planIdempotentInserts(rows, drift));
  assert.throws(() => planIdempotentInserts(rows, [{ ...rows[0], id: 'other' }]));
  assert.throws(() => planIdempotentInserts(rows, [{
    id: 'other', tenant_id: 'other-tenant', member_id: 'other-member',
    accounting_invoice_id: 'unit-invoice',
  }]));
});
test('strict dates, exact cohort and duplicate preferences/decisions', () => {
  assert.equal(legacyExpiry('12/01/2027'), '2027-01-12');
  assert.throws(() => legacyExpiry('31/02/2027'));
  assert.throws(() => legacyExpiry('1/2/2027'));
  assert.throws(() => prepareProposal(fixture().slice(1), [], today));
  const e = fixture(); e[0].prefs.push(e[0].prefs[0]);
  assert.throws(() => prepareProposal(e, [], today));
  assert.throws(() => prepareProposal(fixture(), [{memberId: MEMBERS[0]}, {memberId: MEMBERS[0]}], today));
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
test('pinned original dates preserve nonannual terms and open-ended DD without renewal authority', () => {
  const sha256 = 'eb6939e0e1d88357a54a988d9238f49ac1fb706d62643f8b61ea8f9d6560dc8c';
  const specifications = [
    [352, 'Full Membership DD', '2026-07-30', null],
    [3949, 'Trainee Membership UK', '2026-02-26', '2027-01-31'],
    [1932, 'LMIC Membership', '2026-01-14', '2027-01-12'],
    [175, 'Junior Membership UK', '2021-02-18', '2026-08-25'],
    [3661, 'Full Membership UK', '2026-02-17', '2027-02-17'],
  ];
  const source = specifications.map(([row, membership, start, end], index) => ({
    row, sha256, file: 'unit-fixture.xlsx', sheet: 'unit-sheet',
    data: { 'iConnect UUID': MEMBERS[index], 'Membership History - Membership': membership,
      'Membership History - Membership Start Date': `${start} 00:00:00`,
      ...(end ? { 'Membership History - Membership End Date': `${end} 00:00:00` } : {}) },
  }));
  source.push({ row: 162, sha256, data: {
    'iConnect UUID': MEMBERS[3], 'Membership History - Membership': 'Guest',
    'Membership History - Membership Start Date': '2026-08-26 00:00:00',
  } });
  const evidence = fixture();
  evidence.forEach((e, index) => {
    const end = specifications[index][3];
    e.prefs = e.prefs.filter(p => p.name !== 'ym_date_membership_expires');
    if (end) e.prefs.push({ name: 'ym_date_membership_expires',
      value: `${end.slice(8)}/${end.slice(5,7)}/${end.slice(0,4)}` });
  });
  const proposal = prepareProposal(evidence, [], today, source);
  assert.equal(proposal.blocked.length, 0);
  assert.equal(proposal.rows[0].term_end_date, null);
  assert.equal(proposal.rows[0].payment_method, null);
  assert.equal(proposal.rows[1].term_start_date, '2026-02-26');
  assert.equal(proposal.rows[1].term_end_date, '2027-01-31');
  assert.equal(proposal.rows[2].term_start_date, '2026-01-14');
  assert.equal(proposal.rows[3].tier_label, 'Junior Membership UK');
  assert.equal(proposal.rows[3].status, 'expired');
  assert.ok(proposal.rows.every(r => r.config_id === null && r.membership_renewal_date === null));
  const changed = structuredClone(source);
  changed[1].data['Membership History - Membership Start Date'] = '2026-01-31 00:00:00';
  assert.throws(() => prepareProposal(evidence, [], today, changed));
  assert.throws(() => prepareProposal(evidence, [], today, source.slice(0,-1)));
});
