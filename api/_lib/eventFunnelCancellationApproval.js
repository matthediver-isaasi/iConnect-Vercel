import {createHash} from 'node:crypto';
import {prepareFunnelCancellation} from './eventFunnelCancellationPreparation.js';
import {requireSameOriginJson} from './eventFunnelJourneyHandler.js';
import {runFunnelReversalWorker} from './eventFunnelReversalWorker.js';
import {groupFunnelAmountChoices} from './eventFunnelGroupCancellation.js';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
export function funnelCancellationOperationId(tenantId,requestIds){
  const hex=createHash('sha256').update(JSON.stringify(['event-funnel-cancellation',tenantId,[...requestIds].sort()])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** Called only with tenant-scoped requests loaded by an authenticated admin.
 * The database owns acceptance; failures AFTER approval never request payment,
 * erase cancellation or fall through to legacy per-booking refund consumers.
 */
export async function approveFunnelCancellation({db,ctx,req,requests,reviewerName,
  amountsByRequest={},groupAmounts=null,options={},reviewNotes=null,suppressEmails=false,creditNoteEmail=null,
  hasAdminAccess,hasFeatureAccess,prepare=prepareFunnelCancellation,run=runFunnelReversalWorker}){
  if(!ctx?.isAuthenticated||!ctx.tenantId||!await hasAdminAccess(ctx))fail('Administrator access required',403);
  if(!Array.isArray(requests)||!requests.length||requests.some(r=>!r?.id||r.tenant_id!==ctx.tenantId))
    fail('Cancellation request scope changed');
  const operationId=funnelCancellationOperationId(ctx.tenantId,requests.map(r=>r.id));
  let plan=await prepare({db,tenantId:ctx.tenantId,requests,operationId,amountsByRequest});
  if(plan.kind==='legacy')return null;
  if(plan.kind!=='funnel'||plan.tenantId!==ctx.tenantId||plan.operationId!==operationId)fail('Cancellation scope changed');
  requireSameOriginJson(req);
  if(!ctx.tenantUserId&&(!ctx.memberId||!await hasFeatureAccess(ctx.roleId,'commerce.event-cancellations',
    ctx.memberExcludedFeatures||[])))fail('Cancellation management permission required',403);
  if(groupAmounts)plan=await prepare({db,tenantId:ctx.tenantId,requests,operationId,
    amountsByRequest:groupFunnelAmountChoices({plan,requests,...groupAmounts})});
  if(creditNoteEmail!==null&&(typeof creditNoteEmail!=='string'||creditNoteEmail.length>320
    ||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(creditNoteEmail)))fail('Invalid credit-note email address',400);
  if(typeof suppressEmails!=='boolean'||!options||Array.isArray(options)||typeof options!=='object'
    ||Object.keys(options).some(key=>key!=='voucherReplacements'))fail('Unsupported shared-checkout cancellation options',400);
  const actor=ctx.tenantUserId?`user:${ctx.tenantUserId}`:`member:${ctx.memberId}`;
  const limit=await db.rpc('event_funnel_consume_limit',{p_tenant:ctx.tenantId,p_actor:actor});
  if(limit.error||typeof limit.data!=='boolean')fail('Cancellation approval is temporarily unavailable',503);
  if(!limit.data)fail('Please try again shortly',429);
  const accepted=await db.rpc('event_funnel_approve_cancellation',{p_tenant:ctx.tenantId,p_order:plan.orderId,
    p_id:operationId,p_requests:plan.requestIds,p_items:plan.items,p_options:options,
    p_authority:{actor,reviewer:reviewerName,reviewNotes,suppressEmails,creditNoteEmail}});
  if(accepted.error)fail(accepted.error.code==='22023'?'Invalid cancellation choices':
    'Cancellation could not be approved. Refresh the request before trying again.',
    accepted.error.code==='22023'?400:409);
  if(accepted.data?.id!==operationId||accepted.data?.tenant_id!==ctx.tenantId
    ||accepted.data?.order_id!==plan.orderId||!accepted.data.cancelled_at)
    fail('Approval outcome requires reconciliation. Do not submit another refund.',503);
  let recovery='queued';
  try {recovery=(await run({db,tenantId:ctx.tenantId,operationId,deadlineAt:Date.now()+12000})).status;}catch{
    // The accepted operation is durable and discoverable through recovery UI.
  }
  return {operationId,orderId:plan.orderId,recovery,reviewedAt:accepted.data.cancelled_at};
}
