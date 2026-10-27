import {createMemberCancellationProvider} from './memberCancellationProvider.js';
import {amendmentResult} from './memberAmendmentSettlement.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=()=>{throw Object.assign(new Error('Owned cancellation operation is unavailable'),{status:409});};

// This coordinator cannot create a cancellation or end access. It only
// completes a previously approved and access-applied provider-stop journal.
export function createMemberCancellationExecution({db,provider=createMemberCancellationProvider()}){
 function args(context,id){
  if(![context.tenantId,context.memberId,context.actorId,id].every(v=>uuid.test(v||'')))fail();
  return {p_tenant_id:context.tenantId,p_member_id:context.memberId,p_actor_id:context.actorId,p_id:id};
 }
 async function load(context,id){
  args(context,id);
  const row=amendmentResult(await db.from('member_cancellation_provider_stop').select('*')
   .eq('tenant_id',context.tenantId).eq('member_id',context.memberId).eq('id',id).maybeSingle());
  if(!row||row.id!==id||row.tenant_id!==context.tenantId||row.member_id!==context.memberId
   ||row.prepared?.fingerprint!==row.fingerprint)fail();
  return row;
 }
 async function record(context,row,evidence){
  return amendmentResult(await db.rpc('record_member_cancellation_provider_stop',{
   ...args(context,row.id),p_claim_token:row.claim_token,p_evidence:evidence,
  }));
 }
 async function recover(context,id){
  const row=await load(context,id);
  if(row.state==='stopped'||row.state==='pending')return row;
  if(!row.claim_token)fail();
  const observed=await provider.reconcile(row.prepared);
  return record(context,row,observed);
 }
 async function execute(context,id){
  if(context.actorKind!=='admin')fail();
  const claim=amendmentResult(await db.rpc('claim_member_cancellation_provider_stop',args(context,id)));
  if(!claim?.claimed)return recover(context,id);
  const row=await load(context,id);
  if(row.claim_token!==claim.operation?.claim_token||row.state!=='claimed')fail();
  let observation;
  try{observation=await provider.submitReservedStop(row.prepared,row);}
  catch{
   // Even a pre-read failure retains the claim. Recovery never guesses that
   // a failed transport response authorizes another destructive operation.
   observation={state:'uncertain',subscriptionId:row.prepared.authority.subscriptionId};
  }
  return record(context,row,observation);
 }
 return {execute,recover};
}
