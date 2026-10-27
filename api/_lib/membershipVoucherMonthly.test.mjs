import test from 'node:test';
import assert from 'node:assert/strict';
import { monthlyVoucherCreditLimit, fundedMonthlySnapshot, monthlyFundingSlice, fundedInstalmentDate,
  releaseMembershipVoucherMonthly } from './membershipVoucherMonthly.js';
import { postMembershipVoucherMonthlyPayment, postMembershipVoucherMonthlyCashBatch, accountFullyFundedMonthlyMembership } from './membershipVoucherMonthlyAccounting.js';
import { createGuardedPortalMembershipIntent } from './membershipVoucherSettlement.js';
import { reconcileMembershipVoucherCashRefund, membershipVoucherRefundContext } from './membershipVoucherRefund.js';

const base = { plan_total: 100, monthly_amount_minor: 2500, monthly_amount: 25,
  currency: 'GBP', instalment_count: 4, membership_year: '2026', invoicing_mode: 'annual',
  payment_mode: 'stripe_monthly', accepted_at: new Date().toISOString(),
  commitment: { plan_total: 100 }, billing_request_payment: { included: false, amount_minor: 2500 } };
const funding = { payableMinor: 10000, voucherMinor: 4000, remainingMinor: 6000, currency: 'GBP',
  allocations: [
    { id: 'a', voucherId:'voucher-a', amountMinor: 2600, ownerType: 'member', displayName: 'Personal Learning' },
    { id: 'b', voucherId:'voucher-b', amountMinor: 1400, ownerType: 'organization', displayName: 'Employer Training' },
  ] };

test('finite funding caps partial credit exactly per instalment and leaves pennies on source', () => {
  assert.equal(monthlyVoucherCreditLimit({ grossMinor: 12000, availableMinor: 4007, count: 12, minimumMinor: 100 }), 3996);
  assert.equal(monthlyVoucherCreditLimit({ grossMinor: 12000, availableMinor: 11999, count: 12, minimumMinor: 100 }), 10800);
  assert.equal(monthlyVoucherCreditLimit({ grossMinor: 12000, availableMinor: 12000, count: 12, minimumMinor: 100 }), 12000);
  assert.equal(monthlyVoucherCreditLimit({ grossMinor: 12001, availableMinor: 100, count: 12, minimumMinor: 100 }),97);
});
test('an issued invoice penny remainder is funded without fractional provider cash or lost gross/credit',()=>{
  const odd={...funding,payableMinor:10001,voucherMinor:4001,allocations:[
    {...funding.allocations[0],amountMinor:2600},{...funding.allocations[1],amountMinor:1401},
  ]};
  const scheduled=fundedMonthlySnapshot({...base,plan_total:100.01},odd,'odd');
  const periods=[1,2,3,4].map(i=>monthlyFundingSlice(scheduled.voucher_funding,i));
  assert.deepEqual(periods.map(p=>p.cashMinor),[1500,1500,1500,1500]);
  assert.equal(periods.reduce((sum,p)=>sum+p.grossMinor,0),10001);
  assert.equal(periods.reduce((sum,p)=>sum+p.creditMinor,0),4001);
  assert.deepEqual(periods.map(p=>p.grossMinor-p.creditMinor),[1500,1500,1500,1500]);
});
test('provider net overlay preserves gross purchased terms and never mutates the next renewal offer', () => {
  const original = structuredClone(base);
  const snapshot = fundedMonthlySnapshot(base, funding, 'settlement');
  assert.equal(snapshot.monthly_amount_minor, 1500);
  assert.equal(snapshot.plan_total, 100);
  assert.equal(snapshot.instalment_count, 4);
  assert.deepEqual(base, original);
  assert.equal(base.voucher_funding, undefined);
  assert.equal(base.monthly_amount_minor, 2500);
  const slices = [1,2,3,4].map(n => monthlyFundingSlice(snapshot.voucher_funding, n));
  assert.equal(slices.reduce((sum, s) => sum + s.grossMinor, 0), 10000);
  assert.equal(slices.reduce((sum, s) => sum + s.creditMinor, 0), 4000);
  assert.equal(slices.reduce((sum, s) => sum + s.cashMinor, 0), 6000);
  assert.deepEqual(slices[2].allocations.map(a => a.amountMinor), [600,400]);
  assert.throws(() => monthlyFundingSlice(snapshot.voucher_funding, 5));
});
test('zero-cash schedule uses immutable dates, clamps month ends and retains future instalments', () => {
  const snapshot = { ...base, accepted_at: '2028-01-31T12:00:00Z' };
  assert.equal(fundedInstalmentDate(snapshot, 2), '2028-02-29');
  assert.equal(fundedInstalmentDate(snapshot, 3), '2028-03-31');
});

