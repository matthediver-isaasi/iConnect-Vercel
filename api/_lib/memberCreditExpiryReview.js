import {AMENDMENT_UUID} from './memberAmendments.js';
import {amendmentResult} from './memberAmendmentSettlement.js';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
// Caller must use the shared tenant-admin AND finance gate.
export async function listMemberCreditExpiryReviews(db,tenantId,after){
 if(after&&!AMENDMENT_UUID.test(after))fail('Invalid review cursor.');
 const rows=amendmentResult(await db.rpc('list_member_credit_expiry_reviews',{
  p_tenant_id:tenantId,p_after:after||null,p_limit:100,
 }));
 if(!Array.isArray(rows))fail('Credit expiry reviews could not be loaded.',503);
 return {items:rows,nextCursor:rows.length===100?rows.at(-1).amendmentId:null};
}
export async function reviewMemberCreditExpiry(db,tenantId,actorId,input){
 if(!actorId||!AMENDMENT_UUID.test(input?.memberId||'')||!AMENDMENT_UUID.test(input?.amendmentId||'')
  ||typeof input.note!=='string'||!input.note.trim()||input.note.trim().length>2000)fail('Member, credit and a review note are required.');
 const row=amendmentResult(await db.from('member_membership_credit').select('amendment_id')
  .eq('tenant_id',tenantId).eq('member_id',input.memberId).eq('amendment_id',input.amendmentId).maybeSingle());
 if(!row)fail('Membership credit not found.',404);
 const saved=amendmentResult(await db.rpc('review_member_credit_expiry',{
  p_tenant_id:tenantId,p_amendment_id:input.amendmentId,p_actor_id:actorId,p_note:input.note.trim(),
 }));
 return {review:{note:saved.note,reviewedAt:saved.reviewed_at,actorId:saved.actor_id,
  availableMinor:Math.round(Number(saved.available_balance)*100)}};
}
