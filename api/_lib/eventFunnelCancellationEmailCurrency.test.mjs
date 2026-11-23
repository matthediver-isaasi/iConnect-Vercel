import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFinancialSummaryLines,buildCancellationEmail,CANCELLATION_FLOW_REQUEST_APPROVED} from './cancellationEmail.js';
const input={flow:CANCELLATION_FLOW_REQUEST_APPROVED,isGroup:false,
  reversalResults:{stripeRefund:{success:true,amount:12.34},trainingFund:{success:true,amount:2},
    vouchers:[{reinstated:true,code:'TEST',amount:3}],xeroCreditNote:{success:true,creditNoteNumber:'CN',amount:12.34}}};
test('every financial line uses the original checkout currency',()=>{
  for(const currency of ['USD','EUR']){
    const lines=buildFinancialSummaryLines({...input,currency});
    assert.equal(lines.length,4);
    assert.ok(lines.every(line=>line.includes(`${currency} `)&&!line.includes('£')));
    const rendered=buildCancellationEmail({...input,currency,eventName:'Fixture event',recipientName:'Fixture'});
    assert.match(rendered.html,new RegExp(`${currency} 12\\.34`));
    assert.doesNotMatch(rendered.html,/£12\.34/);
  }
});
test('legacy GBP output is retained and unknown currency input is rejected',()=>{
  assert.deepEqual(buildFinancialSummaryLines(input),buildFinancialSummaryLines({...input,currency:'GBP'}));
  assert.match(buildFinancialSummaryLines(input).join('\n'),/£12\.34/);
  assert.throws(()=>buildFinancialSummaryLines({...input,currency:null}),/currency/);
});