function fixture({ accounting = 'xero', mode = 'annual', full = false, rail = 'stripe' } = {}) {
  const sourceFunding = full ? { ...funding, voucherMinor: 10000, remainingMinor: 0,
    allocations: [{ ...funding.allocations[0], amountMinor: 10000 }] } : funding;
  const snapshot = { ...base, invoicing_mode: mode, payment_mode: rail === 'stripe' ? 'stripe_monthly' : 'direct_debit' };
  const settlement = { id: 'settlement', fee_token_id: 'token', tenant_id: 'tenant', state: full ? 'committed' : 'plan_committed',
    history_record_id: 'history', funding: sourceFunding, monthly_snapshot: snapshot, accounting_status: 'pending',
    history_snapshot: { __accounting: { vatRate: 'NONE', nominalCode: '200' } } };
  const tables = {
    membership_voucher_settlement: [settlement],
    membership_fee_token: [{ id: 'token', tenant_id: 'tenant', member_id: 'member', membership_year: '2026' }],
    member_membership_history: [{ id: 'history', tenant_id: 'tenant', member_id: 'member', final_cost: 100, total_with_vat: 100 }],
    member: [{ id: 'member', tenant_id: 'tenant', first_name: 'Test', last_name: 'Member', email: 'isolated@example.invalid' }],
    membership_voucher_collection: [], membership_payment_term_claim: [],
    xero_token: [{ id: 'xero-connection', app_tenant_id: 'tenant', tenant_id: 'company' }],
    quickbooks_token: [{ id: 'qbo-connection', app_tenant_id: 'tenant', realm_id: 'company', environment: 'sandbox' }],
    voucher: [{ id:'voucher-a',tenant_id:'tenant',expires_at:'2099-01-01' },{ id:'voucher-b',tenant_id:'tenant',expires_at:'2099-01-01' }],
    gocardless_refunds: [],voucher_allocation_refund:[],
  };
  const db = { async rpc(name, args) {
    if(name==='member_credit_return_context')return {data:{applicable:false}};
    if(name==='member_credit_funding_proofs')return {data:[]};
    if (name === 'voucher_credit_refund_allocation') {
      let row=tables.voucher_allocation_refund.find(r=>r.allocation_id===args.p_allocation_id && r.refund_key===args.p_refund_key);
      if (!row) { row={ tenant_id:'tenant',allocation_id:args.p_allocation_id,refund_key:args.p_refund_key,cumulative_minor:0 }; tables.voucher_allocation_refund.push(row); }
      assert.ok(args.p_cumulative_minor>=row.cumulative_minor);
      row.cumulative_minor=args.p_cumulative_minor;
      return { data:{ allocationId:row.allocation_id,cumulativeMinor:row.cumulative_minor } };
    }
    if (name === 'membership_voucher_pin_accounting') {
      if (settlement.accounting_binding && JSON.stringify(settlement.accounting_binding) !== JSON.stringify(args.p_binding)) {
        return { error: { message: 'Accounting connection/company changed' } };
      }
      settlement.accounting_binding = args.p_binding;
      return { data: structuredClone(settlement) };
    }
    assert.equal(name, 'membership_voucher_claim_collection');
    const rows = tables.membership_voucher_collection;
    let row = rows.find(r => r.external_reference === args.p_reference && r.provider === args.p_provider);
    if (!row) {
      assert.ok(rows.length < 4);
      row = { id: `receipt-${rows.length + 1}`, tenant_id: 'tenant', settlement_id: 'settlement',
        ordinal: rows.length + 1, external_reference: args.p_reference, provider: args.p_provider,
        cash_minor: args.p_cash_minor, collection_date: args.p_collection_date || new Date().toISOString().slice(0,10),
        accounting_status: args.p_collection_date > new Date().toISOString().slice(0,10) ? 'scheduled' : 'pending' };
      rows.push(row);
    }
    return { data: structuredClone(row) };
  }, from(table) {
    let filters = [], change = null, one = false;
    const q = {
      select() { return q; }, eq(k,v) { filters.push(r => r[k] === v); return q; },
      is(k,v) { filters.push(r => (r[k] ?? null) === v); return q; },
      in(k,v) { filters.push(r => v.includes(r[k])); return q; }, lte(k,v) { filters.push(r => r[k] <= v); return q; },
      gt(k,v) { filters.push(r=>r[k]>v);return q; },
      like(k,v) { filters.push(r=>String(r[k]).startsWith(v.replace(/%$/,'')));return q; },
      update(v) { change = v; return q; }, single() { one = true; return q; }, maybeSingle() { one = true; return q; },
      order() { return q; }, limit() { return q; }, then(resolve) {
        const rows = (tables[table] || []).filter(r => filters.every(f => f(r)));
        if (change) rows.forEach(r => Object.assign(r, change));
        return Promise.resolve({ data: structuredClone(one ? rows[0] || null : rows) }).then(resolve);
      },
    };
    return q;
  } };
  const invoices = [], payments = [], keys = new Set();
  const provider = {
    name: accounting,
    async createMembershipInvoice(input) {
      if (input.deferStripeSettlement && (!input.stripePaymentIntentId || !input.idempotencyKey)) {
        throw new Error('deferStripeSettlement requires stripePaymentIntentId and idempotencyKey');
      }
      const invoice = { ...input, invoiceId: `invoice-${invoices.length + 1}`, invoiceNumber: `INV-${invoices.length + 1}`, provider: accounting };
      invoices.push(invoice);
      return invoice;
    },
    async fetchInvoiceStatus(id) { return { totalAmt: invoices.find(r => r.invoiceId === id).finalCost, voided: false }; },
    async applyStripePaymentToInvoice(input) {
      if (!keys.has(input.idempotencyKey)) { keys.add(input.idempotencyKey); payments.push(input); }
      return { payment_recorded: true };
    },
  };
  const facade = { getAccountingProvider: async () => provider, getAccountingProviderByName: () => provider,
    extractInvoiceFields: r => ({ accounting_provider: accounting, accounting_invoice_id: r.invoiceId, accounting_invoice_number: r.invoiceNumber }) };
  const agreement = { id: 'agreement', tenant_id: 'tenant', member_id: 'member',
    metadata: { [rail === 'stripe' ? 'card' : 'dd']: fundedMonthlySnapshot(snapshot, sourceFunding, settlement.id) } };
  return { db, tables, invoices, payments, facade, agreement, settlement, token: tables.membership_fee_token[0] };
}

