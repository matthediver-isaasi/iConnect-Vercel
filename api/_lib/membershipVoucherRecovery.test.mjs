import test from 'node:test';
import assert from 'node:assert/strict';
import { regenerateMembershipVoucherQuote } from './membershipVoucherRequote.js';
import { proportionalVoucherRefund, membershipVoucherCancellationSummary } from './membershipVoucherRefund.js';

function quoteFixture({ organization = false, invoiced = false, gross = 120 } = {}) {
  const token = { id:'original',tenant_id:'tenant',member_id:organization ? null:'member',
    organization_id:organization ? 'org':null,membership_year:'2026',currency:'GBP',
    final_cost:100,cost_breakdown:{ totalWithVat:gross },...(invoiced ? { history_record_id:'history' }: {}) };
  const simulation = { success:true,finalCost:100,totalWithVat:120,vatAmount:20,vatRatePercent:20,
    currency:'GBP',membershipYear:{ label:'2026' },config:{ id:'config' } };
  let captured;
  const db = { rpc:async(name,args) => {
    assert.equal(name,'membership_fee_regenerate_quote'); captured=args;
    return { data:{ token:'replacement' } };
  },from:() => {
    const q={ select(){return q;},eq(){return q;},single:async()=>({ data:{
      id:'history',final_cost:100,total_with_vat:gross,accounting_provider:'xero',accounting_invoice_id:'existing',
    } }) };
    return q;
  }};
  const deps={ simulations:{ simulateMembershipForMember:async()=>simulation,simulateMembershipForOrg:async()=>simulation },
    card:{ resolveCardMonthlyOffer:()=>({}),buildCardAgreementSnapshot:()=>({
      plan_total:144,monthly_amount_minor:1200,monthly_amount:12,instalment_count:12,currency:'GBP',accepted_at:new Date().toISOString(),
    }) }};
  return { token,db,deps,get captured(){return captured;} };
}
test('replacement quote freezes matching monthly gross and preserves predecessor identity without financial calls',async()=>{
  const f=quoteFixture();
  const result=await regenerateMembershipVoucherQuote(f.db,f.token,'stripe_monthly',f.deps);
  assert.equal(result.replacementUrl,'/membership-fees/replacement');
  assert.equal(result.grossMinor,14400);
  assert.equal(f.captured.p_final_cost,120);
  assert.equal(f.captured.p_breakdown.membershipVoucherRequote.predecessorTokenId,'original');
  assert.equal(f.captured.p_breakdown.membershipVoucherRequote.simulation.totalWithVat,144);
  assert.equal(f.token.final_cost,100);
});
test('legacy organisation quote gains immutable server-derived terms',async()=>{
  const f=quoteFixture({organization:true});
  await regenerateMembershipVoucherQuote(f.db,f.token,'stripe_upfront',f.deps);
  assert.equal(f.captured.p_breakdown.membershipVoucherRequote.simulation.config.id,'config');
  assert.equal(f.captured.p_final_cost,100);
});
test('existing gross invoice is financed, never repriced to the new monthly sticker price',async()=>{
  const f=quoteFixture({invoiced:true});
  await regenerateMembershipVoucherQuote(f.db,f.token,'stripe_monthly',f.deps);
  const snapshot=f.captured.p_breakdown.membershipVoucherRequote.monthlySnapshot;
  assert.equal(snapshot.plan_total,120);
  assert.equal(snapshot.monthly_amount_minor,1000);
  assert.equal(snapshot.invoicing_mode,'annual');
  assert.equal(f.captured.p_final_cost,100);
});
test('non-divisible issued liability preserves gross and explicitly requires a rounding credit quote',async()=>{
  const f=quoteFixture({invoiced:true,gross:120.01});
  await regenerateMembershipVoucherQuote(f.db,f.token,'stripe_monthly',f.deps);
  assert.equal(f.captured.p_breakdown.membershipVoucherRequote.creditRequired,true);
  assert.equal(f.captured.p_breakdown.membershipVoucherRequote.monthlySnapshot.plan_total,120.01);
  const result=await regenerateMembershipVoucherQuote(f.db,f.token,'stripe_upfront',f.deps);
  assert.equal(result.grossMinor,12001);
});
test('confirmed refund percentages apportion exact minor units across original personal and organisation owners',()=>{
  const allocations=[{id:'a',ownerType:'member',amountMinor:1001},{id:'b',ownerType:'organization',amountMinor:999}];
  const partial=proportionalVoucherRefund(allocations,3000,1000);
  assert.equal(partial.reduce((sum,a)=>sum+a.cumulativeMinor,0),666);
  assert.equal(partial[0].ownerType,'member');
  assert.equal(partial[1].ownerType,'organization');
  assert.deepEqual(proportionalVoucherRefund(allocations,3000,3000).map(a=>a.cumulativeMinor),[1001,999]);
  assert.throws(()=>proportionalVoucherRefund(allocations,3000,3001));
});
test('collection cancellation retains both funding owners under the existing no-refund cancellation policy',()=>{
  const summary=membershipVoucherCancellationSummary({metadata:{dd:{voucher_funding:{
    settlement_id:'purchase',allocations:[{voucherId:'personal',ownerType:'member',amountMinor:1000},
      {voucherId:'org',ownerType:'organization',amountMinor:2000}],
  }}}});
  assert.equal(summary.voucherFunding.disposition,'retained');
  assert.deepEqual(summary.voucherFunding.allocations.map(a=>a.ownerType),['member','organization']);
});
