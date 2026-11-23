import {timingSafeEqual} from 'node:crypto';
import {runFunnelReversalWorker} from './eventFunnelReversalWorker.js';
/** Separate budget from invoice/confirmation work, so those queues cannot
 * starve refund reconciliation. Installing this handler does not schedule it.
 */
export function createFunnelReversalCron({db,getSecret,run=runFunnelReversalWorker,now=()=>Date.now()}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');res.setHeader('CDN-Cache-Control','no-store');
    const secret=getSecret(),provided=req.headers?.authorization;
    const expected=typeof secret==='string'&&secret.length?`Bearer ${secret}`:null;
    if(!expected||typeof provided!=='string'||Buffer.byteLength(provided)!==Buffer.byteLength(expected)
      ||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return res.status(401).json({error:'Unauthorized'});
    if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
    if(!db)return res.status(503).json({error:'Recovery unavailable'});
    const deadline=now()+45000,result={checked:0,complete:0,retry:0,needs_review:0,lease_lost:0};
    try{
      for(let index=0;index<4&&now()<deadline-2000;index++){
        const outcome=await run({db,deadlineAt:deadline});
        if(['idle','budget_exhausted'].includes(outcome?.status))break;
        if(!['complete','retry','needs_review','lease_lost'].includes(outcome?.status))throw new Error('Invalid recovery outcome');
        result.checked++;result[outcome.status]++;
      }
      return res.status(200).json(result);
    }catch{return res.status(503).json({error:'Cancellation recovery requires retry; existing financial authority is retained'});}
  };
}