for (const accounting of ['xero','quickbooks']) for (const cashMinor of [0,250]) {
  test(`${accounting}: variable actual gross and source credit, including internal-only months, retry once`, async () => {
    const f=fixture({accounting,mode:'per_instalment',rail:'gocardless'});
    const grossMinor=cashMinor ? 1250 : 800;
    const creditMinor=grossMinor-cashMinor;
    const fund={variableCredit:true,payableMinor:null,remainingMinor:null,voucherMinor:4000,currency:'GBP',
      creditSchedule:[1,2,3,4].map(ordinal=>({ordinal,allocatedCreditMinor:1000})),allocations:funding.allocations};
    const snap={...base,plan_total:null,invoicing_mode:'per_instalment',payment_mode:'direct_debit',
      collection_policy:{version:1,pricing_policy:'dynamic'},commitment:{term_key:'term'}};
    Object.assign(f.settlement,{funding:fund,monthly_snapshot:snap});
    f.agreement.metadata.dd=fundedMonthlySnapshot(snap,fund,f.settlement.id);
    f.tables.gocardless_collection_reservations=[{id:'r',tenant_id:'tenant',billing_agreement_id:'agreement',
      amount_minor:cashMinor,currency:'GBP',term_key:'term',gocardless_payment_id:cashMinor?'PMvariable':null,
      price_snapshot:{monthly_amount_minor:grossMinor,invoice_net_minor:grossMinor,vat_rate:null,nominal_code:'300',tier_label:'Current'}}];
    const actual=[{...funding.allocations[0],amountMinor:creditMinor}];
    f.tables.membership_variable_voucher_slice=[{tenant_id:'tenant',reservation_id:'r',state:'settled',ordinal:1,
      gross_minor:grossMinor,credit_minor:creditMinor,cash_minor:cashMinor,allocations:actual}];
    const receipt={id:'receipt-variable',tenant_id:'tenant',settlement_id:'settlement',ordinal:1,
      accounting_status:'pending',collection_date:'2020-01-01'};
    f.tables.membership_voucher_collection.push(receipt);
    const rpc=f.db.rpc.bind(f.db);
    f.db.rpc=async(name,args)=>name==='membership_variable_voucher_settle_collection'
      ? {data:structuredClone(receipt)}:rpc(name,args);
    const input={db:f.db,agreement:f.agreement,provider:cashMinor?'gocardless':'voucher',
      externalReference:cashMinor?'PMvariable:unit:1':'variable-voucher:r',cashMinor,currency:'GBP'};
    const deps={facade:f.facade,activateMembership:async()=>({updated:false})};
    await postMembershipVoucherMonthlyPayment(input,deps);
    await postMembershipVoucherMonthlyPayment(input,deps);
    assert.equal(f.invoices.length,1);
    assert.equal(f.invoices[0].finalCost,grossMinor/100);
    assert.equal(f.invoices[0].nominalCode,'300');
    assert.equal(f.invoices[0].authorizeWithoutPayment,true);
    assert.equal(f.invoices[0].deferStripeSettlement,undefined);
    assert.equal(f.payments.reduce((sum,p)=>sum+p.amount,0),grossMinor/100);
    assert.equal(f.payments.filter(p=>p.bankAccountSettingKey.includes('voucher_clearing')).reduce((sum,p)=>sum+p.amount,0),creditMinor/100);
    assert.equal(f.payments.filter(p=>p.bankAccountSettingKey.includes('gocardless_bank')).length,cashMinor?1:0);
  });
}

