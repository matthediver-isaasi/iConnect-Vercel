import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertEventCodeOfConduct} from './eventCodeOfConduct.js';
const content='<h2>Code of Conduct</h2><p>Treat everyone respectfully.</p>';
const policy={content,required:true};
function db(rows=[],error=null) {
  return {from(table){assert.equal(table,'system_settings');return {
    select(fields){assert.equal(fields,'setting_value');return this;},
    eq(key,value){assert.equal(value,key==='tenant_id'?'tenant':'event_code_of_conduct');return this;},
    async limit(n){assert.equal(n,2);return {data:rows,error};},
  };}};
}
const stored=p=>db([{setting_value:JSON.stringify(p)}]);
test('unconfigured and disabled policy preserves existing bookings',async()=>{
  await assertEventCodeOfConduct(db(),'tenant',{});
  await assertEventCodeOfConduct(stored({content:'',required:false}),'tenant',{});
});
test('required policy needs explicit true and current exact content',async()=>{
  for(const value of [undefined,false,'true',1,null]){
    await assert.rejects(assertEventCodeOfConduct(stored(policy),'tenant',{code_of_conduct_accepted:value,code_of_conduct_content:content}),
      {statusCode:400,code:'CODE_OF_CONDUCT_REQUIRED'});
  }
  await assertEventCodeOfConduct(stored(policy),'tenant',{code_of_conduct_accepted:true,code_of_conduct_content:content});
  for(const text of [undefined,'',content+' ']){
    await assert.rejects(assertEventCodeOfConduct(stored(policy),'tenant',{code_of_conduct_accepted:true,code_of_conduct_content:text}),
      {statusCode:409,code:'CODE_OF_CONDUCT_CHANGED'});
  }
});
test('configuration failures never silently disable required acceptance',async()=>{
  for(const fixture of [db([],new Error('offline')),db(null),db([{setting_value:'bad'}]),
    db([{setting_value:JSON.stringify(policy)},{setting_value:JSON.stringify(policy)}]),
    stored({required:'true',content}),stored({required:true,content:'<p><br></p>'}),
    stored({required:true,content:'<p>&nbsp;</p><script>not visible</script>'})]){
    await assert.rejects(assertEventCodeOfConduct(fixture,'tenant',{}),{statusCode:503});
  }
  await assert.rejects(assertEventCodeOfConduct(db(),null,{}),{statusCode:404});
});
test('guards precede checkout side effects and keep policy publicly readable',()=>{
  const load=p=>readFileSync(new URL(p,import.meta.url),'utf8');
  const functions=load('../functions/[functionName].js');
  assert.match(functions,/\['createBooking', 'createOneOffEventBooking'\]\.includes\(functionName\)[\s\S]*?functionName === 'createStripePaymentIntent' && req\.body\?\.metadata\?\.event_id/);
  assert.match(functions,/req\.body\?\.metadata\?\.payment_type !== 'donation'/);
  const fnGuard=functions.lastIndexOf('await assertEventCodeOfConduct');
  assert(fnGuard<functions.lastIndexOf('await runBookingCreditAttempt'));
  const complex=load('../public/complex-event-booking.js');
  assert(complex.indexOf('await assertEventCodeOfConduct')<complex.indexOf('await handleBookingWithCredits(req, capture)'));
  const payment=load('../public/complex-event-payment-intent.js');
  assert(payment.indexOf('await assertEventCodeOfConduct')<payment.indexOf('stripe.paymentIntents.create'));
  const wait=load('../member/event-waiting-list.js');
  assert(wait.indexOf('await assertEventCodeOfConduct')<wait.indexOf('const request = normalizeWaitingRequest'));
  assert.match(load('../public/system-settings.js'),/'event_code_of_conduct'/);
});
