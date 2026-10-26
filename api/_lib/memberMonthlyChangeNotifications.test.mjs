import test from 'node:test';
import assert from 'node:assert/strict';
import {runMemberMonthlyChangeNotifications} from './memberMonthlyChangeNotifications.js';
function fixture(){
  const row={tenant_id:'t',operation_id:'op',state:'pending'};
  let writes=0,failFinish=false,missingEmail=false;
  const db={async rpc(name,args){
    if(name==='pending_monthly_change_notifications')return {data:row.state==='pending'?[row]:[]};
    if(name==='claim_monthly_change_notification'){
      if(row.state!=='pending')return {data:null};row.state='claimed';return {data:{...row,claim_token:'claim'}};
    }
    assert.equal(name,'finish_monthly_change_notification');assert.equal(args.p_claim_token,'claim');
    if(failFinish)return {error:{code:'storage_failed'}};
    row.state=args.p_state;return {data:row};
  },from(table){return {select(){return this},eq(){return this},async maybeSingle(){
    return {data:table==='member'?{id:'m',email:missingEmail?null:'member@example.test'}:
      {id:'op',state:'finalized',member_id:'m',evidence:{application:{operationId:'op',effectiveDate:'2026-11-01',expiresOn:'2027-01-01'}}}};
  }}}};
  return {db,row,sendEmail:async args=>{writes++;assert.match(args.text,/not a payment/);return {success:true,messageId:'mail'}},
    writes:()=>writes,failFinish:()=>{failFinish=true},missingEmail:()=>{missingEmail=true}};
}
test('concurrent sweeps send once and completed notifications are not resent',async()=>{
  const f=fixture();await Promise.all([runMemberMonthlyChangeNotifications(f),runMemberMonthlyChangeNotifications(f)]);
  assert.equal(f.writes(),1);assert.equal(f.row.state,'sent');
  await runMemberMonthlyChangeNotifications(f);assert.equal(f.writes(),1);
});
test('a lost delivery acknowledgement keeps the durable claim instead of resending',async()=>{
  const f=fixture();f.failFinish();
  await runMemberMonthlyChangeNotifications(f);await runMemberMonthlyChangeNotifications(f);
  assert.equal(f.writes(),1);assert.equal(f.row.state,'claimed');
});
test('unknown transport results require review, while definitely unsubmitted requests can retry',async()=>{
  let f=fixture();await runMemberMonthlyChangeNotifications({...f,sendEmail:async()=>{throw Error('timeout')}});
  assert.equal(f.row.state,'uncertain');
  f=fixture();await runMemberMonthlyChangeNotifications({...f,sendEmail:async()=>({success:false,notSubmitted:true})});
  assert.equal(f.row.state,'pending');
  await runMemberMonthlyChangeNotifications(f);assert.equal(f.row.state,'sent');
  f=fixture();f.missingEmail();await runMemberMonthlyChangeNotifications(f);
  assert.equal(f.writes(),0);assert.equal(f.row.state,'blocked');
});