for (const accounting of ['xero','quickbooks']) for (const mode of ['annual','per_instalment']) for (const rail of ['stripe','gocardless']) {
  test(`${accounting} ${rail} ${mode}: gross liability, exact voucher funding, real net cash and duplicate retries`, async () => {
    const f = fixture({ accounting, mode, rail });
    for (let n = 1; n <= 4; n++) {
      const input = { db: f.db, agreement: f.agreement, provider: rail,
        externalReference: `${rail === 'stripe' ? 'in_' : 'PM'}${n}`, cashMinor: 1500,
        currency: 'GBP', stripePaymentIntentId: rail === 'stripe' ? `pi_cash${n}` : null };
      await postMembershipVoucherMonthlyCashBatch(input, { facade: f.facade });
      await postMembershipVoucherMonthlyCashBatch(input, { facade: f.facade });
    }
    assert.equal(f.invoices.length, mode === 'annual' ? 1 : 4);
    assert.equal(f.invoices.reduce((sum,r) => sum + r.finalCost, 0), 100);
    const credit = f.payments.filter(p => p.bankAccountSettingKey?.includes('voucher_clearing'));
    const cash = f.payments.filter(p => !p.bankAccountSettingKey?.includes('voucher_clearing'));
    assert.equal(credit.reduce((sum,p) => sum + p.amount, 0), 40);
    assert.equal(cash.reduce((sum,p) => sum + p.amount, 0), 60);
    assert.ok(credit.every(p => p.strictBankAccount && !p.stripePaymentIntentId));
    assert.ok(cash.every(p => rail === 'stripe' ? p.stripePaymentIntentId?.startsWith('pi_') : !p.stripePaymentIntentId && p.strictBankAccount));
    assert.equal(f.tables.membership_voucher_collection.length, 4);
  });
}
test('catch-up aggregate uses canonical cash units without duplicate funding on individual callback replay', async () => {
  const f = fixture({ mode: 'per_instalment' });
  const input = { db: f.db, agreement: f.agreement, provider: 'stripe', externalReference: 'in_catchup',
    cashMinor: 3000, currency: 'GBP', stripePaymentIntentId: 'pi_catchup' };
  await postMembershipVoucherMonthlyCashBatch(input, { facade: f.facade });
  await postMembershipVoucherMonthlyCashBatch(input, { facade: f.facade });
  assert.equal(f.invoices.length, 2);
  assert.equal(f.payments.filter(p => p.stripePaymentIntentId).reduce((s,p) => s + p.amount,0), 30);
});
test('fully funded per-instalment purchase schedules all periods and invoices only due periods without provider cash', async () => {
  const f = fixture({ full: true, mode: 'per_instalment' });
  await accountFullyFundedMonthlyMembership(f.db, f.token, f.settlement, { facade: f.facade });
  assert.equal(f.tables.membership_voucher_collection.length, 4);
  assert.equal(f.tables.membership_voucher_collection.filter(r => r.accounting_status === 'scheduled').length, 3);
  assert.equal(f.invoices.length, 1);
  assert.ok(f.payments.every(p => p.bankAccountSettingKey === 'xero_voucher_clearing_account_code' && !p.stripePaymentIntentId));
});
test('uncertain monthly provider setup cannot release reserved vouchers', async () => {
  const f = fixture();
  await assert.rejects(releaseMembershipVoucherMonthly(f.db, f.token, {
    ...f.settlement, state: 'provider_pending', provider_attempted_at: new Date().toISOString(),
  }), /uncertain/);
});
test('a same-provider company switch cannot redirect a pending membership accounting operation', async () => {
  const f = fixture({ mode: 'per_instalment' });
  const input = { db: f.db, agreement: f.agreement, provider: 'stripe', externalReference: 'in_first',
    cashMinor: 1500, currency: 'GBP', stripePaymentIntentId: 'pi_first' };
  await postMembershipVoucherMonthlyCashBatch(input, { facade: f.facade });
  f.tables.xero_token[0].tenant_id = 'another-company';
  await assert.rejects(postMembershipVoucherMonthlyCashBatch({ ...input, externalReference: 'in_second',
    stripePaymentIntentId: 'pi_second' }, { facade: f.facade }), /company changed/);
  assert.equal(f.invoices.length, 1);
  assert.ok(f.payments.every(p => p.expectedProviderContext.xero_tenant_id === 'company'));
});
test('confirmed DD refund without API status uses signed mirror and restores exact original mixed-owner funding once',async()=>{
  const f=fixture({mode:'per_instalment',rail:'gocardless'});
  await postMembershipVoucherMonthlyCashBatch({db:f.db,agreement:f.agreement,provider:'gocardless',
    externalReference:'PMrefund',cashMinor:4500,currency:'GBP'},{facade:f.facade});
  const payment={tenant_id:'tenant',gocardless_payment_id:'PMrefund',amount_minor:4500};
  const refunds=[{id:'RFconfirmed',amount:2250,links:{payment:'PMrefund'}}];
  f.tables.gocardless_refunds.push({tenant_id:'tenant',gocardless_payment_id:'PMrefund',
    gocardless_refund_id:'RFconfirmed',amount_minor:2250,status:'created'});
  assert.equal((await reconcileMembershipVoucherCashRefund(f.db,payment,refunds)).pending,true);
  assert.equal(f.tables.voucher_allocation_refund.length,0);
  f.tables.gocardless_refunds[0].status='paid';
  await reconcileMembershipVoucherCashRefund(f.db,payment,refunds);
  await reconcileMembershipVoucherCashRefund(f.db,payment,refunds);
  assert.deepEqual(f.tables.voucher_allocation_refund.map(r=>[r.allocation_id,r.cumulative_minor]),[['a',1300],['b',200]]);
  f.tables.gocardless_refunds[0].status='failed';
  await assert.rejects(reconcileMembershipVoucherCashRefund(f.db,payment,refunds),/financial reconciliation/);
});

