import { supabase } from '../_lib/database.js';
import { authorizeAwards } from './index.js';
import { previewAllocation } from '../_lib/assessment/allocation.js';
const uuid=v=>typeof v==='string'&&/^[0-9a-f-]{36}$/i.test(v);
async function allRows(factory){
  const rows=[];
  for(let page=0;page<100;page++){
    const {data,error}=await factory().order('id').range(page*100,page*100+99);
    if(error)throw error;
    rows.push(...data);
    if(data.length<100)return rows;
  }
  throw Object.assign(new Error('Select a smaller allocation scope before previewing'),{status:422});
}
export default async function handler(req,res,dependencies={}){
  res.setHeader('Cache-Control','private, no-store');
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  const database=dependencies.supabase||supabase;
  if(!database)return res.status(503).json({error:'Allocation unavailable'});
  try{
    const auth=await authorizeAwards(req,database,dependencies.getTenantContext,'awards.management.assign');
    if(!auth.context)return res.status(auth.status).json({error:auth.error});
    const context=auth.context;
    if(req.headers?.['x-awards-request']!=='1'||req.headers?.['sec-fetch-site']==='cross-site'
      ||!String(req.headers?.['content-type']||'').startsWith('application/json'))return res.status(403).json({error:'Use the awards administration page'});
    const {command,roundId,version,mode,manual,assignments:proposed,applicationIds}=req.body||{};
    if(!uuid(roundId)||!['preview','confirm'].includes(command))return res.status(400).json({error:'Invalid allocation request'});
    const {data:round,error}=await database.from('assessment_round').select('*').eq('tenant_id',context.tenantId).eq('id',roundId).maybeSingle();
    if(error)throw error;
    if(!round)return res.status(404).json({error:'Round unavailable'});
    if(command==='confirm'){
      if(!Number.isSafeInteger(version)||!Array.isArray(proposed)||proposed.length<1||proposed.length>500
        ||proposed.some(p=>![p.applicationId,p.appointmentId,p.applicationVersionId,p.criteriaVersionId].every(uuid))){
        return res.status(400).json({error:'Confirm a valid allocation preview'});
      }
      const {data,error:confirmationError}=await database.rpc('assessment_confirm_allocation',{
        p_tenant:context.tenantId,p_round:roundId,p_expected_version:version,
        p_actor_kind:context.memberId?'member':'tenant_user',p_actor:context.memberId||context.tenantUserId,p_pairs:proposed,
      });
      if(confirmationError)throw confirmationError;
      return res.json(data);
    }
    if(applicationIds!==undefined&&(!Array.isArray(applicationIds)||applicationIds.length<1||applicationIds.length>500||!applicationIds.every(uuid))){
      return res.status(400).json({error:'Invalid application selection'});
    }
    const [applications,appointments,assignments]=await Promise.all([
      allRows(()=>{let q=database.from('awards_application').select(round.position>1?'id,eligibility,entry:assessment_round_entry!inner(round_id)':'id,eligibility').eq('tenant_id',context.tenantId).eq('award_id',round.award_id);
        if(round.position>1)q=q.eq('entry.round_id',roundId);
        if(applicationIds)q=q.in('id',applicationIds);return q;}),
      allRows(()=>database.from('assessment_appointment').select('id,state,available,role,capacity,expires_at').eq('tenant_id',context.tenantId).eq('round_id',roundId)),
      allRows(()=>database.from('assessment_assignment').select('id,application_id,appointment_id,state,conflict').eq('tenant_id',context.tenantId).eq('round_id',roundId)),
    ]);
    const result=previewAllocation({mode,applications,appointments:appointments.filter(a=>!a.expires_at||Date.parse(a.expires_at)>Date.now()),
      assignments:assignments.map(a=>({...a,applicationId:a.application_id,appointmentId:a.appointment_id})),
      conflicts:assignments.map(a=>({applicationId:a.application_id,appointmentId:a.appointment_id,state:a.conflict})),
      requiredJudges:round.required_judges,manual:manual||[]});
    if(result.assignments.length>500)return res.status(422).json({error:'Select fewer applications for one allocation confirmation'});
    const {data:criteria,error:criteriaError}=await database.from('assessment_criteria_version').select('id').eq('tenant_id',context.tenantId)
      .eq('round_id',roundId).order('revision',{ascending:false}).limit(1);
    if(criteriaError)throw criteriaError;
    if(!criteria[0])return res.status(400).json({error:'Save round criteria before allocation'});
    const versions=new Map();
    for(const id of new Set(result.assignments.map(p=>p.applicationId))){
      const {data,error:versionError}=await database.from('awards_application_version').select('id').eq('tenant_id',context.tenantId)
        .eq('application_id',id).order('revision',{ascending:false}).limit(1);
      if(versionError)throw versionError;
      if(!data[0])return res.status(409).json({error:'An application is missing its review snapshot'});
      versions.set(id,data[0].id);
    }
    return res.json({...result,roundVersion:round.version,assignments:result.assignments.map(p=>({...p,
      applicationVersionId:versions.get(p.applicationId),criteriaVersionId:criteria[0].id}))});
  }catch(error){
    const status=error.status|| (['40001','PT409','23505'].includes(error.code)?409:['P0001','23514'].includes(error.code)||!error.code?400:503);
    return res.status(status).json({error:status===503?'Allocation temporarily unavailable':error.message});
  }
}
