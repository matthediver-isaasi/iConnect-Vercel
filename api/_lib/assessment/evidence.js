import { aggregateAssessments, calculateAssessment } from './scoring.js';
export function computeEvidence(evidence){
  const required=evidence.assessments.filter(a=>a.included&&!a.recused).map(a=>a.assignmentId);
  const independent=aggregateAssessments(evidence.assessments,{
    minimum:evidence.round.required_judges,requiredAssignments:required,allRequired:evidence.round.require_all,
  });
  const sourceIds=evidence.assessments.filter(a=>a.state==='submitted'&&a.included&&!a.recused&&a.score!==null).map(a=>a.revisionId).sort();
  const moderated=evidence.moderation?.state==='approved'&&evidence.moderation.revision?.action==='approved'
    &&evidence.moderation.authorityValid!==false
    &&JSON.stringify([...evidence.moderation.revision.assessment_revision_ids].sort())===JSON.stringify(sourceIds)
    ? {state:'approved',score:evidence.moderation.revision.exact_score}:null;
  const official=aggregateAssessments(evidence.assessments,{
    minimum:evidence.round.required_judges,requiredAssignments:required,allRequired:evidence.round.require_all,approvedModeration:moderated,
  });
  return{independent,official,sourceIds};
}
export function computeModerationScore({method,definition,answers,overall}){
  if(method==='criterion'){
    const computed=calculateAssessment(definition,answers,{final:true});
    if(!computed.scoringComplete)throw new Error('Every optional scored answer must be resolved before moderation can produce a score');
    return computed.score;
  }
  if(method!=='overall')throw new Error('Choose criterion or overall moderation');
  return calculateAssessment({optionalPolicy:'incomplete',criteria:[{id:'overall',title:'Overall',type:'numeric',required:true,min:0,max:100,weight:100}]},
    {overall:{value:overall}},{final:true}).score;
}
