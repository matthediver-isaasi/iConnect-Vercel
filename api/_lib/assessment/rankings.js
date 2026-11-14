import {computeEvidence} from './evidence.js';
import {createHash} from 'node:crypto';
import {compareScores,shortlistRecommendations} from './scoring.js';
export async function loadRankings(database,tenantId,roundId,{includeSubmitted=false}={}){
  const entries=[],fingerprints={};let total,round;
  for(let page=1;page<=10000;page++){
    const {data,error}=await database.rpc('assessment_round_evidence',{p_tenant:tenantId,p_round:roundId,p_page:page});
    if(error)throw error;
    if(total!==undefined&&total!==data.total)throw new Error('Application set changed; reload rankings');
    total=data.total;round=data.round;
    for(const item of data.entries){
      const evidence=item.evidence,aggregate=computeEvidence(evidence);
      if(fingerprints[evidence.application.id])throw new Error('Duplicate application in rankings');
      fingerprints[evidence.application.id]=item.fingerprint;
      entries.push({...evidence.application,...aggregate.official,
        shortlist:evidence.shortlist,
        ...(includeSubmitted?{assessments:evidence.assessments.filter(a=>a.state==='submitted').map(({appointmentId,answers,score,included,recused,revision,criteriaVersionId})=>({
          judge:`Judge ${createHash('sha256').update(`${roundId}:${appointmentId}`).digest('hex').slice(0,8).toUpperCase()}`,
          answers,score,included,recused,revision,criteriaVersionId,
        }))}:{}),
        ...(includeSubmitted?{workload:evidence.assessments.map(({appointmentId,state,included,recused,score})=>({
          judge:`Judge ${createHash('sha256').update(`${roundId}:${appointmentId}`).digest('hex').slice(0,8).toUpperCase()}`,
          state:state||'not_started',included:included&&!recused,scored:state==='submitted'&&score!==null,
        }))}:{}),
        moderationRequired:round.moderation_required,moderationState:evidence.moderation?.authorityValid===false?'conflicted':evidence.moderation?.state||null});
    }
    if(entries.length===total)break;
    if(!data.entries.length)throw new Error('Rankings are incomplete');
  }
  if(entries.length!==total)throw new Error('Rankings exceed the supported preview size');
  entries.sort((a,b)=>a.officialScore&&b.officialScore?-compareScores(a.officialScore,b.officialScore)||a.id.localeCompare(b.id):
    a.officialScore?-1:b.officialScore?1:a.id.localeCompare(b.id));
  return{round,entries,fingerprints};
}
export function prepareShortlist(rankings,{mode,threshold,limit,applicationIds,state,override,reason}){
  const eligible=rankings.entries.filter(e=>!e.moderationRequired||e.moderationState==='approved');
  const recommendation=shortlistRecommendations(eligible,{mode,threshold,limit});
  if(!['recommended','confirmed','rejected','reopened'].includes(state)||!Array.isArray(applicationIds)
    ||!applicationIds.length||applicationIds.length>500||new Set(applicationIds).size!==applicationIds.length
    ||typeof reason!=='string'||!reason.trim())throw new Error('Select applications, decision state and a reason');
  const decisions=applicationIds.map(id=>{
    const entry=eligible.find(e=>e.id===id&&e.eligibility==='eligible');
    if(!entry)throw new Error('Application is ineligible or required moderation is unapproved');
    const exceptional=mode==='manual'||!recommendation.recommended.includes(id)||!entry.complete;
    if(['recommended','confirmed'].includes(state)&&exceptional&&override!==true){
      throw new Error('Manual, tied, incomplete or non-recommended selections require an explicit reasoned override');
    }
    return{applicationId:id,state,score:entry.officialScore,override:exceptional&&['recommended','confirmed'].includes(state)};
  });
  return{recommendation,decisions};
}
