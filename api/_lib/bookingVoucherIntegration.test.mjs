import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadBookingVouchers, calculateComplexEventCreditQuote } from './complexEventCreditQuote.js';
import { programPurchasePrice, quoteProgramPurchase } from './programVoucherPurchase.js';
import { complexEventInvoiceLines } from './eventInvoiceProducer.js';
import { refundBookingVoucherCredit } from './voucherCreditService.js';

test('complex checkout maps account/invoice/PO to liabilities, not nonexistent stored credit', () => {
  const source=readFileSync(new URL('../public/complex-event-booking.js',import.meta.url),'utf8');
  assert.match(source,/Stored account credit is unavailable/);
  assert.doesNotMatch(source,/org\.account_balance|actualAccountBalanceApplied/);
  assert.doesNotMatch(source,/\.select\('[^']*\baccount_balance\b/);
  assert.match(source,/accountMinor: 0/);
  assert.match(source,/payment_method === 'account' \|\| payment_method === 'invoice'/);
  assert.match(source,/validPaidMethods = \['card', 'account', 'training_fund', 'voucher', 'invoice', PUBLIC_INVOICE_PO\]/);
  const ui=readFileSync(new URL('../../client/src/components/booking/PaymentOptions.jsx',import.meta.url),'utf8');
  assert.doesNotMatch(ui,/value="account_balance"|setRemainingBalancePaymentMethod\('account_balance'\)/);
  assert.match(ui,/Invoice Organisation/);
});

function dbFor(rows) {
  return { from(table) {
    const filters = [];
    let singular = false;
    const q = {
      select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      in(k,v) { filters.push(r => v.includes(r[k])); return q; },
      gte() { return q; }, order() { return q; }, limit() { return q; },
      single() { singular = true; return q; }, maybeSingle() { singular = true; return q; },
      then(resolve,reject) {
        const data = (rows[table] || []).filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data: singular ? data[0] || null : data, error: null }).then(resolve,reject);
      },
    };
    return q;
  } };
}
const member = { id: 'm', tenant_id: 't', organization_id: 'o', role_id: 'blocked', email: 'member@example.invalid' };
const organization = { id: 'o', tenant_id: 't', voucher_allowed_role_ids: ['allowed'], training_fund_balance: 25 };
const personal = { id: 'personal', tenant_id: 't', member_id: 'm', value: 40, status: 'active', expires_at: '2099-01-01' };
const orgCredit = { ...personal, id: 'org', member_id: null, organization_id: 'o' };
const enabled = [{ tenant_id: 't', setting_key: 'individual_vouchers_enabled', setting_value: 'true' }];

test('booking preflight accepts personal credit without organisation role or membership', async () => {
  for (const purchaser of [member, { ...member, organization_id: null }]) {
    const rows = await loadBookingVouchers(dbFor({ voucher: [personal], system_settings: enabled }), {
      tenantId: 't', member: purchaser, organization, voucherIds: ['personal'],
    });
    assert.deepEqual(rows, [personal]);
  }
});
test('org role restrictions, flag off, foreign owners and foreign tenants fail closed', async () => {
  for (const [voucher, settings, purchaser] of [
    [orgCredit, enabled, member], [personal, [], member],
    [{ ...personal, member_id: 'other' }, enabled, member],
    [{ ...personal, tenant_id: 'other' }, enabled, member],
  ]) {
    await assert.rejects(loadBookingVouchers(dbFor({ voucher: [voucher], system_settings: settings }), {
      tenantId: 't', member: purchaser, organization, voucherIds: [voucher.id],
    }));
  }
});
test('legacy org-only absence/off settings preserves permitted organisation credit', async () => {
  const allowedMember = { ...member, role_id: 'allowed' };
  for (const settings of [[], [{ tenant_id: 't', setting_key: 'individual_vouchers_enabled', setting_value: 'false' }]]) {
    const vouchers = await loadBookingVouchers(dbFor({ voucher: [orgCredit], system_settings: settings }), {
      tenantId: 't', member: allowedMember, organization, voucherIds: ['org'],
    });
    assert.equal(calculateComplexEventCreditQuote({ totalMinor: 10000, vouchers, requestedVoucherIds: ['org'] }).remainingMinor, 6000);
  }
});
test('programme quote derives owner, price and funding server-side', async () => {
  const db = dbFor({ member: [member], organization: [organization], voucher: [personal],
    system_settings: enabled, program: [{ id: 'p', tenant_id: 't', name: 'Programme', program_tag: 'tag', program_ticket_price: 50 }] });
  const quote = await quoteProgramPurchase(db, { tenantId: 't', memberId: 'm', params: {
    programId: 'p', quantity: 2, amount: 0.01, organizationId: 'forged', selectedVoucherIds: ['personal'],
  } });
  assert.equal(quote.organizationId, 'o');
  assert.equal(quote.grossMinor, 10000);
  assert.equal(quote.voucherMinor, 4000);
  assert.equal(quote.remainingMinor, 6000);
});
test('programme offer pricing reconciles legacy BOGO, enter-total and bulk', () => {
  const base = { program_ticket_price: 10, offer_type: 'bogo', bogo_buy_quantity: 3, bogo_get_free_quantity: 1 };
  assert.deepEqual(programPurchasePrice(base, 6), { totalMinor: 6000, tickets: 8 });
  assert.deepEqual(programPurchasePrice({ ...base, bogo_logic_type: 'enter_total_pay_less' }, 8), { totalMinor: 6000, tickets: 8 });
  assert.deepEqual(programPurchasePrice({ program_ticket_price: 10, offer_type: 'bulk_discount', bulk_discount_threshold: 5, bulk_discount_percentage: 20 }, 5), { totalMinor: 4000, tickets: 5 });
  assert.throws(() => programPurchasePrice(base, -1));
});
test('new invoice funding distinguishes equal owner display names', () => {
  const voucherFunding = [
    { ownerType: 'member', displayName: 'Credit', amountMinor: 200 },
    { ownerType: 'organization', displayName: 'Credit', amountMinor: 300 },
  ];
  const lines = complexEventInvoiceLines({ event: { title: 'Event' }, resolvedItems: [],
    actualVoucherApplied: 5, actualTfApplied: 0, voucherFunding }, '200');
  assert.deepEqual(lines.map(l => l.Description), ['Credit (Personal) funding', 'Credit (Organisation) funding']);
  assert.equal(lines.reduce((n,l) => n + l.UnitAmount, 0), -5);
});
test('cancellation sends immutable booking provenance to atomic RPC, never current organisation', async () => {
  let call;
  await refundBookingVoucherCredit({ rpc: async (name,args) => { call = { name,args }; return { data: { vouchers: [] } }; } },
    { tenantId: 't', bookingId: 'b', source: 'complex_event_booking',
      refundAllocation: { vouchers: { personal: 12 } }, reversalOptions: {} });
  assert.equal(call.name, 'voucher_credit_refund_booking');
  assert.equal(call.args.p_booking_id, 'b');
  assert.equal(call.args.p_tenant_id, 't');
  assert.equal('organization_id' in call.args, false);
});
