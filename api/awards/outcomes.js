import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
import {loadRankings} from '../_lib/assessment/rankings.js';
import {compareScores} from '../_lib/assessment/scoring.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;if(!db)return res.status(503).json({error:'Outcomes unavailable'});
  try{
    const command=req.body?.command;
    let categoriesOnly=req.method==='GET'&&req.query?.categoriesOnly==='1';
    let approvedOnly=false;
    let auth=await authorizeAwards(req,db,dependencies.getTenantContext,
      command==='category'||categoriesOnly?'awards.management.configure':'awards.management.approve');
    if(req.method==='GET'&&!categoriesOnly&&!auth.context&&auth.status===403){
      approvedOnly=true;
      auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.publish');
      if(!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.communicate');
      if(!auth.context&&auth.status===403)auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.certificates');
      if(!auth.context&&auth.status===403){
        auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.configure');
        if(auth.context)categoriesOnly=true;
      }
    }
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const ctx=auth.context,awardId=req.method==='GET'?req.query?.awardId:req.body?.awardId;
    if(!uuid(awardId))return res.status(400).json({error:'Award required'});
    if(req.method==='GET'){
      const page=Number(req.query?.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const categories=await db.from('awards_outcome_category').select('id,name,certificate_enabled')
        .eq('tenant_id',ctx.tenantId).eq('award_id',awardId).order('id').range((page-1)*50,page*50-1);
      if(categories.error)throw categories.error;
      if(categoriesOnly)return res.json({categories:categories.data,outcomes:[],page,pageSize:50});
      let q=db.from('awards_outcome_revision').select('id,application_id,category_id,round_id,revision,state,selection_method,reason,score_snapshot,category_snapshot,is_override,created_at')
        .eq('tenant_id',ctx.tenantId).eq('award_id',awardId);
      if(approvedOnly)q=q.eq('state','approved');
      if(req.query?.applicationId){if(!uuid(req.query.applicationId))return res.status(400).json({error:'Invalid application'});q=q.eq('application_id',req.query.applicationId);}
      const outcomes=await q.order('created_at',{ascending:false}).order('id').range((page-1)*50,page*50-1);
      if(categories.error||outcomes.error)throw categories.error||outcomes.error;
      return res.json({categories:categories.data,outcomes:outcomes.data,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    const input=req.body,actor={p_tenant:ctx.tenantId,p_actor_kind:ctx.memberId?'member':'tenant_user',p_actor:ctx.memberId||ctx.tenantUserId};
    if(command==='category'){
      if(input.id&&!uuid(input.id)||typeof input.name!=='string'||!input.name.trim()||input.name.length>300||typeof input.certificateEnabled!=='boolean'){
        return res.status(400).json({error:'Category name and certificate setting required'});
      }
      const {data,error}=await db.rpc('awards_category_command',{...actor,p_award:awardId,p_id:input.id||null,
        p_payload:{name:input.name,certificate_enabled:input.certificateEnabled}});
      if(error)throw error;return res.json({category:data});
    }
    if(command!=='decide'||![input.roundId,input.applicationId,input.categoryId].every(uuid)
      ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
      ||!['provisional','recommended','approved','reopened'].includes(input.state)||!['score','panel','manual'].includes(input.method)
      ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>20000||typeof input.override!=='boolean'){
      return res.status(400).json({error:'Outcome, version, method and justification required'});
    }
    const rankings=await loadRankings(db,ctx.tenantId,input.roundId);
    if(rankings.round.award_id!==awardId)return res.status(404).json({error:'Round unavailable'});
    const entry=rankings.entries.find(e=>e.id===input.applicationId&&e.eligibility==='eligible');
    if(!entry)return res.status(404).json({error:'Application unavailable'});
    const best=rankings.entries.find(e=>e.complete&&e.officialScore);
    const exceptional=!entry.complete||input.method==='manual'||input.method==='score'&&(
      !best||!entry.officialScore||compareScores(entry.officialScore,best.officialScore)!==0
      ||rankings.entries.filter(e=>e.complete&&e.officialScore&&compareScores(e.officialScore,best.officialScore)===0).length>1);
    if(exceptional&&!input.override&&input.state!=='reopened')return res.status(400).json({error:'This selection requires an explicit reasoned override'});
    if(input.method==='panel'&&entry.moderationState!=='approved')return res.status(409).json({error:'Panel moderation must be approved first'});
    const {data,error}=await db.rpc('awards_record_outcome',{...actor,p_round:input.roundId,p_application:input.applicationId,
      p_category:input.categoryId,p_expected_revision:input.expectedRevision,p_state:input.state,p_method:input.method,p_reason:input.reason,
      p_override:input.override,p_fingerprint:rankings.fingerprints[input.applicationId],p_score:entry.officialScore,p_all_fingerprints:rankings.fingerprints});
    if(error)throw error;return res.json({outcome:data});
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:error.code==='P0002'?404:['P0001','23514','23505','23502'].includes(error.code)||!error.code?400:503;
    return res.status(status).json({error:status===503?'Outcome action unavailable':error.message});
  }
}
