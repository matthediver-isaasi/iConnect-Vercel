import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateFunnelAmounts, buildFunnelRegistrationPlan,fundedFunnelPaymentMethods } from './eventFunnelRegistrationPlan.js';
import { snapshotFunnelTicket } from './eventFunnelCommercial.js';
import { buildFunnelInvoiceAllocations } from './eventFunnelInvoiceAllocation.js';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('voucher contributions freeze exact original credits for each attendee',()=>{
  const voucherAllocations=[['first',100],['second',101]].map(([voucherId,amountMinor])=>({
    voucherId,amountMinor,lines:[{nodeId:'source',ticketId:'A',amountMinor}],
  }));
  const plan=buildFunnelRegistrationPlan(fixture(),{...options,voucherMinor:201,voucherAllocations});
  assert.equal(plan.voucherAttributionVersion,1);
  for(const row of plan.lines[0].registrations)
    assert.equal(row.voucherContributions.reduce((n,p)=>n+p.amountMinor,0),row.voucherMinor);
  for(const allocation of voucherAllocations)
    assert.equal(plan.lines[0].registrations.flatMap(r=>r.voucherContributions)
      .filter(p=>p.voucherId===allocation.voucherId).reduce((n,p)=>n+p.amountMinor,0),allocation.amountMinor);
  assert.deepEqual(plan,buildFunnelRegistrationPlan(fixture(),{...options,voucherMinor:201,voucherAllocations}));
});
test('payment methods intersect only the remaining payable lines without broadening invoice permission',()=>{
  const lines=[{payableMinor:500,priceSnapshot:{paymentMethods:['card','account']}},
    {payableMinor:0,priceSnapshot:{paymentMethods:['account']}}];
  assert.deepEqual(fundedFunnelPaymentMethods(lines),['card','account']);
  lines[1].payableMinor=1;
  assert.deepEqual(fundedFunnelPaymentMethods(lines),['account']);
  lines[0].priceSnapshot.paymentMethods=['card'];
  assert.deepEqual(fundedFunnelPaymentMethods(lines),[]);
  lines.forEach(line=>line.payableMinor=0);
  assert.deepEqual(fundedFunnelPaymentMethods(lines),['free']);
});
function fixture() {
  const purchaser = { first_name: 'Test', last_name: 'Buyer', email: 'buyer@example.test' };
  const event = { id: uuid(2), tenant_id: uuid(1) };
  const authority = { stripe: { mode: 'test', accountFingerprint: 'account' }, accounting: { name: 'none' }, accountingSettings: {} };
  const price = { ...snapshotFunnelTicket(event, { id: 'A', name: 'Entry', price: 1.005, currency: 'GBP' }, 'simple', authority, { id: uuid(3) }), purchaser };
  return {
    serverNow: '2027-01-23T10:00:00Z',
    session: { id: uuid(4), tenant_id: uuid(1), member_id: uuid(3), state: 'held', revision: 2,
      expires_at: '2027-01-23T10:10:00Z', journey: { version: 1, decisions: {}, checkoutNow: true } },
    graph: { version: 1, tenantId: uuid(1), entry: 'source', reservationSeconds: 600, invoiceMode: 'per_event',
      nodes: [{ id: 'source', type: 'source', event: { id: event.id, kind: 'simple', tenantId: uuid(1) },
        ticketIds: ['A'], requires: [], accept: 'checkout' }, { id: 'checkout', type: 'checkout' }] },
    holds: [{ node_id: 'source', event_kind: 'simple', event_id: event.id, ticket_id: 'A', quantity: 3, places: 3, price_snapshot: price }],
    drafts: { source: { attendeesByTicket: { A: Array.from({ length: 3 }, () => ({ ...purchaser })) } } },
  };
}
const options = { paymentMethod: 'card', invoiceCustomer: { kind: 'member', id: uuid(3) } };

test('real registration plans feed invoice allocations without a parallel fixture-only schema', () => {
  const original=fixture(),plan=buildFunnelRegistrationPlan(original,options);
  const order={id:uuid(90),tenant_id:original.session.tenant_id,state:'confirmed',
    currency:plan.currency,payment_method:plan.paymentMethod,payable_minor:plan.payableMinor,snapshot:plan,
    payment_intent_id:'pi_original',verified_payment:{id:'pi_original',status:'succeeded',
      amount:plan.payableMinor,amountReceived:plan.payableMinor,currency:plan.currency,livemode:false}};
  const allocations=plan.lines.flatMap(line=>line.registrations.map(row=>({
    tenant_id:order.tenant_id,order_id:order.id,booking_id:row.id,
    booking_source:line.eventKind==='simple'?'booking':'complex_event_booking',
    event_id:line.eventId,node_id:line.nodeId,ticket_id:line.ticketId,places:row.places,
    gross_minor:row.grossMinor,payable_minor:row.payableMinor,
    voucher_minor:row.voucherMinor,training_fund_minor:row.trainingFundMinor,
  })));
  const [invoice]=buildFunnelInvoiceAllocations({order,allocations});
  assert.equal(invoice.amountMinor,301);
  assert.equal(invoice.events[0].bookingIds.length,3);
  assert.equal(invoice.settlement.amountMinor,301);
});

