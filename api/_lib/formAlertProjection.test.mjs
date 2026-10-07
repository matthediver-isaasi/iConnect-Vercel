import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFormAlertAnswers } from './formAlertProjection.js';
import { createFormAlertToken, hashFormAlertToken } from './formAlertCapabilities.js';
import { formAlertDeliveryOutcome } from './formAlertDelivery.js';

test('capabilities have 256 random bits and only a hash is used for persistence',()=>{
  const a=createFormAlertToken(),b=createFormAlertToken();
  assert.equal(Buffer.from(a.token,'base64url').length,32);
  assert.equal(a.hash.length,64); assert.equal(hashFormAlertToken(a.token),a.hash);
  assert.notEqual(a.token,b.token); assert.notEqual(a.hash,a.token);
  for(const token of ['',null,123,'../other','a'.repeat(44)]) assert.equal(hashFormAlertToken(token),null);
});
test('anonymous projection redacts nested identity and unknown metadata without changing answers',()=>{
  const fields=[
    {id:'email',type:'text',label:'Your email'},
    {id:'safe',type:'text',label:'Feedback'},
    {id:'mapped',type:'text',label:'Code',prefill_field:'member:first_name'},
    {id:'file',type:'file'},
    {id:'group',type:'grouped_question',sub_questions:[{id:'a',type:'text',label:'Thoughts'},{id:'contact',type:'contact'}]},
    {id:'rows',type:'repeatable_rows',children:[{id:'phone',type:'tel'},{id:'rating',type:'number'}]},
  ];
  const answers={email:'identity',safe:'I can self-identify in free text',mapped:'identity',file:'private-url',
    group:{a:'Hello',contact:{email:'identity'},ip:'identity'},rows:[{phone:'identity',rating:4,linkage:'identity'}],
    network:'identity'};
  const original=structuredClone(answers);
  const result=projectFormAlertAnswers(fields,answers,{anonymous:true});
  assert.ok(!JSON.stringify(result).includes('identity'));
  assert.ok(JSON.stringify(result).includes('self-identify'));
  assert.deepEqual(result.map(x=>x.label),['Feedback','group','rows']);
  assert.deepEqual(answers,original);
});
test('unknown answer objects and stored attachment URLs are never serialized',()=>{
  const result=projectFormAlertAnswers([
    {id:'a',type:'file'}, {id:'b',type:'text'}, {id:'c',type:'text'},
  ],{a:'https://private.invalid/file',b:{token:'secret',html:'<script>'},c:'<script>alert(1)</script>'});
  assert.equal(result[0].value,'Attachment unavailable in this view');
  assert.equal(result[1].value,'');
  assert.equal(result[2].value,'<script>alert(1)</script>','frontend must render this using textContent');
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('safe rejection retries are bounded; unknown and ambiguous sends never auto-retry',()=>{
  assert.equal(formAlertDeliveryOutcome({success:true,id:'provider'},1).status,'sent');
  assert.equal(formAlertDeliveryOutcome({success:false,status:429},1).status,'retry');
  assert.equal(formAlertDeliveryOutcome({success:false,status:429},5).status,'attention');
  assert.equal(formAlertDeliveryOutcome({notSubmitted:true},1).status,'retry');
  assert.equal(formAlertDeliveryOutcome({status:429,ambiguousEffect:true},1).status,'attention');
  assert.equal(formAlertDeliveryOutcome({status:500},1).status,'attention');
  assert.equal(formAlertDeliveryOutcome(undefined,1).status,'attention');
});
