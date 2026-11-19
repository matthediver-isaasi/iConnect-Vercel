import test from 'node:test';
import assert from 'node:assert/strict';
import { assertUnifiedBookingPaymentAuthority, compensateRejectedEventCreditPayment } from './eventPaymentPolicyCompensation.js';

function authority(source='booking',memberId='original-member'){
  return {tenantId:'tenant',eventId:'event',source,memberId,requestedVersion:2,
    paymentIntent:{id:'pi_original',status:'succeeded',metadata:{tenant_id:'tenant',event_id:'event',
      unified_booking_contract_id:'contract',unified_booking_version:'2',member_email:'booker@example.invalid'}},
    attempt:{key:'original-attempt',p_tenant_id:'tenant',source,contract:{id:'contract',tenant_id:'tenant',
      event_id:'event',source,member_id:memberId,payment_intent_id:'pi_original',snapshot:{version:2,
        contact:{email:'different-finance-contact@example.invalid'}}}}};
}
for(const source of ['booking','complex_event_booking'])for(const memberId of ['original-member',null]){
  test(`${source}/${memberId?'member':'guest'} payment requires original scoped authority independently of customer email`,()=>{
    assert.doesNotThrow(()=>assertUnifiedBookingPaymentAuthority(authority(source,memberId)));
    const mutations=[
      value=>delete value.requestedVersion,
      value=>{value.requestedVersion=1;},
      value=>delete value.attempt,
      value=>{value.memberId=memberId?'different-member':'signed-in-member';},
      value=>{value.tenantId='other-tenant';},
      value=>{value.eventId='other-event';},
      value=>{value.source=source==='booking'?'complex_event_booking':'booking';},
      value=>{value.attempt.contract.id='other-contract';},
      value=>{value.attempt.contract.payment_intent_id='pi_other';},
      value=>{value.attempt.contract.snapshot.version=1;},
      value=>{value.paymentIntent.metadata.unified_booking_version='3';},
      value=>{delete value.paymentIntent.metadata.unified_booking_contract_id;},
      value=>{value.attempt.p_tenant_id='other-tenant';},
    ];
    for(const mutate of mutations){
      const value=authority(source,memberId);mutate(value);
      assert.throws(()=>assertUnifiedBookingPaymentAuthority(value),
        error=>error.statusCode===403&&error.code==='UNIFIED_PAYMENT_AUTHORITY_MISMATCH');
    }
    const legacy=authority(source,memberId);
    delete legacy.paymentIntent.metadata.unified_booking_contract_id;
    delete legacy.paymentIntent.metadata.unified_booking_version;
    assert.throws(()=>assertUnifiedBookingPaymentAuthority(legacy),/original authorised booking contract/);
    delete legacy.attempt;
    assert.doesNotThrow(()=>assertUnifiedBookingPaymentAuthority(legacy),'genuine legacy payments retain their old owner checks');
  });
}
for(const source of ['booking','complex_event_booking'])for(const status of ['succeeded','requires_capture']){
  test(`${source}/${status} downgraded payment cannot be refunded or cancelled by rejection handling`,async()=>{
    let writes=0;
    const value=authority(source);value.paymentIntent.status=status;
    const compensate=unifiedAuthority=>compensateRejectedEventCreditPayment({
      paymentIntent:value.paymentIntent,expectedIntentId:'pi_original',tenantId:'tenant',eventId:'event',
      purchaserEmail:'booker@example.invalid',unifiedAuthority,
      refundSucceeded:async()=>{writes++;},cancelAuthorization:async()=>{writes++;},
    });
    for(const context of [null,{...value,requestedVersion:1},{...value,memberId:'different-member'}]){
      const result=await compensate(context);
      assert.equal(result.compensated,false);assert.equal(result.reason,'unverified_binding');
    }
    assert.equal(writes,0,'even matching legacy email and credit metadata cannot authorise a refund');
    assert.equal((await compensate(value)).compensated,true,'original authorised rejection compensation remains available');
    assert.equal(writes,1);
  });
}
