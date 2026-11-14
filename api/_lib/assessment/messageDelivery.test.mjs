import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ROLE_ACCESS_OVERLAY_SKIP_PRIME='1';
const {deliverAwardMessages}=await import('./messageDelivery.js');
const {renderAwardMessage}=await import('./messageTemplates.js');
function fixture({allowed=true}={}){
  const calls=[],tables={
    awards_competition:{id:'award',name:'Award',closes_at:'2027-01-01T12:00:00Z'},
    tenant:{id:'tenant',slug:'fixture',domain:'awards.example.org'},
    awards_application:{id:'application',member_id:'member',submission_id:'submission',reference:'AW-1'},
    member:{email:'member@example.invalid',tenant_id:'tenant'},
    awards_message_configuration:null,
  };
  return{calls,from(table){const q={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:tables[table]??null})};return q;},
    async rpc(name,args){calls.push({name,args});return name==='awards_claim_messages'?{data:[{
      id:'delivery',tenant_id:'tenant',award_id:'award',category:'application_confirmation',claim_token:'claim',recipient_context:{application_id:'application'},
    }]}:{data:args.p_action==='starting'?allowed:true};},
  };
}
test('send-time authority refusal prevents any provider call',async()=>{
  const db=fixture({allowed:false});let sends=0;
  const result=await deliverAwardMessages(db,{send:async()=>{sends++;}});
  assert.equal(sends,0);assert.equal(result[0].state,'cancelled');
});
test('provider acknowledgement, definite non-submission and uncertainty remain distinct',async()=>{
  for(const [provider,state]of [[{success:true,messageId:'provider-id'},'delivered'],[{success:false,notSubmitted:true},'retry'],[{success:true},'attention']]){
    const db=fixture();let envelope;
    const result=await deliverAwardMessages(db,{send:async input=>{envelope=input;return provider;}});
    assert.equal(result[0].state,state);
    assert.equal(envelope.disableTracking,true);assert.equal(envelope.confidentialDiagnostics,true);
    assert.equal(envelope.to,'member@example.invalid');
  }
  const result=await deliverAwardMessages(fixture(),{send:async()=>{throw new Error('Ambiguous provider timeout');}});
  assert.equal(result[0].state,'attention');
});
test('award templates reject unsupported tokens and escape supplied HTML values',()=>{
  assert.throws(()=>renderAwardMessage('winner',{}, {subject:'Result',body:'{{private.judge_notes}}'}),/Unsupported/);
  const rendered=renderAwardMessage('winner',{'award.name':'<script>','outcome.name':'Highly commended',link:'https://example.invalid'},
    {subject:'{{award.name}}',body:'<p>{{award.name}}</p>'});
  assert.equal(rendered.html,'<p>&lt;script&gt;</p>');
});
