import test from 'node:test';
import assert from 'node:assert/strict';
import {newCredential,credentialHash} from './credentials.js';
import {sealInvitation} from './deliveryCredentials.js';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME='1';
const {__setRoleAccessOverlayForTests}=await import('../roleVisibility.js');__setRoleAccessOverlayForTests([]);
const {deliverAwardsInvitations}=await import('./invitationDelivery.js');
const secret='isolated-awards-encryption-secret';
async function fixture({state='invited',provider={success:true,messageId:'fixture-message'},throwProvider=false,notStarted=false,configuration=null,template=null}={}){
  const token=newCredential(),calls=[],messages=[];
  const rows={
    awards_message_configuration:configuration,email_template:template,
    assessment_appointment:{id:'appointment',round_id:'round',state,credential_generation:2,external_email:'judge@example.invalid'},
    assessment_round:{id:'round',award_id:'award',name:'First round',state:'judging'},
    awards_competition:{id:'award',name:'Research & Evidence',state:'closed'},
    tenant:{id:'tenant',slug:'fixture-tenant',domain:null},
    assessment_invitation:{id:'invite',expires_at:'2099-01-01T00:00:00Z',token_hash:credentialHash(token)},
  };
  const db={async rpc(name,args){
    calls.push({name,args});
    if(name==='awards_claim_deliveries')return{data:[{id:'delivery',tenant_id:'tenant',award_id:'award',claim_token:'claim',
      recipient_context:{appointment_id:'appointment',generation:2,envelope:sealInvitation(token,'tenant:appointment',secret)}}]};
    return{data:!(notStarted&&args.p_action==='starting')};
  },from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:rows[table]})};return q;}};
  const outcomes=await deliverAwardsInvitations(db,{secret,send:async message=>{messages.push(message);
    if(throwProvider)throw new Error('Fixture transport timeout');return provider;}});
  return{outcomes,calls,messages,token};
}
test('invitation sender resolves authority and disables bearer-link tracking',async()=>{
  const result=await fixture();
  assert.equal(result.outcomes[0].state,'delivered');
  assert.equal(result.messages.length,1);
  assert.equal(result.messages[0].disableTracking,true);
  assert.equal(result.messages[0].confidentialDiagnostics,true);
  assert.ok(result.messages[0].text.includes(`#token=${result.token}`));
  assert.equal(result.calls.at(-1).args.p_provider_id,'fixture-message');
});
test('revocation before lookup or send marker prevents provider calls',async()=>{
  for(const config of [{state:'revoked'},{notStarted:true}]){
    const result=await fixture(config);assert.equal(result.messages.length,0);assert.equal(result.outcomes[0].state,'cancelled');
  }
});
test('only definite non-submission retries; uncertain provider outcomes need attention',async()=>{
  const retry=await fixture({provider:{success:false,notSubmitted:true}});
  assert.equal(retry.outcomes[0].state,'retry');
  const uncertain=await fixture({throwProvider:true});
  assert.equal(uncertain.outcomes[0].state,'attention');assert.equal(uncertain.messages.length,1);
});
test('configured invitation template retains the protected link and tracking policy',async()=>{
  const result=await fixture({configuration:{enabled:true,email_template_id:'template'},
    template:{subject:'Panel: {{round.name}}',body:'<a href="{{link}}">Accept {{award.name}}</a>'}});
  assert.equal(result.outcomes[0].state,'delivered');
  assert.equal(result.messages[0].subject,'Panel: First round');
  assert.ok(result.messages[0].html.includes(`#token=${result.token}`));
  assert.ok(result.messages[0].html.includes('Research &amp; Evidence'));
  assert.equal(result.messages[0].disableTracking,true);
});
test('disabled and unusable invitation templates never reach the provider',async()=>{
  const disabled=await fixture({configuration:{enabled:false}});
  assert.equal(disabled.outcomes[0].state,'cancelled');assert.equal(disabled.messages.length,0);
  for(const template of [null,{subject:'Invite',body:'No secure link'}]){
    const result=await fixture({configuration:{enabled:true,email_template_id:'template'},template});
    assert.equal(result.outcomes[0].state,'attention');assert.equal(result.messages.length,0);
  }
});
