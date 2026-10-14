import test from 'node:test';
import assert from 'node:assert/strict';
import { handleManualCardApproval } from './manualCardMembershipApproval.js';
const id = '00000000-0000-4000-8000-000000000001';
const request = { body: { action: 'approve_card_membership', memberId: id, historyId: id, tenantId: 'attacker' } };
function response() {
  return { code: 200, status(c) { this.code = c; return this; }, json(body) { this.body = body; return this; } };
}
test('non-admin and invalid input never invoke the database', async () => {
  const db = { rpc() { throw Error('must not run'); } };
  for (const [req, allowed, status] of [[request,false,403],[{body:{}},true,400]]) {
    const res = response();
    await handleManualCardApproval(req,res,{db,context:{tenantId:id},checkAdmin:async()=>allowed});
    assert.equal(res.code,status);
  }
});
test('uses server tenant and actor, exposes conflict, success and safe database errors', async () => {
  for (const [result,status] of [[{data:{ok:true,updated:true}},200],
    [{data:{ok:false,detail:'Not awaiting approval'}},409],[{error:{code:'XX',message:'private'}},500]]) {
    const res=response();
    await handleManualCardApproval(request,res,{context:{tenantId:id,memberId:'actor'},
      checkAdmin:async()=>true,db:{async rpc(name,args){
        assert.equal(name,'approve_manual_card_membership_activation');
        assert.equal(args.p_tenant_id,id);assert.equal(args.p_member_id,id);
        assert.equal(args.p_history_id,id);assert.equal(args.p_actor_email,'member:actor');
        return result;
      }}});
    assert.equal(res.code,status);assert.ok(!JSON.stringify(res.body).includes('private'));
  }
});
