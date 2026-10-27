import test from 'node:test';
import assert from 'node:assert/strict';
import {listMemberCreditExpiryReviews,reviewMemberCreditExpiry} from './memberCreditExpiryReview.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
test('expiry review is tenant/member bound and records a note rather than changing a balance',async()=>{
 const calls=[],filters=[];
 const db={from(table){assert.equal(table,'member_membership_credit');return {
  select(){return this},eq(k,v){filters.push([k,v]);return this},maybeSingle:async()=>({data:{amendment_id:id(3)}}),
 }},rpc:async(name,args)=>{calls.push([name,args]);return {data:{note:args.p_note,actor_id:args.p_actor_id,
  available_balance:'9.04',reviewed_at:'2026-10-27T12:00:00Z'}}}};
 const result=await reviewMemberCreditExpiry(db,id(1),id(4),{
  memberId:id(2),amendmentId:id(3),note:' Reviewed in accounting. ',value:0,tenantId:id(9),
 });
 assert.deepEqual(filters,[['tenant_id',id(1)],['member_id',id(2)],['amendment_id',id(3)]]);
 assert.equal(result.review.availableMinor,904);
 assert.equal(result.review.note,'Reviewed in accounting.');
 assert.equal(calls.length,1);assert.equal(calls[0][0],'review_member_credit_expiry');
 assert.equal(calls[0][1].p_tenant_id,id(1));assert.equal(calls[0][1].value,undefined);
 await assert.rejects(reviewMemberCreditExpiry(db,id(1),id(4),{memberId:id(2),amendmentId:id(3),note:' '}),{status:400});
 assert.equal(calls.length,1);
});
test('expiry queue validates cursors and scopes every page to the authenticated tenant',async()=>{
 let args;
 const db={rpc:async(name,input)=>{assert.equal(name,'list_member_credit_expiry_reviews');args=input;
  return {data:Array.from({length:100},(_,i)=>({amendmentId:id(i+10)}))};}};
 const page=await listMemberCreditExpiryReviews(db,id(1),id(8));
 assert.equal(page.nextCursor,id(109));assert.equal(args.p_tenant_id,id(1));assert.equal(args.p_after,id(8));
 await assert.rejects(listMemberCreditExpiryReviews(db,id(1),'invalid'),{status:400});
 await assert.rejects(listMemberCreditExpiryReviews({rpc:async()=>({error:{code:'PGRST202'}})},id(1)),{status:503});
});
