import test from 'node:test';
import assert from 'node:assert/strict';
import {compatibilityForm, submitThroughRealProcessor,TENANT_ID} from './formSubmissionCompatibility.helpers.mjs';

const form={...compatibilityForm(),form_type:'standard',require_authentication:true,
  fields:[{id:'payment',type:'membership_payment'},{id:'answer',type:'text'}],
  organization_entity_action:'none',entity_pipelines:{members:[],organisations:[]}};
const member={id:'member',tenant_id:TENANT_ID};
const rows=()=>{
  const scope={tenant_id:TENANT_ID,member_id:member.id};
  return {
    membership_fee_token:{...scope,id:'fee',token:'fixture-only',organization_id:null,
      history_record_id:'history',membership_year:'saved-term',
      cost_breakdown:{formVoucher:{formId:form.id,paymentFieldId:'payment',electionId:'e',paymentMode:'stripe_upfront'}}},
    form_membership_voucher_checkout:{...scope,fee_token_id:'fee',election_id:'e',released_at:null},
    membership_successor_election:{...scope,id:'e',status:'reserved',origin:'form',payment_method:'upfront',
      quote:{payerMemberId:member.id,simulation:{membershipYear:{label:'saved-term'}}}},
    member_membership_history:{...scope,id:'history',membership_successor_election_id:'e',status:'active',payment_status:'paid'},
    membership_voucher_settlement:null,
  };
};
test('paid voucher submission is authenticated, preserves answers and replays once',async()=>{
  const result=await submitThroughRealProcessor({form,sessionMember:member,receiptRows:rows(),
    idempotencyKey:'voucher-submission-replay',attempts:2,
    submissionData:{answer:'Retained answer',payment:{voucherCheckoutId:'fee',status:'forged-browser-status'}}});
  assert.ok([200,201].includes(result.response.statusCode),JSON.stringify(result.response.body));
  assert.equal(result.insertedSubmissions.length,1);
  assert.equal(result.insertedSubmissions[0].submission_data.answer,'Retained answer');
  assert.deepEqual(result.insertedSubmissions[0].submission_data.payment,{
    status:'already_paid',voucherCheckoutId:'fee',existingRecordId:'history',membershipYear:'saved-term',
  });
});
test('outage, unpaid, and foreign-scope receipts cannot cause submission effects',async()=>{
  for(const scenario of ['outage','unpaid','foreign','guest']){
    const receiptRows=rows();
    if(scenario==='outage')receiptRows.membership_fee_token={error:{code:'08006'}};
    if(scenario==='unpaid')receiptRows.member_membership_history.payment_status='pending';
    if(scenario==='foreign')receiptRows.membership_fee_token.cost_breakdown.formVoucher.formId='other';
    const result=await submitThroughRealProcessor({form,sessionMember:scenario==='guest'?null:member,receiptRows,
      submissionData:{answer:'Retained answer',payment:{voucherCheckoutId:'fee',status:'already_paid'}}});
    assert.equal(result.response.statusCode,scenario==='outage'?503:scenario==='guest'?403:409,JSON.stringify(result.response.body));
    assert.equal(result.insertedSubmissions.length,0);
    assert.equal(result.handoffs.length,0);
    if(scenario==='outage')assert.equal(result.response.body.retryable,true);
  }
});