test('expired backed membership credit keeps its original expiry while ordinary credit requires approval',async()=>{
  const f=fixture({mode:'per_instalment',rail:'gocardless'});
  await postMembershipVoucherMonthlyCashBatch({db:f.db,agreement:f.agreement,provider:'gocardless',
    externalReference:'PMexpiry',cashMinor:4500,currency:'GBP'},{facade:f.facade});
  const payment={tenant_id:'tenant',gocardless_payment_id:'PMexpiry',amount_minor:4500};
  f.tables.voucher[0].expires_at='2000-01-01';
  await assert.rejects(membershipVoucherRefundContext(f.db,payment),/Approve a future replacement/);
  f.tables.voucher[0].funding_source='membership_change';
  const context=await membershipVoucherRefundContext(f.db,payment);
  assert.deepEqual(context.reversalOptions.voucherReplacements,[]);
  f.tables.membership_voucher_collection[0].accounting_status='failed';
  await assert.rejects(membershipVoucherRefundContext(f.db,payment),/affected membership instalment accounting/);
});

for(const mode of ['annual','per_instalment']){
 test(`${mode} backed funding recovers a lost receipt without repeating its accounting payment`,async()=>{
  const f=fixture({mode});
  const provider=await f.facade.getAccountingProvider();
  provider.getRawAccessToken=async()=>({accessToken:'isolated-test-only',tenantId:'company'});
  const proof={allocationId:'a',binding:{providerTenantId:'company',accountId:'liability'}};
  const baseRpc=f.db.rpc.bind(f.db),claims=new Map(),events=[];
  let loseReceipt=true,posted=null,posts=0;
  f.db.rpc=async(name,args)=>{
   if(name==='claim_member_credit_funding'){
    events.push('claim');
    const existing=claims.has(args.p_context.reference);
    claims.set(args.p_context.reference,args.p_context);
    return {data:{existing,context:args.p_context}};
   }
   if(name==='record_member_credit_redemption'){
    events.push('receipt');
    if(loseReceipt){loseReceipt=false;return {error:{message:'Isolated lost receipt response'}};}
    return {data:args.p_evidence};
   }
   return baseRpc(name,args);
  };
  const originalApply=provider.applyStripePaymentToInvoice.bind(provider);
  provider.applyStripePaymentToInvoice=async input=>{
   const result=await originalApply(input);
   if(/ a(?::\d+)?$/.test(input.paymentReference||'')){
    posts++;events.push('post');
    posted={PaymentID:'isolated-liability-payment',Status:'AUTHORISED',
     Invoice:{InvoiceID:input.invoiceId},Account:{AccountID:'liability'},
     Reference:input.paymentReference,Amount:input.amount};
    return {...result,payment_id:posted.PaymentID};
   }
   return result;
  };
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
   assert.equal(new URL(url).hostname,'api.xero.com');
   assert.equal(options.method,'GET');
   events.push('read');
   return {ok:true,json:async()=>({Payments:posted?[posted]:[]})};
  };
  try{
   const input={db:f.db,agreement:f.agreement,provider:'stripe',
    externalReference:'in_backed',cashMinor:1500,currency:'GBP',stripePaymentIntentId:'pi_backed'};
   const deps={facade:f.facade,verifyMemberCreditRedemption:async()=>[proof]};
   await assert.rejects(postMembershipVoucherMonthlyCashBatch(input,deps),/evidence needs recovery/);
   assert.deepEqual(events.slice(0,4),['claim','post','read','receipt']);
   await postMembershipVoucherMonthlyCashBatch(input,deps);
   assert.equal(posts,1);
   assert.equal(f.invoices.length,1);
   assert.equal(events.filter(x=>x==='receipt').length,2);
  }finally{globalThis.fetch=previousFetch;}
 });
}
test('authenticated annual checkout preserves provider identity and rejects cross-entrypoint races before cash', async () => {
  const f = fixture();
  let intent = null, creations = 0, basis = null, conflict = false;
  const claim = { tenant_id: 'tenant', source_key: 'portal:member:member:2026', provider_payment_id: null };
  f.tables.membership_payment_term_claim.push(claim);
  f.db.rpc = async (name, args) => {
    if (conflict) return { error: { message: 'Another membership checkout owns this term' } };
    if (name === 'membership_payment_term_guard') return { data: {} };
    if (basis && JSON.stringify(basis) !== JSON.stringify(args.p_basis)) return { error: { message: 'Price changed' } };
    basis = args.p_basis;
    return { data: { ...claim } };
  };
  const stripe = { paymentIntents: { retrieve: async () => intent, create: async payload => {
    creations++; intent = { ...payload, id: 'pi_portal', status: 'requires_payment_method' }; return intent;
  } } };
  const owner = { tenantId: 'tenant', memberId: 'member', membershipYear: '2026' };
  const payload = { amount: 10000, currency: 'gbp', metadata: { member_id: 'member' } };
  await createGuardedPortalMembershipIntent(f.db, stripe, owner, payload);
  await createGuardedPortalMembershipIntent(f.db, stripe, owner, payload);
  assert.equal(creations, 1);
  await assert.rejects(createGuardedPortalMembershipIntent(f.db, stripe, owner, { ...payload, amount: 9000 }), /Price changed/);
  conflict = true;
  await assert.rejects(createGuardedPortalMembershipIntent(f.db, stripe, owner, payload), /Another/);
  assert.equal(creations, 1);
});
