import {supabase} from '../_lib/database.js';
import {authorizeAwards} from './index.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  const db=dependencies.supabase||supabase;
  if(!db)return res.status(503).json({error:'Evidence adoption unavailable'});
  try{
    const auth=await authorizeAwards(req,db,dependencies.getTenantContext,'awards.management.assign');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const c=auth.context,input=req.method==='GET'?req.query:req.body;
    if(!uuid(input?.roundId)||!uuid(input?.applicationId))return res.status(400).json({error:'Round and application required'});
    const round=await db.from('assessment_round').select('id,award_id').eq('tenant_id',c.tenantId).eq('id',input.roundId).maybeSingle();
    if(round.error)throw round.error;
    if(!round.data)return res.status(404).json({error:'Round unavailable'});
    const application=await db.from('awards_application').select('id,reference').eq('tenant_id',c.tenantId)
      .eq('award_id',round.data.award_id).eq('id',input.applicationId).maybeSingle();
    if(application.error)throw application.error;
    if(!application.data)return res.status(404).json({error:'Application unavailable'});
    if(req.method==='GET'){
      const page=Number(input.page||1);
      if(!Number.isSafeInteger(page)||page<1||page>10000)return res.status(400).json({error:'Invalid page'});
      const [versions,assignments]=await Promise.all([
        db.from('awards_application_version').select('id,revision,created_at',{count:'exact'}).eq('tenant_id',c.tenantId)
          .eq('application_id',input.applicationId).order('revision',{ascending:false}).range((page-1)*50,page*50-1),
        db.from('assessment_assignment').select('id,version,state,application_version_id',{count:'exact'}).eq('tenant_id',c.tenantId)
          .eq('round_id',input.roundId).eq('application_id',input.applicationId).order('id').range((page-1)*50,page*50-1),
      ]);
      if(versions.error||assignments.error)throw versions.error||assignments.error;
      return res.json({application:application.data,versions:versions.data,versionTotal:versions.count,
        assignments:assignments.data,assignmentTotal:assignments.count,page,pageSize:50});
    }
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use awards administration'});
    if(!uuid(input.snapshotId)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>20000
      ||!input.expectedAssignments||typeof input.expectedAssignments!=='object'||Array.isArray(input.expectedAssignments)
      ||Object.entries(input.expectedAssignments).some(([id,version])=>!uuid(id)||!Number.isSafeInteger(version)||version<1)){
      return res.status(400).json({error:'Snapshot, exact assignment versions and reason required'});
    }
    const {data,error}=await db.rpc('assessment_adopt_snapshot',{p_tenant:c.tenantId,p_round:input.roundId,
      p_application:input.applicationId,p_snapshot:input.snapshotId,p_expected:input.expectedAssignments,
      p_actor_kind:c.memberId?'member':'tenant_user',p_actor:c.memberId||c.tenantUserId,p_reason:input.reason});
    if(error)throw error;return res.json(data);
  }catch(error){
    const status=['40001','PT409'].includes(error.code)?409:['P0001','23514'].includes(error.code)?400:503;
    return res.status(status).json({error:status===503?'Evidence adoption unavailable':error.message});
  }
}
