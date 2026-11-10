import test from 'node:test';
import assert from 'node:assert/strict';
import { TENANT, reviewMember, invoiceKind } from './lib/bnms-invoice-date-repair.mjs';
const setup = () => ({
  m: { id: 'm', tenant_id: TENANT },
  h: [{ id: 'h', tenant_id: TENANT, member_id: 'm', status: 'active', payment_status: 'paid', payment_method: 'upfront',
    term_start_date: null, term_end_date: '2027-03-03', term_key: null }],
  i: [{ id: 'i', tenant_id: TENANT, member_id: 'm', record_kind: 'invoice', accounting_status: 'PAID',
    accounting_payment_status: 'paid', xero_document_id: 'x', invoice_date: '2026-03-03',
    description: "S2026 event (incl. 1 year's full membership)", amount_minor: 55600 }],
  c: [{ id: 'c', tenant_id: TENANT, structure_scope_type: 'member', is_active: true, structure_match_value: 'Full',
    effective_from: '2026-01-01', billing_period: 'annual', renewal_open_days: 90, renewal_grace_days: 90 }],
  related: { agreements: [], plans: [], quotes: [], elections: [] },
});
const run = f => reviewMember(f.m, f.h, f.i, f.c, { memberClass: 'Full' }, f.related, '2026-11-11');
test('invoice establishes missing start without changing expiry or allocating package total', () => {
  const r = run(setup()).repairs[0];
  assert.equal(r.start, '2026-03-03'); assert.equal(r.end, '2027-03-03');
  assert.equal(r.patch.renewal_policy_snapshot.renewal_grace_days, 90);
  assert(!('membership_renewal_date' in r.patch));
  assert(!('final_cost' in r.patch)); assert(!('term_key' in r.patch));
  assert.equal(r.patch.accounting_invoice_id, 'x');
});
for (const [label, mutate] of [
  ['deleted', f => f.m.is_deleted = true],
  ['unpaid invoice', f => f.i[0].accounting_payment_status = 'unpaid'],
  ['old cycle', f => f.i[0].invoice_date = '2025-03-03'],
  ['ambiguous invoice', f => f.i.push({ ...f.i[0], id: 'i2' })],
  ['recurring', f => f.related.agreements.push({ status: 'active' })],
  ['checkout', f => f.related.quotes.push({ id: 'q' })],
  ['changed class schedule', f => f.h[0].config_id = 'other'],
  ['locked commitment', f => f.h[0].term_key = 'rolling:2026-03-03'],
  ['credit note', f => f.i[0].record_kind = 'credit_note'],
  ['overlap', f => f.h.push({ id: 'other', term_start_date: '2027-03-01', term_end_date: '2028-02-29' })],
]) test(`holds ${label}`, () => { const f = setup(); mutate(f); assert.equal(run(f).state, 'held'); });
test('does not rewrite existing approved commencement', () => {
  const f = setup(); f.h[0].term_start_date = '2026-03-04';
  assert.equal(run(f).repairs[0].start, '2026-03-04');
});
test('ordinary member event tickets do not prove membership purchase', () => {
  const f = setup(); f.i[0].description = 'S2026 Full member attending full event';
  assert.equal(invoiceKind(f.i[0]), null);
});
