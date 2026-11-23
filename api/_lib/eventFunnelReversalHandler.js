import {requireSameOriginJson} from './eventFunnelJourneyHandler.js';
import {runFunnelReversalWorker} from './eventFunnelReversalWorker.js';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Administrative recovery of an ALREADY authorized cancellation. This cannot
 * create cancellations, change amounts/options, or bypass the queue cooldown.
 * Never return the private context: it contains original purchaser evidence.
 */
export function createFunnelReversalHandler({db,getTenantContext,hasAdminAccess,hasFeatureAccess,run=runFunnelReversalWorker}){
  return async(req,res)=>{
    for(const key of ['Cache-Control','CDN-Cache-Control','Vercel-CDN-Cache-Control'])res.setHeader(key,'private, no-store');
    res.setHeader('Vary','Cookie');
    try{
      if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'Method not allowed'});}
      requireSameOriginJson(req);
      const ctx=await getTenantContext(req);
      if(!ctx?.isAuthenticated||!ctx.tenantId)return res.status(401).json({error:'Administrator authentication required'});
      if(!await hasAdminAccess(ctx)||(!ctx.tenantUserId&&(!ctx.memberId
        ||!await hasFeatureAccess(ctx.roleId,'commerce.event-cancellations',ctx.memberExcludedFeatures||[]))))
        return res.status(403).json({error:'Cancellation management permission required'});
      const body=req.body;
      if(!body||Array.isArray(body)||!uuid(body.orderId)||!['list','retry'].includes(body.action)
        ||(body.action==='retry'&&!uuid(body.operationId))
        ||Object.keys(body).some(key=>!['action','orderId',...(body.action==='retry'?['operationId']:[])].includes(key)))
        return res.status(400).json({error:'Invalid recovery request'});
      if(!db)return res.status(503).json({error:'Recovery unavailable'});
      const limit=await db.rpc('event_funnel_consume_limit',{p_tenant:ctx.tenantId,
        p_actor:ctx.tenantUserId?`user:${ctx.tenantUserId}`:`member:${ctx.memberId}`});
      if(limit.error||typeof limit.data!=='boolean')throw new Error('Rate limit unavailable');
      if(!limit.data){res.setHeader('Retry-After','60');return res.status(429).json({error:'Please try again shortly'});}
      async function read(){
        const result=await db.rpc('event_funnel_reversal_context',{p_tenant:ctx.tenantId,p_order:body.orderId});
        if(result.error?.code==='PT404')throw Object.assign(new Error(),{status:404});
        if(result.error||result.data?.order?.tenant_id!==ctx.tenantId||result.data.order.id!==body.orderId
          ||!Array.isArray(result.data.history)||result.data.history.some(item=>item.tenant_id!==ctx.tenantId||item.order_id!==body.orderId))
          throw new Error('Recovery scope unavailable');
        return result.data.history;
      }
      let history=await read(),attempt;
      if(body.action==='retry'){
        const operation=history.find(item=>item.id===body.operationId);
        if(!operation)return res.status(404).json({error:'Cancellation operation not found'});
        if(!operation.refund_options||operation.state==='released')
          return res.status(409).json({error:'Original cancellation approval requires reconciliation'});
        attempt=await run({db,tenantId:ctx.tenantId,operationId:operation.id,deadlineAt:Date.now()+45000});
        history=await read();
      }
      return res.status(200).json({...(attempt?{attempt:attempt.status}:{}),operations:history.map(item=>({
        id:item.id,state:item.state,cancelledAt:item.cancelled_at||null,
        nextAttemptAt:['complete','released'].includes(item.state)?null:item.next_attempt_at||null,
        outcomes:Object.fromEntries(['card','training','voucher','credit','cleanup'].filter(key=>
          ['complete','not_applicable','retry','needs_review'].includes(item.last_outcomes?.[key]))
          .map(key=>[key,item.last_outcomes[key]])),
      }))});
    }catch(error){
      return res.status([400,403,404,429].includes(error.status)?error.status:503)
        .json({error:'Cancellation recovery is unavailable. Existing refund authority has been retained.'});
    }
  };
}
