import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMembership, matchesPeriod } from './gfi-membership-comparison.mjs';
const row = { organization: 'Example University', membership_year: '2025/2026', currency: 'GBP',
  final_cost: 100, vat_amount: 20, total_with_vat: 120 };
const contacts = [{ ContactID: 'c', Name: ' EXAMPLE  university ', ContactStatus: 'ACTIVE' }];
const invoice = { InvoiceID: 'i', Type: 'ACCREC', Contact: { ContactID: 'c' }, Status: 'PAID',
  CurrencyCode: 'GBP', SubTotal: 100, TotalTax: 20, Total: 120,
  LineItems: [{ Description: 'Service Membership - August 2025 - July 2026' }] };
const compare = (invoices, cs = contacts, linked = new Set()) => compareMembership(row, cs, invoices, linked).finding;
test('matches exact organisation, full period, net, VAT and total without email', () => {
  assert.equal(compare([invoice]), 'Unique exact membership invoice match');
  assert.equal(matchesPeriod({ LineItems: [{ Description: 'Membership 2025/26' }] }, row.membership_year), true);
});
test('does not infer year solely from issue date or amount', () => {
  assert.equal(compare([{ ...invoice, LineItems: [{ Description: 'Membership subscription' }], DateString: '2025-08-01' }]),
    'No evidenced membership-period match under exact-name contact');
});
test('duplicates, foreign contacts, prior links, credit status and mismatches require review', () => {
  assert.equal(compare([invoice, { ...invoice, InvoiceID: 'i2' }]), 'Multiple matching invoices; duplicate review required');
  assert.equal(compare([invoice], [...contacts, { ...contacts[0], ContactID: 'c2' }]), 'Ambiguous or archived organisation contact');
  assert.equal(compare([invoice], contacts, new Set(['i'])), 'Matching invoice already linked elsewhere');
  assert.equal(compare([{ ...invoice, Status: 'VOIDED' }]), 'Only voided/deleted exact matches');
  assert.equal(compare([{ ...invoice, TotalTax: 0 }]), 'Membership period found; amounts or currency differ');
  assert.equal(compare([invoice], []), 'No exact-name Xero contact; identity review required');
});
