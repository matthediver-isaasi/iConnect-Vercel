import test from 'node:test';
import assert from 'node:assert/strict';
import {projectMonthlyInstalmentSnapshot} from './memberMonthlyInvoiceSnapshot.js';
test('future invoices use the applied tax/nominal snapshot; historical invoices retain their original scope',async()=>{
  const snapshot={currency:'GBP',config_id:'old',commitment:{term_key:'term',membership_renewal_date:'2027-01-01'}};
  const agreement={id:'a',tenant_id:'t',member_id:'m'};
  const op={id:'o',tenant_id:'t',member_id:'m',prepared:{input:{agreement:{id:'a'},authority:{termKey:'term'}}},
    evidence:{application:{operationId:'o',effectiveDate:'2026-07-01',expiresOn:'2027-01-01',
      targetSnapshot:{config:{id:'new',tenant_id:'t',structure_scope_type:'member',flat_vat_rate:'OUTPUT',nominal_code:'4001'},band:null}}}};
  const db={from(){return {select(){return this},eq(){return this},async maybeSingle(){return {data:op}}}}};
  const call=date=>projectMonthlyInstalmentSnapshot({db,agreement,snapshot,getPaymentDate:async()=>date});
  assert.equal(await call('2026-06-30'),snapshot);
  const current=await call('2026-07-01');
  assert.equal(current.config_id,'new');assert.equal(current.collection_price_snapshot.vat_rate,'OUTPUT');
  assert.equal(current.collection_price_snapshot.nominal_code,'4001');
  assert.equal(snapshot.config_id,'old');
  await assert.rejects(call(null),/Original monthly collection date/);
  op.member_id='foreign';await assert.rejects(call('2026-07-01'),/inconsistent/);
});