test('financial allocations preserve every penny and never exceed a line', () => {
  assert.deepEqual(allocateFunnelAmounts([{ amountMinor: 1 }, { amountMinor: 1 }, { amountMinor: 1 }], 2), [1,1,0]);
  for (let amount = 0; amount <= 103; amount++) {
    const lines = [{ amountMinor: 0 }, { amountMinor: 3 }, { amountMinor: 100 }];
    const result = allocateFunnelAmounts(lines, amount);
    assert.equal(result.reduce((a,b) => a+b), amount);
    result.forEach((part,index) => assert.ok(part >= 0 && part <= lines[index].amountMinor));
  }
  assert.throws(() => allocateFunnelAmounts([{ amountMinor: 1 }], 2));
  assert.throws(() => allocateFunnelAmounts([{ amountMinor: 1 }], NaN));
});
test('materialization is deterministic and preserves original decimal-price rounding', () => {
  const original = fixture(), before = structuredClone(original);
  const plan = buildFunnelRegistrationPlan(original, options);
  assert.deepEqual(plan, buildFunnelRegistrationPlan(original, options));
  assert.deepEqual(original, before);
  assert.equal(plan.payableMinor, 301);
  assert.equal(plan.lines[0].registrations.reduce((n,row) => n+row.grossMinor,0), 301);
  assert.equal(new Set(plan.lines[0].registrations.map(row => row.id)).size, 3);
  assert.ok(plan.lines[0].registrations.every(row => row.row.status === 'confirmed' && row.row.stripe_payment_intent_id === undefined));
  assert.deepEqual(plan.paymentAuthority, { mode: 'test', accountFingerprint: 'account' });
});
test('funding allocation is bounded at both event and individual booking levels', () => {
  const allocation=amount=>[{voucherId:'fixture-credit',amountMinor:amount,lines:[{nodeId:'source',ticketId:'A',amountMinor:amount}]}];
  const plan = buildFunnelRegistrationPlan(fixture(), { ...options, voucherMinor: 100, trainingFundMinor: 101,voucherAllocations:allocation(100) });
  assert.equal(plan.payableMinor, 100);
  const rows = plan.lines[0].registrations;
  for (const row of rows) assert.equal(row.grossMinor, row.payableMinor+row.trainingFundMinor+row.voucherMinor);
  assert.equal(rows.reduce((n,row) => n+row.voucherMinor,0), 100);
  assert.equal(rows.reduce((n,row) => n+row.trainingFundMinor,0), 101);
  const zero = buildFunnelRegistrationPlan(fixture(), { ...options, paymentMethod: 'free', voucherMinor: 301,voucherAllocations:allocation(301) });
  assert.equal(zero.payableMinor, 0);
  assert.ok(zero.lines[0].registrations.every(row => row.row.payment_method === 'voucher'));
  assert.throws(()=>buildFunnelRegistrationPlan(fixture(),{...options,voucherMinor:100}));
});
test('group places do not become fake attendee registrations', () => {
  const input = fixture();
  input.holds[0].places = 12;
  input.holds[0].price_snapshot.groupSize = 4;
  const plan = buildFunnelRegistrationPlan(input, options);
  assert.equal(plan.lines[0].registrations.length, 3);
  assert.equal(plan.lines[0].registrations.reduce((n,row) => n+row.places,0), 12);
});
test('expired, incomplete, unauthorized-method and guest-funding plans fail closed', () => {
  for (const mutate of [
    input => { input.serverNow = input.session.expires_at; },
    input => { input.serverNow = 'bad'; },
    input => { input.drafts.source.attendeesByTicket.A.pop(); },
    input => { input.session.state = 'payable'; },
    input => { input.holds[0].places = 4; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => buildFunnelRegistrationPlan(input, options));
  }
  assert.throws(() => buildFunnelRegistrationPlan(fixture(), { ...options, paymentMethod: 'public_invoice_po' }));
  const guest = fixture(); guest.session.member_id = null;
  assert.throws(() => buildFunnelRegistrationPlan(guest, { ...options, voucherMinor: 1 }));
});
test('a source-event discount balances across attendees and funding, and never reaches other lines',()=>{
  // Three tickets (301p total) with a 100p saving and 50p training fund.
  const discount={discountCodeId:uuid(30),code:'SPRING',type:'fixed',value:1,discountMinor:100,
    lines:[{nodeId:'source',ticketId:'A',discountMinor:100}]};
  const plan=buildFunnelRegistrationPlan(fixture(),{...options,discount,trainingFundMinor:50});
  const [line]=plan.lines;
  assert.deepEqual([line.listMinor,line.discountMinor,line.amountMinor],[301,100,201]);
  assert.equal(plan.discountMinor,100);assert.equal(plan.payableMinor,151);
  assert.equal(line.registrations.reduce((n,r)=>n+r.discountMinor,0),100);
  assert.equal(line.registrations.reduce((n,r)=>n+r.grossMinor,0),201);
  for(const r of line.registrations) {
    assert.ok(r.discountMinor>=0);
    assert.equal(r.grossMinor,r.payableMinor+r.trainingFundMinor+r.voucherMinor);
    assert.equal(Math.round(r.row.total_cost*100),r.grossMinor+r.discountMinor);
  }
  assert.throws(()=>buildFunnelRegistrationPlan(fixture(),{...options,discount:{...discount,
    lines:[{nodeId:'extra',ticketId:'A',discountMinor:100}]}}),/original event purchase/);
  assert.throws(()=>buildFunnelRegistrationPlan(fixture(),{...options,discount:{...discount,discountMinor:400,
    lines:[{nodeId:'source',ticketId:'A',discountMinor:400}]}}),/exceed/);
  assert.throws(()=>buildFunnelRegistrationPlan(fixture(),{...options,discount,trainingFundMinor:202}),/funding/i);
  assert.deepEqual(buildFunnelRegistrationPlan(fixture(),options).discounts,[]);
});
