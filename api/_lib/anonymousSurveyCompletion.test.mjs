import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptAnonymousSurveyCompletion } from './anonymousSurveyCompletion.js';

test('completion helper sends server scope, hashes bearer/retry credentials and returns no response', async () => {
  let call;
  const db={rpc:async(name,args)=>{call={name,args};return {data:{accepted:true,replayed:false}};}};
  const result=await acceptAnonymousSurveyCompletion({
    db,tenantId:'tenant',formId:'form',versionId:'version',memberId:'member',
    invitationToken:'verified-token',idempotencyKey:'retry-key',
    submission:{tenant_id:'forged',submission_data:{score:4}},answers:[],
  });
  assert.deepEqual(result,{accepted:true,replayed:false});
  assert.equal(call.name,'accept_anonymous_survey_completion');
  assert.equal(call.args.p_submission.tenant_id,'tenant');
  assert.equal(call.args.p_member_id,'member');
  assert.match(call.args.p_retry_hash,/^[a-f0-9]{64}$/);
  assert.match(call.args.p_token_hash,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(call).includes('retry-key'),false);
  assert.equal(JSON.stringify(call).includes('verified-token'),false);
});
test('invalid retry key and database errors fail closed',async()=>{
  await assert.rejects(acceptAnonymousSurveyCompletion({idempotencyKey:''}),/retry key/);
  const failure={code:'23505',message:'Survey already completed'};
  await assert.rejects(acceptAnonymousSurveyCompletion({
    db:{rpc:async()=>({error:failure})},idempotencyKey:'retry-key',
  }),error=>error===failure);
});