import { supabase } from '../_lib/database.js';
import { lifecycleRuntimeReady, processLifecycleChunk } from '../_lib/memberLifecycleRuntime.js';
import { deliverLifecycleOperations } from '../_lib/memberLifecycleDelivery.js';
import { deliverLifecycleNotice } from '../_lib/memberLifecycleNotifications.js';
export function createLifecycleCron({db=supabase,secret=()=>process.env.CRON_SECRET,ready=lifecycleRuntimeReady,
  process:processChunk=processLifecycleChunk,operations=deliverLifecycleOperations,notice=deliverLifecycleNotice}={}){
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');
    if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
    if(!secret())return res.status(503).json({error:'Cron authentication is not configured'});
    if(req.headers.authorization!==`Bearer ${secret()}`)return res.status(401).json({error:'Unauthorized'});
    try{
      if(!await ready(db))return res.status(503).json({error:'Lifecycle migration is not installed'});
      const outcomes={}, failures=[];
      for(const [stage,run] of [['processed',processChunk],['deliveries',operations],['notifications',notice]]){
        try{outcomes[stage]=(await run(db)).processed;}
        catch{outcomes[stage]=0;failures.push(stage);}
      }
      if(failures.length)return res.status(503).json({...outcomes,failures,error:'Failed stages retained durable retry/review state'});
      return res.json(outcomes);
    }catch{return res.status(503).json({error:'Lifecycle processing retained its cursor for retry; inspect operation history'});}
  };
}
export default createLifecycleCron();
