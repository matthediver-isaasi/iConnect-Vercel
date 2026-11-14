import {formatScore} from './scoring.js';
// Text cells must never become executable spreadsheet formulas.
export function spreadsheetText(value){
  const text=String(value??'');
  return /^[\s]*[=+\-@\t\r]/.test(text)?`'${text}`:text;
}
export function reportRows(rankings){
  const summaries=[],matrix=[],criteria=[],workload=[];
  for(const entry of rankings.entries){
    const reference=entry.reference||entry.id;
    for(const item of entry.workload||[])workload.push({Application:reference,Judge:item.judge,
      State:item.state,Included:item.included?'Yes':'No','Ranking score available':item.scored?'Yes':'No'});
    summaries.push({
      Application:reference,Eligibility:entry.eligibility,Complete:entry.complete?'Yes':'No',
      Score:entry.officialScore?formatScore(entry.officialScore):'',
      'Exact numerator':entry.officialScore?.numerator??'','Exact denominator':entry.officialScore?.denominator??'',
      'Completed assessments':entry.completed,'Discrepancy':entry.discrepancy?'Yes':'No',
      Moderation:entry.moderationState||'Not started',Shortlist:entry.shortlist?.state||'Not decided',
    });
    for(const assessment of entry.assessments||[]){
      const common={Application:reference,Judge:assessment.judge,Revision:assessment.revision,
        Included:assessment.included&&!assessment.recused?'Yes':'No'};
      matrix.push({...common,Score:assessment.score?formatScore(assessment.score):'',
        'Exact numerator':assessment.score?.numerator??'','Exact denominator':assessment.score?.denominator??''});
      for(const [criterion,answer]of Object.entries(assessment.answers||{})){
        criteria.push({...common,Criterion:criterion,'Criteria version':assessment.criteriaVersionId,
          Answer:typeof answer?.value==='object'?JSON.stringify(answer.value):answer?.value??'',Comment:answer?.comment??''});
      }
    }
  }
  return{summaries,matrix,criteria,workload};
}
